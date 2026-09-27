package live

import (
	"time"

	"drawa/internal/config"
)

// ReapCap: a working card (a turn, an approval, a background agent) is never reaped as idle, unless it has been silent this long.
// ponytail: a fixed hard cap for a turn stuck forever (a hung tool); make it a setting if real turns ever run longer.
const ReapCap = 24 * time.Hour

// Start returns the card's running process, starting one if there is none. Mu is not held while spawning (a
// fork/exec can be slow): the card is reserved in `starting`, so concurrent sends for it still start only one.
// Going over config.MaxLive (when set) closes the least recently used idle card. kind names the backend.
func Start(cid, kind, sid, mode, model, effort string) (*Live, error) {
	Mu.Lock()
	for {
		if l := Registry[cid]; l != nil && l.Alive() {
			Mu.Unlock()
			return l, nil
		}
		ch, busy := starting[cid]
		if !busy {
			break
		}
		Mu.Unlock()
		<-ch // another send is starting it: use that one (or try again if it failed)
		Mu.Lock()
	}
	ch := make(chan struct{})
	starting[cid] = ch
	Mu.Unlock()

	l, err := New(cid, kind, sid, mode, model, effort)

	Mu.Lock()
	delete(starting, cid)
	close(ch)
	var victim *Live
	if err == nil {
		Registry[cid] = l
		victim = evictLocked(cid)
	}
	Mu.Unlock()
	if victim != nil {
		go victim.Close() // can take 5s: outside Mu
	}
	return l, err
}

// evictLocked removes and returns the least recently used idle card (not working, not keep) when more are running
// than config.MaxLive (if set), or more of keep's backend than its Kind.MaxLive; else nil. Called with Mu held.
func evictLocked(keep string) *Live {
	kind := ""
	if k := Registry[keep]; k != nil {
		kind = k.Kind
	}
	// lru over all cards, and over keep's backend's
	type pick struct {
		l   *Live
		cid string
		at  time.Time
	}
	var all, same pick
	running, sameRunning := 0, 0
	for cid, l := range Registry {
		l.mu.Lock()
		alive, idle, last := !l.exited, !l.working(), l.last
		l.mu.Unlock()
		if !alive {
			continue
		}
		running++
		if l.Kind == kind {
			sameRunning++
		}
		if cid == keep || !idle {
			continue
		}
		if all.l == nil || last.Before(all.at) {
			all = pick{l, cid, last}
		}
		if l.Kind == kind && (same.l == nil || last.Before(same.at)) {
			same = pick{l, cid, last}
		}
	}
	victim := pick{}
	if k, ok := Lookup(kind); ok && k.MaxLive > 0 && sameRunning > k.MaxLive {
		victim = same
	} else if config.MaxLive > 0 && running > config.MaxLive {
		victim = all
	}
	if victim.l == nil {
		return nil
	}
	delete(Registry, victim.cid)
	return victim.l
}

// Reap closes live agent processes with no traffic for IdleSecs (the next message resumes them).
func Reap() {
	for {
		time.Sleep(60 * time.Second)
		Mu.Lock()
		var idle []*Live
		for cid, l := range Registry {
			l.mu.Lock()
			quiet := time.Since(l.last)
			working := l.working()
			stale := l.exited || (!working && quiet > config.IdleSecs*time.Second) || quiet > ReapCap
			l.mu.Unlock()
			if stale {
				idle = append(idle, l)
				delete(Registry, cid)
			}
		}
		Mu.Unlock()
		for _, l := range idle { // outside Mu: a Close can take 5s, and every page's stream takes Mu
			go l.Close()
		}
	}
}

// Working counts the cards a restart would cut off mid-work (see Live.working).
func Working() int {
	Mu.Lock()
	defer Mu.Unlock()
	n := 0
	for _, l := range Registry {
		l.mu.Lock()
		if !l.exited && l.working() {
			n++
		}
		l.mu.Unlock()
	}
	return n
}

// KillAll kills every card's process group (and Meta's), and waits up to 2s in all for them to exit, so they're
// reaped before this server exits or execs itself.
func KillAll() {
	Mu.Lock()
	all := make([]*Live, 0, len(Registry)+1)
	for _, l := range Registry {
		all = append(all, l)
	}
	if metaLive != nil {
		all = append(all, metaLive)
	}
	Mu.Unlock()
	deadline := time.After(2 * time.Second)
	for _, l := range all {
		l.Kill()
	}
	for _, l := range all {
		if l.done == nil { // NewForTest
			continue
		}
		select {
		case <-l.done:
		case <-deadline:
			return
		}
	}
}
