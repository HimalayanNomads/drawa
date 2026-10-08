package server

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"net/http/httptest"

	"drawa/internal/config"
)

// POST /api/file saves only over the text the page read: a stale copy is a 409 the page can recover from, a
// file it may not write a 403, a path out of the project a 403.
func TestFileSaveRoute(t *testing.T) {
	root, _ := filepath.EvalSymlinks(t.TempDir())
	old := config.Root
	config.Root = root
	t.Cleanup(func() { config.Root = old })
	os.WriteFile(filepath.Join(root, "a.txt"), []byte("one\n"), 0o644)
	os.WriteFile(filepath.Join(root, "ro.txt"), []byte("x"), 0o444)
	srv := httptest.NewServer(Handler())
	defer srv.Close()
	cases := []struct {
		body string
		code int
	}{
		{`{"path":"a.txt","base":"one\n","text":"two\n"}`, 200},
		{`{"path":"a.txt","base":"one\n","text":"three\n"}`, 409}, // the copy it started from is gone
		{`{"path":"../a.txt","base":"","text":"x"}`, 403},
		{`{"path":"missing.txt","base":"","text":"x"}`, 404},
		{`{"path":"a.txt","base":"two\n","text":"` + strings.Repeat("x", 1_000_001) + `"}`, 413},
	}
	if os.Getuid() != 0 {
		cases = append(cases, struct {
			body string
			code int
		}{`{"path":"ro.txt","base":"x","text":"y"}`, 403})
	}
	for _, c := range cases {
		if code, body := call(t, srv, "POST", "/api/file", c.body); code != c.code {
			t.Errorf("%s: %d %s, want %d", c.body, code, body, c.code)
		}
	}
	if b, _ := os.ReadFile(filepath.Join(root, "a.txt")); !strings.HasPrefix(string(b), "two") {
		t.Errorf("a.txt holds %q", b)
	}
}
