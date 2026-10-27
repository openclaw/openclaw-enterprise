---
rfc: ../../rfcs/0024-strands-box-sandbox.md
---

# Implementation plan: Strands Box sandbox integration

- **ID:** RFC-0024
- **Delivery status:** Draft publication authorized; OCE-owned code-mode entrypoint under qualification; no merge
- **Authority:** [Proposed decision](../../rfcs/0024-strands-box-sandbox.md)
- **Source baseline:** `7d472f3f7d3b5104deb7e18ae7a2627ce1da0f91`

## Outcome

Deploy a dedicated Codex Agent through normal OCE APIs with Strands Box as the
selected Sandbox Driver. Prove a real model tool call and revision lifecycle.
Credential Proxy remains outside this phase.

## Work and proof

### Publish drafts and remove the Codex source patch (2026-10-26)

- [x] Confirm the native Codex libraries expose interpreter initialization.
- [x] Prove an OCE entrypoint can execute a native code-mode cell inside the
      unchanged Box boundary, with no Codex library changes.
- [x] Replace the optional Codex source patch with an OCE-owned Cargo binary
      entrypoint and a reproducible staging build recipe.
- [ ] Publish draft Box, OCE and OpenClaw changes with their evidence limits.
      The owner deferred the Codex PR in favor of the OCE entrypoint.
- [ ] Build the packaged entrypoint and run the complete native QA and actual
      VM stop/start recovery on one new immutable runtime. Earlier image results
      remain historical evidence, not acceptance for this replacement.

The selected route keeps native Codex transport and runtime libraries. It owns
startup in the optional OCE image, so no Codex upstream change is required.
The host's optional OTEL listeners are not exposed by this entrypoint; the
qualified OCE caller does not use them. Unknown flags fail at startup.

### Previous acceptance

The [review and qualification record](review-and-qualification.md) preserves
necessity decisions, the mount trim, earlier native QA and VM recovery results.
Those results qualify their recorded immutable images only.

### Authorized completion scope

The owner confirmed API-key login is the acceptance boundary; Codex PAT is not
a prerequisite. Continue local implementation and qualification, with no push,
PR publication or merge and no containment-policy relaxation.

- [x] Build and package the patched native host with the release profile and
      record reproducible source, patch, binary and image identities.
- [x] Exercise real transport pressure, disconnect, framing limits and cleanup;
      repair only reproduced integration defects.
- [x] Compare unresolved model/tool behavior against the same native OCE/Codex
      version without Box before attributing it to this integration.
- [x] Run the complete corrected QA sequence, including the two-Agent final
      Pod/restart snapshot, on the final immutable runtime.
- [x] Prove bounded sustained local-memory operation and final-image recovery,
      plus a fresh tenant/Agent deployment through the supported installation.
- [x] Update the English acceptance report with final evidence and clean up
      disposable probes while retaining the review installation.

The following historical acceptance completed on the earlier image; it does not
qualify the tightened candidate. Publication remains pending explicit authorization. The previous checkpoint passed 49 pairing
regressions, 14 native Agent QA checks, and real VM stop/start with API endpoint
drift. That checkpoint does not cover every supported OCE workflow. Continue on
the same immutable runtime and retained installation; preserve earlier evidence.

### Release and protocol follow-up

The release candidate is now
`sha256:a9f6ce5e0772b806dea8e410ec050419575e9ca0805a9ad6089fcd9c6dbd6970`.
Box and the native code-mode host use optimized release builds. The source,
patch, binary and image hashes are recorded in the local build evidence.

Actual TCP/IPC tests reproduced two adapter defects: shared-pipe pressure could
truncate output, and one stalled client could fail the complete transport.
The adapter now pauses the source until drain and closes only the affected
downstream channel. Frame, buffer and connection limits are unchanged. The
44 Linux transport, provider and supervisor conformance checks pass without skips.

Native protocol qualification then exposed a separate Box defect. Shell aliases
sent stdin EOF immediately after submitting the command, discarding interactive
input. The local alias now forwards input and its real EOF, keeps the response
transport open until Exit, and exits without waiting for caller-held stdin.
The same Restricted Pod probe fails before this repair and passes all three
cases afterward. No policy or syscall grant changed. All 33 alias tests pass;
the stock namespace integration fixture skips in the build container, so it is
not counted as execution proof. Actual provider protocol and full QA continue.

