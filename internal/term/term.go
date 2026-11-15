// Package term runs the canvas's terminal windows: a shell per window on a pseudo-terminal the server opens itself
// (no tmux, no cgo). Its output is buffered so a reloaded page can replay it, and every write wakes the page's
// /api/events stream (live.Changed), which carries it.
package term

import (
	"cmp"
	"crypto/rand"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"drawa/internal/config"
	"drawa/internal/live"
	"drawa/internal/prefs"
)

// Keep is how much output a terminal keeps for a page that reloads: about a few screens of a busy program.
const Keep = 256 << 10

// Supported is false where the server can't open a pseudo-terminal (Windows).
func Supported() bool { return supported }

// ErrNotFolder is a terminal asked to start somewhere that isn't a folder.
var ErrNotFolder = errors.New("not a folder")

// ErrGone is an op on a terminal that isn't running (closed, or the server restarted since).
var ErrGone = errors.New("no such terminal")

// ErrBusy is keys the program in a terminal didn't read in time (raw mode and busy): what's left of them is dropped
// rather than holding the request, and with it one of the browser's few connections, open.
var ErrBusy = errors.New("the terminal isn't reading input")

// ErrTooMany is a terminal past Max.
var ErrTooMany = errors.New("too many terminals open")

// Max is how many shells may run at once: a page bug or cleared storage can't pile up shells nobody can see.
const Max = 32

// Term is one shell on a pseudo-terminal.
type Term struct {
	master *os.File
	cmd    *exec.Cmd

	mu      sync.Mutex
	out     []byte // the newest output: at least Keep bytes once there's that much, at most twice that
	base    int64  // the offset (from the shell's first byte) of out[0]
	reaping bool   // set before Wait: from then on the pid may be reused, so Close mustn't signal it
	exited  bool
	code    int
	done    chan struct{} // closed once the shell is reaped
	linger  time.Duration // Linger when it opened
}

var (
	mu    sync.Mutex
	terms = map[string]*Term{}
)

// Open starts the user's shell in dir (relative to the project, "" for its root) at the given size.
// ponytail: a terminal whose page never closes it lives until the server exits (at most Max of them); reap unread
// ones if that piles up.
func Open(dir string, cols, rows int) (id string, err error) {
	if !supported {
		return "", errors.New("terminals aren't supported on this system")
	}
	id = newID()
	mu.Lock()
	if len(terms) >= Max {
		mu.Unlock()
		return "", ErrTooMany
	}
	terms[id] = nil // the place is held while the shell starts (Get sees no terminal yet)
	mu.Unlock()
	defer func() {
		if err != nil {
			mu.Lock()
			delete(terms, id)
			mu.Unlock()
		}
	}()
	abs, err := config.Inside(dir)
	if err != nil {
		return "", err
	}
	if fi, err := os.Stat(abs); err != nil || !fi.IsDir() {
		return "", fmt.Errorf("%w: %s", ErrNotFolder, dir)
	}
	master, slave, err := openPTY()
	if err != nil {
		return "", err
	}
	defer slave.Close() // the shell holds its own copy
	setSize(master, clamp(cols), clamp(rows))
	cmd := exec.Command(shell(), "-l")
	cmd.Dir = abs
	cmd.Env = append(shellEnv(), "TERM=xterm-256color", "COLORTERM=truecolor")
	cmd.Stdin, cmd.Stdout, cmd.Stderr = slave, slave, slave
	cmd.SysProcAttr = ttyAttr()
	if err := cmd.Start(); err != nil {
		master.Close()
		return "", err
	}
	t := &Term{master: master, cmd: cmd, done: make(chan struct{}), linger: Linger}
	mu.Lock()
	terms[id] = t
	mu.Unlock()
	go t.read(id)
	return id, nil
}

