package live

import (
	"encoding/json"
	"sync"
	"time"

	"claude-ui/internal/config"
)

var (
	metaMu  sync.Mutex
	metaVal map[string]any // nil (or empty) until a real answer has arrived
)

// Meta returns models and slash commands/skills, from Claude's own `initialize` answer (asked once, cached).
// A failed or timed-out attempt isn't cached, so the next call retries.
func Meta() map[string]any {
	metaMu.Lock()
	if len(metaVal) > 0 {
		v := metaVal
		metaMu.Unlock()
		return v
	}
	metaMu.Unlock()

	l, err := New("", "", "", "")
	if err != nil {
		return map[string]any{}
	}
	defer l.Close()
	l.Control("initialize", nil)
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		snap := l.Snapshot()
		for _, line := range snap.Lines {
			var d map[string]any
			if json.Unmarshal([]byte(line), &d) != nil || d["type"] != "control_response" {
				continue
			}
			resp, _ := d["response"].(map[string]any)
			r, _ := resp["response"].(map[string]any)
			models, _ := r["models"].([]any)
			commands, _ := r["commands"].([]any)
			if models == nil {
				models = []any{}
			}
			if commands == nil {
				commands = []any{}
			}
			result := map[string]any{"models": models, "commands": commands}
			metaMu.Lock()
			metaVal = result
			metaMu.Unlock()
			return result
		}
		select {
		case <-Changed.Wait():
		case <-time.After(time.Second):
		}
	}
	return map[string]any{}
}

// Reap closes live Claude processes with no traffic for IdleSecs (the next message resumes them).
func Reap() {
	for {
		time.Sleep(60 * time.Second)
		Mu.Lock()
		var idle []string
		for cid, l := range Registry {
			l.mu.Lock()
			stale := l.exited || time.Since(l.last) > config.IdleSecs*time.Second
			l.mu.Unlock()
			if stale {
				idle = append(idle, cid)
			}
		}
		for _, cid := range idle {
			l := Registry[cid]
			delete(Registry, cid)
			l.Close()
		}
		Mu.Unlock()
	}
}
