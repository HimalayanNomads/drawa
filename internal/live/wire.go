package live

import (
	"encoding/json"
	"fmt"
)

// The wire format: what every backend emits through its Sink, whatever its own protocol, so the page and the
// /api/events plumbing never branch on backend. It is the subset of Claude Code's stream-json the page reads
// (web/src/session/stream.ts `on()`, asks.ts, tasks.ts, items/agent.ts); the claude backend emits it natively and
// other backends translate into it. One JSON object per line:
//
//   - {"type":"system","subtype":"init","session_id","model"}: a turn's process is up; session_id is what the card
//     saves and resumes with (any line's session_id is adopted), model is shown on the card.
//   - {"type":"system","subtype":"status","permissionMode"}: the agent switched mode itself (a plan was approved).
//   - {"type":"stream_event","event":{...}}: how assistant output is drawn. message_start (with message.usage for
//     the context meter), then per block content_block_start {index, content_block: text | thinking |
//     tool_use{id,name}}, content_block_delta {index, delta: text | thinking | partial_json}, content_block_stop
//     {index}. Complete "assistant" lines are ignored unless message.model is "<synthetic>", so text must stream.
//   - {"type":"user","message":{"content":[tool_result{tool_use_id, content, is_error}]}}: a tool's result.
//   - {"type":"control_request","request_id","request":{"subtype":"can_use_tool","tool_name","input",
//     "permission_suggestions"}}: an ask. Non-empty permission_suggestions offers "Always allow"; questions are
//     tool_name AskUserQuestion with input.questions [{question, header, options[{label, description}],
//     multiSelect}]. The answer comes back as Backend.Respond.
//   - {"type":"control_cancel_request","request_id"}: the agent took an ask back without an answer (its turn was
//     stopped, say); the page closes that ask.
//   - {"type":"result","subtype","is_error","result","total_cost_usd","usage","modelUsage":{m:{contextWindow}}}:
//     ends every turn; subtype error_during_execution reads as "Stopped".
//   - Lines of a sub-agent carry "parent_tool_use_id" (its Agent call's tool_use id); only assistant and user
//     lines are read for them.
//   - {"type":"error","text"}: something to show that isn't the agent's output.
//
// Tools are named and shaped as Claude's, which the page renders specially: Read, Edit, Write (file_path,
// old_string, new_string, content), Bash (command), Glob, Grep (pattern), WebFetch (url), Agent (description,
// prompt, subagent_type), TodoWrite (todos), AskUserQuestion, ExitPlanMode (plan). Anything else shows as a
// generic tool row. Live adds its own lines (exit, canvas_call, _gap, attach); backends don't emit those.

// CheckWire checks a translated stream against the rules the page depends on: blocks open and close in order
// within a message, tool results answer an earlier tool call, asks carry an id (and a cancel names one), and a
// turn that started (a user message) ends with a result. Backends' golden tests run their translated fixtures
// through it.
func CheckWire(lines []string) error {
	open := map[float64]bool{}
	calls, asked := map[string]bool{}, map[string]bool{}
	inTurn := false
	for i, line := range lines {
		var d map[string]any
		if json.Unmarshal([]byte(line), &d) != nil {
			return fmt.Errorf("line %d: not a JSON object", i+1)
		}
		switch d["type"] {
		case "stream_event":
			ev, _ := d["event"].(map[string]any)
			idx, _ := ev["index"].(float64)
			switch ev["type"] {
			case "message_start":
				if len(open) > 0 {
					return fmt.Errorf("line %d: message_start with blocks still open", i+1)
				}
			case "content_block_start":
				if open[idx] {
					return fmt.Errorf("line %d: block %v started twice", i+1, idx)
				}
				open[idx] = true
				if b, _ := ev["content_block"].(map[string]any); b["type"] == "tool_use" {
					id, _ := b["id"].(string)
					if id == "" || b["name"] == nil {
						return fmt.Errorf("line %d: tool_use without id or name", i+1)
					}
					calls[id] = true
				}
			case "content_block_delta":
				if !open[idx] {
					return fmt.Errorf("line %d: delta for block %v, which isn't open", i+1, idx)
				}
			case "content_block_stop":
				if !open[idx] {
					return fmt.Errorf("line %d: stop for block %v, which isn't open", i+1, idx)
				}
				delete(open, idx)
			}
		case "assistant": // sub-agents' calls come whole
			for _, b := range blocks(d) {
				if b["type"] == "tool_use" {
					id, _ := b["id"].(string)
					calls[id] = true
				}
			}
		case "user":
			for _, b := range blocks(d) {
				if b["type"] == "tool_result" {
					if id, _ := b["tool_use_id"].(string); !calls[id] {
						return fmt.Errorf("line %d: tool_result for unknown call %q", i+1, id)
					}
				}
			}
			if _, sub := d["parent_tool_use_id"].(string); !sub && !isToolResults(d) {
				inTurn = true
			}
		case "control_request":
			req, _ := d["request"].(map[string]any)
			id, _ := d["request_id"].(string)
			if id == "" || req["subtype"] == nil {
				return fmt.Errorf("line %d: control_request without request_id or subtype", i+1)
			}
			asked[id] = true
			if req["subtype"] == "can_use_tool" && req["tool_name"] == nil {
				return fmt.Errorf("line %d: can_use_tool without tool_name", i+1)
			}
		case "control_cancel_request":
			if id, _ := d["request_id"].(string); !asked[id] {
				return fmt.Errorf("line %d: control_cancel_request for unknown request_id %q", i+1, id)
			}
		case "result":
			if len(open) > 0 {
				return fmt.Errorf("line %d: result with blocks still open", i+1)
			}
			inTurn = false
		case "exit":
			return nil // the process ended: the page shows that instead of a result
		}
	}
	if len(open) > 0 {
		return fmt.Errorf("stream ended with blocks still open")
	}
	if inTurn {
		return fmt.Errorf("a turn has no result")
	}
	return nil
}

func blocks(d map[string]any) []map[string]any {
	msg, _ := d["message"].(map[string]any)
	list, _ := msg["content"].([]any)
	var out []map[string]any
	for _, b := range list {
		if m, ok := b.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}

// isToolResults: a user line that only carries tool results (not a new message from the user).
func isToolResults(d map[string]any) bool {
	bs := blocks(d)
	for _, b := range bs {
		if b["type"] != "tool_result" {
			return false
		}
	}
	return len(bs) > 0
}
