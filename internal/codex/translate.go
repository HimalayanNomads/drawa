package codex

import (
	"encoding/json"
	"fmt"
	"strings"

	"drawa/internal/live"
)

// translator turns one card's app-server messages (notifications and the server's requests) into wire lines
// (live/wire.go). Codex reports a turn as items (a message, a command, a file change...), each started, streamed
// and completed; the page wants one assistant message per turn, drawn block by block, so each item becomes a block
// or a tool call in the turn's message.
type translator struct {
	live.Turn
	turn     string          // the turn being streamed ("" between turns)
	thinking map[string]bool // reasoning items whose summary has a part already (a new part starts a paragraph)
	asks     map[string]ask  // request_id -> the server request the page is asked about
	mcp      []string        // MCP tool calls, in order: an elicitation is about the newest unfinished one
}

type msg struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

func newTranslator(sid, model string) *translator {
	return &translator{Turn: live.NewTurn(sid, model), thinking: map[string]bool{}, asks: map[string]ask{}}
}

// frame translates one line from app-server into zero or more wire lines. Responses to our own calls carry no
// method and are skipped (the backend reads those).
func (t *translator) frame(raw []byte) []string {
	var m msg
	if json.Unmarshal(raw, &m) != nil || m.Method == "" {
		return nil
	}
	if m.ID != nil {
		return t.request(m)
	}
	// a late item or delta (after turn/completed) would open a message with no init or result around it
	if !t.Busy && (strings.HasPrefix(m.Method, "item/") || m.Method == "turn/plan/updated") {
		return nil
	}
	switch m.Method {
	case "thread/started":
		var p struct {
			Thread struct {
				ID    string `json:"id"`
				Model string `json:"model"`
			} `json:"thread"`
		}
		json.Unmarshal(m.Params, &p)
		if t.Sid == "" {
			t.SetSid(p.Thread.ID)
		}
		if t.Model == "" {
			t.SetModel(p.Thread.Model)
		}
	case "turn/started":
		var p struct {
			Turn struct {
				ID        string  `json:"id"`
				StartedAt float64 `json:"startedAt"`
			} `json:"turn"`
		}
		json.Unmarshal(m.Params, &p)
		t.Begin()
		// only the current turn's items are asked about or finished, so the maps don't grow with the thread
		t.Blocks, t.Calls, t.Results, t.thinking, t.mcp = map[string]*live.Block{}, map[string]live.ToolCall{}, map[string]bool{}, map[string]bool{}, nil
		t.turn, t.Started = p.Turn.ID, p.Turn.StartedAt*1000
		return []string{live.Line(live.Obj{"type", "system", "subtype", "init", "session_id", t.Sid, "model", t.Model})}
	case "item/started", "item/completed":
		var p struct {
			Item threadItem `json:"item"`
		}
		json.Unmarshal(m.Params, &p)
		return t.item(p.Item, m.Method == "item/completed")
	// reasoning's summary only, not its raw text (models that send both would interleave them), as history shows it
	case "item/agentMessage/delta", "item/plan/delta", "item/reasoning/summaryTextDelta":
		var p struct {
			ItemID string `json:"itemId"`
			Delta  string `json:"delta"`
		}
		json.Unmarshal(m.Params, &p)
		kind := "text"
		if strings.HasPrefix(m.Method, "item/reasoning/") {
			kind = "thinking"
		}
		return t.text(p.ItemID, kind, p.Delta)
	case "item/reasoning/summaryPartAdded":
		var p struct {
			ItemID string `json:"itemId"`
		}
		json.Unmarshal(m.Params, &p)
		if t.thinking[p.ItemID] {
			return t.text(p.ItemID, "thinking", "\n\n")
		}
	case "turn/plan/updated":
		return t.plan(m.Params)
	case "thread/tokenUsage/updated":
		var p struct {
			TokenUsage struct {
				Last struct {
					Input  float64 `json:"inputTokens"`
					Cached float64 `json:"cachedInputTokens"`
					Output float64 `json:"outputTokens"`
				} `json:"last"`
				Window float64 `json:"modelContextWindow"`
			} `json:"tokenUsage"`
		}
		json.Unmarshal(m.Params, &p)
		l := p.TokenUsage.Last
		t.Usage.Input, t.Usage.Output, t.Usage.Cache.Read = l.Input-l.Cached, l.Output, l.Cached
		t.Window = p.TokenUsage.Window // the context meter's denominator, sent with the result
	case "account/rateLimits/updated":
		var p limits
		json.Unmarshal(m.Params, &p)
		if f, w := p.windows(); f != nil || w != nil { // a credits-only update has neither: keep the rings as they are
			return []string{live.Line(live.Obj{"type", "rate_limit_event", "rate_limit_info", map[string]any{"unifiedWindows": map[string]any{"five_hour": f, "seven_day": w}}})}
		}
	case "serverRequest/resolved":
		var p struct {
			RequestID json.RawMessage `json:"requestId"`
		}
		json.Unmarshal(m.Params, &p)
		if id := rid(p.RequestID); t.asks[id].id != nil { // resolved without our answer: the turn was stopped, say
			delete(t.asks, id)
			return []string{live.Line(live.Obj{"type", "control_cancel_request", "request_id", id})}
		}
	case "error":
		var p struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
			WillRetry bool `json:"willRetry"`
		}
		json.Unmarshal(m.Params, &p)
		if !p.WillRetry && t.Busy {
			t.ErrName, t.ErrMessage = "error", p.Error.Message
		}
	case "turn/completed":
		return t.completed(m.Params)
	}
	return nil
}

