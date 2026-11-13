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
	"sync"

	"drawa/internal/config"
	"drawa/internal/live"
	"drawa/internal/prefs"
)

// Keep is how much output a terminal keeps for a page that reloads: about a few screens of a busy program.
const Keep = 256 << 10

// Supported is false where the server can't open a pseudo-terminal (Windows).
func Supported() bool { return supported }

// ErrGone is an op on a terminal that isn't running (closed, or the server restarted since).
var ErrGone = errors.New("no such terminal")

// Term is one shell on a pseudo-terminal.
type Term struct {
	master *os.File
	cmd    *exec.Cmd

	mu     sync.Mutex
	out    []byte // the newest output, at most Keep bytes
	base   int64  // the offset (from the shell's first byte) of out[0]
	exited bool
	code   int
}

var (
	mu    sync.Mutex
	terms = map[string]*Term{}
)

// Open starts the user's shell in dir (relative to the project, "" for its root) at the given size.
// ponytail: a terminal whose page never closes it lives until the server exits; reap unread ones if that piles up.
func Open(dir string, cols, rows int) (string, error) {
	if !supported {
		return "", errors.New("terminals aren't supported on this system")
	}
	abs, err := config.Inside(dir)
	if err != nil {
		return "", err
	}
	if fi, err := os.Stat(abs); err != nil || !fi.IsDir() {
		return "", fmt.Errorf("not a folder: %s", dir)
	}
	master, slave, err := openPTY()
	if err != nil {
		return "", err
	}
	defer slave.Close() // the shell holds its own copy
	setSize(master, clamp(cols), clamp(rows))
	cmd := exec.Command(shell(), "-l")
	cmd.Dir = abs
	cmd.Env = append(os.Environ(), "TERM=xterm-256color", "COLORTERM=truecolor")
	cmd.Stdin, cmd.Stdout, cmd.Stderr = slave, slave, slave
	cmd.SysProcAttr = ttyAttr()
	if err := cmd.Start(); err != nil {
		master.Close()
		return "", err
	}
	t := &Term{master: master, cmd: cmd}
	id := newID()
	mu.Lock()
	terms[id] = t
	mu.Unlock()
	go t.read()
	return id, nil
}

// read copies the shell's output into the buffer until the terminal closes (EIO once the shell and everything it
// started let go of the slave), then records how the shell ended.
func (t *Term) read() {
	chunk := make([]byte, 32<<10)
	for {
		n, err := t.master.Read(chunk)
		if n > 0 {
			t.mu.Lock()
			t.out = append(t.out, chunk[:n]...)
			if over := len(t.out) - Keep; over > 0 {
				t.out = append(t.out[:0:0], t.out[over:]...)
				t.base += int64(over)
			}
			t.mu.Unlock()
			live.Changed.Notify()
		}
		if err != nil {
			break
		}
	}
	err := t.cmd.Wait()
	code := 0
	if ee, ok := err.(*exec.ExitError); ok {
		code = ee.ExitCode()
	}
	t.mu.Lock()
	t.exited, t.code = true, code
	t.mu.Unlock()
	live.Changed.Notify()
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

// Write types into the terminal.
func (t *Term) Write(s string) error {
	_, err := t.master.WriteString(s)
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
	hangUp(t.cmd.Process.Pid)
	return t.master.Close()
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
