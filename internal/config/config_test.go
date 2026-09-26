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

func TestOpenedCatchesSwappedLink(t *testing.T) {
	base, _ := filepath.EvalSymlinks(t.TempDir())
	old := Root
	t.Cleanup(func() { Root = old })
	Root = filepath.Join(base, "root")
	os.MkdirAll(Root, 0o755)
	os.WriteFile(filepath.Join(base, "secret"), []byte("x"), 0o600)
	os.WriteFile(filepath.Join(Root, "ok"), []byte("x"), 0o600)
	p, err := Inside("f")
	if err != nil {
		t.Fatal(err)
	}
	os.Symlink(filepath.Join(base, "secret"), p) // swapped in after Inside approved the path
	f, _ := os.Open(p)
	defer f.Close()
	if Opened(f, p) == nil {
		t.Error("Opened accepted a file outside Root")
	}
	g, _ := os.Open(filepath.Join(Root, "ok"))
	defer g.Close()
	if err := Opened(g, filepath.Join(Root, "ok")); err != nil {
		t.Errorf("Opened refused a file inside Root: %v", err)
	}
}

func TestNetTokenSurvivesRestart(t *testing.T) {
	oldNet := Net
	t.Cleanup(func() { Net = oldNet; os.Unsetenv(netTokenEnv) })
	Net = true
	os.Unsetenv(netTokenEnv)
	a := netToken()
	if len(a) < 22 || os.Getenv(netTokenEnv) != a {
		t.Fatalf("token %q not long enough or not kept in the environment", a)
	}
	if b := netToken(); b != a {
		t.Errorf("re-exec'd process got a new token %q, want %q", b, a)
	}
}
