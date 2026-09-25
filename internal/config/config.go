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

// Inside resolves rel against Root and refuses anything that escapes it.
func Inside(rel string) (string, error) {
	joined := filepath.Clean(filepath.Join(Root, rel))
	abs, err := filepath.Abs(joined)
	if err != nil {
		return "", err
	}
	resolved := abs
	if r, err := filepath.EvalSymlinks(abs); err == nil {
		resolved = r
	} // doesn't exist yet: fall back to the cleaned path for the containment check
	if resolved != Root && !strings.HasPrefix(resolved, Root+string(filepath.Separator)) {
		return "", ErrOutside
	}
	return resolved, nil
}
