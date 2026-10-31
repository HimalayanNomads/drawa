package server

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"drawa/internal/config"
	"drawa/internal/live"
	"drawa/internal/sessions"
	"drawa/internal/uploads"
)

func call(t *testing.T, srv *httptest.Server, method, path, body string) (int, string) {
	t.Helper()
	req, _ := http.NewRequest(method, srv.URL+path, strings.NewReader(body))
	req.Host = selfHost
	if method == "POST" {
		req.Header.Set("Origin", selfOrigin)
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
	line := `{"type":"user","message":{"role":"user","content":"hello there"}}` + "\n" +
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}` + "\n"
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

// An agent that can't start answers with why, and a missing CLI with where to get it (not a bare 500).
func TestStartFailureSaysWhy(t *testing.T) {
	t.Setenv("PATH", t.TempDir()) // no agent CLI anywhere
	srv := httptest.NewServer(Handler())
	defer srv.Close()
	status, body := call(t, srv, "POST", "/api/send", `{"cid":"55555555-5555-5555-5555-555555555555","p":"hi"}`)
	var j map[string]string
	if status != 500 || json.Unmarshal([]byte(body), &j) != nil || !strings.Contains(j["error"], "install it: https://") {
		t.Fatalf("send with no claude on PATH: %d %s", status, body)
	}
}

// panickingHistory is a backend history whose every call panics.
type panickingHistory struct{}

func (panickingHistory) List() []sessions.Info { panic("boom") }
func (panickingHistory) Load(string, string) ([]map[string]any, bool) {
	panic("boom")
}
func (panickingHistory) Search(string) []sessions.Info { panic("boom") }

func TestHistoryOfBackendSurvivesAPanic(t *testing.T) {
	for _, query := range []string{"", "login"} { // its list, and its search (where Codex pages through app-server)
		if found := historyOfBackend("broken", panickingHistory{}, query); found != nil {
			t.Fatalf("a panicking backend should be left out (query %q): %v", query, found)
		}
	}
}

type fakeBackendForPDF struct {
	lastSent any
}

func (f *fakeBackendForPDF) Send(content any, id string) error {
	f.lastSent = content
	return nil
}
func (f *fakeBackendForPDF) Respond(rid, ask string, a live.Answer) error { return nil }
func (f *fakeBackendForPDF) SetMode(mode string) error                    { return nil }
func (f *fakeBackendForPDF) SetModel(model string) error                  { return nil }
func (f *fakeBackendForPDF) Interrupt() error                             { return nil }
func (f *fakeBackendForPDF) Close()                                       {}
func (f *fakeBackendForPDF) Kill()                                        {}

func TestPDFContentValidationAndTextOnly(t *testing.T) {
	tempUploads := t.TempDir()
	t.Setenv("HOME", tempUploads)
	t.Setenv("USERPROFILE", tempUploads)

	fakeTextOnly := &fakeBackendForPDF{}
	live.Register("fake-text-only", live.Kind{
		Title:    "Fake Text Agent",
		TextOnly: true,
		Modes:    map[string]bool{"default": true},
		Spawn: func(spec live.Spec, sink live.Sink) (live.Backend, error) {
			return fakeTextOnly, nil
		},
	})

	fakeRich := &fakeBackendForPDF{}
	live.Register("fake-rich", live.Kind{
		Title: "Fake Rich Agent",
		Modes: map[string]bool{"default": true},
		Spawn: func(spec live.Spec, sink live.Sink) (live.Backend, error) {
			return fakeRich, nil
		},
	})

	srv := httptest.NewServer(Handler())
	defer srv.Close()

	validPDFb64 := base64.StdEncoding.EncodeToString([]byte("%PDF-1.4\nvalid test content"))
	invalidPDFb64 := base64.StdEncoding.EncodeToString([]byte("NOT A PDF header"))

	// 1. TextOnly kind + PDF content -> 400 + JSON error naming the backend + uploads dir empty
	cid1 := "11111111-1111-1111-1111-111111111111"
	reqBody1, _ := json.Marshal(map[string]any{
		"cid":     cid1,
		"backend": "fake-text-only",
		"mode":    "default",
		"p": []any{
			map[string]any{
				"type":  "document",
				"title": "doc.pdf",
				"source": map[string]any{
					"type":       "base64",
					"media_type": "application/pdf",
					"data":       validPDFb64,
				},
			},
		},
	})
	status1, body1 := call(t, srv, "POST", "/api/send", string(reqBody1))
	if status1 != 400 {
		t.Fatalf("expected 400 for text-only with PDF, got %d: %s", status1, body1)
	}
	var errResp1 map[string]string
	if err := json.Unmarshal([]byte(body1), &errResp1); err != nil {
		t.Fatalf("failed to unmarshal JSON: %v", err)
	}
	wantMsg := "Fake Text Agent takes text only; PDFs can't be attached"
	if errResp1["error"] != wantMsg {
		t.Errorf("error message mismatch: got %q, want %q", errResp1["error"], wantMsg)
	}
	entries, _ := os.ReadDir(uploads.BaseDir())
	if len(entries) != 0 {
		t.Errorf("expected uploads dir to be empty, found: %v", entries)
	}

	// 2. Invalid PDF (%PDF- missing) -> 400 on normal kind
	cid2 := "22222222-2222-2222-2222-222222222222"
	reqBody2, _ := json.Marshal(map[string]any{
		"cid":     cid2,
		"backend": "fake-rich",
		"mode":    "default",
		"p": []any{
			map[string]any{
				"type":  "document",
				"title": "bad.pdf",
				"source": map[string]any{
					"type":       "base64",
					"media_type": "application/pdf",
					"data":       invalidPDFb64,
				},
			},
		},
	})
	status2, body2 := call(t, srv, "POST", "/api/send", string(reqBody2))
	if status2 != 400 {
		t.Fatalf("expected 400 for bad PDF, got %d: %s", status2, body2)
	}
	var errResp2 map[string]string
	_ = json.Unmarshal([]byte(body2), &errResp2)
	if !strings.Contains(errResp2["error"], "\"bad.pdf\" is not a PDF file") {
		t.Errorf("expected error message to state bad.pdf is not a PDF file, got: %q", errResp2["error"])
	}

	// 3. Valid PDF reaches Send unchanged and writes nothing to disk
	cid3 := "33333333-3333-3333-3333-333333333333"
	reqBody3, _ := json.Marshal(map[string]any{
		"cid":     cid3,
		"backend": "fake-rich",
		"mode":    "default",
		"p": []any{
			map[string]any{
				"type":  "document",
				"title": "valid.pdf",
				"source": map[string]any{
					"type":       "base64",
					"media_type": "application/pdf",
					"data":       validPDFb64,
				},
			},
		},
	})
	status3, body3 := call(t, srv, "POST", "/api/send", string(reqBody3))
	if status3 != 200 {
		t.Fatalf("expected 200 for valid send, got %d: %s", status3, body3)
	}
	if fakeRich.lastSent == nil {
		t.Fatalf("expected fakeRich to receive content")
	}
	blocks, ok := fakeRich.lastSent.([]any)
	if !ok || len(blocks) != 1 {
		t.Fatalf("expected content to be slice with 1 block, got: %v", fakeRich.lastSent)
	}
	docBlock, ok := blocks[0].(map[string]any)
	if !ok || docBlock["type"] != "document" || docBlock["title"] != "valid.pdf" {
		t.Fatalf("expected document block unchanged, got: %v", docBlock)
	}
	sessEntries, _ := os.ReadDir(uploads.BaseDir())
	if len(sessEntries) != 0 {
		t.Errorf("expected no files on disk, found %v", sessEntries)
	}
}
