// Package opencode is the OpenCode agent backend: one `opencode serve` per card, driven over its HTTP API, its
// event stream translated into the wire format (translate.go) so the page reads it like any other card.
package opencode

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	"drawa/internal/config"
	"drawa/internal/live"
	"drawa/internal/procx"
)

// Version is the OpenCode release this backend was built and tested against (its API changes often).
const Version = "1.18.32"

var sidRe = regexp.MustCompile(`^ses_[A-Za-z0-9]{10,60}$`)

var modes = map[string]bool{"default": true, "acceptEdits": true, "plan": true, "bypassPermissions": true}

func init() {
	live.Register("opencode", live.Kind{
		Bin: "opencode", Label: "opencode (OpenCode CLI)", Install: "install it: https://opencode.ai", Title: "OpenCode",
		Modes: modes, SidOK: sidRe.MatchString, MaxLive: 3,
		Spawn: spawn, Meta: meta, History: history{}, OneShot: oneShot, Warn: versionWarning,
	})
}

type server struct {
	p      *live.Proc
	base   string // http://127.0.0.1:<port>, once it listens
	pass   string
	ready  chan struct{} // closed when base is known (or the process ended first)
	client *http.Client

	mu    sync.Mutex
	tr    *translator
	sid   string
	mode  string
	model string
	sse   chan struct{} // closed when the event stream ends
}

// versionWarning notes an installed OpenCode other than the tested one (a warning: newer ones usually work).
func versionWarning() string {
	r, err := procx.RunEnv(10*time.Second, "", nil, "opencode", "--version")
	if err != nil || r.Code != 0 {
		return ""
	}
	if v := strings.TrimSpace(r.Stdout); v != Version {
		return "version " + v + ", tested with " + Version
	}
	return ""
}

