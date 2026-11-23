---
status: In progress
rfc: ../rfcs/20261121-agent-automations.md
---

# Implementation plan: Agent automation APIs

- **ID:** RFC-20261121-agent-automations
- **Delivery status:** In progress
- **Authority:** [Agent automation RFC](../rfcs/20261121-agent-automations.md), PR #6850

## Outcome

Expose the six [RFC operations](../rfcs/20261121-agent-automations.md#interface)
as a thin HTTP wrapper over native cron. Reuse exact-Agent native admin access;
do not add an OCC job store, scheduler, or execution qualification system.

## Work

1. Define the six route schemas and generate the OpenAPI reference.
2. Require a human session and exact-Agent `operate`, resolve the selected
   revision, and privately use the shared Gateway machine identity for the
   corresponding cron method.
3. Preserve Origin/CSRF checks, mutation audit, native revision conflicts, and
   `UNKNOWN_OUTCOME` without automatic retry.
4. Update the current [reference](../../docs/reference/agent-automations.md)
   and [flow](../../docs/flows/agent-automations.md).

## Verification

Extend the existing registered Agent/native-admin integration workflow. Exercise
CRUD and run-history forwarding through the supported route, denied callers,
Origin/CSRF protection, a stale revision conflict, and audit evidence. Generate and check OpenAPI,
then run the standard required PR checks. Do not run model or MCP qualification
for this API-only change.

## Delivery record

The simplified wrapper and its focused integration proof are in progress.
Earlier model-only and approved-tool qualification work is outside this scope.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-11-23: Reduce the active plan to six native cron API wrappers; remove execution qualification and OCC job ownership from the delivery scope.

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
