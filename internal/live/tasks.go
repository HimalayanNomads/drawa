package live

import (
	"encoding/json"
	"regexp"
	"strings"
)

var (
	launchedRe = regexp.MustCompile(`Async agent launched[^"]*?agentId: ([\w-]+)`)
	taskIDRe   = regexp.MustCompile(`<task-id>([\w-]+)</task-id>`)
)

// trackTasks keeps the set of background agents still running: added when an Agent call answers "Async agent
// launched" (its id), removed by a task notification naming that id (a live task_notification line, or the
// <task-notification> message, which may list several). ponytail: a notification the CLI never sends keeps the
// card from counting as idle until ReapCap; tracking the CLI's own task list would need a protocol for it.
func (l *Live) trackTasks(line string) {
	if m := launchedRe.FindStringSubmatch(line); m != nil {
		l.mu.Lock()
		if l.tasks == nil {
			l.tasks = map[string]bool{}
		}
		l.tasks[m[1]] = true
		l.mu.Unlock()
		return
	}
	var ids []string
	if strings.Contains(line, `"subtype":"task_notification"`) {
		var d struct {
			TaskID string `json:"task_id"`
		}
		if json.Unmarshal([]byte(line), &d) == nil && d.TaskID != "" {
			ids = append(ids, d.TaskID)
		}
	}
	if strings.Contains(line, "<task-notification>") {
		for _, m := range taskIDRe.FindAllStringSubmatch(line, -1) {
			ids = append(ids, m[1])
		}
	}
	if len(ids) == 0 {
		return
	}
	l.mu.Lock()
	for _, id := range ids {
		delete(l.tasks, id)
	}
	l.mu.Unlock()
}

// working reports whether the card is doing something a close would cut off: a turn, an open approval, or a
// background agent. Called with l.mu held.
func (l *Live) working() bool { return l.busy || len(l.asks) > 0 || len(l.tasks) > 0 }
