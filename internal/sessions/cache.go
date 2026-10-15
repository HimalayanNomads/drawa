package sessions

import (
	"sync"
	"time"
)

// Cache is a backend's session list kept for a few seconds, for backends whose every fetch starts their CLI while
// the page asks again after every turn (the list) or every pause in typing (a search). Asks while a fetch runs share
// it rather than start another; the lock is never held through one, and a failed fetch isn't kept.
type Cache[T any] struct {
	mu       sync.Mutex
	at       time.Time
	items    []T
	fetching *fetch[T]
}

// fetch is one fetch in progress: done closes once items holds its answer.
type fetch[T any] struct {
	done  chan struct{}
	items []T
}

// Get returns the cached items while they're fresh, else loads them again (or waits for the load already running).
// load's ok is false when it failed: the last good items are returned instead (none before the first good load), and
// the next ask tries again.
func (c *Cache[T]) Get(fresh time.Duration, load func() (items []T, ok bool)) []T {
	c.mu.Lock()
	if time.Since(c.at) < fresh {
		defer c.mu.Unlock()
		return c.items
	}
	if running := c.fetching; running != nil {
		c.mu.Unlock()
		<-running.done
		return running.items
	}
	running := &fetch[T]{done: make(chan struct{})}
	c.fetching = running
	c.mu.Unlock()
	// deferred, so a load that panics still lets the asks waiting on it go, and the next one tries again
	defer func() {
		c.mu.Lock()
		c.fetching = nil
		c.mu.Unlock()
		close(running.done)
	}()
	found, ok := load()
	c.mu.Lock()
	if ok {
		c.at, c.items = time.Now(), found
	} else if c.items != nil {
		found = c.items
	}
	c.mu.Unlock()
	running.items = found
	return found
}
