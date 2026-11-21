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

## Outcome and scope

Implement six real HTTP operations through OCC and the existing native scheduler.
OCE is the sole automation manager. Native edits, imports and reconciliation with
other managers are out of scope. OCC records the human creator and enforces
management permissions; execution uses the deployed Agent's service authority
and approved tools. Retained ownership authorizes native history after deletion.

No upstream writes, dependency patches or new upstream scope are required.
The implementation provides broker dispatch, durable ownership and native ID
binding. Protocol and PostgreSQL checks pass. Model execution, policy enforcement,
deployed replacement and independent review remain incomplete.

## Owners and touchpoints

| Owner | Implementation |
| --- | --- |
| HTTP contract | `packages/contracts/src/api/agent-automations.ts`, `api/routes.ts` and generated OpenAPI |
| Agent ownership and policy | `packages/occ/src/agent-automations.ts`, controller composition and facade |
| Durable state | New automation ownership repository, in-memory adapter, PostgreSQL adapter, schema and migration |
| Native protocol | `apps/controller/src/gateway/agent-automations-client.ts`, composed with the existing Compute endpoint and private Gateway credential |
| HTTP lifecycle | `apps/controller/src/http/agent-automations.ts`, existing session, CSRF, audit and error handling |
| Integration | Real HTTP admission case, PostgreSQL ownership tests and the regular Agent QA workflow |

## Ordered implementation

1. Submit the revised RFC before changing the reserved Compute delegation mode.
   Keep the current RFC PR's author and branch. Implementation can continue while
   the proposal is reviewed unless a specific hold is recorded.
2. Add immutable ownership reservations keyed by OCC UUID. Bind each row to
   the exact Namespace, Agent, human Principal and selected native Agent. Use
   database constraints for identity and parent ownership, and cascade Agent
   deletion. The in-memory adapter mirrors those invariants.
3. Integrate ownership operations through controller composition. Creation checks
   exact-Agent `operate` before lookup; management accepts creator `operate` or
   Agent `administer`. Unregistered and foreign-creator IDs remain undisclosed.
4. Compose a private native client for the selected revision. Verify endpoint,
   operator scope, method support and server-selected native Agent. Keep the RPC
   surface fixed to the six supported methods; no caller-selected method, identity,
   target, policy or credential reaches this client.
5. Reserve ownership before native create. Use a unique declaration key and create
   disabled, bind the server-generated native ID durably, then activate if requested.
   Resolve a lost create reply by read-only native inventory and one-time OCC binding,
   without replay or automatic activation. Round-trip native normalization.
   For PATCH, authorize ownership, read the full job, validate its shape and same-read
   revision, then send that revision to the atomic native update. DELETE also
   uses the observed native revision. Filter inventory by OCC ownership before
   public paging and totals, rejecting a changed native snapshot.
6. Read history by the retained ownership record and exact Agent Gateway, even
   after native one-shot or explicit deletion. Preserve native history retention.
   Never infer creator identity from public native job or run payloads.
7. Recheck selected revision and authority around dispatch. Record successful,
   denied and indeterminate outcomes without prompt or native payload content.
   After a mutation might have reached native execution, a lost reply, changed
   revision, malformed acknowledgement or failed success audit is
   `UNKNOWN_OUTCOME`; return the OCC automation path in `Location` when known.
   There is no automatic replay.
8. Update the existing flow, reference, guide links, OpenAPI, permission and
   database-entity cheat sheets. The environment-variable inventory is unchanged
   unless implementation demonstrates a supported configuration need.
9. Run real PostgreSQL and Agent workflow proof, required local checks and
   independent review. Publish no implementation PR until the requested outcome
   is ready and verification limits are explicit.

## Verification

