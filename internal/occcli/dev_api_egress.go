package occcli

import (
	"time"

	"github.com/openclaw/openclaw-enterprise/internal/occdev"
	"github.com/spf13/cobra"
)

func developmentAPIEgressCommand() *cobra.Command {
	var opts occdev.K3dAPIEgressOptions
	command := &cobra.Command{
		Use:   "reconcile-k3d-api-egress",
		Short: "Maintain exact Kubernetes API egress for an owned local Helm installation",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			opts.Out = cmd.OutOrStdout()
			return occdev.ReconcileK3dAPIEgress(cmd.Context(), opts)
		},
	}
	command.Flags().StringVar(&opts.DockerContext, "docker-context", "", "Explicit Docker context owning the local k3d cluster")
	command.Flags().StringVar(&opts.Cluster, "cluster", "", "Existing k3d cluster name")
	command.Flags().StringVar(&opts.Namespace, "namespace", "", "Existing OCE control-plane namespace")
	command.Flags().StringVar(&opts.NamespaceUID, "namespace-uid", "", "Installation namespace UID; refuse a recreated namespace")
	command.Flags().StringVar(&opts.Release, "release", "", "Helm release owning the dependency policy")
	command.Flags().IntVar(&opts.APIPort, "api-port", 0, "Expected Kubernetes API endpoint port")
	command.Flags().BoolVar(&opts.Apply, "apply", false, "Apply the guarded destination patch; default only reports the plan")
	command.Flags().BoolVar(&opts.Watch, "watch", false, "Reconcile continuously as installation infrastructure; requires --apply")
	command.Flags().DurationVar(&opts.Interval, "interval", 5*time.Second, "Reconciliation interval from 1s to 1m")
	return command
}
