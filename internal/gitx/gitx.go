// Package gitx wraps the git CLI: the plain runner, status (status.go) and diffs for the Git window, the repos in the
// project's subfolders (repos.go), and the write operations (stage, commit, push, ...).
package gitx

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"drawa/internal/config"
	"drawa/internal/live"
	"drawa/internal/procx"
)

type Opts struct {
	Timeout time.Duration
	Stdin   string
	Repo    string // the repo git runs in: "" for Root, else one of Nested (checked by repoDir first)
}

// Git runs git in the project; returns (ok, output). Paths always come after `--` (never read as options).
func Git(args ...string) (bool, string) { return GitOpts(Opts{}, args...) }

func GitOpts(o Opts, args ...string) (bool, string) {
	if o.Timeout == 0 {
		o.Timeout = 30 * time.Second
	}
	if err := Check(o.Repo); err != nil { // the callers check first; this is so one that forgets can't run git elsewhere
		return false, err.Error()
	}
	env, argv := command(o.Repo, args)
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

// command is the env and argv for every git call Drawa makes, in Root or in the nested repo named.
func command(repo string, args []string) (env, argv []string) {
	// literal pathspecs: a page-supplied ":/x" would otherwise name a file from the repo's top, outside Root
	env = append(os.Environ(), "GIT_LITERAL_PATHSPECS=1")
	argv = []string{"git"}
	if repo != "" {
		// a repo found in a subfolder is polled with no approval, and may be one the agent just made: its fsmonitor
		// (a command git status runs) is off whatever the trust; it only speeds status up
		argv = append(argv, "-C", Path(repo), "-c", "core.fsmonitor=false")
	}
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
		if len(args) > 0 && (args[0] == "diff" || args[0] == "log" || args[0] == "show") { // diff drivers and textconv from .gitattributes
			args = append([]string{args[0], "--no-ext-diff", "--no-textconv"}, args[1:]...)
		}
	}
	return env, append(argv, args...)
}

// NonNil turns a nil list into an empty one, so it's [] in JSON rather than null.
func NonNil[T any](s []T) []T {
	if s == nil {
		return []T{}
	}
	return s
}

const diffMax = 400_000

// GitDiff is the diff of one file (relative to Root) in repo ("" for Root's).
func GitDiff(repo, rel string, staged bool) (map[string]any, error) {
	repo, err := repoDir(repo)
	if err != nil {
		return nil, err
	}
	if rel, err = rootRel(rel); err != nil {
		return nil, err
	}
	if rel, err = inRepo(repo, rel); err != nil {
		return nil, err
	}
	args := []string{"diff"}
	if staged {
		args = append(args, "--cached")
	}
	args = append(args, "--", rel)
	ok, out := gitHead(repo, diffMax, args...)
	if ok && out == "" && !staged { // untracked: show the whole file as added
		_, out = gitHead(repo, diffMax, "diff", "--no-index", "--", "/dev/null", rel) // --no-index exits 1 when files differ
	}
	return map[string]any{"diff": out}, nil
}

var hashRe = regexp.MustCompile(`^[0-9a-f]{4,64}$`)

// GitShow is what one commit in repo changed, as a patch (no message: the page has it).
func GitShow(repo, hash string) (map[string]any, error) {
	if !hashRe.MatchString(hash) { // never an option or a revision expression
		return nil, errors.New("not a commit hash")
	}
	repo, err := repoDir(repo)
	if err != nil {
		return nil, err
	}
	// ".": only Root's part of the repo, which may be a subfolder of it
	ok, out := gitHead(repo, diffMax, "show", "--format=", "--patch", hash, "--", ".")
	if !ok {
		return nil, errors.New(out)
	}
	return map[string]any{"diff": out}, nil
}

// gitHead runs git and keeps only the first max bytes of its output, then stops it: a huge diff is never held whole.
// Returns (exited cleanly or was cut short, stdout or else stderr).
func gitHead(repo string, max int, args ...string) (bool, string) {
	if err := Check(repo); err != nil {
		return false, err.Error()
	}
	env, argv := command(repo, args)
	r, err := procx.RunLimit(30*time.Second, max, "", env, argv...)
	if err != nil {
		return false, err.Error()
	}
	if r.Stdout == "" {
		return r.Code == 0, strings.Trim(r.Stderr, "\n")
	}
	return r.Code == 0 || r.Truncated, strings.Trim(r.Stdout, "\n")
}

// GitMessage writes a commit message for repo's staged changes, via a one-off call to the named agent backend ("":
// the first installed one).
func GitMessage(repo, backend string) map[string]any {
	ok, diff := GitOpts(Opts{Repo: repo}, "diff", "--cached", "--stat", "--patch")
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

// Forget drops the shared status, for something that just changed the repo (an op, a pull request checked out).
func Forget() {
	stateCache.Lock()
	stateCache.state = nil
	stateCache.Unlock()
}

// GitOp carries out a write operation from the Git window (stage/unstage/commit/push/pull/init/message), in Root's
// repo or the nested one named by "repo".
func GitOp(body map[string]any) (map[string]any, error) {
	Forget() // whatever it does, the next status is fresh
	op, _ := body["op"].(string)
	repo, _ := body["repo"].(string)
	repo, err := repoDir(repo)
	if err != nil {
		return nil, err
	}
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
		if paths[i], err = inRepo(repo, rel); err != nil {
			return nil, err
		}
	}
	git := func(o Opts, args ...string) (bool, string) { o.Repo = repo; return GitOpts(o, args...) }
	var ok bool
	var out string
	switch op {
	case "stage":
		if len(paths) > 0 {
			ok, out = git(Opts{}, append([]string{"add", "--"}, paths...)...)
		} else {
			ok, out = git(Opts{}, "add", "-A", "--", ".") // ".": only Root, which may be a subfolder of the repo
		}
	case "unstage":
		if len(paths) > 0 {
			ok, out = git(Opts{}, append([]string{"restore", "--staged", "--"}, paths...)...)
		} else {
			ok, out = git(Opts{}, "reset", "-q", "--", ".")
		}
	case "discard": // git restore: a Changes row back to what's staged (or HEAD); a Staged row, and its edits, to HEAD
		if len(paths) == 0 {
			return map[string]any{"ok": false, "out": "Name the files to discard."}, nil
		}
		args := []string{"restore"}
		if staged, _ := body["staged"].(bool); staged {
			args = append(args, "--staged", "--worktree", "--source=HEAD")
		}
		ok, out = git(Opts{}, append(append(args, "--"), paths...)...)
	case "commit":
		msg, _ := body["message"].(string)
		if msg = strings.TrimSpace(msg); msg == "" {
			return map[string]any{"ok": false, "out": "Write a commit message first."}, nil
		}
		ok, out = git(Opts{Stdin: msg}, "commit", "-F", "-")
	case "push":
		ok, out = git(Opts{Timeout: 120 * time.Second}, "push")
		if !ok && strings.Contains(out, "no upstream") {
			ok, out = git(Opts{Timeout: 120 * time.Second}, "push", "-u", "origin", "HEAD")
		}
	case "pull":
		ok, out = git(Opts{Timeout: 120 * time.Second}, "pull", "--ff-only")
	case "init":
		if repo != "" {
			return nil, ErrNoRepo // a nested repo is one already
		}
		ok, out = git(Opts{}, "init")
	case "message":
		backend, _ := body["backend"].(string)
		return GitMessage(repo, backend), nil
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
