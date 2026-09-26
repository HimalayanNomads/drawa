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
	"syscall"
	"time"

	"drawa/internal/canvastools"
	"drawa/internal/config"
	"drawa/internal/sessions"
)

const Keep = 20_000          // ponytail: output lines kept for re-attaching; older ones dropped (the transcript has them)
const KeepBytes = 16_000_000 // and at most this much text

// MaxLive caps running card processes: starting one more closes the least recently used idle card (--resume
// brings it back on its next message).
const MaxLive = 12

// pipeGrace is how long output may keep arriving after the process exited, before its read end is closed so the
// exit line arrives even when a background grandchild still holds stdout.
const pipeGrace = 2 * time.Second

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
	mu      sync.Mutex
	writeMu sync.Mutex // serializes Write (the stdin pipe) so callers only need live.Mu around Registry itself
	Token   string
	Gen     string
	Mode    string
	Model   string

	cmd    *exec.Cmd
	stdin  io.WriteCloser
	mcpCfg string        // temp file with the canvas MCP config (its URL carries the token, so not on the command line)
	done   chan struct{} // closed once the process has exited (code is set by then)
	code   int

	lines   []string
	base    int
	trimTo  int // after a turn's result: lines before this can go once the next turn starts (the transcript has them)
	size    int
	last    time.Time
	asks    []ask    // open approval requests in arrival order (re-sent to pages that attach later)
	readers []string // pages reading this stream (newest last): the newest carries out canvas tool calls
	calls   map[string]*Call
	busy    bool // mid-turn: told to pages that attach (a reloaded page can't know otherwise)
	openMsg *int // line where the message being streamed began: a page attaching now reads from there
	exited  bool // the process exited, or its stdin broke: the next send starts a new one (Python: p.poll())
}

type ask struct{ rid, line string }

var (
	Mu       sync.Mutex
	Registry = map[string]*Live{}         // card id (from the page) -> Live
	starting = map[string]chan struct{}{} // cards whose process is being spawned (closed when done); under Mu
	metaLive *Live                        // Meta()'s one-off process while it runs, so KillAll gets it too; under Mu
	Changed  = NewBroadcaster()           // bumped whenever any card pushes a line: wakes /api/events and meta()
)

func randHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err) // the OS RNG failing is not something we can recover from
	}
	return hex.EncodeToString(b)
}

