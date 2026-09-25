// Package gitx wraps the git CLI: the plain runner, status/diff for the Git window, and the write operations
// (stage, commit, push, ...).
package gitx

import (
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"claude-ui/internal/config"
	"claude-ui/internal/procx"
)

type Opts struct {
	Timeout time.Duration
	Stdin   string
}

// Git runs git in the project; returns (ok, output). Paths always come after `--` (never read as options).
func Git(args ...string) (bool, string) { return GitOpts(Opts{}, args...) }

func GitOpts(o Opts, args ...string) (bool, string) {
	if o.Timeout == 0 {
		o.Timeout = 30 * time.Second
	}
	r, err := procx.Run(o.Timeout, o.Stdin, append([]string{"git"}, args...)...)
	if err != nil {
		return false, err.Error()
	}
	if r.Code == 0 {
		return true, strings.Trim(r.Stdout, "\n")
	}
	out := r.Stderr
	if out == "" {
		out = r.Stdout
	}
	return false, strings.Trim(out, "\n")
}

var stateCache = struct {
	sync.Mutex
	at    time.Time
	state map[string]any
}{}

// GitState is git_status(), shared by every page for a few seconds: each open Git window polls it.
func GitState() map[string]any {
	stateCache.Lock()
	defer stateCache.Unlock()
	if stateCache.state == nil || time.Since(stateCache.at) > 3*time.Second {
		stateCache.state = gitStatus()
		stateCache.at = time.Now()
	}
	return stateCache.state
}

const GitFiles = 500 // files listed in the Git window; the rest are counted

var aheadRe = regexp.MustCompile(`ahead (\d+)`)
var behindRe = regexp.MustCompile(`behind (\d+)`)

// gitStatus reports branch, ahead/behind, changed files (staged / unstaged / untracked with line counts), and
// recent commits.
func gitStatus() map[string]any {
	ok, out := Git("status", "--porcelain=v1", "-b", "-z", "--untracked-files=all")
	if !ok {
		return map[string]any{"repo": false, "error": out}
	}
	entries := strings.Split(out, "\x00")
	head := ""
	if len(entries) > 0 && strings.HasPrefix(entries[0], "## ") {
		head = entries[0][3:]
	}
	branch := strings.Replace(strings.SplitN(head, "...", 2)[0], "No commits yet on ", "", 1)
	ahead, behind := 0, 0
	if m := aheadRe.FindStringSubmatch(head); m != nil {
		ahead, _ = strconv.Atoi(m[1])
	}
	if m := behindRe.FindStringSubmatch(head); m != nil {
		behind, _ = strconv.Atoi(m[1])
	}
	type fileRow struct {
		Path             string
		X, Y             string
		Staged, Unstaged [2]int
	}
	var files []*fileRow
	for i := 1; i < len(entries); i++ {
		e := entries[i]
		if len(e) < 4 {
			continue
		}
		x, y, path := string(e[0]), string(e[1]), e[3:]
		if x == "R" || x == "C" {
			i++ // the rename's old path follows
		}
		files = append(files, &fileRow{Path: path, X: x, Y: y})
	}
	type key struct {
		path   string
		staged bool
	}
	counts := map[key][2]int{}
	for _, staged := range []bool{true, false} {
		diffArgs := []string{"diff", "--numstat"}
		if staged {
			diffArgs = append(diffArgs, "--cached")
		}
		ok, out := Git(diffArgs...)
		if !ok {
			continue
		}
		for _, line := range strings.Split(out, "\n") {
			if line == "" {
				continue
			}
			parts := strings.SplitN(line, "\t", 3)
			for len(parts) < 3 {
				parts = append(parts, "")
			}
			a, d, path := parts[0], parts[1], parts[2]
			path = strings.TrimSuffix(strings.Split(path, " => ")[len(strings.Split(path, " => "))-1], "}")
			ai, _ := strconv.Atoi(a)
			di, _ := strconv.Atoi(d)
			counts[key{path, staged}] = [2]int{ai, di}
		}
	}
	for _, f := range files {
		f.Staged = counts[key{f.Path, true}]
		f.Unstaged = counts[key{f.Path, false}]
	}
	ok, out = Git("log", "-n", "12", "--pretty=format:%h\x1f%s\x1f%cr\x1f%an")
	var log []map[string]string
	if ok {
		for _, line := range strings.Split(out, "\n") {
			if line == "" {
				continue
			}
			p := strings.Split(line, "\x1f")
			for len(p) < 4 {
				p = append(p, "")
			}
			log = append(log, map[string]string{"hash": p[0], "subject": p[1], "when": p[2], "author": p[3]})
		}
	}
	fileList := make([]map[string]any, 0, len(files))
	shown := files
	if len(shown) > GitFiles {
		shown = shown[:GitFiles]
	}
	for _, f := range shown {
		fileList = append(fileList, map[string]any{
			"path": f.Path, "x": f.X, "y": f.Y,
			"staged": []int{f.Staged[0], f.Staged[1]}, "unstaged": []int{f.Unstaged[0], f.Unstaged[1]},
		})
	}
	if branch == "" {
		branch = "(detached)"
	}
	return map[string]any{
		"repo": true, "branch": branch, "upstream": strings.Contains(head, "..."),
		"ahead": ahead, "behind": behind, "files": fileList, "total": len(files), "log": nonNil(log),
	}
}

