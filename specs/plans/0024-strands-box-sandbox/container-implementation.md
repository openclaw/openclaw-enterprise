---
rfc: ../../rfcs/0024-strands-box-sandbox.md
---

# Container implementation and prototype records

[Current implementation plan](index.md). Historical checkpoint record follows.

### Current local qualification, 2026-10-23

The container candidate passed all 14 native QA checks under enforced Restricted
admission and default proc masks, after removing the historical Docker-subnet
API egress policy. New-file keyword memory indexing converged in 6,207 ms. Real
model calls retrieved the fact in fresh conversations before and after normal
redeploy, loaded the workspace skill and executed its random receipt command.
Final QA cleanup stopped the Agent, withdrew the model key, and found no copy in
the checked live Kubernetes Secret fields.

A real Lima restart then changed the VM boot ID while preserving the active
Agent revision, both PVC UIDs and every control-plane NetworkPolicy spec. The API
endpoint remained 172.18.0.2; this proves this reboot, not endpoint drift recovery.
No Agent redeploy or policy repair was performed. A fresh model conversation
called memory_search, skills_read and the shell after recovery; retained file
and prior conversation reads passed. The worker retried startup once and became
Ready automatically. Post-reboot normal Agent stop completed, all owned Agent
Pods and Deployments were removed, and 30 checked live Kubernetes Secret fields
contained no copy of the personal key. Retain the VM, PVCs and build cache for
local follow-up; three superseded probe images were removed from both Docker
and the nested containerd inventory.

One earlier final-image attempt failed before model inference: the Gateway
reported PAIRING_CHANGED during remote skill discovery. The same node's later
skills query recovered without intervention, and the next unchanged native QA
run passed. Preserve the failure separately; its root cause is unresolved and
startup reliability is not fully qualified. The QA now recognizes native
run-failed-before-reply records, retains the transcript and fails promptly.

This is local functional proof for Box baseline c4a2443 plus the container
patch, OCE adapter and explicit interface extensions. It is not stock Box,
production distribution or security certification. Pause/resume, semantic
memory, multi-Agent capacity, arbitrary external Unix services, separate tool/MCP
containment domains and Credential Proxy remain unqualified. Nothing was
committed, pushed, published as a PR or merged during this local repair phase.

### Upstream-compatible implementation, authorized 2026-10-23

The operator subsequently directed local implementation and testing only. Do not
publish or update a PR. Keep any interface proposal and candidate implementation
local. This instruction supersedes the earlier authorization to publish work.

Investigate a container-provided PID boundary in the same revision Pod. Keep
the trusted Box process outside the workload container's PID namespace. The
workload launcher must start as that namespace's sole PID 1, retain the runtime's
proc masks and create private user, mount, network, IPC and UTS namespaces. A new
Box-specific setup profile must enumerate exact namespace arguments; no blanket
unshare, privileged container, host namespace or PSA exemption is permitted.
Keep the existing Codex profile unchanged. Treat this as an unqualified candidate.

Before connecting ordinary Agent deployment, verify native Harness startup and
negative controls for supervisor visibility, proc root/fd links, inherited
descriptors, filesystem escape, direct network access and descendant cleanup.
Resolve hosted tool isolation explicitly; sharing an execution namespace across
different containment domains is not acceptable.

Local implementation now passes a two-container Restricted Pod test with the
full Box supervisor and native Codex initialization. Negative probes deny
supervisor files through direct paths and proc root links, extra mounts, direct
network access and an inherited descriptor. Killing the supervisor through the
container runtime stops the workload and a detached descendant. The workload
syscall policy and socket-alias source remain unchanged from the pinned Box
source. Additional tool and MCP declarations fail before launch.

Kubernetes Compute supplies `SandboxHarnessContext.transportToken` to provider
provisioning. The Driver creates an owned immutable Secret, mounts it only in
the supervisor, and probes authenticated native initialization. The deployment
template uses separate container PID namespaces and default proc masks. Focused
OCE checks passed 425 tests with two existing conditional skips; lint and types
passed. These results do not establish native OCE acceptance. The new images
were built, but a local VM filesystem failure interrupted deployment. Resume
only after storage checks and removal of the historical tenant PSA exemption.
Then run native split storage, files, skills, memory search and reboot recovery.

After offline filesystem repair, the same cluster and PVCs recovered. Restricted
admission now rejects Unmasked proc in the actual tenant. The first native QA
run reached the revision Pod but Tini failed on `rt_sigtimedwait`; it never
became Ready. Cleanup stopped the Agent and withdrew the personal key. The
local repair adds the explicit `supervisedCommand` handoff described in the
RFC. The original command remains available to providers that require Tini.
This avoids a workload syscall change; native acceptance remains pending.

