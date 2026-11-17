---
rfc: ../rfcs/0039-event-contract-ownership/index.md
---

# Implementation plan for Agent runtime audit

- **ID:** RFC-0039
- **Delivery status:** In progress
- **Owner:** OCE maintainers
- **Authority:** [RFC-0039](../rfcs/0039-event-contract-ownership/index.md)
- **Source baseline:** `c8c1fb2d1e00413a4a911d1bd7980d44a4e252a1`

## Outcome and scope

A reader with the audit grant can use the Agent audit API to find runtime
activity. The first change covers milestone 2 and the review, file, network,
and tool observations selected from milestone 3.

## Contract and source touchpoints

[Runtime event contracts](../../packages/contracts/src/runtime-audit.ts) list the
fields for each action. The [audit guide](../../docs/guides/topics/audit-log.md)
explains enrollment and read access. The
[audit flow](../../docs/flows/audit-ledger.md) traces writes, retries, and reads.

A review event can include a safe classifier reason and the saved message ID
from the same session. The ID refers to existing conversation history.
To read the message, the reader must also have access to that history.
A tool call records the tool name and call ID. A file decision records the
path from the enforcing file check. A network denial can record the destination
host and port from the enforcing network service.

## Implementation

1. Verify runtime credentials and Agent revision scope at the API. Use the
   existing PostgreSQL ledger. Use the producer event ID to accept identical
   retries as one row.
2. Add runtime event fields to the Agent audit API. Keep its existing grant
   checks, disclosure record, and cursor scope.
3. Record OpenClaw and Codex activity at their execution boundaries. Use the
   tool result and turn result from their respective owners. Record the cause of
   a blocked turn only when its owner supplies that cause.
4. Use an authenticated enforcement source for network denials. Enroll the
   exact Sandbox and Agent revision before accepting its observations.
5. Test the write and read path and each producer on one branch. Record remaining
   producer and deployment limits before marking the milestone complete.

## Verification

| Required outcome                                               | Real check and prerequisites                                        | Result or remaining proof                                                                                                                    |
| -------------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Write, retry, and read within one Agent scope                  | HTTP ingress and Agent audit API with disposable PostgreSQL         | Passed source, grant, and payload checks, retry deduplication, field filtering, and pagination.                                              |
| Keep existing rows across upgrade                              | PostgreSQL logical restore before and after the migration           | Passed the canonical and Provider restore cases.                                                                                             |
| Send runtime evidence and retain the event ID on retry         | Pinned OpenClaw source with an HTTP receiver on loopback            | Passed the sender test.                                                                                                                      |
| Receive a Sandbox denial and reject evidence outside its scope | HTTP OTLP upload and Agent audit API with disposable PostgreSQL     | Passed authentication, Sandbox matching, host and port projection, and replay checks with protobuf input. A live supervisor test is pending. |
| Observe a regular Agent turn and review result                 | Dedicated Gateway with audit enabled and a supported model provider | The pinned runtime passed its sender and source checks. Full deployment proof is pending.                                                    |
| Observe cancellation, restart, and gaps in delivery            | Interrupt an active turn and stop each producer during delivery     | Full proof is pending.                                                                                                                       |

The stock Codex App Server does not report the outcome of each provider
request. The separate OpenClaw worker also needs a trusted source for its
local file and tool operations. Milestone 2 remains in progress.

## Manual Notes

## Changelog

- 2026-11-17 20:37 UTC. Added the runtime delivery plan and recorded the initial PostgreSQL and sender checks (`c8c1fb2d1e00413a4a911d1bd7980d44a4e252a1`).
