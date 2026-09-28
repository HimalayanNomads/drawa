package codex

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"drawa/internal/live"
)

// replay runs a recorded app-server session (testdata/*.rpc: everything it printed, one JSON message per line,
// account and rate-limit messages stripped) through a translator, as a card's first thread.
func replay(t *testing.T, path string) []string {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	tr := newTranslator("", "")
	var out []string
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 1<<24)
	for sc.Scan() {
		lines := tr.frame(sc.Bytes())
		for _, l := range lines {
			if strings.HasPrefix(l, `{"type":"control_request"`) { // the recording answered it, as Respond would
				var d struct {
					RequestID string `json:"request_id"`
				}
				json.Unmarshal([]byte(l), &d)
				delete(tr.asks, d.RequestID)
			}
		}
		out = append(out, lines...)
	}
	return out
}

// An ask Codex resolves itself (the turn was stopped before anyone answered) is taken back on the page.
func TestWithdrawnAsk(t *testing.T) {
	tr := newTranslator("t", "m")
	tr.frame([]byte(`{"method":"item/commandExecution/requestApproval","id":7,"params":{"itemId":"c1","command":"ls"}}`))
	got := tr.frame([]byte(`{"method":"serverRequest/resolved","params":{"requestId":7}}`))
	if len(got) != 1 || got[0] != `{"type":"control_cancel_request","request_id":"cx-7"}` {
		t.Errorf("got %q", got)
	}
	if again := tr.frame([]byte(`{"method":"serverRequest/resolved","params":{"requestId":7}}`)); again != nil {
		t.Errorf("twice: %q", again)
	}
}

// A question with no options (free-form) still gives the page a list to loop over.
func TestFreeFormQuestion(t *testing.T) {
	tr := newTranslator("t", "m")
	got := tr.frame([]byte(`{"method":"item/tool/requestUserInput","id":"q1","params":{"itemId":"i","questions":[{"id":"a","header":"H","question":"Name?","options":null}]}}`))
	if len(got) != 1 || !strings.Contains(got[0], `"options":[]`) || !strings.Contains(got[0], `"request_id":"cx-q1"`) {
		t.Errorf("got %q", got)
	}
}

// Every recorded session translates into a stream the page can read, and into what was reviewed by hand
// (UPDATE=1 go test rewrites the .want.jsonl files after a deliberate change).
func TestFixtures(t *testing.T) {
	files, _ := filepath.Glob("testdata/*.rpc")
	if len(files) == 0 {
		t.Fatal("no fixtures")
	}
	for _, f := range files {
		lines := replay(t, f)
		if err := live.CheckWire(lines); err != nil {
			t.Errorf("%s: %v", f, err)
		}
		want := strings.TrimSuffix(f, ".rpc") + ".want.jsonl"
		got := strings.Join(lines, "\n") + "\n"
		if os.Getenv("UPDATE") != "" {
			os.WriteFile(want, []byte(got), 0o644)
		} else if b, err := os.ReadFile(want); err != nil || string(b) != got {
			t.Errorf("%s: translation differs from %s (UPDATE=1 go test to accept a deliberate change)", f, want)
		}
	}
}

func TestUnwrap(t *testing.T) {
	for in, want := range map[string]string{
		"/usr/bin/zsh -lc ls":             "ls",
		`/usr/bin/zsh -lc 'touch y.txt'`:  "touch y.txt",
		`/bin/bash -lc 'echo '\''hi'\'''`: "echo 'hi'",
		"git status":                      "git status",
		"python3 -c 'print(1)' -lc x":     "python3 -c 'print(1)' -lc x",
	} {
		if got := unwrap(in); got != want {
			t.Errorf("unwrap(%q) = %q, want %q", in, got, want)
		}
	}
}

// completedItems is a recording's finished items, as thread/read returns them for a saved thread.
func completedItems(t *testing.T, path string) []threadItem {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var items []threadItem
	for _, l := range strings.Split(string(b), "\n") {
		var m struct {
			Method string `json:"method"`
			Params struct {
				Item threadItem `json:"item"`
			} `json:"params"`
		}
		if json.Unmarshal([]byte(l), &m) == nil && m.Method == "item/completed" {
			items = append(items, m.Params.Item)
		}
	}
	return items
}

// A saved thread reads back as the page's history: the user's message, then the reply with its tool call, the
// call's result, and the rest of the reply.
func TestHistoryConvert(t *testing.T) {
	msgs := convert(completedItems(t, "testdata/tools.rpc"))
	var shape []string
	for _, m := range msgs {
		s := m["role"].(string)
		if list, ok := m["content"].([]any); ok {
			for _, b := range list {
				bm := b.(map[string]any)
				s += " " + bm["type"].(string)
				if n, ok := bm["name"].(string); ok {
					s += ":" + n
				}
			}
		}
		shape = append(shape, s)
	}
	want := []string{"user", "assistant thinking tool_use:Bash", "user tool_result", "assistant text"}
	if !reflect.DeepEqual(shape, want) {
		t.Errorf("shape = %q, want %q", shape, want)
	}

	edit := convert(completedItems(t, "testdata/edit.rpc"))
	in := edit[1]["content"].([]any)[2].(map[string]any)["input"]
	if got, _ := json.Marshal(in); string(got) != `{"edits":[{"new_string":"a\nb\n","old_string":"a\n"}],"file_path":"/tmp/cx/proj/x.txt"}` {
		t.Errorf("edit input = %s", got)
	}
}

