package live

import (
	"encoding/json"
	"errors"
	"os"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"

	"drawa/internal/config"
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

// startFake runs a shell script in place of `claude`, through the claude backend.
func startFake(t *testing.T, script string) *Live {
	t.Helper()
	saved := claudeArgv
	savedRoot := config.Root
	claudeArgv, config.Root = []string{"sh", "-c", script}, t.TempDir()
	t.Cleanup(func() { claudeArgv, config.Root = saved, savedRoot })
	l, err := New("", "claude", "", "", "", "")
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
	if l.Send("", "") == nil {
		t.Fatal("write to an exited process should fail")
	}
}

// The exit line arrives even while a grandchild still holds stdout (the read end closes pipeGrace after exit).
func TestExitLineWithStdoutHeld(t *testing.T) {
	l := startFake(t, `sleep 5 & exit 4`)
	start := time.Now()
	if code, _ := waitExit(t, l); code != 4 {
		t.Fatalf("exit code %v, want 4", code)
	}
	if time.Since(start) > 4*time.Second {
		t.Fatal("exit line waited for the grandchild")
	}
}

// Every line pushed is a non-empty JSON object: noise, `{}` and broken JSON become error lines.
func TestClassifyWrapsNonJSON(t *testing.T) {
	l := NewForTest("", "g")
	for _, in := range []string{"warning: x", "{}", "{ }", "{not json", `{"type":"x"}`} {
		var d map[string]any
		out := l.classify(in)
		if json.Unmarshal([]byte(out), &d) != nil || d["type"] == nil {
			t.Fatalf("%q -> %q: not a typed JSON object", in, out)
		}
	}
}

// An ask the agent takes back is gone: not re-sent to a page that attaches, and it no longer keeps the card working.
func TestCancelledAskIsGone(t *testing.T) {
	l := NewForTest("", "g")
	l.Emit(`{"type":"control_request","request_id":"r1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{}}}`)
	if len(l.Snapshot().Asks) != 1 || !l.working() {
		t.Fatalf("ask not tracked: %v", l.Snapshot().Asks)
	}
	l.Emit(`{"type":"control_cancel_request","request_id":"r1"}`)
	if a := l.Snapshot().Asks; len(a) != 0 || l.working() {
		t.Fatalf("after cancel: asks %v, working %v", a, l.working())
	}
}

type failing struct{ Backend }

func (failing) SetMode(string) error   { return &Refused{errors.New("not mid-turn")} }
func (failing) Interrupt() error       { return errors.New("broken pipe") }
func (failing) Kill()                  {}
func (failing) Send(any, string) error { return &Refused{errors.New("no such thread")} }

// A Refused error is passed on, but the process stays alive; any other one marks it gone.
func TestRefusedKeepsProcess(t *testing.T) {
	l := NewForTest("", "g")
	l.be = failing{}
	if err := l.ChangeMode("plan"); err == nil || !l.Alive() {
		t.Fatalf("refused: err %v, alive %v", err, l.Alive())
	}
	if err := l.Send("hi", ""); err == nil || !l.Alive() || l.working() { // no turn came, so the card isn't busy
		t.Fatalf("refused send: err %v, alive %v, working %v", err, l.Alive(), l.working())
	}
	if err := l.Interrupt(); err == nil || l.Alive() {
		t.Fatalf("broken: err %v, alive %v", err, l.Alive())
	}
}

// After a turn's result, the next message drops what came before it, but never past the message being streamed;
// halving for Keep keeps that start too.
func TestTrimKeepsOpenMsg(t *testing.T) {
	l := NewForTest("", "g")
	l.be = nopBackend{}
	push := func(s string) { l.Push(l.classify(s) + "\n") }
	push(`{"type":"a"}`)
	push(`{"type":"result"}`) // index 1
	push(`{"type":"b"}`)
	l.Send("", "")
	if s := l.Snapshot(); s.Base != 1 || s.End != 3 {
		t.Fatalf("after next message: base %d end %d, want 1 3", s.Base, s.End)
	}
	push(`{"type":"stream_event","event":{"type":"message_start"}}`) // index 3
	push(`{"type":"result"}`)                                        // an open message outlives it here
	l.Send("", "")
	if s := l.Snapshot(); s.Base != 3 || *s.OpenMsg != 3 {
		t.Fatalf("trim passed the open message: base %d", s.Base)
	}
	l.mu.Lock()
	l.dropTo(l.base + len(l.lines))
	base := l.base
	l.mu.Unlock()
	if base != 3 {
		t.Fatalf("halving passed the open message: base %d", base)
	}
}

// nopBackend takes everything and does nothing.
type nopBackend struct{}

func (nopBackend) Send(any, string) error               { return nil }
func (nopBackend) Respond(string, string, Answer) error { return nil }
func (nopBackend) SetMode(string) error                 { return nil }
func (nopBackend) SetModel(string) error                { return nil }
func (nopBackend) Interrupt() error                     { return nil }
func (nopBackend) Close()                               {}
func (nopBackend) Kill()                                {}

// Over the cap, the least recently used idle card goes; working ones (a turn, an approval, a background agent)
// and the new one stay. With no cap (the default) nothing goes.
func TestEvictLRUIdle(t *testing.T) {
	Mu.Lock()
	saved, savedMax := Registry, config.MaxLive
	Registry, config.MaxLive = map[string]*Live{}, 4
	t.Cleanup(func() { Mu.Lock(); Registry, config.MaxLive = saved, savedMax; Mu.Unlock() })
	old := time.Now().Add(-time.Hour)
	for i := 0; i <= config.MaxLive; i++ {
		l := NewForTest("", "g")
		l.last = time.Now()
		Registry[string(rune('a'+i))] = l
	}
	Registry["a"].last, Registry["a"].busy = old.Add(-time.Hour), true
	Registry["b"].last, Registry["b"].asks = old.Add(-time.Hour), []ask{{"r", "{}"}}
	Registry["e"].last, Registry["e"].tasks = old.Add(-time.Hour), map[string]bool{"agent1": true}
	Registry["c"].last = old
	Registry["d"].last = old.Add(-2 * time.Hour) // oldest idle, but it's the one being started
	config.MaxLive = 0
	none := evictLocked("d")
	config.MaxLive = 4
	victim := evictLocked("d")
	_, stillC := Registry["c"]
	Mu.Unlock()
	if none != nil {
		t.Fatal("evicted with no cap set")
	}
	if victim == nil || stillC {
		t.Fatalf("expected c evicted, got %v (c still registered: %v)", victim, stillC)
	}
}

// A background agent keeps its card working from its launch until a notification names it.
func TestTrackTasks(t *testing.T) {
	l := NewForTest("", "g")
	launch := `{"type":"user","message":{"content":[{"type":"tool_result","content":[{"type":"text","text":"Async agent launched successfully.\nagentId: a1b2c3 (internal ID)"}]}]}}`
	for _, line := range []string{launch, strings.Replace(launch, "a1b2c3", "d4e5f6", 1)} {
		l.trackTasks(line)
	}
	if len(l.tasks) != 2 {
		t.Fatalf("tasks %v, want 2", l.tasks)
	}
	l.trackTasks(`{"type":"system","subtype":"task_notification","task_id":"a1b2c3","status":"completed"}`)
	if l.tasks["a1b2c3"] || !l.working() {
		t.Fatalf("after one notification: %v, working %v", l.tasks, l.working())
	}
	l.trackTasks(`{"type":"user","message":{"content":"<task-notification>\n<task-id>d4e5f6</task-id>\n<status>stopped</status>"}}`)
	if l.working() {
		t.Fatalf("still working: %v", l.tasks)
	}
}

// The canvas MCP config reaches claude as a 0600 file (not on the command line), removed when it exits.
func TestMCPConfigFile(t *testing.T) {
	saved, savedRoot := claudeArgv, config.Root
	// ls -l, not stat: stat's flags differ between GNU (Linux) and BSD (macOS)
	claudeArgv, config.Root = []string{"sh", "-c", `ls -l "$1" | cut -c1-10; cat "$1"; echo`}, t.TempDir()
	t.Cleanup(func() { claudeArgv, config.Root = saved, savedRoot })
	l, err := New("card", "claude", "", "", "", "")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(l.Close)
	waitExit(t, l)
	lines, _ := l.LinesFrom(0)
	all := strings.Join(lines, "")
	if !strings.Contains(all, "-rw-------") || !strings.Contains(all, "/mcp/card/"+l.Token) {
		t.Fatalf("config file not passed as expected: %s", all)
	}
	<-l.done
	if _, err := os.Stat(l.be.(*claude).mcpCfg); !os.IsNotExist(err) {
		t.Fatal("config file left behind")
	}
}

// A backend nobody registered can't start a card, and leaves nothing registered.
func TestStartUnknownBackend(t *testing.T) {
	if _, err := Start("11111111-1111-1111-1111-111111111111", "nope", "", "", "", ""); err == nil {
		t.Fatal("started a card with an unknown backend")
	}
	Mu.Lock()
	defer Mu.Unlock()
	if _, ok := Registry["11111111-1111-1111-1111-111111111111"]; ok {
		t.Fatal("unknown backend left a card registered")
	}
}

type slowRefuse struct {
	nopBackend
	gate chan struct{}
}

func (b slowRefuse) Send(any, string) error { <-b.gate; return &Refused{errors.New("turned down")} }

// A card stays busy while any send may still start a turn, and stops being busy once every one was turned down.
func TestRefusedSendsBusy(t *testing.T) {
	l := NewForTest("", "g")
	gate := make(chan struct{})
	l.be = slowRefuse{gate: gate}
	done := make(chan struct{})
	for range 2 { // two overlapping sends, both refused
		go func() { l.Send("a", ""); done <- struct{}{} }()
	}
	for !func() bool { l.mu.Lock(); defer l.mu.Unlock(); return l.inflight == 2 }() {
		runtime.Gosched()
	}
	gate <- struct{}{}
	<-done
	if !l.working() {
		t.Error("not busy with a send still in flight")
	}
	close(gate)
	<-done
	if l.working() {
		t.Error("still busy after every send was turned down")
	}
	l.mu.Lock()
	l.accepted = true // one was taken (its turn is coming): a refused one doesn't clear busy
	l.busy = true
	l.mu.Unlock()
	l.be = slowRefuse{gate: closed()}
	l.Send("b", "")
	if !l.working() {
		t.Error("cleared busy while an accepted send's turn is coming")
	}
}

func closed() chan struct{} { c := make(chan struct{}); close(c); return c }

// Messages sent but not echoed back yet are reported as queued to pages that attach; a local command's turn (no
// echo) answers the oldest.
func TestQueuedOnAttach(t *testing.T) {
	l := NewForTest("", "g")
	l.be = nopBackend{}
	push := func(s string) { l.Push(l.classify(s) + "\n") }
	l.Send("one", "u1")
	l.Send("two", "u2")
	push(`{"type":"user","message":{"content":"one"},"uuid":"u1"}`)
	if s := l.Snapshot(); !slices.Equal(s.Queued, []string{"u2"}) || !s.Picked {
		t.Fatalf("mid-turn: queued %v picked %v", s.Queued, s.Picked)
	}
	push(`{"type":"result","subtype":"success"}`)
	if s := l.Snapshot(); !slices.Equal(s.Queued, []string{"u2"}) || s.Picked {
		t.Fatalf("after the turn: queued %v picked %v", s.Queued, s.Picked)
	}
	push(`{"type":"result","subtype":"success"}`) // u2 was /cost: its turn ended without an echo
	if s := l.Snapshot(); len(s.Queued) != 0 {
		t.Fatalf("local command's turn left %v queued", s.Queued)
	}
}

type closeCount struct {
	nopBackend
	closed *int
}

func (c closeCount) Close() { *c.closed++ }

// An idle card asked for another effort gets a new process; a working one, or the same effort, keeps its own.
func TestEffortReplacesIdle(t *testing.T) {
	closed := 0
	Register("test-effort", Kind{Spawn: func(Spec, Sink) (Backend, error) { return closeCount{closed: &closed}, nil }})
	const cid = "22222222-2222-2222-2222-222222222222"
	t.Cleanup(func() { Mu.Lock(); delete(Registry, cid); Mu.Unlock(); delete(kinds, "test-effort") })
	a, _ := Start(cid, "test-effort", "", "", "", "high")
	if b, _ := Start(cid, "test-effort", "", "", "", "high"); b != a || closed != 0 {
		t.Fatal("same effort: replaced")
	}
	a.mu.Lock()
	a.busy = true
	a.mu.Unlock()
	if b, _ := Start(cid, "test-effort", "", "", "", "low"); b != a {
		t.Fatal("replaced mid-turn")
	}
	a.mu.Lock()
	a.busy = false
	a.mu.Unlock()
	b, _ := Start(cid, "test-effort", "", "", "", "low")
	if b == a || closed != 1 || !a.replaced {
		t.Fatalf("idle with another effort: same process %v, closed %d", b == a, closed)
	}
}