func randHex(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// permissions is OpenCode's permission config for a Drawa mode (plan mode is its plan agent instead).
func permissions(mode string) map[string]string {
	switch mode {
	case "acceptEdits":
		return map[string]string{"edit": "allow", "bash": "ask", "webfetch": "ask"}
	case "bypassPermissions":
		return map[string]string{"edit": "allow", "bash": "allow", "webfetch": "allow"}
	}
	return map[string]string{"edit": "ask", "bash": "ask", "webfetch": "ask"}
}

var listeningRe = regexp.MustCompile(`listening on (http://127\.0\.0\.1:\d+)`)

func spawn(s live.Spec, sink live.Sink) (live.Backend, error) {
	srv := &server{pass: randHex(16), ready: make(chan struct{}), client: &http.Client{}, sid: s.Sid, mode: s.Mode, model: s.Model,
		tr: newTranslator(s.Sid, s.Model), sse: make(chan struct{})}
	cfg := map[string]any{"permission": permissions(s.Mode)}
	if s.MCPURL != "" {
		cfg["mcp"] = map[string]any{"canvas": map[string]any{"type": "remote", "url": s.MCPURL, "oauth": false}}
	}
	cfgJSON, _ := json.Marshal(cfg)
	// the password and the MCP URL (it carries the card's token) go in the environment, never argv
	env := []string{"OPENCODE_SERVER_PASSWORD=" + srv.pass, "OPENCODE_CONFIG_CONTENT=" + string(cfgJSON)}
	p, stdin, err := live.StartProc([]string{"opencode", "serve", "--port", "0", "--hostname", "127.0.0.1"}, env, sink.Exited)
	if err != nil {
		return nil, err
	}
	stdin.Close()
	srv.p = p
	go srv.pump(sink)
	return srv, nil
}

// pump reads the server's own output (logs) until it says where it listens, then streams its events.
func (s *server) pump(sink live.Sink) {
	br := bufio.NewReader(s.p.Out)
	var tail []string // its last lines, shown if it dies before listening
	for {
		raw, err := br.ReadString('\n')
		if m := listeningRe.FindStringSubmatch(raw); m != nil && s.base == "" {
			s.base = m[1]
			close(s.ready)
			go s.events(sink)
		} else if t := strings.TrimSpace(raw); t != "" && s.base == "" {
			tail = append(tail[max(0, len(tail)-19):], t)
		}
		if err != nil {
			break
		}
	}
	if s.base == "" {
		close(s.ready)
		b, _ := json.Marshal(map[string]any{"type": "error", "text": "OpenCode didn't start: " + strings.Join(tail, "\n")})
		sink.Emit(string(b))
		close(s.sse)
	}
	select { // the last events can still be arriving
	case <-s.sse:
	case <-time.After(2 * time.Second):
	}
	sink.Ended()
}

// events streams GET /event and hands each translated line to the sink.
func (s *server) events(sink live.Sink) {
	defer close(s.sse)
	req, _ := http.NewRequest("GET", s.base+"/event?directory="+url.QueryEscape(config.Root), nil)
	req.SetBasicAuth("opencode", s.pass)
	resp, err := s.client.Do(req)
	if err != nil {
		return
	}
	defer resp.Body.Close()
	br := bufio.NewReader(resp.Body) // no line cap: a tool's output can be big
	for {
		raw, err := br.ReadBytes('\n')
		if data, ok := bytes.CutPrefix(bytes.TrimRight(raw, "\r\n"), []byte("data: ")); ok {
			s.mu.Lock()
			lines := s.tr.frame(data)
			s.mu.Unlock()
			for _, l := range lines {
				sink.Emit(l)
			}
		}
		if err != nil {
			return
		}
	}
}

func (s *server) wait() error {
	select {
	case <-s.ready:
	case <-time.After(30 * time.Second):
		return errors.New("OpenCode didn't start in 30s")
	}
	if s.base == "" {
		return errors.New("OpenCode didn't start")
	}
	return nil
}

// call makes one API request (body nil or JSON) and decodes the answer into out (if not nil).
func (s *server) call(method, path string, body, out any) error {
	if err := s.wait(); err != nil {
		return err
	}
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	sep := "?"
	if strings.Contains(path, "?") {
		sep = "&"
	}
	req, _ := http.NewRequest(method, s.base+path+sep+"directory="+url.QueryEscape(config.Root), rd)
	req.SetBasicAuth("opencode", s.pass)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if resp.StatusCode >= 300 {
		return fmt.Errorf("opencode %s %s: %d %s", method, path, resp.StatusCode, strings.TrimSpace(string(b)))
	}
	if out != nil && len(b) > 0 {
		return json.Unmarshal(b, out)
	}
	return nil
}

// session returns the card's session, creating it on the first message.
func (s *server) session() (string, error) {
	s.mu.Lock()
	sid := s.sid
	s.mu.Unlock()
	if sid != "" {
		return sid, nil
	}
	var sess struct {
		ID string `json:"id"`
	}
	if err := s.call("POST", "/session", map[string]any{}, &sess); err != nil {
		return "", err
	}
	s.mu.Lock()
	s.sid, s.tr.sid = sess.ID, sess.ID
	s.mu.Unlock()
	if s.mode != "" && s.mode != "default" && s.mode != "plan" {
		s.SetMode(s.mode)
	}
	return sess.ID, nil
}

// parts turns a message (a string or Claude content blocks) into OpenCode prompt parts.
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

func (s *server) Send(content any) error {
	sid, err := s.session()
	if err != nil {
		return err
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

// Respond answers a permission ask (per_…) or questions (que_…).
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

// SetMode: plan mode is OpenCode's plan agent, picked per message; the others are the session's permission rules.
func (s *server) SetMode(mode string) error {
	s.mu.Lock()
	s.mode = mode
	sid := s.sid
	s.mu.Unlock()
	if sid == "" || mode == "plan" {
		return nil // no session yet (it starts in this mode), or the next message picks the plan agent
	}
	var rules []map[string]string
	for perm, action := range permissions(mode) {
		rules = append(rules, map[string]string{"permission": perm, "pattern": "*", "action": action})
	}
	return s.call("PATCH", "/session/"+sid, map[string]any{"permission": rules}, nil)
}

func (s *server) SetModel(model string) error {
	s.mu.Lock()
	s.model, s.tr.model = model, model
	s.mu.Unlock()
	return nil // the next message carries it
}

func (s *server) Interrupt() error {
	s.mu.Lock()
	sid := s.sid
	s.mu.Unlock()
	if sid == "" {
		return nil
	}
	return s.call("POST", "/session/"+sid+"/abort", map[string]any{}, nil)
}

func (s *server) Close() { s.p.Stop() }
func (s *server) Kill()  { s.p.Kill() }
