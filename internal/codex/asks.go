package codex

import (
	"encoding/json"
	"strings"

	"drawa/internal/live"
)

// ask is a server request waiting for the page's answer.
type ask struct {
	id     json.RawMessage // the JSON-RPC id to reply to
	method string
	always bool     // "Always allow" is offered: acceptForSession, which lasts as long as this thread's process
	url    bool     // an elicitation that wants a URL visited, not a form filled
	qids   []string // a questions request: each question's id, in the order shown
	texts  []string // and its text, which the page keys its answers by
}

// request: Codex asks before running a command, changing files or calling an MCP tool, or asks the user
// questions; each is shown as Claude's can_use_tool ask about the call.
func (t *translator) request(m msg) []string {
	var p struct {
		ItemID    string `json:"itemId"`
		Command   string `json:"command"`
		Server    string `json:"serverName"`
		Message   string `json:"message"`
		Mode      string `json:"mode"`
		GrantRoot string `json:"grantRoot"`
		Reason    string `json:"reason"`
		Questions []struct {
			ID       string   `json:"id"`
			Header   string   `json:"header"`
			Question string   `json:"question"`
			Options  []option `json:"options"`
		} `json:"questions"`
	}
	json.Unmarshal(m.Params, &p)
	id := rid(m.ID)
	a := ask{id: m.ID, method: m.Method}
	var c live.ToolCall
	desc := ""
	switch m.Method {
	case "item/commandExecution/requestApproval", "item/fileChange/requestApproval":
		// not the execpolicy amendment commands offer: that's a rule saved for every project, for good
		a.always = true
		desc = p.Reason
		if p.GrantRoot != "" { // allowing it grants the whole root, so "Always" would promise less than it gives
			a.always = false
			desc = "Also lets Codex write anywhere under " + p.GrantRoot + " for this session"
		}
		c = t.Calls[p.ItemID]
		switch {
		case c.Name != "":
		case m.Method == "item/fileChange/requestApproval": // a sub-agent thread's items aren't drawn
			c = live.ToolCall{Name: "Edit", Input: map[string]any{}}
			desc = strings.TrimSuffix("A file change the card can't show (from a sub-agent); files unknown. "+desc, ". ")
		default:
			c = live.ToolCall{Name: "Bash", Input: map[string]any{"command": unwrap(p.Command)}}
		}
	case "mcpServer/elicitation/request":
		a.url = p.Mode == "url"
		p.ItemID, c = t.lastMCP(p.Server)
		if c.Name == "" {
			c = live.ToolCall{Name: "mcp__" + p.Server, Input: map[string]any{"message": p.Message}}
		}
	case "item/tool/requestUserInput":
		qs := make([]live.Obj, 0, len(p.Questions))
		for _, q := range p.Questions {
			if q.Options == nil { // free-form: the page still wants a list (it offers its own "other" box)
				q.Options = []option{}
			}
			a.qids, a.texts = append(a.qids, q.ID), append(a.texts, q.Question)
			qs = append(qs, live.Obj{"question", q.Question, "header", q.Header, "options", q.Options, "multiSelect", false})
		}
		c = live.ToolCall{Name: "AskUserQuestion", Input: map[string]any{"questions": qs}}
	default:
		return nil // the backend answers what the page can't (auth refresh, attestation...)
	}
	t.asks[id] = a
	req := live.Obj{"subtype", "can_use_tool", "tool_name", c.Name, "input", c.Input, "tool_use_id", p.ItemID}
	if a.always {
		req = append(req, "permission_suggestions", []live.Obj{{"type", "codex"}})
	}
	if desc != "" {
		req = append(req, "description", desc)
	}
	return []string{live.Line(live.Obj{"type", "control_request", "request_id", id, "request", req})}
}

// lastMCP is the newest call to an MCP server: what an elicitation from it is about.
// ponytail: matched by server, since the request doesn't name the call; two parallel calls to one server could swap.
func (t *translator) lastMCP(server string) (string, live.ToolCall) {
	for i := len(t.mcp) - 1; i >= 0; i-- {
		if c := t.Calls[t.mcp[i]]; strings.HasPrefix(c.Name, "mcp__"+server+"__") && !t.Results[t.mcp[i]] {
			return t.mcp[i], c
		}
	}
	return "", live.ToolCall{}
}

type option struct {
	Label       string `json:"label"`
	Description string `json:"description"`
}
