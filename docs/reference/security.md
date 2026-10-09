# Kubernetes security controls

OpenClaw Enterprise isolates tenant gateway and Agent workloads from the
controller API, worker, and database initialization Job. This page
describes namespace admission, Pod hardening, image approval, and log collection
controls implemented by the Kubernetes Compute Driver and canonical production
Helm chart.

[Agent runtime security](security/runtime-isolation.md) owns credential delivery,
temporary credential exceptions, SandboxDriver containment, and runtime isolation
limits. Review both references when configuring an Installation.

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
annotation (and, in single-cluster Compute, the `openclaw.dev/gateway-namespace`
label) together with a `resourceVersion`-guarded, non-forced patch;
concurrent ownership changes cannot overwrite another tenant's claim.
Additive foreign policies could otherwise defeat default-deny isolation. The
namespace and its existing manager remain operator-owned;
persisted uniqueness prevents simultaneous claims, and retained tenant markers
prevent reassignment until an operator deliberately clears all of the old
markers: the `openclaw.dev/namespace` label, the `openclaw.dev/namespace-id`
annotation and, in single-cluster Compute, the `openclaw.dev/gateway-namespace`
label. A selection that still finds any of them ends `failed`.

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
- While a replacement is prepared beside a serving revision of the same Agent,
  the Agent-scoped transport, model-egress, and plugin-status grants select
  every revision of that Agent; activation narrows them to the active revision.

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

Tenant Gateway and Agent Pods that set `fsGroup: 1000` for private state
(including the Harness workspace and node-state claims) also set
`fsGroupChangePolicy: OnRootMismatch`. The kubelet then changes volume ownership
only when the volume root does not already match, instead of walking every file
on each Pod start.

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
Follow [Codex sandbox setup](../guides/deploy/codex-sandbox.md) for baseline
capture, offline profile generation, node eligibility, and positive and negative
runtime verification. Profile generation and CI use the same reviewed rules;
host installation remains operator-owned.

The optional profile is for cases where `RuntimeDefault` blocks the
user-namespace `clone`, `unshare`, `mount`, and `pivot_root` calls used by Codex `0.163.0-alpha.1`
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

Disposable verification fixtures intentionally do not satisfy production image
approval. The approved production boundary is the digest-pinned controller,
gateway, and Agent image set above; local k3d fixtures and mutable local tags are
testing inputs only. See [image and Helm testing](../testing/images.md) and
[Kubernetes testing](../testing/kubernetes.md).

## Operational log collection boundary

The [observability guide](../guides/observability.md) owns setup, metrics, and
verification procedures. This section defines the security guarantees and limits.

Operational logging does not replace PostgreSQL audit evidence. OCC emits
reviewed controller events for debugging and operations; audit remains the
durable record for bootstrap, mutation, authorization denial, and lifecycle
completion. See [Audit log](../guides/topics/audit-log.md) for what is recorded
and current access limits.

