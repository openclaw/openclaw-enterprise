# Deploy OpenClaw Enterprise

Install OpenClaw Enterprise (OCE), verify access to the OpenClaw Control Plane
(OCC), then deploy an Agent and check its model response. Choose one installation
path below and keep its operator shell and protected files for the next step.
Run repository commands from the matching release checkout's root. Starting OCC
needs no model credential; an Agent needs one to send a model request.

OCE's OpenShell integration is not production-qualified. Review its
[remaining qualification work](../reference/drivers/openshell-sandbox.md#remaining-qualification-work)
before choosing an OpenShell installation path.

| Task                                                     | Start here                                                           | Continue with                                                                                                       |
| -------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Try OCE on your machine                                  | [Local Setup](quickstart.md)                                         | [Deploy an Agent](quickstart.md#deploy-an-agent)                                                                    |
| Try OpenShell locally                                    | [Local k3d setup](deploy/local-setup.md)                             | [Deploy your first Agent](deploy/deploy-first-agent.md)                                                             |
| Install on an existing Kubernetes cluster with OpenShell | [Kubernetes setup](deploy/kubernetes-setup.md)                       | [Deploy your first Agent](deploy/deploy-first-agent.md)                                                             |
| Install on Amazon EKS with OpenShell                     | [EKS setup](deploy/eks-openshell-setup.md)                           | [Deploy your first Agent](deploy/deploy-first-agent.md)                                                             |
| Configure a custom Helm installation                     | [Standard Kubernetes](deploy/kubernetes.md)                          | [Production installation](deploy/production-installation.md), then [production Agents](deploy/production-agents.md) |
| Upgrade an existing Helm installation                    | [Upgrade checklist](deploy/upgrade-checklist.md)                     | [Production image upgrades](deploy/production-upgrade.md)                                                           |
| Recover an interrupted image upgrade                     | [Production upgrade recovery](deploy/production-upgrade-recovery.md) | Reconcile the original run before any retry                                                                         |

## Development

Use [Local Setup](quickstart.md) to start the platform with Kubernetes and
verify authenticated access. Then [prepare the local Agent session](quickstart.md#deploy-an-agent).
The [local Kubernetes development guide](deploy/local-kubernetes-development.md)
explains the profile for contributors working on the platform.

### Verify development

Follow [Local Setup](quickstart.md) to verify the control plane. That check
proves authenticated access; it does not prove an Agent can answer a model
request. Follow [model verification](operate/model-verification.md) for that result.
For local Kubernetes images and cleanup, see
[local operations](deploy/local-operations.md).

### Open the platform console

Use [Local Setup](quickstart.md) for local sign-in. In production, open
`/console/` on the approved internal HTTPS origin matching `OCC_AUTH_BASE_URL`.
Sign in with a human administrator account; service keys are for automation.
The [console reference](../reference/console.md) covers browser behavior and limits.

## Production

The Kubernetes and EKS setup guides install OCE with OpenShell and prepare the
shared operator session for **Deploy your first Agent**. Do not repeat the custom
installation sequence below after either setup guide. Installation profiles and
the custom Helm procedure use a separate configuration and Agent deployment path.
Cluster hosting does not select the Agent model provider.

For an already bootstrapped single-namespace installation, use the
[named runtime attachment contract](../reference/settings/named-workspace.md).
Record the original Installation ID, logical Namespace ID and independently
verified physical UID before selecting it. This path omits initialization and
requires operator-managed private routing; it does not provide a bootstrap stage.

### Production prerequisites

<Snippet file="../snippets/kubernetes-prerequisites.md" />

### Production installation sequence

For a custom Helm installation, follow these pages in order:

1. [Select images and install the control plane](deploy/production-installation.md).
   Generate configuration from an
   [installation profile](deploy/installation-profiles.md) (recommended) or copy
   the manual YAML examples, then create system Secrets, prepare the fresh
   bootstrap PVC, and [install the chart once](deploy/production-installation.md#install-the-control-plane)
   with `occ installation install`. Keep the bootstrap key in the installation shell.
   Use it there to authenticate to the production API.
2. [Prepare Namespaces and deploy Agents](deploy/production-agents.md).
   Grant tenant RoleBindings, choose embedded OpenClaw or dedicated Codex,
   and grant access to the model Secret. Switch to the [Namespace service key in a separate shell](deploy/production-agents.md#prepare-transport-credentials-and-deploy)
   before deploying the reviewed Configuration with `occ agent deploy-first`.
3. [Verify the production workload](deploy/production-agents.md#verify-production-workloads).
   Confirm the selected version and require a real model response. The guide
   offers a TUI and an HTTP check using the optional loopback password on
   Kubernetes trusted-proxy gateways.

Before upgrading a retained installation, complete the
[upgrade checklist](deploy/upgrade-checklist.md). Then use
[production image upgrades](deploy/production-upgrade.md) to release the
control plane without replacing Agent revisions, or to update Agent runtimes
and redeploy the running fleet. Runtime releases require an interruption
window. For a persistent Helm installation on k3d, use
[local k3d image upgrades](deploy/local-k3d-image-upgrade.md).

For ongoing business operation, use [production handoff](deploy/production-handoff.md)
to record owners, credential renewal, alert response, and recovery decisions.
When GitHub sign-in needs recovery or must be turned back off, use
[sign-in maintenance](deploy/auth-maintenance.md) with the API stopped.

For private workspace-file administration, configure
[Agent workspace routing](deploy/workspace-routing.md). For operational logs,
use [platform observability](observability.md).

To exercise this production procedure in a disposable local Kubernetes cluster,
[build and import local images](deploy/local-operations.md#build-images-for-local-kubernetes),
then resume the production installation sequence with the generated YAML copies.
For first-time setup, use [Local Setup](quickstart.md).

### Stop or remove a production deployment

Inventory tenant workloads before uninstalling the control plane:

```bash
helm uninstall oce --namespace openclaw-system \
  --kubeconfig "$KUBECONFIG_FILE" --kube-context "$CONTEXT"
```

Helm does not own external PostgreSQL, operator-created Secrets, bootstrap PVCs,
or tenant workloads created by Compute. Retain database, bootstrap storage, and
tenant resources until recovery and retention requirements are satisfied.

For startup diagnosis, see the [production startup flow](../flows/production-startup.md).
For runtime proof, see the [production TUI flow](../flows/production-tui.md).

## Customization

[Apply a console theme](deploy/console-theme.md) to customize the product name,
logo, browser icons, and colors through mounted files with the upstream image.

Use Helm values, Kubernetes manifests, Installation startup YAML, and Collector
Secrets for production. Use
[`deploy/runtime`](../../deploy/runtime/README.md) for runtime image recipe and
pinned source identity. The [settings reference](../reference/settings.md)
and Driver references own field defaults, precedence, and limits.

Trusted Installation YAML can also select the
[SSH Compute Driver](../reference/drivers/ssh-compute.md); that reference owns
host configuration, credentials, and operational limits.

Trusted Installation YAML can select a
[PluginDriver](../reference/drivers/plugin.md) for Agent plugin resolution. Agent
create/update stores structurally valid plugin maps; deployment startup validates
catalog membership and policy support. SSH Compute rejects nonempty plugin maps
and Agent default plugin approver policies, so use Kubernetes Compute for those
runtime paths. See
[Agent plugins](../reference/agent-plugins.md) for the current contract and
[testing](../testing/README.md) for fixture prerequisites.

## Related

- [Operate the platform](operate/README.md)
- [Troubleshoot the platform](operate/troubleshooting.md)
- [Service API keys, rotation, and bootstrap recovery](../reference/authentication/service-api-keys.md)
- [Credential renewal and revocation](deploy/credential-lifecycle.md)
- [Render installation profiles](deploy/installation-profiles.md)
- [Local Kubernetes, development TUI, and cleanup](deploy/local-operations.md)
- [Local Kubernetes development inner loop](deploy/local-kubernetes-development.md)
- [Configuration and settings](../reference/settings.md)
