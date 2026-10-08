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
			Efforts     []struct {
				ReasoningEffort string `json:"reasoningEffort"`
			} `json:"supportedReasoningEfforts"`
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
		efforts := []string{}
		for _, e := range m.Efforts {
			efforts = append(efforts, e.ReasoningEffort)
		}
		if m.IsDefault {
			list = append([]any{map[string]any{"value": "", "displayName": "Default (" + name + ")", "description": "Codex's default", "efforts": efforts}}, list...)
		}
		list = append(list, map[string]any{"value": m.ID, "displayName": name, "description": strings.TrimSpace(m.Description), "efforts": efforts})
	}
	var u limits
	oneOff("account/rateLimits/read", nil, &u) // fails when signed in with an API key: no windows, no rings
	f, w := u.windows()
	return map[string]any{"models": list, "commands": []any{}, "usageUtil": f["utilization"], "usageResetAt": f["resetsAt"], "weeklyUtil": w["utilization"], "weeklyResetAt": w["resetsAt"]}
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

// limits is Codex's usage snapshot, from account/rateLimits/read and the account/rateLimits/updated it sends.
type limits struct {
	RateLimits struct{ Primary, Secondary *window }
}
type window struct{ UsedPercent, WindowDurationMins, ResetsAt float64 }

// windows sorts the two into the status line's rings, in rate_limit_event's shape: a day or longer is the weekly one.
func (l limits) windows() (five, week map[string]any) {
	for i, w := range []*window{l.RateLimits.Primary, l.RateLimits.Secondary} {
		if w == nil || w.ResetsAt == 0 {
			continue
		}
		p := &five
		if w.WindowDurationMins >= 1440 || w.WindowDurationMins == 0 && i == 1 {
			p = &week
		}
		*p = map[string]any{"utilization": w.UsedPercent / 100, "resetsAt": w.ResetsAt}
	}
	return
}
