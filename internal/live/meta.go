package live

import (
	"encoding/json"
	"sync"
	"time"
)

var (
	metaMu     sync.Mutex     // held for a whole ask: concurrent callers wait for the one claude process, not spawn more
	metaVal    map[string]any // nil (or empty) until a real answer has arrived
	metaFailed time.Time      // the last failed ask: not retried for a minute
)

// Meta returns models and slash commands/skills, from Claude's own `initialize` answer (asked once, cached).
// A failed or timed-out attempt is retried after a minute.
func Meta() map[string]any {
	metaMu.Lock()
	defer metaMu.Unlock()
	if len(metaVal) > 0 {
		return metaVal
	}
	if time.Since(metaFailed) < time.Minute {
		return map[string]any{}
	}
	if v := askMeta(); len(v) > 0 {
		metaVal = v
		return v
	}
	metaFailed = time.Now()
	return map[string]any{}
}

func askMeta() map[string]any {
	l, err := New("", "", "", "")
	if err != nil {
		return nil
	}
	Mu.Lock()
	metaLive = l
	Mu.Unlock()
	defer func() {
		l.Close()
		Mu.Lock()
		metaLive = nil
		Mu.Unlock()
	}()
	l.Control("initialize", nil)
	deadline := time.Now().Add(20 * time.Second)
	pos := 0
	for time.Now().Before(deadline) {
		var lines []string
		lines, pos = l.LinesFrom(pos) // only what's new since the last look
		for _, line := range lines {
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
			return map[string]any{"models": models, "commands": commands}
		}
		select {
		case <-Changed.Wait():
		case <-time.After(time.Second):
		}
	}
	return nil
}
