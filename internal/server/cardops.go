package server

import (
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
// runs unlocked from every other card's, and its backend serializes writes to that one card's process.
// `backend` in the body names the card's backend (none: live.Default, as pages from before backends send).
func handleCardOp(w http.ResponseWriter, r *http.Request, cid string, body map[string]any) {
	kindName := str(body["backend"])
	kind, known := live.Lookup(kindName)
	if !known {
		http.Error(w, "", 400)
		return
	}
	var lv *live.Live
	if r.URL.Path == "/api/send" {
		sid, model, effort := str(body["sid"]), str(body["model"]), str(body["effort"])
		if (sid != "" && !kind.SidOK(sid)) || (model != "" && !modelRe.MatchString(model)) || (effort != "" && !config.Efforts[effort]) {
			http.Error(w, "", 400)
			return
		}
		var err error
		if lv, err = live.Start(cid, kindName, sid, str(body["mode"]), model, effort); err != nil {
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
	if lv != nil {
		kind, _ = live.Lookup(lv.Kind) // a running card keeps the backend it started with
	}

	var err error // its input broke (the process died): answer 500, and the next send starts a new one
	switch r.URL.Path {
	case "/api/send":
		mode, model := str(body["mode"]), str(body["model"])
		if kind.Modes[mode] && mode != lv.GetMode() {
			lv.ChangeMode(mode)
			lv.SetMode(mode)
		}
		if model != "" && model != lv.GetModel() {
			lv.ChangeModel(model)
			lv.SetModel(model)
		}
		var content any
		switch p := body["p"].(type) {
		case string:
			content = p
		case []any:
			content = p
		default:
			http.Error(w, "", 400)
			return
		}
		err = lv.Send(content)

	case "/api/respond":
		if lv == nil || !lv.Alive() { // the process that asked is gone: nothing can take this answer
			sendJSON(w, map[string]any{"error": "not running"}, 409)
			return
		}
		if err = lv.Respond(str(body["request_id"]), answer(body)); err == nil {
			if m := str(body["mode"]); kind.Modes[m] {
				lv.SetMode(m)
				err = lv.ChangeMode(m)
			}
		}

	case "/api/mode":
		m := str(body["mode"])
		if !kind.Modes[m] {
			http.Error(w, "", 400)
			return
		}
		// a card's permission mode changed: switch its running process now (not running: next send starts it so)
		if lv != nil && lv.Alive() && m != lv.GetMode() {
			err = lv.ChangeMode(m) // lv.Mode follows once the agent confirms (classify)
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
			err = lv.Interrupt()
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

// answer reads /api/respond's body: allow (optionally always) or deny with feedback, plus AskUserQuestion answers.
func answer(body map[string]any) live.Answer {
	a := live.Answer{Allow: truthy(body["allow"]), Always: truthy(body["always"]), Message: str(body["message"])}
	if answers, ok := body["answers"].(map[string]any); ok { // {question text: chosen label(s)}
		a.Answers = make(map[string]string, len(answers))
		for k, v := range answers {
			a.Answers[k] = fmt.Sprint(v)
		}
	}
	return a
}
