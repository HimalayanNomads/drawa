package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestInside(t *testing.T) {
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(base, "root")
	os.MkdirAll(filepath.Join(root, "sub"), 0o755)
	os.MkdirAll(filepath.Join(base, "root2"), 0o755)
	os.Symlink("/etc", filepath.Join(root, "lnk"))
	os.Symlink(filepath.Join(root, "sub"), filepath.Join(root, "in"))
	os.Symlink(filepath.Join(base, "root2"), filepath.Join(root, "sib"))

	old := Root
	t.Cleanup(func() { Root = old })
	cases := []struct {
		root, rel string
		ok        bool
	}{
		{root, "sub/new.txt", true},
		{root, "", true},
		{root, "in/new.txt", true},
		{root, filepath.Join(root, "sub"), true}, // absolute, but inside
		{root, "..", false},
		{root, "sub/../../x", false},
		{root, "/etc/passwd", false},
		{root, "lnk", false},
		{root, "lnk/passwd", false},
		{root, "lnk/nonexistent/deeper", false},
		{root, "../root2/x", false}, // /root vs /root2 prefix
		{root, "sib/x", false},
		{"/", "etc/passwd", true},
		{"/", "/tmp", true},
	}
	for _, c := range cases {
		Root = c.root
		_, err := Inside(c.rel)
		if (err == nil) != c.ok {
			t.Errorf("Inside(%q) with Root %q: err=%v, want ok=%v", c.rel, c.root, err, c.ok)
		}
	}
}
