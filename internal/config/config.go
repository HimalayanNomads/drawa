// Package config holds paths and constants shared by the rest of the server, and Inside() (the path-safety
// check every file route uses).
package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
)

const Port = 8765

// Repo is this module's root: where main.go and web/ live. runtime.Caller embeds the build-time source path,
// so this resolves correctly whether launched via `go run` or a built binary, as long as the source tree hasn't
// moved since the binary was built (true here: the restart-on-change loop always rebuilds before re-exec'ing).
var Repo = repoRoot()

func repoRoot() string {
	_, thisFile, _, _ := runtime.Caller(0) // .../internal/config/config.go
	dir, err := filepath.Abs(filepath.Join(filepath.Dir(thisFile), "..", ".."))
	if err != nil {
		dir = "."
	}
	return dir
}

var Dist = filepath.Join(Repo, "web", "dist")

// Root is the project folder Claude works in: argv[1], default the current folder.
var Root = rootDir()

func rootDir() string {
	arg := "."
	if len(os.Args) > 1 {
		arg = os.Args[1]
	}
	abs, err := filepath.Abs(arg)
	if err != nil {
		abs = arg
	}
	if resolved, err := filepath.EvalSymlinks(abs); err == nil {
		abs = resolved
	}
	return abs
}

var nonAlnum = regexp.MustCompile(`[^A-Za-z0-9]`)

// Sessions is where Claude Code stores this project's transcripts: path mangled to dashes, one char at a time
// (must match the CLI's own mangling exactly, so `re.sub` semantics: no collapsing runs of separators).
var Sessions = filepath.Join(sessionsBase(), "projects", nonAlnum.ReplaceAllString(Root, "-"))

func sessionsBase() string {
	if v := os.Getenv("CLAUDE_CONFIG_DIR"); v != "" {
		return v
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".claude")
}

var Modes = map[string]bool{
	"default": true, "acceptEdits": true, "auto": true, "plan": true, "bypassPermissions": true,
}

var Hosts = map[string]bool{
	fmt.Sprintf("127.0.0.1:%d", Port): true,
	fmt.Sprintf("localhost:%d", Port): true,
}

// + the Vite dev server, which proxies to us
var Origins = mergeOrigins()

func mergeOrigins() map[string]bool {
	m := map[string]bool{"127.0.0.1:5173": true, "localhost:5173": true}
	for k := range Hosts {
		m[k] = true
	}
	return m
}

var UUIDRe = regexp.MustCompile(`^[0-9a-f-]{36}$`)

// live Claude processes with no traffic for this long are closed (the next message resumes them)
const IdleSecs = 30 * 60

// This UI renders Mermaid; models often name a node "graph", which Mermaid rejects.
const SystemNote = `Replies are shown in a web UI that renders Markdown and Mermaid. In Mermaid diagrams never use keywords (graph, end, subgraph, flowchart, class, style, click) as node ids; e.g. write graphMod["graph.ts"].`

var ErrOutside = errors.New("outside project folder")

// Inside resolves rel against Root and refuses anything that escapes it. Like Python's (ROOT / rel).resolve(),
// an absolute rel stands alone (so it's only accepted when it already lies inside Root).
func Inside(rel string) (string, error) {
	p := rel
	if !filepath.IsAbs(p) {
		p = filepath.Join(Root, rel)
	}
	resolved, err := resolve(filepath.Clean(p))
	if err != nil {
		return "", err
	}
	// Rel, not a string prefix: /root2 isn't inside /root, and everything is inside Root == "/"
	if r, err := filepath.Rel(Root, resolved); err != nil || r == ".." || strings.HasPrefix(r, ".."+string(filepath.Separator)) {
		return "", ErrOutside
	}
	return resolved, nil
}

// resolve follows symlinks in p even when its leaf doesn't exist yet: the deepest existing ancestor is resolved
// and the rest re-appended, so lnk/new with lnk -> /etc resolves to /etc/new.
func resolve(p string) (string, error) {
	tail := ""
	for {
		if r, err := filepath.EvalSymlinks(p); err == nil {
			return filepath.Join(r, tail), nil
		}
		if _, err := os.Lstat(p); err == nil { // exists but won't resolve: a dangling or looping link
			return "", ErrOutside
		}
		parent := filepath.Dir(p)
		if parent == p {
			return filepath.Join(p, tail), nil
		}
		tail = filepath.Join(filepath.Base(p), tail)
		p = parent
	}
}