The next local candidate keeps the default proc masks and removes the tenant
PSA exemption. It returns ENOSYS for refused sendfile/copy_file_range operations,
allowing the runtime's existing read/write fallbacks. It adds parameter-scoped
renameat2(RENAME_NOREPLACE), recvmsg(MSG_CMSG_CLOEXEC), and kill excluding PID 1
and broadcast -1. These are syscall policy changes, not an unchanged filter.
The mount view, network namespace and private PID namespace remain the reach
boundaries. recvmsg can import descriptors from a reachable peer; CLOEXEC is
not an ancillary-data filter. The trusted handoff socket is removed before
workload execution, inherited launch descriptors are closed, and the workload
cannot connect to the supervisor's private socket. Do not infer support for
arbitrary external Unix services from this test.

Real kernel coverage passed 130 namespace tests. A Restricted two-container Pod
passed native setup, atomic collision preservation, IPC receipts, child SIGTERM,
Codex initialize, and the filesystem/proc/network/private-socket negative probes.
Supervisor SIGKILL stopped a detached descendant. Native OCE deploy then passed
authenticated readiness and split storage, but its first real shell call timed
out: the default container RLIMIT_NOFILE is 1,073,741,816, and the stock alias
sweeps every possible descriptor. The next Box repair uses its already-permitted
close_range call with a proc descriptor snapshot fallback for ENOSYS; it never
reduces the descriptors that must close. Both paths close descriptors above a
lowered soft limit. All 33 alias unit tests passed. Full native acceptance and
reboot recovery are still pending for this candidate.

The current candidate passed all 14 native QA checks, including real model
memory_search, a new-file asynchronous index, skill execution and stop/redeploy
persistence. This run used a pre-existing local development policy allowing the
owned Docker subnet on TCP 6443; it is not the final policy qualification. The
exact policy UID was recorded and the policy removed. The production Helm
endpoint rule and scoped database/Pod selectors remain. Rebuilt runtime digest
883686c414daafbd2d80797ee4250518950bd6a638e8c60590d37ab186acea04
also includes the socket-alias style fix. Repeat native QA and VM reboot under
these unchanged, narrow policies. Do not reapply the legacy restart-egress helper.

The operator confirmed that upstream Box changes and small interface changes are
in scope. Keep the original data-plane revision Pod and remote Harness/split
storage architecture. Do not use the external-VM provider proposal, relax Pod
Security or workload isolation, or merge changes. Historical exception-based
passes remain comparison evidence only.

First compare the Box launcher with the existing supported Codex launcher.
Measure namespace creation and fresh procfs mounting under the unchanged OCE
profile, default proc masks, non-root UID, dropped capabilities and enforced
Restricted admission. A successful namespace call alone is not acceptance. Any
upstream fix must preserve process, filesystem and network boundaries, including
failure behavior, and then pass ordinary OCE deployment and the expanded cases.
Keep the pinned stock source as a control; do not treat an experimental patch or
an unavailable enforcement mechanism as a supported deployment.

The next probe used the unchanged Codex profile and default proc masks. One
`clone` call created private user, mount, IPC, PID and network namespaces. It did
not request UTS isolation, so this is not a substitute Box backend. In that child,
fresh procfs mounts failed with `EPERM` for default options, `subset=pid`, and
`hidepid=2,subset=pid`. The same mount flags are present in the installed profile.
This exposes another prerequisite after namespace creation.

A second control used the existing runtime image and real Codex initialization,
with no model or credential. Normal procfs passed. An empty, read-only `/proc`
allowed Node to start but Codex exited before initialization because
`/proc/self/exe` was absent. The error was `Codex executable path is not configured`.
Do not implement a proc-less fallback or claim a launcher-only fix from these
results. A compatible Box backend remains unresolved; the ordinary OCE E2E cases
remain blocked on that backend. These probes changed no installed security rule.

1. Submit RFC-0024 for human review before changing the Installation/Driver
   configuration contract. Keep the proposed decision separate from acceptance.
2. Package the fixed Box build and persistent adapters in a runtime compatible
   with the existing OCE runtime source and Codex version. Verify native ARM64
   loading; the preliminary Box binary was built against Debian 13, while the
   existing runtime uses Debian Bookworm. Do not assume ABI compatibility.
3. Preserve all `HarnessWorkloadRequirements` in the new Driver. Implement
   admission, exact Pod/PVC/Secret projection, private workspace initialization,
   provision, endpoint, authenticated status, peer labels, observation, logs,
   revision cleanup, and Namespace cleanup. Refuse unsupported attachments and
   auth modes explicitly. Verify Secret values never enter stored Box config.
