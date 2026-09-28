package codex

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"drawa/internal/config"
)

// errPath: without the folder in the overrides Codex would read an untrusted clone's settings (and save a trust
// entry), so a path TOML can't hold stops the call instead of going without them.
var errPath = errors.New("Codex can't be given this folder's path")

// projectArgs says whether Codex may read the project's own settings. An untrusted clone gets no AGENTS.md and
// its folder marked untrusted, so its .codex/config.toml is ignored. Marking the folder either way in the
// overrides also stops Codex from saving a trust entry for it in the user's ~/.codex/config.toml, which it
// otherwise does when a thread starts with a writable sandbox.
func projectArgs() ([]string, error) {
	root, ok := tomlString(config.Root)
	if !ok {
		return nil, errPath
	}
	if config.Untrusted() {
		return []string{"-c", "project_doc_max_bytes=0", "-c", "projects={" + root + "={trust_level=\"untrusted\"}}"}, nil
	}
	return []string{"-c", "projects={" + root + "={trust_level=\"trusted\"}}"}, nil
}

// tomlString is s as a TOML basic string (Go's quoting differs: \x escapes, which TOML lacks). False for invalid
// UTF-8, which TOML can't hold at all.
func tomlString(s string) (string, bool) {
	if !utf8.ValidString(s) {
		return "", false
	}
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch {
		case r == '"' || r == '\\':
			b.WriteByte('\\')
			b.WriteRune(r)
		case r < 0x20 || r == 0x7f:
			fmt.Fprintf(&b, `\u%04X`, r)
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
	return b.String(), true
}

// policy is Codex's approval policy and sandbox for a Drawa mode. acceptEdits asks like default; the backend
// answers its file-change asks inside the project itself. Plan never asks: an approved command would run outside
// the read-only sandbox.
func policy(mode string) (approval string, sandbox string, sandboxPolicy map[string]any) {
	switch mode {
	case "bypassPermissions":
		return "never", "danger-full-access", map[string]any{"type": "dangerFullAccess"}
	case "plan":
		return "never", "read-only", map[string]any{"type": "readOnly"}
	}
	return "untrusted", "workspace-write", map[string]any{"type": "workspaceWrite"}
}

// guarded are the folders Codex's sandbox keeps read-only inside a writable project; auto-accepting a change there
// would get round it.
var guarded = map[string]bool{".git": true, ".codex": true, ".agents": true, ".claude": true}

// inProject: every file a change touches (and moves to) is inside the project, and outside its guarded folders
// (acceptEdits doesn't reach past what the sandbox would allow).
func (s *server) inProject(item string) bool {
	n := 0
	for id, c := range s.tr.Calls {
		if id != item && !strings.HasPrefix(id, item+"#") {
			continue
		}
		path, _ := c.Input["file_path"].(string)
		move, _ := c.Input["move_path"].(string)
		if path == "" || !editable(path) || move != "" && !editable(move) {
			return false
		}
		n++
	}
	return n > 0
}

// editable: inside the project and in none of its guarded folders. Checked on the resolved path, relative to the
// root, so a symlink can't hide a .git and a project that itself sits under ~/.claude still works.
func editable(path string) bool {
	abs, err := config.Inside(path)
	if err != nil {
		return false
	}
	rel, err := filepath.Rel(config.Root, abs)
	if err != nil {
		return false
	}
	for _, part := range strings.Split(rel, string(os.PathSeparator)) {
		if guarded[strings.ToLower(part)] { // case-insensitive filesystems (macOS) would let .GIT through
			return false
		}
	}
	return true
}