// read copies the shell's output into the buffer until the terminal closes (EIO once the shell and everything it
// started let go of the slave), then records how the shell ended.
func (t *Term) read(id string) {
	chunk := make([]byte, 32<<10)
	for {
		n, err := t.master.Read(chunk)
		if n > 0 {
			t.mu.Lock()
			t.out = append(t.out, chunk[:n]...)
			// trimmed only past twice Keep: a PTY reads ~4 KB at a time, and copying the whole buffer down on every
			// read was most of the server's CPU while a program printed nonstop
			if over := len(t.out) - Keep; len(t.out) > 2*Keep {
				t.out = append(t.out[:0:0], t.out[over:]...)
				t.base += int64(over)
			}
			t.mu.Unlock()
			wake()
		}
		if err != nil {
			break
		}
	}
	t.mu.Lock()
	t.reaping = true
	t.mu.Unlock()
	err := t.cmd.Wait()
	code := 0
	if ee, ok := err.(*exec.ExitError); ok {
		code = ee.ExitCode()
	}
	t.mu.Lock()
	t.exited, t.code = true, code
	t.mu.Unlock()
	close(t.done)
	live.Changed.Notify()
	// an ended shell is kept a while, for a page that's reloading to see how it ended, then its place (one of Max)
	// and buffer are freed. ponytail: a page coming back later than that sees "Shell ended" rather than the exit code
	time.AfterFunc(t.linger, func() { Close(id) })
}

// Linger is how long an ended shell's output and exit code stay after it exits.
var Linger = time.Minute

// waking is set while a wakeup for terminal output is due: every chunk read would otherwise wake every events
// stream and live.Meta() (`yes` reads thousands a second). The first chunk wakes them at once (an echoed key isn't
// held back); what follows within the next few milliseconds shares one more wakeup.
var waking atomic.Bool

func wake() {
	if waking.CompareAndSwap(false, true) {
		live.Changed.Notify()
		time.AfterFunc(4*time.Millisecond, func() {
			waking.Store(false)
			live.Changed.Notify()
		})
	}
}

// Since is the output from offset `from` on (from the oldest kept byte if `from` is older), the offset after it,
// and whether the shell has exited (and its code).
func (t *Term) Since(from int64) (data []byte, next int64, exited bool, code int) {
	t.mu.Lock()
	defer t.mu.Unlock()
	end := t.base + int64(len(t.out))
	from = max(from, t.base)
	if from < end {
		data = append([]byte(nil), t.out[from-t.base:]...)
	}
	return data, end, t.exited, t.code
}

// Write types into the terminal, giving up after a while if the program isn't reading.
func (t *Term) Write(s string) error {
	t.master.SetWriteDeadline(time.Now().Add(2 * time.Second))
	_, err := t.master.WriteString(s)
	switch {
	case errors.Is(err, os.ErrClosed): // closed while this was on its way
		return ErrGone
	case os.IsTimeout(err):
		return ErrBusy
	}
	return err
}

// Resize sets the terminal's size; full-screen programs redraw.
func (t *Term) Resize(cols, rows int) error { return setSize(t.master, clamp(cols), clamp(rows)) }

// Get is a running terminal by id, or nil.
func Get(id string) *Term {
	mu.Lock()
	defer mu.Unlock()
	return terms[id]
}

// Close hangs up a terminal's shell and forgets it.
func Close(id string) error {
	mu.Lock()
	t := terms[id]
	delete(terms, id)
	mu.Unlock()
	if t == nil {
		return ErrGone
	}
	t.mu.Lock()     // held while signalling, so read() can't start reaping in between
	if !t.reaping { // once reaped, its pid (and group id) may already be someone else's
		hangUp(t.cmd.Process.Pid)
	}
	t.mu.Unlock()
	return t.master.Close()
}

// CloseAll hangs up every shell and waits (up to a few seconds) for them to end, before the server exits or execs
// itself: after an exec nothing would reap them.
func CloseAll() {
	mu.Lock()
	all := make([]*Term, 0, len(terms))
	ids := make([]string, 0, len(terms))
	for id, t := range terms {
		if t != nil {
			all, ids = append(all, t), append(ids, id)
		}
	}
	mu.Unlock()
	for _, id := range ids {
		Close(id)
	}
	timeout := time.After(3 * time.Second)
	for _, t := range all {
		select {
		case <-t.done:
		case <-timeout:
			return
		}
	}
}

// shellEnv is the server's environment minus the --net sign-in token: it guards Drawa's network address, and a
// shell's `env` (shown on the canvas, readable by agents) mustn't print it.
func shellEnv() []string {
	return slices.DeleteFunc(os.Environ(), func(v string) bool { return strings.HasPrefix(v, config.NetTokenEnv+"=") })
}

// shell is the one your settings name (checked against /etc/shells when it was set, and again here), else $SHELL.
func shell() string {
	settings, _ := prefs.Load()
	if s, _ := settings["terminalShell"].(string); s != "" && slices.Contains(prefs.Shells(), s) {
		return s
	}
	return cmp.Or(os.Getenv("SHELL"), "/bin/sh")
}

func clamp(n int) int { return min(max(n, 2), 1000) }

func newID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}
