package gitx

import (
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"

	"drawa/internal/config"
)

func TestParseNumstat(t *testing.T) {
	out := "1\t2\tplain.go\x00" + "3\t0\t\x00src/a.go\x00src/b.go\x00" + "-\t-\timg.png\x00" + "4\t4\tcafé ü.txt\x00"
	want := map[string][2]int{"plain.go": {1, 2}, "src/b.go": {3, 0}, "img.png": {0, 0}, "café ü.txt": {4, 4}}
	if got := parseNumstat(out); !reflect.DeepEqual(got, want) {
		t.Fatalf("parseNumstat = %v, want %v", got, want)
	}
}

func TestParseStatusPrefix(t *testing.T) {
	out := "## main...origin/main [ahead 1]\x00M  sub/a\x00R  sub/new\x00old\x00?? top.txt\x00?? sub/dir/\x00"
	head, files := parseStatus(out, "sub/")
	if head != "main...origin/main [ahead 1]" {
		t.Fatalf("head = %q", head)
	}
	var paths []string
	for _, f := range files {
		paths = append(paths, f.Path)
	}
	if want := []string{"a", "new", "dir/"}; !reflect.DeepEqual(paths, want) {
		t.Fatalf("paths = %v, want %v", paths, want)
	}
}

// A project folder below the repo's top: the Git window lists only its files, relative to it, with line counts.
func TestStatusInSubfolder(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
	repo, _ := filepath.EvalSymlinks(t.TempDir())
	run := func(dir string, args ...string) {
		cmd := exec.Command("git", append([]string{"-c", "user.email=a@b", "-c", "user.name=a"}, args...)...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
	}
	write := func(p, s string) { os.MkdirAll(filepath.Dir(p), 0o755); os.WriteFile(p, []byte(s), 0o644) }
	sub := filepath.Join(repo, "sub")
	write(filepath.Join(repo, "top.txt"), "a\n")
	write(filepath.Join(sub, "a.txt"), "a\n")
	write(filepath.Join(sub, "old.txt"), "x\ny\n")
	run(repo, "init", "-q")
	run(repo, "add", ".")
	run(repo, "commit", "-qm", "init")
	write(filepath.Join(repo, "top.txt"), "b\n")         // changed outside the project: not listed
	write(filepath.Join(sub, "a.txt"), "a\nb\nc\n")      // +2
	write(filepath.Join(sub, "ü.txt"), "new\n")          // untracked, non-ASCII
	write(filepath.Join(sub, "dir", "deep", "f"), "f\n") // untracked folder: one row
	run(sub, "mv", "old.txt", "new.txt")

	saved := config.Root
	config.Root = sub
	prefixCache.ok = false
	t.Cleanup(func() { config.Root = saved; prefixCache.ok = false })

	st := gitStatus("", false)
	got := map[string]map[string]any{}
	for _, f := range st["files"].([]map[string]any) {
		got[f["path"].(string)] = f
	}
	if len(got) != 4 || got["top.txt"] != nil || got["../top.txt"] != nil {
		t.Fatalf("files = %v", got)
	}
	if f := got["a.txt"]; f == nil || !reflect.DeepEqual(f["unstaged"], []int{2, 0}) {
		t.Fatalf("a.txt = %v", f)
	}
	if f := got["new.txt"]; f == nil || f["x"] != "R" {
		t.Fatalf("new.txt = %v", f)
	}
	if got["ü.txt"] == nil || got["dir/"] == nil {
		t.Fatalf("untracked = %v", got)
	}
	// staging everything stays inside the project folder
	if r, _ := GitOp(map[string]any{"op": "stage"}); r["ok"] != true {
		t.Fatalf("stage: %v", r)
	}
	_, staged := Git("diff", "--cached", "--name-only") // repo-wide: names from the top
	if !strings.Contains(staged, "sub/a.txt") || slices.Contains(strings.Split(staged, "\n"), "top.txt") {
		t.Fatalf("staged = %q", staged)
	}
	d, err := GitDiff("", "a.txt", true)
	if err != nil || d["diff"] == "" {
		t.Fatalf("diff = %v %v", d, err)
	}
}

// A symlink inside the project is passed to git as the link, not its target; escaping paths are refused.
func TestRootRel(t *testing.T) {
	root, _ := filepath.EvalSymlinks(t.TempDir())
	os.WriteFile(filepath.Join(root, "target"), nil, 0o644)
	os.Symlink("target", filepath.Join(root, "link"))
	saved := config.Root
	config.Root = root
	t.Cleanup(func() { config.Root = saved })
	if r, err := rootRel("link"); err != nil || r != "link" {
		t.Fatalf("rootRel(link) = %q, %v", r, err)
	}
	if r, err := rootRel("./a/../link"); err != nil || r != "link" {
		t.Fatalf("rootRel(./a/../link) = %q, %v", r, err)
	}
	if _, err := rootRel("../x"); err == nil {
		t.Fatal("rootRel(../x) accepted")
	}
}

func TestCommandOverrides(t *testing.T) {
	savedC, savedT := config.Cloned, config.Trusted
	t.Cleanup(func() { config.Cloned, config.Trusted = savedC, savedT })
	has := func(list []string, s string) bool { return slices.Contains(list, s) }
	for _, c := range []struct{ cloned, trusted, prompt, locked bool }{
		{false, false, false, false}, {true, true, true, false}, {true, false, true, true},
	} {
		config.Cloned, config.Trusted = c.cloned, c.trusted
		env, argv := command("", []string{"diff", "--cached"})
		if has(env, "GIT_TERMINAL_PROMPT=0") != c.prompt || has(argv, "credential.interactive=false") != c.prompt {
			t.Errorf("%+v: prompt overrides env=%v argv=%v", c, env, argv)
		}
		if has(argv, "core.fsmonitor=false") != c.locked || has(argv, "core.hooksPath=/dev/null") != c.locked ||
			has(argv, "--no-ext-diff") != c.locked {
			t.Errorf("%+v: untrusted overrides argv=%v", c, argv)
		}
		if !has(env, "GIT_LITERAL_PATHSPECS=1") || argv[0] != "git" || argv[len(argv)-1] != "--cached" {
			t.Errorf("%+v: env=%v argv=%v", c, env, argv)
		}
		if _, argv := command("web", []string{"status"}); argv[1] != "-C" || !has(argv, "core.fsmonitor=false") {
			t.Errorf("%+v: nested argv=%v", c, argv)
		}
	}
}

// A repo whose .git/config names commands (fsmonitor, an external diff) runs none of them from Drawa's own git calls
// when the clone is untrusted; the trusted run first proves the commands would have run.
func TestUntrustedRunsNoRepoCommands(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
	repo, _ := filepath.EvalSymlinks(t.TempDir())
	marker := filepath.Join(t.TempDir(), "ran")
	script := filepath.Join(t.TempDir(), "evil.sh")
	os.WriteFile(script, []byte("#!/bin/sh\ntouch "+marker+"\n"), 0o755)
	for _, args := range [][]string{{"init", "-q"}, {"-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "i"},
		{"config", "core.fsmonitor", script}, {"config", "diff.external", script}} {
		cmd := exec.Command("git", args...)
		cmd.Dir = repo
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
	}
	savedR, savedC, savedT := config.Root, config.Cloned, config.Trusted
	t.Cleanup(func() { config.Root, config.Cloned, config.Trusted = savedR, savedC, savedT; prefixCache.ok = false })
	config.Root, config.Cloned = repo, true
	prefixCache.ok = false
	os.WriteFile(filepath.Join(repo, "f"), []byte("a\n"), 0o644)
	Git("add", "f")
	os.WriteFile(filepath.Join(repo, "f"), []byte("b\n"), 0o644)
	run := func() bool {
		os.Remove(marker)
		gitStatus("", false)
		GitDiff("", "f", false)
		_, err := os.Stat(marker)
		return err == nil
	}
	config.Trusted = true
	if !run() {
		t.Skip("this git ran neither command even when trusted")
	}
	config.Trusted = false
	if run() {
		t.Fatal("untrusted clone ran a command from .git/config")
	}
}

// Repos in subfolders: found (not inside hidden or dependency folders), listed with paths relative to Root, left out of
// Root's own untracked rows, and their ops run in them and only on their own files.
func TestNestedRepos(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
	root, _ := filepath.EvalSymlinks(t.TempDir())
	run := func(dir string, args ...string) {
		cmd := exec.Command("git", append([]string{"-c", "user.email=a@b", "-c", "user.name=a"}, args...)...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
	}
	write := func(p, s string) { os.MkdirAll(filepath.Dir(p), 0o755); os.WriteFile(p, []byte(s), 0o644) }
	for _, d := range []string{"", "apps/api", "web", "node_modules/dep", ".cache/x"} {
		dir := filepath.Join(root, d)
		write(filepath.Join(dir, "a.txt"), "a\n")
		run(dir, "init", "-q")
		run(dir, "add", ".")
		run(dir, "commit", "-qm", "init")
	}
	write(filepath.Join(root, "apps", "api", "a.txt"), "a\nb\n")
	write(filepath.Join(root, "web", "new.txt"), "n\n")

	saved := config.Root
	config.Root = root
	prefixCache.ok, nestedCache.list, stateCache.state, wtCache.list = false, nil, nil, nil
	t.Cleanup(func() {
		config.Root = saved
		prefixCache.ok, nestedCache.list, stateCache.state, wtCache.list = false, nil, nil, nil
	})

	if got, want := Nested(), []string{"apps/api", "web"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("Nested = %v, want %v", got, want)
	}
	st := allStatus()
	for _, f := range st["files"].([]map[string]any) {
		if f["path"] == "web/" {
			t.Fatalf("root lists the nested repo web/: %v", st["files"])
		}
	}
	nested := st["nested"].([]map[string]any)
	if len(nested) != 2 || nested[0]["dir"] != "apps/api" || nested[0]["repo"] != true {
		t.Fatalf("nested = %v", nested)
	}
	files := nested[0]["files"].([]map[string]any)
	if len(files) != 1 || files[0]["path"] != "apps/api/a.txt" || !reflect.DeepEqual(files[0]["unstaged"], []int{1, 0}) {
		t.Fatalf("apps/api files = %v", files)
	}
	if d, err := GitDiff("apps/api", "apps/api/a.txt", false); err != nil || !strings.Contains(d["diff"].(string), "+b") {
		t.Fatalf("diff = %v %v", d, err)
	}
	if r, err := GitOp(map[string]any{"op": "stage", "repo": "web", "paths": []any{"web/new.txt"}}); err != nil || r["ok"] != true {
		t.Fatalf("stage in web: %v %v", r, err)
	}
	if _, staged := GitOpts(Opts{Repo: "web"}, "diff", "--cached", "--name-only"); staged != "new.txt" {
		t.Fatalf("web staged = %q", staged)
	}
	if _, err := GitOp(map[string]any{"op": "stage", "repo": "web", "paths": []any{"apps/api/a.txt"}}); err == nil {
		t.Fatal("staged another repo's file")
	}
	for _, repo := range []string{"node_modules/dep", "apps", "../x"} {
		if _, err := GitOp(map[string]any{"op": "stage", "repo": repo}); err == nil {
			t.Fatalf("ran in %q", repo)
		}
	}
	if _, err := GitOp(map[string]any{"op": "init", "repo": "web"}); err == nil {
		t.Fatal("init in a nested repo")
	}
}

// Linked worktrees come from git worktree list: inside the project (even a hidden folder) and outside it, with their
// branches (none when detached) and lock; a worktree lists none of its own, and one whose folder is gone is left out.
func TestWorktrees(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	base, _ := filepath.EvalSymlinks(t.TempDir())
	repo := filepath.Join(base, "repo")
	run := func(dir string, args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	os.MkdirAll(repo, 0o755)
	run(repo, "init", "-q", "-b", "main")
	run(repo, "commit", "-q", "--allow-empty", "-m", "first")
	inside := filepath.Join(repo, ".claude", "worktrees", "a")
	outside := filepath.Join(base, "wt-b")
	gone := filepath.Join(base, "wt-gone")
	run(repo, "worktree", "add", "-q", "-b", "feat-a", inside)
	run(repo, "worktree", "add", "-q", "--detach", outside)
	run(repo, "worktree", "add", "-q", "-b", "feat-gone", gone)
	os.RemoveAll(gone)
	locked := filepath.Join(base, "wt-locked")
	run(repo, "worktree", "add", "-q", "-b", "feat-l", locked)
	run(repo, "worktree", "lock", "--reason", "on a stick", locked)
	rel := filepath.Join(base, "wt-rel")
	run(repo, "-c", "worktree.useRelativePaths=true", "worktree", "add", "-q", "-b", "feat-r", rel) // git 2.48+; else absolute

	// forged entries: git lists any existing folder an admin entry's gitdir names; neither is a worktree
	plain, other := filepath.Join(base, "plain"), filepath.Join(base, "other")
	os.MkdirAll(plain, 0o755)
	os.MkdirAll(other, 0o755)
	run(other, "init", "-q")
	for name, target := range map[string]string{"evil": plain, "evil2": filepath.Join(other, ".git")} {
		adm := filepath.Join(repo, ".git", "worktrees", name)
		os.MkdirAll(adm, 0o755)
		os.WriteFile(filepath.Join(adm, "gitdir"), []byte(target+"\n"), 0o644)
		os.WriteFile(filepath.Join(adm, "HEAD"), []byte("ref: refs/heads/main\n"), 0o644)
		os.WriteFile(filepath.Join(adm, "commondir"), []byte("../..\n"), 0o644)
	}
	if out, _ := exec.Command("git", "-C", repo, "worktree", "list").Output(); !strings.Contains(string(out), plain) {
		t.Logf("git doesn't list the forged entry here, so the check below proves less: %s", out)
	}

	got, err := worktrees(repo)
	if err != nil {
		t.Fatal(err)
	}
	slices.SortFunc(got, func(a, b Worktree) int { return strings.Compare(a.Path, b.Path) })
	want := []Worktree{{Path: inside, Branch: "feat-a"}, {Path: outside, Branch: ""}, {Path: locked, Branch: "feat-l", Locked: true}, {Path: rel, Branch: "feat-r"}}
	slices.SortFunc(want, func(a, b Worktree) int { return strings.Compare(a.Path, b.Path) })
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("worktrees = %+v, want %+v", got, want)
	}
	if w, _ := worktrees(outside); w != nil {
		t.Fatalf("a worktree's own worktrees = %+v, want none", w)
	}
	if w, err := worktrees(base); w != nil || err != nil {
		t.Fatalf("not a repo: %+v %v", w, err)
	}

	saved := config.Root
	config.Root = repo
	reset := func() {
		prefixCache.ok, nestedCache.list, stateCache.state, wtCache.list, wtCache.good = false, nil, nil, nil, nil
	}
	reset()
	t.Cleanup(func() { config.Root = saved; reset() })
	if Check(plain) == nil || Check(filepath.Join(other, ".git")) == nil || Check(outside) != nil {
		t.Fatal("Check trusts a forged worktree, or not a real one")
	}

	// git not answering: the last good list stays; with none ever read, the repo is marked
	Repos()
	path := os.Getenv("PATH")
	t.Setenv("PATH", "")
	wtCache.list = nil
	if l, failed := worktreeLists(); len(l) != 4 || failed != nil {
		t.Fatalf("after a failure = %v %v", l, failed)
	}
	wtCache.list, wtCache.good = nil, nil
	if l, failed := worktreeLists(); len(l) != 0 || !reflect.DeepEqual(failed, []string{""}) {
		t.Fatalf("never read = %v %v", l, failed)
	}
	// the failure is cached too: with git back, calls within the 3s still get it rather than run git again
	os.Setenv("PATH", path)
	if l, failed := worktreeLists(); len(l) != 0 || !reflect.DeepEqual(failed, []string{""}) {
		t.Fatalf("failure not cached: %v %v", l, failed)
	}
	wtCache.list = nil
	if l, failed := worktreeLists(); len(l) != 4 || failed != nil {
		t.Fatalf("after expiry = %v %v", l, failed)
	}

	// a folder whose .git is a link to a real worktree's .git file isn't one (git's validate_worktree wants a file)
	link := filepath.Join(base, "wt-link")
	os.MkdirAll(link, 0o755)
	os.Symlink(filepath.Join(outside, ".git"), filepath.Join(link, ".git"))
	adm := filepath.Join(repo, ".git", "worktrees", "linked")
	os.MkdirAll(adm, 0o755)
	os.WriteFile(filepath.Join(adm, "gitdir"), []byte(filepath.Join(link, ".git")+"\n"), 0o644)
	os.WriteFile(filepath.Join(adm, "HEAD"), []byte("ref: refs/heads/main\n"), 0o644)
	os.WriteFile(filepath.Join(adm, "commondir"), []byte("../..\n"), 0o644)
	if validWorktree(link, filepath.Join(repo, ".git", "worktrees")) {
		t.Fatal("a .git symlink passes as a worktree")
	}
	if got, _ := worktrees(repo); slices.ContainsFunc(got, func(w Worktree) bool { return w.Path == link }) {
		t.Fatalf("listed the linked folder: %+v", got)
	}
}

// The porcelain parser on its own: bare and prunable entries are skipped, the main one is left out, and a list read
// from a linked worktree (whose main entry is someone else) is empty.
func TestParseWorktrees(t *testing.T) {
	out := "worktree /r\x00HEAD a\x00branch refs/heads/main\x00\x00" +
		"worktree /b\x00bare\x00\x00" +
		"worktree /w1\x00HEAD b\x00detached\x00locked\x00\x00" +
		"worktree /w2\x00HEAD c\x00branch refs/heads/x/y\x00locked why not\x00\x00" +
		"worktree /gone\x00HEAD d\x00branch refs/heads/g\x00prunable gitdir file points to non-existent location\x00\x00"
	want := []Worktree{{Path: "/w1", Locked: true}, {Path: "/w2", Branch: "x/y", Locked: true}}
	if got := parseWorktrees(out, "/r"); !reflect.DeepEqual(got, want) {
		t.Fatalf("parse = %+v, want %+v", got, want)
	}
	if got := parseWorktrees(out, "/w1"); got != nil {
		t.Fatalf("from a linked worktree = %+v", got)
	}
}

// A linked worktree of a nested repo sitting beside it under Root (lib and lib-wt) is listed under lib only, not as
// a nested repo of its own; and worktree-remove refuses Root, the nested repo and a locked worktree.
func TestSiblingWorktree(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
	root, _ := filepath.EvalSymlinks(t.TempDir())
	run := func(dir string, args ...string) {
		cmd := exec.Command("git", append([]string{"-c", "user.email=a@b", "-c", "user.name=a"}, args...)...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
	}
	lib := filepath.Join(root, "lib")
	os.MkdirAll(lib, 0o755)
	run(lib, "init", "-q", "-b", "main")
	run(lib, "commit", "-q", "--allow-empty", "-m", "init")
	run(lib, "worktree", "add", "-q", "-b", "feat", filepath.Join(root, "lib-wt"))
	run(lib, "worktree", "add", "-q", "-b", "held", filepath.Join(root, "lib-held"))
	run(lib, "worktree", "lock", filepath.Join(root, "lib-held"))

	saved := config.Root
	config.Root = root
	reset := func() { prefixCache.ok, nestedCache.list, stateCache.state, wtCache.list = false, nil, nil, nil }
	reset()
	t.Cleanup(func() { config.Root = saved; reset() })

	if r := Repos(); !reflect.DeepEqual(r, []string{"lib"}) {
		t.Fatalf("Repos = %v", r)
	}
	nested := allStatus()["nested"].([]map[string]any)
	wts, _ := nested[0]["worktrees"].([]map[string]any)
	if len(wts) != 2 || wts[0]["dir"] != "lib-wt" && wts[1]["dir"] != "lib-wt" {
		t.Fatalf("lib's worktrees = %v", wts)
	}
	for _, w := range wts {
		if (w["dir"] == "lib-held") != (w["locked"] == true) {
			t.Fatalf("locked = %v", w)
		}
	}
	for _, id := range []string{"", "lib", "lib-held"} {
		if _, err := GitOp(map[string]any{"op": "worktree-remove", "repo": id, "force": true}); err == nil {
			t.Fatalf("removed %q", id)
		}
	}
	if _, err := os.Stat(filepath.Join(root, "lib-held")); err != nil {
		t.Fatal("locked worktree gone")
	}
	os.WriteFile(filepath.Join(root, "lib-wt", "new.txt"), []byte("x"), 0o644)
	if r, err := GitOp(map[string]any{"op": "worktree-remove", "repo": "lib-wt"}); err != nil || r["ok"] != false || r["dirty"] != true {
		t.Fatalf("dirty remove = %v %v", r, err)
	}
}

// Worktrees as repos: ids for one inside Root (relative) and one outside (absolute) are accepted, any other folder
// isn't; the inside one isn't also a nested repo; status lists them under their repo with paths relative to them; and
// worktree-remove refuses a dirty one unless forced, keeping the branch.
func TestWorktreeRepos(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
	base, _ := filepath.EvalSymlinks(t.TempDir())
	root := filepath.Join(base, "root")
	run := func(dir string, args ...string) string {
		cmd := exec.Command("git", append([]string{"-c", "user.email=a@b", "-c", "user.name=a"}, args...)...)
		cmd.Dir = dir
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
		return string(out)
	}
	write := func(p, s string) { os.MkdirAll(filepath.Dir(p), 0o755); os.WriteFile(p, []byte(s), 0o644) }
	write(filepath.Join(root, "a.txt"), "a\n")
	run(root, "init", "-q", "-b", "main")
	run(root, "add", ".")
	run(root, "commit", "-qm", "init")
	inside, outside := filepath.Join(root, "wtin"), filepath.Join(base, "out")
	run(root, "worktree", "add", "-q", "-b", "feat-in", inside)
	run(root, "worktree", "add", "-q", "-b", "feat-out", outside)
	write(filepath.Join(outside, "a.txt"), "a\nb\n")
	os.MkdirAll(filepath.Join(base, "random"), 0o755)

	saved := config.Root
	config.Root = root
	prefixCache.ok, nestedCache.list, stateCache.state, wtCache.list = false, nil, nil, nil
	t.Cleanup(func() {
		config.Root = saved
		prefixCache.ok, nestedCache.list, stateCache.state, wtCache.list = false, nil, nil, nil
	})

	if n := Nested(); len(n) != 0 {
		t.Fatalf("worktree listed as a nested repo: %v", n)
	}
	for _, id := range []string{"wtin", outside} {
		if err := Check(id); err != nil {
			t.Fatalf("Check(%q) = %v", id, err)
		}
	}
	if Path(outside) != outside || Path("wtin") != inside {
		t.Fatalf("Path = %q %q", Path(outside), Path("wtin"))
	}
	for _, id := range []string{filepath.Join(base, "random"), base, "/", "wt", "wtin/..", "../out"} {
		if Check(id) == nil {
			t.Fatalf("Check(%q) accepted", id)
		}
	}
	st := allStatus()
	for _, f := range st["files"].([]map[string]any) {
		if strings.HasPrefix(f["path"].(string), "wt") {
			t.Fatalf("root lists the worktree folder: %v", st["files"])
		}
	}
	wts, _ := st["worktrees"].([]map[string]any)
	if len(wts) == 2 && wts[0]["dir"] != outside {
		wts[0], wts[1] = wts[1], wts[0]
	}
	if len(wts) != 2 || wts[0]["dir"] != outside || wts[0]["main"] != "" || wts[0]["branch"] != "feat-out" || wts[1]["dir"] != "wtin" {
		t.Fatalf("worktrees = %v", wts)
	}
	if files := wts[0]["files"].([]map[string]any); len(files) != 1 || files[0]["path"] != "a.txt" {
		t.Fatalf("outside files = %v", files)
	}
	if d, err := GitDiff(outside, "a.txt", false); err != nil || !strings.Contains(d["diff"].(string), "+b") {
		t.Fatalf("diff = %v %v", d, err)
	}
	for _, p := range []string{"../root/a.txt", "/etc/passwd"} {
		if _, err := GitDiff(outside, p, false); err == nil {
			t.Fatalf("diff outside the worktree: %q", p)
		}
	}
	if r, _ := GitOp(map[string]any{"op": "worktree-remove", "repo": outside}); r["ok"] != false || r["dirty"] != true || !strings.Contains(r["out"].(string), "--force") {
		t.Fatalf("removed a dirty worktree: %v", r)
	}
	if r, err := GitOp(map[string]any{"op": "worktree-remove", "repo": outside, "force": true}); err != nil || r["ok"] != true {
		t.Fatalf("forced remove: %v %v", r, err)
	}
	if r, err := GitOp(map[string]any{"op": "worktree-remove", "repo": "wtin"}); err != nil || r["ok"] != true {
		t.Fatalf("clean remove: %v %v", r, err)
	}
	if _, err := os.Stat(outside); !os.IsNotExist(err) {
		t.Fatal("worktree folder still there")
	}
	if !strings.Contains(run(root, "branch"), "feat-out") {
		t.Fatal("branch deleted")
	}
	if _, err := GitOp(map[string]any{"op": "worktree-remove", "repo": ""}); err == nil {
		t.Fatal("removed Root")
	}
	if wts, _ := allStatus()["worktrees"].([]map[string]any); len(wts) != 0 {
		t.Fatalf("worktrees after remove = %v", wts)
	}
}

// A commit's diff takes a hash only: never an option, a range or a revision expression.
func TestGitShowRejects(t *testing.T) {
	for _, h := range []string{"--output=x", "HEAD", "abc", "a1b2c3..d4e5f6", "a1b2c3^", "A1B2C3D"} {
		if _, err := GitShow("", h); err == nil {
			t.Fatalf("GitShow accepted %q", h)
		}
	}
}

func TestRefs(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
	repo, _ := filepath.EvalSymlinks(t.TempDir())
	os.WriteFile(filepath.Join(repo, "a.go"), []byte("func fooBar() {}\nvar x = fooBarBaz\n"), 0o644)
	os.WriteFile(filepath.Join(repo, "b.go"), []byte("// calls\n  fooBar()\n"), 0o644)
	os.MkdirAll(filepath.Join(repo, "d:x"), 0o755)
	os.WriteFile(filepath.Join(repo, "d:x", "c.go"), []byte(strings.Repeat("fooBar\n", 30)), 0o644)
	cmd := exec.Command("git", "init", "-q")
	cmd.Dir = repo
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git init: %v %s", err, out)
	}
	saved := config.Root
	config.Root = repo
	t.Cleanup(func() { config.Root = saved })

	got := Refs("fooBar") // untracked files count: what you just wrote is searched too
	want := []Ref{{"a.go", 1, "func fooBar() {}"}, {"b.go", 2, "fooBar()"}}
	for i := 1; i <= 20; i++ { // a colon in the path, and 20 a file at most
		want = append(want, Ref{"d:x/c.go", i, "fooBar"})
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Refs = %v, want %v", got, want)
	}
	for _, bad := range []string{"", "-e", "1x", "a b", "--open-files-in-pager=sh"} {
		if r := Refs(bad); len(r) != 0 {
			t.Errorf("Refs(%q) = %v, want none", bad, r)
		}
	}
}

func TestBlobAndDiscard(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
	repo, _ := filepath.EvalSymlinks(t.TempDir())
	run := func(args ...string) string {
		cmd := exec.Command("git", append([]string{"-c", "user.email=a@b", "-c", "user.name=a"}, args...)...)
		cmd.Dir = repo
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	f := filepath.Join(repo, "sub", "a.txt")
	os.MkdirAll(filepath.Dir(f), 0o755)
	os.WriteFile(f, []byte("one\n"), 0o644)
	run("init", "-q")
	run("add", ".")
	run("commit", "-qm", "init")
	head := run("rev-parse", "HEAD")
	os.WriteFile(f, []byte("two\n"), 0o644)
	run("add", ".")
	os.WriteFile(f, []byte("three\n"), 0o644)

	saved := config.Root
	config.Root = repo
	prefixCache.ok = false
	t.Cleanup(func() { config.Root = saved; prefixCache.ok = false })

	text := func(rev, path string, top bool) any {
		b, err := Blob("", rev, path, top)
		if err != nil {
			t.Fatalf("Blob(%q, %q): %v", rev, path, err)
		}
		return b["text"]
	}
	if got := text(head, "sub/a.txt", true); got != "one\n" {
		t.Errorf("at HEAD = %q", got)
	}
	if got := text("", "sub/a.txt", false); got != "two\n" {
		t.Errorf("in the index = %q", got)
	}
	if got := text(head, "sub/gone.txt", true); got != nil {
		t.Errorf("missing file = %q, want nil", got)
	}
	for _, bad := range [][2]string{{"HEAD~1", "sub/a.txt"}, {"--output=x", "sub/a.txt"}, {head, "../x"}} {
		if _, err := Blob("", bad[0], bad[1], true); err == nil {
			t.Errorf("Blob(%q, %q) took it", bad[0], bad[1])
		}
	}
	if !HasCommit("", head) || HasCommit("", strings.Repeat("0", 40)) || HasCommit("", "HEAD") {
		t.Errorf("HasCommit is wrong about %s, a missing commit or a name", head)
	}

	config.Root, prefixCache.ok = filepath.Join(repo, "sub"), false // Root below the repo's top: nothing above it is read
	if got := text(head, "sub/a.txt", true); got != "one\n" {
		t.Errorf("inside Root = %q", got)
	}
	for _, rev := range []string{head, ""} {
		if _, err := Blob("", rev, "secret.txt", true); err == nil {
			t.Errorf("Blob(%q, secret.txt) read outside Root", rev)
		}
	}
	config.Root, prefixCache.ok = repo, false

	read := func() string { b, _ := os.ReadFile(f); return string(b) }
	if r, _ := GitOp(map[string]any{"op": "discard", "paths": []any{"sub/a.txt"}}); r["ok"] != true || read() != "two\n" {
		t.Fatalf("discarding the unstaged edit: %v, file %q", r, read())
	}
	os.WriteFile(f, []byte("four\n"), 0o644)
	if r, _ := GitOp(map[string]any{"op": "discard", "staged": true, "paths": []any{"sub/a.txt"}}); r["ok"] != true || read() != "one\n" {
		t.Fatalf("discarding staged and unstaged: %v, file %q", r, read())
	}
	if run("status", "--porcelain") != "" {
		t.Errorf("still changed after discarding: %s", run("status", "--porcelain"))
	}
}

// Nested and Check share the worktree cache: a slow git costs one listing per repo per refresh, not one per call, and
// no lock is held while it runs.
func TestNestedGitOncePerRefresh(t *testing.T) {
	real, err := exec.LookPath("git")
	if err != nil {
		t.Skip("no git")
	}
	root, _ := filepath.EvalSymlinks(t.TempDir())
	for _, d := range []string{"", "sub"} {
		cmd := exec.Command("git", "init", "-q", filepath.Join(root, d))
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("init: %v %s", err, out)
		}
	}
	bin, log := t.TempDir(), filepath.Join(t.TempDir(), "log")
	script := "#!/bin/sh\ncase \" $* \" in *\" worktree \"*) echo x >> " + log + "; sleep 0.3;; esac\nexec " + real + " \"$@\"\n"
	os.WriteFile(filepath.Join(bin, "git"), []byte(script), 0o755)
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))

	saved := config.Root
	config.Root = root
	reset := func() {
		prefixCache.ok, nestedCache.list, stateCache.state, wtCache.list, wtCache.good = false, nil, nil, nil, nil
	}
	reset()
	t.Cleanup(func() { config.Root = saved; reset() })

	var wg sync.WaitGroup
	for range 10 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if n := Nested(); !reflect.DeepEqual(n, []string{"sub"}) {
				t.Errorf("Nested = %v", n)
			}
			if Check("sub") != nil || Check("nope") == nil {
				t.Error("Check")
			}
		}()
	}
	wg.Wait()
	b, _ := os.ReadFile(log)
	if n := strings.Count(string(b), "x"); n != 2 { // Root's repo and sub, once each
		t.Fatalf("git worktree ran %d times", n)
	}
}

// A worktree folder left behind after its admin entry is pruned keeps a .git file pointing at nothing: git says
// "not a repository" there, so it isn't listed as a repo of its own.
func TestStaleWorktreeFolder(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	base := t.TempDir()
	run := func(dir string, args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	repo := filepath.Join(base, "repo")
	os.MkdirAll(repo, 0o755)
	run(repo, "init", "-q", "-b", "main")
	run(repo, "commit", "-q", "--allow-empty", "-m", "first")
	run(repo, "worktree", "add", "-q", "-b", "live", filepath.Join(base, "live"))
	run(repo, "worktree", "add", "-q", "-b", "stale", filepath.Join(base, "stale"))
	if err := os.RemoveAll(filepath.Join(repo, ".git", "worktrees", "stale")); err != nil {
		t.Fatal(err)
	}
	got := findRepos(base)
	slices.Sort(got)
	if want := []string{"live", "repo"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("findRepos = %v, want %v", got, want)
	}
}
