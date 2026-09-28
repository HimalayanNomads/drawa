package codex

import (
	"errors"
	"fmt"
	"path/filepath"
	"slices"
	"strings"

	"drawa/internal/config"
	"drawa/internal/live"
)

// The Backend calls a card makes on its app-server: messages, answers to asks, mode and model changes, stopping.

// input is a message as Codex's input items: text, and images as data URLs.
func input(content any) []map[string]any {
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
				out = append(out, map[string]any{"type": "image", "url": fmt.Sprintf("data:%s;base64,%s", src["media_type"], src["data"])})
			}
		}
	}
	return out
}

// steered is a message added to a running turn that Codex hasn't read yet (it echoes it back when it does).
type steered struct {
	id      string
	content any
}

// Send starts a turn, or adds the message to the running one (Codex reads it at its next step). One at a time, so
// two quick messages can't both start a turn.
func (s *server) Send(content any, id string) error {
	// counted from the start, thread setup included: a Stop meanwhile waits for the turn's id (see learned)
	s.mu.Lock()
	s.sends++
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		if s.sends--; s.sends == 0 {
			s.stopWanted = false // no turn came of it, or it was stopped already
		}
		s.mu.Unlock()
	}()
	thread, err := s.ensureThread()
	if err != nil {
		return err
	}
	s.sending.Lock()
	defer s.sending.Unlock()
	in := input(content)
	s.mu.Lock()
	turn, model, picked := s.turn, s.model, s.startModel != ""
	if model == "" {
		model = s.defaultModel // explicit: a turn's model sticks for the next ones, so "Default" has to say which
	}
	s.mu.Unlock()
	if model == "" && picked { // the card started on a picked model, then chose Default
		model = defaultModel()
	}
	if model != "" {
		s.mu.Lock()
		s.tr.SetModel(model) // what the turn's init line shows
		s.mu.Unlock()
	}
	if turn != "" {
		// listed before the call: Codex can read it (and echo it) before the reply comes
		if id != "" {
			s.mu.Lock()
			s.steered = append(s.steered, steered{id, content})
			s.mu.Unlock()
		}
		if s.call("turn/steer", map[string]any{"threadId": thread, "expectedTurnId": turn, "input": in, "clientUserMessageId": id}, nil) == nil {
			return nil
		}
		if id != "" {
			s.mu.Lock()
			n := len(s.steered)
			s.steered = slices.DeleteFunc(s.steered, func(q steered) bool { return q.id == id })
			taken := len(s.steered) == n
			s.mu.Unlock()
			if taken { // turn/completed took it and sends it again
				return nil
			}
		} // the turn ended meanwhile: start one
	}
	params := map[string]any{"threadId": thread, "input": in}
	if id != "" {
		params["clientUserMessageId"] = id
	}
	if model != "" {
		params["model"] = model
	}
	// the mode is read here, with startingMode set in the same step: a SetMode lands either before (this turn
	// starts in the new mode) or after (it sees startingMode, and stops the turn if that leaves full access)
	s.mu.Lock()
	mode, sentMode := s.mode, s.sentMode
	s.startingMode = mode
	s.mu.Unlock()
	if mode != sentMode { // only on a change: a sandbox policy sent every turn would override the user's own settings
		approval, _, sandbox := policy(mode)
		params["approvalPolicy"], params["sandboxPolicy"] = approval, sandbox
	}
	var r struct {
		Turn struct {
			ID string `json:"id"`
		} `json:"turn"`
	}
	err = s.call("turn/start", params, &r)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.startingMode = ""
	if err == nil {
		s.sentMode = mode
		if s.turn == "" && r.Turn.ID != s.lastTurn { // known before turn/started arrives, so Stop works right away
			s.learned(r.Turn.ID)
		}
	}
	return err
}

// Respond answers the ask the translator emitted as request rid.
func (s *server) Respond(rid, _ string, a live.Answer) error {
	s.mu.Lock()
	q, ok := s.tr.asks[rid]
	delete(s.tr.asks, rid)
	s.mu.Unlock()
	if !ok {
		return nil // answered or withdrawn already
	}
	var result any
	switch q.method {
	case "item/tool/requestUserInput":
		// ponytail: declining answers every question with nothing; the protocol has no way to refuse
		answers := map[string]any{}
		for i, qid := range q.qids {
			// whole, not split on the ", " the page joins picks with: questions go out single-choice, and a typed
			// answer can hold commas
			list := []string{}
			if s := strings.TrimSpace(a.Answers[q.texts[i]]); a.Allow && s != "" {
				list = []string{s}
			}
			answers[qid] = map[string]any{"answers": list}
		}
		result = map[string]any{"answers": answers}
	case "mcpServer/elicitation/request":
		action := "decline"
		if a.Allow {
			action = "accept"
		}
		r := map[string]any{"action": action, "content": nil}
		if a.Allow && !q.url { // a form: Drawa asks yes or no, so it has no fields to fill in
			r["content"] = map[string]any{}
		}
		result = r
	default:
		var d any = "decline"
		if a.Allow {
			d = "accept"
			if a.Always && q.always {
				d = "acceptForSession"
			}
		}
		result = map[string]any{"decision": d}
	}
	return s.write(map[string]any{"id": q.id, "result": result})
}

