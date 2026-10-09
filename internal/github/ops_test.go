package github

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"drawa/internal/config"
)

// fakeGh puts a gh on PATH that answers `repo view` (the repo gh picks: up/drawa; origin by its URL: fork) and logs
// every call with its GH_REPO, for a project that's a clone with origin pointing at a bare repo.
func fakeGh(t *testing.T, fails bool) (log string) {
	dir := t.TempDir()
	log = filepath.Join(dir, "log")
	script := `#!/bin/sh
echo "GH_REPO=$GH_REPO $*" >> "` + log + `"
` + map[bool]string{true: "echo 'no GitHub remote' >&2; exit 1\n", false: `case "$*" in
  "repo view --json"*) echo '{"nameWithOwner":"up/drawa","url":"https://github.com/up/drawa"}' ;;
  "repo view "*" --json owner"*) echo fork ;;
  "pr create"*) cat >/dev/null; echo https://github.com/up/drawa/pull/1 ;;
  "api repos/{owner}/{repo}/contents/f.txt?"*) echo '{"type":"file","encoding":"base64","content":"aGkK"}' ;;
  "api repos/{owner}/{repo}/contents/dir?"*) echo '[{"type":"file","name":"x"}]' ;;
  "api repos/{owner}/{repo}/contents/sub?"*) echo '{"type":"submodule"}' ;;
esac
`}[fails]
	if err := os.WriteFile(filepath.Join(dir, "gh"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	git, err := exec.LookPath("git")
	if err != nil {
		t.Skip("no git")
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+filepath.Dir(git))

	root, bare := t.TempDir(), t.TempDir()
	for _, args := range [][]string{{"-C", bare, "init", "-q", "--bare"}, {"-C", root, "init", "-q", "-b", "feature"},
		{"-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x"},
		{"-C", root, "remote", "add", "origin", bare}} {
		if out, err := exec.Command("git", args...).CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
	}
	saved := config.Root
	config.Root = root
	repoCache.val, repoCache.fail = map[string]map[string]any{}, map[string]repoFail{}
	t.Cleanup(func() {
		config.Root = saved
		repoCache.val, repoCache.fail = map[string]map[string]any{}, map[string]repoFail{}
	})
	return log
}

func calls(t *testing.T, log string) []string {
	b, _ := os.ReadFile(log)
	return strings.Split(strings.TrimSpace(string(b)), "\n")
}

// A pull request from a fork: gh acts on upstream (GH_REPO), so --head names the fork's owner, where the branch was
// pushed. A bare branch name would be looked for upstream.
func TestCreatePrHeadOwner(t *testing.T) {
	log := fakeGh(t, false)
	if r := createPr(map[string]any{"title": "t", "base": "main", "body": "b"}); r["ok"] != true {
		t.Fatalf("createPr: %v", r)
	}
	got := calls(t, log)
	last := got[len(got)-1]
	if !strings.Contains(last, "GH_REPO=github.com/up/drawa pr create") || !strings.Contains(last, "--head=fork:feature") {
		t.Errorf("pr create ran as %q (all: %q)", last, got)
	}
}

// With no GitHub repo to name, Gh still runs, and the failed lookup is kept: two calls ask `repo view` once.
func TestRepoFailureKept(t *testing.T) {
	log := fakeGh(t, true)
	Gh("", 0, "", "pr", "list")
	Gh("", 0, "", "pr", "list")
	views := 0
	for _, c := range calls(t, log) {
		if strings.Contains(c, "repo view") {
			views++
		}
	}
	if views != 1 {
		t.Errorf("repo view asked %d times: %q", views, calls(t, log))
	}
}

// A pull request's file from GitHub when its commit isn't here: only a file's content, never a folder's or a
// submodule's listing. A commit that is here answers alone, even for a file it doesn't have.
func TestBlobFromGitHub(t *testing.T) {
	log := fakeGh(t, false)
	missing := strings.Repeat("ab", 20)
	for path, want := range map[string]any{"f.txt": "hi\n", "dir": nil, "sub": nil} {
		if b, err := Blob("", missing, path); err != nil || b["text"] != want {
			t.Errorf("Blob(%s) = %v, %v; want %q", path, b, err, want)
		}
	}
	head, _ := exec.Command("git", "-C", config.Root, "rev-parse", "HEAD").Output()
	before := len(calls(t, log))
	if b, err := Blob("", strings.TrimSpace(string(head)), "gone.txt"); err != nil || b["text"] != nil {
		t.Errorf("a file the local commit doesn't have = %v, %v", b, err)
	}
	if got := calls(t, log); len(got) != before {
		t.Errorf("asked GitHub for a commit that is here: %q", got[before:])
	}
	if _, err := Blob("", "", "f.txt"); err == nil {
		t.Error("no commit read something (the index)")
	}
}
