package codex

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"drawa/internal/config"
	"drawa/internal/sessions"
)

// history reads saved threads through app-server rather than Codex's rollout files: in code mode those record the
// scripts the model wrote, not the commands and edits they ran, while thread/read gives the same items a live
// card draws.
type history struct{}

var listCache struct {
	sync.Mutex
	at   time.Time
	list []sessions.Info
}

// List is this project's newest 50 threads (not sub-agents').
// ponytail: cached for 3s, since each call starts app-server and the page asks after every turn.
func (history) List() []sessions.Info {
	listCache.Lock()
	defer listCache.Unlock()
	if time.Since(listCache.at) < 3*time.Second {
		return listCache.list
	}
	var r struct {
		Data []struct {
			ID        string  `json:"id"`
			Name      string  `json:"name"`
			Preview   string  `json:"preview"`
			UpdatedAt float64 `json:"updatedAt"`
			Parent    string  `json:"parentThreadId"`
		} `json:"data"`
	}
	out := []sessions.Info{}
	if oneOff("thread/list", map[string]any{"cwd": config.Root, "limit": 50}, &r) == nil {
		for _, t := range r.Data {
			if t.Parent != "" || !config.UUIDRe.MatchString(t.ID) {
				continue
			}
			title := t.Name
			if title == "" {
				title = strings.TrimSpace(t.Preview)
			}
			out = append(out, sessions.Info{ID: t.ID, Title: title, Mtime: t.UpdatedAt})
		}
	}
	listCache.at, listCache.list = time.Now(), out
	return out
}

// Load is a saved thread in the page's history shape (sessions.Load's): user and assistant messages with Claude
// content blocks, tool results in the user message after the call. Sub-agents aren't loaded (agent).
func (history) Load(sid, agent string) ([]map[string]any, bool) {
	if agent != "" {
		return []map[string]any{}, true
	}
	var r struct {
		Thread struct {
			Cwd   string `json:"cwd"`
			Turns []struct {
				Items []threadItem `json:"items"`
			} `json:"turns"`
		} `json:"thread"`
	}
	if oneOff("thread/read", map[string]any{"threadId": sid, "includeTurns": true}, &r) != nil {
		return nil, false
	}
	// another project's thread (the page can name any id): shown empty. Not false, which the page takes for "not
	// written yet" and would wait on.
	if filepath.Clean(r.Thread.Cwd) != filepath.Clean(config.Root) {
		return []map[string]any{}, true
	}
	var msgs []map[string]any
	for _, t := range r.Thread.Turns {
		msgs = append(msgs, convert(t.Items)...)
	}
	return msgs, true
}

// convert is one turn's items as messages: an assistant message gathers blocks until a tool's results need a user
// message after it.
func convert(items []threadItem) []map[string]any {
	msgs := []map[string]any{}
	var content, results []any
	flush := func() {
		if len(content) > 0 {
			sessions.Clip(content)
			msgs = append(msgs, map[string]any{"role": "assistant", "content": content})
		}
		if len(results) > 0 {
			sessions.Clip(results)
			msgs = append(msgs, map[string]any{"role": "user", "content": results})
		}
		content, results = nil, nil
	}
	for _, it := range items {
		switch {
		case it.Type == "userMessage":
			flush()
			c := plain(it.userContent())
			sessions.Clip(c) // sent images become /api/images addresses
			msgs = append(msgs, map[string]any{"role": "user", "content": c})
		case it.Type == "agentMessage" || it.Type == "plan":
			if len(results) > 0 {
				flush()
			}
			if strings.TrimSpace(it.Text) != "" {
				content = append(content, map[string]any{"type": "text", "text": it.Text})
			}
		case it.Type == "reasoning":
			if len(results) > 0 {
				flush()
			}
			if s := strings.TrimSpace(strings.Join(it.Summary, "\n\n")); s != "" {
				content = append(content, map[string]any{"type": "thinking", "thinking": s})
			}
		case it.isTool():
			if len(results) > 0 {
				flush()
			}
			out, isErr := it.output()
			for n, c := range it.calls() {
				id := callID(it.ID, n)
				content = append(content, map[string]any{"type": "tool_use", "id": id, "name": c.Name, "input": c.Input})
				if it.Status != "inProgress" {
					results = append(results, map[string]any{"type": "tool_result", "tool_use_id": id, "content": out, "is_error": isErr})
				}
			}
		}
	}
	flush()
	return msgs
}

// plain turns the Obj blocks userContent builds into plain maps (what sessions.Clip and the page's history read).
func plain(c any) any {
	b, _ := json.Marshal(c)
	var v any
	json.Unmarshal(b, &v)
	return v
}
