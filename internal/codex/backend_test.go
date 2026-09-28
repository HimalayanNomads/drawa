package codex

import (
	"bufio"
	"io"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"drawa/internal/config"
	"drawa/internal/live"
)

func inRoot(t *testing.T) string {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	old := config.Root
	t.Cleanup(func() { config.Root = old })
	config.Root = root
	return root
}

func testServer(mode string) (*server, *buf) {
	b := &buf{}
	return &server{tr: newTranslator("th", "m"), pending: map[int]chan reply{}, stdin: b, mode: mode, thread: "th"}, b
}

// written waits for what a goroutine writes to stdin (the auto-accept answers from one).
func written(s *server, b *buf) string {
	for range 100 {
		s.wmu.Lock()
		got := b.String()
		s.wmu.Unlock()
		if got != "" {
			return got
		}
		time.Sleep(10 * time.Millisecond)
	}
	return ""
}

// acceptEdits answers a file change itself only inside the project, outside its guarded folders, and without a
// grant for a whole folder; otherwise the page is asked.
func TestAcceptEdits(t *testing.T) {
	root := inRoot(t)
	ask := `{"method":"item/fileChange/requestApproval","id":5,"params":{"threadId":"th","itemId":"f1"}}`
	cases := []struct {
		name  string
		input map[string]any
		ask   string
		auto  bool
	}{
		{"inside", map[string]any{"file_path": root + "/a.go"}, ask, true},
		{"relative move inside", map[string]any{"file_path": root + "/a.go", "move_path": "b/c.go"}, ask, true},
		{"outside", map[string]any{"file_path": "/etc/passwd"}, ask, false},
		{"git", map[string]any{"file_path": root + "/.git/config"}, ask, false},
		{"claude", map[string]any{"file_path": root + "/sub/.claude/settings.json"}, ask, false},
		{"moved outside", map[string]any{"file_path": root + "/a.go", "move_path": "/tmp/elsewhere.go"}, ask, false},
		{"moved into codex", map[string]any{"file_path": root + "/a.go", "move_path": root + "/.codex/config.toml"}, ask, false},
		{"grant root", map[string]any{"file_path": root + "/a.go"}, strings.Replace(ask, `"itemId"`, `"grantRoot":"/","itemId"`, 1), false},
	}
	for _, c := range cases {
		s, b := testServer("acceptEdits")
		s.tr.Calls["f1"] = live.ToolCall{Name: "Edit", Input: c.input}
		lines := s.handle([]byte(c.ask))
		if c.auto {
			if len(lines) != 0 || !strings.Contains(written(s, b), `"decision":"accept"`) {
				t.Errorf("%s: not accepted: %q %q", c.name, lines, b.String())
			}
			continue
		}
		if len(lines) != 1 || !strings.HasPrefix(lines[0], `{"type":"control_request"`) {
			t.Errorf("%s: not asked: %q", c.name, lines)
		}
	}
}

func TestProjectArgs(t *testing.T) {
	inRoot(t)
	oldC, oldT := config.Cloned, config.Trusted
	t.Cleanup(func() { config.Cloned, config.Trusted = oldC, oldT })
	config.Cloned, config.Trusted = true, false
	a, err := projectArgs()
	s := strings.Join(a, " ")
	if err != nil || !strings.Contains(s, "project_doc_max_bytes=0") || !strings.Contains(s, `trust_level="untrusted"`) {
		t.Errorf("untrusted: %q %v", s, err)
	}
	config.Trusted = true
	a, err = projectArgs()
	s = strings.Join(a, " ")
	if err != nil || strings.Contains(s, "project_doc_max_bytes") || !strings.Contains(s, `trust_level="trusted"`) {
		t.Errorf("trusted: %q %v", s, err)
	}
	config.Root = "/tmp/bad\xff"
	if _, err := projectArgs(); err == nil {
		t.Error("invalid UTF-8 path accepted")
	}
}

func TestTomlString(t *testing.T) {
	for in, want := range map[string]string{
		`/a "b"`:   `"/a \"b\""`,
		`C:\x`:     `"C:\\x"`,
		"a\nb\x7f": `"a\u000Ab\u007F"`,
		"/café/日本": `"/café/日本"`,
	} {
		if got, ok := tomlString(in); !ok || got != want {
			t.Errorf("%q: got %s %v, want %s", in, got, ok, want)
		}
	}
	if _, ok := tomlString("a\xffb"); ok {
		t.Error("invalid UTF-8 accepted")
	}
}

// A steered message Codex reads (its userMessage echoes the id) is no longer waiting to be sent again.
func TestSteeredDelivered(t *testing.T) {
	s, _ := testServer("default")
	s.turn = "t1"
	s.steered = []steered{{"m1", "one"}, {"m2", "two"}}
	s.handle([]byte(`{"method":"item/started","params":{"threadId":"th","item":{"type":"userMessage","id":"u","clientId":"m1","content":[]}}}`))
	if len(s.steered) != 1 || s.steered[0].id != "m2" {
		t.Errorf("left %v", s.steered)
	}
	// another thread's notification (a sub-agent's) doesn't count
	s.handle([]byte(`{"method":"item/started","params":{"threadId":"other","item":{"type":"userMessage","id":"v","clientId":"m2","content":[]}}}`))
	if !slices.ContainsFunc(s.steered, func(q steered) bool { return q.id == "m2" }) {
		t.Error("another thread's echo delivered m2")
	}
}

// Stop before turn/start's reply names the turn stops it once turn/started does.
func TestStopWhileStarting(t *testing.T) {
	s, b := testServer("default")
	s.sends = 1
	if err := s.Interrupt(); err != nil || !s.stopWanted {
		t.Fatalf("not remembered: %v", err)
	}
	s.handle([]byte(`{"method":"turn/started","params":{"threadId":"th","turn":{"id":"t9"}}}`))
	if got := written(s, b); !strings.Contains(got, `"method":"turn/interrupt"`) || !strings.Contains(got, `"turnId":"t9"`) || s.stopWanted {
		t.Errorf("got %q", got)
	}
}

// Leaving full access stops what runs with it, and only that.
func TestLeavingBypass(t *testing.T) {
	// a turn running with full access: interrupted
	pr, pw := io.Pipe()
	s := &server{tr: newTranslator("t", "m"), pending: map[int]chan reply{}, stdin: pw, thread: "th", turn: "u1", sentMode: "bypassPermissions", mode: "bypassPermissions"}
	wrote := make(chan string, 1)
	go func() { // read the interrupt call, then answer it
		line, _ := bufio.NewReader(pr).ReadString('\n')
		wrote <- line
		s.handle([]byte(`{"id":1,"result":{}}`))
	}()
	if err := s.SetMode("default"); err != nil {
		t.Fatal(err)
	}
	if w := <-wrote; !strings.Contains(w, `"turn/interrupt"`) || !strings.Contains(w, `"turnId":"u1"`) {
		t.Fatalf("running: wrote %s", w)
	}
	// a turn about to start in the safe mode already: left alone
	s = &server{tr: newTranslator("t", "m"), sends: 1, sentMode: "bypassPermissions", startingMode: "default"}
	s.SetMode("default")
	if s.stopWanted {
		t.Error("stopped a turn starting in the safe mode")
	}
	// one about to start with full access: stopped once its id is known
	s = &server{tr: newTranslator("t", "m"), sends: 1, startingMode: "bypassPermissions"}
	s.SetMode("plan")
	if !s.stopWanted {
		t.Error("didn't stop a turn starting with full access")
	}
}
