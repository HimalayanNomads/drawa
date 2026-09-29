// Package sessions loads a session's transcript for the page: sub-agent ids first, then the conversation, then
// what still-running agents did. It also trims what the page never shows (clip/Trimmed), shared by transcripts
// and big live lines.
package sessions

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"drawa/internal/config"
	"drawa/internal/images"
)

const ClipLen = 20_000 // the page shows at most this much of one tool output
const clipNote = "\n… (truncated)"

// truncate cuts s to n characters, adding note if it was cut.
func truncate(s string, n int, note string) string {
	i := 0 // byte offset of the n-th character: no []rune copy of every big output
	for ; n > 0 && i < len(s); n-- {
		_, size := utf8.DecodeRuneInString(s[i:])
		i += size
	}
	if i >= len(s) {
		return s
	}
	return s[:i] + note
}

// clipped cuts v to ClipLen characters if it's a longer string.
func clipped(v any) any {
	if s, ok := v.(string); ok {
		return truncate(s, ClipLen, clipNote)
	}
	return v
}

// clipText cuts a text block's text, the one part of it the page shows at length.
func clipText(b map[string]any, t string) {
	if txt, ok := b["text"]; ok && t == "text" {
		b["text"] = clipped(txt)
	}
}

// decode is json.Unmarshal keeping numbers as written, so ids above 2^53 in tool inputs aren't rounded.
func decode(b []byte, v any) error {
	d := json.NewDecoder(bytes.NewReader(b))
	d.UseNumber()
	return d.Decode(v)
}

// eachLine calls fn with every line of r until it returns false. Unlike bufio.Scanner it has no line length cap,
// so one huge tool output doesn't silently end the transcript there.
func eachLine(r io.Reader, fn func([]byte) bool) {
	br := bufio.NewReaderSize(r, 1<<20)
	for {
		b, err := br.ReadBytes('\n')
		if len(b) > 0 && !fn(b) || err != nil {
			return
		}
	}
}

// decodeAll decodes every line of a transcript, spread over the CPUs: decoding is most of a big transcript's load
// time. A line that doesn't parse (one still being written) comes back zero, so callers skip it as a non-message.
func decodeAll(r io.Reader) []line {
	var raw [][]byte
	eachLine(r, func(b []byte) bool { raw = append(raw, b); return true })
	out := make([]line, len(raw))
	n := runtime.GOMAXPROCS(0)
	var wg sync.WaitGroup
	for w := 0; w < n; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := w; i < len(raw); i += n { // interleaved, so a run of huge lines is shared out
				if decode(raw[i], &out[i]) != nil {
					out[i] = line{}
				}
			}
		}(w)
	}
	wg.Wait()
	return out
}

// line is what the page reads from a transcript line; the rest (toolUseResult, file snapshots) is skipped unbuilt.
type line struct {
	Type        string `json:"type"`
	IsSidechain bool   `json:"isSidechain"`
	IsMeta      bool   `json:"isMeta"`
	UUID        string `json:"uuid"`
	Message     struct {
		Content any `json:"content"`
		Usage   any `json:"usage"`
	} `json:"message"`
	Attachment struct {
		Type   string `json:"type"`
		Prompt string `json:"prompt"`
	} `json:"attachment"`
}

// Clip trims what the page never shows before sending a transcript or a live line: long tool outputs and tool
// inputs, images returned by tools (screenshots Claude looked at), and thinking signatures. Images you sent are
// kept, as an /api/images address instead of base64. Mutates content (a []any of block maps) in place.
func Clip(content any) {
	list, ok := content.([]any)
	if !ok {
		return
	}
	for _, item := range list {
		b, ok := item.(map[string]any)
		if !ok {
			continue
		}
		delete(b, "signature")
		t, _ := b["type"].(string)
		if t == "image" {
			if src, ok := b["source"].(map[string]any); ok {
				if st, _ := src["type"].(string); st == "base64" {
					if data, ok := src["data"].(string); ok {
						if raw, err := base64.StdEncoding.DecodeString(data); err == nil {
							if key, err := images.Store(raw); err == nil { // can't store: keep the base64, like Python on OSError
								mt, _ := src["media_type"].(string)
								b["source"] = map[string]any{"type": "url", "url": "/api/images/" + key, "media_type": mt}
							}
						}
					}
				}
			}
		} else if t == "tool_use" {
			if in, ok := b["input"].(map[string]any); ok {
				for k, v := range in {
					in[k] = clipped(v)
				}
			}
		}
		if t != "tool_result" {
			continue
		}
		switch c := b["content"].(type) {
		case string:
			b["content"] = truncate(c, ClipLen, clipNote)
		case []any:
			out := make([]any, 0, len(c))
			for _, p := range c {
				pm, ok := p.(map[string]any)
				if !ok {
					out = append(out, p)
					continue
				}
				pt, _ := pm["type"].(string)
				if pt == "image" {
					out = append(out, map[string]any{"type": "text", "text": "[image]"})
					continue
				}
				clipText(pm, pt)
				out = append(out, pm)
			}
			b["content"] = out
		}
	}
}