func TestHunkEdits(t *testing.T) {
	diff := "--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n@@ -9 +9 @@\n-z\n\\ No newline at end of file\n+Z\n"
	want := []any{map[string]any{"old_string": "a\nb\nc\n", "new_string": "a\nB\nc\n"}, map[string]any{"old_string": "z\n", "new_string": "Z\n"}}
	if got := hunkEdits(diff); !reflect.DeepEqual(got, want) {
		t.Errorf("hunkEdits = %v", got)
	}
}

type buf struct{ strings.Builder }

func (*buf) Close() error { return nil }

// What Respond writes back for each kind of ask.
func TestRespondShapes(t *testing.T) {
	for _, c := range []struct {
		request, want string
		a             live.Answer
	}{
		{`{"method":"item/commandExecution/requestApproval","id":1,"params":{"itemId":"c","command":"ls"}}`,
			`{"id":1,"result":{"decision":"acceptForSession"}}`, live.Answer{Allow: true, Always: true}},
		{`{"method":"item/fileChange/requestApproval","id":2,"params":{"itemId":"f"}}`,
			`{"id":2,"result":{"decision":"decline"}}`, live.Answer{}},
		{`{"method":"item/tool/requestUserInput","id":"u","params":{"itemId":"i","questions":[{"id":"q","question":"Fruit?","options":[{"label":"apple"},{"label":"pear"}]}]}}`,
			`{"id":"u","result":{"answers":{"q":{"answers":["apple, pear"]}}}}`, live.Answer{Allow: true, Answers: map[string]string{"Fruit?": "apple, pear"}}},
		{`{"method":"item/tool/requestUserInput","id":"v","params":{"itemId":"i","questions":[{"id":"q","question":"DB?","options":[{"label":"Postgres"}]}]}}`,
			`{"id":"v","result":{"answers":{"q":{"answers":["Use Postgres, not SQLite"]}}}}`, live.Answer{Allow: true, Answers: map[string]string{"DB?": "Use Postgres, not SQLite"}}},
		{`{"method":"mcpServer/elicitation/request","id":4,"params":{"serverName":"canvas","mode":"url","message":"m","url":"https://x"}}`,
			`{"id":4,"result":{"action":"accept","content":null}}`, live.Answer{Allow: true}},
	} {
		b := &buf{}
		s := &server{tr: newTranslator("t", "m"), stdin: b}
		lines := s.tr.frame([]byte(c.request))
		var d struct {
			RequestID string `json:"request_id"`
		}
		json.Unmarshal([]byte(lines[0]), &d)
		if err := s.Respond(d.RequestID, "", c.a); err != nil {
			t.Fatal(err)
		}
		if got := strings.TrimSpace(b.String()); got != c.want {
			t.Errorf("%s:\n got %s\nwant %s", d.RequestID, got, c.want)
		}
	}
}

// feed runs app-server lines through a translator and returns everything it wrote.
func feed(tr *translator, frames ...string) []string {
	var out []string
	for _, f := range frames {
		out = append(out, tr.frame([]byte(f))...)
	}
	return out
}

const turn1 = `{"method":"turn/started","params":{"turn":{"id":"t1"}}}`

// Codex's plan is drawn as Claude's to-do list, finished at once.
func TestPlanAsTodos(t *testing.T) {
	out := strings.Join(feed(newTranslator("s", "m"), turn1,
		`{"method":"turn/plan/updated","params":{"plan":[{"step":"a","status":"inProgress"},{"step":"b","status":"pending"},{"step":"c","status":"completed"}]}}`), "\n")
	for _, want := range []string{`"name":"TodoWrite"`,
		`{\"activeForm\":\"a\",\"content\":\"a\",\"status\":\"in_progress\"}`, `\"status\":\"pending\"`, `\"status\":\"completed\"`,
		`"type":"tool_result","tool_use_id":"plan-t1-0"`} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %s in\n%s", want, out)
		}
	}
}

// An MCP server's elicitation is asked about the call it interrupts.
func TestElicitationAboutCall(t *testing.T) {
	out := feed(newTranslator("s", "m"), turn1,
		`{"method":"item/started","params":{"item":{"type":"mcpToolCall","id":"m1","server":"canvas","tool":"canvas_create","arguments":{"kind":"note"},"status":"inProgress"}}}`,
		`{"method":"mcpServer/elicitation/request","id":9,"params":{"serverName":"canvas","mode":"form","message":"ok?"}}`)
	last := out[len(out)-1]
	if !strings.Contains(last, `"tool_name":"mcp__canvas__canvas_create"`) || !strings.Contains(last, `"tool_use_id":"m1"`) {
		t.Errorf("got %s", last)
	}
}

