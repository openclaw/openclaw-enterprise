---
status: In progress
rfc: ../rfcs/20261121-agent-automations.md
---

# Implementation plan: OCC automation broker

- **ID:** RFC-20261121-agent-automations
- **Delivery status:** In progress
- **Owner:** Kevin Lin
- **Authority:** [Agent automations RFC](../rfcs/20261121-agent-automations.md), PR #6850
- **Source baseline:** `c9c925bac8a8865e568e239f814c4356e6ace183`

## Outcome and status

Implement the [submitted Driver contract](https://github.com/openclaw/openclaw-enterprise/pull/6850/commits/849eca56e1f68336fb394065db1495f02d96565f)
for embedded OpenClaw and ordinary dedicated Codex. Both must qualify Agent-shared
static MCP operations over operator-attested anonymous HTTPS. Keep the six OCC
operations, exact-Agent human `operate` for creation, creator/admin management,
CSRF, native normalization, deletion and history, revision checks and
`UNKNOWN_OUTCOME`. Clients cannot select tools. No eligible operations yields
an explicit empty cap. Managed MCP Sandbox, stdio and Codex apps are outside scope.

The implementation may qualify embedded OpenClaw MCP grants. Dedicated Codex
refuses nonempty grants with `AUTOMATIONS_UNQUALIFIED`, without silently falling
back to `[]`; qualified model-only scheduling remains available. This limit does
not complete the accepted both-Harness MCP scope.

**Qualification is incomplete.** The historical checkpoints below establish broker
behavior and empty-cap results on their named revisions. They do not qualify the
approved MCP path. Keep the implementation publication and merge hold until
both packaged Harnesses pass on the final candidate.

## Implementation and proof owners

1. **Compute and Harness.** Qualify the runtime through optional
   `openAgentAutomationTransport(revision, qualification | undefined)` in the
   [Compute contract](../../packages/contracts/src/drivers/compute/index.ts).
   Require current launcher, policy and trust evidence for create, edit and
   re-enable. Redeploy a missing guard. Withdrawal permits authorized disable,
   delete and history. Provision a revision-owned Service and private operator
   HTTPRoute through existing Envoy trust for every revision until retirement.
   Before and after handshake, require all ready EndpointSlice targets to name
   the sole live revision Gateway Pod UID. Refuse empty targets. On that socket,
   verify bounded `system.info` hostname against Pod name, retain hello
   `server.bootId`, and recheck UID, container ID and image before mutation.
   Pin the socket through read and write. On rollover, close without reconnect
   or replay. Before each Gateway spawn, supervisor respawn or container restart,
   the launcher checks plugin allowlist, origins, package digests and effective
   Node/tool switches. Reject tracked installs, mutable extension roots and
   unqualified overrides before loading plugins or starting scheduler catch-up.
2. **Kubernetes networking.** Validate each approved URL, exact /32 or /128
   destinations and optional public PEM CA. Grant only the URL port and approved
   IPs from the relevant workloads. Keep default-deny and TLS hostname verification.
   Project Gateway Node and dedicated Codex CA trust within the workload. Keep
   model credentials out of the dedicated Gateway.
3. **Gateway adapter and OCC.** Match bounded plugin, catalog and effective
   ordinary-session evidence to explicit literal provisioning, approval and
   Gateway policy. Disable Code Mode and discovery for nonempty caps. Persist the
   immutable cap and binding identity atomically in the PostgreSQL reservation.
   Deployment admission and the worker must verify all saved grants, including
   paused jobs and uncertain reservations, remain a subset of the successor's
   eligible bindings with unchanged identities before startup or catch-up.
   Never shrink a saved grant silently. Creator demotion leaves the standing
   grant intact. Retire the job or deny at the service to withdraw a running
   grant. A call already issued can finish.
4. **Verification.** Extend the real `agent-automations` QA scenario on both
   Harnesses. Compare an ordinary Agent call with a scheduled allowed call at
   the anonymous service. Verify denied sibling, server and action attempts,
   TLS/egress failures, and absence of native shell/file, delegation, discovery
   and app effects. Exercise changed origin/digest, pre-guard deployment,
   respawn, stale Pod identity and overdue catch-up. Race old and new Pods during
   cutover and verify the other instance receives no mutation. Extend the PostgreSQL
   ownership and worker suites for immutable bindings, concurrent replacement
   and pending successors. Retain existing native CAS, lost-reply and history
   regressions. Capture actual tool catalogs, runtime identities, provider
   receipts and refusal evidence without secrets. Fixtures alone cannot qualify
   the pilot.

The [automation flow](../../docs/flows/agent-automations.md) owns the runtime
sequence. The [API reference](../../docs/reference/agent-automations.md),
[Compute interface](../../docs/reference/drivers/compute.md) and
[Kubernetes Driver reference](../../docs/reference/drivers/kubernetes-compute.md)
own their respective contracts. Use the existing [Kubernetes QA](../../docs/testing/kubernetes.md)
and [PostgreSQL procedures](../../docs/testing/postgresql.md). Recheck the final
candidate before claiming release readiness.

## Verification

<a id="revised-rfc-acceptance-audit"></a>

At `e22a860f1c` the corrected HTTP and PostgreSQL admission regressions passed.
At `71f8ae5cb5` genuine model-only QA passed 17 cases without skips. The
native fixture also checked empty-cap add/update and rejection of unsupported
caps. Those checks did not establish complete no-tools enforcement,
OCC/database restart, or production fault injection. The canonical reviewer
returned `reviewer_unavailable` with `report_produced:false`; alternate
source/evidence reviews passed. The authorized model-key file was removed.
Use Node 24.22.1, pnpm 11.15.1 and Bun 1.4.4 for the new qualification.

## Delivery record

- `465a76013e`: six admission/refusal routes, native qualification gate, API/docs
  and a real HTTP refusal case. Surrounding integration suites passed 31 tests
  with no failures or skips; type, lint, formatting, generated API and docs passed.
- `c9c925bac8`: creation requires exact-Agent `operate` before resource lookup.
  The regression failed before the correction and passed after it; administrator
  management remained admitted. Required local checks passed.
- The former upstream qualification dependency is replaced by the broker design.
  Existing native APIs must still be qualified on the packaged runtime. The
  previous tests prove refusal paths, not functioning scheduling.
- On the working tree based on `fbf9ad567d`, the real Gateway protocol suite passed
  2 tests without a model call, PostgreSQL ownership passed 1 test, and serialization/preset
  checks passed 5 tests, all without skips. Migration upgrade, Provider continuation
  and rollback passed 150 tests, including the pre-automation predecessor. Pending
  SandboxPolicy custody upgrades passed another 11 tests without skips.
- Type checking, lint, formatting, generated OpenAPI, workspace boundaries, CI
  manifest audit, documentation links/length and flow validation passed.
- The Kubernetes QA run used local controller digest `d4f7adb91eaeaf86d8590d058a99ccbebd6bde0910d5013225390cae3bae4b59`
  and runtime digest `f2899d88e62a796f22eb27e0641384272c27ee689e89bb70d047fc5ef38bf31f`.
  These are working-tree builds, not published releases. k3s exited while creating
  its image-import watcher with `too many open files`. The run failed before Agent
  deployment; the owned cluster was removed. Host-wide limits were not changed.
- Canonical review previously stopped at isolation preflight: launcher bootstrap
  returned HTTP 403 without an isolated cached executable. Normal login-shell
  bootstrap also failed on read-only cache metadata. No reviewer or report ran.
- `b50e0e4704b58cd4ff6664909bc557c16af8396b` freezes the broker implementation.
  The next Kubernetes run used controller digest
  `5db7ced05dbb95109a4b085769bdf8ccc56e2e1ac93744d62f497f2f3fb0dcea`
  and runtime digest `72bbe64b51957f5cba8c3a631f67e1fc57d54f90b5e4df4a58d0e9d0e8a11b4a`.
  Temporary file-watcher capacity and a task-owned copy of Ubuntu's restrictive
  Bubblewrap profile resolved host startup and sandbox preparation. Helm startup,
  network checks and both plugin catalogs passed. Both Harness deployments then
  failed with `RUNTIME_AUTHENTICATION_FAILED`; scheduling cases did not run.
  Node reported 17 tests: 5 passed, 12 failed, 0 skipped. Failures include parent
  aggregation and blocked dependent cases, not 12 independent product defects.
- The extended existing Agent-deletion worker case passed: 1 test, no skips.
  It creates real broker reservations, exercises teardown retry and the database
  finalizer, and verifies removed target ownership and retained sibling ownership.
- Canonical review of `b50e0e4704` used GPT-6 Astra with no model/authentication
  fallback. Its complete 412,957-byte prompt fit one pass, and sandbox preflight
  passed. Authentication failed after launch; no report was produced.
- The disposable Kubernetes installation was removed after both Agent cleanups.
  The file-watcher limit was restored to 128 after checking current usage. The
  task-owned AppArmor profiles, reviewer installation and model-key copy were
  removed; the normal host profiles and Codex installation were preserved.
- `d56b6f1a5639e076eda51fa503b202b111b252d7` adds a model-free replacement and
  concurrency proof. A transparent proxy holds one OCC update after its native
  read while a second OCC update commits; native CAS rejects the first and retains
  the winner. The test then stops and removes the actual Gateway container, starts
  a new container on the retained native volume, changes the OCC revision and
  verifies the paused job, native configuration revision and creator/native-ID
  binding remain unchanged. Create/update counters exclude replay. Lost-create
  replies and post-commit audit/revision failures remain covered in the same case.
  OCC storage and Compute remain fixtures. This cannot establish durable OCC
  ownership across an OCC restart or the production Kubernetes cutover workflow.
  The production QA setup requires valid model authentication before those cases.
  The suite passed 2 tests with 0 failures, 0 skips and 0 model calls. Its owned
  containers, network and retained-state volume were removed. Type checking,
  lint, documentation checks and flow validation passed.

- `cec8f267eef4488dd566f09b1c060fab285ff40e` records the rejected-create fix
  before the execution gate. The original HTTP/transport path failed the real
  invalid-schedule regression by retaining an unbound row; the repaired path
  passed 2 native tests with no model calls. PostgreSQL cleanup, rollback and an
  actual binding/deletion lock race passed 1 test. Current gated HTTP cannot reach
  native create rejection; those results are explicitly pre-gate evidence.
- The final QA scenario checks installed execution refusal only. Its positive
  scheduling/tool-policy checks are not reported as passed or replaced by that
  refusal. The current model key remains invalid, so the installed case is unrun
  on the final gate. The final native fixture seeds real retained state as setup;
  it does not provide a production qualification override or native-edit feature.
- The narrow gate's genuine Gateway suite passed 2 tests with no failures, skips
  or model calls. Native cron remained enabled; fixture jobs used far-future
  schedules. Creation and unsafe edits dispatched no native mutation. Atomic pause,
  deletion, recovery, concurrent CAS, mutation uncertainty and retained-state
  replacement passed. The serialization/preset suite passed 5 tests; that invocation did not select the
  automation-admission file. Type checking, lint,
  formatting, OpenAPI, workspace, CI manifest, docs and flow checks passed.

- Independent app review found two defects at `91654c716b`. A real HTTP IAM
  revocation while an all-creator list was held reproduced foreign-job disclosure;
  final-scope filtering fixes it. Invalid public IDs reproduced PostgreSQL-backed
  HTTP 500 responses; route UUID validation now returns 400, with valid absent IDs
  remaining 404. Both regressions failed before their fixes and passed afterward.
  The native suite passed 2 tests; the PostgreSQL case passed 1. The correctly
  selected `Agent automation admission` HTTP case passed 1 test with no skips.
  Earlier references to 5 focused HTTP tests meant serialization/preset checks,
  not this automation-admission case.

- After model-only RFC submission at `5b1b6582ad`, the implementation's focused
  native suite passed 2 tests, PostgreSQL passed 1, and the actual admission case
  passed 1, without skips. The native fixture made zero model calls. These results
  establish protocol/persistence behavior, not the genuine no-tools runtime claim.

- At `e4b0d4c9ed`, both real Kubernetes Harness lifecycle scenarios passed with
  `gpt-6-luna`: all schedule forms, native normalization, enable/pause, stale CAS,
  human/service and Origin boundaries, one-shots before/after replacement, native
  deletion and retained history, recurring runs under restrictive and widened
  Agent policies, exact native identity retention, empty Gateway tool reports,
  no transcript tool calls and independent file absence. Codex native rollouts
  also recorded zero dynamic tools. Both Agent cleanups passed. The run exited
  nonzero only at a separate Codex assertion requiring all observation limits to
  be empty. That assertion imposed universal native configuration readback not
  required by AC3; replace it with explicit observation limits, preserving every
  runtime assertion. This reporting correction does not itself establish AC3.

- The registered supplemental test passed 2 tests with no failures or skips on
  the `71f8ae5cb5` runtime image, then was frozen at `e822a0fba6`. Embedded file
  write, Codex `exec_command`, and Code Mode `exec` each had a successful control,
  an empty scheduled provider tool list, a correlated native refusal and an
  independent negative file check. Codex used the actual CI-prepared k3d node;
  the earlier Docker control failed at bubblewrap and did not count as proof.
  This uses a synthetic provider, not genuine inference. Configured app/MCP,
  messaging and delegation controls remain gaps. No universal qualification or
  AgentRevision eligibility shortcut follows from these results.

- The final genuine QA run at `71f8ae5cb5` passed all 17 selected tests, with
  zero failures or skips. Both Harnesses passed the complete automation lifecycle
  scenario; artifacts explicitly mark full qualification as not assessed by that
  scenario. The protected model key, cluster and private QA directory were removed.
  Broader local AC3 controls continue without real credentials or external posts.

- The expanded supplemental suite passed 6 tests with zero failures or skips.
  Its tested working tree above `e822a0fba6` was frozen unchanged at
  `58af95933208d0fd858f0656aaf15d0b7d83350e`: an independent reviewer verified all
  nine archived source files, patch sections, checksums, results and image inputs.
  This was source and artifact validation, not an independent runtime rerun.
  Command: `node --test tests/integration/automation-model-only-dispatch.test.ts`,
  using the actual `prepareRuntimeImageSmoke` environment.
  Local Docker tag: `localhost/openclaw-ci-image-openclaw-ci-local-1c553965cbce/runtime-smoke:local`.
  Docker image ID: `sha256:ef6e896d0e68c9cde7d49b2c16d4b0eab38c30e18c4b51ba21944d55d6eebc01`.
  Both imported roles used `localhost/openclaw-ci-image-openclaw-ci-local-1c553965cbce/runtime-smoke@sha256:98f2a92879164f2ad7c011d74506bfeaee3763bdd5f15d734987b1cbd0ceaafb`.
  Tested patch SHA-256: `01b15f896821df94a1352080144a3f1b9a6f5f967a808d3527529b2ddc308e47`.
  Both Harnesses completed real Gateway child sessions and sent one positive
  message to a disposable local Slack collector. Scheduled empty-cap calls were
  refused; exact native database labels and sink counts proved no negative effect.
  This remains synthetic-provider proof. Native Codex collaboration is a separate
  pending control; managed MCP and account-backed apps are not covered.

- Manual routed native collaboration passed: ordinary OCC chat created a completed
  child; the human-session/CSRF automation returned a correlated unsupported-call
  refusal with no child. Compute rendered the relay. A public-CA-only trust image
  preserved native package/executable fingerprints. This synthetic-provider proof
  is manual, not unchanged-image or CI proof. The retained caller is
  `routed-native-control-stage.mjs::deployAndProbe` in `routed-native-setup.mjs`.
  The marker-count oracle was corrected to use native parent/child relations;
  fresh read-only verification passed without model replay. Original failed-oracle
  evidence remains. HTTP attribution is source-backed; live audit confirms
  service chat and human automation admission/binding/success.

  Recheck retained state assertions only (no model/runtime replay):

  ```sh
  node tests/fixtures/automation-model-only-native-collaboration-scenario.mjs \
    /path/to/routed-control-result.json /path/to/native-state-readback-final.json
  ```

- Managed MCP setup verified OpenShell 0.1.8 images, then the Agent Sandbox
  controller download failed with a registry-CDN connection reset. No exact
  cache/archive was available; the owned cluster was removed. Local discovery
  separately refused private DNS (400). No MCP call was qualified.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-11-22: Record dedicated MCP refusal without changing both-Harness acceptance (01a1fc52-9d88-7223-b8a1-3c98595d3fbe; uncommitted above 269ecf6b).

- 2026-11-22: Track the submitted anonymous HTTPS MCP and guarded-launcher requirements. Both packaged Harnesses still require qualification.

- 2026-11-21: User selects model-only automations with fixed empty tool cap and an explicit trusted-writer boundary; replace the earlier approved-tools/non-owner execution criteria.
- 2026-11-21: Fix the independent review findings with reproduced HTTP/IAM and PostgreSQL regressions; correct the earlier five-test suite attribution.
- 2026-11-21: Gate the confirmed operator-schedule authority gap; preserve atomic disable/delete/recovery and ordinary native cron. Mark positive AC1–AC3 and model history unmet, independent of credentials.
- 2026-11-21: Fix rejected-create reservation retention. The real HTTP/native regression fails before the fix and passes afterward; PostgreSQL proves atomic cleanup/audit rollback, creator isolation and a row-lock race that preserves a concurrent native binding.
- 2026-11-21: Add genuine Gateway replacement and concurrent native CAS proof without model calls; retain the PostgreSQL-backed production cutover and model-history gaps.
- 2026-11-21: Repair local infrastructure, record both Harness authentication failures and canonical review status, add deletion-worker ownership proof, and audit AC1–AC5 without claiming model qualification.
- 2026-11-21: Record broker protocol, persistence and upgrade results, and the blocked Kubernetes model proof. Keep policy and independent-review gaps explicit.
- 2026-11-21: Real native protocol verification found that cron.add rejects caller-selected IDs. Use OCC IDs, native declaration keys, disabled creation and a durable one-time native binding before activation.

- 2026-11-21: Revise delivery around the selected OCC broker and sole-manager assumption; retain prior verification limits.
- 2026-11-20 20:31: Correct creation admission to require operate before resource lookup. The real HTTP regression failed on commit `465a76013e` (administer-only POST returned 503 instead of 403) and passed after the correction. Administration still admits the other five operations to the qualification refusal.
- 2026-11-20 20:28: Record passing local admission checks and the blocked independent review; native acceptance remains unrun.
- 2026-11-20 20:23: Record admission work and upstream qualification blockers (source `d4a3ab0c9603ce9678995160776dd78d94a7a688`; authoring run `01a1fc52-9d88-7223-b8a1-3c98595d3fbe`).
