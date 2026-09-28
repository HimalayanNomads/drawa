package opencode

import (
	"encoding/json"
	"fmt"

	"drawa/internal/live"
)

// translatorV2 turns one card's OpenCode v2 events (GET /api/event frames) into wire lines (live/wire.go). v2
// reports each block's whole lifecycle explicitly (started/delta/ended, one event per kind) instead of v1's
// evolving parts, so blocks are keyed by (kind, assistant message, ordinal) rather than a part id.
//
// ponytail: v2's "task" tool (a sub-agent call) hasn't been observed spawning a nested session in testing, so
// unlike translator (v1) this doesn't tag sub-agent output with parent_tool_use_id; if v2 does nest sessions for
// task calls, their events are simply dropped by the t.sid filters below (session.tool.* etc. name the session
// only in general terms, not scoped by an equivalent to v1's part.sessionID for a child).
type translatorV2 struct {
	live.Turn
	echoed  map[string]bool   // inbox ids already echoed as the user's message
	pending map[string]string // tool call id -> its name, from tool.input.started (tool.called doesn't repeat it)
}

func newTranslatorV2(sid, model string) *translatorV2 {
	return &translatorV2{Turn: live.NewTurn(sid, model), echoed: map[string]bool{}, pending: map[string]string{}}
}

