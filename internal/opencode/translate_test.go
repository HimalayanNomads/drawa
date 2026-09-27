package opencode

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"drawa/internal/live"
)

// replay runs a recorded /event stream through a translator for the session that stream's card created (the first
// session.created without a parent).
func replay(t *testing.T, path string) []string {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var frames [][]byte
	sid := ""
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 1<<24)
	for sc.Scan() {
		b := append([]byte(nil), sc.Bytes()...)
		frames = append(frames, b)
		var d struct {
			Type       string `json:"type"`
			Properties struct {
				Info struct {
					ID       string `json:"id"`
					ParentID string `json:"parentID"`
				} `json:"info"`
			} `json:"properties"`
		}
		if sid == "" && json.Unmarshal(b, &d) == nil && d.Type == "session.created" && d.Properties.Info.ParentID == "" {
			sid = d.Properties.Info.ID
		}
	}
	tr := newTranslator(sid, "opencode/big-pickle")
	var out []string
	for _, fr := range frames {
		out = append(out, tr.frame(fr)...)
	}
	return out
}

// replayV2 runs a recorded v2 /api/event stream (testdata/v2/*.sse) through a v2 translator for the session the
// first event naming one belongs to (v2's frames carry data.sessionID directly, unlike v1's nested info.id).
func replayV2(t *testing.T, path string) []string {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var frames [][]byte
	sid := ""
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 1<<24)
	for sc.Scan() {
		b := append([]byte(nil), sc.Bytes()...)
		frames = append(frames, b)
		var d struct {
			Data struct {
				SessionID string `json:"sessionID"`
			} `json:"data"`
		}
		if sid == "" && json.Unmarshal(b, &d) == nil && d.Data.SessionID != "" {
			sid = d.Data.SessionID
		}
	}
	tr := newTranslatorV2(sid, "opencode/space-bunny-free")
	var out []string
	for _, fr := range frames {
		out = append(out, tr.frame(fr)...)
	}
	return out
}

func checkFixtures(t *testing.T, pattern string, replay func(*testing.T, string) []string) {
	t.Helper()
	files, _ := filepath.Glob(pattern)
	if len(files) == 0 {
		t.Fatal("no fixtures")
	}
	for _, f := range files {
		lines := replay(t, f)
		if err := live.CheckWire(lines); err != nil {
			t.Errorf("%s: %v", f, err)
		}
		// golden: the expected translation, reviewed by hand; UPDATE=1 rewrites it after a deliberate change
		want := strings.TrimSuffix(f, ".sse") + ".want.jsonl"
		got := strings.Join(lines, "\n") + "\n"
		if os.Getenv("UPDATE") != "" {
			os.WriteFile(want, []byte(got), 0o644)
		} else if b, err := os.ReadFile(want); err != nil || string(b) != got {
			t.Errorf("%s: translation differs from %s (UPDATE=1 go test to accept a deliberate change)", f, want)
		}
		if os.Getenv("SHOW") != "" {
			t.Logf("=== %s (%d lines)", f, len(lines))
			for _, l := range lines {
				if len(l) > 220 {
					l = l[:220] + "…"
				}
				t.Log(l)
			}
		}
	}
}

// Every recorded session translates into a stream the page can read.
func TestFixturesPassCheckWire(t *testing.T) { checkFixtures(t, "testdata/*.sse", replay) }

// Same, for OpenCode v2's differently-shaped events (translate2.go).
func TestV2FixturesPassCheckWire(t *testing.T) { checkFixtures(t, "testdata/v2/*.sse", replayV2) }
