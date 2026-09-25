// Package live runs one long-running `claude` process per session card: messages go in on stdin (queued while
// busy, like the terminal), output is buffered so the page can (re)attach to the stream at any point.
package live

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"claude-ui/internal/canvastools"
	"claude-ui/internal/config"
	"claude-ui/internal/sessions"
)

const Keep = 20_000          // ponytail: output lines kept for re-attaching; older ones dropped (the transcript has them)
const KeepBytes = 40_000_000 // and at most this much text

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

type Call struct {
	Done   chan struct{}
	Result map[string]any
	To     string
	closed bool
}

type Live struct {
	mu    sync.Mutex
	Token string
	Gen   string
	Mode  string
	Model string

	cmd   *exec.Cmd
	stdin io.WriteCloser

	lines   []string
	base    int
	size    int
	last    time.Time
	asks    map[string]string // request_id -> its raw control_request line (re-sent to pages that attach later)
	readers []string          // pages reading this stream (newest last): the newest carries out canvas tool calls
	calls   map[string]*Call
	busy    bool // mid-turn: told to pages that attach (a reloaded page can't know otherwise)
	openMsg *int // line where the message being streamed began: a page attaching now reads from there
	exited  bool
}

var (
	Mu       sync.Mutex
	Registry = map[string]*Live{} // card id (from the page) -> Live
	Changed  = NewBroadcaster()   // bumped whenever any card pushes a line: wakes /api/events and meta()
)

func randHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err) // the OS RNG failing is not something we can recover from
	}
	return hex.EncodeToString(b)
}

func buildArgv(cid, sid, mode, model, token string) []string {
	argv := append([]string{}, claudeArgv...)
	if cid != "" {
		mcpCfg, _ := json.Marshal(map[string]any{
			"mcpServers": map[string]any{
				"canvas": map[string]any{"type": "http", "url": fmt.Sprintf("http://127.0.0.1:%d/mcp/%s/%s", config.Port, cid, token)},
			},
		})
		argv = append(argv, "--mcp-config", string(mcpCfg))
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
	return argv
}

// NewForTest builds a Live with no backing process, for tests that need to register a fake card without
// spawning a real `claude` process (e.g. server-package tests exercising the MCP or event-stream HTTP layer).
func NewForTest(token, gen string) *Live {
	return &Live{
		Token: token, Gen: gen, last: time.Now(),
		asks: map[string]string{}, calls: map[string]*Call{},
	}
}

// New starts a `claude` process for a card. cid == "" is used for the one-off private instance meta() drives, and
// skips the canvas MCP wiring (nothing to relay calls to).
func New(cid, sid, mode, model string) (*Live, error) {
	token := randHex(16)
	argv := buildArgv(cid, sid, mode, model, token)
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Dir = config.Root
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	pr, pw, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	cmd.Stdout, cmd.Stderr = pw, pw // merged, like Python's stderr=STDOUT
	if err := cmd.Start(); err != nil {
		pr.Close()
		pw.Close()
		return nil, err
	}
	pw.Close() // our copy; the child (and its own children) keep theirs until they exit

	l := &Live{
		Token: token, Gen: randHex(3), Mode: mode, Model: model,
		cmd: cmd, stdin: stdin, last: time.Now(),
		asks: map[string]string{}, calls: map[string]*Call{},
	}
	go l.pump(pr)
	return l, nil
}

func (l *Live) pump(r io.Reader) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 64*1024), 64*1024*1024)
	for scanner.Scan() {
		raw := scanner.Text()
		if strings.TrimSpace(raw) == "" {
			continue
		}
		l.Push(l.classify(raw) + "\n")
	}
	l.mu.Lock()
	l.busy = false
	l.mu.Unlock()
	l.cmd.Wait()
	code := -1
	if l.cmd.ProcessState != nil {
		code = l.cmd.ProcessState.ExitCode()
	}
	l.mu.Lock()
	l.exited = true
	l.mu.Unlock()
	b, _ := json.Marshal(map[string]any{"type": "exit", "code": code})
	l.Push(string(b) + "\n")
}

