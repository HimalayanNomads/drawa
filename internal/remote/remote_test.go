package remote

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestParse(t *testing.T) {
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	base := filepath.Join(Base(), "github.com")
	https, ssh := "https://github.com/o/r.git", "git@github.com:o/r.git"
	ok := []struct{ arg, url, ref string }{
		{"https://github.com/o/r", https, ""},
		{"https://github.com/o/r.git", https, ""},
		{"https://github.com/o/r/", https, ""},
		{"https://github.com/o/r/tree/main", https, "main"},
		{"https://github.com/o/r/tree/feature/x", https, "feature/x"},
		{"git@github.com:o/r.git", ssh, ""},
		{"git@github.com:o/r", ssh, ""},
		{"ssh://git@github.com/o/r.git", ssh, ""},
		{"ssh://git@github.com/o/r", ssh, ""},
		{"https://github.com/o/r?x=1#frag", https, ""},
	}
	for _, c := range ok {
		dir, url, ref, good := Parse(c.arg)
		if !good || dir != filepath.Join(base, "o", "r") || url != c.url || ref != c.ref {
			t.Errorf("Parse(%q) = %q %q %q %v", c.arg, dir, url, ref, good)
		}
	}
	// case folds for the dir only: GitHub names are case-insensitive, the URL is cloned as given
	if dir, url, _, _ := Parse("https://github.com/O/R"); dir != filepath.Join(base, "o", "r") || url != "https://github.com/O/R.git" {
		t.Errorf("Parse of O/R = %q %q", dir, url)
	}
	if dir, url, _, good := Parse("https://github.com/org/.github"); !good || dir != filepath.Join(base, "org", ".github") || url != "https://github.com/org/.github.git" {
		t.Errorf("Parse of org/.github = %q %q %v", dir, url, good)
	}
	bad := []string{
		"o/r", "./local", "/abs/path", "", "http://github.com/o/r", "https://gitlab.com/o/r",
		"https://github.com/o", "https://github.com/", "https://github.com/../x", "https://github.com/o/..",
		"git@github.com:o/..", "git@github.com:o", "git@github.com:-o/r", "https://github.com/o/.",
		"https://github.com/o/%2e%2e", "https://github.com/o/r/tree/%2Dx",
		"https://github.com/o/r/blob/main/x.go", "https://github.com/o/r/tree/", "https://github.com/o/r/tree/-x",
		"https://user@github.com/o/r", "ssh://root@github.com/o/r", "git@gitlab.com:o/r.git",
	}
	for _, arg := range bad {
		if dir, _, _, good := Parse(arg); good {
			t.Errorf("Parse(%q) accepted, dir %q", arg, dir)
		}
	}
}

func TestBaseMissingCache(t *testing.T) {
	tmp := t.TempDir()
	link := filepath.Join(tmp, "link")
	if err := os.Symlink(t.TempDir(), link); err != nil {
		t.Skip("no symlinks:", err)
	}
	t.Setenv("XDG_CACHE_HOME", filepath.Join(link, "missing"))
	before := Base()
	if err := os.MkdirAll(before, 0o755); err != nil {
		t.Fatal(err)
	}
	after, err := filepath.EvalSymlinks(filepath.Join(link, "missing", "drawa", "repos"))
	if err != nil || before != after || Base() != after {
		t.Errorf("Base() before the cache existed %q, after %q (%v)", before, after, err)
	}
}

