# Implementation plan: Bounded planned replacement

- **ID:** RFC-0036
- **Delivery status:** In progress
- **Owner:** Kimiyu-186
- **Authority:** [RFC-0036](https://github.com/openclaw/openclaw-enterprise/pull/4857)
- **Source baseline:** OCE `60289cbf3`; OpenClaw `f60bf92ea58`.

## Outcome and scope

An eligible image update waits for admitted work and delivery before stopping
the serving revision. V1 rejects independent new work; it adds no message queue.
The fixed deadline belongs to the serving revision, not a candidate or retry.
Stop, delete and authorization withdrawal retain their immediate path.

## Contract and source touchpoints

The worker owns the single predecessor stop boundary. The proposed preflight
in #1045 can run before it; this implementation does not add probe Pods.
Driver code decides eligibility from the admitted snapshots. Generic worker
code does not select vendors, execution modes or image formats.

Extend the existing Agent lifecycle record with typed predecessor operation
data. Use existing Namespace/Agent transaction locking and Work claims. Record
stopping before credential closure and stop effects. Waiting can yield a Work
claim; its retry does not consume the ordinary convergence budget. Active
revision maintenance and native administration read the same stop fact.

OpenClaw retains its existing suspension owner and exact-process handoff. Add a
completion mode with a short renewable lease bounded by the supplied fixed
deadline. Readiness in this mode includes active work and result delivery;
existing drain readiness continues to mean custody, not completion. Handoff
rechecks completion under the same lease. A lost lease or process never proves
completion. A Controller outage eventually releases admission.

## Implementation

1. **Gateway completion protocol:** extend suspension prepare, coordinator,
   handoff and protocol validation together. Preserve existing freeze/drain
   callers. Test rejection, continuation, late delivery, cancellation and expiry.
2. **Shared OCE stop boundary:** add typed storage, claim-checked operations,
   worker integration and common maintenance/native-admin status semantics.
   Preserve the conservative path for legacy records with unknown stop history.
3. **Bounded wait integration:** reuse the existing administrative client for
   Kubernetes completion waiting under the shared worker boundary.
   Unsupported runtimes retain the existing replacement path and report why.
4. **Operator behavior and qualification:** expose waiting/outcome through
   existing progress, logs and metrics; align convergence and release-helper
   clocks. Exercise actual PostgreSQL and the isolated Kubernetes release flow.
   Update the existing lifecycle flow and reference documents.

Publish cohesive draft PRs for these functions with explicit dependencies.
Do not split a schema or interface from its regular workflow consumers. The
default runtime pin is not advanced before the candidate runtime is qualified.

## Verification

| Required outcome                           | Real check and prerequisites                                                    | Result or remaining proof                                                             |
| ------------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Wait for tasks and final delivery          | Authenticated Gateway RPC, actual task and completion handoff                   | Transport with a held admitted root passed; real Codex task pending                   |
| Reject new work; permit continuations      | Gateway admission and approval paths during the same wait                       | Existing continuation contracts and real chat rejection passed; full workflow pending |
| Keep a fixed deadline                      | PostgreSQL restart, retry and successor replacement                             | Gateway cutoff passed; worker integration pending                                     |
| Preserve authority and stop intent         | Revocation, cancellation and worker interruption through regular Agent workflow | Shared stop boundary and legacy adoption passed; wait integration pending             |
| Upgrade busy and idle Agents independently | Retained isolated Kubernetes installation, both Gateway and Harness replaced    | Not run                                                                               |
| Force progress after deadline              | Same release path with outstanding work; no uncertain replay                    | Not run                                                                               |
| Preserve ordinary operations               | Old conversation, scheduled task and unsupported-runtime replacement            | Not run                                                                               |

## Delivery record

- Shared stop-boundary slice: 15 native-access tests passed; PostgreSQL migration
  qualification passed ten fresh, upgrade and restore paths. All 40 PostgreSQL
  worker cases passed. Integration review then found that allowing ordinary
  predecessor maintenance could apply changed Installation images before stop.
  That permission was removed: the real worker regression failed before the
  correction and passed afterward, alongside legacy adoption and stop ordering
  (three targeted cases). Safe maintenance remains part of the Driver integration.
  Review also found and fixed
  legacy adoption incorrectly reopening a stopped predecessor. Its real admission
  and worker regression failed before the fix and passed after it; all 15 native
  access tests passed again. This slice does not yet enable completion waiting.
- Gateway primitive: 43 coordinator tests and 21 schema/handler tests passed.
  Red-baseline tests reproduced the old busy refusal and missing protocol field.
  Review found and fixed readiness routing during completion wait. Another 67
  readiness/admission/continuation checks and one real authenticated transport
  test passed, including control reconnect and new-message rejection.
  Full runtime and release-path validation remains outstanding.

- Reused clean, inactive worktrees after verifying their earlier PRs were merged.
  Retained previous branches and the isolated runtime baseline.
- #1045 is a proposal, not an implemented second coordinator. Its future
  candidate check shares the predecessor lifecycle record and stop boundary.
- No default runtime pin, deployment or production resource has changed.

## Manual Notes

## Changelog

- 2026-11-10: Started implementation from the inspected source baselines.