func nonNil(log []map[string]string) []map[string]string {
	if log == nil {
		return []map[string]string{}
	}
	return log
}

func GitDiff(rel string, staged bool) (map[string]any, error) {
	if _, err := config.Inside(rel); err != nil {
		return nil, err
	}
	args := []string{"diff"}
	if staged {
		args = append(args, "--cached")
	}
	args = append(args, "--", rel)
	ok, out := Git(args...)
	if ok && out == "" && !staged { // untracked: show the whole file as added
		_, out = Git("diff", "--no-index", "--", "/dev/null", rel) // --no-index exits 1 when files differ
	}
	if len(out) > 400_000 {
		out = out[:400_000]
	}
	return map[string]any{"diff": out}, nil
}

// GitMessage writes a commit message for the staged changes, via a one-off Claude call.
func GitMessage() map[string]any {
	ok, diff := Git("diff", "--cached", "--stat", "--patch")
	if !ok || strings.TrimSpace(diff) == "" {
		return map[string]any{"error": "Nothing staged to describe."}
	}
	prompt := "Write a git commit message for this staged diff. First line: imperative summary under 70 characters. " +
		"Then a blank line and a short body only if the change needs explaining. Reply with the message only, no code fences."
	if len(diff) > 80_000 {
		diff = diff[:80_000]
	}
	ok, out := procx.Haiku(prompt, diff)
	if !ok {
		return map[string]any{"error": out}
	}
	return map[string]any{"message": out}
}

// GitOp carries out a write operation from the Git window (stage/unstage/commit/push/pull/init/message).
func GitOp(body map[string]any) (map[string]any, error) {
	stateCache.Lock()
	stateCache.state = nil // whatever it does, the next status is fresh
	stateCache.Unlock()
	op, _ := body["op"].(string)
	var paths []string
	if raw, ok := body["paths"].([]any); ok {
		for _, p := range raw {
			if s, ok := p.(string); ok {
				paths = append(paths, s)
			}
		}
	}
	for _, p := range paths {
		if _, err := config.Inside(p); err != nil {
			return nil, err
		}
	}
	var ok bool
	var out string
	switch op {
	case "stage":
		if len(paths) > 0 {
			ok, out = Git(append([]string{"add", "--"}, paths...)...)
		} else {
			ok, out = Git("add", "-A")
		}
	case "unstage":
		if len(paths) > 0 {
			ok, out = Git(append([]string{"restore", "--staged", "--"}, paths...)...)
		} else {
			ok, out = Git("reset", "-q")
		}
	case "commit":
		msg := strings.TrimSpace(anyToStr(body["message"]))
		if msg == "" {
			return map[string]any{"ok": false, "out": "Write a commit message first."}, nil
		}
		ok, out = GitOpts(Opts{Stdin: msg}, "commit", "-F", "-")
	case "push":
		ok, out = GitOpts(Opts{Timeout: 120 * time.Second}, "push")
		if !ok && strings.Contains(out, "no upstream") {
			ok, out = GitOpts(Opts{Timeout: 120 * time.Second}, "push", "-u", "origin", "HEAD")
		}
	case "pull":
		ok, out = GitOpts(Opts{Timeout: 120 * time.Second}, "pull", "--ff-only")
	case "init":
		ok, out = Git("init")
	case "message":
		return GitMessage(), nil
	default:
		return map[string]any{"ok": false, "out": "unknown op " + op}, nil
	}
	if len(out) > 4000 {
		out = out[len(out)-4000:]
	}
	return map[string]any{"ok": ok, "out": out}, nil
}

func anyToStr(v any) string {
	s, _ := v.(string)
	return s
}
