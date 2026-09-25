package live

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"claude-ui/internal/config"
)

func TestDetachFailsPendingCalls(t *testing.T) {
	l := &Live{readers: []string{"a", "b"}, calls: map[string]*Call{}}
	callX := &Call{Done: make(chan struct{}), To: "a"}
	callY := &Call{Done: make(chan struct{}), To: "b"}
	l.calls["x"], l.calls["y"] = callX, callY

	l.Detach("a")

	select {
	case <-callX.Done:
	default:
		t.Fatal("call x (reader a) should have been failed")
	}
	if callX.Result == nil || callX.Result["isError"] != true {
		t.Fatalf("call x should carry an error result, got %#v", callX.Result)
	}
	select {
	case <-callY.Done:
		t.Fatal("call y (reader b, still attached) should still be pending")
	default:
	}
}

// startFake runs a shell script in place of `claude`, wired up like New does.
func startFake(t *testing.T, script string) *Live {
	t.Helper()
	saved := claudeArgv
	savedRoot := config.Root
	claudeArgv, config.Root = []string{"sh", "-c", script}, t.TempDir()
	t.Cleanup(func() { claudeArgv, config.Root = saved, savedRoot })
	l, err := New("", "", "", "")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(l.Close)
	return l
}

// waitExit waits for the pump's exit line and returns its code.
func waitExit(t *testing.T, l *Live) (float64, []string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		lines, _ := l.LinesFrom(0)
		for _, line := range lines {
			var d map[string]any
			if json.Unmarshal([]byte(line), &d) == nil && d["type"] == "exit" {
				return d["code"].(float64), lines
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("no exit line: the pump hung")
	return 0, nil
}

// A line longer than any fixed buffer (a big tool result) is read whole, and the exit still arrives.
func TestLongLineNoCap(t *testing.T) {
	l := startFake(t, `head -c 2000000 /dev/zero | tr '\0' x; echo; echo after; exit 3`)
	code, lines := waitExit(t, l)
	if code != 3 {
		t.Fatalf("exit code %v, want 3", code)
	}
	if len(lines) < 2 || !strings.Contains(lines[0], strings.Repeat("x", 2_000_000)) || !strings.Contains(lines[1], "after") {
		t.Fatalf("long line not read whole (%d lines)", len(lines))
	}
}

// Only one Wait: the exit code is real (not -1), and Close racing the pump is clean under -race.
func TestExitCodeAndClose(t *testing.T) {
	l := startFake(t, `cat >/dev/null; exit 5`)
	go l.Close()
	if code, _ := waitExit(t, l); code != 5 {
		t.Fatalf("exit code %v, want 5", code)
	}
	if l.Alive() {
		t.Fatal("exited process reported alive")
	}
}

// A background child holding stdout open doesn't keep a dead card alive, and writing to it fails.
func TestExitedWithStdoutHeld(t *testing.T) {
	l := startFake(t, `exec 0<&-; sleep 3 & exit 0`)
	deadline := time.Now().Add(2 * time.Second)
	for l.Alive() && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if l.Alive() {
		t.Fatal("card still alive after its process exited")
	}
	if l.Write(map[string]any{"type": "user"}) == nil {
		t.Fatal("write to an exited process should fail")
	}
}
