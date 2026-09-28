package live

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"drawa/internal/config"
	"drawa/internal/procx"
	"drawa/internal/sessions"
)

// The claude backend: one long-running `claude -p` per card, speaking stream-json on stdin and stdout. Its output
// is the wire format already, so lines go to the Sink as they come.

var claudeArgv = []string{
	"claude", "-p",
	"--input-format", "stream-json",
	"--output-format", "stream-json",
	"--verbose",
	"--include-partial-messages",
	"--replay-user-messages",
	"--append-system-prompt", config.SystemNote,
	"--permission-prompt-tool", "stdio", // tool approvals (incl. plan approval) come to the page as control_requests
	"--allowedTools", "mcp__canvas__canvas_list,mcp__canvas__canvas_read", // looking at the canvas never asks
}

func init() {
	Register("claude", Kind{
		Bin: "claude", Label: "claude (Claude Code CLI)", Install: "install it: https://claude.com/claude-code", Title: "Claude Code",
		Blurb: "Your Claude subscription, through the claude CLI",
		Modes: config.Modes, SidOK: config.UUIDRe.MatchString, Unsend: true,
		Spawn: spawnClaude, Meta: claudeMeta, History: claudeHistory{}, OneShot: claudeOneShot,
	})
}

type claude struct {
	p       *Proc
	stdin   io.WriteCloser
	writeMu sync.Mutex // one line at a time on stdin
	mcpCfg  string     // temp file with the canvas MCP config (its URL carries the token, so not on the command line)
	waitMu  sync.Mutex
	waits   map[string]chan map[string]any // control requests of ours awaiting their control_response, by request_id
}

// writeMCPConfig writes the canvas MCP config to a 0600 temp file (CreateTemp's mode): the URL carries the card's
// token, which `ps` would show if it were on the command line.
func writeMCPConfig(url string) (string, error) {
	cfg, _ := json.Marshal(map[string]any{
		"mcpServers": map[string]any{"canvas": map[string]any{"type": "http", "url": url}},
	})
	f, err := os.CreateTemp("", "drawa-mcp-*.json")
	if err != nil {
		return "", err
	}
	_, err = f.Write(cfg)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(f.Name())
		return "", err
	}
	return f.Name(), nil
}

// untrustedArgs keeps a clone of someone else's repo from configuring Claude: `claude -p` shows no workspace-trust
// prompt, so the project's .claude/settings.json hooks would run shell commands unasked. With only the user's own
// settings (checked on CLI 2.1.283) .claude/settings.json and settings.local.json are skipped whole (hooks, permissions),
// and so are .mcp.json servers (even with enableAllProjectMcpServers), CLAUDE.md and CLAUDE.local.md
// (nested ones too), and .claude/agents, commands and skills. Still loaded: user settings, user-scope MCP servers,
// managed policy, and what Drawa passes itself (--mcp-config, so the canvas tools keep working). The repo's files
// can still carry prompt injection once Claude reads them; tool calls go through the approval flow as usual.
func untrustedArgs() []string {
	if !config.Untrusted() {
		return nil
	}
	return []string{"--setting-sources", "user"}
}

func buildArgv(sid, mode, model, effort, mcpPath string) []string {
	argv := append(append([]string{}, claudeArgv...), untrustedArgs()...)
	if mcpPath != "" {
		argv = append(argv, "--mcp-config", mcpPath)
	}
	if sid != "" {
		argv = append(argv, "--resume", sid)
	}
	if config.Modes[mode] {
		argv = append(argv, "--permission-mode", mode)
	}
	if model != "" {
		argv = append(argv, "--model", model)
	}
	if config.Efforts[effort] {
		argv = append(argv, "--effort", effort)
	}
	return argv
}

func spawnClaude(s Spec, sink Sink) (be Backend, err error) {
	c := &claude{}
	if s.MCPURL != "" {
		if c.mcpCfg, err = writeMCPConfig(s.MCPURL); err != nil {
			return nil, err
		}
		defer func() {
			if err != nil {
				os.Remove(c.mcpCfg)
			}
		}()
	}
	c.p, c.stdin, err = StartProc(buildArgv(s.Sid, s.Mode, s.Model, s.Effort, c.mcpCfg), nil, func(code int) {
		if c.mcpCfg != "" {
			os.Remove(c.mcpCfg)
		}
		sink.Exited(code)
	})
	if err != nil {
		return nil, err
	}
	go c.pump(sink)
	return c, nil
}

func (c *claude) pump(sink Sink) {
	br := bufio.NewReader(c.p.Out) // no line cap: a huge tool result must not stop the reading (the child would block)
	for {
		raw, err := br.ReadBytes('\n')
		if line := strings.TrimRight(string(raw), "\r\n"); strings.TrimSpace(line) != "" {
			if strings.Contains(line, `"control_response"`) { // (answered checks it is one)
				c.answered(line)
			}
			sink.Emit(line)
		}
		if err != nil { // EOF, or the read end closed pipeGrace after the process exited
			break
		}
	}
	sink.Ended()
}

func (c *claude) write(obj map[string]any) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	b, err := json.Marshal(obj)
	if err != nil {
		return err
	}
	_, err = c.stdin.Write(append(b, '\n'))
	return err
}

var requests atomic.Int64

// requestID names one of our control requests, unique even for two in the same clock tick.
func requestID() string { return fmt.Sprintf("ui-%d-%d", time.Now().UnixNano(), requests.Add(1)) }

