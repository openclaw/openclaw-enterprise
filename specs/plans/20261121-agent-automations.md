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
The current implementation still refuses dispatch; the broker and its runtime
proof remain incomplete.

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
2. Add immutable ownership reservations keyed by native job ID. Bind each row to
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
5. Reserve ownership before create dispatch. Round-trip native normalization.
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
   `UNKNOWN_OUTCOME`; there is no automatic replay.
8. Update the existing flow, reference, guide links, OpenAPI, permission and
   database-entity cheat sheets. The environment-variable inventory is unchanged
   unless implementation demonstrates a supported configuration need.
9. Run real PostgreSQL and Agent workflow proof, required local checks and
   independent review. Publish no implementation PR until the requested outcome
   is ready and verification limits are explicit.

## Verification

| Required outcome | Proof | Current result |
| --- | --- | --- |
| Human and exact-Agent admission | Real HTTP app, sessions and Native IAM | Existing refusal case passed; broker success coverage pending |
| Ownership constraints and cleanup | Disposable migrated PostgreSQL, application role, actual repository operations | Pending |
| Normalization and lifecycle | OCC HTTP calls to a real packaged Gateway in the regular Agent workflow | Pending |
| Approved and denied tools | Scheduled real model turn in each selected Harness; include current policy reduction and app/MCP boundaries | Pending |
| History after deletion | Successful one-shot and explicit deletion, then creator/admin and foreign-creator history requests | Pending |
| Unknown outcomes | Lost mutation reply, post-dispatch revision change and failed audit append; count native dispatches | Pending |
| Revision replacement | Owned disposable Gateway workload and persistent state across replacement | Pending |
| Independent review | Canonical autoreview, without provider or isolation bypass | Previous attempt blocked before reviewer launch; unchanged blocker until repaired |

Use Node 24.22.1, pnpm 11.15.1 and Bun 1.4.4. Follow the
[PostgreSQL setup](../../docs/testing/postgresql.md) and
[real-runtime procedures](../../docs/testing/kubernetes.md).
Register the Agent scenario in the QA selector, manifest and applicable advisory
lane. Fixture or source-only checks do not satisfy native runtime acceptance.

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
- Canonical review previously stopped at isolation preflight: launcher bootstrap
  returned HTTP 403 without an isolated cached executable. Normal login-shell
  bootstrap also failed on read-only cache metadata. No reviewer or report ran.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-11-21: Revise delivery around the selected OCC broker and sole-manager assumption; retain prior verification limits.
- 2026-11-20 20:31: Correct creation admission to require operate before resource lookup. The real HTTP regression failed on commit `465a76013e` (administer-only POST returned 503 instead of 403) and passed after the correction. Administration still admits the other five operations to the qualification refusal.
- 2026-11-20 20:28: Record passing local admission checks and the blocked independent review; native acceptance remains unrun.
- 2026-11-20 20:23: Record admission work and upstream qualification blockers (source `d4a3ab0c9603ce9678995160776dd78d94a7a688`; authoring run `01a1fc52-9d88-7223-b8a1-3c98595d3fbe`).
