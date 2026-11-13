//go:build !linux && !darwin

package term

import (
	"errors"
	"os"
	"syscall"
)

const supported = false

var errUnsupported = errors.New("terminals aren't supported on this system")

func openPTY() (*os.File, *os.File, error) { return nil, nil, errUnsupported }
func setSize(*os.File, int, int) error     { return errUnsupported }
func ttyAttr() *syscall.SysProcAttr        { return nil }
func hangUp(int)                           {}
