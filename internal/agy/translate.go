package agy

import (
	"encoding/json"
	"fmt"
	"strings"

	"drawa/internal/live"
	"drawa/internal/sessions"
)

// event is one line of `agy --output-format stream-json`: init, a step_update (the user's message, an agent
// response streaming text, or a tool call), and a result ending each turn.
type event struct {
	Event          string `json:"event"`
	ConversationID string `json:"conversation_id"`
	Init           struct {
		Model string `json:"model"`
	} `json:"init"`
	Step struct {
		ConversationID string  `json:"conversation_id"`
		Index          int     `json:"step_index"`
		State          string  `json:"state"` // ACTIVE | DONE | ERROR
		Type           string  `json:"step_type"`
		TextDelta      string  `json:"text_delta"`
		ThinkingDelta  string  `json:"thinking_delta"`
		Usage          *usage  `json:"usage"`
		Duration       float64 `json:"duration_seconds"`
		Tool           struct {
			Name   string         `json:"name"`
			Params map[string]any `json:"parameters"`
			Output any            `json:"output"`
			Error  *struct {
				Message string `json:"message"`
			} `json:"error"`
		} `json:"tool_info"`
	} `json:"step_update"`
	Result struct {
		ConversationID string  `json:"conversation_id"`
		Status         string  `json:"status"` // SUCCESS | ERROR | CANCELLED
		Error          string  `json:"error"`
		Duration       float64 `json:"duration_seconds"`
		Denied         []struct {
			Action string `json:"action"`
			Name   string `json:"display_name"`
		} `json:"denied_actions"`
	} `json:"result"`
}

type usage struct {
	Input     float64 `json:"input_tokens"`
	Output    float64 `json:"output_tokens"`
	CacheRead float64 `json:"cache_read_tokens"`
}

// sent is a message written to agy that it hasn't started on yet: it runs one turn per message, in order.
type sent struct{ id, text string }

type translator struct {
	t      live.Turn
	mode   string // the Drawa mode its process runs in, told to the page with the first turn
	told   bool
	queue  []sent
	text   map[int]*live.Block // an agent_response step -> its text block
	think  map[int]*live.Block
	output float64          // this turn's output tokens (agy's result counts every turn of the process)
	ms     float64          // and its time
	rec    []map[string]any // this turn's messages in the history shape, for the record (history.go)
	reply  []any            // the assistant message being recorded
}

func newTranslator(sid, model string) *translator {
	return &translator{t: live.NewTurn(sid, model), text: map[int]*live.Block{}, think: map[int]*live.Block{}}
}

// queued: a message was written; its echo comes when agy starts on it (user_input).
func (x *translator) queued(id, text string) { x.queue = append(x.queue, sent{id, text}) }

func (x *translator) frame(raw []byte) []string {
	var e event
	if json.Unmarshal(raw, &e) != nil {
		return nil
	}
	switch e.Event {
	case "init":
		if e.ConversationID != "" {
			x.t.SetSid(e.ConversationID)
		}
		if e.Init.Model != "" {
			x.t.SetModel(e.Init.Model)
		}
	case "step_update":
		if e.Step.ConversationID != "" {
			x.t.SetSid(e.Step.ConversationID)
		}
		return x.step(e)
	case "result":
		if e.Result.ConversationID != "" {
			x.t.SetSid(e.Result.ConversationID)
		}
		return x.result(e)
	}
	return nil
}

func (x *translator) step(e event) []string {
	s := e.Step
	switch s.Type {
	case "user_input":
		if s.State != "DONE" {
			return nil
		}
		return x.begin()
	case "agent_response":
		var out []string
		if s.ThinkingDelta != "" || s.TextDelta != "" { // a step that only calls tools says nothing
			out = x.ensureMessage(s.Index)
		}
		if s.ThinkingDelta != "" {
			out = append(out, x.delta(x.think, s.Index, "thinking", s.ThinkingDelta)...)
		}
		if s.TextDelta != "" {
			out = append(out, x.delta(x.text, s.Index, "text", s.TextDelta)...)
		}
		if s.State != "ACTIVE" {
			if s.Usage != nil {
				x.t.Usage.Input, x.t.Usage.Cache.Read = s.Usage.Input, s.Usage.CacheRead
				x.output += s.Usage.Output
			}
			x.ms += s.Duration * 1000
			for _, m := range []map[int]*live.Block{x.think, x.text} {
				if b := m[s.Index]; b != nil && x.t.IsOpen(b) {
					out = append(out, x.t.Stop(b))
				}
			}
		}
		return out
	case "tool":
		return x.tool(e)
	}
	return nil
}

