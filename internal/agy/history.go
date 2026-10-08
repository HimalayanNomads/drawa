package agy

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"drawa/internal/config"
	"drawa/internal/sessions"
)

// agy's saved conversations don't say which project they belong to, so Drawa keeps its own record of the ones its
// cards had: each finished turn's messages, in the page's history shape, one per line, under ~/.drawa/agy/<project>/.
// ponytail: a conversation continued in a terminal is missing those turns here; read agy's own store once it
// records the project folder.
var dir = func() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".drawa", "agy", regexp.MustCompile(`[^A-Za-z0-9]`).ReplaceAllString(config.Root, "-"))
}()

func file(sid string) string { return filepath.Join(dir, sid+".jsonl") }

// remember appends a turn's messages to its conversation's record.
func remember(sid string, msgs []map[string]any) {
	if !config.UUIDRe.MatchString(sid) || len(msgs) == 0 || os.MkdirAll(dir, 0o700) != nil {
		return
	}
	f, err := os.OpenFile(file(sid), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	w := bufio.NewWriter(f)
	for _, m := range msgs {
		if b, err := json.Marshal(m); err == nil {
			w.Write(append(b, '\n'))
		}
	}
	w.Flush()
}

type history struct{}

// List is this project's recorded conversations, newest first; each is titled by its first message.
func (history) List() []sessions.Info {
	out := []sessions.Info{}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		sid, ok := strings.CutSuffix(e.Name(), ".jsonl")
		info, err := e.Info()
		if !ok || err != nil || !config.UUIDRe.MatchString(sid) {
			continue
		}
		out = append(out, sessions.Info{ID: sid, Title: title(sid), Mtime: float64(info.ModTime().UnixMilli()) / 1000})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Mtime > out[j].Mtime })
	return out
}

func title(sid string) string {
	f, err := os.Open(file(sid))
	if err != nil {
		return ""
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64*1024), 4<<20)
	if !sc.Scan() {
		return ""
	}
	var m struct {
		Content any `json:"content"`
	}
	json.Unmarshal(sc.Bytes(), &m)
	t, _ := m.Content.(string)
	t = strings.Join(strings.Fields(t), " ")
	if r := []rune(t); len(r) > 120 {
		t = string(r[:120]) + "…"
	}
	return t
}

// Load is a recorded conversation; one Drawa has no record of yet reads as not written (the page uses the live
// stream). Sub-agents aren't recorded (agent).
func (history) Load(sid, agent string) ([]map[string]any, bool) {
	if agent != "" {
		return []map[string]any{}, true
	}
	if !config.UUIDRe.MatchString(sid) {
		return nil, false
	}
	f, err := os.Open(file(sid))
	if err != nil {
		return nil, false
	}
	defer f.Close()
	msgs := []map[string]any{}
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64*1024), 64<<20)
	for sc.Scan() {
		var m map[string]any
		if json.Unmarshal(sc.Bytes(), &m) == nil {
			msgs = append(msgs, m)
		}
	}
	return msgs, true
}