func (l *Live) classify(line string) string {
	if !strings.HasPrefix(line, "{") { // stderr noise -> an error line the page can show
		b, _ := json.Marshal(map[string]any{"type": "error", "text": strings.TrimSpace(line)})
		return string(b)
	}
	switch {
	case strings.HasPrefix(line, `{"type":"system","subtype":"init"`):
		l.mu.Lock()
		l.busy = true
		l.mu.Unlock()
	case strings.HasPrefix(line, `{"type":"stream_event","event":{"type":"message_start"`):
		l.mu.Lock()
		l.busy = true
		n := l.base + len(l.lines) // the index this line gets
		l.openMsg = &n
		l.mu.Unlock()
	case strings.HasPrefix(line, `{"type":"stream_event","event":{"type":"message_stop"`):
		l.mu.Lock()
		l.openMsg = nil // complete: the transcript has it now
		l.mu.Unlock()
	case strings.Contains(line, `"type":"result"`): // its keys come in any order
		var d map[string]any
		if json.Unmarshal([]byte(line), &d) == nil && d["type"] == "result" {
			l.mu.Lock()
			l.busy = false
			l.mu.Unlock()
		}
	case len(line) > 4000 && (strings.Contains(line, `"type":"user"`) || strings.Contains(line, `"type":"assistant"`)):
		line = sessions.Trimmed(line)
	case strings.Contains(line, `"can_use_tool"`) || strings.Contains(line, `"permissionMode"`):
		var d map[string]any
		if json.Unmarshal([]byte(line), &d) == nil {
			if d["type"] == "control_request" {
				if req, ok := d["request"].(map[string]any); ok && req["subtype"] == "can_use_tool" {
					if rid, ok := d["request_id"].(string); ok {
						l.mu.Lock()
						l.asks[rid] = line
						l.mu.Unlock()
					}
				}
			} else if d["subtype"] == "status" {
				if pm, _ := d["permissionMode"].(string); pm != "" {
					l.mu.Lock()
					l.Mode = pm // e.g. plan approved -> Claude left plan mode
					l.mu.Unlock()
				}
			}
		}
	}
	return line
}

func (l *Live) Push(line string) {
	l.mu.Lock()
	l.lines = append(l.lines, line)
	l.size += len(line)
	if len(l.lines) > Keep || l.size > KeepBytes {
		drop := len(l.lines) / 2
		for _, s := range l.lines[:drop] {
			l.size -= len(s)
		}
		l.lines = l.lines[drop:]
		l.base += drop
	}
	l.last = time.Now()
	l.mu.Unlock()
	Changed.Notify()
}

// Kill hard-kills the process without waiting (used when this whole server process is about to be replaced).
func (l *Live) Kill() {
	if l.cmd.Process != nil {
		l.cmd.Process.Kill()
	}
}

func (l *Live) Alive() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return !l.exited
}

func (l *Live) Write(obj map[string]any) error {
	if obj["type"] == "user" {
		l.mu.Lock()
		l.busy = true
		l.mu.Unlock()
	}
	b, err := json.Marshal(obj)
	if err != nil {
		return err
	}
	b = append(b, '\n')
	_, err = l.stdin.Write(b)
	l.mu.Lock()
	l.last = time.Now()
	l.mu.Unlock()
	return err
}

func (l *Live) Control(subtype string, kw map[string]any) {
	req := map[string]any{"subtype": subtype}
	for k, v := range kw {
		req[k] = v
	}
	l.Write(map[string]any{
		"type": "control_request", "request_id": fmt.Sprintf("ui-%d", time.Now().UnixNano()), "request": req,
	})
}

func (l *Live) Close() {
	l.stdin.Close()
	done := make(chan struct{})
	go func() { l.cmd.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		if l.cmd.Process != nil {
			l.cmd.Process.Kill()
		}
	}
}