func (c *claude) control(subtype string, kw map[string]any) error {
	req := map[string]any{"subtype": subtype}
	for k, v := range kw {
		req[k] = v
	}
	return c.write(map[string]any{
		"type": "control_request", "request_id": requestID(), "request": req,
	})
}

func (c *claude) Send(content any, id string) error {
	msg := map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": content}}
	if id != "" {
		msg["uuid"] = id // what Unsend names it by (and the CLI echoes it back with it)
	}
	return c.write(msg)
}

// Unsend takes a message back out of the CLI's queue, if Claude hasn't read it yet: it reads queued messages at
// the end of a turn, or between tool calls.
func (c *claude) Unsend(id string) (bool, error) {
	rid := requestID()
	ch := make(chan map[string]any, 1)
	c.waitMu.Lock()
	if c.waits == nil {
		c.waits = map[string]chan map[string]any{}
	}
	c.waits[rid] = ch
	c.waitMu.Unlock()
	defer func() { c.waitMu.Lock(); delete(c.waits, rid); c.waitMu.Unlock() }()
	err := c.write(map[string]any{
		"type": "control_request", "request_id": rid,
		"request": map[string]any{"subtype": "cancel_async_message", "message_uuid": id},
	})
	if err != nil {
		return false, err
	}
	select {
	case r := <-ch:
		if e, _ := r["error"].(string); e != "" {
			return false, fmt.Errorf("%s", e)
		}
		got, _ := r["response"].(map[string]any)
		return got["cancelled"] == true, nil
	case <-time.After(5 * time.Second): // an older CLI that doesn't know the request may never answer
		return false, fmt.Errorf("no answer")
	}
}

// answered hands a control_response to the Unsend waiting for it.
func (c *claude) answered(line string) {
	var d struct{ Response map[string]any }
	if json.Unmarshal([]byte(line), &d) != nil || d.Response == nil {
		return
	}
	rid, _ := d.Response["request_id"].(string)
	c.waitMu.Lock()
	ch := c.waits[rid]
	c.waitMu.Unlock()
	if ch != nil {
		select { // never block the output: a second answer to one id is dropped
		case ch <- d.Response:
		default:
		}
	}
}

func (c *claude) SetMode(mode string) error {
	return c.control("set_permission_mode", map[string]any{"mode": mode})
}

func (c *claude) SetModel(model string) error {
	return c.control("set_model", map[string]any{"model": model})
}

func (c *claude) Interrupt() error { return c.control("interrupt", nil) }

// Respond answers a tool approval: allow (optionally "always", from Claude's own suggestion) or deny with feedback.
func (c *claude) Respond(rid, askLine string, a Answer) error {
	ask := parseAskRequest(askLine)
	var resp map[string]any
	if a.Allow {
		updatedInput, _ := ask["input"].(map[string]any)
		if updatedInput == nil {
			updatedInput = map[string]any{}
		} else {
			cloned := make(map[string]any, len(updatedInput))
			for k, v := range updatedInput {
				cloned[k] = v
			}
			updatedInput = cloned
		}
		resp = map[string]any{"behavior": "allow", "updatedInput": updatedInput}
		if a.Answers != nil { // AskUserQuestion: {question text: chosen label(s)}
			answers := make(map[string]any, len(a.Answers))
			for k, v := range a.Answers {
				answers[k] = v
			}
			updatedInput["answers"] = answers
		}
		if a.Always {
			if sugg, ok := ask["permission_suggestions"]; ok && sugg != nil {
				resp["updatedPermissions"] = sugg
			}
		}
	} else {
		msg := a.Message
		if msg == "" {
			msg = "The user declined this."
		}
		resp = map[string]any{"behavior": "deny", "message": msg}
	}
	return c.write(map[string]any{
		"type":     "control_response",
		"response": map[string]any{"subtype": "success", "request_id": rid, "response": resp},
	})
}

func parseAskRequest(line string) map[string]any {
	var wrap map[string]any
	if json.Unmarshal([]byte(line), &wrap) != nil {
		return map[string]any{}
	}
	req, _ := wrap["request"].(map[string]any)
	if req == nil {
		return map[string]any{}
	}
	return req
}

func (c *claude) Close() {
	c.stdin.Close()
	select {
	case <-c.p.Done:
	case <-time.After(5 * time.Second):
		c.Kill()
	}
}

func (c *claude) Kill() { c.p.Kill() }

// claudeOneShot is a one-off `claude -p` call with Haiku, the text on stdin.
func claudeOneShot(prompt, text string) (bool, string) {
	argv := append([]string{"claude", "-p", "--model", "haiku"}, untrustedArgs()...)
	r, err := procx.RunEnv(120*time.Second, text, nil, append(argv, prompt)...)
	if err != nil {
		return false, err.Error()
	}
	if r.Code == 0 {
		return true, strings.TrimSpace(r.Stdout)
	}
	out := r.Stderr
	if out == "" {
		out = r.Stdout
	}
	out = strings.TrimSpace(out)
	if len(out) > 500 {
		out = out[:500]
	}
	return false, out
}

// claudeHistory reads the CLI's transcripts (~/.claude/projects/<project>/<sid>.jsonl).
type claudeHistory struct{}

func (claudeHistory) List() []sessions.Info { return sessions.List() }

func (claudeHistory) Load(sid, agent string) ([]map[string]any, bool) {
	// the CLI writes it once the first message is queued; until then the page reads the live process instead
	if _, err := os.Stat(filepath.Join(config.Sessions, sid+".jsonl")); err != nil {
		return nil, false
	}
	return sessions.Load(sid, agent), true
}