// writeMCPConfig writes the canvas MCP config to a 0600 temp file (CreateTemp's mode): the URL carries the card's
// token, which `ps` would show if it were on the command line.
func writeMCPConfig(cid, token string) (string, error) {
	cfg, _ := json.Marshal(map[string]any{
		"mcpServers": map[string]any{
			"canvas": map[string]any{"type": "http", "url": fmt.Sprintf("http://127.0.0.1:%d/mcp/%s/%s", config.Port, cid, token)},
		},
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

func buildArgv(sid, mode, model, mcpPath string) []string {
	argv := append([]string{}, claudeArgv...)
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
	return argv
}

// NewForTest builds a Live with no backing process, for tests that need to register a fake card without
// spawning a real `claude` process (e.g. server-package tests exercising the MCP or event-stream HTTP layer).
func NewForTest(token, gen string) *Live {
	return &Live{
		Token: token, Gen: gen, last: time.Now(), calls: map[string]*Call{},
	}
}

// New starts a `claude` process for a card. cid == "" is used for the one-off private instance meta() drives, and
// skips the canvas MCP wiring (nothing to relay calls to).
func New(cid, sid, mode, model string) (l *Live, err error) {
	token, mcpPath := randHex(16), ""
	if cid != "" {
		if mcpPath, err = writeMCPConfig(cid, token); err != nil {
			return nil, err
		}
		defer func() {
			if err != nil {
				os.Remove(mcpPath)
			}
		}()
	}
	argv := buildArgv(sid, mode, model, mcpPath)
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Dir = config.Root
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true} // its own group, so Kill takes its tools and agents too
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	pr, pw, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	cmd.Stdout, cmd.Stderr = pw, pw // merged, like Python's stderr=STDOUT
	if err = cmd.Start(); err != nil {
		pr.Close()
		pw.Close()
		return nil, err
	}
	pw.Close() // our copy; the child (and its own children) keep theirs until they exit

	l = &Live{
		Token: token, Gen: randHex(3), Mode: mode, Model: model, mcpCfg: mcpPath,
		cmd: cmd, stdin: stdin, last: time.Now(), done: make(chan struct{}), calls: map[string]*Call{},
	}
	// The only Wait: it returns when the process exits, even if a background descendant still holds stdout open.
	go func() {
		l.cmd.Wait()
		l.mu.Lock()
		l.code, l.exited = l.cmd.ProcessState.ExitCode(), true
		l.mu.Unlock()
		if l.mcpCfg != "" {
			os.Remove(l.mcpCfg)
		}
		close(l.done)
		time.AfterFunc(pipeGrace, func() { pr.Close() }) // unblocks pump if a grandchild still holds stdout
	}()
	go l.pump(pr)
	return l, nil
}

func (l *Live) pump(r io.Reader) {
	br := bufio.NewReader(r) // no line cap: a huge tool result must not stop the reading (the child would block)
	for {
		raw, err := br.ReadBytes('\n')
		if line := strings.TrimRight(string(raw), "\r\n"); strings.TrimSpace(line) != "" {
			l.Push(l.classify(line) + "\n")
		}
		if err != nil { // EOF, or the read end closed pipeGrace after the process exited
			break
		}
	}
	l.mu.Lock()
	l.busy = false
	l.mu.Unlock()
	<-l.done
	l.mu.Lock()
	code := l.code
	l.mu.Unlock()
	b, _ := json.Marshal(map[string]any{"type": "exit", "code": code})
	l.Push(string(b) + "\n")
}

func (l *Live) classify(line string) string {
	// stderr noise (anything but a non-empty JSON object) -> an error line the page can show: every line sent is
	// then a JSON object the page counts, so its position stays in step with the buffer's
	if !strings.HasPrefix(line, "{") || strings.HasPrefix(strings.TrimSpace(line[1:]), "}") || !json.Valid([]byte(line)) {
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
	case strings.Contains(line, `"type":"result"`) && isResult(line): // its keys come in any order
		l.mu.Lock()
		l.busy = false
		if len(l.asks) == 0 {
			l.trimTo = l.base + len(l.lines) // this result's index: what came before goes when the next turn starts
		}
		l.mu.Unlock()
	case len(line) > 4000 && (strings.Contains(line, `"type":"user"`) || strings.Contains(line, `"type":"assistant"`)):
		line = sessions.Trimmed(line)
	case strings.Contains(line, `"can_use_tool"`) || strings.Contains(line, `"permissionMode"`):
		var d map[string]any
		if json.Unmarshal([]byte(line), &d) == nil {
			if d["type"] == "control_request" {
				if req, ok := d["request"].(map[string]any); ok && req["subtype"] == "can_use_tool" {
					if rid, ok := d["request_id"].(string); ok {
						l.mu.Lock()
						l.asks = append(l.asks, ask{rid, line})
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

// isResult: a nested object's "type":"result" mustn't claim the line (it may still need trimming or be an ask).
func isResult(line string) bool {
	var d struct{ Type string }
	return json.Unmarshal([]byte(line), &d) == nil && d.Type == "result"
}

func (l *Live) Push(line string) {
	l.mu.Lock()
	l.lines = append(l.lines, line)
	l.size += len(line)
	if len(l.lines) > Keep || l.size > KeepBytes {
		l.dropTo(l.base + len(l.lines)/2)
	}
	l.last = time.Now()
	l.mu.Unlock()
	Changed.Notify()
}

// dropTo drops buffered lines before global index n, never past the start of the message being streamed (a page
// attaching reads from there). Called with l.mu held.
func (l *Live) dropTo(n int) {
	if l.openMsg != nil && n > *l.openMsg {
		n = *l.openMsg // ponytail: one message bigger than KeepBytes stays whole; it's freed once it completes
	}
	drop := min(n-l.base, len(l.lines))
	if drop <= 0 {
		return
	}
	for _, s := range l.lines[:drop] {
		l.size -= len(s)
	}
	clear(l.lines[:drop]) // so the dropped strings can be freed (the array itself stays shared)
	l.lines = l.lines[drop:]
	l.base += drop
}

// Kill hard-kills the process group without waiting (the server is about to be replaced, or Close timed out).
func (l *Live) Kill() {
	if l.cmd != nil && l.cmd.Process != nil {
		syscall.Kill(-l.cmd.Process.Pid, syscall.SIGKILL)
	}
}

func (l *Live) Alive() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return !l.exited
}

func (l *Live) Write(obj map[string]any) error {
	l.writeMu.Lock() // one line at a time on this card's stdin; other cards are unaffected
	defer l.writeMu.Unlock()
	if obj["type"] == "user" {
		l.mu.Lock()
		l.busy = true
		if len(l.asks) == 0 {
			// ponytail: trimmed here, not at the result, so streams still reading that turn's tail aren't cut off
			l.dropTo(l.trimTo)
		}
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
	if err != nil {
		l.exited = true // it can't take input any more: the next send starts a new process
	}
	l.mu.Unlock()
	if err != nil {
		l.Kill()
	}
	return err
}

func (l *Live) Control(subtype string, kw map[string]any) error {
	req := map[string]any{"subtype": subtype}
	for k, v := range kw {
		req[k] = v
	}
	return l.Write(map[string]any{
		"type": "control_request", "request_id": fmt.Sprintf("ui-%d", time.Now().UnixNano()), "request": req,
	})
}

func (l *Live) Close() {
	if l.stdin == nil { // NewForTest
		return
	}
	l.stdin.Close()
	select {
	case <-l.done:
	case <-time.After(5 * time.Second):
		l.Kill()
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

// Snapshot is the buffer state a page attaching needs, taken under the lock (not the lines: see LinesFrom).
type Snapshot struct {
	Base    int
	End     int // the index the next line gets
	Busy    bool
	OpenMsg *int
	Asks    []string // open approval request lines, in arrival order
}

func (l *Live) Snapshot() Snapshot {
	l.mu.Lock()
	defer l.mu.Unlock()
	asks := make([]string, len(l.asks))
	for i, a := range l.asks {
		asks[i] = a.line
	}
	var openMsg *int
	if l.openMsg != nil {
		v := *l.openMsg
		openMsg = &v
	}
	return Snapshot{Base: l.base, End: l.base + len(l.lines), Busy: l.busy, OpenMsg: openMsg, Asks: asks}
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

func (l *Live) PopAsk(rid string) (string, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for i, a := range l.asks {
		if a.rid == rid {
			l.asks = append(l.asks[:i:i], l.asks[i+1:]...)
			return a.line, true
		}
	}
	return "", false
}

// Readers lists the pages reading this stream (newest last).
func (l *Live) Readers() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string(nil), l.readers...)
}

func (l *Live) SetMode(mode string)   { l.mu.Lock(); l.Mode = mode; l.mu.Unlock() }
func (l *Live) SetModel(model string) { l.mu.Lock(); l.Model = model; l.mu.Unlock() }
func (l *Live) GetMode() string       { l.mu.Lock(); defer l.mu.Unlock(); return l.Mode }
func (l *Live) GetModel() string      { l.mu.Lock(); defer l.mu.Unlock(); return l.Model }