// SetMode takes effect from the next turn/start, which carries it. Leaving full access also stops the running
// turn: Codex can't take a turn's sandbox back once it's going, so it would keep full access to the end.
func (s *server) SetMode(mode string) error {
	s.mu.Lock()
	s.mode = mode
	thread, turn := s.thread, s.turn
	safer := mode != "bypassPermissions"
	running := safer && turn != "" && s.sentMode == "bypassPermissions" // a turn going with full access
	if safer && s.startingMode == "bypassPermissions" {                 // one about to start with it
		s.stopWanted = true
	}
	s.mu.Unlock()
	if running {
		return s.interrupt(thread, turn)
	}
	return nil
}

func (s *server) SetModel(model string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.model = model
	if model == "" {
		model = s.defaultModel
	}
	if model != "" { // else the next turn's init names it
		s.tr.SetModel(model)
	}
	return nil
}

func (s *server) Interrupt() error {
	s.mu.Lock()
	thread, turn := s.thread, s.turn
	if turn == "" && s.sends > 0 { // its id isn't known yet: stopped once it is (learned)
		s.stopWanted = true
	}
	s.mu.Unlock()
	if turn == "" {
		return nil
	}
	return s.interrupt(thread, turn)
}

// interrupt stops a turn. Codex refusing means the turn is over already, which is what Stop wanted.
func (s *server) interrupt(thread, turn string) error {
	err := s.call("turn/interrupt", map[string]any{"threadId": thread, "turnId": turn}, nil)
	var over *live.Refused
	if errors.As(err, &over) {
		return nil
	}
	return err
}

// threadConfig is the config every thread gets: the canvas server (its URL carries the card's token, so it goes
// over stdin, never argv), with looking at the canvas never asking, like Claude's --allowedTools.
// ("auto" would let Codex decide from the tool's annotations; "approve" means approved.)
func (s *server) threadConfig() map[string]any {
	cfg := map[string]any{}
	if s.mcp != "" {
		cfg["mcp_servers"] = map[string]any{"canvas": map[string]any{"url": s.mcp, "default_tools_approval_mode": "prompt",
			"tools": map[string]any{"canvas_list": map[string]any{"approval_mode": "approve"}, "canvas_read": map[string]any{"approval_mode": "approve"}}}}
	}
	return cfg
}

// ensureThread starts the card's thread, or resumes its saved one, on first use.
func (s *server) ensureThread() (string, error) {
	s.start.Lock()
	defer s.start.Unlock()
	s.mu.Lock()
	thread, started, sid, mode, model := s.thread, s.started, s.tr.Sid, s.mode, s.model
	s.mu.Unlock()
	if thread != "" {
		return thread, nil
	}
	if !started {
		if err := s.call("initialize", map[string]any{"clientInfo": map[string]any{"name": "drawa", "version": config.Version}}, nil); err != nil {
			return "", err
		}
		s.write(map[string]any{"method": "initialized"})
		s.mu.Lock()
		s.started = true
		s.mu.Unlock()
	}
	approval, sandbox, _ := policy(mode)
	params := map[string]any{"cwd": config.Root, "approvalPolicy": approval, "sandbox": sandbox, "config": s.threadConfig()}
	if model != "" {
		params["model"] = model
	}
	method := "thread/start"
	if sid != "" {
		if err := s.ownThread(sid); err != nil {
			return "", err
		}
		method, params["threadId"], params["excludeTurns"] = "thread/resume", sid, true
	}
	var r struct {
		Thread struct {
			ID string `json:"id"`
		} `json:"thread"`
		Model string `json:"model"`
	}
	if err := s.call(method, params, &r); err != nil {
		return "", err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.thread, s.sentMode, s.startModel = r.Thread.ID, mode, model
	s.tr.SetSid(r.Thread.ID)
	if model == "" { // Codex's default (or the project's): the model a "Default" pick means from now on
		s.defaultModel = r.Model
		s.tr.SetModel(r.Model)
	}
	return s.thread, nil
}

// ownThread: a card only resumes this project's threads (a page could name any id). Read before resuming, since
// the resume's own reply would show the cwd it was just given.
func (s *server) ownThread(sid string) error {
	var r struct {
		Thread struct {
			Cwd string `json:"cwd"`
		} `json:"thread"`
	}
	if err := s.call("thread/read", map[string]any{"threadId": sid}, &r); err != nil {
		return err
	}
	if filepath.Clean(r.Thread.Cwd) != filepath.Clean(config.Root) {
		return fmt.Errorf("that Codex thread belongs to another folder")
	}
	return nil
}
