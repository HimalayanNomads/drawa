package opencode

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"drawa/internal/live"
)

// session returns the card's session, creating it on the first message.
func (s *server) session() (string, error) {
	s.mu.Lock()
	sid, mode, model, spawned := s.sid, s.mode, s.model, s.spawnMode
	s.mu.Unlock()
	if sid != "" {
		return sid, nil
	}
	var id string
	if s.v2 {
		body := map[string]any{}
		if provider, mid, ok := strings.Cut(model, "/"); ok {
			body["model"] = map[string]any{"providerID": provider, "id": mid}
		}
		if mode == "plan" {
			body["agent"] = "plan"
		}
		var sess struct {
			Data struct {
				ID string `json:"id"`
			} `json:"data"`
		}
		if err := s.call("POST", "/api/session", body, &sess); err != nil {
			return "", err
		}
		id = sess.Data.ID
	} else {
		var sess struct {
			ID string `json:"id"`
		}
		if err := s.call("POST", "/session", map[string]any{}, &sess); err != nil {
			return "", err
		}
		id = sess.ID
	}
	s.mu.Lock()
	s.sid = id
	s.tr.SetSid(id)
	s.mu.Unlock()
	// the process's config has the mode it spawned in: a different one picked since applies now, or the session
	// would run with the old permissions (full access, after leaving bypass). Failing here replaces the process.
	if mode != spawned {
		if err := s.SetMode(mode); err != nil {
			return "", err
		}
	}
	return id, nil
}

// parts turns a message (a string or Claude content blocks) into OpenCode v1 prompt parts.
func parts(content any) []map[string]any {
	if text, ok := content.(string); ok {
		return []map[string]any{{"type": "text", "text": text}}
	}
	var out []map[string]any
	list, _ := content.([]any)
	for _, b := range list {
		m, _ := b.(map[string]any)
		switch m["type"] {
		case "text":
			if t, _ := m["text"].(string); t != "" {
				out = append(out, map[string]any{"type": "text", "text": t})
			}
		case "image":
			src, _ := m["source"].(map[string]any)
			if src["type"] == "base64" {
				mime, _ := src["media_type"].(string)
				data, _ := src["data"].(string)
				out = append(out, map[string]any{"type": "file", "mime": mime, "url": "data:" + mime + ";base64," + data})
			}
		}
	}
	return out
}

// textAndFiles turns a message into OpenCode v2's prompt shape: one text string plus file attachments (unlike v1,
// its /prompt has no parts array and no per-message model field — the model rides on the session instead).
func textAndFiles(content any) (string, []map[string]any) {
	if text, ok := content.(string); ok {
		return text, nil
	}
	var text []string
	var files []map[string]any
	list, _ := content.([]any)
	for _, b := range list {
		m, _ := b.(map[string]any)
		switch m["type"] {
		case "text":
			if t, _ := m["text"].(string); t != "" {
				text = append(text, t)
			}
		case "image":
			src, _ := m["source"].(map[string]any)
			if src["type"] == "base64" {
				mime, _ := src["media_type"].(string)
				data, _ := src["data"].(string)
				files = append(files, map[string]any{"uri": "data:" + mime + ";base64," + data})
			}
		}
	}
	return strings.Join(text, "\n"), files
}

func (s *server) Send(content any, _ string) error {
	sid, err := s.session()
	if err != nil {
		return err
	}
	if s.v2 {
		text, files := textAndFiles(content)
		body := map[string]any{"text": text}
		if len(files) > 0 {
			body["files"] = files
		}
		return s.call("POST", "/api/session/"+sid+"/prompt", body, nil)
	}
	body := map[string]any{"parts": parts(content), "agent": "build"}
	s.mu.Lock()
	if s.mode == "plan" {
		body["agent"] = "plan"
	}
	if provider, model, ok := strings.Cut(s.model, "/"); ok {
		body["model"] = map[string]any{"providerID": provider, "modelID": model}
	}
	s.mu.Unlock()
	return s.call("POST", "/session/"+sid+"/prompt_async", body, nil)
}

// Respond answers a permission ask (v1 and v2 "per_…") or questions (v1 "que_…", v2's form "frm_…").
func (s *server) Respond(rid, ask string, a live.Answer) error {
	if strings.HasPrefix(rid, "que_") {
		if !a.Allow {
			return s.call("POST", "/question/"+rid+"/reject", map[string]any{}, nil)
		}
		var d struct {
			Request struct {
				Input struct {
					Questions []struct {
						Question string `json:"question"`
					} `json:"questions"`
				} `json:"input"`
			} `json:"request"`
		}
		json.Unmarshal([]byte(ask), &d)
		answers := [][]string{}
		for _, q := range d.Request.Input.Questions {
			var labels []string
			for _, l := range strings.Split(a.Answers[q.Question], ", ") {
				if l = strings.TrimSpace(l); l != "" {
					labels = append(labels, l)
				}
			}
			answers = append(answers, append([]string{}, labels...))
		}
		return s.call("POST", "/question/"+rid+"/reply", map[string]any{"answers": answers}, nil)
	}
	s.mu.Lock()
	sid := s.sid
	s.mu.Unlock()
	if strings.HasPrefix(rid, "frm_") {
		return s.respondForm(sid, rid, ask, a)
	}
	if s.v2 {
		reply := map[string]any{"decision": "reject"}
		switch {
		case a.Allow && a.Always:
			reply["decision"] = "always"
		case a.Allow:
			reply["decision"] = "once"
		case a.Message != "":
			reply["message"] = a.Message
		}
		return s.call("POST", "/api/session/"+sid+"/permission/"+rid+"/reply", reply, nil)
	}
	reply := map[string]any{"reply": "reject"}
	switch {
	case a.Allow && a.Always:
		reply["reply"] = "always"
	case a.Allow:
		reply["reply"] = "once"
	case a.Message != "":
		reply["message"] = a.Message
	}
	return s.call("POST", "/permission/"+rid+"/reply", reply, nil)
}

