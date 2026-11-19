package occcli

import (
	"errors"
	"fmt"
	"os/exec"
	"syscall"
	"time"

	"github.com/spf13/cobra"
)

// ExitStatusError preserves a child command's diagnostic and native exit status.
type ExitStatusError struct{ Code int }

func (err *ExitStatusError) Error() string { return fmt.Sprintf("exit status %d", err.Code) }

func runStreamingProcess(cmd *cobra.Command, process *exec.Cmd, waitDelay time.Duration) error {
	process.Stdin = cmd.InOrStdin()
	process.Stdout, process.Stderr = cmd.OutOrStdout(), cmd.ErrOrStderr()
	// A zero delay leaves settlement to the script; development paths can bound cleanup.
	process.Cancel = func() error { return process.Process.Signal(syscall.SIGTERM) }
	process.WaitDelay = waitDelay
	err := process.Run()
	var exited *exec.ExitError
	if errors.As(err, &exited) && exited.ExitCode() > 0 && cmd.Context().Err() == nil {
		return &ExitStatusError{Code: exited.ExitCode()}
	}
	return err
}