4. Implement the proposed selector in Installation composition and update its
   configuration definition. Keep provider logic in the Driver and its runtime
   adapters. Update the current Driver reference, operator instructions, and
   source-backed flow documentation in the same change.
5. Install the control plane and PostgreSQL in the owned k3d environment, with
   exact controller/runtime identities and separate database roles. Verify
   NetworkPolicies and the candidate seccomp profile on the actual image.
6. Register real Agent scenarios in the QA matrix: create/deploy, native handshake,
   workspace-node enrollment, model tool call, allowed workspace write, denied
   outside access and network destination, reconnect, stop, redeploy, and
   persistence. Check failed authentication and unavailable/missing profile
   paths. Do not replace model execution with a fixture.
7. Run focused type, lint, formatting, package-boundary, and integration checks.
   Retain review evidence, exact versions, and a resumable resource inventory.
   Remove only test resources that no longer serve this task.

## Historical prototype evidence and gaps

The local Linux ARM64 prototype passed the normal Agent workflow through a real
Helm-installed control plane and PostgreSQL. The model used the operator's
personal OpenAI API key and `gpt-5.4-mini`. The successful checks were:

- Native Codex authentication and readiness; workspace node pairing.
- A real model shell call that wrote a random marker to `AGENTS.md`, followed by
  Gateway file readback of the same marker.
- A file-policy refusal for `/etc/shadow`. The unapproved external request failed;
  a separate request to the same Box egress proxy returned HTTP 403 with an
  explicit default-deny decision for `example.com:443`.
- A fresh Gateway connection, normal Agent stop, deletion of old Box resources,
  normal redeployment, and unchanged PVC identities with the marker retained.
- A second real model shell call in the same conversation after redeployment,
  which read the original marker. An unauthenticated Harness request returned 401.

This is conditional local proof. It does not show that unchanged Box main works
or that the default OCE security configuration supports this integration:

- The passing prototype used Box base `c4a2443791d5656c87025d861d733648416649ab`
  with Linux syscall and shell-alias descriptor cleanup patches. The latter
  uses the already permitted `close_range` call; the old sweep stalls when a
  container has a file-descriptor limit above one billion. The original OCE
  tini/Node startup command is retained.
- Restricted admission rejects `procMount: Unmasked`. The operator authorized a
  full PSA exemption for the exact isolated test Namespace. Positive and negative
  admission controls verified its scope. The seccomp profile is experimental.
- Node runs without JIT. Native code mode is disabled after its host exited with
  SIGTRAP; the cause of that crash is not fully established. The selected model
  uses native shell tools. Other models and architectures remain unqualified.
- Existing Compute configuration selects HTTPS Responses at the official API
  endpoint. The Driver projects Codex full access because Box owns isolation,
  following the existing OpenShell model; nested bubblewrap cannot run here.

Focused Linux checks passed: 507 tests with two explicit skips, ten supervisor
checks, 25 Box syscall checks, and 33 Box socket-alias checks. The two skips cover
root permission semantics and a separately selected native runtime image. OCE
TypeScript, lint, formatting, workspace boundaries, and the proxy-routing
regression passed. Strict Box Clippy still reports an unchanged warning in
`view.rs`; it is not a clean Clippy result.

The Agent is stopped. Its model Secret was replaced with a synthetic invalid
value. The task's Kubernetes Secret fields no longer contain the personal key,
and Agent Pods and Box-owned resources are gone. The VM, cluster, database,
workspace PVCs, dependencies, and build cache remain for review and continuation.
No further investigation of the other service-account key is in scope.

The final documentation check is blocked by the absent docs-site
`@sindresorhus/slugify` dependency. Dependencies were not installed as a side
effect of verification.

The local acceptance now runs through the ordinary QA matrix with the explicit
`strands-sandbox` selector. Ten checks passed with no failures or skips, including
unexpected Sandbox loss observation and recovery through normal redeployment.
The operator explicitly approved the listed local compatibility conditions.
The scenario withdraws the model key and stops the Agent in its cleanup path.
It is excluded from default and hosted advisory runs that lack the prepared
Linux ARM64 environment. See [local acceptance](../../../docs/testing/strands-box.md).

Before implementation review, complete the current Driver
reference, operator guide, source-backed flow, failure-path coverage, and image
qualification. The local prototype is not PR-ready; the submitted draft remains
an RFC. Credential Proxy is deferred. No merge, production rollout, or internal
runtime pin change is authorized.
