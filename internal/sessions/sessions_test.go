package sessions

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"drawa/internal/config"
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

func TestLongLineAndBigInts(t *testing.T) {
	// A line longer than the read buffer mustn't end the transcript, and ids past 2^53 in tool inputs keep every digit.
	root := withTempSessions(t)
	f, _ := os.Create(filepath.Join(root, "s.jsonl"))
	writeLine(f, "user", []any{map[string]any{"type": "tool_result", "tool_use_id": "x", "content": strings.Repeat("é", 2<<20)}})
	f.WriteString(`{"type":"assistant","message":{"content":[{"type":"tool_use","input":{"id":12345678901234567891}}]}}` + "\n")
	f.Close()
	msgs := Load("s", "")
	if len(msgs) != 2 {
		t.Fatalf("expected both messages, got %d", len(msgs))
	}
	if c := msgs[0]["content"].([]any)[0].(map[string]any)["content"].(string); c != strings.Repeat("é", ClipLen)+"\n… (truncated)" {
		t.Fatalf("tool output not clipped to %d characters: %d bytes", ClipLen, len(c))
	}
	b, _ := json.Marshal(msgs[1]["content"])
	if !strings.Contains(string(b), "12345678901234567891") {
		t.Fatalf("big int rounded: %s", b)
	}
}

func TestQueuedHandback(t *testing.T) {
	root := withTempSessions(t)
	f, _ := os.Create(filepath.Join(root, "s.jsonl"))
	prompt := "<agent-message from=\"a1\">\n  report\n</agent-message>"
	for _, a := range []map[string]any{
		{"type": "queued_command", "prompt": prompt},
		{"type": "queued_command", "prompt": "a message you typed"}, // has its own user line
	} {
		b, _ := json.Marshal(map[string]any{"type": "attachment", "attachment": a})
		f.Write(append(b, '\n'))
	}
	f.Close()

	msgs := Load("s", "")
	if len(msgs) != 1 || msgs[0]["role"] != "user" || msgs[0]["isMeta"] != true {
		t.Fatalf("want the hand-back as one meta user message: %#v", msgs)
	}
	if text := msgs[0]["content"].([]any)[0].(map[string]any)["text"]; text != prompt {
		t.Fatalf("text changed: %q", text)
	}
}

func TestListTitles(t *testing.T) {
	dir := withTempSessions(t)
	write := func(id string, lines ...[2]any) {
		f, _ := os.Create(filepath.Join(dir, id+".jsonl"))
		defer f.Close()
		for _, l := range lines {
			writeLine(f, l[0].(string), l[1])
		}
	}
	reply := [2]any{"assistant", []any{map[string]any{"type": "text", "text": "ok"}}}
	write("pasted", // text beside an image, after a tool-result-only message
		[2]any{"user", []any{map[string]any{"type": "tool_result", "content": "x"}}},
		[2]any{"user", []any{map[string]any{"type": "image"}, map[string]any{"type": "text", "text": "what is this"}}},
		reply)
	write("usage", // Drawa's /usage probe: never answered by the model
		[2]any{"user", "<local-command-caveat>Caveat</local-command-caveat>"},
		[2]any{"user", "<command-name>/usage</command-name>"})
	write("plain", [2]any{"user", "<command-name>/clear</command-name>"}, [2]any{"user", "hello"}, reply)
	got := map[string]string{}
	for _, s := range List() {
		got[s.ID] = s.Title
	}
	want := map[string]string{"pasted": "what is this", "plain": "hello"}
	if len(got) != len(want) || got["pasted"] != want["pasted"] || got["plain"] != want["plain"] {
		t.Fatalf("List titles = %v, want %v", got, want)
	}
}

func writeRaw(w *os.File, entry map[string]any) {
	b, _ := json.Marshal(entry)
	w.Write(b)
	w.Write([]byte("\n"))
}

