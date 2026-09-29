package github

import (
	"cmp"
	"strings"
	"sync"

	"drawa/internal/gitx"
)

// Pr fetches one pull request in full: its diff, comments, reviews and inline (line) comments. The three `gh`
// calls are independent (none needs another's result), so they run concurrently rather than one after another.
func Pr(n string) (map[string]any, error) {
	n, err := Num(n)
	if err != nil {
		return nil, err
	}
	var p map[string]any
	var pages []any
	var diff string
	var viewErr, pagesErr error
	var derr error
	var wg sync.WaitGroup
	wg.Add(3)
	go func() {
		defer wg.Done()
		fields := PRList + ",url,body,additions,deletions,changedFiles,reviews,comments,mergeable,createdAt"
		viewErr = GhJSON(0, "", &p, "pr", "view", n, "--json", fields)
	}()
	go func() {
		defer wg.Done()
		// comments on lines of code (reviews' inline comments): not in `pr view`. --slurp: every page, as one list of pages.
		pagesErr = GhJSON(0, "", &pages, "api", "--paginate", "--slurp", "repos/{owner}/{repo}/pulls/"+n+"/comments?per_page=100")
	}()
	go func() {
		defer wg.Done()
		diff, derr = Gh(0, "", "pr", "diff", n)
	}()
	wg.Wait()
	if viewErr != nil {
		return nil, viewErr
	}
	var inline []map[string]any
	inlineError := ""
	if pagesErr != nil {
		inlineError = strings.SplitN(pagesErr.Error(), "\n", 2)[0]
	} else {
		for _, page := range pages {
			if items, ok := page.([]any); ok {
				for _, it := range items {
					if m, ok := it.(map[string]any); ok {
						inline = append(inline, m)
					}
				}
			}
		}
	}
	if derr != nil {
		diff = "(no diff: " + derr.Error() + ")"
	}
	diffTrunc := len(diff) > DiffMax
	if diffTrunc {
		diff = diff[:DiffMax]
	}
	var comments, reviews []map[string]any
	for _, c := range asList(p["comments"]) {
		comments = append(comments, Comment(c))
	}
	for _, r := range asList(p["reviews"]) {
		if body, _ := r["body"].(string); body != "" || s(r["state"]) != "COMMENTED" {
			row := Comment(r)
			row["state"] = r["state"]
			reviews = append(reviews, row)
		}
	}
	var inlineOut []map[string]any
	for _, c := range inline {
		row := Comment(c)
		row["path"] = c["path"]
		line := c["line"]
		if line == nil {
			line = c["original_line"]
		}
		row["line"] = line
		row["side"] = cmp.Or(s(c["side"]), "RIGHT")
		row["outdated"] = c["line"] == nil // its line is gone from the current diff: shown apart, not under a line
		hunk := s(c["diff_hunk"])
		if len(hunk) > 600 {
			hunk = hunk[len(hunk)-600:]
		}
		row["hunk"] = hunk
		inlineOut = append(inlineOut, row)
	}
	row := PrRow(p)
	row["url"] = p["url"]
	row["body"] = s(p["body"])
	row["additions"] = p["additions"]
	row["deletions"] = p["deletions"]
	row["files"] = p["changedFiles"]
	row["mergeable"] = p["mergeable"]
	row["created"] = p["createdAt"]
	row["comments"] = gitx.NonNil(comments)
	row["reviews"] = gitx.NonNil(reviews)
	row["inline"] = gitx.NonNil(inlineOut)
	row["inline_error"] = inlineError
	row["diff"] = diff
	row["diff_truncated"] = diffTrunc
	return row, nil
}

func asList(v any) []map[string]any {
	raw, _ := v.([]any)
	out := make([]map[string]any, 0, len(raw))
	for _, x := range raw {
		if m, ok := x.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}

func Issue(n string) (map[string]any, error) {
	nn, err := Num(n)
	if err != nil {
		return nil, err
	}
	var i map[string]any
	if err := GhJSON(0, "", &i, "issue", "view", nn, "--json", "number,title,body,author,state,labels,assignees,url,comments,createdAt,updatedAt"); err != nil {
		return nil, err
	}
	row := IssueRow(i)
	row["body"] = s(i["body"])
	row["url"] = i["url"]
	row["created"] = i["createdAt"]
	var assignees []string
	for _, a := range asList(i["assignees"]) {
		assignees = append(assignees, s(a["login"]))
	}
	row["assignees"] = gitx.NonNil(assignees)
	var comments []map[string]any
	for _, c := range asList(i["comments"]) {
		comments = append(comments, Comment(c))
	}
	row["comments"] = gitx.NonNil(comments)
	return row, nil
}

// PrChecks is only a pull request's checks: what the window polls while some are still running.
func PrChecks(n string) ([]map[string]any, error) {
	n, err := Num(n)
	if err != nil {
		return nil, err
	}
	var p map[string]any
	if err := GhJSON(0, "", &p, "pr", "view", n, "--json", "statusCheckRollup"); err != nil {
		return nil, err
	}
	checks, _ := p["statusCheckRollup"].([]any)
	return Checks(checks), nil
}
