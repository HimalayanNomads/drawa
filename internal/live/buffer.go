package live

import "time"

// A card's output buffer: lines are pushed as they come, dropped from the front after a turn (never past the
// message being streamed), and read by pages from any position.

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
