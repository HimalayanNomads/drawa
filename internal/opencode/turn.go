package opencode

import (
	"bytes"
	"encoding/json"
)

// turn is the message/block bookkeeping shared by OpenCode's v1 and v2 event translators (translate.go,
// translate2.go): both stream one assistant message at a time, block by block, and close a turn with the same
// wire lines, even though the two servers report it through entirely different events.
type turn struct {
	sid   string // the card's session (ses_…)
	model string // provider/model, shown on the card

	msg    string            // the card's assistant message being streamed ("" between messages)
	next   int               // the next block index in it
	blocks map[string]*block // a translator-chosen key -> its block in the stream
	open   []*block          // blocks started and not stopped, in order
	calls  map[string]call   // tool call id -> its Claude name and input (for asks about it)

	results map[string]bool // tool calls whose result was sent

	busy                bool // mid-turn: init was sent, result not yet
	turns               int
	cost                float64
	usage               tokens
	started, ended      float64 // ms: the turn's first assistant message was created, its last one completed
	errName, errMessage string
}

func newTurn(sid, model string) turn {
	return turn{sid: sid, model: model, blocks: map[string]*block{}, calls: map[string]call{}, results: map[string]bool{}}
}

func (t *turn) setModel(m string) { t.model = m }
func (t *turn) setSid(sid string) { t.sid = sid }

type block struct {
	index int
	kind  string // text | thinking
	sent  int    // bytes of the part's text already sent
	msg   string
}

type call struct {
	name  string
	input map[string]any
}

type tokens struct {
	Input  float64 `json:"input"`
	Output float64 `json:"output"`
	Cache  struct {
		Read  float64 `json:"read"`
		Write float64 `json:"write"`
	} `json:"cache"`
}

// obj is a JSON object that keeps its keys in order (key, value, key, value, …): live's classify recognizes lines
// by how they start, e.g. {"type":"stream_event","event":{"type":"message_start".
type obj []any

func (o obj) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	b.WriteByte('{')
	for i := 0; i+1 < len(o); i += 2 {
		if i > 0 {
			b.WriteByte(',')
		}
		k, _ := json.Marshal(o[i])
		v, err := json.Marshal(o[i+1])
		if err != nil {
			return nil, err
		}
		b.Write(k)
		b.WriteByte(':')
		b.Write(v)
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}

func line(o obj) string {
	b, _ := json.Marshal(o)
	return string(b)
}

func streamEvent(ev obj) string { return line(obj{"type", "stream_event", "event", ev}) }

func (t *turn) begin() {
	t.busy, t.turns, t.cost, t.started, t.ended, t.errName, t.errMessage = true, 0, 0, 0, 0, "", ""
}

func (t *turn) startMessage(id string) []string {
	out := t.stopMessage()
	t.msg, t.next = id, 0
	// ponytail: OpenCode reports tokens when a step ends, so the context meter shows the previous step's input
	u := t.usage
	return append(out, streamEvent(obj{"type", "message_start", "message", obj{"id", id, "model", t.model,
		"usage", obj{"input_tokens", u.Input, "cache_read_input_tokens", u.Cache.Read, "cache_creation_input_tokens", u.Cache.Write}}}))
}

func (t *turn) stopMessage() []string {
	if t.msg == "" {
		return nil
	}
	var out []string
	for _, b := range t.open {
		out = append(out, streamEvent(obj{"type", "content_block_stop", "index", b.index}))
	}
	t.open, t.msg = nil, ""
	t.turns++
	return append(out, streamEvent(obj{"type", "message_stop"}))
}

func (t *turn) delta(b *block, text string) string {
	key := "text"
	if b.kind == "thinking" {
		key = "thinking"
	}
	return streamEvent(obj{"type", "content_block_delta", "index", b.index, "delta", obj{"type", key + "_delta", key, text}})
}

func (t *turn) isOpen(b *block) bool {
	for _, o := range t.open {
		if o == b {
			return true
		}
	}
	return false
}

func (t *turn) stop(b *block) string {
	for i, o := range t.open {
		if o == b {
			t.open = append(t.open[:i:i], t.open[i+1:]...)
			break
		}
	}
	return streamEvent(obj{"type", "content_block_stop", "index", b.index})
}

// end: the card's session went idle; the turn's result. Backends set errName to flag an abort (subtype
// error_during_execution, which the page reads as "Stopped") versus any other error.
func (t *turn) end(aborted func(name string) bool) []string {
	out := t.stopMessage()
	subtype, isErr := "success", false
	switch {
	case aborted(t.errName):
		subtype, isErr = "error_during_execution", true
	case t.errName != "":
		subtype, isErr = "error", true
	}
	dur := 0.0
	if t.ended > t.started && t.started > 0 {
		dur = t.ended - t.started
	}
	u := t.usage
	t.busy = false
	return append(out, line(obj{"type", "result", "subtype", subtype, "is_error", isErr, "result", t.errMessage,
		"session_id", t.sid, "num_turns", t.turns, "duration_ms", dur, "total_cost_usd", t.cost,
		"usage", obj{"input_tokens", u.Input, "output_tokens", u.Output, "cache_read_input_tokens", u.Cache.Read, "cache_creation_input_tokens", u.Cache.Write}}))
}
