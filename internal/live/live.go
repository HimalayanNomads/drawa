// Package live runs one long-running agent process per session card (a backend: see backend.go): messages go
// in as they're sent (queued while busy, like the terminal), output is buffered so the page can (re)attach to the
// stream at any point.
package live

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"

	"drawa/internal/config"
	"drawa/internal/sessions"
)

const Keep = 20_000          // ponytail: output lines kept for re-attaching; older ones dropped (the transcript has them)
const KeepBytes = 16_000_000 // and at most this much text

type Live struct {
	mu    sync.Mutex
	Token string
	Gen   string
	Kind  string // the backend's name (backend.go)
	Mode  string
	Model string

	be   Backend
	done chan struct{} // closed once the process has exited (code is set by then)
	code int

	lines    []string
	base     int
	trimTo   int // after a turn's result: lines before this can go once the next turn starts (the transcript has them)
	size     int
	last     time.Time
	asks     []ask    // open approval requests in arrival order (re-sent to pages that attach later)
	readers  []string // pages reading this stream (newest last): the newest carries out canvas tool calls
	calls    map[string]*Call
	busy     bool            // mid-turn: told to pages that attach (a reloaded page can't know otherwise)
	inflight int             // Sends not answered yet
	accepted bool            // a Send was taken since the last result: a turn is coming, whatever the others did
	tasks    map[string]bool // background agents still running: they outlive the turn, so the card isn't idle
	openMsg  *int            // line where the message being streamed began: a page attaching now reads from there
	exited   bool            // the process exited, or its input broke: the next send starts a new one (Python: p.poll())
}

type ask struct{ rid, line string }

var (
	Mu       sync.Mutex
	Registry = map[string]*Live{}         // card id (from the page) -> Live
	starting = map[string]chan struct{}{} // cards whose process is being spawned (closed when done); under Mu
	metaLive *Live                        // Meta()'s one-off process while it runs, so KillAll gets it too; under Mu
	Changed  = NewBroadcaster()           // bumped whenever any card pushes a line: wakes /api/events and meta()
)

func randHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err) // the OS RNG failing is not something we can recover from
	}
	return hex.EncodeToString(b)
}

// NewForTest builds a Live with no backing process, for tests that need to register a fake card without
// spawning a real agent process (e.g. server-package tests exercising the MCP or event-stream HTTP layer).
func NewForTest(token, gen string) *Live {
	return &Live{
		Token: token, Gen: gen, last: time.Now(), calls: map[string]*Call{},
	}
}

// New starts a card's agent process with the named backend. cid == "" is used for the one-off private instance
// Meta drives, and skips the canvas MCP wiring (nothing to relay calls to).
func New(cid, kind, sid, mode, model, effort string) (*Live, error) {
	k, ok := Lookup(kind)
	if !ok {
		return nil, fmt.Errorf("no backend %q", kind)
	}
	if kind == "" {
		kind = Default
	}
	l := &Live{
		Token: randHex(16), Gen: randHex(3), Kind: kind, Mode: mode, Model: model,
		last: time.Now(), done: make(chan struct{}), calls: map[string]*Call{},
	}
	spec := Spec{Cid: cid, Sid: sid, Mode: mode, Model: model, Effort: effort}
	if cid != "" {
		spec.MCPURL = fmt.Sprintf("http://127.0.0.1:%d/mcp/%s/%s", config.Port, cid, l.Token)
	}
	be, err := k.Spawn(spec, l)
	if err != nil {
		return nil, err
	}
	l.be = be
	return l, nil
}

// Backend is the card's backend (for a backend's own package, e.g. its Meta asking its private instance).
func (l *Live) Backend() Backend { return l.be }

// Emit takes one line of the backend's output.
func (l *Live) Emit(line string) { l.Push(l.classify(line) + "\n") }

func (l *Live) Exited(code int) {
	l.mu.Lock()
	l.code, l.exited = code, true
	l.mu.Unlock()
	close(l.done)
}

// Ended: the backend's output is drained after its process exited: the turn is over, and the page is told how it ended.
func (l *Live) Ended() {
	l.mu.Lock()
	l.busy = false
	l.mu.Unlock()
	<-l.done
	l.mu.Lock()
	code := l.code
	l.mu.Unlock()
	b, _ := json.Marshal(map[string]any{"type": "exit", "code": code})
	l.Push(string(b) + "\n")
}