// begin: agy started on the oldest message sent: it's echoed (so the page stops showing it queued) and a turn opens.
func (x *translator) begin() []string {
	var m sent
	if len(x.queue) > 0 {
		m, x.queue = x.queue[0], x.queue[1:]
	}
	x.t.Begin()
	x.output, x.ms, x.rec, x.reply = 0, 0, nil, nil
	x.rec = append(x.rec, map[string]any{"role": "user", "content": m.text})
	init := live.Line(live.Obj{"type", "system", "subtype", "init", "session_id", x.t.Sid, "model", x.t.Model})
	var out []string
	if !x.told && x.mode != "" { // the page's mode picker settles on what the process really runs
		x.told = true
		out = append(out, live.Line(live.Obj{"type", "system", "subtype", "status", "permissionMode", x.mode, "session_id", x.t.Sid}))
	}
	user := live.Obj{"type", "user", "message", live.Obj{"role", "user", "content", m.text}, "session_id", x.t.Sid}
	if m.id != "" {
		user = append(user, "uuid", m.id)
	}
	return append(out, init, live.Line(user))
}

func (x *translator) ensureMessage(step int) []string {
	if x.t.Msg != "" {
		return nil
	}
	return x.t.StartMessage(fmt.Sprintf("agy-%s-%d", x.t.Sid, step))
}

func (x *translator) delta(blocks map[int]*live.Block, step int, kind, text string) []string {
	var out []string
	b := blocks[step]
	if b == nil {
		b = &live.Block{Index: x.t.Next, Kind: kind, Msg: x.t.Msg}
		x.t.Next++
		blocks[step] = b
		x.t.Open = append(x.t.Open, b)
		out = append(out, live.StreamEvent(live.Obj{"type", "content_block_start", "index", b.Index, "content_block", live.Obj{"type", kind, kind, ""}}))
	}
	x.record(kind, text)
	return append(out, x.t.Delta(b, text))
}

// tool: a call is drawn when it starts (ACTIVE) and answered when it ends (DONE or ERROR).
func (x *translator) tool(e event) []string {
	s := e.Step
	id := fmt.Sprintf("agy-%s-%d", x.t.Sid, s.Index)
	name := s.Tool.Name
	var out []string
	if _, seen := x.t.Calls[id]; !seen {
		cname, input := claudeTool(name, s.Tool.Params)
		x.t.Calls[id] = live.ToolCall{Name: cname, Input: input}
		out = append(out, x.ensureMessage(s.Index)...)
		idx := x.t.Next
		x.t.Next++
		js, _ := json.Marshal(input)
		out = append(out,
			live.StreamEvent(live.Obj{"type", "content_block_start", "index", idx, "content_block", live.Obj{"type", "tool_use", "id", id, "name", cname, "input", live.Obj{}}}),
			live.StreamEvent(live.Obj{"type", "content_block_delta", "index", idx, "delta", live.Obj{"type", "input_json_delta", "partial_json", string(js)}}),
			live.StreamEvent(live.Obj{"type", "content_block_stop", "index", idx}))
		x.reply = append(x.reply, map[string]any{"type": "tool_use", "id": id, "name": cname, "input": input})
	}
	if s.State == "ACTIVE" || x.t.Results[id] {
		return out
	}
	x.t.Results[id] = true
	content, isErr := toolOutput(s.Tool.Output), false
	if s.Tool.Error != nil || s.State == "ERROR" {
		isErr = true
		if s.Tool.Error != nil {
			content = s.Tool.Error.Message
		}
	}
	// the result needs its call's message closed first: the page reads it as the reply to what came before
	out = append(out, x.t.StopMessage()...)
	res := map[string]any{"type": "tool_result", "tool_use_id": id, "content": content, "is_error": isErr}
	sessions.Clip([]any{res}) // big outputs trimmed for the page and the record alike
	x.flush()
	x.rec = append(x.rec, map[string]any{"role": "user", "content": []any{res}})
	return append(out, live.Line(live.Obj{"type", "user", "message", live.Obj{"role", "user", "content", []any{res}}, "session_id", x.t.Sid}))
}

