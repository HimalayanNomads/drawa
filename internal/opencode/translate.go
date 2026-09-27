package opencode

import (
	"encoding/json"
	"strings"
)

// translator turns one card's OpenCode v1 events (GET /event frames) into wire lines (live/wire.go). OpenCode
// sends whole parts on every change plus text deltas; the page wants Claude's block-by-block stream, so it keeps
// what it has sent of each part. Everything is keyed to the card's session: other sessions in the same server are
// the card's sub-agents (task calls), which the page reads as whole assistant/user lines tagged with the call.
type translator struct {
	turn
	roles    map[string]string // message id -> user | assistant
	echoed   map[string]bool   // user messages already echoed
	children map[string]string // a sub-agent's session -> the task call that started it
	childTxt map[string]bool   // sub-agent text parts already sent
}

type span struct {
	Created   float64 `json:"created"`
	Completed float64 `json:"completed"`
	Start     float64 `json:"start"`
	End       float64 `json:"end"`
}

type part struct {
	ID        string  `json:"id"`
	SessionID string  `json:"sessionID"`
	MessageID string  `json:"messageID"`
	Type      string  `json:"type"`
	Text      string  `json:"text"`
	Synthetic bool    `json:"synthetic"`
	Time      *span   `json:"time"`
	CallID    string  `json:"callID"`
	Tool      string  `json:"tool"`
	Cost      float64 `json:"cost"`
	Tokens    *tokens `json:"tokens"`
	State     *struct {
		Status   string         `json:"status"`
		Input    map[string]any `json:"input"`
		Output   string         `json:"output"`
		Error    string         `json:"error"`
		Metadata map[string]any `json:"metadata"`
	} `json:"state"`
}

type message struct {
	ID         string `json:"id"`
	SessionID  string `json:"sessionID"`
	Role       string `json:"role"`
	ModelID    string `json:"modelID"`
	ProviderID string `json:"providerID"`
	Time       span   `json:"time"`
}

func newTranslator(sid, model string) *translator {
	return &translator{
		turn:  newTurn(sid, model),
		roles: map[string]string{}, echoed: map[string]bool{}, children: map[string]string{}, childTxt: map[string]bool{},
	}
}

// frame translates one event frame ({type, properties}) into zero or more wire lines.
func (t *translator) frame(raw []byte) []string {
	var f struct {
		Type       string          `json:"type"`
		Properties json.RawMessage `json:"properties"`
	}
	if json.Unmarshal(raw, &f) != nil {
		return nil
	}
	var out []string
	emit := func(s ...string) { out = append(out, s...) }
	switch f.Type {
	case "session.status":
		var p struct {
			SessionID string `json:"sessionID"`
			Status    struct {
				Type string `json:"type"`
			} `json:"status"`
		}
		if json.Unmarshal(f.Properties, &p) == nil && p.SessionID == t.sid && p.Status.Type == "busy" && !t.busy {
			t.begin()
			emit(line(obj{"type", "system", "subtype", "init", "session_id", t.sid, "model", t.model}))
		}
	case "message.updated":
		var p struct {
			Info message `json:"info"`
		}
		if json.Unmarshal(f.Properties, &p) == nil {
			emit(t.message(p.Info)...)
		}
	case "message.part.updated":
		var p struct {
			Part part `json:"part"`
		}
		if json.Unmarshal(f.Properties, &p) == nil {
			emit(t.part(p.Part)...)
		}
	case "message.part.delta":
		var p struct {
			SessionID string `json:"sessionID"`
			PartID    string `json:"partID"`
			Field     string `json:"field"`
			Delta     string `json:"delta"`
		}
		if json.Unmarshal(f.Properties, &p) == nil && p.SessionID == t.sid && p.Field == "text" {
			if b := t.blocks[p.PartID]; b != nil && b.msg == t.msg {
				b.sent += len(p.Delta)
				emit(t.delta(b, p.Delta))
			}
		}
	case "permission.asked":
		emit(t.permission(f.Properties)...)
	case "question.asked":
		emit(t.question(f.Properties)...)
	case "session.error":
		var p struct {
			SessionID string `json:"sessionID"`
			Error     struct {
				Name string `json:"name"`
				Data struct {
					Message string `json:"message"`
				} `json:"data"`
			} `json:"error"`
		}
		if json.Unmarshal(f.Properties, &p) == nil && (p.SessionID == t.sid || p.SessionID == "") {
			t.errName, t.errMessage = p.Error.Name, p.Error.Data.Message
		}
	case "session.idle":
		var p struct {
			SessionID string `json:"sessionID"`
		}
		if json.Unmarshal(f.Properties, &p) == nil && p.SessionID == t.sid && t.busy {
			emit(t.end(func(name string) bool { return name == "MessageAbortedError" })...)
		}
	}
	return out
}

