package agy

import (
	"encoding/json"
	"strings"
	"time"

	"drawa/internal/config"
	"drawa/internal/procx"
)

// models is `agy models`: one "id<TAB>name" per line. Its reasoning effort is part of the model ("… (High)"), and
// slash commands aren't allowed headless, so commands is empty.
func models() map[string]any {
	r, err := procx.RunEnv(60*time.Second, "", nil, "agy", "models")
	if err != nil || r.Code != 0 {
		return nil
	}
	list := []any{map[string]any{"value": "", "displayName": "Default", "description": "Antigravity's default"}}
	for _, l := range strings.Split(r.Stdout, "\n") {
		id, name, ok := strings.Cut(strings.TrimSpace(l), "\t")
		if !ok || id == "" {
			continue
		}
		list = append(list, map[string]any{"value": id, "displayName": strings.TrimSpace(name), "description": ""})
	}
	return map[string]any{"models": list, "commands": []any{}}
}

// oneShot answers one prompt about text: a single stream-json message (the text can be bigger than argv allows),
// with no approvals, so its tools can only read. ponytail: agy saves it as a conversation of its own; drop it once
// agy can run without saving.
func oneShot(prompt, text string) (bool, string) {
	if config.Untrusted() { // as in spawn: agy can't skip this project's own settings
		return false, "Antigravity can't skip this project's own settings, so it doesn't run in a clone you haven't trusted."
	}
	in, _ := json.Marshal(map[string]any{"event": "user", "message": map[string]any{"content": prompt + "\n\n" + text}})
	r, err := procx.RunEnv(180*time.Second, string(in)+"\n", nil,
		"agy", "--input-format", "stream-json", "--output-format", "stream-json", "--disable-slash-commands", "-p=")
	if err != nil {
		return false, err.Error()
	}
	var reply strings.Builder
	msg := ""
	for _, l := range strings.Split(r.Stdout, "\n") {
		var e event
		if json.Unmarshal([]byte(l), &e) != nil {
			continue
		}
		if e.Event == "step_update" && e.Step.Type == "agent_response" {
			reply.WriteString(e.Step.TextDelta)
		}
		if e.Event == "result" && e.Result.Error != "" {
			msg = e.Result.Error
		}
	}
	if out := strings.TrimSpace(reply.String()); r.Code == 0 && out != "" {
		return true, out
	}
	if msg == "" {
		msg = strings.TrimSpace(r.Stderr)
	}
	if msg == "" {
		msg = "Antigravity gave no answer."
	}
	return false, msg[:min(len(msg), 500)]
}
