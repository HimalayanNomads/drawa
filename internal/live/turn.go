package live

import (
	"bytes"
	"encoding/json"
)

// Turn is the message/block bookkeeping shared by the backends that translate their own events into the wire
// format (wire.go), such as OpenCode's v1 and v2 translators: each streams one assistant message at a time, block
// by block, and closes a turn with the same wire lines, however differently its agent reports them.
type Turn struct {
	Sid    string  // the card's session id in the backend's own terms
	Model  string  // the model, shown on the card
	Window float64 // the model's context window, when the backend knows it (0: it doesn't)

	Msg    string              // the card's assistant message being streamed ("" between messages)
	Next   int                 // the next block index in it
	Blocks map[string]*Block   // a translator-chosen key -> its block in the stream
	Open   []*Block            // blocks started and not stopped, in order
	Calls  map[string]ToolCall // tool call id -> its Claude name and input (for asks about it)

	Results map[string]bool // tool calls whose result was sent

	Busy                bool // mid-turn: init was sent, result not yet
	Turns               int
	Cost                float64
	Usage               Tokens
	Started, Ended      float64 // ms: the turn's first assistant message was created, its last one completed
	ErrName, ErrMessage string
}

func NewTurn(sid, model string) Turn {
	return Turn{Sid: sid, Model: model, Blocks: map[string]*Block{}, Calls: map[string]ToolCall{}, Results: map[string]bool{}}
}

func (t *Turn) SetModel(m string) { t.Model = m }
func (t *Turn) SetSid(sid string) { t.Sid = sid }

type Block struct {
	Index int
	Kind  string // text | thinking
	Sent  int    // bytes of the part's text already sent
	Msg   string // the message it belongs to
}

type ToolCall struct {
	Name  string
	Input map[string]any
}

// Tokens is a step's token usage. The JSON tags are OpenCode's shape (its translator unmarshals into it); other
// backends set the fields.
type Tokens struct {
	Input  float64 `json:"input"`
	Output float64 `json:"output"`
	Cache  struct {
		Read  float64 `json:"read"`
		Write float64 `json:"write"`
	} `json:"cache"`
}

// Obj is a JSON object that keeps its keys in order (key, value, key, value, …): Live.classify recognizes lines
// by how they start, e.g. {"type":"stream_event","event":{"type":"message_start".
type Obj []any

func (o Obj) MarshalJSON() ([]byte, error) {
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

func Line(o Obj) string {
	b, _ := json.Marshal(o)
	return string(b)
}

func StreamEvent(ev Obj) string { return Line(Obj{"type", "stream_event", "event", ev}) }

func (t *Turn) Begin() {
	t.Busy, t.Turns, t.Cost, t.Started, t.Ended, t.ErrName, t.ErrMessage = true, 0, 0, 0, 0, "", ""
}

func (t *Turn) StartMessage(id string) []string {
	out := t.StopMessage()
	t.Msg, t.Next = id, 0
	// ponytail: usage is known only once a step ends, so the context meter shows the previous step's input
	u := t.Usage
	return append(out, StreamEvent(Obj{"type", "message_start", "message", Obj{"id", id, "model", t.Model,
		"usage", Obj{"input_tokens", u.Input, "cache_read_input_tokens", u.Cache.Read, "cache_creation_input_tokens", u.Cache.Write}}}))
}

func (t *Turn) StopMessage() []string {
	if t.Msg == "" {
		return nil
	}
	var out []string
	for _, b := range t.Open {
		out = append(out, StreamEvent(Obj{"type", "content_block_stop", "index", b.Index}))
	}
	t.Open, t.Msg = nil, ""
	t.Turns++
	return append(out, StreamEvent(Obj{"type", "message_stop"}))
}

func (t *Turn) Delta(b *Block, text string) string {
	key := "text"
	if b.Kind == "thinking" {
		key = "thinking"
	}
	return StreamEvent(Obj{"type", "content_block_delta", "index", b.Index, "delta", Obj{"type", key + "_delta", key, text}})
}

func (t *Turn) IsOpen(b *Block) bool {
	for _, o := range t.Open {
		if o == b {
			return true
		}
	}
	return false
}

func (t *Turn) Stop(b *Block) string {
	for i, o := range t.Open {
		if o == b {
			t.Open = append(t.Open[:i:i], t.Open[i+1:]...)
			break
		}
	}
	return StreamEvent(Obj{"type", "content_block_stop", "index", b.Index})
}

// End: the card's session went idle; the turn's result. Backends set ErrName to flag an abort (subtype
// error_during_execution, which the page reads as "Stopped") versus any other error.
func (t *Turn) End(aborted func(name string) bool) []string {
	out := t.StopMessage()
	subtype, isErr := "success", false
	switch {
	case aborted(t.ErrName):
		subtype, isErr = "error_during_execution", true
	case t.ErrName != "":
		subtype, isErr = "error", true
	}
	dur := 0.0
	if t.Ended > t.Started && t.Started > 0 {
		dur = t.Ended - t.Started
	}
	u := t.Usage
	t.Busy = false
	res := Obj{"type", "result", "subtype", subtype, "is_error", isErr, "result", t.ErrMessage,
		"session_id", t.Sid, "num_turns", t.Turns, "duration_ms", dur, "total_cost_usd", t.Cost,
		"usage", Obj{"input_tokens", u.Input, "output_tokens", u.Output, "cache_read_input_tokens", u.Cache.Read, "cache_creation_input_tokens", u.Cache.Write}}
	if t.Window > 0 {
		res = append(res, "modelUsage", Obj{t.Model, Obj{"contextWindow", t.Window}})
	}
	return append(out, Line(res))
}
