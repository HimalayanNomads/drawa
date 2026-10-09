// Package server is the HTTP layer: GET routing, the write endpoints (/api/git, /api/gh, /api/images, /api/prefs, the
// per-card send/respond/mode/canvas/interrupt/close operations), static file serving, and dispatch to the
// /api/events stream, the canvas MCP server, and the /api/shell runner.
package server

import (
	"bytes"
	"cmp"
	"compress/gzip"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"drawa/internal/config"
	"drawa/internal/filesx"
	"drawa/internal/github"
	"drawa/internal/gitx"
	"drawa/internal/images"
	"drawa/internal/live"
	"drawa/internal/prefs"
	"drawa/internal/sessions"
	"drawa/internal/symbols"
	"drawa/internal/update"
	"drawa/internal/webassets"
)

func truthy(v any) bool { b, _ := v.(bool); return b }
func str(v any) string  { s, _ := v.(string); return s }

// need is a required query parameter: absent (not just empty) is an error, e.g. a diff of "" would be the whole repo.
func need(q url.Values, key string) (string, error) {
	if !q.Has(key) {
		return "", fmt.Errorf("missing %s", key)
	}
	return q.Get(key), nil
}

// Handler is the whole HTTP surface: localhost only unless --net, since this endpoint runs Claude Code with
// your permissions (with --net, netAuthorized gates the network address with config.NetToken instead).
func Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header() // no other site may frame the page and click through its approvals
		h.Set("Content-Security-Policy", "frame-ancestors 'none'")
		h.Set("X-Frame-Options", "DENY")
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

type routeFunc func(url.Values) (any, int, error)

func ok(body any, err error) (any, int, error) {
	if err != nil {
		return nil, 0, err
	}
	return body, 200, nil
}

var getRoutes = map[string]routeFunc{
	"/api/info": func(q url.Values) (any, int, error) {
		return map[string]any{"root": config.Root, "version": config.Version}, 200, nil
	},
	"/api/version": func(q url.Values) (any, int, error) {
		info, _ := update.Check() // offline: no newer release to offer, which is the right answer
		return info, 200, nil
	},
	"/api/update/progress": func(q url.Values) (any, int, error) {
		got, total := update.Progress()
		return map[string]int64{"got": got, "total": total}, 200, nil
	},
	"/api/tree": func(q url.Values) (any, int, error) { return ok(filesx.Tree(q.Get("path"))) },
	"/api/file": func(q url.Values) (any, int, error) {
		p, err := need(q, "path")
		if err != nil {
			return nil, 0, err
		}
		return ok(filesx.Get(p))
	},
	"/api/git":       gitRoute,
	"/api/git/repos": func(q url.Values) (any, int, error) { return gitx.NonNil(gitx.Repos()), 200, nil },
	"/api/git/diff": func(q url.Values) (any, int, error) {
		p, err := need(q, "path")
		if err != nil {
			return nil, 0, err
		}
		return ok(gitx.GitDiff(q.Get("repo"), p, q.Get("staged") == "1"))
	},
	"/api/git/show": func(q url.Values) (any, int, error) {
		h, err := need(q, "hash")
		if err != nil {
			return nil, 0, err
		}
		return ok(gitx.GitShow(q.Get("repo"), h))
	},
	"/api/git/blob": func(q url.Values) (any, int, error) {
		p, err := need(q, "path")
		if err != nil {
			return nil, 0, err
		}
		return ok(gitx.Blob(q.Get("repo"), q.Get("rev"), p, q.Get("top") == "1")) // top: a commit's paths, from the repo's top
	},
	"/api/gh/blob": func(q url.Values) (any, int, error) {
		p, err := need(q, "path")
		if err != nil {
			return nil, 0, err
		}
		ref, err := need(q, "ref") // none would read the index, not the pull request's head
		if err != nil {
			return nil, 0, err
		}
		return ok(github.Blob(q.Get("repo"), ref, p))
	},
	"/api/files":     func(q url.Values) (any, int, error) { return filesx.Find(q.Get("q"), 40), 200, nil },
	"/api/symbols":   symbolsRoute,
	"/api/refs":      refsRoute,
	"/api/meta":      func(q url.Values) (any, int, error) { return live.Meta(q.Get("backend")), 200, nil },
	"/api/sessions":  func(q url.Values) (any, int, error) { return allSessions(), 200, nil },
	"/api/agents":    func(q url.Values) (any, int, error) { return agents(), 200, nil },
	"/api/prefs":     func(q url.Values) (any, int, error) { return prefsAnswer(prefs.Load()), 200, nil },
	"/api/session":   sessionRoute,
	"/api/gh":        func(q url.Values) (any, int, error) { return github.State(q.Get("repo")), 200, nil },
	"/api/gh/prs":    func(q url.Values) (any, int, error) { return ok(github.Prs(q.Get("repo"), ghList(q))) },
	"/api/gh/issues": func(q url.Values) (any, int, error) { return ok(github.Issues(q.Get("repo"), ghList(q))) },
	"/api/gh/checks": func(q url.Values) (any, int, error) { return ok(github.PrChecks(q.Get("repo"), q.Get("n"))) },
	"/api/gh/runs":   func(q url.Values) (any, int, error) { return ok(github.Runs(q.Get("repo"), q.Get("limit"))) },
	"/api/gh/labels": func(q url.Values) (any, int, error) { return ok(github.Labels(q.Get("repo"))) },
	"/api/gh/me":     func(q url.Values) (any, int, error) { return ok(github.Me(q.Get("repo"))) },
	"/api/gh/pr":     func(q url.Values) (any, int, error) { return ok(github.Pr(q.Get("repo"), q.Get("n"))) },
	"/api/gh/issue":  func(q url.Values) (any, int, error) { return ok(github.Issue(q.Get("repo"), q.Get("n"))) },
	"/api/gh/log":    func(q url.Values) (any, int, error) { return ok(github.Log(q.Get("repo"), q.Get("url"))) },
}

