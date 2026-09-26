package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"

	"drawa/internal/config"
	"drawa/internal/live"
)

// modelRe: model names and aliases as Claude takes them ("opus", "claude-opus-4-1", "sonnet[1m]", Bedrock/Vertex
// ARNs with / and @); they end up on its command line, so nothing starting with - (it would read as an option).
var modelRe = regexp.MustCompile(`^[\w.\[\]/@][\w.\[\]:/@-]{0,199}$`)

// handleCardOp is the per-card operations: send a message, answer an approval, change mode, answer a canvas
// call, interrupt, or close. live.Mu only guards the Registry map itself (live.Start spawns outside it, so two
// concurrent /api/send calls for a new card still start one process); once a *Live is in hand, every card's I/O
// runs unlocked from every other card's, and Live.Write serializes writes to that one card's stdin internally.
func handleCardOp(w http.ResponseWriter, r *http.Request, cid string, body map[string]any) {
	var lv *live.Live
	if r.URL.Path == "/api/send" {
		sid, model := str(body["sid"]), str(body["model"])
		if (sid != "" && !config.UUIDRe.MatchString(sid)) || (model != "" && !modelRe.MatchString(model)) {
			http.Error(w, "", 400)
			return
		}
		var err error
		if lv, err = live.Start(cid, sid, str(body["mode"]), model); err != nil {
			http.Error(w, "", 500)
			return
		}
	} else {
		live.Mu.Lock()
		lv = live.Registry[cid]
		if r.URL.Path == "/api/close" && lv != nil {
			delete(live.Registry, cid)
		}
		live.Mu.Unlock()
	}

	var err error // stdin broke (the process died): answer 500, and the next send starts a new one
	switch r.URL.Path {
	case "/api/send":
		mode, model := str(body["mode"]), str(body["model"])
		if config.Modes[mode] && mode != lv.GetMode() {
			lv.Control("set_permission_mode", map[string]any{"mode": mode})
			lv.SetMode(mode)
		}
		if model != "" && model != lv.GetModel() {
			lv.Control("set_model", map[string]any{"model": model})
			lv.SetModel(model)
		}
		p, isStr := body["p"].(string)
		var content any
		if isStr {
			content = p
		} else if list, isList := body["p"].([]any); isList {
			content = list
		} else {
			http.Error(w, "", 400)
			return
		}
		err = lv.Write(map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": content}})

	case "/api/respond":
		if lv == nil || !lv.Alive() { // the process that asked is gone: nothing can take this answer
			sendJSON(w, map[string]any{"error": "not running"}, 409)
			return
		}
		err = respond(lv, body)

	case "/api/mode":
		m := str(body["mode"])
		if !config.Modes[m] {
			http.Error(w, "", 400)
			return
		}
		// a card's permission mode changed: switch its running process now (not running: next send starts it so)
		if lv != nil && lv.Alive() && m != lv.GetMode() {
			err = lv.Control("set_permission_mode", map[string]any{"mode": m}) // lv.Mode follows once Claude confirms (pump)
		}

	case "/api/canvas":
		// the page's answer to a canvas tool call (an MCP tool result)
		if lv != nil {
			if result, ok := body["result"].(map[string]any); ok {
				lv.AnswerCanvasCall(str(body["id"]), result)
			}
		}

	case "/api/interrupt":
		if lv != nil && lv.Alive() {
			err = lv.Control("interrupt", nil)
		}

	case "/api/close":
		if lv != nil {
			lv.Close() // can take 5s; never held Mu (freed above) so other cards' streams aren't stalled by it
			sendJSON(w, map[string]any{"ok": true, "live": lv.Alive()}, 200)
			return
		}
	}
	if err != nil {
		http.Error(w, "", 500)
		return
	}
	sendJSON(w, map[string]any{"ok": true, "live": lv != nil && lv.Alive()}, 200)
}

// respond answers a tool approval: allow (optionally "always", from Claude's own suggestion) or deny with feedback.
func respond(lv *live.Live, body map[string]any) error {
	rid := str(body["request_id"])
	line, _ := lv.PopAsk(rid)
	if line == "" {
		line = "{}"
	}
	ask := parseAskRequest(line)
	var resp map[string]any
	if truthy(body["allow"]) {
		updatedInput, _ := ask["input"].(map[string]any)
		if updatedInput == nil {
			updatedInput = map[string]any{}
		} else {
			cloned := make(map[string]any, len(updatedInput))
			for k, v := range updatedInput {
				cloned[k] = v
			}
			updatedInput = cloned
		}
		resp = map[string]any{"behavior": "allow", "updatedInput": updatedInput}
		if answers, ok := body["answers"].(map[string]any); ok { // AskUserQuestion: {question text: chosen label(s)}
			strAnswers := make(map[string]any, len(answers))
			for k, v := range answers {
				strAnswers[k] = fmt.Sprint(v)
			}
			updatedInput["answers"] = strAnswers
		}
		if truthy(body["always"]) {
			if sugg, ok := ask["permission_suggestions"]; ok && sugg != nil {
				resp["updatedPermissions"] = sugg
			}
		}
	} else {
		msg := str(body["message"])
		if msg == "" {
			msg = "The user declined this."
		}
		resp = map[string]any{"behavior": "deny", "message": msg}
	}
	if err := lv.Write(map[string]any{
		"type":     "control_response",
		"response": map[string]any{"subtype": "success", "request_id": rid, "response": resp},
	}); err != nil {
		return err
	}
	if m := str(body["mode"]); config.Modes[m] {
		lv.SetMode(m)
		return lv.Control("set_permission_mode", map[string]any{"mode": m})
	}
	return nil
}

func parseAskRequest(line string) map[string]any {
	var wrap map[string]any
	if json.Unmarshal([]byte(line), &wrap) != nil {
		return map[string]any{}
	}
	req, _ := wrap["request"].(map[string]any)
	if req == nil {
		return map[string]any{}
	}
	return req
}
