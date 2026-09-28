// Package gitx wraps the git CLI: the plain runner, status/diff for the Git window, and the write operations
// (stage, commit, push, ...).
package gitx

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"drawa/internal/config"
	"drawa/internal/live"
	"drawa/internal/procx"
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
	env, argv := command(args)
	r, err := procx.RunEnv(o.Timeout, o.Stdin, env, argv...)
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

// command is the env and argv for every git call Drawa makes.
func command(args []string) (env, argv []string) {
	// literal pathspecs: a page-supplied ":/x" would otherwise name a file from the repo's top, outside Root
	env = append(os.Environ(), "GIT_LITERAL_PATHSPECS=1")
	argv = []string{"git"}
	if config.Cloned {
		// a blobless clone fetches old blobs on demand (diff, blame): with nobody at Drawa's terminal to answer, a
		// credential prompt would hang the Git window until the timeout, so fail at once instead
		env = append(env, "GIT_TERMINAL_PROMPT=0", "GIT_ASKPASS=", "SSH_ASKPASS=", "SSH_ASKPASS_REQUIRE=never")
		argv = append(argv, "-c", "credential.interactive=false")
	}
	if config.Untrusted() {
		// the agent may be talked into editing .git/config, and the Git window polls status with no approval: turn off
		// the repo-local settings that run commands (credential.helper= drops the helper list, the user's own too)
		argv = append(argv, "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null",
			"-c", "credential.helper=", "-c", "core.sshCommand=ssh -o BatchMode=yes")
		if len(args) > 0 && (args[0] == "diff" || args[0] == "log") { // diff drivers and textconv from .gitattributes
			args = append([]string{args[0], "--no-ext-diff", "--no-textconv"}, args[1:]...)
		}
	}
	return env, append(argv, args...)
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

type fileRow struct {
	Path             string
	X, Y             string
	Staged, Unstaged [2]int
}

// parseStatus reads `git status --porcelain=v1 -b -z` -> the branch line and the changed files. Porcelain paths are
// relative to the repo's top even when git runs in a subfolder: prefix (`rev-parse --show-prefix`) is cut off so
// they're relative to Root like every other path the page sends back, and anything outside Root is left out.
func parseStatus(out, prefix string) (head string, files []*fileRow) {
	entries := strings.Split(out, "\x00")
	if len(entries) > 0 && strings.HasPrefix(entries[0], "## ") {
		head = entries[0][3:]
	}
	for i := 1; i < len(entries); i++ {
		e := entries[i]
		if len(e) < 4 {
			continue
		}
		x, y, path := string(e[0]), string(e[1]), e[3:]
		if x == "R" || x == "C" {
			i++ // the rename's old path follows
		}
		if !strings.HasPrefix(path, prefix) {
			continue
		}
		files = append(files, &fileRow{Path: path[len(prefix):], X: x, Y: y})
	}
	return head, files
}

// parseNumstat reads `git diff --numstat -z` -> added/deleted per (new) path. A rename is "a\td\t\0old\0new\0";
// -z keeps paths raw (no quoting, no "{a => b}"), so they match status's.
func parseNumstat(out string) map[string][2]int {
	counts := map[string][2]int{}
	tok := strings.Split(out, "\x00")
	for i := 0; i < len(tok); i++ {
		parts := strings.SplitN(tok[i], "\t", 3)
		if len(parts) < 3 {
			continue
		}
		path := parts[2]
		if path == "" && i+2 < len(tok) {
			path = tok[i+2]
			i += 2
		}
		a, _ := strconv.Atoi(parts[0]) // "-" for binary files: 0
		d, _ := strconv.Atoi(parts[1])
		counts[path] = [2]int{a, d}
	}
	return counts
}

var prefixCache = struct {
	sync.Mutex
	val string
	ok  bool
}{}

// prefix is Root's place in its repo ("" at the top, "sub/dir/" below it). Cached once known: Root never moves.
func prefix() string {
	prefixCache.Lock()
	defer prefixCache.Unlock()
	if !prefixCache.ok {
		if ok, out := Git("rev-parse", "--show-prefix"); ok {
			prefixCache.val, prefixCache.ok = out, true
		}
	}
	return prefixCache.val
}

// gitStatus reports branch, ahead/behind, changed files (staged / unstaged / untracked with line counts), and
// recent commits.
func gitStatus() map[string]any {
	if _, err := exec.LookPath("git"); err != nil { // not "no repo": the Git window mustn't offer a git init that can't run
		return map[string]any{"repo": false, "missing": true, "error": "git isn't installed. Get it from https://git-scm.com/downloads, then reopen this window."}
	}
	// "normal", not "all": an untracked folder is one row, not a walk through every file in it (polled every few seconds)
	ok, out := Git("status", "--porcelain=v1", "-b", "-z", "--untracked-files=normal", "--", ".")
	if !ok {
		return map[string]any{"repo": false, "error": out}
	}
	head, files := parseStatus(out, prefix())
	branch := strings.Replace(strings.SplitN(head, "...", 2)[0], "No commits yet on ", "", 1)
	ahead, behind := 0, 0
	if m := aheadRe.FindStringSubmatch(head); m != nil {
		ahead, _ = strconv.Atoi(m[1])
	}
	if m := behindRe.FindStringSubmatch(head); m != nil {
		behind, _ = strconv.Atoi(m[1])
	}
	// line counts only for the sides that have changes: each is a full diff
	var anyStaged, anyUnstaged bool
	for _, f := range files {
		anyStaged = anyStaged || (f.X != " " && f.X != "?")
		anyUnstaged = anyUnstaged || (f.Y != " " && f.X != "?")
	}
	numstat := func(want bool, extra ...string) map[string][2]int {
		if !want {
			return nil
		}
		if ok, out := Git(append([]string{"diff", "--numstat", "-z", "--relative"}, extra...)...); ok {
			return parseNumstat(out)
		}
		return nil
	}
	staged, unstaged := numstat(anyStaged, "--cached"), numstat(anyUnstaged)
	for _, f := range files {
		f.Staged, f.Unstaged = staged[f.Path], unstaged[f.Path]
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
		"ahead": ahead, "behind": behind, "files": fileList, "total": len(files), "log": NonNil(log),
	}
}

// NonNil turns a nil list into an empty one, so it's [] in JSON rather than null.
func NonNil[T any](s []T) []T {
	if s == nil {
		return []T{}
	}
	return s
}

const diffMax = 400_000

func GitDiff(rel string, staged bool) (map[string]any, error) {
	rel, err := rootRel(rel)
	if err != nil {
		return nil, err
	}
	args := []string{"diff"}
	if staged {
		args = append(args, "--cached")
	}
	args = append(args, "--", rel)
	ok, out := gitHead(diffMax, args...)
	if ok && out == "" && !staged { // untracked: show the whole file as added
		_, out = gitHead(diffMax, "diff", "--no-index", "--", "/dev/null", rel) // --no-index exits 1 when files differ
	}
	return map[string]any{"diff": out}, nil
}

// gitHead runs git and keeps only the first max bytes of its output, then stops it: a huge diff is never held whole.
// Returns (exited cleanly or was cut short, stdout or else stderr).
func gitHead(max int, args ...string) (bool, string) {
	env, argv := command(args)
	r, err := procx.RunLimit(30*time.Second, max, "", env, argv...)
	if err != nil {
		return false, err.Error()
	}
	if r.Stdout == "" {
		return r.Code == 0, strings.Trim(r.Stderr, "\n")
	}
	return r.Code == 0 || r.Truncated, strings.Trim(r.Stdout, "\n")
}

// GitMessage writes a commit message for the staged changes, via a one-off call to the named agent backend ("":
// the first installed one).
func GitMessage(backend string) map[string]any {
	ok, diff := Git("diff", "--cached", "--stat", "--patch")
	if !ok || strings.TrimSpace(diff) == "" {
		return map[string]any{"error": "Nothing staged to describe."}
	}
	prompt := "Write a git commit message for this staged diff. First line: imperative summary under 70 characters. " +
		"Then a blank line and a short body only if the change needs explaining. Reply with the message only, no code fences."
	if len(diff) > 80_000 {
		diff = diff[:80_000]
	}
	ok, out := live.Write(backend, prompt, diff)
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
	for i, p := range paths {
		rel, err := rootRel(p)
		if err != nil {
			return nil, err
		}
		paths[i] = rel
	}
	var ok bool
	var out string
	switch op {
	case "stage":
		if len(paths) > 0 {
			ok, out = Git(append([]string{"add", "--"}, paths...)...)
		} else {
			ok, out = Git("add", "-A", "--", ".") // ".": only Root, which may be a subfolder of the repo
		}
	case "unstage":
		if len(paths) > 0 {
			ok, out = Git(append([]string{"restore", "--staged", "--"}, paths...)...)
		} else {
			ok, out = Git("reset", "-q", "--", ".")
		}
	case "commit":
		msg, _ := body["message"].(string)
		if msg = strings.TrimSpace(msg); msg == "" {
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
		backend, _ := body["backend"].(string)
		return GitMessage(backend), nil
	default:
		return map[string]any{"ok": false, "out": "unknown op " + op}, nil
	}
	if len(out) > 4000 {
		out = out[len(out)-4000:]
	}
	return map[string]any{"ok": ok, "out": out}, nil
}

// rootRel checks rel is inside the project and returns it relative to Root: what git gets, never the raw input (git
// runs in Root, which may be a subfolder of the repo). Containment is checked on the resolved path, but git gets the
// cleaned unresolved one: a tracked symlink stages the link itself, not its target.
func rootRel(rel string) (string, error) {
	if _, err := config.Inside(rel); err != nil {
		return "", err
	}
	p := rel
	if !filepath.IsAbs(p) {
		p = filepath.Join(config.Root, p)
	}
	r, err := filepath.Rel(config.Root, filepath.Clean(p))
	if err != nil || r == ".." || strings.HasPrefix(r, ".."+string(filepath.Separator)) {
		return "", config.ErrOutside // "../x" can resolve back inside through a link, but git would take it literally
	}
	return r, nil
}
