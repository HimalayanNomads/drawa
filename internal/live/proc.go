package live

import (
	"io"
	"os"
	"os/exec"
	"syscall"
	"time"

	"drawa/internal/config"
)

// pipeGrace is how long output may keep arriving after the process exited, before its read end is closed so the
// exit line arrives even when a background grandchild still holds stdout.
const pipeGrace = 2 * time.Second

// Proc is an agent process in its own process group (so Kill takes its tools and agents too), run in the project
// folder, with stdout and stderr merged into one pipe. Every backend starts its process through it.
type Proc struct {
	cmd  *exec.Cmd
	Out  *os.File      // the read end of the merged output
	Done chan struct{} // closed once the process has exited
}

// StartProc starts argv (with env added to ours) and calls onExit with its exit code once it has exited.
func StartProc(argv, env []string, onExit func(code int)) (*Proc, io.WriteCloser, error) {
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Dir = config.Root
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if len(env) > 0 {
		cmd.Env = append(os.Environ(), env...)
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, nil, err
	}
	pr, pw, err := os.Pipe()
	if err != nil {
		return nil, nil, err
	}
	cmd.Stdout, cmd.Stderr = pw, pw // merged, like Python's stderr=STDOUT
	if err = cmd.Start(); err != nil {
		pr.Close()
		pw.Close()
		return nil, nil, err
	}
	pw.Close() // our copy; the child (and its own children) keep theirs until they exit
	p := &Proc{cmd: cmd, Out: pr, Done: make(chan struct{})}
	// The only Wait: it returns when the process exits, even if a background descendant still holds stdout open.
	go func() {
		cmd.Wait()
		onExit(cmd.ProcessState.ExitCode())
		close(p.Done)
		time.AfterFunc(pipeGrace, func() { pr.Close() }) // unblocks the reader if a grandchild still holds stdout
	}()
	return p, stdin, nil
}

// Kill hard-kills the process group without waiting.
func (p *Proc) Kill() {
	if p.cmd.Process != nil {
		syscall.Kill(-p.cmd.Process.Pid, syscall.SIGKILL)
	}
}

// Stop asks the process group to end (SIGTERM), then kills it if it hasn't within 5s.
func (p *Proc) Stop() {
	if p.cmd.Process != nil {
		syscall.Kill(-p.cmd.Process.Pid, syscall.SIGTERM)
	}
	select {
	case <-p.Done:
	case <-time.After(5 * time.Second):
		p.Kill()
	}
}
