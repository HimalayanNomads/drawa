package gitx

import (
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
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

	st := gitStatus("")
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
		gitStatus("")
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
	prefixCache.ok, nestedCache.list, stateCache.state = false, nil, nil
	t.Cleanup(func() { config.Root = saved; prefixCache.ok, nestedCache.list, stateCache.state = false, nil, nil })

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
	t.Cleanup(func() { config.Root = saved })

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
