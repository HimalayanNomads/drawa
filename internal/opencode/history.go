package opencode

import (
	"encoding/json"
	"sort"
	"strings"
	"sync"
	"time"

	"drawa/internal/config"
	"drawa/internal/procx"
	"drawa/internal/sessions"
)

// history reads OpenCode's saved sessions through its CLI (they live in its SQLite database, and go.mod stays
// dependency-free, so no driver).
type history struct{}

var listCache struct {
	sync.Mutex
	at   time.Time
	list []sessions.Info
}

// List is this project's newest 50 top-level sessions.
// ponytail: cached for 3s, since each call starts the CLI (~1s) and the page asks after every turn.
func (history) List() []sessions.Info {
	listCache.Lock()
	defer listCache.Unlock()
	if time.Since(listCache.at) < 3*time.Second {
		return listCache.list
	}
	out := []sessions.Info{}
	r, err := procx.RunEnv(30*time.Second, "", nil, "opencode", "session", "list", "--format", "json", "--max-count", "200")
	if err == nil && r.Code == 0 {
		var all []struct {
			ID        string  `json:"id"`
			Title     string  `json:"title"`
			Updated   float64 `json:"updated"`
			Directory string  `json:"directory"`
			ParentID  string  `json:"parentID"`
		}
		json.Unmarshal([]byte(r.Stdout), &all)
		for _, s := range all {
			if s.Directory == config.Root && s.ParentID == "" && sidRe.MatchString(s.ID) {
				out = append(out, sessions.Info{ID: s.ID, Title: s.Title, Mtime: s.Updated / 1000})
			}
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Mtime > out[j].Mtime })
	out = out[:min(len(out), 50)]
	listCache.at, listCache.list = time.Now(), out
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
	r, err := procx.RunEnv(60*time.Second, "", nil, "opencode", "export", sid)
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
