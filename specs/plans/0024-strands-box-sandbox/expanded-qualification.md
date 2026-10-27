---
rfc: ../../rfcs/0024-strands-box-sandbox.md
---

# Expanded acceptance and stock Box records

[Current implementation plan](index.md). Historical checkpoint record follows.

## Expanded acceptance requested on 2026-10-23

The initial ten-check scenario is a sandbox integration smoke test, not complete
Agent or Compute lifecycle qualification. Extend the owned local environment:

1. Prove split storage from actual Gateway/Harness mounts and remote configuration.
2. Use a real workspace skill through discovery and a model tool call; verify the
   resulting artifact. Do not count advertised capabilities as successful use.
3. Write a synthetic memory fact and retrieve it through the normal memory-search
   path in a new conversation, before and after lifecycle transitions. Record the
   actual index/backend and distinguish search from direct file reads.
4. Exercise normal Agent stop/deploy, Harness-process or Pod restart, and recovery.
5. Exercise owned compute-host suspension/resumption when supported, shutdown/
   startup, and reboot. Capture host boot identity, data/PVC identity, readiness,
   and functional recovery. Do not call Agent redeployment a machine reboot.
6. Cover remaining scoped filesystem operations and a small concurrent workload
   check; distinguish configured resource limits from tested exhaustion behavior.
7. Withdraw credentials, stop the test Agent, retain the reusable environment, and
   update the user-facing report with per-case outcomes and unsupported operations.

Reuse the existing images, cluster, Agent and private credential path. Keep paid
model calls short and bounded; use credential-free checks where they establish
the claimed behavior. Credential Proxy remains excluded. No merge is authorized.

## Expanded results and open acceptance gaps

The expanded private acceptance exercised the same Helm installation, runtime
images and ordinary OCE APIs. Live mounts confirmed split storage: Gateway state
and Harness workspace use separate PVCs; the Gateway accesses workspace files,
skills and memory through the paired remote node.

- Passed: real skill discovery, `skills_read`, shell execution and a receipt,
  repeated after VM restart; text/binary/empty/Unicode file transfer, hashes,
  listing, overwrite protection and outside-path refusal in the allowed scope.
- Passed: Box Pod replacement, Agent stop/deploy, running revision cutover with
  old-resource cleanup, unchanged PVC identities and real post-transition tools.
- Passed: native Gateway memory search over remote files, with `provider=none`
  and `fts-only`. Model-callable memory tools remain unavailable; actual new-
  conversation recall failed. Explicit configuration did not resolve this.
  Root cause is unknown; semantic search is untested.
- Passed: two in-flight model conversations on one Agent without Pod restarts.
  Separately, two heavy CLI processes caused a 2 GiB Gateway OOM and recovery.
  This does not qualify multi-Agent scaling or resource-exhaustion behavior.
- Conditional: VM stop/start and restart changed boot IDs and recovered model
  tools, files, skills, history and keyword search. Local database Pod-address
  drift required exact-selector egress repair. A later k3d API endpoint change
  left health/GET checks passing while Secret PATCH and stop reconciliation
  failed. Refreshing the exact endpoint `/32` restored both writes. Unattended
  full control-plane recovery therefore remains unqualified.
- Not supported in this fixture: machine pause/resume. Lima has no matching
  command; guest RTC wake setup failed before suspension. ComputeDriver has no
  VM pause/resume API. Do not substitute Agent stop or Pod pause as proof.

The initial ten-case QA remains a smoke test. The expanded cases are not yet all
in the repository matrix. Corrected test-harness assertion errors and initial
VM data-plane-only passes are not full acceptance evidence. Personal credentials
were withdrawn through the ordinary Secret API after network repair; no Agent
Pods/Deployments remain, and 30 checked Kubernetes Secret fields contain no key.
Retain the environment for the unresolved cases and implementation review.

Contract audit: this is not adapter-only. The local diff adds optional
`SandboxDriver.harnessPeerLabels`, extends Kubernetes Compute provider routing
configuration and enforcement, changes Installation composition, and relocates
the shared native hook directory. Compute lifecycle signatures are unchanged.
The historical passing image used both Box patches and local exceptions.
The existing RFC covers the proposed route refinement; it is not release approval.