func (t *translator) message(m message) []string {
	t.roles[m.ID] = m.Role
	if m.SessionID != t.sid || m.Role != "assistant" {
		return nil
	}
	if m.ProviderID != "" && m.ModelID != "" {
		t.model = m.ProviderID + "/" + m.ModelID
	}
	var out []string
	if t.msg != m.ID && m.Time.Completed == 0 {
		out = append(out, t.startMessage(m.ID)...)
		if t.started == 0 {
			t.started = m.Time.Created
		}
	}
	if m.Time.Completed != 0 && t.msg == m.ID {
		out = append(out, t.stopMessage()...)
		t.ended = m.Time.Completed
	}
	return out
}

func (t *translator) part(p part) []string {
	if p.SessionID != t.sid {
		if parent, ok := t.children[p.SessionID]; ok {
			return t.childPart(parent, p)
		}
		return nil
	}
	switch p.Type {
	case "text", "reasoning":
		if t.roles[p.MessageID] == "user" {
			if p.Synthetic || p.Text == "" || t.echoed[p.MessageID] {
				return nil
			}
			t.echoed[p.MessageID] = true
			return []string{line(obj{"type", "user", "message", obj{"role", "user", "content", p.Text}, "uuid", p.MessageID})}
		}
		return t.textPart(p)
	case "tool":
		return t.toolPart(p)
	case "step-finish":
		if p.Tokens != nil {
			t.usage = *p.Tokens
		}
		t.cost += p.Cost
	}
	return nil
}

func (t *translator) textPart(p part) []string {
	var out []string
	if t.msg != p.MessageID {
		out = append(out, t.startMessage(p.MessageID)...)
	}
	b := t.blocks[p.ID]
	if b == nil {
		kind := "text"
		if p.Type == "reasoning" {
			kind = "thinking"
		}
		b = &block{index: t.next, kind: kind, msg: t.msg}
		t.next++
		t.blocks[p.ID] = b
		t.open = append(t.open, b)
		out = append(out, streamEvent(obj{"type", "content_block_start", "index", b.index, "content_block", obj{"type", kind, kind, ""}}))
	}
	if !t.isOpen(b) {
		return out
	}
	if len(p.Text) > b.sent { // text that came whole rather than as deltas
		out = append(out, t.delta(b, p.Text[b.sent:]))
		b.sent = len(p.Text)
	}
	if p.Time != nil && p.Time.End != 0 {
		out = append(out, t.stop(b))
	}
	return out
}

func (t *translator) toolPart(p part) []string {
	if p.State == nil || p.CallID == "" || p.State.Status == "pending" {
		return nil
	}
	var out []string
	if _, seen := t.calls[p.CallID]; !seen {
		if t.msg != p.MessageID {
			out = append(out, t.startMessage(p.MessageID)...)
		}
		name, input := tool(p.Tool, p.State.Input)
		t.calls[p.CallID] = call{name, input}
		in, _ := json.Marshal(input)
		i := t.next
		t.next++
		out = append(out,
			streamEvent(obj{"type", "content_block_start", "index", i, "content_block", obj{"type", "tool_use", "id", p.CallID, "name", name, "input", obj{}}}),
			streamEvent(obj{"type", "content_block_delta", "index", i, "delta", obj{"type", "input_json_delta", "partial_json", string(in)}}),
			streamEvent(obj{"type", "content_block_stop", "index", i}))
	}
	if child, _ := p.State.Metadata["sessionId"].(string); child != "" && p.Tool == "task" {
		t.children[child] = p.CallID
	}
	return append(out, t.result(p, "")...)
}

// result is a finished tool call's tool_result line (parent: the sub-agent's task call, or "").
func (t *translator) result(p part, parent string) []string {
	st := p.State.Status
	if (st != "completed" && st != "error") || t.results[p.CallID] {
		return nil
	}
	t.results[p.CallID] = true
	content, isErr := p.State.Output, st == "error"
	if isErr {
		content = p.State.Error
	}
	o := obj{"type", "user"}
	if parent != "" {
		o = append(o, "parent_tool_use_id", parent)
	}
	o = append(o, "message", obj{"role", "user", "content", []obj{{"type", "tool_result", "tool_use_id", p.CallID, "content", content, "is_error", isErr}}})
	return []string{line(o)}
}

