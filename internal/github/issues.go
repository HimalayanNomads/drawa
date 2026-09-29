package github

import (
	"regexp"
	"strings"
	"unicode"
)

// LabelArg checks a label name: gh reads --label values as comma-separated (CSV), so no commas or quotes.
func LabelArg(l string) (string, error) {
	if l = strings.TrimSpace(l); l == "" || len(l) > 50 || strings.ContainsAny(l, `,"`) || strings.ContainsFunc(l, unicode.IsControl) {
		return "", errf("%q isn't a label name.", l)
	}
	return l, nil
}

var loginRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9-]{0,38}$`)

// LoginArg checks a GitHub login ("@me" is whoever gh is logged in as).
func LoginArg(l string) (string, error) {
	if l = strings.TrimSpace(l); l == "@me" {
		return l, nil
	}
	if l = strings.TrimPrefix(l, "@"); !loginRe.MatchString(l) {
		return "", errf("%q isn't a GitHub login.", l)
	}
	return l, nil
}

// flags turns a list from the page into --flag=value arguments, each value checked first.
func flags(v any, flag string, check func(string) (string, error)) ([]string, error) {
	raw, _ := v.([]any)
	out := []string{}
	for _, x := range raw {
		val, err := check(s(x))
		if err != nil {
			return nil, err
		}
		out = append(out, flag+"="+val)
	}
	return out, nil
}

func newIssue(b map[string]any) map[string]any {
	title := strings.TrimSpace(s(b["title"]))
	if title == "" {
		return fail(errf("An issue needs a title."))
	}
	labels, err := flags(b["labels"], "--label", LabelArg)
	if err != nil {
		return fail(err)
	}
	return reply(Gh(0, s(b["body"]), append([]string{"issue", "create", "--title=" + title, "--body-file", "-"}, labels...)...))
}

// edit adds and removes labels and assignees on an issue (or pull request).
func edit(b map[string]any) map[string]any {
	n, err := Num(b["n"])
	if err != nil {
		return fail(err)
	}
	args := []string{kind(b), "edit", n}
	for _, f := range []struct {
		key, flag string
		check     func(string) (string, error)
	}{{"add_labels", "--add-label", LabelArg}, {"remove_labels", "--remove-label", LabelArg},
		{"add_assignees", "--add-assignee", LoginArg}, {"remove_assignees", "--remove-assignee", LoginArg}} {
		more, err := flags(b[f.key], f.flag, f.check)
		if err != nil {
			return fail(err)
		}
		args = append(args, more...)
	}
	if len(args) == 3 {
		return fail(errf("Nothing to change."))
	}
	return reply(Gh(0, "", args...))
}