func (x *translator) result(e event) []string {
	r := e.Result
	switch r.Status {
	case "SUCCESS", "":
	case "CANCELLED":
		x.t.ErrName = "cancelled"
	default:
		x.t.ErrName, x.t.ErrMessage = "error", r.Error
		if x.t.ErrMessage == "" {
			x.t.ErrMessage = "Antigravity ended the turn with " + strings.ToLower(r.Status)
		}
	}
	x.t.Usage.Output = x.output
	x.t.Started, x.t.Ended = 1, 1+x.ms
	if x.t.Ended == x.t.Started && r.Duration > 0 {
		x.t.Ended = 1 + r.Duration*1000
	}
	if !x.t.Busy { // a result with no message started (a bad input line): still a turn's end for the page
		x.t.Begin()
	}
	x.flush()
	lines := x.t.End(func(name string) bool { return name == "cancelled" })
	if len(r.Denied) > 0 { // agy can't ask for approval when headless: what it turned down, as the page shows Claude's
		var denials []any
		for _, d := range r.Denied {
			denials = append(denials, live.Obj{"tool_name", d.Name, "tool_input", live.Obj{}})
		}
		var res map[string]any
		if n := len(lines); n > 0 && json.Unmarshal([]byte(lines[n-1]), &res) == nil {
			res["permission_denials"] = denials
			b, _ := json.Marshal(res)
			lines[n-1] = string(b)
		}
	}
	return lines
}

// record adds streamed text to the assistant message being recorded.
func (x *translator) record(kind, text string) {
	if n := len(x.reply); n > 0 {
		if b, _ := x.reply[n-1].(map[string]any); b["type"] == kind {
			b[kind] = b[kind].(string) + text
			return
		}
	}
	x.reply = append(x.reply, map[string]any{"type": kind, kind: text})
}

func (x *translator) flush() {
	if len(x.reply) > 0 {
		sessions.Clip(x.reply)
		x.rec = append(x.rec, map[string]any{"role": "assistant", "content": x.reply})
	}
	x.reply = nil
}

// done takes the finished turn's messages, for the record.
func (x *translator) done() []map[string]any {
	r := x.rec
	x.rec = nil
	return r
}

func toolOutput(v any) string {
	switch o := v.(type) {
	case nil:
		return ""
	case string:
		return o
	default:
		b, _ := json.Marshal(o)
		return string(b)
	}
}

// tools maps agy's tool names to Claude's, which the page draws specially, and each one's input fields: Claude's
// field, then agy's names for it. ponytail: agy's parameter names were read off its stream for the tools seen
// (view_file, write_to_file, run_command); the rest are its documented names, and an unknown one is shown generic.
var tools = map[string]struct {
	name   string
	fields [][]string
}{
	"view_file":                  {"Read", [][]string{{"file_path", "AbsolutePath", "FilePath", "TargetFile"}}},
	"write_to_file":              {"Write", [][]string{{"file_path", "TargetFile", "AbsolutePath"}, {"content", "CodeContent", "Content"}}},
	"replace_file_content":       {"Edit", [][]string{{"file_path", "TargetFile", "AbsolutePath"}, {"old_string", "TargetContent"}, {"new_string", "ReplacementContent"}}},
	"multi_replace_file_content": {"Edit", [][]string{{"file_path", "TargetFile", "AbsolutePath"}}},
	"sed_file":                   {"Edit", [][]string{{"file_path", "TargetFile", "AbsolutePath"}}},
	"run_command":                {"Bash", [][]string{{"command", "CommandLine", "Command"}}},
	"grep_search":                {"Grep", [][]string{{"pattern", "Query", "Pattern"}, {"path", "SearchPath", "SearchDirectory"}}},
	"find_by_name":               {"Glob", [][]string{{"pattern", "Pattern", "Query"}, {"path", "SearchDirectory", "SearchPath"}}},
	"read_url_content":           {"WebFetch", [][]string{{"url", "Url", "URL"}}},
}

func claudeTool(name string, params map[string]any) (string, map[string]any) {
	input := map[string]any{}
	for k, v := range params {
		input[k] = v
	}
	t, ok := tools[name]
	if !ok {
		if name == "" {
			name = "tool"
		}
		return name, input
	}
	for _, f := range t.fields {
		for _, from := range f[1:] {
			if v, ok := params[from]; ok {
				input[f[0]] = v
				break
			}
		}
	}
	return t.name, input
}
