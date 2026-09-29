package github

import (
	"regexp"
	"strconv"
	"strings"
	"time"
)

var runJobRe = regexp.MustCompile(`/actions/runs/(\d+)/job/(\d+)`)

// Log is the failing steps' log of a GitHub Actions job (from a check's details URL), for Claude to read.
func Log(url string) (map[string]any, error) {
	m := runJobRe.FindStringSubmatch(url)
	if m == nil {
		return nil, errf("Only GitHub Actions checks have logs here; open the check's page for others.")
	}
	out, err := Gh(120*time.Second, "", "run", "view", m[1], "--job", m[2], "--log-failed")
	if err != nil {
		// ponytail: matched on gh's error text; GitHub answers 410 Gone once a run's logs have expired
		if strings.Contains(err.Error(), "HTTP 410") {
			return nil, errf("GitHub no longer keeps this run's logs (they expire).")
		}
		return nil, err
	}
	if len(out) > 20_000 {
		out = out[len(out)-20_000:]
	}
	return map[string]any{"log": out}, nil
}

// RunState is one word for a workflow run or check: pending until it's done, then pass, skip or fail.
func RunState(status, conclusion string) string {
	if !strings.EqualFold(status, "completed") {
		return "pending"
	}
	switch strings.ToLower(conclusion) {
	case "success":
		return "pass"
	case "skipped", "neutral":
		return "skip"
	}
	return "fail"
}

// Runs lists the repo's recent GitHub Actions workflow runs, newest first (one more than asked: there are more).
func Runs(limit string) ([]map[string]any, error) {
	n, _ := strconv.Atoi(limit)
	n = min(max(n, ListMax), ListCap)
	var raw []map[string]any
	if err := GhJSON(0, "", &raw, "run", "list", "--limit", strconv.Itoa(n+1), "--json",
		"databaseId,displayTitle,workflowName,status,conclusion,headBranch,event,createdAt,url,attempt"); err != nil {
		return nil, err
	}
	out := make([]map[string]any, len(raw))
	for i, r := range raw {
		out[i] = map[string]any{
			"id": r["databaseId"], "title": r["displayTitle"], "workflow": r["workflowName"], "branch": r["headBranch"],
			"event": r["event"], "created": r["createdAt"], "url": r["url"], "attempt": r["attempt"],
			"conclusion": orEmpty(r["conclusion"]), "state": RunState(s(r["status"]), s(r["conclusion"])),
		}
	}
	return out, nil
}

// rerun starts a workflow run again: only its failed jobs (and what they need), or all of it.
func rerun(b map[string]any) map[string]any {
	id, err := Num(b["run"])
	if err != nil {
		return fail(err)
	}
	args := []string{"run", "rerun", id}
	if truthy(b["failed"]) {
		args = append(args, "--failed")
	}
	return reply(Gh(0, "", args...))
}
