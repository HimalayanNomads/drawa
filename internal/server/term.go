package server

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"drawa/internal/config"
	"drawa/internal/prefs"
	"drawa/internal/term"
)

// maxKeys caps one keys op: a paste bigger than this goes in several (the page batches per frame anyway).
const maxKeys = 64 << 10

// termRoute says whether terminals work here (under --net, only from this machine: see termOp)
// and which shells the Settings panel may offer.
func termRoute(q url.Values) (any, int, error) {
	return map[string]any{"supported": term.Supported(), "shells": prefs.Shells()}, 200, nil
}

// termOp is POST /api/term: open, keys, resize and close a terminal window's shell. Only from this machine: with
// --net, a device holding the network link may drive agents (each asks before it acts), but a raw shell is a step
// further than that link was meant to give.
func termOp(w http.ResponseWriter, r *http.Request, body map[string]any) {
	if config.Net && !loopback(r) {
		sendJSON(w, map[string]any{"error": "terminals open only on the machine running drawa"}, 403)
		return
	}
	num := func(k string) int { f, _ := body[k].(float64); return int(f) }
	if str(body["op"]) == "open" {
		id, err := term.Open(str(body["cwd"]), num("cols"), num("rows"))
		if err != nil {
			status := 500
			if errors.Is(err, config.ErrOutside) {
				status = 403
			}
			sendJSON(w, map[string]any{"error": err.Error()}, status)
			return
		}
		sendJSON(w, map[string]any{"id": id}, 200)
		return
	}
	id := str(body["id"])
	if !config.UUIDRe.MatchString(id) {
		http.Error(w, "", 400)
		return
	}
	var err error
	switch str(body["op"]) {
	case "close":
		err = term.Close(id)
	case "keys", "resize":
		t := term.Get(id)
		switch {
		case t == nil:
			err = term.ErrGone
		case str(body["op"]) == "resize":
			err = t.Resize(num("cols"), num("rows"))
		case len(str(body["data"])) > maxKeys:
			http.Error(w, "", 400)
			return
		default:
			err = t.Write(str(body["data"]))
		}
	default:
		http.Error(w, "", 400)
		return
	}
	switch {
	case errors.Is(err, term.ErrGone):
		sendJSON(w, map[string]any{"error": err.Error()}, 404)
	case err != nil:
		sendJSON(w, map[string]any{"error": err.Error()}, 500)
	default:
		sendJSON(w, map[string]any{"ok": true}, 200)
	}
}

// termSubs parses /api/events' `t=id:from,...`: the terminals a page shows, and the offset each has drawn up to.
func termSubs(q string) map[string]int64 {
	subs := map[string]int64{}
	for _, part := range strings.Split(q, ",") {
		id, from, _ := strings.Cut(part, ":")
		if config.UUIDRe.MatchString(id) {
			n, _ := strconv.ParseInt(from, 10, 64)
			subs[id] = n
		}
	}
	return subs
}

// termLines is what's new on the page's terminals since the last call, as tagged lines, advancing each offset.
// done remembers the ones already reported ended (exited, or gone with a server restart), so that goes out once.
func termLines(subs map[string]int64, done map[string]bool) []string {
	var out []string
	for id, from := range subs {
		if done[id] {
			continue
		}
		t := term.Get(id)
		if t == nil {
			done[id] = true
			out = append(out, `{"_t":"`+id+`","gone":true}`+"\n")
			continue
		}
		data, next, exited, code := t.Since(from)
		if len(data) > 0 {
			b, _ := json.Marshal(map[string]any{"_t": id, "from": next - int64(len(data)), "to": next, "data": base64.StdEncoding.EncodeToString(data)})
			out = append(out, string(b)+"\n")
		}
		subs[id] = next
		if exited {
			done[id] = true
			out = append(out, `{"_t":"`+id+`","exit":`+strconv.Itoa(code)+"}\n")
		}
	}
	return out
}
