package occcli

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"
)

func installationUpgradeCommand() *cobra.Command {
	var profile, evidence string
	upgrade := &cobra.Command{
		Use:   "upgrade [-- EXPERT_OPTIONS...]",
		Short: "Upgrade production images with a private operator profile",
	}
	upgrade.PersistentFlags().StringVar(&profile, "profile", "", "Owner-only production upgrade profile")
	upgrade.PersistentFlags().StringVar(&evidence, "evidence-dir", "", "Fresh evidence directory, or the original directory for recovery")
	upgrade.PersistentPreRunE = func(cmd *cobra.Command, _ []string) error {
		for _, name := range []string{"url", "service-key-file", "ca-bundle", "timeout-seconds", "namespace", "output"} {
			if cmd.Flags().Changed(name) {
				return fmt.Errorf("--%s is an OCC client option and is not used by this production upgrade; use the profile, OCC environment, or expert options after --", name)
			}
		}
		return nil
	}
	run := func(action string) func(*cobra.Command, []string) error {
		return func(cmd *cobra.Command, args []string) error {
			if action != "status" && strings.TrimSpace(profile) == "" {
				return errors.New("--profile must name the owner-only production upgrade profile")
			}
			if action != "plan" && strings.TrimSpace(evidence) == "" {
				return errors.New("--evidence-dir must name the fresh or original upgrade evidence directory")
			}
			if action == "plan" && cmd.Flags().Changed("evidence-dir") {
				return errors.New("plan does not use --evidence-dir")
			}
			if action == "status" && cmd.Flags().Changed("profile") {
				return errors.New("status reads local evidence and does not use --profile")
			}
			repository, err := checkoutRepository("occ installation upgrade", filepath.Join("scripts", "upgrade-production"))
			if err != nil {
				return err
			}
			current, err := os.Getwd()
			if err != nil {
				return err
			}
			if current != repository {
				return errors.New("run occ installation upgrade from the reviewed release checkout root so relative paths keep their meaning")
			}
			arguments := []string{action}
			if action != "status" {
				arguments = append(arguments, "--profile", profile)
			}
			if action != "plan" {
				arguments = append(arguments, "--evidence-dir", evidence)
			}
			if len(args) > 0 {
				arguments = append(arguments, "--")
				arguments = append(arguments, args...)
			}
			process := exec.CommandContext(cmd.Context(), filepath.Join(repository, "scripts", "upgrade-production"), arguments...)
			process.Dir = repository
			return runStreamingProcess(cmd, process, 0)
		}
	}
	args := func(expert bool) cobra.PositionalArgs {
		return func(cmd *cobra.Command, values []string) error {
			if len(values) > 0 && (!expert || cmd.ArgsLenAtDash() != 0) {
				return errors.New("expert upgrade options must follow --")
			}
			return nil
		}
	}
	upgrade.Args, upgrade.RunE = args(true), run("upgrade")
	for _, operation := range []struct {
		name, description string
		expert            bool
	}{
		{"plan", "Show the selected target and next steps without contacting the cluster", false},
		{"preflight", "Check the candidate with temporary cluster resources", true},
		{"status", "Report local evidence markers without contacting the cluster", false},
		{"resume", "Resume the original upgrade with its recorded evidence", true},
		{"cleanup-preflight", "Reconcile interrupted preflight cleanup", true},
	} {
		child := &cobra.Command{
			Use: operation.name, Short: operation.description,
			Args: args(operation.expert), RunE: run(operation.name),
		}
		upgrade.AddCommand(child)
	}
	config := commandGroup("config", "Find the chart-owned operation for protected Installation settings")
	for _, action := range []string{"apply", "rollback"} {
		config.AddCommand(&cobra.Command{
			Use: action, Short: "Show the supported chart operation", Args: cobra.NoArgs,
			RunE: func(_ *cobra.Command, _ []string) error {
				return errors.New("protected Installation configuration is not applied or rolled back by the image upgrade command. Use the chart-owned operation in docs/guides/deploy/production-upgrade.md#apply-other-installation-changes. A failed Helm operation can leave a Secret write in effect; inspect the recorded effects before recovery. Do not return to an earlier controller without checking committed database and authentication state compatibility; authentication changes use stopped authentication maintenance")
			},
		})
	}
	upgrade.AddCommand(config)
	return upgrade
}
