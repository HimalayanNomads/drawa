package opencode

import (
	"sort"
	"time"

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
	if s.v2 {
		return metaV2(s)
	}
	return metaV1(s)
}

func metaV1(s *server) map[string]any {
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

type v2ModelList struct {
	Data []struct {
		ID         string `json:"id"`
		ProviderID string `json:"providerID"`
		Name       string `json:"name"`
		Cost       []struct {
			Input  float64 `json:"input"`
			Output float64 `json:"output"`
		} `json:"cost"`
	} `json:"data"`
}

// metaV2 reads OpenCode v2's flat model list (GET /api/model, unlike v1's providers-with-nested-models) and joins
// in provider display names (GET /api/provider) for grouping, since v2's model entries only carry a providerID.
func metaV2(s *server) map[string]any {
	var providers struct {
		Data []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"data"`
	}
	s.call("GET", "/api/provider", nil, &providers)
	providerName := map[string]string{}
	for _, p := range providers.Data {
		providerName[p.ID] = p.Name
	}
	// v2 fetches its model catalog after the server starts listening (a fresh process, spun up fresh for every
	// meta() call, answers empty for about a second); poll briefly rather than caching that empty answer forever
	// (live.Meta caches any non-nil result it gets).
	var list v2ModelList
	deadline := time.Now().Add(5 * time.Second)
	for {
		list = v2ModelList{}
		if s.call("GET", "/api/model", nil, &list) != nil {
			return nil
		}
		if len(list.Data) > 0 || time.Now().After(deadline) {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	if len(list.Data) == 0 {
		return nil // still nothing after warm-up: a real failure, so live.Meta retries in a minute
	}
	var def struct {
		Data struct {
			ID         string `json:"id"`
			ProviderID string `json:"providerID"`
		} `json:"data"`
	}
	s.call("GET", "/api/model/default", nil, &def)
	models := []any{}
	if def.Data.ID != "" {
		name := providerName[def.Data.ProviderID]
		if name == "" {
			name = def.Data.ProviderID
		}
		models = append(models, map[string]any{"value": "", "displayName": "Default (" + def.Data.ID + ")", "description": name + " · OpenCode's default"})
	}
	sort.Slice(list.Data, func(i, j int) bool {
		if list.Data[i].ProviderID != list.Data[j].ProviderID {
			return list.Data[i].ProviderID < list.Data[j].ProviderID
		}
		return list.Data[i].ID < list.Data[j].ID
	})
	for _, m := range list.Data {
		name := m.Name
		if name == "" {
			name = m.ID
		}
		group := providerName[m.ProviderID]
		if group == "" {
			group = m.ProviderID
		}
		desc := group
		if len(m.Cost) > 0 && m.Cost[0].Input == 0 && m.Cost[0].Output == 0 {
			desc += " · free"
		}
		models = append(models, map[string]any{"value": m.ProviderID + "/" + m.ID, "displayName": name, "description": desc, "group": group})
	}
	var cmds struct {
		Data []struct {
			Name        string `json:"name"`
			Description string `json:"description"`
		} `json:"data"`
	}
	s.call("GET", "/api/command", nil, &cmds)
	commands := []any{}
	for _, c := range cmds.Data {
		commands = append(commands, map[string]any{"name": c.Name, "description": c.Description})
	}
	return map[string]any{"models": models, "commands": commands}
}
