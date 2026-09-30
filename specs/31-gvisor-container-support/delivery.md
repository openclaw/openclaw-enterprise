# gVisor delivery and qualification

[Overview](../31-gvisor-container-support.md)

See the [2026-09-24 amendment](../31-gvisor-container-support.md#current-disposition--2026-09-24-amendment)
for release scope and changes to the historical source and storage baseline.

Each increment ends in a useful ordinary-Agent outcome and its own evidence.
The following criteria are required results, not reported passes. Accepted
direction, source definitions and a running fixture do not complete the proposed
gVisor contribution or recovery journey.

The increments remain proposed 1.x discussion, with no commitment to ship in
1.x and no 0.x qualification gate. The requirements below apply when an increment
is selected for implementation; they are not evidence of current availability.

## Increments and qualification

Operators install the complete pinned
[runsc distribution](https://gvisor.dev/docs/user_guide/install/) with
[`platform=systrap`](https://gvisor.dev/docs/user_guide/platforms/) and STRICT
sidecar policy on eligible nodes. The selected profile requires Kubernetes
1.35 or later, approved immutable images, enforcing NetworkPolicies,
restricted Pod security, existing Codex authentication/seccomp and resource
limits. One operator-managed combination suffices for initial qualification.

1. **Runtime checkpoint.** An ordinary authorized Agent runs genuine dedicated
   Codex, model and tools with explicit profile selection, complete readiness
   and containment, compatibility with main and useful diagnostics. Qualify
   authentication, seccomp and cleanup. Existing supported storage suffices
   with its existing limits. Report source and installed evidence separately.
2. **Disposable contribution.** The Agent uses the existing repository
   credential service to clone, edit, test, commit, push and open an approved
   same-repository PR. Complete storage admission, create custody and disposal.
   Prove role-specific material, real tool-child PATH and generation-sensitive
   repair. This delivery requires exact SQL review and fresh/upgrade PostgreSQL
   checks. It is the genuine contribution portion of the initial MVP.
3. **Retained current state.** Qualified same-build, same-cluster replacement
   preserves files, local commits and completed context. Test gateway-only,
   Harness-only and combined replacement. Deny all successor writable phases
   without predecessor exclusion, then complete a resumed real turn under
   fresh authority.
4. **Continuing recovery.** Capture actual visible writes, verify and export
   the selected artifact, then restore into fresh stores with proven
   compatibility and preserved uncertain effects. Host-loss and changed-build
   claims need separate qualification.

The runtime checkpoint does not complete the proposed gVisor MVP for 1.x
discussion. All four increments remain proposed, not approved release scope. [Protected composition](architecture.md#protected-composition)
has its own gates and does not automatically precede every retained-state task.
Every deployment must satisfy its immutable profile. No weaker retained
combination is implied.

Keep a stable review branch and exact source/evidence checkpoint for each useful
milestone. Continue later work separately and backport applicable fixes with
focused validation. Preserve the first RFC commit as the logical implementation
stack base. A branch or checkpoint name does not imply release readiness.

## Acceptance evidence

Extend the existing Kubernetes Compute tests and the genuine ordinary-Agent
workflow. Consequential negative cases must cover:

- Invalid selections and missing, deleting, substituted or mismatched RuntimeClasses.
- Conflicting and terminating candidate Pods, incomplete observations and
  independent observation failures that must preserve positive violations.
- Noncooperative cleanup callbacks, stale-selector races and UID-guarded cleanup.
- Unknown or late creates, replacement objects and remaining storage references.
- Authentication, seccomp and observed-stop regressions.
- Supported optional-plugin failure disables only the failed selection, preserves
  successful policy and recomputes exclusions on restart.

A transport fixture proves the source behavior it exercises, not a running
sandbox. Requested RuntimeClass placement does not prove the executed binary.
Installed receipts must identify all of the following:

- Exact source and image digests.
- Kubernetes, containerd and runsc versions and configuration.
- Pod UID, node, container runtime interface (CRI) sandbox and the actual
  executable, hash, platform and flags.
- Effective security, eligible-node scheduling and the complete additive
  network-policy set, including demonstrated denials.
- Effective PID, storage, log, socket and resource limits, plus cleanup outcomes.

For enabled plugins, verify the [private status path](architecture.md#components-and-dependencies)
on the selected runtime/CNI combination: exact API-proxy sources, gateway-to-current-Agent
access and restart refresh work on TCP/18791, unrelated peers remain denied,
and blocked or untrusted required status cannot produce readiness. Reuse existing
plugin coverage within runtime qualification.

Use real dependencies for genuine Codex/model execution and live repository
contribution. The contribution receipt records the approved base, actual test
command and result, local and remote Git object IDs, PR head and base, and an
independent provider readback. A successful local command alone does not
establish the remote result.

Keep source, composed, installed, live-provider and release evidence separate.
Missing or unknown evidence stays explicit. Rich qualification artifacts require
restricted access. [History](https://github.com/openclaw/openclaw-enterprise/pull/250)
consumes only authorized, owner-produced safe identities, phases, reasons and
outcomes. Do not project raw errors, credentials, custody handles, environments,
commands, bodies or provider payloads into History. Qualification evidence
does not gain a new authority or lifetime through audit retention.

Implementation updates the owning living references for
[Kubernetes Compute](https://github.com/openclaw/openclaw-enterprise/blob/e9766f35a25afa240ee109b41a6ef821fb68687e/docs/reference/drivers/kubernetes-compute.md),
[Driver selection](https://github.com/openclaw/openclaw-enterprise/blob/e9766f35a25afa240ee109b41a6ef821fb68687e/docs/reference/drivers/selection.md),
[Harness flow](https://github.com/openclaw/openclaw-enterprise/blob/e9766f35a25afa240ee109b41a6ef821fb68687e/docs/flows/harness-execution-topology.md)
and deployment/testing guides. Those references state only implemented behavior
and its weaker assurance and compatibility limits. Historical RFC status does
not replace those current contracts.

## Decisions and follow-ups

The [interface decisions](interfaces.md#owner-decisions) keep the exact disposal
transition, protected bootstrap, supported native artifact and finite profile
transitions open with their existing owners. The earliest-untrusted-execution
containment strengthening remains proposed. None of those unresolved choices
turns required behavior into an optional improvement.

The following breadth remains separately triggered future work:

- Deployment operators qualify broader installation automation when a selected
  deployment requires it. Operator-managed installation suffices initially.
- Compute and Harness owners qualify embedded/decomposed OpenClaw or additional
  backends for a selected consumer, retaining existing lifecycle, authority and
  storage owners.
- Runtime, identity and operators qualify exact-container origin or independent
  termination during control-plane outages when stronger assurance is selected.
- Persistence and native owners qualify host-loss or changed-build recovery
  with compatibility and loss-window evidence.
- The credential owner supplies durable provider cleanup through protected
  custody, restart recovery and provider-observed outcomes.

These follow-ups do not replace the selected disposable contribution, retained
completed context or continuing recovery.
