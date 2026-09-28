package opencode

import (
	"encoding/json"
	"strings"
	"time"
)

// oneShot answers one prompt about text (on stdin) with OpenCode's default model: `opencode run --format json`,
// whose text events are the reply. The session it creates is deleted, so it doesn't fill the history list.
func oneShot(prompt, text string) (bool, string) {
	r, err := ocRun(180*time.Second, text, "run", "--format", "json", prompt)
	if err != nil {
		return false, err.Error()
	}
	var reply []string
	sid := ""
	for _, l := range strings.Split(r.Stdout, "\n") {
		var ev struct {
			Type      string `json:"type"`
			SessionID string `json:"sessionID"`
			Part      part   `json:"part"`
		}
		if json.Unmarshal([]byte(l), &ev) != nil {
			continue
		}
		if ev.SessionID != "" {
			sid = ev.SessionID
		}
		if ev.Type == "text" {
			reply = append(reply, ev.Part.Text)
		}
	}
	if sid != "" && sidRe.MatchString(sid) {
		go ocRun(30*time.Second, "", "session", "delete", sid)
	}
	if out := strings.TrimSpace(strings.Join(reply, "")); r.Code == 0 && out != "" {
		return true, out
	}
	msg := strings.TrimSpace(r.Stderr)
	if msg == "" {
		msg = "OpenCode gave no answer."
	}
	return false, msg[:min(len(msg), 500)]
}