The complete release QA now passes all 32 checks, with zero failures or skips,
on the same `a9f6ce5` image and `gpt-5.4`. It includes all six native transport
cases, two-Agent overlap with unchanged Pod/restart snapshots, native code mode,
real keyword/semantic model recall, and 48 distinct concurrent local-embedding
queries over 62.7 seconds. Gateway limits stayed at 3 GiB; the peak had reached
that limit before the sustained workload, whose OOM/restart and limit-hit counters
did not increase. This is bounded local proof, not capacity qualification.

Earlier failed attempts remain failed. Mini sometimes selected unrelated tools
or shell Node instead of the declared native code-mode path. A saved failed
thread still contains the memory tool definition. A bounded `gpt-5.4` comparison
then revealed model transcription of skill frontmatter (`--` instead of `---`).
The fixture now installs valid skill bytes through native `file_write` and checks
their size/hash through `file_fetch`; actual model skill read/execution and every
tool-error assertion remain mandatory. Recall uses the published
`exec -> tools.memory_search` invocation. No product permission was widened or
model failure reclassified as success. Two incomplete model-catalog migration
attempts were refused before any model call and are preserved separately.

The fixture is a fresh tenant/Agent/PVC pair provisioned through ordinary OCE
APIs on the retained Helm installation; it is not a fresh cluster installation.
The completed QA restores configuration, stops the Agent and verifies key
withdrawal. The same release image subsequently passed actual VM stop/start:
boot ID changed, revision/PVC/file/policy identities remained valid, old
conversations survived, and new model calls completed memory search, skill read
and execution plus semantic recall without post-boot index maintenance. No
pairing error or OOM occurred. The API endpoint stayed `.2`; prior exact-endpoint
drift proof remains separate. Only the local observer connections were restored.

A fresh same-version native OCE Harness, with no Box selector, passed real
memory search before and after stop/redeploy. This does not explain every
historical model/tool-selection failure; those failures remain preserved.
The original provider-history Agent was unsuitable as a native control and its
failed deployment remains a separate fixture record.

Release compilation exhausted the retained VM's disk and caused Pod eviction.
Exact obsolete images, build records and development-profile artifacts were
removed after ownership checks. Native trim returned about 12 GiB to macOS;
Kubernetes cleared DiskPressure and recovered without threshold changes.
This build incident is separate from runtime compatibility evidence.

Report and handoff are complete. The English Google Doc records the final
release proof and preserved failures; native structure and all eight exported
PDF pages were checked. Both retained Agents are stopped, their Pods/Deployments
are absent, and 38 live Secret fields contain no personal key. The failed
intermediate `842cddf` image was removed from both outer Docker and nested CRI;
the final image, baseline comparison resources and useful release caches remain.
The task inventory records exact identities and reassessment after local review.
No implementation PR was published or merged.

### Earlier workflow checkpoint, 2026-10-26 (superseded)

- [x] Bound the post-redeploy memory investigation: successful and failed turns
      had identical complete initial prompts and tools; native request construction
      retained memory tools. No Box dispatch failure was observed. Preserve the
      unexplained model selection failure; do not expand this task into unrelated
      OCE/model repairs or claim the old failure fixed.
- [x] Restore and qualify native code-mode execution inside the same Box process
      boundary, with W^X and all existing filesystem and network rules intact.
- [ ] Run the complete local acceptance sequence on one final immutable runtime
      image, without skipped checks or manual workload repair during the run.
- [x] Measure bounded local embedding concurrency at the native 3 GiB limit:
      three waves of four distinct native searches passed without OOM/restarts;
      observed peak was 2.50 GiB. Recovery is recorded separately below.
- [x] Exercise native OCC live workspace read/write and remote file transfer
      (Unicode, binary, empty files, overwrite and path refusals).
- [x] Create a second Agent through normal APIs with initial workspace files;
      verify independent PVCs, file and node authority, concurrent real turns,
      and complete deletion without disturbing the retained Agent.
      Successful overlapping command traces are preserved; the final-image
      concurrency run stopped at a test-only output-marker assertion before its
      final restart-count snapshot, so that complete check is not a pass.
- [x] Replace only the owned Harness Pod and verify automatic enrollment and
      functional recovery on the same revision; perform live revision cutover
      and verify old resources disappear without losing workspace contents.
- [x] Qualify semantic memory through documented native local provider configuration,
      including actual retrieval and persistence. Do not
      pass credentials through plaintext configuration or alter network policy.
- [x] Reconcile each supported local workflow with evidence in the user report.
      External-account scenarios need their own credentials and authorization;
      pause/resume has no ComputeDriver API and Credential Proxy remains deferred.

