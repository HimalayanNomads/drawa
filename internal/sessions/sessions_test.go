package sessions

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"claude-ui/internal/config"
)

func TestTrimLiveLine(t *testing.T) {
	big := strings.Repeat("x", 50_000)
	line, _ := json.Marshal(map[string]any{
		"type":            "user",
		"message":         map[string]any{"content": []any{map[string]any{"type": "tool_result", "content": big}}},
		"tool_use_result": map[string]any{"stdout": big},
	})
	out := Trimmed(string(line))
	var d map[string]any
	if err := json.Unmarshal([]byte(out), &d); err != nil {
		t.Fatalf("Trimmed produced invalid JSON: %v", err)
	}
	if _, ok := d["tool_use_result"]; ok {
		t.Fatal("tool_use_result should have been dropped")
	}
	content := d["message"].(map[string]any)["content"].([]any)
	text := content[0].(map[string]any)["content"].(string)
	if len(text) >= 21_000 {
		t.Fatalf("content not clipped: %d chars", len(text))
	}
}

func withTempSessions(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	orig := config.Sessions
	config.Sessions = dir
	t.Cleanup(func() { config.Sessions = orig })
	return dir
}

func writeLine(w *os.File, typ string, content any) {
	b, _ := json.Marshal(map[string]any{"type": typ, "message": map[string]any{"content": content}})
	w.Write(b)
	w.Write([]byte("\n"))
}

func TestSubagentIdsFirst(t *testing.T) {
	root := withTempSessions(t)
	f, _ := os.Create(filepath.Join(root, "s.jsonl"))
	writeLine(f, "user", "hi")
	f.Close()
	sub := filepath.Join(root, "s", "subagents")
	os.MkdirAll(sub, 0o755)
	os.WriteFile(filepath.Join(sub, "agent-a1b2.meta.json"), []byte(`{"toolUseId":"toolu_X"}`), 0o644)
	af, _ := os.Create(filepath.Join(sub, "agent-a1b2.jsonl"))
	writeLine(af, "assistant", []any{map[string]any{"type": "text", "text": "ok"}})
	af.Close()

	msgs := Load("s", "")
	if len(msgs) == 0 {
		t.Fatal("expected messages")
	}
	first := msgs[0]
	if first["role"] != "agent" || first["parent"] != "toolu_X" || first["aid"] != "a1b2" {
		t.Fatalf("first message wrong: %#v", first)
	}
	last := msgs[len(msgs)-1]
	if last["parent"] != "toolu_X" {
		t.Fatalf("last message should belong to the agent: %#v", last)
	}
}

func TestSubagentPartialLineAndFinishedAgents(t *testing.T) {
	// An agent still writing its transcript (reload mid-agent) mustn't break loading; a finished agent's
	// messages are left for its window to fetch.
	root := withTempSessions(t)
	f, _ := os.Create(filepath.Join(root, "s.jsonl"))
	writeLine(f, "user", "hi")
	writeLine(f, "user", []any{map[string]any{"type": "tool_result", "tool_use_id": "toolu_DONE", "content": "the report"}})
	f.WriteString(`{"type": "assist`)
	f.Close()
	sub := filepath.Join(root, "s", "subagents")
	os.MkdirAll(sub, 0o755)
	for _, pair := range [][2]string{{"run1", "toolu_RUN"}, {"done1", "toolu_DONE"}} {
		aid, call := pair[0], pair[1]
		os.WriteFile(filepath.Join(sub, "agent-"+aid+".meta.json"), []byte(`{"toolUseId":"`+call+`"}`), 0o644)
		af, _ := os.Create(filepath.Join(sub, "agent-"+aid+".jsonl"))
		writeLine(af, "assistant", []any{map[string]any{"type": "text", "text": "working"}})
		af.WriteString(`{"type": "user", "mess`)
		af.Close()
	}

	msgs := Load("s", "")
	foundLazyDone := false
	for _, m := range msgs {
		if m["aid"] == "done1" && m["lazy"] == true && m["parent"] == "toolu_DONE" {
			foundLazyDone = true
		}
	}
	if !foundLazyDone {
		t.Fatalf("expected a lazy done1 marker, got %#v", msgs)
	}
	for _, m := range msgs {
		if _, hasAid := m["aid"]; !hasAid && m["parent"] != nil {
			if m["parent"] != "toolu_RUN" {
				t.Fatalf("only the running agent's own messages should be inlined, got parent %v", m["parent"])
			}
		}
	}

	one := Load("s", "toolu_DONE")
	if len(one) != 2 || one[0]["aid"] != "done1" {
		t.Fatalf("fetching the finished agent directly should return its id then its messages: %#v", one)
	}
	content := one[1]["content"].([]any)
	text := content[0].(map[string]any)["text"]
	if text != "working" {
		t.Fatalf("expected the agent's own message, got %#v", one[1])
	}
}
