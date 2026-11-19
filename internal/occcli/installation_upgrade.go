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
	upgrade := commandGroup("upgrade", "Plan and apply production image upgrades")
	upgrade.Example = "  occ installation upgrade plan --profile /secure/occ/upgrade.json\n  occ installation upgrade apply --profile /secure/occ/upgrade.json"
	upgrade.SetFlagErrorFunc(func(cmd *cobra.Command, err error) error {
		if cmd == upgrade {
			return fmt.Errorf("%w. Use occ installation upgrade plan to preview or occ installation upgrade apply to deploy", err)
		}
		return err
	})
	upgrade.PersistentPreRunE = func(cmd *cobra.Command, _ []string) error {
		for _, name := range []string{"url", "service-key-file", "ca-bundle", "timeout-seconds", "namespace", "output"} {
			if cmd.Flags().Changed(name) {
				return fmt.Errorf("--%s is an OCC client option and is not used by this production upgrade; use the profile, OCC environment, or expert options after --", name)
			}
		}
		return nil
	}
	operation := func(name, action, description string) *cobra.Command {
		var profile, evidence string
		var autoApprove bool
		expert := action != "status"
		originalEvidence := action == "status" || action == "resume" || action == "cleanup-preflight" || action == "migration-apply"
		use := name
		if originalEvidence {
			use += " RUN"
		}
		if expert {
			use += " [-- EXPERT_OPTIONS...]"
		}
		cmd := &cobra.Command{
			Use:   use,
			Short: description,
			Args: func(cmd *cobra.Command, values []string) error {
				beforeDash := len(values)
				if split := cmd.ArgsLenAtDash(); split >= 0 {
					beforeDash = split
				}
				if originalEvidence {
					if beforeDash != 1 || strings.TrimSpace(values[0]) == "" {
						return errors.New("specify exactly one original evidence directory as RUN before any expert options")
					}
					values = values[1:]
				} else if expert && beforeDash != 0 {
					return errors.New("expert upgrade options must follow --")
				}
				if !expert && len(values) != 0 {
					return errors.New("this operation does not accept additional positional arguments")
				}
				return nil
			},
			RunE: func(cmd *cobra.Command, args []string) error {
				if action != "status" && strings.TrimSpace(profile) == "" {
					return errors.New("--profile must name the owner-only production upgrade profile")
				}
				if cmd.Flags().Changed("evidence-dir") && strings.TrimSpace(evidence) == "" {
					return errors.New("--evidence-dir must name the upgrade evidence directory")
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
				if profile != "" {
					arguments = append(arguments, "--profile", profile)
				}
				if originalEvidence {
					arguments = append(arguments, "--evidence-dir", args[0])
					args = args[1:]
				} else if evidence != "" {
					arguments = append(arguments, "--evidence-dir", evidence)
				}
				if autoApprove {
					arguments = append(arguments, "--auto-approve")
				}
				if len(args) > 0 {
					arguments = append(arguments, "--")
					arguments = append(arguments, args...)
				}
				process := exec.CommandContext(cmd.Context(), filepath.Join(repository, "scripts", "upgrade-production"), arguments...)
				process.Dir = repository
				return runStreamingProcess(cmd, process, 0)
			},
		}
		if action != "status" {
			cmd.Flags().StringVar(&profile, "profile", "", "Owner-only production upgrade profile")
		}
		if !originalEvidence && action != "plan" {
			cmd.Flags().StringVar(&evidence, "evidence-dir", "", "New evidence directory (default: private directory beside the profile)")
		}
		if action == "apply" || action == "resume" || action == "migration-apply" {
			cmd.Flags().BoolVar(&autoApprove, "auto-approve", false, "Approve this operation without the interactive prompt")
		}
		return cmd
	}
	upgrade.AddCommand(
		operation("plan", "plan", "Preview the target and selected images offline"),
		operation("apply", "apply", "Run preflight and deploy the selected images"),
		operation("preflight", "preflight", "Rehearse the candidate with temporary cluster resources"),
		operation("status", "status", "Inspect local evidence without contacting the cluster"),
		operation("resume", "resume", "Resume the original upgrade with its recorded evidence"),
		operation("cleanup-preflight", "cleanup-preflight", "Reconcile interrupted preflight cleanup"),
	)
	migration := commandGroup("migration", "Check or apply production database migrations")
	migration.AddCommand(
		operation("check", "migration-check", "Check migration history before a production change"),
		operation("apply", "migration-apply", "Apply and verify migrations after the separate database handoff"),
	)
	upgrade.AddCommand(migration)
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
