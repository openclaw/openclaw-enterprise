# Set up EKS with Helm OCC

Use this setup for the EKS target of [main](./main.md). Follow the user-facing
[EKS guide](../../../../docs/guides/deploy/eks.md), then the
[shared production installation](../../../../docs/guides/deploy/production-installation.md).
The guides own commands and configuration; record any missing step or workaround
in main's deviation log instead of creating an undocumented parallel installer.

## Resolve the target

Record the authorized AWS account, region, fresh cluster/VPC and database,
control-plane and Agent node groups, exact kubeconfig/context, release names,
source/chart/image identities, and retention decision. Cloud resource creation
or deletion requires explicit scope. Helm does not create the AWS foundation.
Use a separate release and fresh database for a different Plugin Driver; record
which runtime branch belongs to each Installation.

## Follow the guides in order

1. Complete the EKS guide's infrastructure, cluster selection, registry access,
   network enforcement, and storage sections. Verify the reviewed Codex sandbox
   profile on every eligible Agent node before deployment. Confirm CSI readiness
   and the selected storage configuration rather than inheriting an old cluster's
   working state.
2. For a private API, use [private EKS access](../../../../docs/guides/deploy/eks-private-access.md).
   Preserve TLS/SNI verification and the default kubeconfig. Record run-owned
   tunnels and their cleanup. An API tunnel does not provide general VPC DNS.
3. Configure [workspace routing](../../../../docs/guides/deploy/workspace-routing.md)
   and [native administration](../../../../docs/guides/deploy/native-admin.md).
   Verify private HTTPS, DNS, certificates, exact proxy sources, and tenant-local
   permissions before creating Agents.
4. Follow the production guide's configuration, database, bootstrap-volume,
   Secret, Helm-installation, and authentication steps. If using
   [installation profiles](../../../../docs/guides/deploy/installation-profiles.md),
   inspect the rendered values and protected Installation together before applying.
5. Exercise main's broker-omitted baseline, then its configured case using
   [repository installation](../../../../docs/guides/repository-credentials/installation.md).
   Configure and verify [both Slack proxies](../../../../docs/guides/integrations/slack.md#configure-both-slack-proxies)
   before Slack Agent admission.

## Hand off and clean up

Require a converged Helm release, migrated database with the limited application
role, authenticated Console, and the required presets. Continue with main's
baseline Agent and runtime/isolation checks; healthy infrastructure is not Agent
acceptance. Record actual image IDs and resulting claim identities.

Apply [main's retention decision](./runtime-acceptance.md#completion) first.
Preserve requested running Agents and their dependencies; the shutdown steps
below apply only to resources selected for disposal.

Stop run-owned Agents before closing access. Follow the recorded retention
choice for the exact cluster, database, volumes, registry artifacts, and network
resources. Verify deletion when authorized; otherwise inventory retained resources
and ongoing charges. Never delete an existing cluster merely because its name
resembles a previous run.
