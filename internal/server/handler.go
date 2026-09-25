// Package server is the HTTP layer: GET routing, the write endpoints (/api/git, /api/gh, /api/images, the
// per-card send/respond/mode/canvas/interrupt/close operations), static file serving, and dispatch to the
// /api/events stream, the canvas MCP server, and the /api/shell runner.
package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"claude-ui/internal/config"
	"claude-ui/internal/filesx"
	"claude-ui/internal/github"
	"claude-ui/internal/gitx"
	"claude-ui/internal/images"
	"claude-ui/internal/live"
	"claude-ui/internal/sessions"
)

type Q map[string]string

func (q Q) require(key string) (string, error) {
	v, ok := q[key]
	if !ok {
		return "", fmt.Errorf("missing %s", key)
	}
	return v, nil
}

func defaultStr(v, def string) string {
	if v == "" {
		return def
	}
	return v
}

func truthy(v any) bool { b, _ := v.(bool); return b }
func str(v any) string  { s, _ := v.(string); return s }

// Handler is the whole HTTP surface: localhost only, this endpoint runs Claude Code with your permissions.
func Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			doGET(w, r)
		case http.MethodPost:
			doPOST(w, r)
		default:
			http.Error(w, "", http.StatusMethodNotAllowed)
		}
	})
}

