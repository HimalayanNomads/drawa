// Package remote turns a GitHub URL given as the project argument into a local clone in a stable cache folder,
// so `drawa https://github.com/o/r` works and reruns (and self-restarts) land on the same root.
package remote

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// Base is where clones live: <UserCacheDir>/drawa/repos, symlinks resolved so Root is identical before and
// after the first clone, even on a machine where the cache dir doesn't exist yet.
func Base() string {
	cache, err := os.UserCacheDir()
	if err != nil {
		// ponytail: no $HOME/$XDG_CACHE_HOME at all; the temp dir may not survive a reboot, but it's a real folder
		cache = os.TempDir()
	}
	return resolve(filepath.Join(cache, "drawa", "repos"))
}

// resolve follows symlinks in the longest prefix of p that exists and keeps the rest as is, so it gives the
// same answer as the EvalSymlinks config.rootDir runs once the whole path has been created. No disk writes:
// Parse must stay side-effect free.
func resolve(p string) string {
	tail := ""
	for {
		if real, err := filepath.EvalSymlinks(p); err == nil {
			return filepath.Join(real, tail)
		}
		parent := filepath.Dir(p)
		if parent == p {
			return filepath.Join(p, tail)
		}
		tail, p = filepath.Join(filepath.Base(p), tail), parent
	}
}

// Parse reports whether arg is a GitHub URL, and if so the clone folder (Base()/github.com/<owner>/<repo>),
// the URL to clone, and the ref from /tree/<ref> ("" if none). Pure string work: no network, no disk.
//
// Accepted: https://github.com/o/r[.git][/], https://github.com/o/r/tree/<ref>, git@github.com:o/r[.git] and
// ssh://git@github.com/o/r[.git]. The URL to clone keeps the user's transport (https or ssh) so their usual
// credentials work. A ref may contain "/" (feature/x): everything after /tree/ is taken as the name to check out.
func Parse(arg string) (dir, cloneURL, ref string, ok bool) {
	var owner, repo string
	ssh := false
	if rest, found := strings.CutPrefix(arg, "git@github.com:"); found {
		parts := strings.Split(strings.TrimSuffix(rest, "/"), "/")
		if len(parts) != 2 {
			return "", "", "", false
		}
		owner, repo, ssh = parts[0], parts[1], true
	} else {
		u, err := url.Parse(arg)
		if err != nil || u.Host != "github.com" {
			return "", "", "", false
		}
		switch {
		case u.Scheme == "https" && u.User == nil:
		case u.Scheme == "ssh" && u.User != nil && u.User.Username() == "git":
			ssh = true
		default:
			return "", "", "", false
		}
		parts := strings.Split(strings.Trim(u.Path, "/"), "/")
		if len(parts) < 2 {
			return "", "", "", false
		}
		owner, repo = parts[0], parts[1]
		if len(parts) > 2 {
			// only https browser links carry /tree/<ref>; anything else (/blob/..., /pulls) isn't a repo URL
			if ssh || parts[2] != "tree" || len(parts) < 4 {
				return "", "", "", false
			}
			ref = strings.Join(parts[3:], "/")
		}
	}
	repo = strings.TrimSuffix(repo, ".git")
	// the dir is built from these, so they must stay one plain path segment inside Base()
	if !segment(owner) || !segment(repo) || strings.HasPrefix(ref, "-") {
		return "", "", "", false
	}
	cloneURL = "https://github.com/" + owner + "/" + repo + ".git"
	if ssh {
		cloneURL = "git@github.com:" + owner + "/" + repo + ".git"
	}
	// GitHub names are case-insensitive, so O/R and o/r must share one clone
	return filepath.Join(Base(), "github.com", strings.ToLower(owner), strings.ToLower(repo)), cloneURL, ref, true
}

