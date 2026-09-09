# Kubernetes security controls

OpenClaw Enterprise isolates tenant gateway and Agent workloads from the
controller API, worker, and database initialization Job. This page
describes controls implemented by the Kubernetes Compute Driver and canonical
production Helm chart, their temporary credential exceptions, and how to verify
them.

## Namespace admission and resource isolation

The Compute Driver creates or discovers one Kubernetes namespace per OCC
Namespace and requires all three Pod Security labels to be `restricted`:

```text
pod-security.kubernetes.io/enforce=restricted
pod-security.kubernetes.io/audit=restricted
pod-security.kubernetes.io/warn=restricted
```

Selecting an existing namespace with `POST /namespaces` and `existingNamespace`
requires Installation `administer` authorization in addition to ordinary
Namespace creation permission. The worker rechecks that authority immediately
before adoption; revoked access prevents side effects. Its selected Kubernetes
namespace must already be `Active`, carry
`openclaw.dev/namespace-lifecycle: external`, enforce all three restricted
security labels, and have the required tenant-local RoleBindings. The worker
rejects foreign tenant markers and NetworkPolicies before binding its exact
`openclaw.dev/namespace` Namespace-ID label and `openclaw.dev/namespace-id`
annotation together with a `resourceVersion`-guarded, non-forced patch;
concurrent ownership changes cannot overwrite another tenant's claim.
Additive foreign policies could otherwise defeat default-deny isolation. The
namespace and its existing manager remain operator-owned;
persisted uniqueness prevents simultaneous claims, and retained tenant markers
prevent reassignment until an operator deliberately clears both old markers.

Each tenant namespace also receives:

- A `ResourceQuota` containing the configured
  `resources.namespace.quota` values. Its effective limits depend on the
  resource keys the operator configures; a Pod-count quota does not implicitly
  impose an aggregate CPU or memory quota.
- A `LimitRange` containing the configured
  `resources.namespace.containerDefaults.requests` and
  `resources.namespace.containerDefaults.limits` for CPU and memory.
- Default-deny ingress and egress NetworkPolicies, an exact DNS exception,
  restricted ingress for explicitly approved gateway clients, and exact-owner
  gateway-to-Agent WebSocket transport. A gateway cannot connect to
  another Agent in the same Namespace.
- A temporary Agent-only TCP/443 internet-egress exception that excludes
  private network ranges and cloud metadata addresses. Replace it with an
  approved model egress proxy before treating destination isolation as complete.

These admission labels, quota, and limit policies apply to both driver-owned
and operator-owned tenant namespaces. The controller namespace is created and
governed separately by the operator; the production Helm chart does not create
it, label it for Pod Security Admission, or attach a namespace-level
`ResourceQuota` or `LimitRange`. Apply the desired equivalent controls to that
namespace independently.

Admission labels and NetworkPolicy objects are declarations, not proof of
enforcement. The cluster must enable Pod Security Admission and use a
networking implementation that enforces NetworkPolicies.

## Pod and container hardening

The Compute-owned tenant gateway and Agent, controller API, controller worker,
and initialization Pod templates apply the same restricted Pod and container
settings:

- `runAsNonRoot: true` with user and group `1000`.
- Pod `seccompProfile.type: RuntimeDefault`; only the dedicated Codex Agent
  container can use a configured Localhost seccomp profile.
- `allowPrivilegeEscalation: false`.
- `capabilities.drop: ["ALL"]`.
- `readOnlyRootFilesystem: true`.
- Explicit CPU and memory requests and limits for each container.

Tenant gateway and Agent bounds come from `resources.gateway` and
`resources.agent` in the selected Compute Driver configuration. Controller API,
worker and initialization containers use the chart's explicit `resources`
requests and limits, defaulting to `100m` CPU/`128Mi` memory requests and
`500m` CPU/`512Mi` memory limits.

