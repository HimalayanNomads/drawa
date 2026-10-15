package sessions

import (
	"testing"
	"time"
)

func TestFailedFetchIsNotCached(t *testing.T) {
	var cache Cache[string]
	calls := 0
	load := func() ([]string, bool) {
		calls++
		return []string{"x"}, calls > 1 // the first fails
	}
	cache.Get(time.Minute, load)
	if got := cache.Get(time.Minute, load); calls != 2 || len(got) != 1 {
		t.Fatalf("a failed fetch should be tried again: %d calls, %v", calls, got)
	}
	if cache.Get(time.Minute, load); calls != 2 {
		t.Fatalf("a good fetch should be kept: %d calls", calls)
	}
}

func TestFailedFetchKeepsTheLastGoodList(t *testing.T) {
	var cache Cache[string]
	cache.Get(0, func() ([]string, bool) { return []string{"good"}, true })
	if got := cache.Get(0, func() ([]string, bool) { return nil, false }); len(got) != 1 || got[0] != "good" {
		t.Fatalf("a failed fetch should answer with the last good list: %v", got)
	}
}

func TestPanickingFetchDoesNotHangTheNext(t *testing.T) {
	var cache Cache[string]
	func() {
		defer func() { recover() }()
		cache.Get(0, func() ([]string, bool) { panic("boom") })
	}()
	answered := make(chan []string, 1)
	go func() { answered <- cache.Get(0, func() ([]string, bool) { return []string{"x"}, true }) }()
	select {
	case got := <-answered:
		if len(got) != 1 {
			t.Fatalf("got %v", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the ask after a panicking fetch hung")
	}
}
