# Agent runtime security

This reference defines credential delivery, workload ownership, and isolation
limits for Kubernetes Agent runtimes. Apply these boundaries together with the
[infrastructure security controls](../security.md).

## Temporary runtime credential exceptions

Dedicated Agents retain separate canonical app-server transport and Gateway
password Secrets in their tenant control-plane namespace. Compute delivers the
app-server token, never the Gateway password, into a revision-owned Harness
Secret in the data plane. Kubernetes gateway authentication uses trusted proxy,
with an optional separately configured loopback password. Dedicated Codex and
its Gateway use the existing capability-token app-server protocol over
cross-namespace `ws://`; the server verifies the token's SHA-256 digest.
Namespace separation does not encrypt that connection or implement mutual TLS.
Embedded OpenClaw retains its combined data-plane workload and transport bundle;
it is outside the dedicated control-plane boundary.

The initial credential API requires exact Agent read and operate access, a ready
Namespace, and no historical revisions. It generates an app-server transport
token and a local gateway password internally in separately owned CP Secrets.
Channel credentials use the separately authorized OCC Secret API.
Those values pass transiently through the authorized API; they are excluded from
Configuration, database records, audit fields, responses, and logs. Provisioning
creates missing whole Secrets only and rejects foreign, malformed, or conflicting
existing groups. It provides no credential readback, rotation, or deletion API.
A failed request can leave completed Secret creates in place; recovery reads
metadata and never deletes them as a rollback.

There are two supported model-credential paths:

- **Existing API key:** Agent `harnessAuth` references a same-Namespace OCC
  Secret. Admission requires the actor and Agent principal's exact Secret
  `operate`; dispatch rechecks both. The Secret Driver owns storage, and
  Kubernetes supplies `OPENAI_API_KEY` only to dedicated Codex or the combined
  embedded OpenClaw gateway/Harness through a revision-owned runtime projection.

- **Driver-issued access token:** After exact OCC and independent ChatGPT
  authorization, API-side Kubernetes Compute creates one account-owned Secret
  in the tenant control-plane namespace. Its `token` and `workspace-id` keys are
  delivered into each selected revision's data-plane Secret and exposed as
  `CODEX_ACCESS_TOKEN` and `CODEX_CHATGPT_WORKSPACE_ID`. Kubernetes resolves
  these runtime Secret references. Codex logs
  in with `--with-access-token` under its forced ChatGPT workspace and stores
  login state only in its bounded ephemeral workload volume. Embedded access
  tokens are rejected before deployment.

A dedicated gateway never receives either model credential. Public OCC Agent
and AgentRevision responses can include the configured provider ID, which is
persisted on the mutable Agent row and immutable AgentRevision row. Credential
bytes stay out of OCC resources, AgentRevision snapshots, ConfigMaps, responses,
and audit records. Upstream account, credential, and workspace identifiers remain
private: the internal immutable auth snapshot retains verified Provider/workspace
ownership, while public responses expose only safe references. The runtime
Secret retains the credential material required for authentication.

The API's dedicated controller identity receives tenant control-plane Secret `get`,
`create`, `update`, `patch`, and `delete` permissions for credential provisioning
and account-credential lifecycle operations. It also receives Deployment `list`
to reject initial credential provisioning when an Agent runtime already exists.
Its operator-provisioned RoleBindings grant no cluster-wide Secret access or
Secret `list` or `watch` permissions.

The Helm worker role reads canonical CP Secrets and creates, updates and deletes
revision-owned runtime Secrets in the data plane. Enabling
[repository credentials](../repository-credentials.md) also permits Secret listing
for session material cleanup. Grants are namespace-scoped; Compute checks exact
owner and admitted source identities before normal operations.
Agent workload identities receive no direct Secret API permissions.
Kubernetes RBAC cannot constrain dynamic Secret creation by `resourceNames`, so
compromise of the API or worker identity can affect Secrets
across each granted tenant namespace. Even without direct Secret permissions,
a compromised worker with tenant Deployment write permissions can indirectly
project and expose any Secret in that namespace. Distinct identities and exact
ownership checks do not eliminate this namespace-level trust; independently
enforced workload admission is required for stronger isolation.

The upstream ChatGPT admin key is read only by the API-side `ChatGPTClient`
owned by its configured [Provider](../providers.md); it
never appears in startup YAML, persistence, public account data, workload Pods,
or the worker. Restrict provider TLS egress to the API Pod and an explicitly
approved provider/proxy CIDR. The worker receives no provider egress exception.
Managed account bindings carry exact Provider, Driver, and workspace identity.
Issuance/deletion, deployment, and worker reconciliation reject conflicting
ownership; the worker validates binding metadata and confirms issuance. Its Compute Driver
reads admitted credential bytes only to deliver selected runtime fields; it does
not receive upstream account administration credentials. Startup does not scan saved references. Removing
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
Driver selection alone. See the [Sandbox overview](../../guides/topics/sandbox.md),
[SandboxDriver contract](../drivers/sandbox.md), and
[OpenShell compatibility limits](../drivers/openshell-sandbox.md).

## Agent runtime isolation

Production Agent dispatch supports embedded OpenClaw and dedicated Codex. Each
Agent has its own gateway, one selected active revision, and an exact-owner
Service. Guarded routing does not guarantee a physical process singleton during
Kubernetes node partitions or manual replacement; the
[Compute reference](../drivers/kubernetes-compute.md#execution-modes) records that
limitation. Embedded OpenClaw receives only its operator-owned API
key in its combined gateway/Harness. Dedicated Codex receives either its
Secret-backed API key or its bound account's directly projected access
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
