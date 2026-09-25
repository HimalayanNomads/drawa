package github

import (
	"reflect"
	"testing"
)

func TestNewestRunPerName(t *testing.T) {
	rollup := []any{
		map[string]any{"__typename": "CheckRun", "workflowName": "CI", "name": "test", "status": "COMPLETED", "conclusion": "FAILURE",
			"startedAt": "2026-01-01T10:00:00Z", "detailsUrl": "old"},
		map[string]any{"__typename": "CheckRun", "workflowName": "CI", "name": "test", "status": "COMPLETED", "conclusion": "SUCCESS",
			"startedAt": "2026-01-01T11:00:00Z", "detailsUrl": "rerun"}, // a re-run: the old failure must not stay
		map[string]any{"__typename": "CheckRun", "name": "lint", "status": "COMPLETED", "conclusion": "SKIPPED", "startedAt": "2026-01-01T10:00:00Z"},
		map[string]any{"__typename": "StatusContext", "context": "deploy", "state": "PENDING", "targetUrl": "d"},
	}
	got := Checks(rollup)
	want := []map[string]any{
		{"name": "CI / test", "state": "pass", "url": "rerun"},
		{"name": "lint", "state": "skip", "url": ""},
		{"name": "deploy", "state": "pending", "url": "d"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Checks() = %#v, want %#v", got, want)
	}
}