func sendJSON(w http.ResponseWriter, body any, status int) {
	data, err := json.Marshal(body)
	if err != nil {
		data = []byte(`{"error":"internal"}`)
		status = 500
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	w.Write(data)
}

func sendBytes(w http.ResponseWriter, data []byte, kind, cache string) {
	w.Header().Set("Content-Type", kind)
	if cache != "" {
		w.Header().Set("Cache-Control", cache)
	}
	w.WriteHeader(200)
	w.Write(data)
}

type routeFunc func(Q) (any, int, error)

func ok(body any, err error) (any, int, error) {
	if err != nil {
		return nil, 0, err
	}
	return body, 200, nil
}

var getRoutes = map[string]routeFunc{
	"/api/info": func(q Q) (any, int, error) { return map[string]any{"root": config.Root}, 200, nil },
	"/api/tree": func(q Q) (any, int, error) { return ok(filesx.Tree(q["path"])) },
	"/api/file": func(q Q) (any, int, error) {
		p, err := q.require("path")
		if err != nil {
			return nil, 0, err
		}
		return ok(filesx.Get(p))
	},
	"/api/git": func(q Q) (any, int, error) { return gitx.GitState(), 200, nil },
	"/api/git/diff": func(q Q) (any, int, error) {
		p, err := q.require("path")
		if err != nil {
			return nil, 0, err
		}
		return ok(gitx.GitDiff(p, q["staged"] == "1"))
	},
	"/api/files": func(q Q) (any, int, error) { return filesx.Find(q["q"], 40), 200, nil },
	"/api/meta":  func(q Q) (any, int, error) { return live.Meta(), 200, nil },
	"/api/sessions": func(q Q) (any, int, error) {
		if info, err := os.Stat(config.Sessions); err != nil || !info.IsDir() {
			return []sessions.Info{}, 200, nil
		}
		return sessions.List(), 200, nil
	},
	"/api/session":   sessionRoute,
	"/api/gh":        func(q Q) (any, int, error) { return github.State(), 200, nil },
	"/api/gh/prs":    func(q Q) (any, int, error) { return ok(github.Prs(defaultStr(q["state"], "open"))) },
	"/api/gh/issues": func(q Q) (any, int, error) { return ok(github.Issues(defaultStr(q["state"], "open"))) },
	"/api/gh/pr":     func(q Q) (any, int, error) { return ok(github.Pr(q["n"])) },
	"/api/gh/issue":  func(q Q) (any, int, error) { return ok(github.Issue(q["n"])) },
	"/api/gh/log":    func(q Q) (any, int, error) { return ok(github.Log(q["url"])) },
}

var agentIDRe = regexp.MustCompile(`^[\w-]{1,100}$`)

func sessionRoute(q Q) (any, int, error) {
	sid := q["id"]
	if !config.UUIDRe.MatchString(sid) {
		return map[string]any{"error": "bad session id"}, 404, nil
	}
	agent := q["agent"]
	if agent != "" && !agentIDRe.MatchString(agent) {
		return map[string]any{"error": "bad agent id"}, 404, nil
	}
	if _, err := os.Stat(filepath.Join(config.Sessions, sid+".jsonl")); err == nil {
		return sessions.Load(sid, agent), 200, nil
	}
	// the CLI writes it once the first message is queued; until then the page reads the live process instead
	return map[string]any{"error": "This session's transcript isn't written yet.", "missing": true}, 404, nil
}

func mapErr(err error) (int, map[string]any) {
	if errors.Is(err, config.ErrOutside) {
		return 403, map[string]any{"error": "outside project folder"}
	}
	var ghErr *github.Error
	if errors.As(err, &ghErr) {
		return 502, map[string]any{"error": err.Error()}
	}
	return 404, map[string]any{"error": err.Error()}
}

func singleValues(v url.Values) Q {
	q := Q{}
	for k, vs := range v {
		if len(vs) > 0 {
			q[k] = vs[0]
		}
	}
	return q
}

func doGET(w http.ResponseWriter, r *http.Request) {
	if !config.Hosts[r.Host] { // DNS rebinding would otherwise expose your files
		http.Error(w, "", 403)
		return
	}
	path := r.URL.Path
	q := singleValues(r.URL.Query())
	if path == "/api/events" {
		streamEvents(w, r, q)
		return
	}
	if strings.HasPrefix(path, "/mcp/") {
		http.Error(w, "", 405) // the canvas MCP server has no server-to-client stream
		return
	}
	if !strings.HasPrefix(path, "/api/") {
		static(w, path)
		return
	}
	if strings.HasPrefix(path, "/api/images/") && images.HashRe.MatchString(path[len("/api/images/"):]) {
		data, err := os.ReadFile(filepath.Join(images.Store_, path[len("/api/images/"):]))
		if err != nil {
			http.Error(w, "", 404)
			return
		}
		kind := images.Type(data)
		if kind == "" {
			kind = "application/octet-stream"
		}
		sendBytes(w, data, kind, "private, max-age=31536000, immutable")
		return
	}
	route, found := getRoutes[path]
	if !found {
		http.Error(w, "", 404)
		return
	}
	body, status, err := route(q)
	if err != nil {
		status, body = mapErr(err)
	}
	sendJSON(w, body, status)
}

func static(w http.ResponseWriter, reqPath string) {
	info, err := os.Stat(config.Dist)
	if err != nil || !info.IsDir() {
		http.Error(w, "UI not built: run `npm install && npm run build` in web/", 503)
		return
	}
	rel := strings.TrimPrefix(reqPath, "/")
	if rel == "" {
		rel = "index.html"
	}
	f := filepath.Clean(filepath.Join(config.Dist, rel))
	if f != config.Dist && !strings.HasPrefix(f, config.Dist+string(filepath.Separator)) {
		http.Error(w, "", 404)
		return
	}
	fi, err := os.Stat(f)
	if err != nil || fi.IsDir() {
		http.Error(w, "", 404)
		return
	}
	data, err := os.ReadFile(f)
	if err != nil {
		http.Error(w, "", 404)
		return
	}
	kind := mime.TypeByExtension(filepath.Ext(f))
	if kind == "" {
		kind = "application/octet-stream"
	}
	sendBytes(w, data, kind, "")
}

// maxBody caps a POST body (a pasted image, base64, is the biggest thing the page sends).
const maxBody = 25 << 20

// Any website you visit can POST to localhost; only accept our own page (Origin) on our own host (DNS rebinding).
func doPOST(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(r.URL.Path, "/")
	if len(parts) == 4 && parts[1] == "mcp" && config.Hosts[r.Host] { // /mcp/<card>/<token>
		handleMCP(w, r, parts[2], parts[3])
		return
	}
	origin := r.Header.Get("Origin")
	if i := strings.Index(origin, "://"); i >= 0 {
		origin = origin[i+3:]
	}
	if !config.Hosts[r.Host] || !config.Origins[origin] {
		http.Error(w, "", 403)
		return
	}
	raw, _ := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBody))
	var body map[string]any
	if json.Unmarshal(raw, &body) != nil {
		body = map[string]any{}
	}

	switch r.URL.Path {
	case "/api/shell":
		runShell(w, r, str(body["cmd"]))
		return
	case "/api/images":
		sendJSON(w, images.Save(str(body["data"])), 200)
		return
	case "/api/gh":
		sendJSON(w, github.Op(body), 200)
		return
	case "/api/git":
		out, err := gitx.GitOp(body)
		if err != nil {
			sendJSON(w, map[string]any{"ok": false, "out": "path outside project folder"}, 403)
			return
		}
		sendJSON(w, out, 200)
		return
	}

	cid := str(body["cid"])
	if !config.UUIDRe.MatchString(cid) {
		http.Error(w, "", 400)
		return
	}
	handleCardOp(w, r, cid, body)
}
