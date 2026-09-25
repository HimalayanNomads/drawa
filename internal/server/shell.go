package server

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"syscall"

	"claude-ui/internal/config"
)

// runShell is shell mode (! in the message box): run the command in the project folder, streaming its output.
// The last chunk is NUL + {"exit": code}. Stop = the page closing the request: the command is killed at once.
func runShell(w http.ResponseWriter, r *http.Request, cmd string) {
	if strings.TrimSpace(cmd) == "" {
		http.Error(w, "", 400)
		return
	}
	c := exec.Command("bash", "-c", cmd)
	c.Dir = config.Root
	c.Env = append(append([]string{}, os.Environ()...), "NO_COLOR=1", "TERM=dumb")
	c.SysProcAttr = &syscall.SysProcAttr{Setpgid: true} // its own process group
	stdout, err := c.StdoutPipe()
	if err != nil {
		http.Error(w, "", 500)
		return
	}
	c.Stderr = c.Stdout // merged, like Python's stderr=STDOUT
	if err := c.Start(); err != nil {
		http.Error(w, "", 500)
		return
	}
	// the page sends nothing after its request: the connection closing means Stop -> kill the whole group
	// (pipelines and whatever the command started)
	stopWatch := context.AfterFunc(r.Context(), func() {
		if c.Process != nil {
			syscall.Kill(-c.Process.Pid, syscall.SIGKILL)
		}
	})
	defer stopWatch()

	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(200)
	flusher, _ := w.(http.Flusher)
	buf := make([]byte, 65536)
	for {
		n, rerr := stdout.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				return
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
		if rerr != nil {
			break
		}
	}
	c.Wait()
	code := -1
	if c.ProcessState != nil {
		code = c.ProcessState.ExitCode()
	}
	tail, _ := json.Marshal(map[string]any{"exit": code})
	w.Write(append([]byte{0}, tail...))
}
