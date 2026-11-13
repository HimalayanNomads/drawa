package term

import (
	"bytes"
	"os"
	"path/filepath"
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
	t.Setenv("ENV", "") // no rc file: a predictable prompt

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
