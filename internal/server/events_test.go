package server

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"drawa/internal/live"
)

// A page whose position fell out of the buffer gets attach, then a "_gap" marker flagged "_r" (not counted), then
// the buffer's lines.
func TestGapMarker(t *testing.T) {
	const cid = "cccccccc-0000-0000-0000-000000000000"
	lv := live.NewForTest("", "g1")
	for i := 0; i <= live.Keep; i++ { // one past Keep: the older half is dropped
		lv.Push(`{"type":"x"}` + "\n")
	}
	base := lv.Snapshot().Base
	live.Mu.Lock()
	live.Registry[cid] = lv
	live.Mu.Unlock()
	t.Cleanup(func() { live.Mu.Lock(); delete(live.Registry, cid); live.Mu.Unlock() })

	srv := httptest.NewServer(Handler())
	defer srv.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+"/api/events?page=abcd1234&c="+cid+":0:g1", nil)
	req.Host = selfHost
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	rd := bufio.NewReader(resp.Body)
	var got []map[string]any
	for range 3 {
		line, err := rd.ReadString('\n')
		if err != nil {
			t.Fatal(err)
		}
		var d map[string]any
		if json.Unmarshal([]byte(line), &d) != nil {
			t.Fatalf("bad line %q", line)
		}
		got = append(got, d)
	}
	if got[0]["type"] != "attach" || got[0]["from"] != float64(base) {
		t.Fatalf("attach: %#v", got[0])
	}
	if got[1]["type"] != "_gap" || got[1]["_r"] != float64(1) || got[1]["to"] != float64(base) {
		t.Fatalf("gap: %#v", got[1])
	}
	if got[2]["type"] != "x" || got[2]["_r"] != nil {
		t.Fatalf("first buffered line: %#v", got[2])
	}
}