The controller worker declares a bounded writable `emptyDir` for its readiness
marker. Installation startup YAML, Better Auth signing material, and other
mounted controller Secret data remain read-only. The initialization Job writes
the generated bootstrap password and service-key JSON only to its operator-provided
protected output volume. Neither output is mounted into the API, worker, or tenant
Pods. See [bootstrap credential handling](authentication.md#installation-and-account-ownership).
A configured ChatGPT admin key
is mounted read-only only in the API Pod; the worker, initialization Job, and
tenant Pods never receive it.

Real tenant gateway and Agent Pods declare an explicitly bounded `emptyDir`
mounted at `/home/node`; its size is limited to `1Gi`.
An independently bounded `64Mi` `emptyDir` provides the real runtime's required
`/tmp` directory.
The Agent's projected ServicePrincipal token remains mounted read-only. The Pod
root filesystem remains read-only; only declared runtime state is writable.

`runtime.codexSeccompProfile` is an optional Kubernetes Compute Driver setting
for a reviewed Codex compatibility allowlist. It renders only on the dedicated
Codex Agent container as `seccompProfile.type: Localhost` with a relative
`localhostProfile`; the Pod, gateway, embedded runtime, controller, and init
templates keep `RuntimeDefault`. The Driver rejects empty, absolute, traversing,
or unconfined profile paths and does not accept arbitrary security context
overrides. The operator must install the pinned profile on every eligible node
before workload startup; kubelet fails closed when the profile is absent.

The optional profile is for cases where `RuntimeDefault` blocks the
user-namespace `clone`, `unshare`, and `mount` calls used by Codex `0.152.1`
and bubblewrap. The profile is a syscall compatibility allowlist, not the
filesystem or network boundary. Codex and bubblewrap continue to own runtime
filesystem enforcement, and Kubernetes NetworkPolicies plus the configured
runtime proxy continue to own network enforcement.

The initialization Job uses a read-only root filesystem. Its migration
init-container and bootstrap container receive separate database credentials.

## Image approval and immutability

The production Helm chart accepts only the approved controller image through
`images.controller` and rejects a mutable tag at render time. Approved gateway
and Agent images belong to the trusted Installation startup YAML under
`drivers.compute.configuration.images`; each must use an immutable
`@sha256:` digest, and `requireImmutableDigest` must be `true`. The selected
Compute Driver rejects mutable runtime images and disabled digest enforcement
at production startup. The chart has no gateway or Agent image values and does
not independently compare runtime images with a separate approval list;
operators must review the startup Secret and image provenance.

The controller image build also requires an explicitly selected Node 24 base
image. Operators are responsible for choosing an approved, immutable base;
the Dockerfile checks the Node major version but does not independently verify
registry provenance or enforce a digest on its build argument.

Disposable k3d integration uses the nonroot `tests/fixtures/kubernetes` image
with the same Compute Driver-generated namespace labels, quota, LimitRange,
NetworkPolicies, Pod security context, container security context, and bounded
resources. Its local fixture image may intentionally use a mutable tag, and its
`node:24-bookworm` base is not digest-pinned. This exception applies only to
explicitly selected disposable k3d verification; it is not production image
approval or supply-chain attestation.

Fixture-based infrastructure tests prove only their documented Pod and network
model. A live Agent turn additionally requires real OpenClaw and Codex images,
tenant Secrets provisioned through the authorized initial credential API or
operator workflow, enforcing NetworkPolicy, and a model API
credential.

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
owned by its configured [Provider](providers.md); it
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
Driver selection alone. See the [SandboxDriver contract](drivers/sandbox.md) and
[OpenShell compatibility limits](drivers/openshell-sandbox.md).

## Operational log collection boundary

The [observability guide](../guides/observability.md) owns setup, metrics, and
verification procedures. This section defines the security guarantees and limits.

Operational logging does not replace PostgreSQL audit evidence. OCC emits
reviewed controller events for debugging and operations; audit remains the
durable record for bootstrap, mutation, authorization denial, and lifecycle
completion.

Gateway and Codex native OTLP log exporters stay disabled. Remote export is
owned by an operator-managed OpenTelemetry Collector that reads container output
and protected container or Pod metadata. Tenant Configuration, SecretBindings,
lifecycle hooks, and runtime payload fields cannot supply `RUST_LOG`,
`LOG_FORMAT`, `OTEL_*`, native `OPENCLAW_*` logging controls, exporter
credentials, or remote destination settings.

The Collector promotes only fixed operational event classes: reviewed OCC event
names, gateway subsystem records under `gateway`, and Codex app-server stderr
records under `codex_app_server`. It parses JSON records up to `32KiB`, maps
severity explicitly, sets the remote body to the event class, and drops
malformed, oversized, unclassified, stdout protocol, or content-bearing records.
Resource identity comes from protected Docker labels or Kubernetes Pod metadata;
request, work, Namespace, Agent, and revision IDs remain attributes.

Collector credentials and TLS material live only in Collector-owned deployment
configuration. In Helm, the bundled Collector uses dedicated config and exporter
Secrets, read-only `/var/log/pods`, a non-root UID with supplementary group
`0` for CRI file read access, and restricted Pod and container security
settings. Its dedicated egress policy permits DNS, the Kubernetes API for
metadata, and one approved exporter or proxy `/32`. The shared dependency
egress policy also selects Collector Pods and permits the configured database
destination; NetworkPolicy permissions are additive. Its file offsets and exporter queue use a
bounded `emptyDir`; they are best-effort across process or container restart and
are lost with Pod or node replacement. In Docker development, forwarding is
nonblocking with finite Engine and container-local buffers. Export outage or
overflow can lose operational logs but cannot block reconciliation, weaken IAM,
or change audit persistence.

## Verify controls

Run the actual production Helm chart and manifest-boundary integration tests:

```bash
OCC_HELM_BIN=/absolute/path/to/helm \
  node --test tests/integration/production-kubernetes-packaging.test.mjs
```

This test proves the rendered private Service, dedicated workload identities,
tenant-scoped RoleBinding boundaries, mounted Secrets, restrictive network
configuration, and rejection of unsafe image or policy inputs. It does not
prove live cluster admission or NetworkPolicy enforcement.

For disposable k3d setup, fixture-image import, Kubernetes environment
selection, and the real-cluster test invocation, use the
[canonical integration testing instructions](../../AGENTS.md#running-integration-tests).

The real-cluster tests inspect the restricted tenant labels, `ResourceQuota`,
`LimitRange`, NetworkPolicies, nonroot Pod settings, `RuntimeDefault` seccomp,
dropped capabilities, denied privilege escalation, read-only root filesystem,
and bounded container resources. Without the required disposable cluster and
fixture image, these tests skip explicitly; skipped tests are not evidence that
a production cluster enforces the declared controls.

Production Agent dispatch supports embedded OpenClaw and dedicated Codex. Each
Agent has its own gateway, one selected active revision, and an exact-owner
Service. Guarded routing does not guarantee a physical process singleton during
Kubernetes node partitions or manual replacement; the
[Compute reference](drivers/kubernetes-compute.md#execution-modes) records that
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

- [Production Kubernetes deployment](../guides/deploy.md)
- [Service accounts and credential ownership](service-accounts.md)
- [Kubernetes Compute Driver](drivers/kubernetes-compute.md)
- [Namespace configuration](configuration.md)
- [Identity and access management](authorization.md)
