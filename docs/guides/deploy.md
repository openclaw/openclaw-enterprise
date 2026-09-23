# Deploy OpenClaw Enterprise

Install OpenClaw Enterprise on Kubernetes, verify access to the OpenClaw
Control Plane (OCC), then deploy an Agent and check its model response. Use
[Local Setup](quickstart.md) for a first installation on your machine. The
production guides below are for operators using an existing cluster; [Kubernetes Setup](kubernetes-setup.md) gives a short introduction. Run
repository commands from the repository root. Starting OCC needs no model
credential; an Agent needs one to send a model request.

## Development

Use [Local Setup](quickstart.md) to start the platform with Kubernetes and
verify authenticated access. Then [deploy your first Agent](first-agent.md).
The [local Kubernetes development guide](deploy/local-kubernetes-development.md)
explains the profile for contributors working on the platform.

### Verify development

Follow [Local Setup](quickstart.md) to verify the control plane. That check
proves authenticated access; it does not prove an Agent can answer a model
request. Complete [Deploy your first Agent](first-agent.md) for that result.
For local Kubernetes images and cleanup, see
[local operations](deploy/local-operations.md).

### Open the platform console

Use [Local Setup](quickstart.md) for local sign-in. In production, open
`/console/` on the approved internal HTTPS origin matching `OCC_AUTH_BASE_URL`.
Sign in with a human administrator account; service keys are for automation.
The [console reference](../reference/console.md) covers browser behavior and limits.

## Production

Choose the guide for your cluster:

- [Standard Kubernetes](deploy/kubernetes.md): prepare an existing Kubernetes
  cluster, storage, networking, and PostgreSQL.
- [Amazon EKS](deploy/eks.md): prepare AWS managed Kubernetes, node groups,
  VPC networking, EBS/EFS storage, and optional RDS PostgreSQL.

Both paths use the same Helm chart and shared installation procedure. Cluster
hosting does not select the Agent model provider.

### Production prerequisites

- Kubernetes 1.35 or later, an explicit context, enforcing NetworkPolicies,
  Helm, a version-compatible `kubectl`, Python 3, `yq` v4, and the installed
  [OCC CLI](cli.md). Older servers produce a startup warning and remain outside
  the supported boundary.
- Controller and runtime image digests (build them in the first step).
- External PostgreSQL with separate migrator and application roles.
- A Kubernetes node pool labeled for OCC control-plane Pods. The production example
  selects nodes with `oce-role: control`; the chart default is `{}`. Set
  `controlPlane.nodeSelector` to the reviewed labels for your cluster.
- A Kubernetes node pool labeled for Agent runtime Pods. The production
  Installation example selects nodes with `oce-role: agents`; set
  `drivers.compute.configuration.runtime.nodeSelector` to the reviewed labels
  for gateway and Agent scheduling.
- Operator-managed HTTPS access for approved clients; the chart does not create
  TLS or Ingress.
- Operator-created startup, database, authentication, optional Provider Secrets,
  fresh bootstrap PVC, gateway storage, and exact `/32` egress destinations.

### Production installation sequence

Follow these pages in order in the same operator shell:

1. [Build images and install the control plane](deploy/production-installation.md).
   Configure protected Installation YAML and Helm values, create system
   Secrets, prepare the fresh bootstrap PVC, install the chart, and authenticate
   to the production API.
2. [Prepare Namespaces and deploy Agents](deploy/production-agents.md).
   Grant tenant RoleBindings, choose embedded OpenClaw or dedicated Codex,
   provision exact-Agent credentials, and deploy an immutable revision.
3. [Verify the production workload](deploy/production-agents.md#verify-production-workloads).
   Confirm the active revision and require a real model response. The guide
   offers a TUI and an HTTP check using the optional loopback password on
   Kubernetes trusted-proxy gateways.

For ongoing business operation, use [production handoff](deploy/production-handoff.md)
to record owners, credential renewal, alert response, and recovery decisions.

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

Use Helm values, Kubernetes manifests, Installation startup YAML, and Collector
Secrets for production. Use
[`deploy/runtime`](../../deploy/runtime/README.md) for runtime image recipe and
package-version overrides. The [settings reference](../reference/settings.md)
and Driver references own field defaults, precedence, and limits.

Trusted Installation YAML can also select the
[SSH Compute Driver](../reference/drivers/ssh-compute.md); that reference owns
host configuration, credentials, and operational limits.

Trusted Installation YAML can select a
[PluginDriver](../reference/drivers/plugin.md) for Agent plugin resolution. Agent
create/update stores structurally valid plugin maps; deployment startup validates
catalog membership and policy support. SSH Compute rejects nonempty plugin maps,
so use Kubernetes Compute for plugin-enabled runtime proof. See
[Agent plugins](../reference/agent-plugins.md) for the current contract and
[testing](../testing/README.md) for fixture prerequisites.

## Related

- [Operate the platform](operate/README.md)
- [Troubleshoot the platform](operate/troubleshooting.md)
- [Service API keys, rotation, and bootstrap recovery](../reference/authentication/service-api-keys.md)
- [Credential renewal and revocation](deploy/credential-lifecycle.md)
- [Local Kubernetes, development TUI, and cleanup](deploy/local-operations.md)
- [Local Kubernetes development inner loop](deploy/local-kubernetes-development.md)
- [Configuration and settings](../reference/settings.md)
