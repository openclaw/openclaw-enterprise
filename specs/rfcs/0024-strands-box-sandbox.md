---
status: Proposed
implementation_status: Not implemented
author: Kimiyu-186
---

# Proposal: Strands Box as a Sandbox Driver

- **ID:** RFC-0024
- **Created:** 2026-10-22
- **Implementation plan:** [Sandbox integration](../plans/0024-strands-box-sandbox.md)

## Decision

Offer Strands Box as an optional bundled Sandbox Driver for dedicated Codex on
Kubernetes ARM64. Compute still prepares the Harness command and owns its
authenticated Gateway route. The Driver starts that command inside Box and
exposes a revision-specific endpoint through the
[SandboxDriver contract](../../docs/reference/drivers/sandbox.md).
Credential Proxy integration is a separate phase.

The deployment decision is whether OCE should support a separately reviewed
placement or admission policy for Box. The tested build requires a Pod setting
that OCE's Restricted tenant Namespaces reject. Without an approved placement
design or a Box build that works under Restricted, those Namespaces cannot run
this Driver. Selecting it must preserve the tenant policy and surface the
admission failure.

## Problem

Box can contain a local process, but OCE needs an authenticated Harness endpoint,
workspace-node enrollment, persistent workspace storage, and revision cleanup.
Running `codex app-server` directly in Box does not preserve the startup command
that Compute prepares. The native WebSocket listener also stays inside Box's
private network namespace.

The inspected baselines are OCE commit
`7d472f3f7d3b5104deb7e18ae7a2627ce1da0f91` and Box commit
`c4a2443791d5656c87025d861d733648416649ab`. This Box source supports Linux ARM64;
the v0.1.0 release does not supply a Linux binary. OCE's existing Codex version
is `0.163.0-alpha.2`. This proposal does not change that version.

## Installation and ownership

Reserve packageless `drivers.sandbox.id: strands-box-sandbox` for this bundled
implementation. Other existing selections keep their current behavior. Validate
its configuration before creating resources:

- `kubernetes.seccompProfile`: a node-local relative path to the reviewed Box
  profile. Reject traversal and a missing profile; never fall back to Unconfined.
- `kubernetes.nodeSelector`: nodes qualified for ARM64, Pod user namespaces,
  and the exact profile. An eligibility label alone is not qualification.
- `policy.network.endpoints`: explicit host and port grants that Box translates
  to both connection and HTTP authorization. The Driver separately derives the
  exact Agent Gateway route from Compute's prepared inputs.

Omit editable and live network-policy support in the first implementation.
The Driver declares only facets demonstrated by its actual policy and runtime.
It rejects any Credential Gateway attachment in this phase. It does not mint,
refresh, substitute, or inject provider credentials.

Compute continues to own admission, workload identity, Gateway routing,
transport authentication, baseline tenant isolation, and activation. The Driver
uses `requirements.image` and `requirements.command` unchanged, with a runtime
image that includes the fixed Box build and its transport adapters. It must not
substitute another image or bypass OCE's login and real-model startup checks.

The Driver projects every prepared environment Secret reference, file,
ServiceAccount token, PVC subpath, and mount mode to the exact revision Pod.
Unsupported inputs fail before workload creation. Workspace setup uses the
existing private setup payload and completion marker before Harness execution.
Secret values remain in Kubernetes Secret delivery and private runtime memory
or files; they must not enter Box's stored configuration, logs, or revisions.
The secret handoff into the contained startup process needs its own verified
implementation; the credential-free prototype does not prove this handoff.

## Runtime and transport

One revision owns one Box workload. A trusted adapter inside Box starts the
original Harness command, with its log streams separated from the adapter
protocol. The Harness keeps its native WebSocket listener and authentication.
An outer adapter exposes the provider-owned endpoint, checks the exact Agent
transport token, and relays independent connections over the inherited pipe to
the inner adapter. The inner adapter connects to the native listener inside
Box. Its messages contain connection identity and data, not OCE operations.

Rejected connections create no inner session. Reconnection does not restart the
Harness. Concurrent connections retain separate native sessions and request IDs.
Both adapters need message-size, queue, connection-count, and shutdown bounds;
the production limits remain to be selected and tested. The outer adapter is
trusted provider code, has no model credential, and must not execute commands
received from a client.

`harnessStatus` reports serving only after a native authenticated handshake.
It preserves OCE's held startup-failure response when the model probe fails.
`observeHarness` reads the revision Pod's actual state. Endpoint and peer labels
select that revision alone. Cleanup removes only owned revision resources,
waits for workload termination, and retains the Agent workspace for redeploy.
Namespace cleanup uses the same ownership checks across that Namespace.

The proposed Pod candidate uses `hostUsers: false`, UID/GID 1000,
`allowPrivilegeEscalation: false`, dropped capabilities, a read-only root, bounded
writable volumes, a Localhost seccomp profile, and `procMount: Unmasked` inside
the Pod user namespace. This last setting is a material node/admission requirement,
not permission to expose host namespaces or run a privileged Harness. Node
provisioning owns installation of the profile. OCE does not install it through
a privileged workload on shared clusters.

## Restricted admission compatibility gap