// rid is a JSON-RPC id as the page's request_id.
func rid(id json.RawMessage) string { return "cx-" + strings.Trim(string(id), `"`) }

func (t *translator) completed(raw json.RawMessage) []string {
	var p struct {
		Turn struct {
			Status      string  `json:"status"`
			CompletedAt float64 `json:"completedAt"`
			Error       *struct {
				Message string `json:"message"`
			} `json:"error"`
		} `json:"turn"`
	}
	json.Unmarshal(raw, &p)
	if !t.Busy {
		return nil
	}
	switch p.Turn.Status {
	case "interrupted":
		t.ErrName = "interrupted"
	case "failed":
		t.ErrName = "failed"
		if p.Turn.Error != nil {
			t.ErrMessage = p.Turn.Error.Message
		}
	}
	t.Ended = p.Turn.CompletedAt * 1000
	t.turn = ""
	return t.End(func(name string) bool { return name == "interrupted" })
}

// open makes sure the turn's assistant message is streaming (Codex's turn is the page's message).
func (t *translator) open() []string {
	if t.Msg == t.turn && t.Msg != "" {
		return nil
	}
	id := t.turn
	if id == "" {
		id = "turn"
	}
	return t.StartMessage(id)
}

// text streams a message, plan or reasoning item's delta into its block, starting the block on its first text.
func (t *translator) text(id, kind, delta string) []string {
	if delta == "" {
		return nil
	}
	out := t.open()
	b := t.Blocks[id]
	if b == nil || !t.IsOpen(b) {
		if kind == "thinking" && b == nil && delta == "\n\n" {
			return out
		}
		b = &live.Block{Index: t.Next, Kind: kind}
		t.Next++
		t.Blocks[id] = b
		t.Open = append(t.Open, b)
		typ := live.Obj{"type", "text", "text", ""}
		if kind == "thinking" {
			typ = live.Obj{"type", "thinking", "thinking", ""}
			t.thinking[id] = true
		}
		out = append(out, live.StreamEvent(live.Obj{"type", "content_block_start", "index", b.Index, "content_block", typ}))
	}
	return append(out, t.Delta(b, delta))
}

