package opencode

import (
	"encoding/json"
	"strings"

	"drawa/internal/live"
)

// translator turns one card's OpenCode v1 events (GET /event frames) into wire lines (live/wire.go). OpenCode
// sends whole parts on every change plus text deltas; the page wants Claude's block-by-block stream, so it keeps
// what it has sent of each part. Everything is keyed to the card's session: other sessions in the same server are
// the card's sub-agents (task calls), which the page reads as whole assistant/user lines tagged with the call.
type translator struct {
	live.Turn
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
	ID        string       `json:"id"`
	SessionID string       `json:"sessionID"`
	MessageID string       `json:"messageID"`
	Type      string       `json:"type"`
	Text      string       `json:"text"`
	Synthetic bool         `json:"synthetic"`
	Time      *span        `json:"time"`
	CallID    string       `json:"callID"`
	Tool      string       `json:"tool"`
	Cost      float64      `json:"cost"`
	Tokens    *live.Tokens `json:"tokens"`
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
		Turn:  live.NewTurn(sid, model),
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
		if json.Unmarshal(f.Properties, &p) == nil && p.SessionID == t.Sid && p.Status.Type == "busy" && !t.Busy {
			t.Begin()
			emit(live.Line(live.Obj{"type", "system", "subtype", "init", "session_id", t.Sid, "model", t.Model}))
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
		if json.Unmarshal(f.Properties, &p) == nil && p.SessionID == t.Sid && p.Field == "text" {
			if b := t.Blocks[p.PartID]; b != nil && b.Msg == t.Msg {
				b.Sent += len(p.Delta)
				emit(t.Delta(b, p.Delta))
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
		if json.Unmarshal(f.Properties, &p) == nil && (p.SessionID == t.Sid || p.SessionID == "") {
			t.ErrName, t.ErrMessage = p.Error.Name, p.Error.Data.Message
		}
	case "session.idle":
		var p struct {
			SessionID string `json:"sessionID"`
		}
		if json.Unmarshal(f.Properties, &p) == nil && p.SessionID == t.Sid && t.Busy {
			emit(t.End(func(name string) bool { return name == "MessageAbortedError" })...)
		}
	}
	return out
}

func (t *translator) message(m message) []string {
	t.roles[m.ID] = m.Role
	if m.SessionID != t.Sid || m.Role != "assistant" {
		return nil
	}
	if m.ProviderID != "" && m.ModelID != "" {
		t.Model = m.ProviderID + "/" + m.ModelID
	}
	var out []string
	if t.Msg != m.ID && m.Time.Completed == 0 {
		out = append(out, t.StartMessage(m.ID)...)
		if t.Started == 0 {
			t.Started = m.Time.Created
		}
	}
	if m.Time.Completed != 0 && t.Msg == m.ID {
		out = append(out, t.StopMessage()...)
		t.Ended = m.Time.Completed
	}
	return out
}

func (t *translator) part(p part) []string {
	if p.SessionID != t.Sid {
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
			return []string{live.Line(live.Obj{"type", "user", "message", live.Obj{"role", "user", "content", p.Text}, "uuid", p.MessageID})}
		}
		return t.textPart(p)
	case "tool":
		return t.toolPart(p)
	case "step-finish":
		if p.Tokens != nil {
			t.Usage = *p.Tokens
		}
		t.Cost += p.Cost
	}
	return nil
}

func (t *translator) textPart(p part) []string {
	var out []string
	if t.Msg != p.MessageID {
		out = append(out, t.StartMessage(p.MessageID)...)
	}
	b := t.Blocks[p.ID]
	if b == nil {
		kind := "text"
		if p.Type == "reasoning" {
			kind = "thinking"
		}
		b = &live.Block{Index: t.Next, Kind: kind, Msg: t.Msg}
		t.Next++
		t.Blocks[p.ID] = b
		t.Open = append(t.Open, b)
		out = append(out, live.StreamEvent(live.Obj{"type", "content_block_start", "index", b.Index, "content_block", live.Obj{"type", kind, kind, ""}}))
	}
	if !t.IsOpen(b) {
		return out
	}
	if len(p.Text) > b.Sent { // text that came whole rather than as deltas
		out = append(out, t.Delta(b, p.Text[b.Sent:]))
		b.Sent = len(p.Text)
	}
	if p.Time != nil && p.Time.End != 0 {
		out = append(out, t.Stop(b))
	}
	return out
}

func (t *translator) toolPart(p part) []string {
	if p.State == nil || p.CallID == "" || p.State.Status == "pending" {
		return nil
	}
	var out []string
	if _, seen := t.Calls[p.CallID]; !seen {
		if t.Msg != p.MessageID {
			out = append(out, t.StartMessage(p.MessageID)...)
		}
		name, input := tool(p.Tool, p.State.Input)
		t.Calls[p.CallID] = live.ToolCall{Name: name, Input: input}
		in, _ := json.Marshal(input)
		i := t.Next
		t.Next++
		out = append(out,
			live.StreamEvent(live.Obj{"type", "content_block_start", "index", i, "content_block", live.Obj{"type", "tool_use", "id", p.CallID, "name", name, "input", live.Obj{}}}),
			live.StreamEvent(live.Obj{"type", "content_block_delta", "index", i, "delta", live.Obj{"type", "input_json_delta", "partial_json", string(in)}}),
			live.StreamEvent(live.Obj{"type", "content_block_stop", "index", i}))
	}
	if child, _ := p.State.Metadata["sessionId"].(string); child != "" && p.Tool == "task" {
		t.children[child] = p.CallID
	}
	return append(out, t.result(p, "")...)
}

// result is a finished tool call's tool_result line (parent: the sub-agent's task call, or "").
func (t *translator) result(p part, parent string) []string {
	st := p.State.Status
	if (st != "completed" && st != "error") || t.Results[p.CallID] {
		return nil
	}
	t.Results[p.CallID] = true
	content, isErr := p.State.Output, st == "error"
	if isErr {
		content = p.State.Error
	}
	o := live.Obj{"type", "user"}
	if parent != "" {
		o = append(o, "parent_tool_use_id", parent)
	}
	o = append(o, "message", live.Obj{"role", "user", "content", []live.Obj{{"type", "tool_result", "tool_use_id", p.CallID, "content", content, "is_error", isErr}}})
	return []string{live.Line(o)}
}

// childPart: a sub-agent's text and tool calls, whole, tagged with the task call that started it.
func (t *translator) childPart(parent string, p part) []string {
	switch p.Type {
	case "text":
		if t.roles[p.MessageID] == "user" || p.Time == nil || p.Time.End == 0 || t.childTxt[p.ID] || strings.TrimSpace(p.Text) == "" {
			return nil
		}
		t.childTxt[p.ID] = true
		return []string{live.Line(live.Obj{"type", "assistant", "parent_tool_use_id", parent,
			"message", live.Obj{"role", "assistant", "content", []live.Obj{{"type", "text", "text", p.Text}}}})}
	case "tool":
		if p.State == nil || p.CallID == "" || p.State.Status == "pending" {
			return nil
		}
		var out []string
		if _, seen := t.Calls[p.CallID]; !seen {
			name, input := tool(p.Tool, p.State.Input)
			t.Calls[p.CallID] = live.ToolCall{Name: name, Input: input}
			out = append(out, live.Line(live.Obj{"type", "assistant", "parent_tool_use_id", parent,
				"message", live.Obj{"role", "assistant", "content", []live.Obj{{"type", "tool_use", "id", p.CallID, "name", name, "input", input}}}}))
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
	c, ok := t.Calls[p.Tool.CallID]
	if !ok { // asked before its call reached us: describe it from what the ask carries
		c = live.ToolCall{Name: p.Permission, Input: map[string]any{}}
		if n, ok := toolNames[p.Permission]; ok {
			c.Name = n
		}
		if f, _ := p.Metadata["filepath"].(string); f != "" {
			c.Input["file_path"] = f
		}
		if cmd, _ := p.Metadata["command"].(string); cmd != "" {
			c.Input["command"] = cmd
		}
		if len(c.Input) == 0 && len(p.Patterns) > 0 {
			c.Input["pattern"] = strings.Join(p.Patterns, " ")
		}
	}
	req := live.Obj{"subtype", "can_use_tool", "tool_name", c.Name, "input", c.Input, "tool_use_id", p.Tool.CallID}
	if len(p.Always) > 0 {
		req = append(req, "permission_suggestions", []live.Obj{{"type", "opencode", "always", p.Always}})
	}
	return []string{live.Line(live.Obj{"type", "control_request", "request_id", p.ID, "request", req})}
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
	qs := make([]live.Obj, 0, len(p.Questions))
	for _, q := range p.Questions {
		multi, _ := q["multiple"].(bool)
		qs = append(qs, live.Obj{"question", q["question"], "header", q["header"], "options", q["options"], "multiSelect", multi})
	}
	return []string{live.Line(live.Obj{"type", "control_request", "request_id", p.ID, "request", live.Obj{"subtype", "can_use_tool",
		"tool_name", "AskUserQuestion", "input", live.Obj{"questions", qs}, "tool_use_id", p.Tool.CallID}})}
}

func (t *translator) mine(sid string) bool {
	_, child := t.children[sid]
	return sid == t.Sid || child
}
