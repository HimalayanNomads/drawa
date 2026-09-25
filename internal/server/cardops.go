package server

import (
	"encoding/json"
	"fmt"
	"net/http"

	"claude-ui/internal/config"
	"claude-ui/internal/live"
)

// handleCardOp is the per-card operations: send a message, answer an approval, change mode, answer a canvas
// call, interrupt, or close. All guarded by one lock, matching the original's single LIVE_LOCK-guarded block, so
// two concurrent /api/send calls for a new card can't both spawn a process for it.
func handleCardOp(w http.ResponseWriter, r *http.Request, cid string, body map[string]any) {
	live.Mu.Lock()
	lv := live.Registry[cid]

	switch r.URL.Path {
	case "/api/send":
		mode, model := str(body["mode"]), str(body["model"])
		if lv == nil || !lv.Alive() {
			newLv, err := live.New(cid, str(body["sid"]), mode, model)
			if err != nil {
				live.Mu.Unlock()
				http.Error(w, "", 500)
				return
			}
			live.Registry[cid] = newLv
			lv = newLv
		} else {
			if config.Modes[mode] && mode != lv.GetMode() {
				lv.Control("set_permission_mode", map[string]any{"mode": mode})
				lv.SetMode(mode)
			}
			if model != "" && model != lv.GetModel() {
				lv.Control("set_model", map[string]any{"model": model})
				lv.SetModel(model)
			}
		}
		p, isStr := body["p"].(string)
		var content any
		if isStr {
			content = p
		} else if list, isList := body["p"].([]any); isList {
			content = list
		} else {
			live.Mu.Unlock()
			http.Error(w, "", 400)
			return
		}
		lv.Write(map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": content}})

	case "/api/respond":
		if lv != nil && lv.Alive() {
			respond(lv, body)
		}

	case "/api/mode":
		m := str(body["mode"])
		if !config.Modes[m] {
			live.Mu.Unlock()
			http.Error(w, "", 400)
			return
		}
		// a card's permission mode changed: switch its running process now (not running: next send starts it so)
		if lv != nil && lv.Alive() && m != lv.GetMode() {
			lv.Control("set_permission_mode", map[string]any{"mode": m}) // lv.Mode follows once Claude confirms (pump)
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
			lv.Control("interrupt", nil)
		}

	case "/api/close":
		if lv != nil {
			delete(live.Registry, cid)
			lv.Close()
		}
	}
	live.Mu.Unlock()
	sendJSON(w, map[string]any{"ok": true, "live": lv != nil && lv.Alive()}, 200)
}

// respond answers a tool approval: allow (optionally "always", from Claude's own suggestion) or deny with feedback.
func respond(lv *live.Live, body map[string]any) {
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
	lv.Write(map[string]any{
		"type":     "control_response",
		"response": map[string]any{"subtype": "success", "request_id": rid, "response": resp},
	})
	if m := str(body["mode"]); config.Modes[m] {
		lv.Control("set_permission_mode", map[string]any{"mode": m})
		lv.SetMode(m)
	}
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
