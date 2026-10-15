package codex

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestSearchPagesThroughThreads(t *testing.T) {
	dir := t.TempDir()
	// app-server answers thread/list a page at a time: the second page only for the first page's cursor
	script := `#!/bin/sh
while read -r line; do
  case "$line" in
  *'"cursor":"page2"'*) echo '{"id":2,"result":{"data":[{"id":"00000000-0000-4000-8000-000000000002","name":"Auth rework","preview":"rework the login","updatedAt":2000}],"nextCursor":null}}' ;;
  *thread/list*) echo '{"id":2,"result":{"data":[{"id":"00000000-0000-4000-8000-000000000001","preview":"fix the login page","updatedAt":1000},{"id":"00000000-0000-4000-8000-000000000003","preview":"login sub-agent","updatedAt":3000,"parentThreadId":"00000000-0000-4000-8000-000000000001"}],"nextCursor":"page2"}}' ;;
  esac
done
`
	if err := os.WriteFile(filepath.Join(dir, "codex"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	listCache, searchCache = cachedThreads{}, cachedThreads{}
	found := (history{}).Search("login")
	if len(found) != 2 || found[0].Title != "Auth rework" || found[1].Title != "fix the login page" {
		t.Fatalf("Search should page through, skip sub-agents, name renamed threads by their name, newest first: %v", found)
	}
	if found := (history{}).Search("000000000001"); len(found) != 1 {
		t.Fatalf("Search by id: %v", found)
	}
}

func TestFailedFetchIsNotCached(t *testing.T) {
	var cache cachedThreads
	calls := 0
	load := func() ([]thread, bool) {
		calls++
		return []thread{{ID: "x"}}, calls > 1 // the first fails
	}
	cache.get(time.Minute, load)
	if got := cache.get(time.Minute, load); calls != 2 || len(got) != 1 {
		t.Fatalf("a failed fetch should be tried again: %d calls, %v", calls, got)
	}
	if cache.get(time.Minute, load); calls != 2 {
		t.Fatalf("a good fetch should be kept: %d calls", calls)
	}
}
