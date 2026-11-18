package occcli

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/openclaw/openclaw-enterprise/internal/occdev"
	"github.com/spf13/cobra"
)

func developmentCommand() *cobra.Command {
	command := commandGroup("dev", "Start or stop a local development stack from a source checkout")
	command.AddCommand(&cobra.Command{
		Use:   "check",
		Short: "Check recorded Local Setup provisioning dependencies",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			repository, err := developmentRepository()
			if err != nil {
				return err
			}
			return occdev.Check(cmd.Context(), occdev.Options{Repository: repository, Out: cmd.OutOrStdout(), Err: cmd.ErrOrStderr()})
		},
	})
	// Development commands do not use the remote resource client's flags, but
	// an explicit empty --key-output must not fall back to the dev-owned path.
	command.PersistentPreRunE = func(cmd *cobra.Command, _ []string) error { return refuseEmptyFlags(cmd) }
	for _, action := range []struct{ name, description string }{
		{"up", "Start the selected development Compute Driver"},
		{"down", "Stop the selected development stack"},
	} {
		var keyOutput string
		var sandboxNetworkPolicyFile string
		var sandboxNetworkPolicyCeilingFile string
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
				options := occdev.Options{Repository: repository, KeyOutput: keyOutput, SandboxNetworkPolicyFile: sandboxNetworkPolicyFile, SandboxNetworkPolicyCeilingFile: sandboxNetworkPolicyCeilingFile, ComposeArgs: args, Volumes: volumes, Out: cmd.OutOrStdout(), Err: cmd.ErrOrStderr()}
				if action.name == "down" {
					return occdev.Down(cmd.Context(), options)
				}
				if err := occdev.CheckDevelopmentProfile(); err != nil {
					return err
				}
				profile := occdev.ResolveProfile(os.Getenv)
				switch profile.ComputeDriver {
				case "kubernetes":
					return occdev.Up(cmd.Context(), options)
				case "docker":
					if sandboxNetworkPolicyFile != "" || sandboxNetworkPolicyCeilingFile != "" {
						return fmt.Errorf("Sandbox policy input requires Kubernetes Compute and a Sandbox Driver")
					}
					// Reuse the established Docker startup flow. Its Kubernetes
					// dispatch cannot recur because this branch selects Docker.
					arguments := []string{filepath.Join(repository, "scripts", "dev-up")}
					if keyOutput != "" {
						arguments = append(arguments, "--key-output", keyOutput)
					}
					arguments = append(arguments, "--")
					arguments = append(arguments, args...)
					process := exec.CommandContext(cmd.Context(), "bash", arguments...)
					process.Dir = repository
					// Name the selection the script would otherwise default, so a
					// change to either default cannot send it back here.
					process.Env = append(os.Environ(), "OCC_DEVELOPMENT_COMPUTE_DRIVER=docker")
					return runStreamingProcess(cmd, process, 10*time.Second)
				default:
					return profile.CheckComputeDriver()
				}
			},
		}
		if action.name == "up" {
			child.Flags().StringVar(&keyOutput, "key-output", "", "Absent absolute path in a private directory for the bootstrap service key")
			child.Flags().StringVar(&sandboxNetworkPolicyCeilingFile, "sandbox-network-policy-ceiling-file", "", "YAML file bounding per-Agent network policy additions; grants no access")
			child.Flags().StringVar(&sandboxNetworkPolicyFile, "sandbox-network-policy-file", "", "YAML file of additional OpenShell binary and endpoint network policies")
		} else {
			child.Flags().BoolVar(&volumes, "volumes", false, "Also delete Docker Compose volumes (Kubernetes cleanup always deletes its volumes)")
		}
		command.AddCommand(child)
	}
	command.AddCommand(&cobra.Command{
		Use:    "check-profile",
		Hidden: true,
		Args:   cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			return occdev.CheckDevelopmentProfile()
		},
	})
	command.AddCommand(&cobra.Command{
		Use:    "prepare-browser",
		Hidden: true,
		Args:   cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			repository, err := developmentRepository()
			if err != nil {
				return err
			}
			environment, err := occdev.DockerBrowserEnvironment(repository, true)
			if err != nil {
				return err
			}
			for _, key := range []string{"OCC_DEVELOPMENT_BROWSER_ORIGIN", "OCC_DEVELOPMENT_AGENT_NATIVE_ADMIN_DOMAIN", "OCC_DEVELOPMENT_BROWSER_PORT", "OCC_DEVELOPMENT_BROWSER_TLS_CERT", "OCC_DEVELOPMENT_BROWSER_TLS_KEY"} {
				if _, err := fmt.Fprintln(cmd.OutOrStdout(), environment[key]); err != nil {
					return err
				}
			}
			return nil
		},
	})
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

func developmentRepository() (string, error) {
	return checkoutRepository("occ dev", "compose.yaml")
}