## Stock Box qualification

Keep the stock Linux filter and OCE security settings for this qualification.
The source archive's reconstructed Git tree matches the pinned commit's tree
`31ffaa51e83cdc7e5bbb6b3820174820d1b6fcd6`. Build offline from that immutable
source and run with a separate image and synthetic data. Keep previous
credentialed E2E results scoped to the earlier prototype.

- In a new enforcing Restricted namespace with `hostUsers: false`, stock Box
  could not launch `/usr/bin/true`. RuntimeDefault prevented creating a user
  namespace. OCE's existing Codex profile prevented creating the remaining
  namespaces. A server-side dry-run refused Unmasked proc. Both runtime probes
  exited before Harness code. The earlier prototype's 14 checks do not pass or
  fail an unstarted stock Harness.
- With stock Box on the Linux VM, the governed shell ran with a process-start
  hard and soft descriptor limit of 4096 and denied the unapproved command.
  A bounded launch requires descriptor hygiene at process creation. The Docker
  default in this fixture was 1,073,741,816. The cap solves the observed stall;
  its capacity and deployment as a cluster setting have not been qualified.
- Deny one syscall per case atop the existing isolated OCE container. Record a
  control plus ten variants for skill tree copy, real workspace baseline setup,
  a Node IPC round trip, and the supervisor's process-group termination
  sequence. Single denials of `sendfile`, `copy_file_range`, `renameat2`,
  `recvmsg`, and `kill` caused their corresponding operations to fail. Each
  of the other five single denials allowed all four to complete. The two
  scheduler queries produced warnings. This experiment establishes operation
  dependencies; it does not establish a minimal safe kernel allowlist.
- The stock Box can read the packaged skill directly. The existing Compute
  entrypoint still copies the skill tree. Disabling the native file helper
  would change concurrent-path safety guarantees. Further design must
  preserve atomic publication, workspace access and reliable child shutdown.

## Change record

- 2026-10-22: Drafted from the pinned source and local ARM64 probes during local qualification. RFC submitted as draft PR #3230; implementation remains unqualified.

- 2026-10-22: Submitted the Namespace provider-route refinement before changing
  the Sandbox/Kubernetes Compute contract. Ordinary Box egress rejects WebSocket
  upgrades; Node requires jitless execution. Native adapter probes passed, but
  regular Agent integration remains pending. Use a small number of short model
  calls after credential-free checks; do not run broad model matrices by default.

- 2026-10-22: Local sandbox E2E passed with explicit compatibility conditions,
  including model tools before and after redeployment. Personal model key retracted.

- 2026-10-22: Registered and passed the repeatable local sandbox QA scenario,
  including provider loss, recovery, two real model tools and final key withdrawal.

- 2026-10-23: Expanded live acceptance and source-diff audit. Recorded real memory
  tool failure, unsupported VM suspend, manual endpoint recovery and scoped key
  withdrawal. Complete E2E acceptance remains open. No implementation merge.

## Repair and requalification on 2026-10-23

The operator requested fixing the model memory tool and unattended VM recovery,
with emphasis on remote Harness and split storage. No merge is authorized.

1. Trace the pinned memory plugin factory and effective tool selection. Reproduce
   the missing tools without paid turns, repair their actual owner, and prove a
   fresh model conversation uses memory search over the remote workspace.
2. Use the existing supported environment selected by the operator. Source review
   found the original local launcher's `applyDevelopmentRestartEgress`: it admits
   control-plane API traffic to the owned k3d subnet and database traffic by Pod
   selector. Restore this omitted local-profile configuration in the retained
   fixture, adapting only the release and database namespace. State its broader
   control-plane destination scope explicitly; tenant sandbox policy is unchanged.
   Fixed local IP reservations were reverted. Do not hide post-restart policy
   repair in tests or treat the local profile as production EKS failover proof.
3. Reboot the actual VM without policy repair. Verify endpoint/rule identity,
   database and control-plane readiness, Secret update, Agent stop/deploy and
   real post-restart memory/skill behavior. Prove distinct Gateway/Harness PVCs.
4. Withdraw the personal model key, retain the reusable environment, update the
   existing Google Doc with causes, fixes and real results. Pause remains outside
   supported Lima operations unless new evidence establishes support.