// prefsAnswer is your settings, and why ~/.drawa/config.json couldn't be read or saved when it couldn't, for the
// page to say (a broken hand edit: the defaults apply meanwhile).
func prefsAnswer(p map[string]any, err error) map[string]any {
	out := map[string]any{"prefs": p}
	if err != nil {
		out["error"] = err.Error()
	}
	return out
}

// symbolsRoute is code definitions: ?q= fuzzy by name (Ctrl+K), ?def= exactly this name (a diff's go to
// definition), or neither: whether universal-ctags is installed (the Settings panel says). Lookups are empty when
// it isn't, or when your settings turn symbols off.
func symbolsRoute(q url.Values) (any, int, error) {
	if !q.Has("q") && !q.Has("def") {
		return map[string]any{"installed": symbols.Installed(), "install": symbols.Install()}, 200, nil
	}
	if p, _ := prefs.Load(); p["symbols"] == "off" {
		return []symbols.Symbol{}, 200, nil
	}
	if q.Has("def") {
		return symbols.Exact(q.Get("def"), 50), 200, nil
	}
	return symbols.Fuzzy(q.Get("q"), 40), 200, nil
}

func ghList(q url.Values) github.List {
	return github.ListArgs(cmp.Or(q.Get("state"), "open"), q.Get("q"), q.Get("filter"), q.Get("limit"))
}

var agentIDRe = regexp.MustCompile(`^[\w-]{1,100}$`)

// agents describes the registered backends for the page's menus: which are installed, their modes, and whether
// they can write commit messages (Write with).
func agents() []map[string]any {
	out := []map[string]any{}
	for _, name := range live.Names() {
		k, _ := live.Lookup(name)
		_, err := exec.LookPath(k.Bin)
		modes := []string{}
		for m := range k.Modes {
			modes = append(modes, m)
		}
		sort.Strings(modes)
		out = append(out, map[string]any{"name": name, "title": k.Title, "blurb": k.Blurb, "installed": err == nil, "install": k.Install,
			"modes": modes, "canWrite": k.OneShot != nil, "canUnsend": k.Unsend, "resume": k.Resume, "noEffort": k.NoEffort, "textOnly": k.TextOnly})
	}
	return out
}

// allSessions is every backend's history list, newest first, each entry tagged with its backend.
// ponytail: each list is its newest 50, and so is the merged one; paginate if needed.
func allSessions() []sessions.Info {
	out := []sessions.Info{}
	for _, name := range live.Names() {
		k, _ := live.Lookup(name)
		if k.History == nil {
			continue
		}
		for _, s := range k.History.List() {
			s.Backend = name
			out = append(out, s)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Mtime > out[j].Mtime })
	return out[:min(len(out), 50)]
}

