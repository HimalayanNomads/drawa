package codex

import (
	"cmp"
	"encoding/json"
	"path/filepath"
	"slices"
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

// thread is one entry of app-server's thread/list.
type thread struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"` // set when it's renamed
	Preview   string  `json:"preview"`
	UpdatedAt float64 `json:"updatedAt"`
	Parent    string  `json:"parentThreadId"`
}

// info is how the history list shows a thread: by its name, else its first message.
func (t thread) info() sessions.Info {
	title := t.Name
	if title == "" {
		title = strings.TrimSpace(t.Preview)
	}
	return sessions.Info{ID: t.ID, Title: title, Mtime: t.UpdatedAt}
}

const (
	searchPageSize = 1000 // threads per thread/list call while searching: each call starts app-server
	maxSearchPages = 10
)

// threads is this project's threads (not sub-agents'), newest first: one page of limit, or with every set, page
// after page (up to maxSearchPages).
func threads(limit int, every bool) []thread {
	out := []thread{}
	cursor := ""
	for range maxSearchPages {
		params := map[string]any{"cwd": config.Root, "limit": limit}
		if cursor != "" {
			params["cursor"] = cursor
		}
		var r struct {
			Data       []thread `json:"data"`
			NextCursor string   `json:"nextCursor"`
		}
		if oneOff("thread/list", params, &r) != nil {
			break
		}
		for _, t := range r.Data {
			if t.Parent == "" && config.UUIDRe.MatchString(t.ID) {
				out = append(out, t)
			}
		}
		if !every || r.NextCursor == "" {
			break
		}
		cursor = r.NextCursor
	}
	return out
}

// cachedThreads is a list kept for a few seconds, since each fetch starts app-server and the page asks again after
// every turn (the list) or every pause in typing (a search).
type cachedThreads struct {
	sync.Mutex
	at      time.Time
	threads []thread
}

var (
	listCache   cachedThreads
	searchCache cachedThreads
)

const (
	listFresh   = 3 * time.Second
	searchFresh = 15 * time.Second // one search's keystrokes reuse the full list
)

// get returns the cached threads while they're fresh, else fetches them again.
func (c *cachedThreads) get(fresh time.Duration, fetch func() []thread) []thread {
	c.Lock()
	defer c.Unlock()
	if time.Since(c.at) >= fresh {
		c.at, c.threads = time.Now(), fetch()
	}
	return c.threads
}

// List is this project's newest 50 threads (not sub-agents').
func (history) List() []sessions.Info {
	out := []sessions.Info{}
	for _, t := range listCache.get(listFresh, func() []thread { return threads(sessions.MaxListed, false) }) {
		out = append(out, t.info())
	}
	return out
}

// Search is the newest of all this project's threads whose name, first message or id has every word of query.
func (history) Search(query string) []sessions.Info {
	all := slices.Clone(searchCache.get(searchFresh, func() []thread { return threads(searchPageSize, true) }))
	slices.SortStableFunc(all, func(a, b thread) int { return cmp.Compare(b.UpdatedAt, a.UpdatedAt) }) // newest first, as the list shows them
	out := []sessions.Info{}
	for _, t := range all {
		if len(out) == sessions.MaxListed {
			break
		}
		if sessions.Matches(strings.Join([]string{t.Name, t.Preview, t.ID}, "\n"), query) {
			out = append(out, t.info())
		}
	}
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