For platform-owned runtime logging, Gateway and Codex native OTLP log exporters
stay disabled. A trusted Driver that declares
[deployment-managed logging](drivers/compute.md#runtime-logging-ownership) instead
retains its operator-managed pipeline; the guarantees below do not extend to
that pipeline. Its operator must verify destinations, redaction, credential
isolation, and access controls separately. OCC logging and audit are unchanged.

In the platform-owned path, remote export is
owned by an operator-managed OpenTelemetry Collector that reads container output
and protected container or Pod metadata. Tenant Configuration, SecretBindings,
lifecycle hooks, and runtime payload fields cannot supply `RUST_LOG`,
`LOG_FORMAT`, `OTEL_*`, native `OPENCLAW_*` logging controls, exporter
credentials, or remote destination settings.

The bundled Collector promotes only fixed operational event classes: reviewed OCC
event names, gateway subsystem records under `gateway`, Codex app-server
stderr records under `codex_app_server`, Codex warnings and errors (never the
`codex_otel` targets), the Codex `turn` span's start and end (`codex.turn`),
completed tool calls (`codex.tool_call`), and the runtime wrappers' fixed stderr
diagnostics (`runtime.startup_phase`, `runtime.workspace_node`,
`runtime.gateway_settings_overridden`, and `openclaw.model_probe` /
`codex.model_probe`) with only a bounded phase name or code. It parses JSON records up to `32KiB`,
maps severity explicitly, keeps allowlisted attributes, and replaces retained
bodies with the event class, stripping arbitrary content. Codex turn and tool-call
bodies are fixed text; a `codex.operational` body keeps Codex's own message only
for `codex_app_server` targets or the fixed `codex_core::responses_retry` retry
messages, and only when it is short plain text with no quotes, braces, query
strings, credential words or word over 24 characters. Other Codex errors, which
can interpolate chat text, keep the event name; other Codex warnings are dropped. It drops malformed,
oversized, unclassified, unspecified-severity, and Codex stdout protocol records.
Resource identity comes from protected Docker labels or Kubernetes Pod metadata;
request, work, Namespace, Agent, and revision IDs remain attributes.

A Gateway startup failure (OpenClaw's `Gateway failed to start:` error, which has
no subsystem) is promoted as `gateway.startup_failed`; its body keeps the message
only under the `codex.operational` plain-text rules. Those rules also reject
messages with an argv credential flag (`-u`, `--password`) or a `user:password`
pair.

Collector credentials and TLS material live only in Collector-owned deployment
configuration. In Helm, the bundled Collector uses dedicated config and exporter
Secrets, read-only `/var/log/pods`, a non-root UID with supplementary group
`0` for CRI file read access, and restricted Pod and container security
settings. Its dedicated egress policy permits DNS, the Kubernetes API for
metadata, and one approved exporter or proxy: a `/32` address or an in-cluster
namespace and Pod selector, on the exporter port. No chart policy grants the
Collector database access; the shared dependency egress policy selects only
the API, worker and initialization Pods. Its file offsets and exporter queue use a
bounded `emptyDir`; they are best-effort across process or container restart and
are lost with Pod or node replacement. In Docker development, forwarding is
nonblocking with finite Engine and container-local buffers. Export outage or
overflow can lose operational logs but cannot block reconciliation, weaken IAM,
or change audit persistence.

### Console and API runtime log reads

OCC also offers a second, non-exported read path: the
[Agent logs](../guides/topics/agent-logs.md) routes fetch one bounded page of
Kubernetes container output, Pod status and Pod Events on demand. It does not
change the Collector boundary above; nothing is stored, cached, logged or sent
to the Collector, and responses carry `Cache-Control: no-store`.

- **Access.** Pod status and Events need Agent `operate` and `read` plus
  revision `read`. Log text needs Agent `read_logs` or `administer` and Agent
  `read`, for any revision of that Agent. `administer` is the audience that already reaches Gateway
  logs through the native admin UI; `read_logs` delegates log text alone and is
  never granted by bootstrap. A `read_logs` Restriction also blocks
  `administer`. Every poll is authorized again; a denial is audited and reaches
  no Driver.
- **Audit.** OCC writes `openclaw.agents.runtime_logs.view` before the first log
  read of a view, and `openclaw.agents.runtime_logs.download` before every
  download, both with audit kind `access`. If that write fails the request returns `503` with no content.
  A download is the same sanitized page in a text serializer; it needs the
  same grants and is not stored on the server.
- **Content.** An allowlist classifier keeps only operational wrapper, Gateway,
  Codex tracing and short plain-text lines. Codex message text is kept only from
  reviewed operational targets (app server, login, CA setup, plugin manifests)
  and reviewed fixed-format messages (model endpoint connection, network proxy
  startup, retries) whose variable parts are a configured endpoint, a listener
  address, counts, durations or a connection error (error kind, OS error, HTTP
  status, proxy or TLS diagnostic). Other structured output, including
  Codex protocol traffic, payload keys such as `prompt` and `content`, and
  pretty-printed JSON spread over several lines, is withheld and counted. Retained text passes pattern redaction, which is
  best-effort. The `content` class has no producer.
- **Events.** Pod Event reasons and messages reach the `operate` audience after
  credential redaction. Node names, image references and Secret and ConfigMap
  names are masked in the standard scheduler and kubelet message shapes; the
  masking is best-effort, so other Event text can still name cluster objects.
- **Sandbox source.** OpenShell policy decisions and supervisor tracing use the
  same tiers and audit. OCC reads them through a client narrowed to the
  read-only `GetSandboxLogs` RPC (`sandbox:read`), so this path cannot create,
  delete or exec into a Sandbox. Records are classed `activity`; command lines
  and URLs are redacted and cut to 1 KiB.
- **Errors.** Driver and cluster error text never reaches a client; failures map
  to fixed codes.
- **Ordering.** The operator switch (`501`) runs before authorization, so a
  principal without grants learns only whether the feature is on. The
  per-principal rate limit and the replica's concurrent-read limit apply after
  authorization: every denial is refused and audited, and only authorized
  requests spend the caller's request budget.
- **Cluster access.** The tenant API, Gateway observer and execution tenant API
  roles gain read-only `pods/log get` and `events get,list` through
  `agentRuntimeLogs.enabled`. RBAC cannot separate Agents, so OCC reads only
  Pods carrying the exact Agent and revision labels and re-checks them on every
  read. Cursors are HMAC-signed with the auth secret and bound to one principal,
  Agent, revision and source.

## Related

- [Image and Helm testing](../testing/images.md)
- [Kubernetes testing](../testing/kubernetes.md)

- [Production Kubernetes deployment](../guides/deploy.md)
- [Service accounts and credential ownership](service-accounts.md)
- [Kubernetes Compute Driver](drivers/kubernetes-compute.md)
- [Namespace configuration](configuration.md)
- [Identity and access management](authorization.md)
