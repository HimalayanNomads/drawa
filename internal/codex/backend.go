// Package codex is the Codex CLI agent backend: one `codex app-server` per card, driven with JSON-RPC over its
// stdin and stdout. backend.go: registration, the process and its calls; client.go: what a card asks of it
// (its thread, messages, answers, mode, model, stopping); translate.go, asks.go and items.go: its messages in the wire format,
// so the page reads it like any other card; history.go: saved threads; appserver.go: one-off app-server calls;
// meta.go: the model list; oneshot.go: commit messages; config.go: the -c overrides and the
// mode policies (what acceptEdits accepts).
package codex

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"

	"drawa/internal/config"
	"drawa/internal/live"
	"drawa/internal/procx"
)

// Version is the Codex release this backend was built and tested against; app-server calls itself experimental.
const Version = "0.158.0"

var modes = map[string]bool{"default": true, "acceptEdits": true, "plan": true, "bypassPermissions": true}

func init() {
	live.Register("codex", live.Kind{
		Bin: "codex", Label: "codex (Codex CLI)", Install: "install it: https://developers.openai.com/codex/cli", Title: "Codex",
		Blurb: "Your ChatGPT plan or OpenAI API key",
		Modes: modes, SidOK: config.UUIDRe.MatchString,
		Spawn: spawn, Meta: models, History: history{}, OneShot: oneShot, Warn: versionWarning,
	})
}

var rawVersion = sync.OnceValue(func() string {
	r, err := procx.RunEnv(10*time.Second, "", nil, "codex", "--version")
	if err != nil || r.Code != 0 {
		return ""
	}
	return strings.TrimPrefix(strings.TrimSpace(r.Stdout), "codex-cli ")
})

// versionWarning notes an installed Codex other than the tested one (a warning: newer ones usually work).
func versionWarning() string {
	if v := rawVersion(); v != "" && v != Version {
		return "version " + v + ", tested with " + Version
	}
	return ""
}

var ansi = regexp.MustCompile("\x1b\\[[0-9;]*m")

type server struct {
	p     *live.Proc
	stdin io.WriteCloser
	wmu   sync.Mutex // one message at a time on stdin
	mcp   string
	sink  live.Sink

	mu           sync.Mutex
	tr           *translator
	next         int
	pending      map[int]chan reply
	started      bool      // initialize done
	thread       string    // the thread, once started or resumed
	turn         string    // the turn running ("" when idle)
	lastTurn     string    // the last turn that completed (its turn/start reply can come after)
	sends        int       // Sends in flight (thread setup included): a turn may be about to start
	startingMode string    // the mode a turn/start in flight carries
	stopWanted   bool      // Stop came while a Send was in flight: interrupt the turn once its id is known
	steered      []steered // messages added to the running turn, until Codex echoes them
	mode         string
	sentMode     string     // the mode Codex has now (thread start, or the last turn/start that changed it)
	model        string     // "" for Codex's default
	defaultModel string     // what that default is, from thread/start
	startModel   string     // the model the thread started on, if one was picked
	start        sync.Mutex // one thread start at a time
	sending      sync.Mutex // one Send at a time
}

type reply struct {
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Message string `json:"message"`
	} `json:"error"`
}

func spawn(s live.Spec, sink live.Sink) (live.Backend, error) {
	args, err := projectArgs()
	if err != nil {
		return nil, err
	}
	srv := &server{tr: newTranslator("", s.Model), pending: map[int]chan reply{}, mode: s.Mode, model: s.Model, mcp: s.MCPURL, sink: sink}
	srv.tr.SetSid(s.Sid) // a saved thread is resumed on the first message, so opening a card doesn't start anything
	p, stdin, err := live.StartProc(append([]string{"codex", "app-server"}, args...), nil, sink.Exited)
	if err != nil {
		return nil, err
	}
	srv.p, srv.stdin = p, stdin
	go srv.pump(sink)
	return srv, nil
}

// pump reads app-server's output: replies go to their calls, everything else through the translator.
func (s *server) pump(sink live.Sink) {
	br := bufio.NewReader(s.p.Out) // no line cap: a command's output can be big
	var tail []string              // its last non-JSON lines (logs), shown if it dies
	for {
		raw, err := br.ReadBytes('\n')
		if line := strings.TrimSpace(string(raw)); line != "" {
			if strings.HasPrefix(line, "{") {
				for _, l := range s.handle([]byte(line)) {
					sink.Emit(l)
				}
			} else {
				tail = append(tail[max(0, len(tail)-19):], line)
			}
		}
		if err != nil {
			break
		}
	}
	s.mu.Lock()
	started := s.started
	for id, ch := range s.pending { // calls still waiting get an answer
		ch <- reply{Error: &struct {
			Message string `json:"message"`
		}{"Codex stopped"}}
		delete(s.pending, id)
	}
	s.mu.Unlock()
	if !started && len(tail) > 0 { // once it's up, its logs are only noise (a closed card, a network hiccup it retried)
		b, _ := json.Marshal(map[string]any{"type": "error", "text": "Codex didn't start: " + ansi.ReplaceAllString(strings.Join(tail, "\n"), "")})
		sink.Emit(string(b))
	}
	sink.Ended()
}

