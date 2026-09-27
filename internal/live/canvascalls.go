package live

import (
	"encoding/json"
	"time"

	"drawa/internal/canvastools"
)

// Canvas tool calls: a card's agent calls the canvas MCP endpoint, the call is relayed to the newest page reading
// the card's stream (a canvas_call line), and the page's answer comes back through /api/canvas.

type Call struct {
	Done   chan struct{}
	Result map[string]any
	To     string
	closed bool
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

// Readers lists the pages reading this stream (newest last).
func (l *Live) Readers() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string(nil), l.readers...)
}
