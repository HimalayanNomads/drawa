//go:build linux || darwin

package term

import (
	"os"
	"syscall"
	"unsafe"
)

const supported = true

func ioctl(f *os.File, req, arg uintptr) error {
	if _, _, e := syscall.Syscall(syscall.SYS_IOCTL, f.Fd(), req, arg); e != 0 {
		return e
	}
	return nil
}

// setSize tells the terminal its size; the kernel sends the shell's foreground job SIGWINCH.
func setSize(master *os.File, cols, rows int) error {
	ws := struct{ rows, cols, x, y uint16 }{uint16(rows), uint16(cols), 0, 0}
	return ioctl(master, syscall.TIOCSWINSZ, uintptr(unsafe.Pointer(&ws)))
}

// ttyAttr makes the child a session leader whose controlling terminal is its stdin (the slave), as a login shell
// in a terminal emulator gets.
func ttyAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setsid: true, Setctty: true, Ctty: 0}
}

// hangUp sends SIGHUP to the shell's whole process group, as closing a terminal window does.
func hangUp(pid int) { syscall.Kill(-pid, syscall.SIGHUP) }
