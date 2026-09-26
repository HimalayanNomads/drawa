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

	st := gitStatus()
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
	d, err := GitDiff("a.txt", true)
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
