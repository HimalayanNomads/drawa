// Package opencode is the OpenCode agent backend: one `opencode serve` per card, driven over its HTTP API (this
// file: registration and process lifecycle; client.go: the API calls a turn makes), its event stream translated
// into the wire format (translate.go, translate2.go) so the page reads it like any other card.
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
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"drawa/internal/config"
	"drawa/internal/live"
	"drawa/internal/procx"
)

// Version and VersionV2 are the OpenCode releases this backend was built and tested against: v2's HTTP server (a
// near-total rewrite of v1's, see spawn/session/Send/meta below) needs its own code path, so both are tracked.
const (
	Version   = "1.18.32"
	VersionV2 = "2.0.18"
)

// untrustedEnv keeps a clone of someone else's repo from configuring OpenCode. OPENCODE_DISABLE_PROJECT_CONFIG
// (checked on 1.18.33) skips the project's opencode.json(c), its .opencode/ folders (plugins there are code that
// runs as soon as any opencode command loads config, even `opencode debug config`; also agents, commands, MCP
// servers) and its AGENTS.md/CLAUDE.md. The user's global config and OPENCODE_CONFIG_CONTENT (the canvas server,
// the permissions) still load.
func untrustedEnv() []string {
	if !config.Untrusted() {
		return nil
	}
	return []string{"OPENCODE_DISABLE_PROJECT_CONFIG=1"}
}

// ocRun is procx.RunEnv for an opencode command, which also runs in Root, so it gets untrustedEnv too.
func ocRun(timeout time.Duration, stdin string, args ...string) (*procx.Result, error) {
	var env []string
	if e := untrustedEnv(); e != nil {
		env = append(os.Environ(), e...)
	}
	return procx.RunEnv(timeout, stdin, env, append([]string{"opencode"}, args...)...)
}

// rawVersion runs `opencode --version` once (cached: every call site would otherwise re-run it).
var rawVersion = sync.OnceValue(func() string {
	r, err := ocRun(10*time.Second, "", "--version")
	if err != nil || r.Code != 0 {
		return ""
	}
	return strings.TrimSpace(r.Stdout)
})

// normalizeVersion strips the "opencode " / "v" prefix v2 prints ("opencode v2.0.18") that v1 didn't ("1.18.32").
func normalizeVersion(v string) string {
	v = strings.TrimPrefix(v, "opencode ")
	return strings.TrimPrefix(v, "v")
}

// isV2 reports whether the installed OpenCode is a v2 release.
func isV2() bool {
	major, _, _ := strings.Cut(normalizeVersion(rawVersion()), ".")
	n, _ := strconv.Atoi(major)
	return n >= 2
}

var sidRe = regexp.MustCompile(`^ses_[A-Za-z0-9]{10,60}$`)

var modes = map[string]bool{"default": true, "acceptEdits": true, "plan": true, "bypassPermissions": true}

func init() {
	live.Register("opencode", live.Kind{
		Bin: "opencode", Label: "opencode (OpenCode CLI)", Install: "install it: https://opencode.ai", Title: "OpenCode",
		Modes: modes, SidOK: sidRe.MatchString, MaxLive: 3,
		Spawn: spawn, Meta: meta, History: history{}, OneShot: oneShot, Warn: versionWarning,
	})
}

// wireTranslator is implemented by both the v1 and v2 event translators (translate.go, translate2.go); the two
// servers' events are different enough (a rewritten vocabulary and payload shape) that they need one each.
type wireTranslator interface {
	frame(raw []byte) []string
	setModel(model string)
	setSid(sid string)
}

type server struct {
	p      *live.Proc
	base   string // http://127.0.0.1:<port>, once it listens
	pass   string
	ready  chan struct{} // closed when base is known (or the process ended first)
	client *http.Client
	v2     bool // this card's OpenCode is a v2 release: different endpoints, request/response shapes and events

	mu    sync.Mutex
	tr    wireTranslator
	sid   string
	mode  string
	model string
	sse   chan struct{} // closed when the event stream ends
}

// versionWarning notes an installed OpenCode other than the tested one (a warning: newer ones usually work).
func versionWarning() string {
	v := rawVersion()
	if v == "" {
		return ""
	}
	tested := Version
	if isV2() {
		tested = VersionV2
	}
	if normalizeVersion(v) != tested {
		return "version " + v + ", tested with " + tested
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
	v2 := isV2()
	var tr wireTranslator
	if v2 {
		tr = newTranslatorV2(s.Sid, s.Model)
	} else {
		tr = newTranslator(s.Sid, s.Model)
	}
	srv := &server{pass: randHex(16), ready: make(chan struct{}), client: &http.Client{}, sid: s.Sid, mode: s.Mode, model: s.Model,
		tr: tr, sse: make(chan struct{}), v2: v2}
	// the static permission config still works in its v1 shape on a v2 server; only the runtime API (SetMode) changed
	cfg := map[string]any{"permission": permissions(s.Mode)}
	if s.MCPURL != "" {
		cfg["mcp"] = map[string]any{"canvas": map[string]any{"type": "remote", "url": s.MCPURL, "oauth": false}}
	}
	cfgJSON, _ := json.Marshal(cfg)
	// the password and the MCP URL (it carries the card's token) go in the environment, never argv
	env := []string{"OPENCODE_SERVER_PASSWORD=" + srv.pass, "OPENCODE_CONFIG_CONTENT=" + string(cfgJSON)}
	env = append(env, untrustedEnv()...)
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

// events streams GET /event (v1) or /api/event (v2) and hands each translated line to the sink.
func (s *server) events(sink live.Sink) {
	defer close(s.sse)
	path := "/event"
	if s.v2 {
		path = "/api/event"
	}
	req, _ := http.NewRequest("GET", s.base+path+"?directory="+url.QueryEscape(config.Root), nil)
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

func (s *server) Close() { s.p.Stop() }
func (s *server) Kill()  { s.p.Kill() }
