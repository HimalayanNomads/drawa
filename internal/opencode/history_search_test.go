package opencode

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"drawa/internal/config"
	"drawa/internal/sessions"
)

// fakeCLI puts an executable script named name first on PATH.
func fakeCLI(t *testing.T, name, script string) {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, name), []byte("#!/bin/sh\n"+script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

func TestSearchAllSessions(t *testing.T) {
	root := config.Root
	// the list asks for the newest 200 of every folder, the search for all of them: only the search sees the old one
	fakeCLI(t, "opencode", fmt.Sprintf(`case "$*" in
*"--max-count 200"*) echo '[{"id":"ses_newnewnewnewnew","title":"Fix the login","updated":3000,"directory":%[1]q}]' ;;
*) echo '[{"id":"ses_newnewnewnewnew","title":"Fix the login","updated":3000,"directory":%[1]q},
{"id":"ses_childchildchild","title":"login sub-task","updated":2500,"directory":%[1]q,"parentID":"ses_newnewnewnewnew"},
{"id":"ses_otherotherother","title":"login elsewhere","updated":2000,"directory":"/somewhere/else"},
{"id":"ses_oldoldoldoldold","title":"Old login rework","updated":1000,"directory":%[1]q}]' ;;
esac
`, root))
	listCache, searchCache = sessions.Cache[session]{}, sessions.Cache[session]{}
	if list := (history{}).List(); len(list) != 1 {
		t.Fatalf("List: %v", list)
	}
	found := (history{}).Search("LOGIN")
	if len(found) != 2 || found[0].ID != "ses_newnewnewnewnew" || found[1].ID != "ses_oldoldoldoldold" {
		t.Fatalf("Search should find this folder's top-level sessions, newest first, beyond the list: %v", found)
	}
	if found := (history{}).Search("ses_oldold"); len(found) != 1 || found[0].Title != "Old login rework" {
		t.Fatalf("Search by id: %v", found)
	}
	if found := (history{}).Search("login payments"); len(found) != 0 {
		t.Fatalf("every word must match: %v", found)
	}
}