The missing memory tools were caused by the Agent's explicit plugin allowlist:
`plugins.allow` included `codex` but omitted `memory-core`. Selecting the memory
slot starts the backend but does not authorize its tools. An ordinary Configuration
PATCH added the plugin and enabled its entry, followed by normal deployment.
Model `memory_search` and operator `memory_get` then returned the retained remote
fact. Fresh-write coverage additionally requires native asynchronous index
convergence; immediate recall and transient management-RPC polling failed and
remain recorded as failed attempts. Do not count cached results as a fresh write.

The production chart still requires operator-maintained exact endpoint `/32`
rules. Its EKS guide explicitly assigns endpoint changes to infrastructure
updates. The local restart policy does not close that production lifecycle gap,
and this work does not introduce a new CNI, controller or policy bypass.

Requalification passed all 14 QA checks with zero failures or skips. New memory
became visible through the native tool after 5,861 ms, and fresh model conversations
retrieved it before and after redeploy. The redeployed model loaded the workspace
skill and produced its receipt with a real shell tool; instruction text alone
was rejected by the assertion.

The actual VM restart and a separate verified-stop/start both passed. The second
boot changed the Kubernetes API endpoint from one dynamic Docker address to
another while all control-plane NetworkPolicy specs remained unchanged. Ordinary
Secret PATCH, retained conversation history, memory_search, skills_read and shell
execution passed on the same Agent revision and PVC UIDs. Only local observation
SSH/port-forward connections were re-established; no policy or service repair was
performed. The test Agent was stopped afterward and its model Secret withdrawn;
30 owned Kubernetes Secret fields contained no copy of the personal key. The
VM, cluster, PVCs and build cache are retained for review and follow-up. These
results do not qualify production admission, EKS endpoint drift, semantic memory,
multi-Agent capacity or credential proxy. No merge was performed.

### 2026-10-23 — Independent stock Box VM qualification

The unmodified Linux ARM64 Box ran the image's Codex app-server as a non-root
user on a second VM. The same remote file survived both a process relaunch and
a real VM stop/start. An outside-canary read failed. The existing Kubernetes
provider readiness predicate returned false while this app-server was live:
zero matching Pods, and both retained local-path RWO volumes select the original
cluster node. A separate native app-server also selected a stock-Box exec-server
through Codex's environment configuration. Direct executor file and command RPCs
passed. The app-server's host file RPC did not follow that executor.

An OCE asset-copy experiment preserved bytes and modes for all 78 image files.
Selecting the existing OpenClaw descriptor-copy path for the isolated SQLite
worker passed its snapshot checks. Real workspace initialization then failed
publishing AGENTS.md with RENAME_NOREPLACE. Node IPC, graceful child stop, private
revision identity, an authenticated Gateway round trip and provider storage
remain open. Host supervision can stop a whole cgroup; it did not demonstrate
graceful child drain. The nested tini also needs rt_sigtimedwait. This phase
used default Box enforcement, synthetic data and zero model calls.

### Qualification under the original RFC

The standalone VM was a kernel comparison. Acceptance uses a dedicated
revision Pod on the OCE data plane. Retain enforcing Restricted admission,
the prepared workspace mounts and workload identity. Reproduce the stock
launcher under both installed seccomp profiles. Only after that launcher can
start, qualify Gateway authentication, a fresh Harness RPC, split storage,
files, Skills, Memory and recovery through ordinary OCE deployment.

A native deploy in a fresh enforcing tenant produced zero Harness Pods. Its
ReplicaSet received a Restricted admission refusal for `procMount: Unmasked`.
With default proc masks, stock Box in a minimal Debian image received
`EPERM` at `unshare(CLONE_NEWUSER)` under RuntimeDefault. The ordinary OCE
Codex profile allowed NEWUSER and denied the following combined mount, UTS,
IPC and network namespace request. Node-side tracing of the exact test
container confirmed both calls and the effective OCI argument filters. A fresh
source build and the native revision image/adapter command reproduced the
same failures. The leaf never ran. The in-Pod storage and tool cases remain
pending a launch mechanism compatible with the existing policy.
