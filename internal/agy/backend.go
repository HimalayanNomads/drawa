// Package agy is the Antigravity CLI agent backend: one `agy` per card in its headless stream-json mode, a message
// per line on stdin and a turn for each (backend.go: registration and the process; translate.go: its events in the
// wire format; history.go: Drawa's own record of its conversations; meta.go: models and commit messages).
//
// Only what agy can do headless is offered (issue #34): it can't ask for approval, so a card runs either in agy's
// default mode, where tools that need one are turned down and reported like Claude's denials, or with every tool
// allowed (Allow everything), picked when its process starts; it can't be stopped or switch models or modes
// mid-session, and takes text only.
package agy

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"sync"
	"time"

	"drawa/internal/config"
	"drawa/internal/live"
	"drawa/internal/procx"
)

// Version is the agy release this backend was built and tested against.
const Version = "1.2.16"

func init() {
	live.Register("agy", live.Kind{
		Bin: "agy", Label: "agy (Antigravity CLI)", Install: "install it: https://antigravity.google, then sign in once by running agy",
		Title: "Antigravity", Blurb: "Your Google sign-in; no approvals: read-only, or Allow everything",
		Resume: "agy --conversation", Modes: map[string]bool{"default": true, "bypassPermissions": true}, SidOK: config.UUIDRe.MatchString,
		Spawn: spawn, Meta: models, History: history{}, OneShot: oneShot, Warn: versionWarning,
		// switching effort means restarting agy, and its models name their own level (#34)
		NoEffort: "https://github.com/HimalayanNomads/drawa/issues/34#issuecomment-5867108371",
		TextOnly: true, // its stream input has no field for images
	})
}

var rawVersion = sync.OnceValue(func() string {
	r, err := procx.RunEnv(10*time.Second, "", nil, "agy", "--version")
	if err != nil || r.Code != 0 {
		return ""
	}
	return strings.TrimSpace(r.Stdout)
})

func versionWarning() string {
	if v := rawVersion(); v != "" && v != Version {
		return "version " + v + ", tested with " + Version
	}
	return ""
}

var errStop = &live.Refused{Err: errors.New("Antigravity can't be stopped mid-turn from Drawa")}

type agent struct {
	mode  string // the mode it started in: agy can't change it on a running process
	p     *live.Proc
	stdin io.WriteCloser
	wmu   sync.Mutex
	mu    sync.Mutex
	tr    *translator
}

// argv: headless stream-json, resuming the card's conversation. ponytail: no flag skips a project's own agy
// settings, so an untrusted clone gets no agy card (gate this on a flag once agy has one); the canvas MCP server
// isn't wired in either, since agy takes MCP servers only from its own config folder.
func argv(s live.Spec) []string {
	a := []string{"agy", "--input-format", "stream-json", "--output-format", "stream-json", "--disable-slash-commands"}
	if s.Sid != "" {
		a = append(a, "--conversation", s.Sid)
	}
	if s.Model != "" {
		a = append(a, "--model", s.Model)
	}
	if s.Mode == "bypassPermissions" {
		a = append(a, "--dangerously-skip-permissions")
	}
	return append(a, "-p=") // -p takes the next argument as its prompt; the prompts come on stdin
}

func spawn(s live.Spec, sink live.Sink) (live.Backend, error) {
	if config.Untrusted() {
		return nil, errors.New("Antigravity can't skip this project's own settings, so it doesn't run in a clone you haven't trusted")
	}
	a := &agent{mode: mode(s.Mode), tr: newTranslator(s.Sid, s.Model)}
	a.tr.mode = a.mode
	p, stdin, err := live.StartProc(argv(s), nil, sink.Exited)
	if err != nil {
		return nil, err
	}
	a.p, a.stdin = p, stdin
	go a.pump(sink)
	return a, nil
}

func (a *agent) pump(sink live.Sink) {
	br := bufio.NewReader(a.p.Out) // no line cap: a tool's output can be big
	var tail []string              // its last non-JSON lines, shown if it ends before saying anything
	started := false
	for {
		raw, err := br.ReadBytes('\n')
		if line := strings.TrimSpace(string(raw)); strings.HasPrefix(line, "{") {
			started = true
			a.mu.Lock()
			lines := a.tr.frame([]byte(line))
			ended := strings.Contains(line, `"event":"result"`)
			var rec []map[string]any
			if ended {
				rec = a.tr.done()
			}
			sid := a.tr.t.Sid
			a.mu.Unlock()
			for _, l := range lines {
				sink.Emit(l)
			}
			if ended {
				remember(sid, rec)
			}
		} else if line != "" {
			tail = append(tail[max(0, len(tail)-19):], line)
		}
		if err != nil {
			break
		}
	}
	if !started && len(tail) > 0 {
		b, _ := json.Marshal(map[string]any{"type": "error", "text": "Antigravity didn't start: " + strings.Join(tail, "\n")})
		sink.Emit(string(b))
	}
	sink.Ended()
}

// text is a message's text: agy takes text only, so pasted images are left out.
func text(content any) string {
	if s, ok := content.(string); ok {
		return s
	}
	var parts []string
	list, _ := content.([]any)
	for _, b := range list {
		if m, _ := b.(map[string]any); m["type"] == "text" {
			if t, _ := m["text"].(string); t != "" {
				parts = append(parts, t)
			}
		}
	}
	return strings.Join(parts, "\n\n")
}

// Send writes the message; agy queues it and runs it as its own turn once the one before has ended.
func (a *agent) Send(content any, id string) error {
	t := text(content)
	if strings.TrimSpace(t) == "" {
		return &live.Refused{Err: errors.New("Antigravity takes text only")}
	}
	b, _ := json.Marshal(map[string]any{"event": "user", "message": map[string]any{"content": t}})
	a.mu.Lock()
	a.tr.queued(id, t)
	a.mu.Unlock()
	a.wmu.Lock()
	defer a.wmu.Unlock()
	_, err := a.stdin.Write(append(b, '\n'))
	return err
}

func (a *agent) Respond(string, string, live.Answer) error { return nil } // it never asks
// mode is a Drawa mode as agy runs it: the ones it doesn't have (none can ask) run as its default.
func mode(m string) string {
	if m == "bypassPermissions" {
		return m
	}
	return "default"
}

func (a *agent) SetMode(m string) error {
	if mode(m) == a.mode {
		return nil
	}
	return &live.Refused{Err: errors.New("Antigravity takes its mode when its session starts: start a new session to change it")}
}
func (a *agent) SetModel(string) error {
	return &live.Refused{Err: errors.New("Antigravity can't switch models mid-session: start a new session to pick another")}
}
func (a *agent) Interrupt() error { return errStop }
func (a *agent) Close()           { a.stdin.Close(); a.p.Stop() }
func (a *agent) Kill()            { a.p.Kill() }
