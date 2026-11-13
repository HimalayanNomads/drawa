//go:build linux || darwin

package term

import (
	"os"
	"syscall"
	"unsafe"
)

const supported = true

// ioctl runs on the file's descriptor through SyscallConn, not Fd(): Fd() would switch it to blocking mode, and then
// closing the terminal couldn't wake the goroutine reading it.
func ioctl(f *os.File, req, arg uintptr) error {
	conn, err := f.SyscallConn()
	if err != nil {
		return err
	}
	var errno syscall.Errno
	if err := conn.Control(func(fd uintptr) {
		_, _, errno = syscall.Syscall(syscall.SYS_IOCTL, fd, req, arg)
	}); err != nil {
		return err
	}
	if errno != 0 {
		return errno
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
