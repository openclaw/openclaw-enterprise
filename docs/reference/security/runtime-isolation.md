# Agent runtime security

This reference defines credential delivery, workload ownership, and isolation
limits for Kubernetes Agent runtimes. Apply these boundaries together with the
[infrastructure security controls](../security.md).

## Temporary runtime credential exceptions

Every Agent retains one Agent-specific transport Secret in its exact tenant
namespace, provisioned by the selected Compute Driver through the initial
credential API or by an operator. It contains a gateway admission token. Dedicated Codex additionally
receives a distinct `APP_SERVER_TOKEN`: its separate gateway connects only to
its exact Agent Service over same-Namespace `ws://`, and the real app-server
verifies the capability token's SHA-256 digest. Embedded OpenClaw has no
app-server transport.

The initial credential API requires exact Agent read and operate access, a ready
Namespace, and no historical revisions. It generates transport tokens and a local gateway password internally
and stores supplied model and Slack values in correctly owned Kubernetes Secrets.
Those values pass transiently through the authorized API; they are excluded from
Configuration, database records, audit fields, responses, and logs. Provisioning
creates missing whole Secrets only and rejects foreign, malformed, or conflicting
existing groups. It provides no credential readback, rotation, or deletion API.
A failed request can leave completed Secret creates in place; recovery reads
metadata and never deletes them as a rollback.

There are two supported model-credential paths:

- **Existing API key:** An Agent-specific model Secret supplies
  `OPENAI_API_KEY` only to dedicated Codex or the combined embedded OpenClaw
  gateway/Harness. When a native account references an existing source Secret,
  an independently authorized operator materializes that exact source into the
  Agent Secret. That existing path does not require direct controller Secret
  access; stale destination detection and production materializer ownership
  remain unimplemented.
- **Driver-issued access token:** After exact OCC and independent ChatGPT
  authorization, API-side Kubernetes Compute creates one account-owned Secret
  in the exact backing namespace. Its `token` and `workspace-id` keys are
  projected directly into each associated dedicated Codex workload as
  `CODEX_ACCESS_TOKEN` and `CODEX_CHATGPT_WORKSPACE_ID`. Kubernetes resolves
  the Secret references; no Agent-specific token copy is created. Codex logs
  in with `--with-access-token` under its forced ChatGPT workspace and stores
  login state only in its bounded ephemeral workload volume. Embedded access
  tokens are rejected before deployment.

A dedicated gateway never receives either model credential. Public OCC Agent
and AgentRevision responses can include the configured provider ID, which is
persisted on the mutable Agent row and immutable AgentRevision row. Credential
bytes and upstream ChatGPT account, credential, and workspace identifiers stay
out of public OCC resources, AgentRevision snapshots, ConfigMaps, responses,
and audit records; the concrete Driver private binding and runtime Secret keep
the upstream identifiers and credential material needed for runtime
authentication.

The API's dedicated controller identity receives only the tenant-local Secret
operations needed to create, verify, and delete account-owned Secrets. Its
operator-provisioned RoleBindings grant no cluster-wide Secret access, `list`,
or `watch`. Kubernetes RBAC cannot constrain dynamic Secret creation by
`resourceNames`, so compromise of that API identity can affect Secrets across
each granted tenant namespace. Worker and workload identities receive no
direct Secret API permissions. However, a compromised worker with existing
tenant Deployment write permissions can indirectly project and expose any
Secret in that namespace. Distinct identities and exact ownership checks bound
normal operation but do not eliminate the worker's namespace-level trust;
independently enforced workload admission is required for stronger isolation.

The upstream ChatGPT admin key is read only by the API-side `ChatGPTClient`
owned by its configured [Provider](../providers.md); it
never appears in startup YAML, persistence, public account data, workload Pods,
or the worker. Restrict provider TLS egress to the API Pod and an explicitly
approved provider/proxy CIDR. The worker receives no provider egress exception.
Managed account bindings carry exact Provider, Driver, and workspace identity.
Issuance/deletion, deployment, and worker reconciliation reject conflicting
ownership; the worker reads only binding metadata and confirms issuance, never
external IDs or secret values. Startup does not scan saved references. Removing
or retargeting configuration does not adopt or revoke existing credentials;
restore the original configuration for exact cleanup of old bindings.
The issued account credential requests only
`chatgpt.workspace.feature.allow-codex-local-access.access`, has a maximum
30-day configured lifetime, and is not refreshed automatically.

Direct model-credential possession, Agent TCP/443 egress, and capability-token
`ws://` remain explicit temporary exceptions: brokered model credentials, a
restricted model egress proxy, mutually authenticated TLS, and short-lived
workload-bound transport identity remain required follow-up work.

## Selected SandboxDriver boundary

An Installation may select an optional SandboxDriver with declared networking,
filesystem, or process containment facets. Current startup requires bundled
Kubernetes Compute for that selection. Compute retains the Namespace baseline,
Agent identity, gateway, and routing; a selected provider may own the dedicated
Harness workload. The Compute-owned Pod templates above do not independently
prove the containment of a provider-owned workload.

The bundled OpenShell provider supports dedicated Codex and delegates containment
outside the inner Codex sandbox. It requires upstream support for the workload's
Secret references and projected identity. Stock gateway incompatibilities fail
explicitly, and test-only bridges are not production support. Do not infer a
complete pre-execution policy barrier or command-level sandbox admission from
Driver selection alone. See the [SandboxDriver contract](../drivers/sandbox.md) and
[OpenShell compatibility limits](../drivers/openshell-sandbox.md).

## Agent runtime isolation

Production Agent dispatch supports embedded OpenClaw and dedicated Codex. Each
Agent has its own gateway, one selected active revision, and an exact-owner
Service. Guarded routing does not guarantee a physical process singleton during
Kubernetes node partitions or manual replacement; the
[Compute reference](../drivers/kubernetes-compute.md#execution-modes) records that
limitation. Embedded OpenClaw receives only its operator-owned API
key in its combined gateway/Harness. Dedicated Codex receives either its
operator-owned API key or its associated account's directly projected access
token only in its separate workload, and uses authenticated WebSocket
transport. A dedicated
replacement app-server can start idle before the current workload is retired.
Existing claim-fenced worker reconciliation allows temporary unavailability but
fails closed across Agent and Namespace boundaries. Brokered credentials,
workload-bound transport authentication, and restricted model egress remain
future work.

## Related

- [Kubernetes storage and credentials](../drivers/kubernetes-compute/storage-and-credentials.md)
- [Service accounts and credential ownership](../service-accounts.md)
