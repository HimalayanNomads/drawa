package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"drawa/internal/config"
)

func call(t *testing.T, srv *httptest.Server, method, path, body string) (int, string) {
	t.Helper()
	req, _ := http.NewRequest(method, srv.URL+path, strings.NewReader(body))
	req.Host = "127.0.0.1:8765"
	if method == "POST" {
		req.Header.Set("Origin", "http://127.0.0.1:8765")
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

// A card op naming a backend nobody registered is refused before anything starts.
func TestUnknownBackendRefused(t *testing.T) {
	srv := httptest.NewServer(Handler())
	defer srv.Close()
	cid := "22222222-2222-2222-2222-222222222222"
	for _, path := range []string{"/api/send", "/api/respond", "/api/mode", "/api/interrupt"} {
		status, _ := call(t, srv, "POST", path, `{"cid":"`+cid+`","backend":"nope","p":"hi","mode":"default"}`)
		if status != 400 {
			t.Errorf("%s with an unknown backend: status %d, want 400", path, status)
		}
	}
}

// The history list and a session read through the claude backend's History, as before backends existed, plus a
// backend tag on each entry; other backends' ids and unknown backends are refused.
func TestSessionsThroughHistory(t *testing.T) {
	saved := config.Sessions
	config.Sessions = t.TempDir()
	t.Cleanup(func() { config.Sessions = saved })
	sid := "33333333-3333-3333-3333-333333333333"
	line := `{"type":"user","message":{"role":"user","content":"hello there"}}` + "\n"
	if err := os.WriteFile(filepath.Join(config.Sessions, sid+".jsonl"), []byte(line), 0o600); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(Handler())
	defer srv.Close()

	status, body := call(t, srv, "GET", "/api/sessions", "")
	var list []map[string]any
	if status != 200 || json.Unmarshal([]byte(body), &list) != nil || len(list) != 1 {
		t.Fatalf("/api/sessions: %d %s", status, body)
	}
	if list[0]["id"] != sid || list[0]["backend"] != "claude" || list[0]["title"] == nil || list[0]["mtime"] == nil {
		t.Fatalf("/api/sessions entry: %v", list[0])
	}

	for q, want := range map[string]int{
		"?id=" + sid:                               200,
		"?id=" + sid + "&backend=claude":           200,
		"?id=" + sid + "&backend=nope":             404,
		"?id=ses_abc":                              404,
		"?id=44444444-4444-4444-4444-444444444444": 404,
	} {
		if status, body := call(t, srv, "GET", "/api/session"+q, ""); status != want {
			t.Errorf("/api/session%s: %d %s, want %d", q, status, body, want)
		}
	}
	_, body = call(t, srv, "GET", "/api/session?id=44444444-4444-4444-4444-444444444444", "")
	if !strings.Contains(body, `"missing":true`) {
		t.Errorf("a session not written yet should say missing: %s", body)
	}
}