func (l *Live) classify(line string) string {
	// stderr noise (anything but a non-empty JSON object) -> an error line the page can show: every line sent is
	// then a JSON object the page counts, so its position stays in step with the buffer's
	if !strings.HasPrefix(line, "{") || strings.HasPrefix(strings.TrimSpace(line[1:]), "}") || !json.Valid([]byte(line)) {
		b, _ := json.Marshal(map[string]any{"type": "error", "text": strings.TrimSpace(line)})
		return string(b)
	}
	l.trackTasks(line)
	switch {
	case strings.HasPrefix(line, `{"type":"system","subtype":"init"`):
		l.mu.Lock()
		l.busy = true
		l.mu.Unlock()
	case strings.HasPrefix(line, `{"type":"stream_event","event":{"type":"message_start"`):
		l.mu.Lock()
		l.busy = true
		n := l.base + len(l.lines) // the index this line gets
		l.openMsg = &n
		l.mu.Unlock()
	case strings.HasPrefix(line, `{"type":"stream_event","event":{"type":"message_stop"`):
		l.mu.Lock()
		l.openMsg = nil // complete: the transcript has it now
		l.mu.Unlock()
	case strings.HasPrefix(line, `{"type":"control_cancel_request"`): // the agent took an ask back unanswered
		var d struct {
			RequestID string `json:"request_id"`
		}
		if json.Unmarshal([]byte(line), &d) == nil {
			l.PopAsk(d.RequestID)
		}
	case strings.Contains(line, `"type":"result"`) && isResult(line): // its keys come in any order
		l.mu.Lock()
		l.busy, l.accepted = false, false
		if len(l.asks) == 0 {
			l.trimTo = l.base + len(l.lines) // this result's index: what came before goes when the next turn starts
		}
		l.mu.Unlock()
	case len(line) > 4000 && (strings.Contains(line, `"type":"user"`) || strings.Contains(line, `"type":"assistant"`)):
		line = sessions.Trimmed(line)
	case strings.Contains(line, `"can_use_tool"`) || strings.Contains(line, `"permissionMode"`):
		var d map[string]any
		if json.Unmarshal([]byte(line), &d) == nil {
			if d["type"] == "control_request" {
				if req, ok := d["request"].(map[string]any); ok && req["subtype"] == "can_use_tool" {
					if rid, ok := d["request_id"].(string); ok {
						l.mu.Lock()
						l.asks = append(l.asks, ask{rid, line})
						l.mu.Unlock()
					}
				}
			} else if d["subtype"] == "status" {
				if pm, _ := d["permissionMode"].(string); pm != "" {
					l.mu.Lock()
					l.Mode = pm // e.g. plan approved -> Claude left plan mode
					l.mu.Unlock()
				}
			}
		}
	}
	return line
}

// isResult: a nested object's "type":"result" mustn't claim the line (it may still need trimming or be an ask).
func isResult(line string) bool {
	var d struct{ Type string }
	return json.Unmarshal([]byte(line), &d) == nil && d.Type == "result"
}

// Kill hard-kills the process group without waiting (the server is about to be replaced, or Close timed out).
func (l *Live) Kill() {
	if l.be != nil {
		l.be.Kill()
	}
}

func (l *Live) Alive() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return !l.exited
}

// wrote records a write to the process: one that failed means it can't take input any more, so the next send
// starts a new one. A Refused one is the agent saying no: the process is fine.
func (l *Live) wrote(err error) error {
	broken := err != nil && !refused(err)
	l.mu.Lock()
	l.last = time.Now()
	if broken {
		l.exited = true
	}
	l.mu.Unlock()
	if broken {
		l.Kill()
	}
	return err
}

// Send is a user message: a string or Claude content blocks; id is its uuid (or "").
func (l *Live) Send(content any, id string) error {
	l.mu.Lock()
	l.inflight++
	l.busy = true
	if len(l.asks) == 0 {
		// ponytail: trimmed here, not at the result, so streams still reading that turn's tail aren't cut off
		l.dropTo(l.trimTo)
	}
	l.mu.Unlock()
	err := l.wrote(l.be.Send(content, id))
	l.mu.Lock()
	l.inflight--
	if err == nil {
		l.accepted = l.busy // (not if its turn's result already came: that would outlive the turn)
	} else if refused(err) && l.inflight == 0 && !l.accepted { // every send was turned down: no turn is coming
		l.busy = false
	}
	l.mu.Unlock()
	return err
}

// Unsend takes back a message Send queued, if the agent hasn't read it yet (false: it has, or it can't).
func (l *Live) Unsend(id string) (bool, error) {
	u, ok := l.be.(Unsender)
	if !ok {
		return false, nil
	}
	return u.Unsend(id)
}

// Respond answers the open ask rid (an approval or questions).
func (l *Live) Respond(rid string, a Answer) error {
	line, _ := l.PopAsk(rid)
	if line == "" {
		line = "{}"
	}
	return l.wrote(l.be.Respond(rid, line, a))
}

// ChangeMode and ChangeModel ask the running process to switch; Mode and Model follow via SetMode / SetModel (or,
// for the mode, once the agent confirms it).
func (l *Live) ChangeMode(mode string) error   { return l.wrote(l.be.SetMode(mode)) }
func (l *Live) ChangeModel(model string) error { return l.wrote(l.be.SetModel(model)) }
func (l *Live) Interrupt() error               { return l.wrote(l.be.Interrupt()) }

func (l *Live) Close() {
	if l.be == nil { // NewForTest
		return
	}
	l.be.Close()
}

func (l *Live) PopAsk(rid string) (string, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for i, a := range l.asks {
		if a.rid == rid {
			l.asks = append(l.asks[:i:i], l.asks[i+1:]...)
			return a.line, true
		}
	}
	return "", false
}

func (l *Live) SetMode(mode string)   { l.mu.Lock(); l.Mode = mode; l.mu.Unlock() }
func (l *Live) SetModel(model string) { l.mu.Lock(); l.Model = model; l.mu.Unlock() }
func (l *Live) GetMode() string       { l.mu.Lock(); defer l.mu.Unlock(); return l.Mode }
func (l *Live) GetModel() string      { l.mu.Lock(); defer l.mu.Unlock(); return l.Model }
