package codex

import (
	"os"
	"strings"
	"time"

	"drawa/internal/procx"
)

// oneShot answers one prompt about text with `codex exec` at low reasoning effort, read-only and not saved to
// the history list; the reply is the last message, which Codex writes to a file.
func oneShot(prompt, text string) (bool, string) {
	args, err := projectArgs()
	if err != nil {
		return false, err.Error()
	}
	f, err := os.CreateTemp("", "drawa-codex-*.txt")
	if err != nil {
		return false, err.Error()
	}
	f.Close()
	defer os.Remove(f.Name())
	argv := append([]string{"codex", "exec", "--skip-git-repo-check", "--sandbox", "read-only", "--ephemeral",
		"--color", "never", "-c", `model_reasoning_effort="low"`, "-o", f.Name()}, args...)
	r, err := procx.RunEnv(180*time.Second, prompt+"\n\n"+text, nil, append(argv, "-")...)
	if err != nil {
		return false, err.Error()
	}
	out, _ := os.ReadFile(f.Name())
	if s := strings.TrimSpace(string(out)); r.Code == 0 && s != "" {
		return true, s
	}
	msg := strings.TrimSpace(r.Stderr)
	if msg == "" {
		msg = "Codex gave no answer."
	}
	return false, msg[max(0, len(msg)-500):] // the end: Codex prints its settings banner first
}
