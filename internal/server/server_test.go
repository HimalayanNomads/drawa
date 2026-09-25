package server

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"claude-ui/internal/live"
)

// mcpPost POSTs an MCP JSON-RPC body to a card, with the Host header the handler requires (config.Hosts is
// fixed to :8765 regardless of the test server's actual listening port).
func mcpPost(t *testing.T, srv *httptest.Server, cardPath string, body any) (int, []byte) {
	t.Helper()
	var data []byte
	switch b := body.(type) {
	case []byte:
		data = b
	default:
		data, _ = json.Marshal(body)
	}
	req, err := http.NewRequest(http.MethodPost, srv.URL+cardPath, bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	req.Host = "127.0.0.1:8765"
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	buf := new(bytes.Buffer)
	buf.ReadFrom(resp.Body)
	return resp.StatusCode, buf.Bytes()
}

func TestMcpRoundTrip(t *testing.T) {
	lv := live.NewForTest("t"+strings.Repeat("0", 31), "g1")
	lv.AddReader("r1")
	live.Mu.Lock()
	live.Registry["card"] = lv
	live.Mu.Unlock()
	t.Cleanup(func() {
		live.Mu.Lock()
		delete(live.Registry, "card")
		live.Mu.Unlock()
	})

	srv := httptest.NewServer(Handler())
	defer srv.Close()
	path := "/mcp/card/" + lv.Token

	status, body := mcpPost(t, srv, path, map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{"protocolVersion": "2025-06-18"}})
	if status != 200 {
		t.Fatalf("initialize: status %d body %s", status, body)
	}
	var initResp map[string]any
	json.Unmarshal(body, &initResp)
	result := initResp["result"].(map[string]any)
	if result["serverInfo"].(map[string]any)["name"] != "claude-ui-canvas" {
		t.Fatalf("unexpected initialize result: %s", body)
	}

	status, _ = mcpPost(t, srv, path, map[string]any{"jsonrpc": "2.0", "method": "notifications/initialized"})
	if status != 202 {
		t.Fatalf("notification: status %d", status)
	}

	status, body = mcpPost(t, srv, path, map[string]any{"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
	var listResp map[string]any
	json.Unmarshal(body, &listResp)
	tools := listResp["result"].(map[string]any)["tools"].([]any)
	found := false
	for _, tl := range tools {
		if tl.(map[string]any)["name"] == "canvas_create" {
			found = true
		}
	}
	if !found {
		t.Fatalf("canvas_create missing from tools/list: %s", body)
	}

	// tools/call for canvas_list should push a canvas_call line and block until the page answers it.
	callDone := make(chan struct{})
	var callStatus int
	var callBody []byte
	go func() {
		callStatus, callBody = mcpPost(t, srv, path, map[string]any{
			"jsonrpc": "2.0", "id": 3, "method": "tools/call",
			"params": map[string]any{"name": "canvas_list", "arguments": map[string]any{}},
		})
		close(callDone)
	}()

	deadline := time.Now().Add(2 * time.Second)
	var callID string
	for time.Now().Before(deadline) && callID == "" {
		lines, _ := lv.LinesFrom(0)
		for _, line := range lines {
			var d map[string]any
			if json.Unmarshal([]byte(line), &d) == nil && d["type"] == "canvas_call" {
				callID, _ = d["id"].(string)
			}
		}
		if callID == "" {
			time.Sleep(10 * time.Millisecond)
		}
	}
	if callID == "" {
		t.Fatal("canvas_call was never pushed")
	}
	if !lv.AnswerCanvasCall(callID, map[string]any{"content": []map[string]any{{"type": "text", "text": "called canvas_list"}}}) {
		t.Fatal("AnswerCanvasCall reported no pending call")
	}

	select {
	case <-callDone:
	case <-time.After(2 * time.Second):
		t.Fatal("tools/call never returned")
	}
	if callStatus != 200 {
		t.Fatalf("tools/call: status %d body %s", callStatus, callBody)
	}
	var cr map[string]any
	json.Unmarshal(callBody, &cr)
	text := cr["result"].(map[string]any)["content"].([]any)[0].(map[string]any)["text"]
	if text != "called canvas_list" {
		t.Fatalf("unexpected tools/call result: %s", callBody)
	}
}

func TestMcpBadRequests(t *testing.T) {
	lv := live.NewForTest("t"+strings.Repeat("1", 31), "g1")
	live.Mu.Lock()
	live.Registry["card2"] = lv
	live.Mu.Unlock()
	t.Cleanup(func() {
		live.Mu.Lock()
		delete(live.Registry, "card2")
		live.Mu.Unlock()
	})
	srv := httptest.NewServer(Handler())
	defer srv.Close()
	path := "/mcp/card2/" + lv.Token

	_, body := mcpPost(t, srv, path, []byte("{not json"))
	var d map[string]any
	json.Unmarshal(body, &d)
	if code, _ := d["error"].(map[string]any)["code"].(float64); code != -32700 {
		t.Fatalf("malformed JSON: expected -32700, got %s", body)
	}

	_, body = mcpPost(t, srv, path, []byte("[1,2]"))
	json.Unmarshal(body, &d)
	if code, _ := d["error"].(map[string]any)["code"].(float64); code != -32600 {
		t.Fatalf("non-object JSON: expected -32600, got %s", body)
	}
}

// TestTwoCardsOneStream: one page's /api/events stream carries every card's lines, tagged with the card, from
// each card's own offset.
func TestTwoCardsOneStream(t *testing.T) {
	a := live.NewForTest("", "g1")
	b := live.NewForTest("", "g1")
	a.Push(`{"type": "x", "i": 0}` + "\n")
	a.Push(`{"type": "x", "i": 1}` + "\n")
	b.Push(`{"type": "y", "i": 0}` + "\n")
	b.Push(`{"type": "y", "i": 1}` + "\n")
	live.Mu.Lock()
	live.Registry["aaaaaaaa-0000-0000-0000-000000000000"] = a
	live.Registry["bbbbbbbb-0000-0000-0000-000000000000"] = b
	live.Mu.Unlock()
	t.Cleanup(func() {
		live.Mu.Lock()
		delete(live.Registry, "aaaaaaaa-0000-0000-0000-000000000000")
		delete(live.Registry, "bbbbbbbb-0000-0000-0000-000000000000")
		live.Mu.Unlock()
	})

	srv := httptest.NewServer(Handler())
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	open := func(c string) *bufio.Reader {
		t.Helper()
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+"/api/events?page=abcd1234&c="+c, nil)
		req.Host = "127.0.0.1:8765"
		resp, err := srv.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { resp.Body.Close() })
		return bufio.NewReader(resp.Body)
	}
	reader := open("aaaaaaaa-0000-0000-0000-000000000000:0,bbbbbbbb-0000-0000-0000-000000000000:1")

	readLine := func() map[string]any {
		t.Helper()
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatalf("stream ended early: %v", err)
		}
		var d map[string]any
		if json.Unmarshal([]byte(line), &d) != nil {
			t.Fatalf("bad line: %q", line)
		}
		return d
	}

	got := make([]map[string]any, 5) // 2 attach lines + 2 of a's + 1 of b's
	for i := range got {
		got[i] = readLine()
	}
	check := func(i int, cid, typ string, val float64) {
		d := got[i]
		if c := d["_c"].(string); c != cid {
			t.Fatalf("line %d: card %q, want %q (%#v)", i, c, cid, d)
		}
		if d["type"] != typ {
			t.Fatalf("line %d: type %v, want %q (%#v)", i, d["type"], typ, d)
		}
		got := d["i"]
		if got == nil {
			got = d["from"]
		}
		if got != val {
			t.Fatalf("line %d: value %v, want %v (%#v)", i, got, val, d)
		}
	}
	check(0, "aaaaaaaa-0000-0000-0000-000000000000", "attach", 0)
	check(1, "aaaaaaaa-0000-0000-0000-000000000000", "x", 0)
	check(2, "aaaaaaaa-0000-0000-0000-000000000000", "x", 1)
	check(3, "bbbbbbbb-0000-0000-0000-000000000000", "attach", 1)
	check(4, "bbbbbbbb-0000-0000-0000-000000000000", "y", 1)
	if r := a.Readers(); len(r) != 1 || r[0] != "abcd1234" {
		t.Fatalf("readers %v, want [abcd1234]", r)
	}

	b.Push(`{"type": "y", "i": 2}` + "\n") // later output wakes the stream
	d := readLine()
	if d["i"] != float64(2) {
		t.Fatalf("expected b's new line, got %#v", d)
	}

	// an offset from an older process of the card: this one is read from its first line
	reader = open("aaaaaaaa-0000-0000-0000-000000000000:2:oldgen")
	if d := readLine(); d["type"] != "attach" || d["from"] != float64(0) {
		t.Fatalf("older generation should replay from 0, got %#v", d)
	}
}
