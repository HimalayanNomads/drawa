// Package sessions loads a session's transcript for the page: sub-agent ids first, then the conversation, then
// what still-running agents did. It also trims what the page never shows (clip/Trimmed), shared by transcripts
// and big live lines.
package sessions

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"claude-ui/internal/config"
	"claude-ui/internal/images"
)

const ClipLen = 20_000 // the page shows at most this much of one tool output

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "\n… (truncated)"
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
							mt, _ := src["media_type"].(string)
							b["source"] = map[string]any{"type": "url", "url": "/api/images/" + images.Store(raw), "media_type": mt}
						}
					}
				}
			}
		} else if t == "tool_use" {
			if in, ok := b["input"].(map[string]any); ok {
				for k, v := range in {
					if s, ok := v.(string); ok && len([]rune(s)) > ClipLen {
						in[k] = truncate(s, ClipLen)
					}
				}
			}
		}
		if t != "tool_result" {
			continue
		}
		switch c := b["content"].(type) {
		case string:
			if len([]rune(c)) > ClipLen {
				b["content"] = truncate(c, ClipLen)
			}
		case []any:
			out := make([]any, 0, len(c))
			for _, p := range c {
				pm, ok := p.(map[string]any)
				if !ok {
					out = append(out, p)
					continue
				}
				if pt, _ := pm["type"].(string); pt == "image" {
					out = append(out, map[string]any{"type": "text", "text": "[image]"})
					continue
				}
				if pt, _ := pm["type"].(string); pt == "text" {
					if txt, ok := pm["text"].(string); ok && len([]rune(txt)) > ClipLen {
						pm["text"] = truncate(txt, ClipLen)
					}
				}
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
	if json.Unmarshal([]byte(line), &d) != nil {
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
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 64*1024), 16*1024*1024)
	for scanner.Scan() {
		var d struct {
			Type    string `json:"type"`
			IsMeta  bool   `json:"isMeta"`
			Message struct {
				Content json.RawMessage `json:"content"`
			} `json:"message"`
		}
		if json.Unmarshal(scanner.Bytes(), &d) != nil {
			continue
		}
		if d.Type != "user" || d.IsMeta {
			continue
		}
		var c string
		if json.Unmarshal(d.Message.Content, &c) != nil || strings.HasPrefix(c, "<") {
			continue
		}
		return truncatePlain(c, 120)
	}
	return "(no prompt)"
}

func truncatePlain(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
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
	ID    string  `json:"id"`
	Title string  `json:"title"`
	Mtime float64 `json:"mtime"`
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
		scanner := bufio.NewScanner(f)
		scanner.Buffer(make([]byte, 64*1024), 64*1024*1024)
		for scanner.Scan() {
			var d map[string]any
			if json.Unmarshal(scanner.Bytes(), &d) != nil { // the agent is still writing it
				continue
			}
			t, _ := d["type"].(string)
			msg, _ := d["message"].(map[string]any)
			if (t != "user" && t != "assistant") || msg == nil {
				continue
			}
			content, ok := msg["content"].([]any) // skips its prompt (a plain string)
			if !ok {
				continue
			}
			Clip(content)
			for _, item := range content {
				if b, ok := item.(map[string]any); ok {
					if bt, _ := b["type"].(string); bt == "text" {
						if txt, ok := b["text"].(string); ok && len([]rune(txt)) > ClipLen {
							b["text"] = truncate(txt, ClipLen)
						}
					}
				}
			}
			out = append(out, map[string]any{"role": t, "content": content, "parent": parent})
		}
		f.Close()
	}
	return out
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
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 64*1024), 64*1024*1024)
	for scanner.Scan() {
		var d map[string]any
		if json.Unmarshal(scanner.Bytes(), &d) != nil { // a line still being written
			continue
		}
		t, _ := d["type"].(string)
		isSidechain, _ := d["isSidechain"].(bool)
		isMeta, _ := d["isMeta"].(bool)
		if (t != "user" && t != "assistant") || isSidechain || isMeta {
			continue
		}
		msg, _ := d["message"].(map[string]any)
		if msg == nil {
			msg = map[string]any{}
		}
		for id := range finishedAgents(msg["content"]) {
			done[id] = true
		}
		content := msg["content"]
		Clip(content)
		m := map[string]any{"role": t, "content": content}
		if t == "assistant" {
			if usage, ok := msg["usage"]; ok && usage != nil {
				m["usage"] = usage // for the context meter
			}
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
