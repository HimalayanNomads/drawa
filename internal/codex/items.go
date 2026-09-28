package codex

import (
	"encoding/json"
	"fmt"
	"strings"

	"drawa/internal/live"
)

// Codex's thread items as Claude's messages and tool calls, which the page knows how to draw. The live translator
// and history (thread/read returns the same items) both go through here, so a session looks the same either way.

// threadItem is a ThreadItem, with only the fields the page draws.
type threadItem struct {
	Type             string          `json:"type"`
	ID               string          `json:"id"`
	ClientID         string          `json:"clientId"`
	Text             string          `json:"text"`
	Summary          []string        `json:"summary"`
	Content          json.RawMessage `json:"content"` // a user message's parts, or reasoning's text
	Command          string          `json:"command"`
	AggregatedOutput *string         `json:"aggregatedOutput"`
	ExitCode         *int            `json:"exitCode"`
	Status           string          `json:"status"`
	Changes          []change        `json:"changes"`
	Server           string          `json:"server"`
	Tool             string          `json:"tool"`
	Arguments        map[string]any  `json:"arguments"`
	Result           *struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	} `json:"result"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
	Query  string `json:"query"`
	Path   string `json:"path"`
	Prompt string `json:"prompt"`
}

type userPart struct {
	Type string `json:"type"`
	Text string `json:"text"`
	URL  string `json:"url"`
}

type change struct {
	Path string `json:"path"`
	Kind struct {
		Type     string  `json:"type"`
		MovePath *string `json:"move_path"` // an update that also renames the file
	} `json:"kind"`
	Diff string `json:"diff"`
}

// userContent is a user message as the page shows it: its text, or blocks when it carries images.
func (it threadItem) userContent() any {
	var parts []userPart
	json.Unmarshal(it.Content, &parts)
	var text []string
	var blocks []live.Obj
	for _, p := range parts {
		switch p.Type {
		case "text":
			text = append(text, p.Text)
			blocks = append(blocks, live.Obj{"type", "text", "text", p.Text})
		case "image":
			if mime, data, ok := dataURL(p.URL); ok {
				blocks = append(blocks, live.Obj{"type", "image", "source", live.Obj{"type", "base64", "media_type", mime, "data", data}})
			}
		}
	}
	if len(blocks) > len(text) {
		return blocks
	}
	return strings.Join(text, "\n")
}

func dataURL(u string) (mime, data string, ok bool) {
	rest, isData := strings.CutPrefix(u, "data:")
	mime, data, ok = strings.Cut(rest, ";base64,")
	return mime, data, ok && isData
}

// isTool: an item drawn as tool calls.
func (it threadItem) isTool() bool {
	switch it.Type {
	case "commandExecution", "fileChange", "mcpToolCall", "webSearch", "imageView", "dynamicToolCall", "collabAgentToolCall":
		return true
	}
	return false
}

// calls is an item as Claude tool calls: one, or one per file for a file change.
func (it threadItem) calls() []live.ToolCall {
	switch it.Type {
	case "commandExecution":
		return []live.ToolCall{{Name: "Bash", Input: map[string]any{"command": unwrap(it.Command)}}}
	case "fileChange":
		out := make([]live.ToolCall, 0, len(it.Changes))
		for _, c := range it.Changes {
			out = append(out, fileCall(c))
		}
		return out
	case "mcpToolCall":
		return []live.ToolCall{{Name: "mcp__" + it.Server + "__" + it.Tool, Input: orEmpty(it.Arguments)}}
	case "webSearch":
		return []live.ToolCall{{Name: "WebSearch", Input: map[string]any{"query": it.Query}}}
	case "imageView":
		return []live.ToolCall{{Name: "Read", Input: map[string]any{"file_path": it.Path}}}
	case "collabAgentToolCall": // a plain row, not Claude's Agent: its sub-agent's own lines aren't streamed
		return []live.ToolCall{{Name: "Sub-agent", Input: map[string]any{"prompt": it.Prompt}}}
	}
	return []live.ToolCall{{Name: it.Tool, Input: orEmpty(it.Arguments)}}
}

// fileCall is one file of a change as the Claude edit tool that draws it.
func fileCall(c change) live.ToolCall {
	switch c.Kind.Type {
	case "add":
		return live.ToolCall{Name: "Write", Input: map[string]any{"file_path": c.Path, "content": added(c.Diff)}}
	case "delete":
		return live.ToolCall{Name: "Edit", Input: map[string]any{"file_path": c.Path, "old_string": "", "new_string": ""}}
	}
	in := map[string]any{"file_path": c.Path, "edits": hunkEdits(c.Diff)}
	if c.Kind.MovePath != nil {
		in["move_path"] = *c.Kind.MovePath
	}
	return live.ToolCall{Name: "MultiEdit", Input: in}
}

func orEmpty(m map[string]any) map[string]any {
	if m == nil {
		return map[string]any{}
	}
	return m
}

// callID is the id of an item's n-th tool call.
func callID(item string, n int) string {
	if n == 0 {
		return item
	}
	return fmt.Sprintf("%s#%d", item, n)
}

// output is a finished tool item's result as the page shows it.
func (it threadItem) output() (content string, isErr bool) {
	isErr = it.Status == "failed" || it.Status == "declined"
	switch it.Type {
	case "commandExecution":
		if it.AggregatedOutput != nil {
			content = *it.AggregatedOutput
		}
		if it.ExitCode != nil && *it.ExitCode != 0 {
			isErr = true
		}
	case "mcpToolCall":
		if it.Error != nil {
			return it.Error.Message, true
		}
		if it.Result != nil {
			var t []string
			for _, c := range it.Result.Content {
				if c.Text != "" {
					t = append(t, c.Text)
				} else if c.Type == "image" {
					t = append(t, "[image]")
				}
			}
			content = strings.Join(t, "\n")
		}
	}
	if it.Status == "declined" && content == "" {
		content = "Declined."
	}
	return content, isErr
}

// unwrap is a command without Codex's shell wrapper (`/usr/bin/zsh -lc 'ls -la'` -> `ls -la`).
func unwrap(cmd string) string {
	i := strings.Index(cmd, " -lc ")
	if i < 0 || strings.Contains(cmd[:i], " ") {
		return cmd
	}
	s := cmd[i+5:]
	if len(s) >= 2 && s[0] == '\'' && s[len(s)-1] == '\'' {
		s = strings.ReplaceAll(s[1:len(s)-1], `'\''`, "'")
	}
	return s
}

// added is a new file's content from its diff (every line added), or the text as is if it isn't a diff.
func added(diff string) string {
	if !strings.Contains(diff, "@@") {
		return diff
	}
	var b strings.Builder
	for _, l := range strings.SplitAfter(diff, "\n") {
		if strings.HasPrefix(l, "+") && !strings.HasPrefix(l, "+++") {
			b.WriteString(l[1:])
		}
	}
	return b.String()
}

// lines joins whole lines, each ending in a newline, so the page's line diff doesn't see the last one as changed.
func lines(ls []string) string {
	if len(ls) == 0 {
		return ""
	}
	return strings.Join(ls, "\n") + "\n"
}

// hunkEdits turns a unified diff's hunks into MultiEdit edits: old is each hunk's context and '-' lines, new its
// context and '+' lines. File headers (---, +++, diff, index) are skipped.
func hunkEdits(diff string) []any {
	var edits []any
	var old, nu []string
	changed := false
	flush := func() {
		if changed {
			edits = append(edits, map[string]any{"old_string": lines(old), "new_string": lines(nu)})
		}
		old, nu, changed = nil, nil, false
	}
	started := false
	for _, l := range strings.Split(strings.TrimRight(strings.ReplaceAll(diff, "\r\n", "\n"), "\n"), "\n") {
		if strings.HasPrefix(l, "@@") {
			flush()
			started = true
			continue
		}
		if !started && (strings.HasPrefix(l, "--- ") || strings.HasPrefix(l, "+++ ") || strings.HasPrefix(l, "diff ") || strings.HasPrefix(l, "index ")) {
			continue
		}
		started = true
		switch {
		case strings.HasPrefix(l, "-"):
			old, changed = append(old, l[1:]), true
		case strings.HasPrefix(l, "+"):
			nu, changed = append(nu, l[1:]), true
		case strings.HasPrefix(l, `\`): // "\ No newline at end of file"
		default:
			c := strings.TrimPrefix(l, " ")
			old, nu = append(old, c), append(nu, c)
		}
	}
	flush()
	return edits
}
