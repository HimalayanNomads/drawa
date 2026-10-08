package filesx

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSave(t *testing.T) {
	root := useRoot(t)
	p := filepath.Join(root, "a.sh")
	os.WriteFile(p, []byte("echo 1\n"), 0o755)

	if err := Save("a.sh", "echo 1\n", "echo 2\n"); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(p); string(b) != "echo 2\n" {
		t.Errorf("saved %q", b)
	}
	if info, _ := os.Stat(p); info.Mode().Perm() != 0o755 {
		t.Errorf("mode %v, want 0755", info.Mode().Perm())
	}
	// the page's copy is stale: refuse rather than throw away what's on disk
	if err := Save("a.sh", "echo 1\n", "echo 3\n"); !errors.Is(err, ErrChanged) {
		t.Errorf("stale base: %v", err)
	}
	// too big to have been read whole: the page only ever saw the start
	big := make([]byte, maxRead+10)
	for i := range big {
		big[i] = 'x'
	}
	os.WriteFile(filepath.Join(root, "big"), big, 0o644)
	if err := Save("big", string(big[:maxRead]), "x"); !errors.Is(err, ErrChanged) {
		t.Errorf("big file: %v", err)
	}
	// not UTF-8: the page saw replacement characters, saving them would rewrite every such byte
	os.WriteFile(filepath.Join(root, "latin1"), []byte("caf\xe9\n"), 0o644)
	if err := Save("latin1", "caf\uFFFD\n", "x"); !errors.Is(err, ErrChanged) {
		t.Errorf("not UTF-8: %v", err)
	}
	if os.Getuid() != 0 { // root may write anything
		os.WriteFile(filepath.Join(root, "ro"), []byte("a"), 0o444)
		if err := Save("ro", "a", "b"); !errors.Is(err, ErrReadOnly) {
			t.Errorf("read-only: %v", err)
		}
	}
	if err := Save("../outside", "", "x"); err == nil {
		t.Error("saved outside the project")
	}
	if left, _ := filepath.Glob(filepath.Join(root, ".*drawa-*")); len(left) > 0 {
		t.Errorf("temp files left: %v", left)
	}
}

// Get says when the editor mustn't save a file's text back, and why.
func TestGetNoEdit(t *testing.T) {
	root := useRoot(t)
	for name, c := range map[string]struct {
		data string
		why  string
	}{
		"plain":   {"a\nb\n", ""},
		"windows": {"a\r\nb\r\n", ""},
		"oldmac":  {"a\rb\r", "old Mac"},
		"mixed":   {"a\r\nb\n", "mixes"},
		"latin1":  {"caf\xe9", "UTF-8"},
		"big":     {strings.Repeat("x", maxRead+1), "1 MB"},
	} {
		os.WriteFile(filepath.Join(root, name), []byte(c.data), 0o644)
		got, err := Get(name)
		if err != nil {
			t.Fatal(name, err)
		}
		why, _ := got["noEdit"].(string)
		if (c.why == "") != (why == "") || !strings.Contains(why, c.why) {
			t.Errorf("%s: noEdit %q, want %q", name, why, c.why)
		}
	}
	if os.Getuid() != 0 {
		os.WriteFile(filepath.Join(root, "ro"), []byte("a"), 0o444)
		if got, _ := Get("ro"); got["noEdit"] != "it's read-only" {
			t.Errorf("read-only: %v", got["noEdit"])
		}
	}
}

// Saving through a link inside the project writes the file it points to and leaves the link a link; a link out
// of the project is refused.
func TestSaveSymlinks(t *testing.T) {
	root := useRoot(t)
	os.WriteFile(filepath.Join(root, "real"), []byte("a"), 0o644)
	os.Symlink("real", filepath.Join(root, "link"))
	if err := Save("link", "a", "b"); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(root, "real")); string(b) != "b" {
		t.Errorf("target holds %q", b)
	}
	if fi, _ := os.Lstat(filepath.Join(root, "link")); fi.Mode()&os.ModeSymlink == 0 {
		t.Error("the link was replaced by a file")
	}
	out := filepath.Join(t.TempDir(), "out")
	os.WriteFile(out, []byte("a"), 0o644)
	os.Symlink(out, filepath.Join(root, "away"))
	if err := Save("away", "a", "b"); err == nil {
		t.Error("saved through a link out of the project")
	}
	if b, _ := os.ReadFile(out); string(b) != "a" {
		t.Errorf("outside file changed to %q", b)
	}
}

// A writable file in a folder that can't take a new file is written in place.
func TestSaveInLockedFolder(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("root writes anywhere")
	}
	root := useRoot(t)
	dir := filepath.Join(root, "locked")
	os.Mkdir(dir, 0o755)
	os.WriteFile(filepath.Join(dir, "f"), []byte("a"), 0o644)
	os.Chmod(dir, 0o555)
	t.Cleanup(func() { os.Chmod(dir, 0o755) })
	if err := Save("locked/f", "a", "b"); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "f")); string(b) != "b" {
		t.Errorf("saved %q", b)
	}
}
