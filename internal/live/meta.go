package live

import (
	"sync"
	"time"
)

type metaCache struct {
	val    map[string]any // nil (or empty) until a real answer has arrived
	failed time.Time      // the last failed ask: not retried for a minute
}

var (
	// ponytail: one lock for every backend's ask, so concurrent callers wait for the one process rather than spawn
	// more; per-backend locks if two backends' pickers ever load at once and one is slow.
	metaMu  sync.Mutex
	metaVal = map[string]*metaCache{} // backend name -> its answer
)

// Meta returns a backend's models and slash commands/skills, asked from the backend once and cached. A failed or
// timed-out attempt is retried after a minute.
func Meta(kind string) map[string]any {
	if kind == "" {
		kind = Default
	}
	k, ok := Lookup(kind)
	if !ok || k.Meta == nil {
		return map[string]any{}
	}
	metaMu.Lock()
	defer metaMu.Unlock()
	c := metaVal[kind]
	if c == nil {
		c = &metaCache{}
		metaVal[kind] = c
	}
	if len(c.val) > 0 {
		return c.val
	}
	if time.Since(c.failed) < time.Minute {
		return map[string]any{}
	}
	if v := k.Meta(); len(v) > 0 {
		c.val = v
		return v
	}
	c.failed = time.Now()
	return map[string]any{}
}

// TrackMeta registers a backend's one-off Meta process so KillAll gets it too; the returned func closes it.
func TrackMeta(l *Live) func() {
	Mu.Lock()
	metaLive = l
	Mu.Unlock()
	return func() {
		l.Close()
		Mu.Lock()
		metaLive = nil
		Mu.Unlock()
	}
}
