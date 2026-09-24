//go:build darwin || dragonfly || freebsd || linux || netbsd || openbsd

package occdev

import (
	"errors"
	"os"
	"os/exec"
	"syscall"
)

func ownCommand(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL); err != nil {
			if errors.Is(err, syscall.ESRCH) {
				return os.ErrProcessDone
			}
			return err
		}
		return nil
	}
}
