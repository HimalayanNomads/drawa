package live

import "testing"

func TestDetachFailsPendingCalls(t *testing.T) {
	l := &Live{readers: []string{"a", "b"}, calls: map[string]*Call{}}
	callX := &Call{Done: make(chan struct{}), To: "a"}
	callY := &Call{Done: make(chan struct{}), To: "b"}
	l.calls["x"], l.calls["y"] = callX, callY

	l.Detach("a")

	select {
	case <-callX.Done:
	default:
		t.Fatal("call x (reader a) should have been failed")
	}
	if callX.Result == nil || callX.Result["isError"] != true {
		t.Fatalf("call x should carry an error result, got %#v", callX.Result)
	}
	select {
	case <-callY.Done:
		t.Fatal("call y (reader b, still attached) should still be pending")
	default:
	}
}