// item: an item started (a tool call is shown as soon as it's known, so an ask about it has a row) or completed.
func (t *translator) item(it threadItem, done bool) []string {
	switch it.Type {
	case "userMessage":
		if done {
			return nil
		}
		return []string{t.userEcho(it)}
	case "agentMessage", "plan":
		if !done {
			return nil
		}
		var out []string
		if b := t.Blocks[it.ID]; b == nil { // nothing streamed: send it whole
			out = t.text(it.ID, "text", it.Text)
		}
		if b := t.Blocks[it.ID]; b != nil && t.IsOpen(b) {
			out = append(out, t.Stop(b))
		}
		return out
	case "reasoning":
		if b := t.Blocks[it.ID]; done && b != nil && t.IsOpen(b) {
			return []string{t.Stop(b)}
		}
		return nil
	}
	if it.isTool() {
		out := t.uses(it) // what's new: a file change can list its files only when it completes
		if done {
			out = append(out, t.results(it)...)
		}
		return out
	}
	return nil
}

// userEcho is the user's message as the page shows it; uuid is the page's own id for it when it sent one.
func (t *translator) userEcho(it threadItem) string {
	id := it.ClientID
	if id == "" {
		id = it.ID
	}
	return live.Line(live.Obj{"type", "user", "message", live.Obj{"role", "user", "content", it.userContent()}, "uuid", id})
}

func (t *translator) uses(it threadItem) []string {
	var out []string
	for n, c := range it.calls() {
		id := callID(it.ID, n)
		if _, sent := t.Calls[id]; sent {
			continue
		}
		if out == nil {
			out = t.open()
		}
		if n == 0 && it.Type == "mcpToolCall" {
			t.mcp = append(t.mcp, it.ID)
		}
		t.Calls[id] = c
		in, _ := json.Marshal(c.Input)
		i := t.Next
		t.Next++
		out = append(out,
			live.StreamEvent(live.Obj{"type", "content_block_start", "index", i, "content_block", live.Obj{"type", "tool_use", "id", id, "name", c.Name, "input", live.Obj{}}}),
			live.StreamEvent(live.Obj{"type", "content_block_delta", "index", i, "delta", live.Obj{"type", "input_json_delta", "partial_json", string(in)}}),
			live.StreamEvent(live.Obj{"type", "content_block_stop", "index", i}))
	}
	return out
}

func (t *translator) results(it threadItem) []string {
	content, isErr := it.output()
	var out []string
	for n := range max(1, len(it.Changes)) {
		id := callID(it.ID, n)
		if _, ok := t.Calls[id]; !ok || t.Results[id] {
			continue
		}
		t.Results[id] = true
		out = append(out, live.Line(live.Obj{"type", "user", "message", live.Obj{"role", "user", "content",
			[]live.Obj{{"type", "tool_result", "tool_use_id", id, "content", content, "is_error", isErr}}}}))
	}
	return out
}

// plan: Codex's plan updates, drawn as Claude's to-do list.
func (t *translator) plan(raw json.RawMessage) []string {
	var p struct {
		Plan []struct {
			Step   string `json:"step"`
			Status string `json:"status"`
		} `json:"plan"`
	}
	if json.Unmarshal(raw, &p) != nil || len(p.Plan) == 0 {
		return nil
	}
	todos := make([]any, 0, len(p.Plan))
	for _, s := range p.Plan {
		status := map[string]string{"inProgress": "in_progress", "completed": "completed"}[s.Status]
		if status == "" {
			status = "pending"
		}
		todos = append(todos, map[string]any{"content": s.Step, "activeForm": s.Step, "status": status})
	}
	id := fmt.Sprintf("plan-%s-%d", t.turn, len(t.Calls))
	it := threadItem{Type: "dynamicToolCall", ID: id, Tool: "TodoWrite", Arguments: map[string]any{"todos": todos}, Status: "completed"}
	return append(t.uses(it), t.results(it)...)
}
