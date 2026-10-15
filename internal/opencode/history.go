package opencode

import (
	"encoding/json"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"drawa/internal/config"
	"drawa/internal/sessions"
)

// history reads OpenCode's saved sessions through its CLI (they live in its SQLite database, and go.mod stays
// dependency-free, so no driver).
type history struct{}

// session is one entry of `opencode session list`.
type session struct {
	ID        string  `json:"id"`
	Title     string  `json:"title"` // OpenCode's own: its generated title, or the one you renamed it to
	Updated   float64 `json:"updated"`
	Directory string  `json:"directory"`
	ParentID  string  `json:"parentID"`
}

func (s session) info() sessions.Info {
	return sessions.Info{ID: s.ID, Title: s.Title, Mtime: s.Updated / 1000}
}

const (
	listCount   = 200       // the newest sessions of every folder, which the list keeps this project's 50 of
	searchCount = 1_000_000 // while searching: all of them (the CLI has no folder filter)
)

// projectSessions is this project's top-level sessions among the newest count of every folder, newest first.
func projectSessions(count int) []session {
	out := []session{}
	r, err := ocRun(30*time.Second, "", "session", "list", "--format", "json", "--max-count", strconv.Itoa(count))
	if err != nil || r.Code != 0 {
		return out
	}
	var all []session
	json.Unmarshal([]byte(r.Stdout), &all)
	for _, s := range all {
		if s.Directory == config.Root && s.ParentID == "" && sidRe.MatchString(s.ID) {
			out = append(out, s)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Updated > out[j].Updated })
	return out
}

// cachedSessions is a list kept for a few seconds, since each fetch starts the CLI (~1s) and the page asks again
// after every turn (the list) or every pause in typing (a search).
type cachedSessions struct {
	sync.Mutex
	at       time.Time
	sessions []session
}

var (
	listCache   cachedSessions
	searchCache cachedSessions
)

const (
	listFresh   = 3 * time.Second
	searchFresh = 15 * time.Second // one search's keystrokes reuse the full list
)

// get returns the cached sessions while they're fresh, else fetches them again.
func (c *cachedSessions) get(fresh time.Duration, count int) []session {
	c.Lock()
	defer c.Unlock()
	if time.Since(c.at) >= fresh {
		c.at, c.sessions = time.Now(), projectSessions(count)
	}
	return c.sessions
}

// List is this project's newest 50 top-level sessions.
func (history) List() []sessions.Info {
	out := []sessions.Info{}
	for _, s := range listCache.get(listFresh, listCount) {
		if len(out) == sessions.MaxListed {
			break
		}
		out = append(out, s.info())
	}
	return out
}

// Search is the newest of all this project's sessions whose title or id has every word of query.
func (history) Search(query string) []sessions.Info {
	out := []sessions.Info{}
	for _, s := range searchCache.get(searchFresh, searchCount) {
		if len(out) == sessions.MaxListed {
			break
		}
		if sessions.Matches(s.Title+"\n"+s.ID, query) {
			out = append(out, s.info())
		}
	}
	return out
}

type exported struct {
	Messages []struct {
		Info struct {
			Role string `json:"role"`
		} `json:"info"`
		Parts []part `json:"parts"`
	} `json:"messages"`
}

// Load turns an exported session into the page's history shape (sessions.Load's): user and assistant messages
// with Claude content blocks, tool results in the user message after the call. Sub-agents aren't loaded (agent).
func (history) Load(sid, agent string) ([]map[string]any, bool) {
	if agent != "" {
		return []map[string]any{}, true
	}
	r, err := ocRun(60*time.Second, "", "export", sid)
	if err != nil || r.Code != 0 {
		return nil, false
	}
	var ex exported
	if json.Unmarshal([]byte(r.Stdout[strings.Index(r.Stdout, "{"):]), &ex) != nil {
		return nil, false
	}
	return convert(ex), true
}

func convert(ex exported) []map[string]any {
	msgs := []map[string]any{}
	for _, m := range ex.Messages {
		if m.Info.Role == "user" {
			var text []string
			for _, p := range m.Parts {
				if p.Type == "text" && !p.Synthetic {
					text = append(text, p.Text)
				}
			}
			if len(text) > 0 {
				msgs = append(msgs, map[string]any{"role": "user", "content": strings.Join(text, "\n")})
			}
			continue
		}
		var content, results []any
		var usage map[string]any
		for _, p := range m.Parts {
			switch p.Type {
			case "text":
				if strings.TrimSpace(p.Text) != "" {
					content = append(content, map[string]any{"type": "text", "text": p.Text})
				}
			case "reasoning":
				if strings.TrimSpace(p.Text) != "" {
					content = append(content, map[string]any{"type": "thinking", "thinking": p.Text})
				}
			case "tool":
				if p.State == nil {
					continue
				}
				name, input := tool(p.Tool, p.State.Input)
				content = append(content, map[string]any{"type": "tool_use", "id": p.CallID, "name": name, "input": input})
				if p.State.Status == "completed" || p.State.Status == "error" {
					out, isErr := p.State.Output, p.State.Status == "error"
					if isErr {
						out = p.State.Error
					}
					results = append(results, map[string]any{"type": "tool_result", "tool_use_id": p.CallID, "content": out, "is_error": isErr})
				}
			case "step-finish":
				if p.Tokens != nil {
					usage = map[string]any{"input_tokens": p.Tokens.Input, "output_tokens": p.Tokens.Output,
						"cache_read_input_tokens": p.Tokens.Cache.Read, "cache_creation_input_tokens": p.Tokens.Cache.Write}
				}
			}
		}
		if len(content) > 0 {
			sessions.Clip(content)
			a := map[string]any{"role": "assistant", "content": content}
			if usage != nil {
				a["usage"] = usage
			}
			msgs = append(msgs, a)
		}
		if len(results) > 0 {
			sessions.Clip(results)
			msgs = append(msgs, map[string]any{"role": "user", "content": results})
		}
	}
	return msgs
}