// Trimmed trims a big user/assistant line from the live stream, like a transcript (Clip), and drops the CLI's
// duplicate `tool_use_result` (the full tool output again, which the page doesn't read).
func Trimmed(line string) string {
	var d map[string]any
	if decode([]byte(line), &d) != nil {
		return line
	}
	t, _ := d["type"].(string)
	if t != "user" && t != "assistant" {
		return line
	}
	msg, ok := d["message"].(map[string]any)
	if !ok {
		return line
	}
	delete(d, "tool_use_result")
	Clip(msg["content"])
	b, err := json.Marshal(d)
	if err != nil {
		return line
	}
	return string(b)
}

func firstPrompt(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return "(no prompt)"
	}
	defer f.Close()
	prompt := "(no prompt)"
	eachLine(f, func(b []byte) bool {
		var d struct {
			Type    string `json:"type"`
			IsMeta  bool   `json:"isMeta"`
			Message struct {
				Content json.RawMessage `json:"content"`
			} `json:"message"`
		}
		if json.Unmarshal(b, &d) != nil || d.Type != "user" || d.IsMeta {
			return true
		}
		var c string
		if json.Unmarshal(d.Message.Content, &c) != nil || strings.HasPrefix(c, "<") {
			return true
		}
		prompt = truncate(c, 120, "")
		return false
	})
	return prompt
}

var promptCache = struct {
	sync.Mutex
	m map[string]string
}{m: map[string]string{}}

// firstPromptOf: a transcript's first prompt only changes with the file.
func firstPromptOf(path string, mtime int64) string {
	key := fmt.Sprintf("%s\x00%d", path, mtime)
	promptCache.Lock()
	if v, ok := promptCache.m[key]; ok {
		promptCache.Unlock()
		return v
	}
	promptCache.Unlock()
	v := firstPrompt(path)
	promptCache.Lock()
	if len(promptCache.m) > 1024 { // ponytail: a simple cap, not true LRU
		promptCache.m = map[string]string{}
	}
	promptCache.m[key] = v
	promptCache.Unlock()
	return v
}

type Info struct {
	ID      string  `json:"id"`
	Title   string  `json:"title"`
	Mtime   float64 `json:"mtime"`
	Backend string  `json:"backend,omitempty"` // which agent backend it belongs to (set by the server's merged list)
}

// List returns the newest 50 sessions. ponytail: newest 50, paginate if needed.
func List() []Info {
	entries, err := os.ReadDir(config.Sessions)
	out := []Info{}
	if err != nil {
		return out
	}
	type fm struct {
		path  string
		mtime time.Time
	}
	var all []fm
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".jsonl") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		all = append(all, fm{filepath.Join(config.Sessions, e.Name()), info.ModTime()})
	}
	sort.Slice(all, func(i, j int) bool { return all[i].mtime.After(all[j].mtime) })
	if len(all) > 50 {
		all = all[:50]
	}
	for _, f := range all {
		id := strings.TrimSuffix(filepath.Base(f.path), ".jsonl")
		out = append(out, Info{ID: id, Title: firstPromptOf(f.path, f.mtime.UnixNano()), Mtime: float64(f.mtime.UnixNano()) / 1e9})
	}
	return out
}

var taskDoneRe = regexp.MustCompile(`<task-notification>[\s\S]*?<tool-use-id>([^<]+)</tool-use-id>`)

// finishedAgents: Agent calls this message shows as finished — a result that isn't a background launch, or a
// background agent's <task-notification>.
func finishedAgents(content any) map[string]bool {
	out := map[string]bool{}
	var blocks []any
	switch c := content.(type) {
	case []any:
		blocks = c
	case string:
		blocks = []any{map[string]any{"type": "text", "text": c}}
	default:
		return out
	}
	for _, item := range blocks {
		b, ok := item.(map[string]any)
		if !ok {
			continue
		}
		t, _ := b["type"].(string)
		if t == "tool_result" {
			text := ""
			switch c := b["content"].(type) {
			case string:
				text = c
			case []any:
				var sb strings.Builder
				for _, p := range c {
					if pm, ok := p.(map[string]any); ok {
						if s, ok := pm["text"].(string); ok {
							sb.WriteString(s)
						}
					}
				}
				text = sb.String()
			}
			if !strings.HasPrefix(text, "Async agent launched") {
				if id, ok := b["tool_use_id"].(string); ok {
					out[id] = true
				}
			}
		} else if t == "text" {
			if txt, ok := b["text"].(string); ok {
				for _, m := range taskDoneRe.FindAllStringSubmatch(txt, -1) {
					out[m[1]] = true
				}
			}
		}
	}
	return out
}

