---
status: Completed
rfc: ../rfcs/20261121-agent-automations.md
---

# Implementation plan: Agent automation APIs

- **ID:** RFC-20261121-agent-automations
- **Delivery status:** Completed
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

Implemented in [PR #6942](https://github.com/openclaw/openclaw-enterprise/pull/6942)
at commit `fda1229e7adf0b36ec185824fde6b4cef0e7ad1e`. The current
[reference](../../docs/reference/agent-automations.md) and
[flow](../../docs/flows/agent-automations.md) describe the supported API.

The real native Gateway integration passed on that commit on kdevbox-2 with
Node.js 24: 1 passed, 0 failed, 0 skipped, in 84.155 seconds.

```sh
OCC_TEST_RUNTIME_IMAGE=openclaw-enterprise-runtime@sha256:2697f9166f1fcceecd3b2e5e9bda8e68ab994c218b58288440b42721ec1d8362 \
OCC_TEST_WORKSPACE_ENVOY_IMAGE=envoyproxy/envoy@sha256:947974108bb93df64469fedaa0ab7191cdf86c608217d6ff9b497c4e96ff1069 \
node --test tests/integration/workspace-files-native.test.ts
```

[Required CI passed](https://github.com/openclaw/openclaw-enterprise/actions/runs/45262190826/job/138010823178)
at the same commit: 35 successful checks, 9 conditional skips, and 1 optional
neutral check. The integration made no model calls. It did not qualify model,
MCP, scheduled tool, release, or deployment behavior.

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
