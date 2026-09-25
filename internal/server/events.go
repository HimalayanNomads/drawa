package server

import (
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"claude-ui/internal/config"
	"claude-ui/internal/live"
)

var pageRe = regexp.MustCompile(`^[0-9a-f]{8,32}$`)

type heldStream struct {
	lv  *live.Live
	pos int // the next line index (global, i.e. Live.base-relative) this page hasn't read yet
}

// tag wraps a raw buffered line with its card id, by splicing `"_c":"<cid>",` right after the line's opening `{`.
func tag(cid, line string) string {
	if len(line) < 2 || line[1] == '}' {
		return ""
	}
	return `{"_c":"` + cid + `",` + line[1:]
}

// streamEvents is a page's one stream of all its cards' output, as NDJSON lines tagged with the card ("_c").
// `c` = cid:from:gen,... (from = the card's next line, -1 = only new ones; gen = the process that offset belongs
// to). A card whose process starts later, or restarts, is read from its first line. `page` names the page for
// canvas tool calls.
func streamEvents(w http.ResponseWriter, r *http.Request, q Q) {
	page := q["page"]
	if !pageRe.MatchString(page) {
		http.Error(w, "", 400)
		return
	}
	type sub struct {
		start int
		gen   string
	}
	subs := map[string]sub{}
	if c := q["c"]; c != "" {
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
	flusher, _ := w.(http.Flusher)

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
		for cid, s := range subs {
			live.Mu.Lock()
			lv := live.Registry[cid]
			live.Mu.Unlock()
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
						n = snap.Base + len(snap.Lines)
					}
				} else {
					n = start
				}
				if n < snap.Base {
					n = snap.Base
				}
				missed := start < snap.Base // its approval requests may have been dropped (or never read)
				if h != nil {
					h.lv.Detach(page)
				}
				lv.AddReader(page)
				h = &heldStream{lv: lv, pos: n}
				heldMap[cid] = h
				b, _ := json.Marshal(map[string]any{"type": "attach", "from": n, "gen": lv.Gen, "reader": page, "busy": snap.Busy})
				out = append(out, tag(cid, string(b)+"\n"))
				if missed && n != 0 {
					keys := make([]string, 0, len(snap.Asks))
					for k := range snap.Asks {
						keys = append(keys, k)
					}
					sort.Strings(keys)
					for _, k := range keys {
						out = append(out, tag(cid, snap.Asks[k]))
					}
				}
			}
			if h != nil {
				chunk, newPos := h.lv.LinesFrom(h.pos)
				h.pos = newPos
				for _, line := range chunk {
					out = append(out, tag(cid, line))
				}
			}
		}
		if len(out) == 0 {
			select {
			case <-seenCh: // something changed since we captured this snapshot: loop again to pick it up
			case <-time.After(15 * time.Second):
				out = []string{"\n"} // keep-alive
			case <-ctx.Done():
				return
			}
			if len(out) == 0 {
				continue
			}
		}
		if _, err := io.WriteString(w, strings.Join(out, "")); err != nil {
			return // the connection dropped
		}
		if flusher != nil {
			flusher.Flush()
		}
		select {
		case <-ctx.Done():
			return
		default:
		}
	}
}