func TestTitlePrefersRename(t *testing.T) {
	dir := withTempSessions(t)
	path := filepath.Join(dir, "renamed.jsonl")
	f, _ := os.Create(path)
	defer f.Close()
	writeLine(f, "user", "fix the login bug")
	writeLine(f, "assistant", []any{map[string]any{"type": "text", "text": `I'll grep for "custom-title"`}})
	titleOf := func() string { return List()[0].Title }
	if got := titleOf(); got != "fix the login bug" {
		t.Fatalf("first prompt: got %q", got)
	}
	writeRaw(f, map[string]any{"type": "ai-title", "aiTitle": "Login bug fix"})
	if got := titleOf(); got != "Login bug fix" {
		t.Fatalf("generated title (read from where the last list stopped): got %q", got)
	}
	writeRaw(f, map[string]any{"type": "custom-title", "customTitle": "AUTH"})
	writeRaw(f, map[string]any{"type": "ai-title", "aiTitle": "Later name"})
	if got := titleOf(); got != "AUTH" {
		t.Fatalf("rename wins over a later generated title: got %q", got)
	}
	writeRaw(f, map[string]any{"type": "custom-title", "customTitle": "AUTH v2"})
	if got := titleOf(); got != "AUTH v2" {
		t.Fatalf("the last rename counts: got %q", got)
	}
	for _, query := range []string{"auth", "login BUG", "later", "renamed"} {
		if len(Search(query)) != 1 {
			t.Fatalf("Search(%q) should find it by any of its names or its id", query)
		}
	}
	if len(Search("auth payments")) != 0 {
		t.Fatal("every word must match")
	}
}

func TestSearchBeyondTheList(t *testing.T) {
	dir := withTempSessions(t)
	reply := []any{map[string]any{"type": "text", "text": "ok"}}
	for index := range MaxListed + 10 {
		path := filepath.Join(dir, fmt.Sprintf("s%03d.jsonl", index))
		f, _ := os.Create(path)
		prompt := "routine work"
		if index == 0 {
			prompt = "the oldest one"
		}
		writeLine(f, "user", prompt)
		writeLine(f, "assistant", reply)
		f.Close()
		at := time.Now().Add(time.Duration(index) * time.Minute) // s000 oldest
		os.Chtimes(path, at, at)
	}
	if list := List(); len(list) != MaxListed || list[len(list)-1].ID == "s000" {
		t.Fatalf("List: want the newest %d, got %d", MaxListed, len(list))
	}
	if found := Search("oldest"); len(found) != 1 || found[0].ID != "s000" {
		t.Fatalf("Search past the list: got %v", found)
	}
	if found := Search("s000"); len(found) != 1 {
		t.Fatalf("Search by id: got %v", found)
	}
}

func TestLongTranscriptSkimsItsMiddle(t *testing.T) {
	dir := withTempSessions(t)
	f, _ := os.Create(filepath.Join(dir, "long.jsonl"))
	defer f.Close()
	writeLine(f, "user", "start the big refactor")
	writeLine(f, "assistant", []any{map[string]any{"type": "text", "text": "ok"}})
	filler := []any{map[string]any{"type": "text", "text": strings.Repeat("x", 4096)}}
	writeRaw(f, map[string]any{"type": "custom-title", "customTitle": "Old name"})
	for written := 0; written < headBytes+tailBytes; written += 4096 {
		writeLine(f, "assistant", filler)
	}
	writeRaw(f, map[string]any{"type": "custom-title", "customTitle": "Newest name"})
	writeLine(f, "assistant", filler)
	if got := List()[0].Title; got != "Newest name" {
		t.Fatalf("the newest title from the end: got %q", got)
	}
	if len(Search("refactor")) != 1 {
		t.Fatal("the first prompt from the start")
	}
	writeRaw(f, map[string]any{"type": "custom-title", "customTitle": "Renamed later"})
	if got := List()[0].Title; got != "Renamed later" {
		t.Fatalf("later reads pick up from where the skim stopped: got %q", got)
	}
}

func TestHugeFirstMessageIsReadWhole(t *testing.T) {
	dir := withTempSessions(t)
	f, _ := os.Create(filepath.Join(dir, "picture.jsonl"))
	defer f.Close()
	// a first message carrying a pasted picture, crossing headBytes: its prompt still names the session
	writeLine(f, "user", []any{
		map[string]any{"type": "text", "text": "what is in this screenshot"},
		map[string]any{"type": "image", "source": map[string]any{"data": strings.Repeat("A", headBytes+headBytes/2)}},
	})
	writeLine(f, "assistant", []any{map[string]any{"type": "text", "text": "a cat"}})
	filler := []any{map[string]any{"type": "text", "text": strings.Repeat("x", 4096)}}
	for written := 0; written < tailBytes+headBytes; written += 4096 {
		writeLine(f, "assistant", filler)
	}
	writeLine(f, "user", "a later question")
	if got := List()[0].Title; got != "what is in this screenshot" {
		t.Fatalf("the first prompt, past a huge first line: got %q", got)
	}
}