// segment: non-empty, no separators or "..", not "." and can't be read as a flag. A leading "." is fine:
// real repos like org/.github use it.
func segment(s string) bool {
	return s != "" && s != "." && !strings.ContainsAny(s, `/\`) && !strings.Contains(s, "..") &&
		!strings.HasPrefix(s, "-")
}

// Ensure clones url into dir if dir doesn't exist yet (checking out ref on that first clone only); an existing
// clone is reused as is.
func Ensure(dir, cloneURL, ref string) error {
	if cloned(dir) {
		fmt.Println("Using existing clone at", dir)
		if ref != "" {
			fmt.Printf("Ignoring %q: the clone already exists and stays on its current branch\n", ref)
		}
		fetch(dir)
		return nil
	}
	// a folder without .git (history deleted, or another drawa mid-clone) may hold work: never clone over it, since
	// the cleanup below would delete it
	if _, err := os.Stat(dir); err == nil {
		return fmt.Errorf("%s exists but isn't a git clone; move it away to clone again", dir)
	}
	if err := os.MkdirAll(filepath.Dir(dir), 0o755); err != nil {
		return err
	}
	// blobless keeps full history (the Git window needs it) while staying fast like --depth 1; no submodules,
	// since they'd fetch more untrusted URLs
	if err := loud(exec.Command("git", "clone", "--filter=blob:none", "--", cloneURL, dir)); err != nil {
		os.RemoveAll(dir)
		owner, repo := filepath.Base(filepath.Dir(dir)), filepath.Base(dir)
		return fmt.Errorf("git clone %s failed: %w\nIf the repo is private, run `gh auth setup-git`, or use the SSH URL git@github.com:%s/%s.git", cloneURL, err, owner, repo)
	}
	if ref != "" {
		if err := loud(exec.Command("git", "-C", dir, "checkout", ref, "--")); err != nil {
			fmt.Fprintf(os.Stderr, "Couldn't check out %q (%v); staying on the default branch. Only branch and tag names work, not folder links like /tree/main/docs\n", ref, err)
		}
	}
	fmt.Println("Cloned into", dir)
	return nil
}

var fetchTimeout = 10 * time.Second // a var so the test needn't wait it out

// fetch updates dir's remote refs, best effort, and never resets or pulls: the working tree may hold Claude's
// uncommitted edits. It runs on every start and self-restart, so it must never wait on a network that's down
// or a credential prompt nobody sees.
func fetch(dir string) {
	ctx, cancel := context.WithTimeout(context.Background(), fetchTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", append(guard(dir), "-c", "credential.interactive=false", "-c", "core.askPass=", "fetch", "--quiet")...)
	// empty askpass values switch off desktop password pop-ups too: git skips an empty askpass, ssh obeys _REQUIRE
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "GIT_ASKPASS=", "SSH_ASKPASS=", "SSH_ASKPASS_REQUIRE=never")
	// own session, so no controlling terminal: nothing can ask for a key passphrase on /dev/tty either
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	_ = cmd.Run()
}

// guard starts a git command in a clone without running anything its .git/config names: the fetch runs before
// the trust question and --clean never asks it, while an agent in an earlier session may have written there
// (fsmonitor, hooks, a "!cmd" credential helper, sshCommand, a remote turned into a local path). Env
// GIT_SSH_COMMAND still wins over the sshCommand here, as it's the user's own.
func guard(dir string) []string {
	return []string{"-C", dir, "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "credential.helper=",
		"-c", "core.sshCommand=ssh -o BatchMode=yes", "-c", "protocol.file.allow=never"}
}

// loud runs cmd with git's progress and prompts on the user's terminal.
func loud(cmd *exec.Cmd) error {
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stderr, os.Stderr
	return cmd.Run()
}

func cloned(dir string) bool {
	_, err := os.Stat(filepath.Join(dir, ".git"))
	return err == nil
}

// Clean removes cached clones that hold no uncommitted changes and no unpushed commits; arg "" means every
// clone, otherwise it's a URL naming one. Dirty clones are kept and reported. The canvas layout and Claude's
// history are keyed by the clone's path, not stored in it, so they survive and come back on the next clone.
// It can't tell whether a Drawa is open on a clone right now, so don't clean while one is.
func Clean(arg string) error {
	var dirs []string
	if arg == "" {
		all, err := filepath.Glob(filepath.Join(Base(), "github.com", "*", "*"))
		if err != nil {
			return err
		}
		for _, d := range all {
			if cloned(d) {
				dirs = append(dirs, d)
			}
		}
	} else {
		dir, _, _, ok := Parse(arg)
		if !ok {
			return fmt.Errorf("%s is not a GitHub repo URL", arg)
		}
		if !cloned(dir) {
			return fmt.Errorf("%s is not cloned (looked in %s)", arg, dir)
		}
		dirs = []string{dir}
	}
	if len(dirs) == 0 {
		fmt.Println("No cached clones.")
		return nil
	}
	for _, dir := range dirs {
		if why := keep(dir); why != "" {
			fmt.Printf("Kept %s: %s\n", dir, why)
			continue
		}
		if err := os.RemoveAll(dir); err != nil {
			return err
		}
		fmt.Println("Removed", dir)
		_ = os.Remove(filepath.Dir(dir)) // the owner folder, only if that was its last repo
	}
	return nil
}

// keep says why dir must not be deleted, or "" if nothing in it would be lost.
func keep(dir string) string {
	checks := []struct {
		reason string
		args   []string
	}{
		// --untracked-files=all overrides a status.showUntrackedFiles=no config, and --ignored catches .env files
		// and notes in ignored folders; a clone with only build output is kept too, which is the safe side
		{"uncommitted or ignored files", []string{"status", "--porcelain", "--untracked-files=all", "--ignored"}},
		{"unpushed commits", []string{"log", "HEAD", "--branches", "--not", "--remotes", "--oneline"}}, // HEAD: a detached checkout's commits
		{"stashed changes", []string{"stash", "list"}},
	}
	for _, c := range checks {
		out, err := exec.Command("git", append(guard(dir), c.args...)...).Output()
		if err != nil {
			var exit *exec.ExitError
			if errors.As(err, &exit) && len(exit.Stderr) > 0 {
				return strings.TrimSpace(string(exit.Stderr))
			}
			return err.Error()
		}
		if strings.TrimSpace(string(out)) != "" {
			return c.reason
		}
	}
	return ""
}