// Subagents returns each sub-agent's own transcript, tagged with the Agent call that started it, so the page puts
// it in the agent's window. With only set: just that sub-agent. Agents in skip (finished) send only their id,
// marked lazy.
func Subagents(sid, only string, skip map[string]bool) []map[string]any {
	out := []map[string]any{}
	dir := filepath.Join(config.Sessions, sid, "subagents")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return out
	}
	var metas []string
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".meta.json") {
			metas = append(metas, e.Name())
		}
	}
	sort.Strings(metas)
	for _, name := range metas {
		raw, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			continue
		}
		var meta struct {
			ToolUseId string `json:"toolUseId"`
		}
		if json.Unmarshal(raw, &meta) != nil || meta.ToolUseId == "" {
			continue
		}
		parent := meta.ToolUseId
		base := strings.TrimSuffix(name, ".meta.json")
		jsonlPath := filepath.Join(dir, base+".jsonl")
		if _, err := os.Stat(jsonlPath); err != nil {
			continue
		}
		if only != "" && parent != only {
			continue
		}
		aid := strings.TrimPrefix(base, "agent-")
		entry := map[string]any{"role": "agent", "content": []any{}, "parent": parent, "aid": aid}
		if skip[parent] {
			entry["lazy"] = true
		}
		out = append(out, entry)
		if skip[parent] {
			continue
		}
		f, err := os.Open(jsonlPath)
		if err != nil {
			continue
		}
		for _, d := range decodeAll(f) {
			content, ok := d.Message.Content.([]any) // skips its prompt (a plain string)
			if (d.Type != "user" && d.Type != "assistant") || !ok {
				continue
			}
			Clip(content)
			for _, item := range content {
				if b, ok := item.(map[string]any); ok {
					bt, _ := b["type"].(string)
					clipText(b, bt)
				}
			}
			out = append(out, map[string]any{"role": d.Type, "content": content, "parent": parent})
		}
		f.Close()
	}
	return out
}

// typed: a message you sent (text, maybe with images), not a tool's result.
func typed(content any) bool {
	if _, ok := content.(string); ok {
		return true
	}
	list, _ := content.([]any)
	if len(list) == 0 {
		return false
	}
	b, _ := list[0].(map[string]any)
	return b["type"] == "text"
}

// Load returns a session's transcript for the page. With agent set (an Agent call id): only that sub-agent, which
// a finished agent's window fetches when it's first opened.
func Load(sid, agent string) []map[string]any {
	if agent != "" {
		return Subagents(sid, agent, nil)
	}
	msgs := []map[string]any{}
	done := map[string]bool{}
	f, err := os.Open(filepath.Join(config.Sessions, sid+".jsonl"))
	if err != nil {
		return msgs
	}
	defer f.Close()
	for _, d := range decodeAll(f) {
		t, content := d.Type, d.Message.Content
		// an agent's hand-back that arrived while Claude was busy is kept only as the queued command Claude read (typed
		// messages queued the same way also get a user line of their own): pass it on as the report it is
		if a := d.Attachment; t == "attachment" && a.Type == "queued_command" && strings.HasPrefix(a.Prompt, "<agent-message ") {
			t, content, d.IsMeta = "user", []any{map[string]any{"type": "text", "text": a.Prompt}}, true
		}
		if (t != "user" && t != "assistant") || d.IsSidechain {
			continue
		}
		for id := range finishedAgents(content) {
			done[id] = true
		}
		Clip(content)
		m := map[string]any{"role": t, "content": content}
		if t == "user" && !d.IsMeta && typed(content) {
			m["uuid"] = d.UUID // a message still queued is named by it when a page attaches (live.Snapshot)
		}
		if d.IsMeta {
			m["isMeta"] = true // text the CLI added (a skill's instructions, an agent's report): the page folds it, as it does live
		}
		if t == "assistant" && d.Message.Usage != nil {
			m["usage"] = d.Message.Usage // for the context meter
		}
		msgs = append(msgs, m)
	}
	sub := Subagents(sid, "", done)
	withAid, withoutAid := []map[string]any{}, []map[string]any{}
	for _, m := range sub {
		if _, ok := m["aid"]; ok {
			withAid = append(withAid, m)
		} else {
			withoutAid = append(withoutAid, m)
		}
	}
	result := make([]map[string]any, 0, len(withAid)+len(msgs)+len(withoutAid))
	result = append(result, withAid...)
	result = append(result, msgs...)
	result = append(result, withoutAid...)
	return result
}