func TestRewrittenTranscriptIsReadAgain(t *testing.T) {
	dir := withTempSessions(t)
	path := filepath.Join(dir, "rewritten.jsonl")
	// real transcripts open with the same queue-operation line however the rest is rewritten, so the start can't
	// tell a rewrite from an append
	header := map[string]any{"type": "queue-operation", "sessionId": "rewritten", "content": "same opening line"}
	write := func(title string, padding int) {
		f, _ := os.Create(path)
		defer f.Close()
		writeRaw(f, header)
		writeLine(f, "user", "the first prompt")
		writeLine(f, "assistant", []any{map[string]any{"type": "text", "text": strings.Repeat("ok", padding)}})
		writeRaw(f, map[string]any{"type": "custom-title", "customTitle": title})
	}
	write("Old name", 1)
	if got := List()[0].Title; got != "Old name" {
		t.Fatalf("got %q", got)
	}
	write("New name", 40) // bigger, so it looks appended to
	if got := List()[0].Title; got != "New name" {
		t.Fatalf("a rewrite keeping the first line should be read again: got %q", got)
	}
	write("Shorter", 2)
	if got := List()[0].Title; got != "Shorter" {
		t.Fatalf("a rewrite to a smaller size should be read again: got %q", got)
	}
	f, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	writeRaw(f, map[string]any{"type": "custom-title", "customTitle": "Appended name"})
	f.Close()
	if got := List()[0].Title; got != "Appended name" {
		t.Fatalf("a real append is still read from where it stopped: got %q", got)
	}
}

// TestClipDocument verifies that Clip strips base64 data from document blocks while
// keeping title and media_type, leaving existing image URL blocks unchanged (#136).
func TestClipDocument(t *testing.T) {
	blocks := []any{
		map[string]any{
			"type": "document",
			"source": map[string]any{
				"type":       "base64",
				"media_type": "application/pdf",
				"data":       "JVBERi0xLjQKJcTl8uXr...",
			},
			"title": "spec.pdf",
		},
		map[string]any{
			"type": "image",
			"source": map[string]any{
				"type":       "url",
				"url":        "/api/images/existing.png",
				"media_type": "image/png",
			},
		},
		map[string]any{
			"type": "image",
			"source": map[string]any{
				"type":       "base64",
				"media_type": "image/png",
				"data":       "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
			},
		},
	}

	Clip(blocks)

	doc := blocks[0].(map[string]any)
	docSrc := doc["source"].(map[string]any)
	if _, hasData := docSrc["data"]; hasData {
		t.Fatal("document data was not stripped")
	}
	if docSrc["media_type"] != "application/pdf" {
		t.Errorf("document media_type = %v, want application/pdf", docSrc["media_type"])
	}
	if doc["title"] != "spec.pdf" {
		t.Errorf("document title = %v, want spec.pdf", doc["title"])
	}

	// Image URL blocks remain completely unchanged.
	imgURL := blocks[1].(map[string]any)
	imgURLSrc := imgURL["source"].(map[string]any)
	if imgURLSrc["type"] != "url" || imgURLSrc["url"] != "/api/images/existing.png" || imgURLSrc["media_type"] != "image/png" {
		t.Errorf("image URL block was altered: %v", imgURLSrc)
	}

	// Base64 image blocks convert to /api/images/ URLs without having data deleted like documents.
	imgB64 := blocks[2].(map[string]any)
	imgB64Src := imgB64["source"].(map[string]any)
	if imgB64Src["type"] != "url" || !strings.HasPrefix(imgB64Src["url"].(string), "/api/images/") {
		t.Errorf("base64 image was not converted to /api/images/ address: %v", imgB64Src)
	}
	if imgB64Src["media_type"] != "image/png" {
		t.Errorf("image media_type = %v, want image/png", imgB64Src["media_type"])
	}
}
