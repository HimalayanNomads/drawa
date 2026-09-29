package server

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"drawa/internal/config"
)

func TestNetAuth(t *testing.T) {
	oldNet, oldToken, oldHosts := config.Net, config.NetToken, config.Hosts
	config.Net = true
	config.NetToken = "testtok1testtok1testtok1"
	config.Hosts = map[string]bool{"127.0.0.1:8765": true, "localhost:8765": true, "10.0.0.5:8765": true}
	t.Cleanup(func() {
		config.Net, config.NetToken, config.Hosts = oldNet, oldToken, oldHosts
		netAuthMu.Lock()
		netFails, netLocked = map[string]int{}, map[string]time.Time{}
		netAuthMu.Unlock()
	})

	h := Handler()
	const netHost = "10.0.0.5:8765" // stands in for this machine's LAN address
	get := func(path, host, from string, cookies ...*http.Cookie) *http.Response {
		t.Helper()
		req := httptest.NewRequest("GET", path, nil)
		req.Host, req.RemoteAddr = host, from
		for _, c := range cookies {
			req.AddCookie(c)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec.Result()
	}
	const lan, lan2 = "10.0.0.9:5000", "10.0.0.10:5000"

	if resp := get("/api/info", netHost, lan); resp.StatusCode != 403 {
		t.Errorf("network client, no token: status %d, want 403", resp.StatusCode)
	}
	if resp := get("/api/info", "localhost:8765", lan); resp.StatusCode != 403 {
		t.Errorf("network client forging Host: localhost: status %d, want 403", resp.StatusCode)
	}
	if resp := get("/api/info", "127.0.0.1:8765", "127.0.0.1:5000"); resp.StatusCode != 200 {
		t.Errorf("loopback client, no token: status %d, want 200", resp.StatusCode)
	}

	resp := get("/?token="+config.NetToken+"&x=1", netHost, lan)
	if resp.StatusCode != 302 || resp.Header.Get("Location") != "/?x=1" {
		t.Fatalf("valid token: status %d to %q, want 302 to /?x=1", resp.StatusCode, resp.Header.Get("Location"))
	}
	var cookie *http.Cookie
	for _, c := range resp.Cookies() {
		if c.Name == netCookie {
			cookie = c
		}
	}
	if cookie == nil {
		t.Fatal("valid token didn't set the auth cookie")
	}
	if resp := get("/api/info", netHost, lan, cookie); resp.StatusCode != 200 {
		t.Errorf("cookie from earlier valid token: status %d, want 200", resp.StatusCode)
	}

	stale := &http.Cookie{Name: netCookie, Value: "from-an-earlier-run"}
	for i := 0; i < 2*maxNetAttempts; i++ {
		get("/favicon.ico", netHost, lan2, stale)
	}
	if lockedOut("10.0.0.10") {
		t.Error("a stale cookie and missing tokens locked the address out")
	}
	// a stale cookie says what to do: text for the page, JSON the page's ping reads as signed out
	if b, _ := io.ReadAll(get("/", netHost, lan2, stale).Body); !strings.Contains(string(b), "Network link") {
		t.Errorf("stale cookie, page load: body %q", b)
	}
	if b, _ := io.ReadAll(get("/api/info", netHost, lan2, stale).Body); !strings.Contains(string(b), `"signedOut":true`) {
		t.Errorf("stale cookie, /api/info: body %q", b)
	}

	for i := 0; i < maxNetAttempts; i++ {
		get("/api/info?token=wrong", netHost, lan)
	}
	if resp := get("/api/info?token="+config.NetToken, netHost, lan); resp.StatusCode != 403 {
		t.Errorf("locked-out address, even with the right token: status %d, want 403", resp.StatusCode)
	}
	netAuthMu.Lock()
	netLocked["10.0.0.9"] = time.Now().Add(-time.Second)
	netAuthMu.Unlock()
	if lockedOut("10.0.0.9") || len(netLocked) != 0 {
		t.Error("an expired lock wasn't lifted and dropped")
	}
}
