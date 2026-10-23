//go:build linux || darwin

package occdev

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"syscall"
	"time"
)

// Podman starts its Compose provider as a child rather than replacing itself.
// Own the group so cancellation also stops the provider and its engine clients.
func ownComposeProcessGroup(cmd *exec.Cmd) (func() error, error) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	kill := func() error {
		if cmd.Process == nil {
			return nil
		}
		err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		if errors.Is(err, syscall.ESRCH) {
			return os.ErrProcessDone
		}
		return err
	}
	cmd.Cancel = kill
	// A child that exits while a descendant retains a pipe must not strand Run.
	cmd.WaitDelay = 2 * time.Second
	return func() error {
		if cmd.Process == nil {
			return nil
		}
		if err := kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
			return fmt.Errorf("stop Compose process group: %w", err)
		}
		deadline := time.Now().Add(5 * time.Second)
		for {
			err := syscall.Kill(-cmd.Process.Pid, 0)
			if errors.Is(err, syscall.ESRCH) {
				return nil
			}
			if err != nil {
				return fmt.Errorf("inspect Compose process group: %w", err)
			}
			if time.Now().After(deadline) {
				return fmt.Errorf("Compose process group %d has not exited; retain state until its processes are stopped", cmd.Process.Pid)
			}
			time.Sleep(10 * time.Millisecond)
		}
	}, nil
}
