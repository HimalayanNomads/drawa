package server

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Exercise the actual preferences routes and file, isolated from the user's configuration.
func TestCompletionPrefsRoutes(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	path := filepath.Join(home, ".drawa", "config.json")
	os.MkdirAll(filepath.Dir(path), 0o755)
	os.WriteFile(path, []byte(`{"ui":"minimal","mine":true}`), 0o644)
	srv := httptest.NewServer(Handler())
	defer srv.Close()
	if code, body := call(t, srv, "GET", "/api/prefs", ""); code != 200 || !strings.Contains(body, `"completion":"toast"`) {
		t.Fatalf("default completion: %d %s", code, body)
	}
	for _, mode := range []string{"browser", "toast", "none"} {
		want := mode
		if mode == "browser" {
			want = "toast"
		}
		if code, body := call(t, srv, "POST", "/api/prefs", `{"completion":"`+mode+`"}`); code != 200 || !strings.Contains(body, `"completion":"`+want+`"`) {
			t.Fatalf("save %s: %d %s", mode, code, body)
		}
		if code, body := call(t, srv, "GET", "/api/prefs", ""); code != 200 || !strings.Contains(body, `"completion":"`+want+`"`) {
			t.Fatalf("read %s: %d %s", mode, code, body)
		}
		var saved map[string]any
		data, err := os.ReadFile(path)
		if err != nil || json.Unmarshal(data, &saved) != nil || saved["completion"] != want || saved["mine"] != true || saved["ui"] != "minimal" {
			t.Fatalf("saved %s: %s, %v", mode, data, err)
		}
	}
	before, _ := os.ReadFile(path)
	for _, body := range []string{`{"completion":"sound"}`, `{"completion":"invalid"}`, `{"completion":false}`, `{"completion":"toast","ui":"tiny"}`} {
		if code, reply := call(t, srv, "POST", "/api/prefs", body); code != 400 {
			t.Errorf("%s: %d %s", body, code, reply)
		}
		if after, _ := os.ReadFile(path); string(after) != string(before) {
			t.Fatal("invalid request changed the settings file")
		}
	}
	os.WriteFile(path, []byte(`{"completion":"toast","mine":true}`), 0o644)
	if code, body := call(t, srv, "GET", "/api/prefs", ""); code != 200 || !strings.Contains(body, `"completion":"toast"`) {
		t.Fatalf("hand edit: %d %s", code, body)
	}
	broken := `{"completion":`
	os.WriteFile(path, []byte(broken), 0o644)
	if code, body := call(t, srv, "POST", "/api/prefs", `{"completion":"none"}`); code != 500 {
		t.Fatalf("broken config: %d %s", code, body)
	}
	if after, _ := os.ReadFile(path); string(after) != broken {
		t.Fatal("broken config overwritten")
	}
}

// The page reads and changes ~/.drawa/config.json through /api/prefs; a change outside a setting's choices is refused.
func TestPrefsRoutes(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	srv := httptest.NewServer(Handler())
	defer srv.Close()
	for _, c := range []struct {
		method, body string
		code         int
		want         string
	}{
		{"GET", "", 200, `"ui":"full"`},
		{"POST", `{"ui":"minimal"}`, 200, `"ui":"minimal"`},
		{"POST", `{"ui":"huge"}`, 400, `invalid setting`},
		{"POST", `{}`, 400, `nothing to change`},
		{"GET", "", 200, `"ui":"minimal"`},
	} {
		if code, body := call(t, srv, c.method, "/api/prefs", c.body); code != c.code || !strings.Contains(body, c.want) {
			t.Errorf("%s %s: %d %s, want %d with %s", c.method, c.body, code, body, c.code, c.want)
		}
	}
}

// /api/symbols says whether ctags is there; with symbols turned off in your settings, lookups answer an empty list.
func TestSymbolsRoute(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	srv := httptest.NewServer(Handler())
	defer srv.Close()
	if code, body := call(t, srv, "GET", "/api/symbols", ""); code != 200 || !strings.Contains(body, `"installed":`) {
		t.Errorf("status: %d %s", code, body)
	}
	if code, body := call(t, srv, "POST", "/api/prefs", `{"symbols":"off"}`); code != 200 || !strings.Contains(body, `"symbols":"off"`) {
		t.Fatalf("turning symbols off: %d %s", code, body)
	}
	for _, path := range []string{"/api/symbols?q=find", "/api/symbols?def=Find"} {
		if code, body := call(t, srv, "GET", path, ""); code != 200 || body != "[]" {
			t.Errorf("%s with symbols off: %d %s", path, code, body)
		}
	}
}
