package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"drawa/internal/images"
	"drawa/internal/live"
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

func TestBrowserGuards(t *testing.T) {
	h := Handler()
	do := func(method, path, ctype, fetchSite, body string) *http.Response {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Host = "127.0.0.1:8765"
		if method == "POST" {
			req.Header.Set("Origin", "http://127.0.0.1:8765")
			req.Header.Set("Content-Type", ctype)
		}
		if fetchSite != "" {
			req.Header.Set("Sec-Fetch-Site", fetchSite)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec.Result()
	}
	cid := `"cid":"0b7c1c2e-8f3a-4d1e-9c2b-1a2b3c4d5e6f"`
	cases := []struct {
		name                          string
		method, path, ctype, site, in string
		want                          int
	}{
		{"form-style POST", "POST", "/api/images", "text/plain;charset=UTF-8", "", `{"data":""}`, 415},
		{"JSON POST", "POST", "/api/images", "application/json", "", `{"data":""}`, 200},
		{"send, flag as sid", "POST", "/api/send", "application/json", "", `{` + cid + `,"sid":"--help"}`, 400},
		{"send, flag as model", "POST", "/api/send", "application/json", "", `{` + cid + `,"model":"-p"}`, 400},
		{"cross-site GET", "GET", "/api/gh", "", "cross-site", "", 403},
		{"same-origin GET", "GET", "/api/info", "", "same-origin", "", 200},
	}
	for _, c := range cases {
		resp := do(c.method, c.path, c.ctype, c.site, c.in)
		if resp.StatusCode != c.want {
			t.Errorf("%s: status %d, want %d", c.name, resp.StatusCode, c.want)
		}
		if resp.Header.Get("X-Frame-Options") != "DENY" || !strings.Contains(resp.Header.Get("Content-Security-Policy"), "frame-ancestors 'none'") {
			t.Errorf("%s: missing anti-framing headers", c.name)
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