// sessionRoute is one saved session (?id=, ?backend=, optionally one sub-agent's ?agent=).
func sessionRoute(q url.Values) (any, int, error) {
	k, known := live.Lookup(q.Get("backend"))
	sid := q.Get("id")
	if !known || k.History == nil || !k.SidOK(sid) {
		return map[string]any{"error": "bad session id"}, 404, nil
	}
	agent := q.Get("agent")
	if agent != "" && !agentIDRe.MatchString(agent) {
		return map[string]any{"error": "bad agent id"}, 404, nil
	}
	if msgs, ok := k.History.Load(sid, agent); ok {
		return msgs, 200, nil
	}
	// a 404 like any missing session, but `missing` tells the page this one is expected to appear
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

func doGET(w http.ResponseWriter, r *http.Request) {
	if !config.Hosts[r.Host] { // DNS rebinding would otherwise expose your files
		http.Error(w, "", 403)
		return
	}
	if !netAuthorized(w, r) {
		return
	}
	path := r.URL.Path
	// another site's <img>/<link> can still send a GET here, and some of these start git or gh
	if strings.HasPrefix(path, "/api/") && r.Header.Get("Sec-Fetch-Site") == "cross-site" {
		http.Error(w, "", 403)
		return
	}
	q := r.URL.Query()
	if path == "/api/events" {
		streamEvents(w, r)
		return
	}
	if strings.HasPrefix(path, "/mcp/") {
		http.Error(w, "", 405) // the canvas MCP server has no server-to-client stream
		return
	}
	if !strings.HasPrefix(path, "/api/") {
		static(w, r)
		return
	}
	if key, isImage := strings.CutPrefix(path, "/api/images/"); isImage && images.HashRe.MatchString(key) {
		serveImage(w, r, key)
		return
	}
	if path == "/api/raw" {
		serveRaw(w, r, q.Get("path"))
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

func serveImage(w http.ResponseWriter, r *http.Request, key string) {
	data, err := os.ReadFile(filepath.Join(images.Store_, key))
	if err != nil {
		http.Error(w, "", 404)
		return
	}
	w.Header().Set("Content-Type", cmp.Or(images.Type(data), "application/octet-stream"))
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable") // named by its hash: never changes
	http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(data))
}

// rawTypes: only pictures, set by extension rather than sniffed, so /api/raw can't serve the project's HTML as a page.
var rawTypes = map[string]string{
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
	".svg": "image/svg+xml", ".avif": "image/avif", ".bmp": "image/bmp", ".ico": "image/x-icon",
}

const rawMax = 20 << 20

// serveRaw serves a project picture's bytes for an <img>.
func serveRaw(w http.ResponseWriter, r *http.Request, rel string) {
	ctype, isImage := rawTypes[strings.ToLower(filepath.Ext(rel))]
	if !isImage {
		http.Error(w, "", 415)
		return
	}
	f, info, err := filesx.Open(rel)
	if err != nil {
		http.Error(w, "", 404)
		return
	}
	defer f.Close()
	if info.Size() > rawMax {
		http.Error(w, "", 413)
		return
	}
	h := w.Header()
	h.Set("Content-Type", ctype)
	h.Set("X-Content-Type-Options", "nosniff")
	// an SVG from a cloned repo opened directly would otherwise run its script on our origin
	h.Set("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'")
	h.Set("Cache-Control", "no-cache") // the file may change on disk; ServeContent revalidates by mtime
	http.ServeContent(w, r, "", info.ModTime(), f)
}

var errNoUI = errors.New("UI not built: run `npm install && npm run build` in web/")

func static(w http.ResponseWriter, r *http.Request) {
	rel := strings.TrimPrefix(r.URL.Path, "/")
	if rel == "" {
		rel = "index.html"
	}
	data, mod, err := readAsset(rel)
	if errors.Is(err, errNoUI) {
		http.Error(w, err.Error(), 503)
		return
	}
	if err != nil {
		http.Error(w, "", 404)
		return
	}
	h := w.Header()
	switch {
	case strings.HasPrefix(rel, "assets/"): // Vite names these by content hash
		h.Set("Cache-Control", "public, max-age=31536000, immutable")
	case rel == "index.html": // always revalidated, so a rebuild's new asset names are picked up
		h.Set("Cache-Control", "no-cache")
	}
	h.Set("Content-Type", cmp.Or(mime.TypeByExtension(filepath.Ext(rel)), "application/octet-stream"))
	if compressible[filepath.Ext(rel)] {
		h.Add("Vary", "Accept-Encoding")
		// ponytail: compressed on every miss, and "gzip;q=0" counts as yes; the immutable cache makes misses rare
		if strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
			var buf bytes.Buffer
			zw := gzip.NewWriter(&buf)
			zw.Write(data)
			zw.Close()
			data = buf.Bytes()
			h.Set("Content-Encoding", "gzip")
		}
	}
	http.ServeContent(w, r, rel, mod, bytes.NewReader(data))
}

var compressible = map[string]bool{".js": true, ".css": true, ".json": true, ".html": true, ".svg": true, ".map": true}

// readAsset reads a built UI file from web/dist, or else from the copy embedded at release-build time (a
// standalone binary run outside its source tree). embed.FS rejects traversal itself; the disk path is checked here.
func readAsset(rel string) ([]byte, time.Time, error) {
	if info, err := os.Stat(config.Dist); err != nil || !info.IsDir() {
		if !webassets.Available() {
			return nil, time.Time{}, errNoUI
		}
		data, err := webassets.Dist.ReadFile(path.Join("dist", rel))
		return data, time.Time{}, err
	}
	f := filepath.Clean(filepath.Join(config.Dist, rel))
	if f != config.Dist && !strings.HasPrefix(f, config.Dist+string(filepath.Separator)) {
		return nil, time.Time{}, os.ErrNotExist
	}
	fi, err := os.Stat(f)
	if err != nil || !fi.Mode().IsRegular() {
		return nil, time.Time{}, os.ErrNotExist
	}
	data, err := os.ReadFile(f)
	return data, fi.ModTime(), err
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
	if !netAuthorized(w, r) {
		return
	}
	// a <form> that got through rendered markdown posts from our own Origin, but can only send form or text bodies
	if mt, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type")); mt != "application/json" {
		http.Error(w, "", http.StatusUnsupportedMediaType)
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
	case "/api/update":
		if err := update.Install(); err != nil {
			sendJSON(w, map[string]any{"error": err.Error()}, 502)
			return
		}
		sendJSON(w, map[string]any{"ok": true, "working": live.Working()}, 200) // what "Restart now" would stop
		return
	case "/api/update/restart":
		restartNow(w)
		return
	case "/api/prefs":
		p, err := prefs.Set(body)
		switch {
		case errors.Is(err, prefs.ErrInvalid):
			sendJSON(w, map[string]any{"error": err.Error()}, 400)
		case err != nil:
			sendJSON(w, map[string]any{"error": err.Error()}, 500)
		default:
			sendJSON(w, map[string]any{"prefs": p}, 200)
		}
		return
	case "/api/file":
		if err := filesx.Save(str(body["path"]), str(body["base"]), str(body["text"])); err != nil {
			sendJSON(w, map[string]any{"error": err.Error()}, saveStatus(err))
		} else {
			sendJSON(w, map[string]any{"ok": true}, 200)
		}
		return
	case "/api/git":
		out, err := gitx.GitOp(body)
		if err != nil {
			msg := "path outside project folder"
			if errors.Is(err, gitx.ErrNoRepo) {
				msg = err.Error()
			}
			sendJSON(w, map[string]any{"ok": false, "out": msg}, 403)
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

// restartNow answers, then execs the update Install put on disk. The page asked after being told what a restart
// stops, so there's no second check here.
func restartNow(w http.ResponseWriter) {
	if !update.Pending() {
		sendJSON(w, map[string]any{"error": "no update is installed"}, 409)
		return
	}
	sendJSON(w, map[string]any{"ok": true}, 200)
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}
	go func() {
		time.Sleep(300 * time.Millisecond) // let the answer reach the page first
		update.Restart()
	}()
}

// saveStatus: 409 tells the page its copy is stale (it then checks whether its save landed after all); 403 is a
// file it may not write; 404 one that's gone; 413 text too big to open again; anything else went wrong on the way.
func saveStatus(err error) int {
	switch {
	case errors.Is(err, filesx.ErrChanged):
		return 409
	case errors.Is(err, config.ErrOutside), errors.Is(err, filesx.ErrReadOnly), errors.Is(err, os.ErrPermission):
		return 403
	case errors.Is(err, os.ErrNotExist):
		return 404 // deleted since it was opened
	case errors.Is(err, filesx.ErrTooBig):
		return 413
	}
	return 500
}

// refsRoute is where a name is used; more: the list stops before the last of them.
func refsRoute(q url.Values) (any, int, error) {
	refs, more := gitx.Refs(q.Get("name"))
	return map[string]any{"refs": refs, "more": more}, 200, nil
}

// gitRoute is the shared git status; fresh=1 (the Git window's refresh button) reads it all again first.
func gitRoute(q url.Values) (any, int, error) {
	if q.Get("fresh") == "1" {
		gitx.Fresh()
	}
	return gitx.GitState(), 200, nil
}
