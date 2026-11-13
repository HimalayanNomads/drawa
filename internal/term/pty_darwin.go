package term

import (
	"bytes"
	"os"
	"syscall"
	"unsafe"
)

// openPTY opens a pseudo-terminal pair: /dev/ptmx, granted and unlocked, and the slave it names.
func openPTY() (master, slave *os.File, err error) {
	master, err = os.OpenFile("/dev/ptmx", os.O_RDWR|syscall.O_NOCTTY, 0)
	if err != nil {
		return nil, nil, err
	}
	fail := func(e error) (*os.File, *os.File, error) { master.Close(); return nil, nil, e }
	if err = ioctl(master, syscall.TIOCPTYGRANT, 0); err != nil {
		return fail(err)
	}
	if err = ioctl(master, syscall.TIOCPTYUNLK, 0); err != nil {
		return fail(err)
	}
	name := make([]byte, 128)
	if err = ioctl(master, syscall.TIOCPTYGNAME, uintptr(unsafe.Pointer(&name[0]))); err != nil {
		return fail(err)
	}
	if i := bytes.IndexByte(name, 0); i >= 0 {
		name = name[:i]
	}
	slave, err = os.OpenFile(string(name), os.O_RDWR|syscall.O_NOCTTY, 0)
	if err != nil {
		return fail(err)
	}
	return master, slave, nil
}
