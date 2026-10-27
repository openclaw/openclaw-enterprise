---
rfc: ../../rfcs/0024-strands-box-sandbox.md
---

# Memory, pairing and local deployment records

[Current implementation plan](index.md). Historical checkpoint record follows.

### Native local provider qualification, 2026-10-26

The optional image at `sha256:5ccdd945536683c88ef828fa9d2ba5e4a434018fa9da438778cc91462eee1640`
indexed 81 remote files into 95 chunks with 768-dimensional vectors. The native
llama.cpp provider reported ready. A synonym query had no FTS match, then found
the new remote memory file with `textScore: 0`; an actual model `memory_search`
returned that file. Gateway public HTTPS remained refused. The Gateway used its
native 3 GiB limit with no OOM.

A subsequent clean native deployment and actual VM stop/start passed. The boot
ID changed from `49a43ab5-5397-4a1c-900b-b6c1b28df518` to
`292cc159-e835-4c95-8d09-69d843aa8dcf`; this reboot retained the API address.
The Agent revision, PVC identities and all policies remained unchanged. Normal
Secret PATCH, saved history, real memory/skill/shell execution and synonym-only
semantic recall passed. No deployment, index maintenance or workload/policy
repair occurred after boot; only observation forwards were restored. Gateway
peak usage reached 2.89 GiB under its 3 GiB limit. No OOM or pairing refusal was
recorded, but this small remaining memory margin does not qualify capacity.

Preserve the preceding full-QA failure: one post-redeploy model turn called
`sessions_yield` instead of `memory_search` and claimed tools were unavailable.
The native Codex dynamic-tool definitions were identical before and after the
redeploy; the preceding recall succeeded. These facts do not prove why the
model selected the wrong tool. The independent semantic success does not erase
that failure. QA now preserves a completed wrong answer and fails immediately,
instead of waiting for its missing receipt until timeout.

A separate local fixture fault removed the idle unpublished runtime through
Kubelet image GC under disk pressure. Re-importing the same digest and applying
native CRI image pinning repaired it. The initial semantic diagnostic deployment
needed that repair; subsequent configuration deployments did not. Production
images require an available registry or managed air-gap distribution. Removed
the obsolete Ubuntu Box build target; retained the current Debian build cache,
source, installed images and stock comparisons. Tenant policies were unchanged.

The startup adapter disables `code_mode_host`; OpenClaw can override the startup
`code_mode` flag in its thread configuration. Earlier notes that both flags
remained disabled were too broad. Direct shell and dynamic tools have evidence;
code-mode execution is not qualified by those tests.

### Remote memory maintenance correction, 2026-10-26

The external OpenAI embedding diagnostic reached the configured provider but
timed out under the dedicated Gateway's existing default-deny egress. The
operator selected native local embeddings; external provider egress design is
deferred. Package OpenClaw's unmodified llama.cpp provider through its official
standalone plugin build, its pinned default embedding model, and a source-built
llama-server compatible with the runtime's Debian base. Use the native managed
localService configuration and an immutable local model path. No runtime model
download, embedding credential, new Service or network allowance is required.
The remote file owner, Gateway index owner, and current Driver contracts remain
unchanged. Verify actual vectors, synonym-only retrieval and reboot persistence.
This is optional runtime packaging, not a claim that OCE already ships these
assets by default.

The workflow extension passed file transfer, live native workspace edits,
Harness Pod replacement, live revision cutover, initial files, two-Agent
isolation/concurrent real turns, and normal second-Agent deletion. Semantic
qualification then failed: changing from keyword indexing to an embedding
provider requires explicit index maintenance. The documented standalone CLI
sees zero eligible remote files while the Gateway index contains fourteen.
Never rebuild from that local-only view or copy Harness storage into Gateway.

Add an explicit `operator.admin` Memory Core Gateway method, `memory.index`,
using the existing remote workspace binding and native index manager. Keep
index publication fenced by current caller and configuration authority. This
is a local OpenClaw runtime patch at the existing source pin, not a new
SandboxDriver or ComputeDriver contract. Qualify remote bytes versus a local
decoy, stale-authority refusal, live operator.read denial, real embeddings,
synonym-only retrieval, and actual host recovery without reindexing afterward.
Return the reusable fixture to its original keyword configuration through the
same supported maintenance operation. No database injection or request retry.

### Local deployment supplement, 2026-10-26

The operator approved a deployment-layer supplement after a true VM reboot
changed the Kubernetes API endpoint from 172.18.0.2 to 172.18.0.3. The unchanged
exact Helm rule caused normal Secret PATCH to fail with 503. Preserve this failed
acceptance. A separate workspace diagnostic passed real memory_search, skills_read
and shell execution on the same revision and PVCs; that does not qualify the
failed control-plane write.

Implement `occ dev reconcile-k3d-api-egress` in the existing local deployment
owner and install it as a Linux host service. It uses the local cluster operator's
existing Docker administration authority, verifies owned server addresses,
namespace UID, Helm release and the chart's control-plane selector, and replaces
only API destination `/32` entries. JSON Patch tests policy UID and resourceVersion.
It does not grant Docker access to OCC or workloads, copy credentials, change
tenant policies, reserve IPs, or add subnet exceptions. Missing/untrusted inputs
refuse writes and remain observable. This is compatible with current architecture
ownership, but is new deployment functionality, not a claim that RFC-0024 already
implemented automatic endpoint maintenance.

Focused guards and a real Kubernetes fixture cover preview, identity refusal,
actual endpoint replacement, unchanged non-API permissions and no-op writes.
The real fixture passed. The service repaired the observed stale exact rule and
a fresh normal Secret PATCH succeeded. Run native Agent QA and another real host
reboot with the service installed from boot. Permit only the documented API
destination delta; verify all other policy specs, Agent revision and PVC UIDs
remain unchanged.

