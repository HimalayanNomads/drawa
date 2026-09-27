package opencode

import (
	"sort"

	"drawa/internal/live"
)

// meta asks a private OpenCode server for its models (grouped by provider, free ones marked) and its commands.
func meta() map[string]any {
	l, err := live.New("", "opencode", "", "", "", "")
	if err != nil {
		return nil
	}
	defer live.TrackMeta(l)()
	s := l.Backend().(*server)
	var providers struct {
		Providers []struct {
			ID     string `json:"id"`
			Name   string `json:"name"`
			Models map[string]struct {
				Name string `json:"name"`
				Cost *struct {
					Input  float64 `json:"input"`
					Output float64 `json:"output"`
				} `json:"cost"`
			} `json:"models"`
		} `json:"providers"`
		Default map[string]string `json:"default"`
	}
	if s.call("GET", "/config/providers", nil, &providers) != nil {
		return nil
	}
	models := []any{}
	for provider, model := range providers.Default {
		models = append(models, map[string]any{"value": "", "displayName": "Default (" + model + ")", "description": provider + " · OpenCode's default"})
		break
	}
	for _, p := range providers.Providers {
		ids := make([]string, 0, len(p.Models))
		for id := range p.Models {
			ids = append(ids, id)
		}
		sort.Strings(ids)
		for _, id := range ids {
			m := p.Models[id]
			desc := p.Name
			if m.Cost != nil && m.Cost.Input == 0 && m.Cost.Output == 0 {
				desc += " · free"
			}
			name := m.Name
			if name == "" {
				name = id
			}
			models = append(models, map[string]any{"value": p.ID + "/" + id, "displayName": name, "description": desc, "group": p.Name})
		}
	}
	var cmds []struct {
		Name        string `json:"name"`
		Description string `json:"description"`
	}
	s.call("GET", "/command", nil, &cmds)
	commands := []any{}
	for _, c := range cmds {
		commands = append(commands, map[string]any{"name": c.Name, "description": c.Description})
	}
	return map[string]any{"models": models, "commands": commands}
}
