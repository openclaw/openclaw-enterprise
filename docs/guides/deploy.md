# Deploy OpenClaw Enterprise

Choose a local or production OpenClaw Control Plane (OCC) deployment, verify
authenticated access, then deploy Agents when you are ready to prove a workload.
Run commands from the repository root. Startup needs no model credential.

## Development

Use the [quickstart](quickstart.md) for Docker or Podman Compose startup,
console sign-in, service-key handling, and the first authenticated
`/installation` check. The
[Compose development flow](../flows/docker-compose-development.md) owns startup
internals.

The current Podman verification baseline is Podman client 6.1.0, server 5.7.1,
and podman-compose 1.6.0. The verified boundary is default control-plane startup,
worker access to the Podman API, authenticated Installation access, Namespace
isolation, and an embedded OpenClaw Agent with a provider-backed model turn.
Dedicated Codex, interactive TUI, and the optional Fluentd logging override
remain Docker-verified.

### Verify development

Follow [Read the Installation with the bootstrap service key](quickstart.md#read-the-installation-with-the-bootstrap-service-key).
That check proves controller access, not an Agent deployment or model turn.
For local TUI proof, cleanup, and local Kubernetes images, use
[local operations](deploy/local-operations.md). For log export, use
[platform observability](observability.md#docker-compose).

### Open the platform console

Use [Open the platform console](quickstart.md#open-the-platform-console) for
local sign-in. Production uses the same `/console/` path on the approved
internal HTTPS origin matching `OCC_AUTH_BASE_URL`; browser login uses the
human administrator session path, not service keys. The
[console reference](../reference/console.md) owns console behavior and limits.

## Production

### Production prerequisites

- Explicit Kubernetes context, enforcing NetworkPolicies, Helm, `kubectl`,
  Python 3, and `yq` v4.
- Controller and runtime image digests (build them in the first step).
- External PostgreSQL with separate migrator and application roles.
- Operator-managed HTTPS access for approved clients; the chart does not create
  TLS or Ingress.
- Operator-created startup, database, authentication, optional Provider Secrets,
  fresh bootstrap PVC, gateway storage, and exact egress destinations.

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
   Confirm the active revision, gateway access, and TUI model-turn proof for
   token-authenticated gateways.

For ongoing business operation, use [production handoff](deploy/production-handoff.md)
to record owners, credential renewal, alert response, and recovery decisions.

For private workspace-file administration, configure
[Agent workspace routing](deploy/workspace-routing.md). For operational logs,
use [platform observability](observability.md).

For a disposable local Kubernetes trial, first
[build and import local images](deploy/local-operations.md#build-images-for-local-kubernetes),
then resume the production installation sequence with the generated YAML copies.

### Stop or remove a production deployment

Inventory tenant workloads before uninstalling the control plane:

```bash
helm uninstall oce --namespace openclaw-system
```

Helm does not own external PostgreSQL, operator-created Secrets, bootstrap PVCs,
or tenant workloads created by Compute. Retain database, bootstrap storage, and
tenant resources until recovery and retention requirements are satisfied.

For startup diagnosis, see the [production startup flow](../flows/production-startup.md).
For runtime proof, see the [production TUI flow](../flows/production-tui.md).

## Customization

Use `.env` and extra Compose files for development. Use Helm values, Kubernetes
manifests, Installation startup YAML, and Collector Secrets for production. Use
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

- [Service API keys, rotation, and bootstrap recovery](deploy/service-keys.md)
- [Credential renewal and revocation](deploy/credential-lifecycle.md)
- [Local Kubernetes, development TUI, and cleanup](deploy/local-operations.md)
- [Configuration and settings](../reference/settings.md)
