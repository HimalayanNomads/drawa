package term

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"drawa/internal/config"
)

// waitFor polls a terminal's output until it contains want (or fails after a few seconds).
func waitFor(t *testing.T, term *Term, want string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if out, _, _, _ := term.Since(0); bytes.Contains(out, []byte(want)) {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	out, _, _, _ := term.Since(0)
	t.Fatalf("output never had %q; got %q", want, out)
}

func TestShell(t *testing.T) {
	if !supported {
		t.Skip("no pseudo-terminals here")
	}
	saved := config.Root
	config.Root, _ = filepath.EvalSymlinks(t.TempDir())
	t.Cleanup(func() { config.Root = saved })
	t.Setenv("SHELL", "/bin/sh")
	t.Setenv("HOME", t.TempDir()) // the shell setting is read from ~/.drawa: none here
	t.Setenv("ENV", "")           // no rc file: a predictable prompt

	id, err := Open("", 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	term := Get(id)
	term.Write("stty size; pwd; echo h''i\r") // h''i: the echoed command line doesn't match "hi"
	waitFor(t, term, "24 80")
	waitFor(t, term, config.Root)
	waitFor(t, term, "hi")

	term.Resize(100, 30)
	term.Write("stty size\r")
	waitFor(t, term, "30 100")

	term.Write("exit 3\r")
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, _, exited, code := term.Since(0); exited {
			if code != 3 {
				t.Fatalf("exit code %d, want 3", code)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("shell never exited")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if Close(id) != nil || Get(id) != nil {
		t.Fatal("close kept the terminal")
	}
	if Close(id) != ErrGone {
		t.Fatal("closing twice should say it's gone")
	}
}

func TestOutsideRoot(t *testing.T) {
	saved := config.Root
	config.Root = t.TempDir()
	t.Cleanup(func() { config.Root = saved })
	if _, err := Open("..", 80, 24); err == nil {
		t.Fatal("opened a shell outside the project")
	}
	os.WriteFile(filepath.Join(config.Root, "f"), nil, 0o600)
	if _, err := Open("f", 80, 24); err == nil {
		t.Fatal("opened a shell in a file")
	}
}

func TestBufferTrim(t *testing.T) {
	term := &Term{}
	term.out = bytes.Repeat([]byte("a"), Keep)
	term.base = 100
	data, next, _, _ := term.Since(0) // older than what's kept: from the oldest kept byte
	if len(data) != Keep || next != 100+Keep {
		t.Fatalf("len %d next %d", len(data), next)
	}
	if data, _, _, _ := term.Since(next); len(data) != 0 {
		t.Fatal("nothing new should be empty")
	}
	if data, _, _, _ := term.Since(next - 5); len(data) != 5 {
		t.Fatal("tail")
	}
}

// The --net sign-in token never reaches a shell's environment.
func TestShellEnvDropsNetToken(t *testing.T) {
	t.Setenv(config.NetTokenEnv, "secret-token-value-123456")
	for _, v := range shellEnv() {
		if strings.HasPrefix(v, config.NetTokenEnv+"=") {
			t.Fatal("net token passed to the shell")
		}
	}
}

// shellIn starts /bin/sh with no rc file in a fresh project folder, closed when the test ends.
func shellIn(t *testing.T) (string, *Term) {
	t.Helper()
	if !supported {
		t.Skip("no pseudo-terminals here")
	}
	saved := config.Root
	config.Root, _ = filepath.EvalSymlinks(t.TempDir())
	t.Cleanup(func() { config.Root = saved })
	t.Setenv("SHELL", "/bin/sh")
	t.Setenv("HOME", t.TempDir())
	t.Setenv("ENV", "")
	id, err := Open("", 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { Close(id) })
	return id, Get(id)
}

// Closing a shell that's running something ends that program too.
func TestCloseKillsBusyChildren(t *testing.T) {
	id, term := shellIn(t)
	term.Write(`sh -c "echo pi''d=\$\$ e''nd; exec sleep 300"` + "\r") // '' keeps the echoed command line from matching
	waitFor(t, term, " end")
	out, _, _, _ := term.Since(0)
	// the last pid=: a login profile may print its own before it (systemd's OSC 3008 context carries one)
	after := out[bytes.LastIndex(out, []byte("pid="))+len("pid="):]
	number, _, _ := strings.Cut(string(after), " end")
	pid, err := strconv.Atoi(number)
	if err != nil {
		t.Fatalf("no pid in %q", out)
	}
	Close(id)
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		stat, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
		if syscall.Kill(pid, 0) != nil || (err == nil && bytes.Contains(stat, []byte(") Z "))) {
			return // gone, or a zombie waiting to be reaped
		}
	}
	t.Fatal("the shell's program outlived the terminal")
}

// Keys for a program that isn't reading give up instead of hanging the request.
func TestKeysToBusyProgramDontHang(t *testing.T) {
	_, term := shellIn(t)
	term.Write("stty raw -echo; echo rea''dy; sleep 30\r")
	waitFor(t, term, "ready")
	start, big := time.Now(), strings.Repeat("x", 32<<10)
	for i := 0; i < 10; i++ {
		if err := term.Write(big); err != nil {
			if err != ErrBusy {
				t.Fatalf("want ErrBusy, got %v", err)
			}
			if time.Since(start) > 6*time.Second {
				t.Fatalf("took %v", time.Since(start))
			}
			return
		}
	}
	t.Fatal("320 KB went into a terminal nobody reads")
}

// Past Max, no shell starts.
func TestMaxTerminals(t *testing.T) {
	mu.Lock()
	for i := range Max {
		terms[fmt.Sprint("held", i)] = nil
	}
	mu.Unlock()
	t.Cleanup(func() {
		mu.Lock()
		for i := range Max {
			delete(terms, fmt.Sprint("held", i))
		}
		mu.Unlock()
	})
	if _, err := Open("", 80, 24); err != ErrTooMany {
		t.Fatalf("want ErrTooMany, got %v", err)
	}
}

// An ended shell gives its place back after Linger, even if no page closes it.
func TestExitedShellIsForgotten(t *testing.T) {
	saved := Linger
	Linger = 50 * time.Millisecond
	t.Cleanup(func() { Linger = saved })
	id, term := shellIn(t)
	term.Write("exit\r")
	for deadline := time.Now().Add(5 * time.Second); Get(id) != nil; time.Sleep(20 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("an exited shell kept its place")
		}
	}
}

// A shell that exits while a job it started still holds the terminal is reported as exited (and reaped) anyway.
func TestExitWithBackgroundJob(t *testing.T) {
	_, term := shellIn(t)
	term.Write("sleep 30 &\r")
	time.Sleep(200 * time.Millisecond)
	term.Write("exit 4\r")
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		if _, _, exited, code := term.Since(0); exited {
			if code != 4 {
				t.Fatalf("exit code %d, want 4", code)
			}
			return
		}
	}
	t.Fatal("the shell's exit was never reported")
}
