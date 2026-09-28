package live

import (
	"bufio"
	"encoding/json"
	"io"
	"strings"
	"testing"

	"drawa/internal/config"
)

// Unsend writes cancel_async_message for the message's uuid and returns what the CLI's control_response says.
func TestClaudeUnsend(t *testing.T) {
	for _, cancelled := range []bool{true, false} {
		r, w := io.Pipe()
		c := &claude{stdin: w}
		go func() {
			line, _ := bufio.NewReader(r).ReadBytes('\n')
			var req struct {
				RequestID string `json:"request_id"`
				Request   map[string]any
			}
			json.Unmarshal(line, &req)
			if req.Request["subtype"] != "cancel_async_message" || req.Request["message_uuid"] != "m1" {
				t.Errorf("wrote %s", line)
			}
			resp, _ := json.Marshal(map[string]any{"type": "control_response", "response": map[string]any{
				"subtype": "success", "request_id": req.RequestID, "response": map[string]any{"cancelled": cancelled}}})
			c.answered(string(resp))
		}()
		got, err := c.Unsend("m1")
		if err != nil || got != cancelled {
			t.Errorf("Unsend = %v, %v; want %v", got, err, cancelled)
		}
	}
}

// An untrusted clone's card and one-shot calls start with the user's settings only.
func TestUntrustedArgv(t *testing.T) {
	cloned, trusted := config.Cloned, config.Trusted
	defer func() { config.Cloned, config.Trusted = cloned, trusted }()
	for _, c := range []struct{ cloned, trusted, want bool }{{false, false, false}, {true, true, false}, {true, false, true}} {
		config.Cloned, config.Trusted = c.cloned, c.trusted
		if got := strings.Contains(strings.Join(buildArgv("", "", "", "", ""), " "), "--setting-sources user"); got != c.want {
			t.Errorf("cloned=%v trusted=%v: --setting-sources user in argv = %v", c.cloned, c.trusted, got)
		}
	}
}