A real local OCE installation admitted a dedicated Codex revision through the
normal API and reached the new Driver. Its Deployment could not create a Pod:
OCE tenant Namespaces enforce the Kubernetes Restricted standard, which refuses
`procMount: Unmasked` even with `hostUsers: false`. Removing that setting admitted
the diagnostic Pod, but the fixed Box build then failed while mounting its fresh
`/proc` with `Operation not permitted`. These are separate observed failures.

Do not silently lower tenant admission or report this as default OCE compatibility.
A specifically authorized local admission exception can test conditional
functionality, but a supported deployment needs an explicit reviewed placement
or admission design, or a compatible Box implementation. The Kubernetes
[user namespace documentation](https://kubernetes.io/docs/concepts/workloads/pods/user-namespaces/)
also retains the default/empty ProcMount requirement under Restricted.

The credential-free startup lane additionally requires the complete three-binary
Box package, a canonical `/var/run` identity-token path in the adapter image,
directory grants for rotating Secret projections, exact executable grants, and
non-overlapping filesystem grants. These corrections are local work in progress;
a regular Agent model tool turn and lifecycle qualification have not passed.

## Kubernetes provider routing refinement

The current Kubernetes Compute configuration requires one fixed provider address
and writes a Gateway host alias for every provider endpoint. This cannot express
revision-owned Services inside the prepared Agent Namespace.

Extend `network.providerHarness` with an explicit `{ mode: "namespace", port }`
alternative; keep the existing fixed-address shape unchanged. Namespace routing
uses ordinary cluster DNS and admits only an endpoint Service name in the prepared
Namespace, on the configured port. Cross-cluster execution is initially refused.

Add optional `SandboxDriver.harnessPeerLabels(context)` with the same Namespace
and revision context as `workspaceNodePeerLabels`. It returns the exact revision's
Harness ingress Pod labels. Kubernetes Compute requires this method for Namespace
routing, verifies the Namespace/Agent/revision/workload ownership labels, and
uses them for Gateway egress. During preparation, retain the serving predecessor's
peer until cutover. No labels means no network grant. This is separate from the
workspace-node peer: a provider may use different ingress and enrollment relays.
The change belongs to the Sandbox contract and Kubernetes Compute, with no
provider-name branch in OCC core.

The Box Driver also requires an explicit control-plane Namespace and Pod selector
for authenticated readiness ingress. Its own NetworkPolicy grants that peer and
the exact Agent Gateway ingress, DNS, declared model destinations, and the fixed
Gateway destination derived from the owned enrollment Secret. Unsupported route
shapes fail closed; ordinary HTTP egress is not evidence of WebSocket support.

The loaded Box HTTP proxy rejects WebSocket upgrades. The adapter therefore has
a reverse byte channel to the one approved Gateway destination; the workload
cannot supply a different host or port. TLS remains end-to-end on TLS routes.
Box Linux seccomp also refuses Node V8 executable `mprotect`; the current adapter
uses `--jitless`. Full OpenClaw compatibility and performance remain qualification
requirements, not established support.

## Evidence and required verification

Local credential-free probes on Debian 13 ARM64 and k3s 1.35.9 showed:

| Probe                                                   | Observed result                                                                                              |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| RuntimeDefault                                          | Box refuses because user namespaces are blocked.                                                             |
| Existing OCE Codex profile                              | User namespace passes; Box's additional namespace operation is refused.                                      |
| Experimental exact syscall additions, ordinary Pod      | Fresh proc mount is refused.                                                                                 |
| Same profile, Pod user namespace and proc setting above | Box-contained Codex initializes.                                                                             |
| Native Codex `command/exec` inside Box                  | Workspace write succeeds; outside read and write fail; outside marker is unchanged.                          |
| Persistent transport prototype                          | Missing/wrong tokens return 401; reconnect and two concurrent sessions initialize through one Codex process. |

The profile extends the captured runtime baseline; it is an experimental
candidate, not a production-approved artifact. Network-policy enforcement,
model turns, the full OCE startup command, and Agent lifecycle are still unproved.
An upstream filesystem test also has a reproducible parent-rename EBUSY
expectation failure; the protected write remains refused. Qualification must
resolve or explicitly account for that upstream compatibility result.

Acceptance requires the normal OCE API, worker, database, Kubernetes Compute,
Sandbox Driver, Gateway, and contained Harness path. Prove an actual model tool
call, private workspace-node enrollment, denied network/file access, stop,
redeploy with workspace persistence, successor cutover, and owned-resource
cleanup. Extend the regular Agent QA workflow; mocks do not establish these
outcomes.

## Alternatives and decisions needed

Direct host access to Box's private WebSocket listener does not work. A fresh
stdio Codex per incoming connection loses the revision process lifecycle.
Codex Unix transport uses a protected daemon directory in private `/tmp`; the
simple shared-directory probe did not produce a host-reachable socket. The
pipe adapter retains native WebSocket session semantics without changing Codex.

An installed Driver package could avoid a new bundled selector, but would need
a real pinned production package and image distribution. Test-only factory
injection or a manually placed package is not Installation qualification.

Maintainers must decide whether OCE should ship the bundled selector and image,
and whether Kubernetes Compute should support revision-owned Service endpoints.
A supported deployment also needs an accepted placement design or a compatible
Box build, verified secret delivery, and the Agent lifecycle checks above.