// childPart: a sub-agent's text and tool calls, whole, tagged with the task call that started it.
func (t *translator) childPart(parent string, p part) []string {
	switch p.Type {
	case "text":
		if t.roles[p.MessageID] == "user" || p.Time == nil || p.Time.End == 0 || t.childTxt[p.ID] || strings.TrimSpace(p.Text) == "" {
			return nil
		}
		t.childTxt[p.ID] = true
		return []string{line(obj{"type", "assistant", "parent_tool_use_id", parent,
			"message", obj{"role", "assistant", "content", []obj{{"type", "text", "text", p.Text}}}})}
	case "tool":
		if p.State == nil || p.CallID == "" || p.State.Status == "pending" {
			return nil
		}
		var out []string
		if _, seen := t.calls[p.CallID]; !seen {
			name, input := tool(p.Tool, p.State.Input)
			t.calls[p.CallID] = call{name, input}
			out = append(out, line(obj{"type", "assistant", "parent_tool_use_id", parent,
				"message", obj{"role", "assistant", "content", []obj{{"type", "tool_use", "id", p.CallID, "name", name, "input", input}}}}))
		}
		return append(out, t.result(p, parent)...)
	}
	return nil
}

// permission: OpenCode asks before a tool runs; the page shows it as Claude's can_use_tool ask about that call.
func (t *translator) permission(raw json.RawMessage) []string {
	var p struct {
		ID         string         `json:"id"`
		SessionID  string         `json:"sessionID"`
		Permission string         `json:"permission"`
		Patterns   []string       `json:"patterns"`
		Metadata   map[string]any `json:"metadata"`
		Always     []string       `json:"always"`
		Tool       struct {
			CallID string `json:"callID"`
		} `json:"tool"`
	}
	if json.Unmarshal(raw, &p) != nil || p.ID == "" || !t.mine(p.SessionID) {
		return nil
	}
	c, ok := t.calls[p.Tool.CallID]
	if !ok { // asked before its call reached us: describe it from what the ask carries
		c = call{p.Permission, map[string]any{}}
		if n, ok := toolNames[p.Permission]; ok {
			c.name = n
		}
		if f, _ := p.Metadata["filepath"].(string); f != "" {
			c.input["file_path"] = f
		}
		if cmd, _ := p.Metadata["command"].(string); cmd != "" {
			c.input["command"] = cmd
		}
		if len(c.input) == 0 && len(p.Patterns) > 0 {
			c.input["pattern"] = strings.Join(p.Patterns, " ")
		}
	}
	req := obj{"subtype", "can_use_tool", "tool_name", c.name, "input", c.input, "tool_use_id", p.Tool.CallID}
	if len(p.Always) > 0 {
		req = append(req, "permission_suggestions", []obj{{"type", "opencode", "always", p.Always}})
	}
	return []string{line(obj{"type", "control_request", "request_id", p.ID, "request", req})}
}

// question: OpenCode's question tool, shown as Claude's AskUserQuestion.
func (t *translator) question(raw json.RawMessage) []string {
	var p struct {
		ID        string           `json:"id"`
		SessionID string           `json:"sessionID"`
		Questions []map[string]any `json:"questions"`
		Tool      struct {
			CallID string `json:"callID"`
		} `json:"tool"`
	}
	if json.Unmarshal(raw, &p) != nil || p.ID == "" || !t.mine(p.SessionID) {
		return nil
	}
	qs := make([]obj, 0, len(p.Questions))
	for _, q := range p.Questions {
		multi, _ := q["multiple"].(bool)
		qs = append(qs, obj{"question", q["question"], "header", q["header"], "options", q["options"], "multiSelect", multi})
	}
	return []string{line(obj{"type", "control_request", "request_id", p.ID, "request", obj{"subtype", "can_use_tool",
		"tool_name", "AskUserQuestion", "input", obj{"questions", qs}, "tool_use_id", p.Tool.CallID}})}
}

func (t *translator) mine(sid string) bool {
	_, child := t.children[sid]
	return sid == t.sid || child
}
