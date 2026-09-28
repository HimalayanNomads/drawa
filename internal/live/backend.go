package live

import (
	"errors"
	"sort"

	"drawa/internal/sessions"
)

// Spec is everything a backend needs to start one card's agent.
type Spec struct {
	Cid, Sid, Mode, Model string
	Effort                string // Claude's reasoning effort (config.Efforts); backends without one ignore it
	MCPURL                string // the card's canvas MCP endpoint (it carries the card's token): never put it in argv
}

// Answer is the page's reply to an ask (a tool approval or questions), normalized from /api/respond.
type Answer struct {
	Allow, Always bool
	Message       string // why it was declined
	// ponytail: question text -> the chosen labels joined by ", ", as the page sends them; backends that take a
	// list per question split it. Send lists from the page if a label ever contains ", ".
	Answers map[string]string // nil: not a questions answer
}

// Backend runs one card's agent process. It reports through the Sink it was spawned with, in the wire format
// described in wire.go, whatever its own protocol is.
type Backend interface {
	Send(content any, id string) error       // a user message: a string or Claude content blocks; id: its uuid, or ""
	Respond(rid, ask string, a Answer) error // answer the ask it emitted as line `ask` ("{}" if it's gone)
	SetMode(mode string) error               // a Drawa permission mode (a key of its Kind's Modes)
	SetModel(model string) error
	Interrupt() error
	Close() // graceful: waits up to 5s, then kills
	Kill()  // the whole process group, now
}

// Unsender is a Backend that can take back a message it was sent but hasn't read yet (see Kind.Unsend).
type Unsender interface {
	Unsend(id string) (bool, error) // false: already read (or never queued)
}

// Refused is a backend error meaning the agent turned the request down (a mode it won't switch to mid-turn, say)
// while its process is fine: Live passes it on without treating the process as gone.
type Refused struct{ Err error }

func (r *Refused) Error() string { return r.Err.Error() }
func (r *Refused) Unwrap() error { return r.Err }

func refused(err error) bool {
	var r *Refused
	return errors.As(err, &r)
}

// Sink is how a backend reports; *Live implements it.
type Sink interface {
	Emit(line string) // one output line (no newline): Live classifies and buffers it
	Exited(code int)  // the process is gone: the card stops counting as alive
	Ended()           // its output is drained too: the exit line goes out
}

// History reads a backend's saved sessions for the history list and for reopening one.
type History interface {
	List() []sessions.Info
	Load(sid, agent string) ([]map[string]any, bool) // false: not written yet (the page reads the live stream)
}

// Kind is one backend. Adding one is a package that calls Register from its init().
type Kind struct {
	Bin, Label, Install string          // the executable, how preflight names it, where to get it
	Title               string          // what the page calls it ("Claude Code")
	Blurb               string          // one line on what picking it means, for menus
	Modes               map[string]bool // the Drawa permission modes it accepts
	Unsend              bool            // its Backend is an Unsender: queued messages can be deleted or edited
	SidOK               func(sid string) bool
	Spawn               func(Spec, Sink) (Backend, error)
	Meta                func() map[string]any // {models, commands}; Meta() caches it
	History             History               // nil: it has no history list
	// OneShot answers one prompt about text (on stdin) with a fast model and no tools: commit messages, PR
	// descriptions. (true, its reply) or (false, the error). nil: it can't; Write picks another backend.
	OneShot func(prompt, text string) (bool, string)
	Warn    func() string // a note for preflight when its CLI is installed (e.g. an untested version), or ""
}

var kinds = map[string]Kind{} // written only by init()s, so read without a lock

// Default is the backend a request that names none gets: pages from before backends existed.
const Default = "claude"

func Register(name string, k Kind) { kinds[name] = k }

// Lookup finds a backend by name; "" means Default.
func Lookup(name string) (Kind, bool) {
	if name == "" {
		name = Default
	}
	k, ok := kinds[name]
	return k, ok
}

// Names lists the registered backends in a fixed order.
func Names() []string {
	names := make([]string, 0, len(kinds))
	for n := range kinds {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}