The final native QA passed all 14 checks with no failures or skips. Fresh memory
indexing completed in 6,108 ms. The subsequent VM stop/start changed the API
endpoint from 172.18.0.3 to 172.18.0.2. At boot the service first refused the stale
mixed endpoint set; after Kubernetes removed the stale address it replaced the
single `/32` destination. Normal Secret PATCH succeeded on its first attempt.
The same Agent revision and PVC UIDs retained files, conversation history,
memory_search, skills_read and actual shell execution. All tenant rules and
all other control-plane rule fields remained identical. Only observation
SSH/port-forward connections were restored manually.

The final runtime reported no pairing refusal or OOM; its Gateway cgroup peak
was 2,465,878,016 bytes under the native 3 GiB limit. API and worker each restarted
once during boot and became Ready without intervention. Normal Agent stop and
key withdrawal completed; 30 inspected live Secret fields had zero personal-key
matches and no Agent Pods/Deployments remained. Retain the VM, PVCs, installed
infrastructure service and useful build state for follow-up. One QA invocation
before cleanup correctly refused the still-running fixture; it made no model
call and remains recorded separately.

The supplemental implementation and installation instructions belong to
[local API recovery](../../../docs/guides/deploy/local-api-egress-recovery.md).

### Pairing failure investigation, 2026-10-26

The acceptance goal remains the complete local OCE workflow through the current
revision-Pod, remote Harness and split-storage architecture. Fix incompatibilities
in their owning layer; do not replace that architecture, relax isolation, retry a
failed business request, publish a PR or merge.

The pinned OpenClaw runtime can temporarily refuse every node's published
pairing binding while an unrelated device write is pending. The upstream change
`e158fc392cc9ee13a8b71dbf7642ef6739283230` addresses this race after the
selected source pin. First reproduce the public Gateway failure against the exact
pinned source without Box. Adapt a minimal source repair through the existing
runtime patch build path, preserving operator credential receipts and committed
revocation checks. Prove ordinary concurrent requests succeed and actual token
revocation, rotation, unpairing and reapproval still reject stale dispatch.

After the focused regression passes, build an immutable local runtime and run
the native deployment, split-storage, file, skill, memory and reboot acceptance
again. Preserve before/after evidence and distinguish a reproduced causal path
from the unavailable detailed trace of the historical incident. Withdraw the
personal model key and retain the useful environment for follow-up.

The real Gateway regression reproduced `UNAVAILABLE / PAIRING_CHANGED` on the
fixed source pin with no Box or adapter. The repair removes the global in-flight
write fence, preserves prospective operator receipts and foreign-revision
invalidation, and adds no retry. The corrected final fixture fails its concurrent
success case before repair while all four actual authority-change cases pass.
With the repair, all 49 selected Gateway/SQLite tests pass, including the existing
required-worker caller-authority tests. Formatting and type-aware lint/type checks
pass for all four affected upstream files.

One intermediate image build caught an imprecise test interleaving: the initial
port broadened the dispatch-path match and could hold a background lookup after
delivery. Restore the upstream `node-registry-private` match and assert no frame
was sent before changing approval. Preserve that failed run separately. The
corrected fixture passed the full image-build gate without a production change.

The first packaged-runtime QA passed 13 checks but failed its post-redeploy
memory conversation when a history CLI exited 137. The kernel recorded a MEMCG
OOM kill of that exact Gateway Pod, not a pairing refusal. The retained test
Installation still capped Gateway memory at `2Gi`; current `occdev` and profile
defaults use `3Gi` and document this workload's 1.8-2.2 GiB peaks. Restore the
native `3Gi` limit through Installation startup configuration, preserving the
`1792Mi` request and all security policy. Record Pod resources, image identity
and security context in native QA evidence. Revalidate with a new evidence
directory, preserving the OOM run; VM recovery remains pending.

### Minimality review, 2026-10-26

The operator requested a local incompatibility inventory and minimal Box fixes.
Keep the fixed upstream baseline, retained cluster and original revision-Pod
architecture. No publication or merge is authorized.

The prior candidate applied three argument-scoped compatibility rules to every
Linux namespace workload. Limit RENAME_NOREPLACE, MSG_CMSG_CLOEXEC and child
signalling to the explicit container backend. Ordinary namespace workloads retain
their original refusals. The ENOSYS copy fallback still refuses the optimized
syscalls. The alias descriptor fix is unchanged.

The ordinary-mode regression failed on the previous candidate. After repair,
131 real-kernel namespace tests passed with no failures or ignored tests. The
new image passed Restricted Pod boundary probes, native initialization, atomic
publication, IPC, child termination and supervisor-loss descendant cleanup.
The stock control still fails under RuntimeDefault and the ordinary Codex profile.
All 14 native QA checks passed on runtime digest
`d9c1c901c2c26a6b7650ce71209ae591b06f4ce728591866e05c9e8ea0ac86a8`.
Fresh keyword indexing converged in 6,319 ms. A real VM restart then preserved
the active revision, both PVC identities and every control-plane NetworkPolicy
spec. Retained files, history, memory search, skill reads and real shell execution
passed without repair. The API endpoint did not change; this is not drift proof.
The existing Codex profile and Box setup profile hashes remained unchanged.
The personal key was withdrawn through the normal API after Agent stop.
Keep the earlier PAIRING_CHANGED incident open; a successful rerun does not
identify its root cause. Preserve the earlier dated evidence below.
