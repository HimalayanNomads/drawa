package codex

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"syscall"
	"time"

	"drawa/internal/config"
)

// oneOff makes one call on a private, short-lived app-server (no thread, so it costs no tokens): the model list,
// the history list, a saved thread. ponytail: a process per call (about half a second); keep one around if the
// history list is ever opened often enough for that to show.
func oneOff(method string, params, out any) error {
	args, err := projectArgs()
	if err != nil {
		return err
	}
	cmd := exec.Command("codex", append([]string{"app-server"}, args...)...)
	cmd.Dir = config.Root
	// its own group, killed whole (what it started too), and no waiting on a pipe a leftover child still holds
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.WaitDelay = 2 * time.Second
	stdin, _ := cmd.StdinPipe()
	stdout, _ := cmd.StdoutPipe()
	if err := cmd.Start(); err != nil {
		return err
	}
	kill := func() { syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	defer func() { kill(); cmd.Wait() }()
	timer := time.AfterFunc(30*time.Second, kill)
	defer timer.Stop()
	hello, _ := json.Marshal(map[string]any{"id": 1, "method": "initialize", "params": map[string]any{"clientInfo": map[string]any{"name": "drawa", "version": config.Version}}})
	req, _ := json.Marshal(map[string]any{"id": 2, "method": method, "params": params})
	fmt.Fprintf(stdin, "%s\n%s\n%s\n", hello, `{"method":"initialized"}`, req)
	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 1<<20), 1<<26) // a long thread's turns come in one line
	for sc.Scan() {
		var r struct {
			ID int `json:"id"`
			reply
		}
		if json.Unmarshal(sc.Bytes(), &r) != nil || r.ID != 2 {
			continue
		}
		if r.Error != nil {
			return errors.New(r.Error.Message)
		}
		return json.Unmarshal(r.Result, out)
	}
	return fmt.Errorf("codex %s: no answer", method)
}