Extend the existing `strands-sandbox` QA scenario at its real API/Gateway
boundaries. New checks protect currently uncovered routing, storage identity,
initialization, concurrent Agent authority and revision retirement behavior.
Use short model turns only where actual model execution is the claim. Keep
cleanup registered before creating additional resources. No publication or merge.

## Code-mode qualification, 2026-10-26

Native Codex host source `a6274249d5877030676db098914db686bab7c921`
(`0.163.0-alpha.2`) has an existing interpreter mode, but the host did not expose
its selection. The local startup patch and Strands preload enable it without
changing the host protocol, Driver contracts or Box W^X enforcement. The same
rebuilt host traps in default mode and computes JavaScript successfully in
interpreter mode inside the unchanged Restricted Box Pod. Invalid configuration
fails before handshake. All 81 native host tests passed with no skips. See
[packaging and verification](../../../docs/guides/deploy/strands-code-mode.md).

The final runtime candidate is
`sha256:a4a6eb465507d6b7e62d8f2b39ca2acbecdacc43f16ca25986a84cb55598ada7`.
Its post-redeploy memory recall and real model code-mode execution passed.
Complete QA attempts remain failed: model tool-selection/argument errors and
overly restrictive test assertions are preserved, not reclassified as Box bugs.
Stop repeating the entire model suite; finish independent resource and recovery
qualification without expanding into unrelated OCE/model behavior.
No publication, merge, policy relaxation or automatic model-turn retry occurred.

The first resource generator launched four full CLI clients in the Gateway
cgroup and caused a real OOM at 3 GiB. Preserve its kernel evidence. A corrected
single observer process uses the existing native Gateway SDK for the same
three-by-four search load; all 12 queries passed at unchanged limits and runtime.
The semantic qualification also passed its keyword-negative control, 101-file /
117-chunk remote index with 768-dimensional vectors, actual model `memory_search`,
read-only maintenance denial and continued public-HTTPS denial. This is bounded
functional/resource proof, not production capacity certification.

The same final image passed a real VM stop/start: boot ID changed, active
revision/PVC identities/workspace bytes and all tenant policies remained equal.
The exact API endpoint stayed unchanged in this run; earlier endpoint-drift
proof remains separate. Historical conversations survived and new model calls
executed `memory_search`, `skills_read` and the skill's shell command, followed
by synonym-only semantic recall without post-boot index maintenance. Profile
hashes, Restricted admission and the rebuilt host hash matched before/after.
No pairing refusal or OOM occurred, but the recovery workload's cgroup peak
approached 3 GiB; capacity remains unqualified. Two initial observer connections
failed because the local forward incorrectly targeted the Pod-IP-bound API
instead of the existing operator client. Correcting that local forward did not
modify the installation or replay any model request.

Handoff: the original keyword configuration/index was restored, the Agent was
stopped, and its Pods/Deployments were absent. No personal key matched the 30
checked live Kubernetes Secret fields. Retain the owned VM, cluster, PVCs,
installed recovery service and source/build caches for review. The English
[acceptance report](https://docs.google.com/document/d/1ISl-nv_zmJN0v0bDwwZ7mhxct0oQXVerJE6CIqo2mn4)
separates final-image passes, earlier targeted probes, pending local code fixes
and unverified cases; original experiments remain linked in its archive.
Native readback and exported PDF layout were checked. Focused ESLint/Prettier,
workspace isolation and diff whitespace checks passed. Repository docs checks
remain blocked by the absent `@sindresorhus/slugify` dependency; no install was
performed as a verification side effect.

## Preserved delivery records

The following records retain their original checkpoint claims, including
superseded workarounds and failed runs. They are not a combined final pass.

- [Memory, pairing and local deployment](memory-and-pairing.md)
- [Container implementation and original prototype](container-implementation.md)
- [Expanded acceptance and stock Box investigation](expanded-qualification.md)

The first final-image run passed native code mode and post-redeploy memory,
then failed when the model sent a shell session ID to code-mode `wait`. One
conversation repeated its command. Preserve that failure; no product repair is
attributed to it. The concurrency fixture now calls `exec_command` followed by
`write_stdin` inside native code mode, explicitly exercising the supported
process-session protocol. A later run exposed an overly strict final-prose nonce
assertion despite successful tool effects. Remove that prose assertion, retain
actual tool receipts/API readback, and fail any tool error even if a later call
succeeds. Both prior artifacts remain failed; the runtime image is unchanged.
