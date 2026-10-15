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
