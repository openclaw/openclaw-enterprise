package occcli

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/openclaw/openclaw-enterprise/internal/occdev"
	"github.com/spf13/cobra"
)

func developmentCommand() *cobra.Command {
	command := commandGroup("dev", "Start or stop a local development stack from a source checkout")
	// Development commands do not use the remote resource client's flags.
	command.PersistentPreRunE = func(_ *cobra.Command, _ []string) error { return nil }
	for _, action := range []struct{ name, description string }{
		{"up", "Start the selected development Compute Driver"},
		{"down", "Stop the selected development stack"},
	} {
		var keyOutput string
		var volumes bool
		child := &cobra.Command{
			Use:   action.name + " [-- COMPOSE_GLOBAL_OPTIONS...]",
			Short: action.description,
			Args: func(cmd *cobra.Command, args []string) error {
				if len(args) > 0 && cmd.ArgsLenAtDash() != 0 {
					return fmt.Errorf("Compose options must follow --")
				}
				return nil
			},
			RunE: func(cmd *cobra.Command, args []string) error {
				repository, err := developmentRepository()
				if err != nil {
					return err
				}
				options := occdev.Options{Repository: repository, KeyOutput: keyOutput, ComposeArgs: args, Volumes: volumes, Out: cmd.OutOrStdout(), Err: cmd.ErrOrStderr()}
				if action.name == "down" {
					return occdev.Down(cmd.Context(), options)
				}
				switch os.Getenv("OCC_DEVELOPMENT_COMPUTE_DRIVER") {
				case "kubernetes":
					return occdev.Up(cmd.Context(), options)
				case "", "docker":
					// Reuse the established Docker startup flow. Its Kubernetes
					// dispatch cannot recur because this branch selects Docker.
					arguments := []string{filepath.Join(repository, "scripts", "dev-up")}
					if keyOutput != "" {
						arguments = append(arguments, "--key-output", keyOutput)
					}
					arguments = append(arguments, "--")
					arguments = append(arguments, args...)
					process := exec.CommandContext(cmd.Context(), "bash", arguments...)
					process.Dir, process.Stdin = repository, cmd.InOrStdin()
					process.Stdout, process.Stderr = cmd.OutOrStdout(), cmd.ErrOrStderr()
					// On interrupt, terminate rather than kill the script so its EXIT
					// trap removes the temporary directory with the rendered Compose
					// configuration; kill it only if it does not stop in time.
					process.Cancel = func() error { return process.Process.Signal(syscall.SIGTERM) }
					process.WaitDelay = 10 * time.Second
					err := process.Run()
					// The script prints its own diagnostic; pass its status on
					// (usage errors exit 2) instead of collapsing it to 1. An
					// interrupt keeps the generic error.
					var exited *exec.ExitError
					if errors.As(err, &exited) && exited.ExitCode() > 0 && cmd.Context().Err() == nil {
						return &ExitStatusError{Code: exited.ExitCode()}
					}
					return err
				default:
					return fmt.Errorf("OCC_DEVELOPMENT_COMPUTE_DRIVER must be docker or kubernetes")
				}
			},
		}
		if action.name == "up" {
			child.Flags().StringVar(&keyOutput, "key-output", "", "Absent absolute path in a private directory for the bootstrap service key")
		} else {
			child.Flags().BoolVar(&volumes, "volumes", false, "Also delete Docker Compose volumes (Kubernetes cleanup always deletes its volumes)")
		}
		command.AddCommand(child)
	}
	var profile string
	analyze := &cobra.Command{
		Use:    "analyze-compose",
		Hidden: true,
		Args:   cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			data, err := io.ReadAll(cmd.InOrStdin())
			if err != nil {
				return err
			}
			values, err := occdev.AnalyzeCompose(data, profile)
			if err != nil {
				return err
			}
			_, err = fmt.Fprintln(cmd.OutOrStdout(), strings.Join(values, "\n"))
			return err
		},
	}
	analyze.Flags().StringVar(&profile, "profile", "docker", "Development Compute Driver")
	command.AddCommand(analyze)
	return command
}

// ExitStatusError asks the caller to exit with Code without printing anything
// more: the child process that failed has already reported why.
type ExitStatusError struct{ Code int }

func (err *ExitStatusError) Error() string { return fmt.Sprintf("exit status %d", err.Code) }

func developmentRepository() (string, error) {
	directory, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		module, err := os.ReadFile(filepath.Join(directory, "go.mod"))
		if err == nil && strings.HasPrefix(string(module), "module github.com/openclaw/openclaw-enterprise\n") {
			if _, err := os.Stat(filepath.Join(directory, "compose.yaml")); err == nil {
				return directory, nil
			}
		}
		parent := filepath.Dir(directory)
		if parent == directory {
			return "", fmt.Errorf("run occ dev from an OpenClaw Enterprise source checkout")
		}
		directory = parent
	}
}
