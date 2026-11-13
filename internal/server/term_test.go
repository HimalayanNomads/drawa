package server

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"drawa/internal/config"
	"drawa/internal/term"
)

// A terminal opened over POST /api/term streams its output on /api/events (tagged "_t"), takes keys, and reports
// "gone" once closed.
func TestTerminalOverHTTP(t *testing.T) {
	if !term.Supported() {
		t.Skip("no pseudo-terminals here")
	}
	saved := config.Root
	config.Root, _ = filepath.EvalSymlinks(t.TempDir())
	t.Cleanup(func() { config.Root = saved })
	t.Setenv("SHELL", "/bin/sh")
	t.Setenv("HOME", t.TempDir()) // the shell setting is read from ~/.drawa: none here
	t.Setenv("ENV", "")
	srv := httptest.NewServer(Handler())
	defer srv.Close()

	if code, _ := call(t, srv, "POST", "/api/term", `{"op":"open","cwd":"..","cols":80,"rows":24}`); code != 403 {
		t.Fatalf("open outside the project: %d", code)
	}
	if code, _ := call(t, srv, "POST", "/api/term", `{"op":"keys","id":"../../x","data":"hi"}`); code != 400 {
		t.Fatalf("bad id: %d", code)
	}
	code, body := call(t, srv, "POST", "/api/term", `{"op":"open","cols":80,"rows":24}`)
	var opened struct{ ID string }
	if json.Unmarshal([]byte(body), &opened); code != 200 || opened.ID == "" {
		t.Fatalf("open: %d %s", code, body)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+"/api/events?page=abcd1234&t="+opened.ID+":0", nil)
	req.Host = selfHost
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	call(t, srv, "POST", "/api/term", `{"op":"keys","id":"`+opened.ID+`","data":"echo h''i\r"}`)

	rd, seen := bufio.NewReader(resp.Body), ""
	for !strings.Contains(seen, "hi\r\n") {
		line, err := rd.ReadString('\n')
		if err != nil {
			t.Fatalf("stream ended before the output; saw %q", seen)
		}
		var msg struct {
			T    string `json:"_t"`
			Data string
		}
		json.Unmarshal([]byte(line), &msg)
		if msg.T != opened.ID {
			continue
		}
		raw, _ := base64.StdEncoding.DecodeString(msg.Data)
		seen += string(raw)
	}

	if code, _ := call(t, srv, "POST", "/api/term", `{"op":"close","id":"`+opened.ID+`"}`); code != 200 {
		t.Fatalf("close: %d", code)
	}
	for {
		line, err := rd.ReadString('\n')
		if err != nil {
			t.Fatal("no gone line after close")
		}
		if strings.Contains(line, `"gone":true`) {
			break
		}
	}
	if code, _ := call(t, srv, "POST", "/api/term", `{"op":"keys","id":"`+opened.ID+`","data":"x"}`); code != 404 {
		t.Fatalf("keys after close: %d", code)
	}
}
