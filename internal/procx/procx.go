// Package procx runs programs in the project folder: the plain subprocess wrapper, and the one-off
// `claude -p --model haiku` call used for commit messages and PR descriptions.
package procx

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"time"

	"claude-ui/internal/config"
)

type Result struct {
	Stdout string
	Stderr string
	Code   int
}

// Run runs argv in the project folder -> (result, nil), or (nil, err) if it couldn't be run at all (missing
// binary, timeout) — a non-zero exit is a normal result, not a Go error, matching Python's subprocess.run.
func Run(timeout time.Duration, stdin string, argv ...string) (*Result, error) {
	return RunEnv(timeout, stdin, nil, argv...)
}

// RunEnv is Run with a replacement environment (nil keeps the current process's).
func RunEnv(timeout time.Duration, stdin string, env []string, argv ...string) (*Result, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Dir = config.Root
	cmd.Env = env
	if stdin != "" {
		cmd.Stdin = strings.NewReader(stdin)
	}
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	runErr := cmd.Run()
	if ctx.Err() == context.DeadlineExceeded {
		return nil, fmt.Errorf("timed out after %s", timeout)
	}
	var exitErr *exec.ExitError
	if runErr != nil && !errors.As(runErr, &exitErr) {
		return nil, runErr
	}
	code := 0
	if cmd.ProcessState != nil {
		code = cmd.ProcessState.ExitCode()
	}
	return &Result{Stdout: out.String(), Stderr: errb.String(), Code: code}, nil
}

// Haiku is a one-off Claude call (commit messages, PR descriptions) -> (ok, its reply or the error).
func Haiku(prompt, text string) (bool, string) {
	r, err := Run(120*time.Second, text, "claude", "-p", "--model", "haiku", prompt)
	if err != nil {
		return false, err.Error()
	}
	if r.Code == 0 {
		return true, strings.TrimSpace(r.Stdout)
	}
	out := r.Stderr
	if out == "" {
		out = r.Stdout
	}
	out = strings.TrimSpace(out)
	if len(out) > 500 {
		out = out[:500]
	}
	return false, out
}