// respondForm answers OpenCode v2's question tool, now a generic form: one field per question, keyed q0, q1, …
// in the order translate2.go's form() built them.
func (s *server) respondForm(sid, rid, ask string, a live.Answer) error {
	if !a.Allow {
		return s.call("DELETE", "/api/session/"+sid+"/form/"+rid, nil, nil)
	}
	var d struct {
		Request struct {
			Input struct {
				Questions []struct {
					Question string `json:"question"`
					Multi    bool   `json:"multiSelect"`
				} `json:"questions"`
			} `json:"input"`
		} `json:"request"`
	}
	json.Unmarshal([]byte(ask), &d)
	answer := map[string]any{}
	for i, q := range d.Request.Input.Questions {
		var labels []string
		for _, l := range strings.Split(a.Answers[q.Question], ", ") {
			if l = strings.TrimSpace(l); l != "" {
				labels = append(labels, l)
			}
		}
		key := fmt.Sprintf("q%d", i)
		if q.Multi {
			answer[key] = labels
		} else if len(labels) > 0 {
			answer[key] = labels[0]
		}
	}
	return s.call("POST", "/api/session/"+sid+"/form/"+rid+"/reply", map[string]any{"answer": answer}, nil)
}

// v2Action maps a Drawa/v1 permission key to OpenCode v2's action name (its shell tool was renamed from "bash").
func v2Action(perm string) string {
	if perm == "bash" {
		return "shell"
	}
	return perm
}

// SetMode: plan mode is OpenCode's plan agent, picked per message on v1 or set on the session on v2; the other
// modes are the session's permission rules (a different ruleset shape on each version).
// SetMode and Interrupt fail closed: if OpenCode turns either down, the process is replaced (a new one starts in
// the right mode, with no turn running) rather than kept as a harmless refusal.
func (s *server) SetMode(mode string) error { return fatal(s.setMode(mode)) }
func (s *server) Interrupt() error          { return fatal(s.interrupt()) }

// fatal is err without the live.Refused that keeps the process alive.
func fatal(err error) error {
	var r *live.Refused
	if errors.As(err, &r) {
		return r.Err
	}
	return err
}

func (s *server) setMode(mode string) error {
	s.mu.Lock()
	s.mode = mode
	sid, v2 := s.sid, s.v2
	s.mu.Unlock()
	if sid == "" {
		return nil // no session yet: the next one starts in this mode
	}
	if v2 {
		agent := "build"
		if mode == "plan" {
			agent = "plan"
		}
		if err := s.call("POST", "/api/session/"+sid+"/agent", map[string]any{"agent": agent}, nil); err != nil {
			return err
		}
		var rules []map[string]any
		for perm, action := range permissions(rulesFor(mode)) {
			rules = append(rules, map[string]any{"action": v2Action(perm), "resource": "*", "effect": action})
		}
		return s.call("PATCH", "/api/session/"+sid, map[string]any{"permissions": rules}, nil)
	}
	var rules []map[string]string // (and the next message picks the plan agent, in plan)
	for perm, action := range permissions(rulesFor(mode)) {
		rules = append(rules, map[string]string{"permission": perm, "pattern": "*", "action": action})
	}
	return s.call("PATCH", "/session/"+sid, map[string]any{"permission": rules}, nil)
}

// SetModel: v1 embeds the model in every prompt, so nothing to do now; v2 has no such field, so an existing
// session needs telling directly (a session with none yet picks it up from Send's session()).
func (s *server) SetModel(model string) error {
	s.mu.Lock()
	s.model = model
	s.tr.SetModel(model)
	sid, v2 := s.sid, s.v2
	s.mu.Unlock()
	if !v2 || sid == "" {
		return nil
	}
	provider, id, ok := strings.Cut(model, "/")
	if !ok {
		return nil // "Default": no v2 endpoint to un-set an existing session's model
	}
	return s.call("POST", "/api/session/"+sid+"/model", map[string]any{"model": map[string]any{"id": id, "providerID": provider}}, nil)
}

func (s *server) interrupt() error {
	s.mu.Lock()
	sid, v2 := s.sid, s.v2
	s.mu.Unlock()
	if sid == "" {
		return nil
	}
	if v2 {
		return s.call("POST", "/api/session/"+sid+"/interrupt", map[string]any{}, nil)
	}
	return s.call("POST", "/session/"+sid+"/abort", map[string]any{}, nil)
}

// rulesFor is the mode whose permission rules a mode uses: plan is the plan agent plus default's asking, so
// switching to it from bypass doesn't keep bypass's rules.
func rulesFor(mode string) string {
	if mode == "plan" {
		return "default"
	}
	return mode
}