// frame translates one event frame ({type, data}) into zero or more wire lines.
func (t *translatorV2) frame(raw []byte) []string {
	var f struct {
		Type    string          `json:"type"`
		Created float64         `json:"created"`
		Data    json.RawMessage `json:"data"`
	}
	if json.Unmarshal(raw, &f) != nil {
		return nil
	}
	var out []string
	emit := func(s ...string) { out = append(out, s...) }
	switch f.Type {
	case "session.execution.started":
		var p struct {
			SessionID string `json:"sessionID"`
		}
		if json.Unmarshal(f.Data, &p) == nil && p.SessionID == t.Sid && !t.Busy {
			t.Begin()
			emit(live.Line(live.Obj{"type", "system", "subtype", "init", "session_id", t.Sid, "model", t.Model}))
		}
	case "session.inbox.enqueued":
		emit(t.echo(f.Data)...)
	case "session.step.started":
		emit(t.stepStarted(f.Data)...)
	case "session.step.ended":
		var p struct {
			SessionID string `json:"sessionID"`
		}
		if json.Unmarshal(f.Data, &p) == nil && p.SessionID == t.Sid {
			emit(t.StopMessage()...)
		}
	case "session.text.started":
		emit(t.startPart(f.Data, "text")...)
	case "session.reasoning.started":
		emit(t.startPart(f.Data, "thinking")...)
	case "session.text.delta":
		emit(t.deltaPart(f.Data, "text")...)
	case "session.reasoning.delta":
		emit(t.deltaPart(f.Data, "thinking")...)
	case "session.text.ended":
		emit(t.endPart(f.Data, "text")...)
	case "session.reasoning.ended":
		emit(t.endPart(f.Data, "thinking")...)
	case "session.tool.input.started":
		var p struct {
			SessionID string `json:"sessionID"`
			ID        string `json:"id"`
			Name      string `json:"name"`
		}
		if json.Unmarshal(f.Data, &p) == nil && p.SessionID == t.Sid {
			t.pending[p.ID] = p.Name
		}
	case "session.tool.called":
		emit(t.toolCalled(f.Data)...)
	case "session.tool.success":
		emit(t.toolResult(f.Data, false)...)
	case "session.tool.failed":
		emit(t.toolResult(f.Data, true)...)
	case "permission.asked":
		emit(t.permission(f.Data)...)
	case "form.created":
		emit(t.form(f.Data)...)
	case "session.usage.updated":
		var p struct {
			SessionID string      `json:"sessionID"`
			Cost      float64     `json:"cost"`
			Tokens    live.Tokens `json:"tokens"`
		}
		if json.Unmarshal(f.Data, &p) == nil && p.SessionID == t.Sid {
			t.Cost, t.Usage = p.Cost, p.Tokens
		}
	case "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted":
		var p struct {
			SessionID string `json:"sessionID"`
			Error     struct {
				Type    string `json:"type"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal(f.Data, &p) == nil && p.SessionID == t.Sid && t.Busy {
			if f.Type != "session.execution.succeeded" {
				t.ErrName, t.ErrMessage = f.Type, p.Error.Message
				if t.ErrMessage == "" {
					t.ErrMessage = p.Error.Type
				}
			}
			t.Ended = f.Created
			emit(t.End(func(name string) bool { return name == "session.execution.interrupted" })...)
		}
	}
	return out
}

// echo emits the user's own message once, the way it types it: OpenCode v2 reports it via the inbox, not a part.
func (t *translatorV2) echo(raw json.RawMessage) []string {
	var p struct {
		SessionID string `json:"sessionID"`
		InboxID   string `json:"inboxID"`
		Item      struct {
			Type    string `json:"type"`
			Payload struct {
				Text string `json:"text"`
			} `json:"payload"`
		} `json:"item"`
	}
	if json.Unmarshal(raw, &p) != nil || p.SessionID != t.Sid || p.Item.Type != "user" || p.Item.Payload.Text == "" || t.echoed[p.InboxID] {
		return nil
	}
	t.echoed[p.InboxID] = true
	return []string{live.Line(live.Obj{"type", "user", "message", live.Obj{"role", "user", "content", p.Item.Payload.Text}, "uuid", p.InboxID})}
}

func (t *translatorV2) stepStarted(raw json.RawMessage) []string {
	var p struct {
		SessionID          string `json:"sessionID"`
		AssistantMessageID string `json:"assistantMessageID"`
		Model              struct {
			ID         string `json:"id"`
			ProviderID string `json:"providerID"`
		} `json:"model"`
		Started float64 `json:"started"`
	}
	if json.Unmarshal(raw, &p) != nil || p.SessionID != t.Sid {
		return nil
	}
	if p.Model.ID != "" && p.Model.ProviderID != "" {
		t.Model = p.Model.ProviderID + "/" + p.Model.ID
	}
	out := t.StartMessage(p.AssistantMessageID)
	if t.Started == 0 {
		t.Started = p.Started
	}
	return out
}

func blockKey(kind, msgID string, ordinal int) string {
	return fmt.Sprintf("%s:%s:%d", kind, msgID, ordinal)
}

func (t *translatorV2) startPart(raw json.RawMessage, kind string) []string {
	var p struct {
		SessionID          string `json:"sessionID"`
		AssistantMessageID string `json:"assistantMessageID"`
		Ordinal            int    `json:"ordinal"`
	}
	if json.Unmarshal(raw, &p) != nil || p.SessionID != t.Sid {
		return nil
	}
	key := blockKey(kind, p.AssistantMessageID, p.Ordinal)
	if t.Blocks[key] != nil {
		return nil
	}
	b := &live.Block{Index: t.Next, Kind: kind, Msg: t.Msg}
	t.Next++
	t.Blocks[key] = b
	t.Open = append(t.Open, b)
	return []string{live.StreamEvent(live.Obj{"type", "content_block_start", "index", b.Index, "content_block", live.Obj{"type", kind, kind, ""}})}
}

func (t *translatorV2) deltaPart(raw json.RawMessage, kind string) []string {
	var p struct {
		SessionID          string `json:"sessionID"`
		AssistantMessageID string `json:"assistantMessageID"`
		Ordinal            int    `json:"ordinal"`
		Delta              string `json:"delta"`
	}
	if json.Unmarshal(raw, &p) != nil || p.SessionID != t.Sid {
		return nil
	}
	b := t.Blocks[blockKey(kind, p.AssistantMessageID, p.Ordinal)]
	if b == nil || !t.IsOpen(b) {
		return nil
	}
	b.Sent += len(p.Delta)
	return []string{t.Delta(b, p.Delta)}
}

func (t *translatorV2) endPart(raw json.RawMessage, kind string) []string {
	var p struct {
		SessionID          string `json:"sessionID"`
		AssistantMessageID string `json:"assistantMessageID"`
		Ordinal            int    `json:"ordinal"`
		Text               string `json:"text"`
	}
	if json.Unmarshal(raw, &p) != nil || p.SessionID != t.Sid {
		return nil
	}
	b := t.Blocks[blockKey(kind, p.AssistantMessageID, p.Ordinal)]
	if b == nil || !t.IsOpen(b) {
		return nil
	}
	var out []string
	if b.Sent == 0 && p.Text != "" { // arrived whole, no deltas
		out = append(out, t.Delta(b, p.Text))
	}
	return append(out, t.Stop(b))
}

// toolCalled: v2 hands the whole call (id + parsed input) in one event, unlike v1's evolving part; its name came
// earlier, on tool.input.started.
func (t *translatorV2) toolCalled(raw json.RawMessage) []string {
	var p struct {
		SessionID string         `json:"sessionID"`
		ID        string         `json:"id"`
		Input     map[string]any `json:"input"`
	}
	if json.Unmarshal(raw, &p) != nil || p.SessionID != t.Sid || p.ID == "" {
		return nil
	}
	if _, seen := t.Calls[p.ID]; seen {
		return nil
	}
	rawName := t.pending[p.ID]
	delete(t.pending, p.ID)
	name, input := tool(rawName, p.Input)
	t.Calls[p.ID] = live.ToolCall{Name: name, Input: input}
	in, _ := json.Marshal(input)
	i := t.Next
	t.Next++
	return []string{
		live.StreamEvent(live.Obj{"type", "content_block_start", "index", i, "content_block", live.Obj{"type", "tool_use", "id", p.ID, "name", name, "input", live.Obj{}}}),
		live.StreamEvent(live.Obj{"type", "content_block_delta", "index", i, "delta", live.Obj{"type", "input_json_delta", "partial_json", string(in)}}),
		live.StreamEvent(live.Obj{"type", "content_block_stop", "index", i}),
	}
}

// toolResult is a finished tool call's tool_result line. v2's success content is already Claude-shaped content
// blocks ([{type:"text",text:…}, …]), so it's forwarded as-is.
func (t *translatorV2) toolResult(raw json.RawMessage, isErr bool) []string {
	var p struct {
		SessionID string          `json:"sessionID"`
		ID        string          `json:"id"`
		Content   json.RawMessage `json:"content"`
		Error     struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal(raw, &p) != nil || p.SessionID != t.Sid || p.ID == "" || t.Results[p.ID] {
		return nil
	}
	t.Results[p.ID] = true
	var content any = p.Error.Message
	if !isErr {
		json.Unmarshal(p.Content, &content)
	}
	return []string{live.Line(live.Obj{"type", "user", "message", live.Obj{"role", "user",
		"content", []live.Obj{{"type", "tool_result", "tool_use_id", p.ID, "content", content, "is_error", isErr}}}})}
}

// permission: OpenCode asks before a tool runs; the page shows it as Claude's can_use_tool ask about that call.
func (t *translatorV2) permission(raw json.RawMessage) []string {
	var p struct {
		ID        string         `json:"id"`
		SessionID string         `json:"sessionID"`
		Action    string         `json:"action"`
		Resources []string       `json:"resources"`
		Save      []string       `json:"save"`
		Metadata  map[string]any `json:"metadata"`
		Source    struct {
			ID string `json:"id"`
		} `json:"source"`
	}
	if json.Unmarshal(raw, &p) != nil || p.ID == "" || !t.mine(p.SessionID) {
		return nil
	}
	c, ok := t.Calls[p.Source.ID]
	if !ok { // asked before its call reached us: describe it from what the ask carries
		c = live.ToolCall{Name: p.Action, Input: map[string]any{}}
		if n, ok := toolNames[p.Action]; ok {
			c.Name = n
		}
		if f, _ := p.Metadata["filepath"].(string); f != "" {
			c.Input["file_path"] = f
		} else if len(p.Resources) > 0 {
			if p.Action == "shell" {
				c.Input["command"] = p.Resources[0]
			} else {
				c.Input["file_path"] = p.Resources[0]
			}
		}
	}
	req := live.Obj{"subtype", "can_use_tool", "tool_name", c.Name, "input", c.Input, "tool_use_id", p.Source.ID}
	if len(p.Save) > 0 {
		req = append(req, "permission_suggestions", []live.Obj{{"type", "opencode", "always", p.Save}})
	}
	return []string{live.Line(live.Obj{"type", "control_request", "request_id", p.ID, "request", req})}
}

// form: OpenCode v2's generic form, used by its question tool (metadata.kind == "question"); shown as Claude's
// AskUserQuestion, one field per question (key q0, q1, …, matched positionally when the answer comes back).
// Forms of any other kind (skills, plugins) aren't questions the page knows how to ask, so they're left alone.
func (t *translatorV2) form(raw json.RawMessage) []string {
	var p struct {
		Form struct {
			ID        string `json:"id"`
			SessionID string `json:"sessionID"`
			Metadata  struct {
				Kind string `json:"kind"`
				Tool struct {
					ID string `json:"id"`
				} `json:"tool"`
			} `json:"metadata"`
			Fields []struct {
				Title       string `json:"title"`
				Description string `json:"description"`
				Type        string `json:"type"`
				Options     []struct {
					Label       string `json:"label"`
					Description string `json:"description"`
				} `json:"options"`
			} `json:"fields"`
		} `json:"form"`
	}
	if json.Unmarshal(raw, &p) != nil || p.Form.ID == "" || p.Form.Metadata.Kind != "question" || !t.mine(p.Form.SessionID) {
		return nil
	}
	qs := make([]live.Obj, 0, len(p.Form.Fields))
	for _, f := range p.Form.Fields {
		opts := make([]live.Obj, 0, len(f.Options))
		for _, o := range f.Options {
			opts = append(opts, live.Obj{"label", o.Label, "description", o.Description})
		}
		qs = append(qs, live.Obj{"question", f.Description, "header", f.Title, "options", opts, "multiSelect", f.Type == "multiselect"})
	}
	return []string{live.Line(live.Obj{"type", "control_request", "request_id", p.Form.ID, "request", live.Obj{"subtype", "can_use_tool",
		"tool_name", "AskUserQuestion", "input", live.Obj{"questions", qs}, "tool_use_id", p.Form.Metadata.Tool.ID}})}
}

func (t *translatorV2) mine(sid string) bool { return sid == t.Sid }
