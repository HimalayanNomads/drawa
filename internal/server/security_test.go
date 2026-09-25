package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"claude-ui/internal/images"
	"claude-ui/internal/live"
)

func TestRequestChecks(t *testing.T) {
	lv := live.NewForTest("t"+strings.Repeat("1", 31), "g1")
	live.Mu.Lock()
	live.Registry["sec"] = lv
	live.Mu.Unlock()
	t.Cleanup(func() {
		live.Mu.Lock()
		delete(live.Registry, "sec")
		live.Mu.Unlock()
	})
	srv := httptest.NewServer(Handler())
	defer srv.Close()

	good := "127.0.0.1:8765"
	cases := []struct {
		name, method, path, host, origin string
	}{
		{"GET bad host", "GET", "/api/files", "evil.com:8765", ""},
		{"POST bad host", "POST", "/api/images", "evil.com", "http://127.0.0.1:8765"},
		{"POST no origin", "POST", "/api/images", good, ""},
		{"POST evil origin", "POST", "/api/images", good, "http://evil.com"},
		{"POST null origin", "POST", "/api/images", good, "null"},
		{"MCP with origin", "POST", "/mcp/sec/" + lv.Token, good, "http://127.0.0.1:8765"},
		{"MCP bad token", "POST", "/mcp/sec/" + strings.Repeat("0", 32), good, ""},
	}
	for _, c := range cases {
		req, _ := http.NewRequest(c.method, srv.URL+c.path, strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"ping"}`))
		req.Host = c.host
		if c.origin != "" {
			req.Header.Set("Origin", c.origin)
		}
		resp, err := srv.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != 403 {
			t.Errorf("%s: status %d, want 403", c.name, resp.StatusCode)
		}
	}
}

func TestStashRefusesSpecialFiles(t *testing.T) {
	for _, p := range []string{"/dev/zero", t.TempDir()} {
		if _, err := images.Stash(p); err == nil {
			t.Errorf("Stash(%q) accepted", p)
		}
	}
}