| Required outcome | Proof | Current result |
| --- | --- | --- |
| Human and exact-Agent admission | Real HTTP app, sessions and Native IAM | HTTP checks pass; native protocol case verifies creator filtering and successful dispatch |
| Ownership constraints and cleanup | Disposable migrated PostgreSQL, application role, actual repository operations | Reservation, one-time binding, uniqueness, immutable creator and audit rollback pass. Real deletion worker removes ownership after a teardown retry and preserves sibling ownership |
| Normalization and lifecycle | OCC HTTP calls to a real packaged Gateway in the regular Agent workflow | Real Gateway protocol case passes all three schedule forms, CRUD and stale revisions; installed workflow reaches Agent deployment but model authentication fails |
| Approved and denied tools | Scheduled real model turn in each selected Harness; include current policy reduction and app/MCP boundaries | Embedded OpenClaw and dedicated Codex both fail model authentication. No scheduled model turn ran. Policy-reduction and app/MCP cases still need implementation and real proof |
| History after deletion | Successful one-shot and explicit deletion, then creator/admin and foreign-creator history requests | Never-run deleted job correctly returns 404 in native proof; completed-run history remains unverified |
| Unknown outcomes | Lost mutation reply, post-dispatch revision change and failed audit append; count native dispatches | Real Gateway fault cases pass without create replay; lost create reply leaves a disabled recoverable job |
| Revision replacement | Owned disposable Gateway workload and persistent state across replacement | Genuine Gateway container replacement on retained native storage preserves a paused job and unchanged in-memory OCC ownership, without create/update replay. Production Kubernetes cutover with PostgreSQL-backed OCC remains unverified |
| Independent review | Canonical autoreview, without provider or isolation bypass | CLI and sandbox preflight repaired; review of `b50e0e4704` returns `reviewer_unavailable`, `report_produced=false`, authentication failure |

Use Node 24.22.1, pnpm 11.15.1 and Bun 1.4.4. Follow the
[PostgreSQL setup](../../docs/testing/postgresql.md) and
[real-runtime procedures](../../docs/testing/kubernetes.md).
Register the Agent scenario in the QA selector, manifest and applicable advisory
lane. Fixture or source-only checks do not satisfy native runtime acceptance.

### RFC acceptance audit

| Criterion | Established | Remaining |
| --- | --- | --- |
| AC1: Scheduling | Three schedule forms and normalization through the real native protocol | Approved-tool scheduled execution in both Harnesses |
| AC2: Lifecycle | CRUD, pause/resume, stale-revision refusal and two concurrent OCC edits exercising native atomic CAS | Successful one-shot execution and retained history after deletion |
| AC3: Authority | HTTP session, exact-Agent, creator, service-key and Origin refusals | Real approved/denied tools, policy reduction and app/MCP restrictions in embedded and dedicated execution |
| AC4: Recovery | Lost replies, native CAS, failed audit and revision fencing without create replay; physical Gateway replacement retains paused state and native identity with unchanged in-memory OCC ownership | PostgreSQL-backed production cutover and completed-run history across replacement |
| AC5: Persistence and audit | PostgreSQL invariants, atomic audit, native-ID binding and deletion-worker cleanup with sibling preservation | Model-run evidence required by the other criteria; no persistence-specific gap remains in the selected cases |

The runtime guide's `OCC_TEST_QA_OPENAI_KEY_FILE` and `OCC_TEST_QA_MODEL_API_KEY`
are unset in the task environment. The selected `OPENAI_API_KEY` reached the
OpenClaw Pod unchanged, but the provider returned `401 invalid_api_key`. No other
documented credential for the selected endpoint was available. Do not substitute
a staging credential or another provider.

The normal CLI reports workload-identity login. Its documented login help has no
same-identity workload refresh command. The canonical review's authentication
failure does not establish whether that identity is rejected or unavailable in
review isolation. Restore the existing host identity integration before retrying;
no token extraction, manual refresh or provider fallback was attempted.

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
  2 tests without a model call, PostgreSQL ownership passed 1 test, and focused HTTP
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

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-11-21: Add genuine Gateway replacement and concurrent native CAS proof without model calls; retain the PostgreSQL-backed production cutover and model-history gaps.
- 2026-11-21: Repair local infrastructure, record both Harness authentication failures and canonical review status, add deletion-worker ownership proof, and audit AC1–AC5 without claiming model qualification.
- 2026-11-21: Record broker protocol, persistence and upgrade results, and the blocked Kubernetes model proof. Keep policy and independent-review gaps explicit.
- 2026-11-21: Real native protocol verification found that cron.add rejects caller-selected IDs. Use OCC IDs, native declaration keys, disabled creation and a durable one-time native binding before activation.

- 2026-11-21: Revise delivery around the selected OCC broker and sole-manager assumption; retain prior verification limits.
- 2026-11-20 20:31: Correct creation admission to require operate before resource lookup. The real HTTP regression failed on commit `465a76013e` (administer-only POST returned 503 instead of 403) and passed after the correction. Administration still admits the other five operations to the qualification refusal.
- 2026-11-20 20:28: Record passing local admission checks and the blocked independent review; native acceptance remains unrun.
- 2026-11-20 20:23: Record admission work and upstream qualification blockers (source `d4a3ab0c9603ce9678995160776dd78d94a7a688`; authoring run `01a1fc52-9d88-7223-b8a1-3c98595d3fbe`).