// CanvasCall relays a canvas tool call to the page and waits for its answer (an MCP tool result).
func (l *Live) CanvasCall(name string, args map[string]any) map[string]any {
	l.mu.Lock()
	if len(l.readers) == 0 {
		l.mu.Unlock()
		return canvastools.ToolError("The canvas isn't open in a browser right now, so it can't be read or changed. Ask the user to open it.")
	}
	to := l.readers[len(l.readers)-1]
	cid := randHex(8)
	call := &Call{Done: make(chan struct{}), To: to}
	l.calls[cid] = call
	l.mu.Unlock()

	b, _ := json.Marshal(map[string]any{"type": "canvas_call", "id": cid, "to": to, "tool": name, "args": args})
	l.Push(string(b) + "\n")

	select {
	case <-call.Done:
	case <-time.After(60 * time.Second):
		l.mu.Lock()
		delete(l.calls, cid)
		l.mu.Unlock()
		return canvastools.ToolError("The canvas page didn't answer (closed, or busy). Try again or ask the user.")
	}
	l.mu.Lock()
	res := call.Result
	delete(l.calls, cid)
	l.mu.Unlock()
	return res
}

// AnswerCanvasCall is the page's answer to a canvas tool call (an MCP tool result), from /api/canvas.
func (l *Live) AnswerCanvasCall(id string, result map[string]any) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	call, ok := l.calls[id]
	if !ok || call.closed {
		return false
	}
	call.Result = result
	call.closed = true
	close(call.Done)
	return true
}

// Detach: a page stopped reading; calls it was carrying out can't be answered any more, so say so right away.
// (A page re-opening its stream reads under the same id: its calls stand while any of its streams is open.)
func (l *Live) Detach(reader string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.readers = removeOne(l.readers, reader)
	for _, r := range l.readers {
		if r == reader {
			return
		}
	}
	for _, call := range l.calls {
		if call.To == reader && !call.closed {
			call.Result = canvastools.ToolError("The canvas page closed or reloaded before answering. Try again.")
			call.closed = true
			close(call.Done)
		}
	}
}

func (l *Live) AddReader(reader string) {
	l.mu.Lock()
	l.readers = append(l.readers, reader)
	l.mu.Unlock()
}

func removeOne(s []string, v string) []string {
	for i, x := range s {
		if x == v {
			return append(append([]string{}, s[:i]...), s[i+1:]...)
		}
	}
	return s
}

// Snapshot is the buffer state an HTTP handler needs, taken under the lock.
type Snapshot struct {
	Base    int
	Lines   []string
	Busy    bool
	OpenMsg *int
	Asks    map[string]string
}

func (l *Live) Snapshot() Snapshot {
	l.mu.Lock()
	defer l.mu.Unlock()
	asks := make(map[string]string, len(l.asks))
	for k, v := range l.asks {
		asks[k] = v
	}
	var openMsg *int
	if l.openMsg != nil {
		v := *l.openMsg
		openMsg = &v
	}
	return Snapshot{Base: l.base, Lines: append([]string(nil), l.lines...), Busy: l.busy, OpenMsg: openMsg, Asks: asks}
}

// LinesFrom returns lines from n (a global index) onward, plus the buffer's new end index.
func (l *Live) LinesFrom(n int) ([]string, int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	start := n - l.base
	if start < 0 {
		start = 0
	}
	if start > len(l.lines) {
		start = len(l.lines)
	}
	return append([]string(nil), l.lines[start:]...), l.base + len(l.lines)
}

func (l *Live) Base() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.base
}

func (l *Live) PopAsk(rid string) (string, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	line, ok := l.asks[rid]
	delete(l.asks, rid)
	return line, ok
}

func (l *Live) SetMode(mode string)   { l.mu.Lock(); l.Mode = mode; l.mu.Unlock() }
func (l *Live) SetModel(model string) { l.mu.Lock(); l.Model = model; l.mu.Unlock() }
func (l *Live) GetMode() string       { l.mu.Lock(); defer l.mu.Unlock(); return l.Mode }
func (l *Live) GetModel() string      { l.mu.Lock(); defer l.mu.Unlock(); return l.Model }
