package live

import (
	"strings"
	"testing"
)

// A turn as the claude backend emits it (trimmed to the fields the page reads).
var wireTurn = []string{
	`{"type":"user","message":{"role":"user","content":"read note.txt"}}`,
	`{"type":"system","subtype":"init","session_id":"s1","model":"claude-sonnet-4-5"}`,
	`{"type":"stream_event","event":{"type":"message_start","message":{"usage":{"input_tokens":3}}}}`,
	`{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}`,
	`{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Reading"}}}`,
	`{"type":"stream_event","event":{"type":"content_block_stop","index":0}}`,
	`{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"Read","input":{}}}}`,
	`{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"file_path\":\"note.txt\"}"}}}`,
	`{"type":"stream_event","event":{"type":"content_block_stop","index":1}}`,
	`{"type":"control_request","request_id":"r1","request":{"subtype":"can_use_tool","tool_name":"Read","input":{"file_path":"note.txt"}}}`,
	`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"hello"}]}}`,
	`{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.01}`,
}

func TestCheckWireAcceptsATurn(t *testing.T) {
	if err := CheckWire(wireTurn); err != nil {
		t.Fatal(err)
	}
}

func TestCheckWireRejects(t *testing.T) {
	without := func(drop int) []string {
		return append(append([]string{}, wireTurn[:drop]...), wireTurn[drop+1:]...)
	}
	for name, c := range map[string]struct {
		lines []string
		want  string
	}{
		"no result":         {wireTurn[:len(wireTurn)-1], "no result"},
		"unclosed block":    {without(5), "still open"},
		"delta after close": {append(append([]string{}, wireTurn[:6]...), wireTurn[4]), "isn't open"},
		"unknown tool call": {[]string{`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"zz"}]}}`}, "unknown call"},
		"ask without id":    {append([]string{}, `{"type":"control_request","request":{"subtype":"can_use_tool","tool_name":"Bash"}}`), "request_id"},
		"cancel without id": {append(append([]string{}, wireTurn[:10]...), `{"type":"control_cancel_request"}`), "unknown request_id"},
		"cancel unasked":    {append(append([]string{}, wireTurn[:10]...), `{"type":"control_cancel_request","request_id":"r9"}`), "unknown request_id"},
	} {
		if err := CheckWire(c.lines); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: got %v, want an error containing %q", name, err, c.want)
		}
	}
}

// An ask taken back unanswered (its turn was stopped) is fine.
func TestCheckWireCancelAsk(t *testing.T) {
	lines := append(append([]string{}, wireTurn[:10]...), `{"type":"control_cancel_request","request_id":"r1"}`)
	if err := CheckWire(append(lines, wireTurn[10:]...)); err != nil {
		t.Fatal(err)
	}
}

// A process that dies mid-turn ends the stream with exit, not result: that's allowed.
func TestCheckWireExitEndsTurn(t *testing.T) {
	if err := CheckWire(append(append([]string{}, wireTurn[:4]...), `{"type":"exit","code":1}`)); err != nil {
		t.Fatal(err)
	}
}

// A backend that knows the context window reports it in the result, last, as Claude does.
func TestTurnEndWindow(t *testing.T) {
	tn := NewTurn("s", "m")
	tn.Window = 200000
	out := tn.End(func(string) bool { return false })
	if last := out[len(out)-1]; !strings.HasSuffix(last, `"modelUsage":{"m":{"contextWindow":200000}}}`) {
		t.Fatal(last)
	}
}