// A rename is in the edit's input, for the page and the acceptEdits check.
func TestMovePath(t *testing.T) {
	c := fileCall(change{Path: "a.go", Kind: struct {
		Type     string  `json:"type"`
		MovePath *string `json:"move_path"`
	}{"update", new(string)}})
	if _, ok := c.Input["move_path"]; !ok {
		t.Errorf("input = %v", c.Input)
	}
	var it threadItem
	json.Unmarshal([]byte(`{"type":"fileChange","id":"f","changes":[{"path":"a","kind":{"type":"update","move_path":"b"},"diff":""},{"path":"c","kind":{"type":"update","move_path":null},"diff":""}]}`), &it)
	calls := it.calls()
	if calls[0].Input["move_path"] != "b" {
		t.Errorf("rename: %v", calls[0].Input)
	}
	if _, ok := calls[1].Input["move_path"]; ok {
		t.Errorf("no rename: %v", calls[1].Input)
	}
}

// An approval that grants a whole root says so, and doesn't offer "Always" on top.
func TestGrantRoot(t *testing.T) {
	tr := newTranslator("s", "m")
	got := feed(tr, turn1, `{"method":"item/fileChange/requestApproval","id":3,"params":{"itemId":"f","grantRoot":"/tmp/x","reason":"r"}}`)
	last := got[len(got)-1]
	if strings.Contains(last, "permission_suggestions") || !strings.Contains(last, `under /tmp/x for this session`) || !strings.Contains(last, `"tool_name":"Edit"`) {
		t.Errorf("got %s", last)
	}
	if tr.asks["cx-3"].always {
		t.Error("always offered")
	}
	cmd := feed(tr, `{"method":"item/commandExecution/requestApproval","id":4,"params":{"itemId":"c","command":"ls","reason":"needs network"}}`)[0]
	if !strings.Contains(cmd, "permission_suggestions") || !strings.Contains(cmd, `"description":"needs network"`) || !strings.Contains(cmd, `"tool_name":"Bash"`) {
		t.Errorf("got %s", cmd)
	}
}

// Items arriving after the turn ended don't open a message outside a turn.
func TestLateItem(t *testing.T) {
	tr := newTranslator("s", "m")
	feed(tr, turn1, `{"method":"turn/completed","params":{"turn":{"status":"completed"}}}`)
	late := feed(tr, `{"method":"item/agentMessage/delta","params":{"itemId":"a","delta":"hi"}}`,
		`{"method":"item/started","params":{"item":{"type":"commandExecution","id":"c","command":"ls"}}}`,
		`{"method":"turn/plan/updated","params":{"plan":[{"step":"a","status":"pending"}]}}`)
	if late != nil {
		t.Errorf("got %q", late)
	}
}

// A turn's bookkeeping starts empty: nothing from the previous turn is asked about or finished again.
func TestTurnReset(t *testing.T) {
	tr := newTranslator("s", "m")
	feed(tr, turn1, `{"method":"item/started","params":{"item":{"type":"commandExecution","id":"c1","command":"ls"}}}`,
		`{"method":"turn/completed","params":{"turn":{"status":"completed"}}}`)
	if _, ok := tr.Calls["c1"]; !ok {
		t.Fatal("call not recorded")
	}
	feed(tr, `{"method":"turn/started","params":{"turn":{"id":"t2"}}}`)
	if len(tr.Calls) != 0 || len(tr.Blocks) != 0 || len(tr.Results) != 0 {
		t.Errorf("turn 1 left %v %v %v", tr.Calls, tr.Blocks, tr.Results)
	}
}

// A message added mid-turn (recorded: turn/steer while a command ran) is echoed with the page's id, so the server
// counts it delivered and doesn't send it again when the turn ends.
func TestSteerEchoed(t *testing.T) {
	b, err := os.ReadFile("testdata/steer.rpc")
	if err != nil {
		t.Fatal(err)
	}
	s := &server{tr: newTranslator("", ""), pending: map[int]chan reply{}, stdin: &buf{}, steered: []steered{{id: "steer-1"}}}
	echoed := false
	for _, l := range strings.Split(strings.TrimSpace(string(b)), "\n") {
		if strings.Contains(l, `"method":"turn/completed"`) {
			break // it would clear what's left anyway (and re-send it): check before
		}
		for _, out := range s.handle([]byte(l)) {
			echoed = echoed || strings.Contains(out, `"uuid":"steer-1"`)
		}
	}
	if !echoed || len(s.steered) != 0 {
		t.Errorf("echoed %v, still steered %v", echoed, s.steered)
	}
}
