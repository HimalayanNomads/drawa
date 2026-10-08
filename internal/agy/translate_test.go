package agy

import (
	"encoding/json"
	"strings"
	"testing"

	"drawa/internal/live"
)

// A turn as agy 1.2.16 streamed it: a read, a command headless mode turned down, text, then a second message's turn.
const fixture = `{"event":"init","conversation_id":"4bd7c6c4-6c0e-428e-85cc-5d3e33a33160","init":{"cwd":"/tmp/x","permission_mode":"request-review"}}
{"event":"step_update","step_update":{"conversation_id":"4bd7c6c4-6c0e-428e-85cc-5d3e33a33160","step_index":0,"state":"DONE","step_type":"user_input"}}
{"event":"step_update","step_update":{"conversation_id":"4bd7c6c4-6c0e-428e-85cc-5d3e33a33160","step_index":1,"state":"DONE","step_type":"agent_response","duration_seconds":3.1,"usage":{"input_tokens":11789,"output_tokens":517,"thinking_tokens":355,"cache_read_tokens":0,"total_tokens":12306}}}
{"event":"step_update","step_update":{"conversation_id":"4bd7c6c4-6c0e-428e-85cc-5d3e33a33160","step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"view_file","tool_info":{"name":"view_file","parameters":{"AbsolutePath":"/tmp/x/a.txt"}}}}
{"event":"step_update","step_update":{"conversation_id":"4bd7c6c4-6c0e-428e-85cc-5d3e33a33160","step_index":2,"state":"DONE","step_type":"tool","tool_name":"view_file","duration_seconds":0.1,"tool_info":{"name":"view_file","parameters":{"AbsolutePath":"/tmp/x/a.txt"},"output":"2 lines, 12 bytes"}}}
{"event":"step_update","step_update":{"conversation_id":"4bd7c6c4-6c0e-428e-85cc-5d3e33a33160","step_index":3,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"ls -la"}}}}
{"event":"step_update","step_update":{"conversation_id":"4bd7c6c4-6c0e-428e-85cc-5d3e33a33160","step_index":3,"state":"ERROR","step_type":"tool","tool_name":"run_command","duration_seconds":0.02,"tool_info":{"name":"run_command","parameters":{"CommandLine":"ls -la"},"error":{"type":"TOOL_ERROR","message":"permission check failed"}}}}
{"event":"step_update","step_update":{"conversation_id":"4bd7c6c4-6c0e-428e-85cc-5d3e33a33160","step_index":4,"state":"ACTIVE","step_type":"agent_response","text_delta":"It says "}}
{"event":"step_update","step_update":{"conversation_id":"4bd7c6c4-6c0e-428e-85cc-5d3e33a33160","step_index":4,"state":"DONE","step_type":"agent_response","text_delta":"hello.","duration_seconds":1.2,"usage":{"input_tokens":12000,"output_tokens":20,"cache_read_tokens":0}}}
{"event":"result","result":{"conversation_id":"4bd7c6c4-6c0e-428e-85cc-5d3e33a33160","status":"SUCCESS","response":"It says hello.","duration_seconds":4.4,"num_turns":1,"denied_actions":[{"action":"command","display_name":"RunCommand"}]}}
{"event":"step_update","step_update":{"conversation_id":"4bd7c6c4-6c0e-428e-85cc-5d3e33a33160","step_index":5,"state":"DONE","step_type":"user_input"}}
{"event":"step_update","step_update":{"conversation_id":"4bd7c6c4-6c0e-428e-85cc-5d3e33a33160","step_index":6,"state":"ACTIVE","step_type":"agent_response","text_delta":"ok."}}
{"event":"step_update","step_update":{"conversation_id":"4bd7c6c4-6c0e-428e-85cc-5d3e33a33160","step_index":6,"state":"DONE","step_type":"agent_response","text_delta":"\n","usage":{"input_tokens":12100,"output_tokens":5}}}
{"event":"result","result":{"conversation_id":"4bd7c6c4-6c0e-428e-85cc-5d3e33a33160","status":"SUCCESS","response":"ok.\n","num_turns":2}}`

func TestTranslate(t *testing.T) {
	x := newTranslator("", "")
	x.queued("u1", "read a.txt")
	x.queued("u2", "say ok")
	var out []string
	var recs [][]map[string]any
	for _, l := range strings.Split(fixture, "\n") {
		out = append(out, x.frame([]byte(l))...)
		if strings.Contains(l, `"event":"result"`) {
			recs = append(recs, x.done())
		}
	}
	if err := live.CheckWire(out); err != nil {
		t.Fatalf("%v\n%s", err, strings.Join(out, "\n"))
	}
	all := strings.Join(out, "\n")
	for _, want := range []string{`"uuid":"u1"`, `"uuid":"u2"`, `"name":"Read"`, `\"file_path\":\"/tmp/x/a.txt\"`, `"name":"Bash"`,
		`"is_error":true`, `"text":"It says "`, `"permission_denials":[{"tool_name":"RunCommand","tool_input":{}}]`,
		`"session_id":"4bd7c6c4-6c0e-428e-85cc-5d3e33a33160"`} {
		if !strings.Contains(all, want) {
			t.Errorf("missing %s in\n%s", want, all)
		}
	}
	if len(recs) != 2 {
		t.Fatalf("records: %d", len(recs))
	}
	b, _ := json.Marshal(recs[0])
	for _, want := range []string{`"content":"read a.txt"`, `"name":"Read"`, `"tool_use_id":"agy-4bd7c6c4-6c0e-428e-85cc-5d3e33a33160-3"`, `"text":"It says hello."`} {
		if !strings.Contains(string(b), want) {
			t.Errorf("record missing %s in %s", want, b)
		}
	}
}

func TestToolOutputClipped(t *testing.T) {
	x := newTranslator("4bd7c6c4-6c0e-428e-85cc-5d3e33a33160", "")
	x.queued("u1", "read")
	x.frame([]byte(`{"event":"step_update","step_update":{"step_index":0,"state":"DONE","step_type":"user_input"}}`))
	big, _ := json.Marshal(strings.Repeat("x", 30000))
	x.frame([]byte(`{"event":"step_update","step_update":{"step_index":1,"state":"DONE","step_type":"tool","tool_info":{"name":"view_file","output":` + string(big) + `}}}`))
	x.frame([]byte(`{"event":"result","result":{"status":"SUCCESS"}}`))
	if b, _ := json.Marshal(x.done()); len(b) > 25000 {
		t.Errorf("tool output not clipped in the record: %d bytes", len(b))
	}
}
