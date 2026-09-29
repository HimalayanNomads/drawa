package server

import (
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"drawa/internal/config"
	"drawa/internal/live"
)

var pageRe = regexp.MustCompile(`^[0-9a-f]{8,32}$`)

type heldStream struct {
	lv  *live.Live
	pos int // the next line index (global, i.e. Live.base-relative) this page hasn't read yet
}

// tag wraps a raw buffered line with its card id, by splicing `"_c":"<cid>",` right after the line's opening `{`.
// A line that isn't a non-empty object (live's classify prevents those) still goes out, as an empty error line: the
// page counts every line it gets, so dropping one here would put its position out of step.
func tag(cid, line string) string {
	if !strings.HasPrefix(line, "{") || strings.HasPrefix(strings.TrimSpace(line[1:]), "}") {
		line = `{"type":"error","text":""}` + "\n"
	}
	return `{"_c":"` + cid + `",` + line[1:]
}

// resent marks a line that isn't one of the buffer's (an ask sent again, a gap marker) with "_r":1, so the page
// doesn't count it toward its position.
func resent(line string) string { return `{"_r":1,` + line[1:] }

// gapLine tells the page lines between its position and `to` (the next line's index) were dropped from the
// buffer: the transcript has them.
func gapLine(to int) string { return `{"type":"_gap","to":` + strconv.Itoa(to) + "}\n" }

// streamEvents is a page's one stream of all its cards' output, as NDJSON lines tagged with the card ("_c").
// `c` = cid:from:gen,... (from = the card's next line, -1 = only new ones; gen = the process that offset belongs
// to). A card whose process starts later, or restarts, is read from its first line. `page` names the page for
// canvas tool calls.
func streamEvents(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	page := q.Get("page")
	if !pageRe.MatchString(page) {
		http.Error(w, "", 400)
		return
	}
	type sub struct {
		start int
		gen   string
	}
	subs := map[string]sub{}
	if c := q.Get("c"); c != "" {
		for _, part := range strings.Split(c, ",") {
			fields := strings.SplitN(part, ":", 3)
			for len(fields) < 3 {
				fields = append(fields, "")
			}
			cid, nStr, gen := fields[0], fields[1], fields[2]
			if config.UUIDRe.MatchString(cid) {
				n := -1
				if v, err := strconv.Atoi(nStr); err == nil {
					n = v
				}
				subs[cid] = sub{n, gen}
			}
		}
	}
	w.Header().Set("Content-Type", "application/x-ndjson")
	w.WriteHeader(200)
	rc := http.NewResponseController(w)

	cids := make([]string, 0, len(subs)) // a fixed order, so a card's lines always come out in one sequence
	for cid := range subs {
		cids = append(cids, cid)
	}
	slices.Sort(cids)
	lvs := make([]*live.Live, len(cids))
	keepAlive := time.NewTicker(15 * time.Second)
	defer keepAlive.Stop()

	absent := map[string]bool{}
	heldMap := map[string]*heldStream{}
	defer func() {
		for _, h := range heldMap {
			h.lv.Detach(page)
		}
	}()

	ctx := r.Context()
	for {
		seenCh := live.Changed.Wait()
		var out []string
		live.Mu.Lock() // once per wakeup, not per card
		for i, cid := range cids {
			lvs[i] = live.Registry[cid]
		}
		live.Mu.Unlock()
		for i, cid := range cids {
			s, lv := subs[cid], lvs[i]
			h := heldMap[cid]
			if lv == nil && h == nil && !absent[cid] {
				absent[cid] = true                                     // no process yet: when one starts, all of its output is new to this page
				out = append(out, tag(cid, `{"type": "absent"}`+"\n")) // (so nothing of it is running: its agents included)
			}
			start := s.start
			if lv != nil && (h == nil || h.lv != lv) { // attach
				if h != nil || absent[cid] || (s.gen != "" && s.gen != lv.Gen) {
					start = 0 // a process this page hasn't read yet: from its first line
				}
				snap := lv.Snapshot()
				var n int
				if start < 0 { // fresh (-1): new lines, plus the message being streamed right now (not in the transcript yet)
					if snap.OpenMsg != nil {
						n = *snap.OpenMsg
					} else {
						n = snap.End
					}
				} else {
					n = start
				}
				if n < snap.Base {
					n = snap.Base
				}
				missed := start < snap.Base // its approval requests may have been dropped (or never read)
				gap := start >= 0 && start < snap.Base
				if h != nil {
					h.lv.Detach(page)
				}
				lv.AddReader(page)
				h = &heldStream{lv: lv, pos: n}
				heldMap[cid] = h
				b, _ := json.Marshal(map[string]any{"type": "attach", "from": n, "gen": lv.Gen, "reader": page, "busy": snap.Busy, "queued": snap.Queued, "picked": snap.Picked})
				out = append(out, tag(cid, string(b)+"\n"))
				if gap {
					out = append(out, tag(cid, resent(gapLine(n))))
				}
				if missed && n != 0 {
					for _, a := range snap.Asks {
						out = append(out, tag(cid, resent(a)))
					}
				}
			}
			if h != nil {
				// ponytail: an unchanged card costs one lock and a compare here (its end index is its change count)
				chunk, newPos := h.lv.LinesFrom(h.pos)
				if from := newPos - len(chunk); from > h.pos { // the buffer was trimmed past what this page read
					out = append(out, tag(cid, resent(gapLine(from))))
				}
				h.pos = newPos
				for _, line := range chunk {
					out = append(out, tag(cid, line))
				}
			}
		}
		if len(out) == 0 {
			select {
			case <-seenCh: // something changed since we captured this snapshot: loop again to pick it up
			case <-keepAlive.C:
				out = []string{"\n"} // keep-alive
			case <-ctx.Done():
				return
			}
			if len(out) == 0 {
				continue
			}
		}
		// a stalled page must detach (its canvas calls go elsewhere), not hold this stream forever
		rc.SetWriteDeadline(time.Now().Add(30 * time.Second))
		if _, err := io.WriteString(w, strings.Join(out, "")); err != nil {
			return // the connection dropped
		}
		if rc.Flush() != nil {
			return
		}
		select {
		case <-ctx.Done():
			return
		default:
		}
	}
}
