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
	"syscall"
	"time"

	"drawa/internal/config"
)

type Result struct {
	Stdout    string
	Stderr    string
	Code      int
	Truncated bool // RunLimit: stdout passed its limit, so the process was killed and Stdout holds the first part
}

// RunEnv runs argv in the project folder with a replacement environment (nil keeps the current process's) ->
// (result, nil), or (nil, err) if it couldn't be run at all (missing binary, timeout) — a non-zero exit is a
// normal result, not a Go error, matching Python's subprocess.run.
func RunEnv(timeout time.Duration, stdin string, env []string, argv ...string) (*Result, error) {
	return RunLimit(timeout, 0, stdin, env, argv...)
}

// RunLimit is RunEnv keeping at most limit bytes of stdout (0: no limit): past that the process group is killed
// and the result is marked Truncated, so a huge output (a big diff) is never buffered whole.
func RunLimit(timeout time.Duration, limit int, stdin string, env []string, argv ...string) (*Result, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Dir = config.Root
	cmd.Env = env
	// on timeout kill the whole group (git push's ssh too), and stop waiting on pipes an escaped child still holds
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = 5 * time.Second
	if stdin != "" {
		cmd.Stdin = strings.NewReader(stdin)
	}
	var errb bytes.Buffer
	out := &capped{max: limit, full: cancel}
	cmd.Stdout, cmd.Stderr = out, &errb
	runErr := cmd.Run()
	if out.over {
		return &Result{Stdout: out.String(), Stderr: errb.String(), Code: -1, Truncated: true}, nil
	}
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

// capped is a buffer that stops at max bytes (0: never) and calls full once, when something past that arrives.
// The buffer is a named field, not embedded: embedding would inherit bytes.Buffer's ReadFrom, which io.Copy
// prefers over Write, so the cap would never run and a big output would be buffered whole.
type capped struct {
	buf  bytes.Buffer
	max  int
	over bool
	full func()
}

func (c *capped) Write(p []byte) (int, error) {
	if c.max == 0 {
		return c.buf.Write(p)
	}
	if room := c.max - c.buf.Len(); len(p) > room {
		c.buf.Write(p[:room])
		if !c.over {
			c.over = true
			c.full()
		}
		return len(p), nil
	}
	return c.buf.Write(p)
}

func (c *capped) String() string { return c.buf.String() }

// Haiku is a one-off Claude call (commit messages, PR descriptions) -> (ok, its reply or the error).
func Haiku(prompt, text string) (bool, string) {
	r, err := RunEnv(120*time.Second, text, nil, "claude", "-p", "--model", "haiku", prompt)
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