func git(t *testing.T, args ...string) {
	t.Helper()
	if out, err := exec.Command("git", args...).CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

func TestEnsureClean(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	tmp := t.TempDir()
	t.Setenv("XDG_CACHE_HOME", filepath.Join(tmp, "cache"))
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	for _, k := range []string{"GIT_AUTHOR", "GIT_COMMITTER"} {
		t.Setenv(k+"_NAME", "t")
		t.Setenv(k+"_EMAIL", "t@example.com")
	}
	work, bare := filepath.Join(tmp, "work"), filepath.Join(tmp, "bare.git")
	git(t, "init", "-q", work)
	git(t, "-C", work, "commit", "-q", "--allow-empty", "-m", "first")
	git(t, "clone", "-q", "--bare", work, bare)

	root := filepath.Join(Base(), "github.com")
	clean, untracked, ahead := filepath.Join(root, "a", "clean"), filepath.Join(root, "b", "untracked"), filepath.Join(root, "b", "ahead")
	stashed, detached := filepath.Join(root, "b", "stashed"), filepath.Join(root, "b", "detached")
	ignored, hidden := filepath.Join(root, "b", "ignored"), filepath.Join(root, "b", "hidden")
	all := []string{clean, untracked, ahead, stashed, detached, ignored, hidden}
	for _, d := range all {
		if err := Ensure(d, bare, ""); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(untracked, "new.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(ignored, ".git", "info", "exclude"), []byte("secret.env\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(ignored, "secret.env"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	// a config hiding untracked files must not hide them from Clean
	git(t, "-C", hidden, "config", "status.showUntrackedFiles", "no")
	if err := os.WriteFile(filepath.Join(hidden, "new.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	git(t, "-C", ahead, "commit", "-q", "--allow-empty", "-m", "local")
	if err := os.WriteFile(filepath.Join(stashed, "new.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	git(t, "-C", stashed, "stash", "-q", "-u")
	git(t, "-C", detached, "checkout", "-q", "--detach")
	git(t, "-C", detached, "commit", "-q", "--allow-empty", "-m", "detached")
	// a second Ensure must reuse the clone, leaving the local commit alone
	if err := Ensure(ahead, "/nonexistent", ""); err != nil {
		t.Fatal(err)
	}

	if err := Clean(""); err != nil {
		t.Fatal(err)
	}
	if cloned(clean) || exists(filepath.Dir(clean)) {
		t.Error("clean clone or its empty owner folder was kept")
	}
	for _, d := range all[1:] {
		if !cloned(d) {
			t.Error("a clone with local work was removed:", d)
		}
	}
	if err := Clean("https://github.com/nobody/here"); err == nil {
		t.Error("Clean of a repo that isn't cloned should fail")
	}
	if err := Clean("o/r"); err == nil {
		t.Error("Clean of a non-URL should fail")
	}
}

func TestEnsureNotAClone(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "notes.txt")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := Ensure(dir, "/nonexistent", ""); err == nil {
		t.Error("Ensure on a folder without .git succeeded")
	}
	if !exists(file) {
		t.Error("Ensure removed a file from a folder that isn't a clone")
	}
}

// A fetch that hangs (dead network, prompt nobody sees) must not hold up the start.
func TestFetchTimeout(t *testing.T) {
	old := fetchTimeout
	fetchTimeout = time.Second
	t.Cleanup(func() { fetchTimeout = old })
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	dir := t.TempDir()
	git(t, "init", "-q", dir)
	git(t, "-C", dir, "remote", "add", "origin", "git@github.com:o/r.git")
	// an ssh that never answers; "#" comments out the args git appends
	t.Setenv("GIT_SSH_COMMAND", "sleep 60 #") // env, since guard() overrides a repo's core.sshCommand
	start := time.Now()
	if err := Ensure(dir, "", ""); err != nil {
		t.Fatal(err)
	}
	if d := time.Since(start); d > 3*time.Second {
		t.Errorf("Ensure on an existing clone took %v", d)
	}
}

func TestEnsureCloneFails(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	dir := filepath.Join(t.TempDir(), "o", "r")
	if err := Ensure(dir, filepath.Join(t.TempDir(), "missing.git"), ""); err == nil {
		t.Fatal("clone of a missing repo succeeded")
	}
	if exists(dir) {
		t.Error("partial clone left behind")
	}
}

func exists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// --clean inspects clones nobody was asked to trust, so a command planted in .git/config must not run.
func TestKeepRunsNoRepoCommands(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	dir, marker := t.TempDir(), filepath.Join(t.TempDir(), "ran")
	git(t, "init", "-q", dir)
	git(t, "-C", dir, "config", "core.fsmonitor", "touch "+marker+" #")
	keep(dir)
	if exists(marker) {
		t.Error("keep ran the repo's core.fsmonitor")
	}
	// the control: plain git does run it, so the check above means something
	git(t, "-C", dir, "status", "--porcelain")
	if !exists(marker) {
		t.Skip("this git doesn't run core.fsmonitor commands; nothing to check")
	}
}
