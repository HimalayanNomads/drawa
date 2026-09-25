package live

import "sync"

// Broadcaster is a repeatable wakeup signal: Wait() returns a channel that closes the next time Notify() runs.
// It replaces Python's threading.Condition for both the per-card buffer and the global "something changed" signal
// that wakes the multiplexed /api/events stream, and supports select-based timeouts naturally.
type Broadcaster struct {
	mu sync.Mutex
	ch chan struct{}
}

func NewBroadcaster() *Broadcaster { return &Broadcaster{ch: make(chan struct{})} }

func (b *Broadcaster) Wait() <-chan struct{} {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.ch
}

func (b *Broadcaster) Notify() {
	b.mu.Lock()
	old := b.ch
	b.ch = make(chan struct{})
	b.mu.Unlock()
	close(old)
}