func (s *server) handle(raw []byte) []string {
	var m struct {
		ID     json.RawMessage `json:"id"` // a number or a string
		Method string          `json:"method"`
		Params struct {
			ThreadID string `json:"threadId"`
			Item     struct {
				Type     string `json:"type"`
				ClientID string `json:"clientId"`
			} `json:"item"`
			Turn struct {
				ID string `json:"id"`
			} `json:"turn"`
			ItemID    string  `json:"itemId"`
			GrantRoot *string `json:"grantRoot"`
		} `json:"params"`
		reply
	}
	if json.Unmarshal(raw, &m) != nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if m.Method == "" { // a reply to one of our calls
		var id int
		if json.Unmarshal(m.ID, &id) == nil && s.pending[id] != nil {
			s.pending[id] <- m.reply
			delete(s.pending, id)
		}
		return nil
	}
	request := m.ID != nil
	// ponytail: another thread's notifications (a sub-agent's) are skipped, not drawn; its requests still come
	// through, or it would wait forever, and so does their resolving (request ids are per connection, not thread)
	if !request && m.Method != "serverRequest/resolved" && s.thread != "" && m.Params.ThreadID != "" && m.Params.ThreadID != s.thread {
		return nil
	}
	switch m.Method {
	case "item/fileChange/requestApproval":
		if s.mode == "acceptEdits" && m.Params.GrantRoot == nil && s.inProject(m.Params.ItemID) {
			go s.answer(raw, map[string]any{"decision": "accept"})
			return nil
		}
	case "item/started":
		if m.Params.Item.Type == "userMessage" { // Codex read a message: a steered one is delivered
			s.steered = slices.DeleteFunc(s.steered, func(q steered) bool { return q.id != "" && q.id == m.Params.Item.ClientID })
		}
	case "turn/started":
		s.learned(m.Params.Turn.ID)
	case "turn/completed":
		s.turn, s.lastTurn = "", m.Params.Turn.ID
		if left := s.steered; len(left) > 0 { // added too late for that turn: they start the next one, as Claude's
			// queue would (the page shows them queued until read). ponytail: a message sent at this moment can
			// overtake them; hold new Sends until they're out if the order ever matters
			s.steered = nil
			s.sends++ // counted from now: a Stop at this moment lands on these, not on chance
			go s.resend(left)
		}
	}
	lines := s.tr.frame(raw)
	if request && len(lines) == 0 { // a request the page can't answer
		go s.answer(raw, nil)
	}
	return lines
}

// learned: the running turn's id is known (turn/started, or turn/start's reply). A Stop that came before it
// stops it now. Called with s.mu held.
func (s *server) learned(turn string) {
	s.turn = turn
	if s.stopWanted {
		s.stopWanted = false
		go s.interrupt(s.thread, turn)
	}
}

// resend starts turns with steered messages Codex never read, telling the card about any that fail.
func (s *server) resend(left []steered) {
	defer func() {
		s.mu.Lock()
		if s.sends--; s.sends == 0 {
			s.stopWanted = false
		}
		s.mu.Unlock()
	}()
	for _, q := range left {
		if err := s.Send(q.content, q.id); err != nil {
			s.sink.Emit(live.Line(live.Obj{"type", "error", "text", "Couldn't send a queued message: " + err.Error()}))
		}
	}
}

// answer replies to a server request with result, or with an error when result is nil.
func (s *server) answer(raw []byte, result any) {
	var m struct {
		ID json.RawMessage `json:"id"`
	}
	json.Unmarshal(raw, &m)
	if result == nil {
		s.write(map[string]any{"id": m.ID, "error": map[string]any{"code": -32601, "message": "not supported by Drawa"}})
		return
	}
	s.write(map[string]any{"id": m.ID, "result": result})
}

func (s *server) write(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	s.wmu.Lock()
	defer s.wmu.Unlock()
	_, err = s.stdin.Write(append(b, '\n'))
	return err
}

// call makes one request and waits for its reply (decoded into out, if not nil).
func (s *server) call(method string, params, out any) error {
	s.mu.Lock()
	s.next++
	id, ch := s.next, make(chan reply, 1)
	s.pending[id] = ch
	s.mu.Unlock()
	if err := s.write(map[string]any{"id": id, "method": method, "params": params}); err != nil {
		s.mu.Lock()
		delete(s.pending, id)
		s.mu.Unlock()
		return err
	}
	var r reply
	select {
	case r = <-ch:
	case <-time.After(2 * time.Minute):
		s.mu.Lock()
		delete(s.pending, id)
		s.mu.Unlock()
		return fmt.Errorf("codex %s: no answer in 2 minutes", method)
	}
	if r.Error != nil { // Codex turned it down; the process is fine
		return &live.Refused{Err: fmt.Errorf("codex %s: %s", method, r.Error.Message)}
	}
	if out != nil {
		return json.Unmarshal(r.Result, out)
	}
	return nil
}

func (s *server) Close() { s.stdin.Close(); s.p.Stop() }
func (s *server) Kill()  { s.p.Kill() }
