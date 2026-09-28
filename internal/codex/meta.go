package codex

import (
	"strings"
	"sync"
)

// models is Codex's model list. Codex has no slash commands the page could send, so commands is empty.
func models() map[string]any {
	var r struct {
		Data []struct {
			ID          string `json:"id"`
			DisplayName string `json:"displayName"`
			Description string `json:"description"`
			Hidden      bool   `json:"hidden"`
			IsDefault   bool   `json:"isDefault"`
		} `json:"data"`
	}
	if oneOff("model/list", map[string]any{}, &r) != nil {
		return nil
	}
	list := []any{}
	for _, m := range r.Data {
		if m.IsDefault {
			known.Lock()
			known.model = m.ID
			known.Unlock()
		}
		if m.Hidden {
			continue
		}
		name := m.DisplayName
		if name == "" {
			name = m.ID
		}
		if m.IsDefault {
			list = append([]any{map[string]any{"value": "", "displayName": "Default (" + name + ")", "description": "Codex's default"}}, list...)
		}
		list = append(list, map[string]any{"value": m.ID, "displayName": name, "description": strings.TrimSpace(m.Description)})
	}
	return map[string]any{"models": list, "commands": []any{}}
}

// known is Codex's default model, from the last model list that loaded.
var known struct {
	sync.Mutex
	model string
}

// defaultModel is the model Codex picks when none is named (for a card that started on another one). Asked for
// again after a failure (offline, signed out), not cached as "".
func defaultModel() string {
	known.Lock()
	m := known.model
	known.Unlock()
	if m == "" {
		models()
		known.Lock()
		m = known.model
		known.Unlock()
	}
	return m
}
