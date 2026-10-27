---
status: Proposed
implementation_status: Partially implemented
author: Kimiyu-186
---

# Proposal: Strands Box as a Sandbox Driver

- **ID:** RFC-0024
- **Created:** 2026-10-22

## Decision

Add an optional bundled Strands Box Sandbox Driver for dedicated Codex on
Kubernetes ARM64. Keep the existing data plane revision Pod, remote Harness,
Gateway and split storage. Compute owns the prepared Harness command,
identities, volumes, routing and revision lifecycle; the Sandbox Driver owns
containment and its authenticated Harness endpoint.

This proposal requires a Box container backend and OCE integration changes.
It does not claim that stock Box is compatible. Credential Proxy and Codex PAT
qualification are outside the initial API-key acceptance scope. Pause/resume is
unsupported and must fail explicitly. Stop/start and retained workspace recovery
are required. Production capacity and other architectures require separate proof.

## Problem

Box contains a process, but OCE also requires an authenticated Harness endpoint,
workspace-node enrollment, persistent storage and revision cleanup. Box's native
Linux launcher creates a procfs mount that cannot run under the revision Pod's
Restricted policy. Its private network namespace also prevents direct access to
the native Codex WebSocket listener.

The integration must preserve those boundaries. It cannot substitute an
external VM, use an unmasked proc mount, grant a privileged Pod, move execution
to Gateway, or replace the Harness command with a test-only Codex process.

## Containment and supervision

Use two containers in one revision Pod with separate PID namespaces: a trusted
Box supervisor and a contained workload receiver. The receiver must be the
workload container's sole PID 1. It preserves the container's masked proc view,
binds it recursively read-only, and creates Box's private user, mount, network,
IPC and UTS namespaces. Supervisor loss terminates the receiver and descendants.
The initial backend accepts one agent and rejects separate tool or MCP domains.

Keep `hostUsers: false`, non-root UID/GID 1000, dropped capabilities,
`allowPrivilegeEscalation: false`, read-only roots and default proc masks.
The supervisor uses RuntimeDefault. Node provisioning installs a reviewed
Localhost setup profile for the workload container. That profile adds exact
setup operations to the captured RuntimeDefault profile; Box then applies its
separate workload filter. OCE does not install profiles through privileged Pods.

Box's container backend needs argument-scoped `RENAME_NOREPLACE` and positive
child-process signalling inside the private PID namespace. Refused
`sendfile`/`copy_file_range` operations return `ENOSYS` for ordinary read/write
fallbacks. Workload `recvmsg`, `kill(0)` and executable-memory generation remain
refused. The trusted supervisor's descriptor handoff occurs before containment;
it does not grant the workload descriptor-receiving authority.

## Driver contract supplements

Extend the existing contracts with three optional handoffs:

- `HarnessWorkloadRequirements.supervisedCommand`: the prepared entrypoint without
  Compute's generic init wrapper. A provider may use it only if it supplies
  process supervision, orphan reaping, signal forwarding and descendant cleanup.
  Other providers use `command` unchanged. An absent alternative does not permit
  guessing or stripping a command prefix.
- `SandboxHarnessContext.transportToken`: the existing revision transport token
  for trusted provider readiness. The Driver projects it into a revision-owned
  Secret mounted only by the supervisor. Readiness requires successful
  authentication and a fresh native Codex `initialize` response.
- `SandboxDriver.harnessPeerLabels(context)`: the exact Harness ingress Pod labels
  for the prepared Namespace and revision. Compute validates Namespace, Agent,
  revision and workload-role ownership before granting Gateway egress. No labels
  means no grant. This is separate from workspace-node enrollment peer labels.

Lifecycle signatures and Compute's authority do not change. There is no
provider-name branch in OCC core.

## Installation and routing

Reserve packageless `drivers.sandbox.id: strands-box-sandbox` for this bundled
Driver. Other selections keep their behavior. Require:

- `kubernetes.seccompProfile`: a relative, node-local path to the reviewed setup
  profile; traversal is refused and a missing profile never falls back to Unconfined.
- `kubernetes.nodeSelector`: nodes qualified for ARM64, Pod user namespaces and
  the installed profile. A label alone is not qualification.
- `kubernetes.controlPlanePeer`: the exact Namespace and Pod selector for trusted
  controller readiness ingress.
- `policy.network.endpoints`: explicit host/port grants. The Driver derives the
  exact Agent Gateway destination from prepared enrollment inputs.

Extend Compute's `network.providerHarness` with `{ mode: "namespace", port }`.
Keep the existing fixed-address shape. Namespace mode accepts only a Service
name in the prepared Agent Namespace on the configured port and uses cluster
DNS. Cross-cluster execution is initially refused. During revision preparation,
retain the predecessor's exact ingress peer until activation retires it.

The Driver uses `requirements.image` and the explicit supervised command. It
projects every prepared environment Secret reference, file, ServiceAccount token,
PVC subpath and mount mode, or refuses unsupported inputs before creation.
Workspace setup uses Compute's existing private payload and completion marker.
Secret values do not enter Box's stored configuration, logs or revision metadata.
Credential Gateway attachments and editable/live network policy are rejected.

## Harness transport and runtime compatibility

The inner adapter starts the prepared Harness and connects to its native
WebSocket listener inside Box. The outer adapter authenticates the exact Agent
transport token and relays connection-identified bytes over an inherited pipe.
Independent clients retain native sessions and request IDs; reconnecting does
not restart the Harness. The adapter protocol contains no OCE operations or
arbitrary execution requests.

Bound frames, queues, connections and shutdown. Backpressure pauses the sender;
a slow or disconnected client closes its channel. Malformed shared framing or
loss of the shared pipe stops the revision. A reverse byte channel targets only
the approved Gateway destination because Box's HTTP proxy cannot carry that
WebSocket upgrade. TLS remains end-to-end on TLS routes.

The supervisor has access to projected model Secrets and is part of the trusted
computing base. The separate readiness Secret does not establish a general
credential-isolation boundary. `harnessStatus` requires native authenticated
initialization; `observeHarness` checks the actual revision Pod. Cleanup removes
only owned revision resources and retains the Agent workspace for redeploy.

OpenClaw's native node launcher uses a byte-only message channel to avoid
workload descriptor reception. OCE's code-mode entrypoint calls the existing
Codex interpreter initialization API and native host library. These adaptations
preserve node lifecycle and native code-mode execution without adding `recvmsg`
or permitting JIT. Codex libraries require no source patch.

## Acceptance

Use the normal OCE API, worker, database, Kubernetes Compute, Sandbox Driver,
Gateway and contained Harness. Require authenticated readiness, streaming
execution, cancellation and reconnect, file/network refusals, split storage,
file transfer, skills and native keyword/local semantic memory. Exercise stop,
redeploy, revision replacement, two-Agent isolation and owned-resource cleanup.
Then stop/start the local VM and prove automatic recovery with retained PVCs,
revision identity, file bytes and semantic index on the same immutable image.

Memory indexing remains owned by OpenClaw Memory Core on Gateway and reads the
canonical Harness workspace through its authenticated remote binding. Local
embeddings need no Gateway public egress. Pairing publication and local
Kubernetes API endpoint recovery are separate existing runtime/deployment
repairs, not Box containment features. The local host service may update only
exact API destination rules after validating the owned installation.

Mocks, a Ready Pod, or an earlier image's results do not establish this acceptance.
Keep failed attempts as local evidence; PRs report the tested image, current
results and remaining limits. No security relaxation or retry of failed model
tools may turn a failing case into a pass.
