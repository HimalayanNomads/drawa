package live

import (
	"encoding/json"
	"fmt"
	"regexp"
	"time"
)

// claudeMeta asks a private claude process for its models and slash commands/skills (its `initialize` answer),
// plus tools/MCP counts and usage-window stats (from a `/usage` local command, $0: it never reaches the model) so a
// card's status line has something to show before its own process has ever run.
func claudeMeta() map[string]any {
	l, err := New("", "claude", "", "", "", "")
	if err != nil {
		return nil
	}
	defer TrackMeta(l)()
	c := l.be.(*claude)
	c.control("initialize", nil)
	c.Send("/usage")
	deadline := time.Now().Add(20 * time.Second)
	pos := 0
	out := map[string]any{}
	haveModels, haveUsage := false, false
	for time.Now().Before(deadline) && !(haveModels && haveUsage) {
		var lines []string
		lines, pos = l.LinesFrom(pos) // only what's new since the last look
		for _, line := range lines {
			var d map[string]any
			if json.Unmarshal([]byte(line), &d) != nil {
				continue
			}
			switch d["type"] {
			case "control_response":
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
				out["models"], out["commands"] = models, commands
				haveModels = true
			case "system":
				if d["subtype"] != "init" {
					continue
				}
				tools, _ := d["tools"].([]any)
				out["tools"] = len(tools)
				mcps, _ := d["mcp_servers"].([]any)
				out["mcpTotal"] = len(mcps)
				connected := 0
				for _, m := range mcps {
					if mm, ok := m.(map[string]any); ok && mm["status"] == "connected" {
						connected++
					}
				}
				out["mcpConnected"] = connected
			case "result":
				if d["local_command"] != "usage" {
					continue
				}
				if text, ok := d["result"].(string); ok {
					addUsage(out, text, time.Now())
				}
				haveUsage = true
			}
		}
		select {
		case <-Changed.Wait():
		case <-time.After(time.Second):
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// usageRe: `/usage`'s two summary lines. ponytail: scrapes the CLI's human-readable text (no structured form
// exists outside a real, billed turn's rate_limit_event) — if Claude Code ever rewords this, matches just stop and
// Meta() quietly omits the usage-window fields rather than breaking the rest of it.
// the time has no minutes when the reset falls exactly on the hour ("at 10pm", not "at 10:00pm").
var usageRe = regexp.MustCompile(`(?m)^(Current session|Current week[^:]*): (\d+)% used . resets (\w+ \d+) at (\d{1,2})(?::(\d{2}))?(am|pm) \(([^)]+)\)`)

// addUsage parses `/usage`'s reply into usageUtil/usageResetAt (the 5-hour window) and weeklyUtil/weeklyResetAt,
// as unix seconds. The CLI gives no year, so `now`'s year is assumed, correcting for the one case that's wrong: a
// reset that already looks more than a day in the past actually falls next year (asked right before Dec 31).
func addUsage(out map[string]any, text string, now time.Time) {
	for _, m := range usageRe.FindAllStringSubmatch(text, -1) {
		// m: [all, "Current session"/"Current week...", percent, date, hour, minute (may be ""), am/pm, tz]
		util, resetAt := parsePercent(m[2]), parseResetAt(m[3], m[4], m[5], m[6], m[7], now)
		if resetAt == 0 {
			continue
		}
		if m[1] == "Current session" {
			out["usageUtil"], out["usageResetAt"] = util, resetAt
		} else {
			out["weeklyUtil"], out["weeklyResetAt"] = util, resetAt
		}
	}
}

func parsePercent(s string) float64 {
	var n int
	fmt.Sscanf(s, "%d", &n)
	return float64(n) / 100
}

func parseResetAt(dateStr, hour, minute, ampm, tz string, now time.Time) int64 {
	if minute == "" {
		minute = "00"
	}
	loc, err := time.LoadLocation(tz)
	if err != nil {
		loc = time.UTC
	}
	ts, err := time.ParseInLocation("Jan 2 3:04pm 2006", fmt.Sprintf("%s %s:%s%s %d", dateStr, hour, minute, ampm, now.Year()), loc)
	if err != nil {
		return 0
	}
	if ts.Before(now.Add(-24 * time.Hour)) { // "resets" a year from now, asked in late December
		ts = ts.AddDate(1, 0, 0)
	}
	return ts.Unix()
}
