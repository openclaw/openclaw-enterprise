---
rfc: ../rfcs/0039-event-contract-ownership/index.md
---

# Control-plane audit coverage

- **ID:** RFC-0039
- **Delivery status:** In progress
- **Owner:** OCE maintainers
- **Authority:** [RFC-0039 milestone 1](../rfcs/0039-event-contract-ownership/index.md)
- **Source baseline:** `cea7d46c6956c59ba9604a710022159930eb5aa4`

## Outcome and scope

When Control Plane audit is enabled, the OpenClaw Control Plane (OCC) saves a
record for each supported control-plane operation. Check request results,
authentication, resource changes, and durable worker transitions. Use the
existing audit switch and PostgreSQL ledger. This work covers the control
plane. Agent turns, model requests, and tool activity belong to later milestones.

## Contract and source touchpoints

The [audit flow](../../docs/flows/audit-ledger.md) owns the request, worker,
and disclosure paths. The [audit guide](../../docs/guides/topics/audit-log.md)
identifies the recorded operations and their limits.

The registered operation supplies the audit action or operation ID. OCC
uses verified caller and resource IDs when it has them. It commits required
mutation records with the corresponding state changes. No request or response
body is needed to record an operation's result.

## Implementation

1. Inventory the supported operations in the published API. Check control-plane
   routes that the API registers separately. Record the request result, or
   identify the dedicated recorder that owns the operation.
2. Check authentication and key mutations for transactions that can commit
   before the required record. Check worker paths that register follow-up
   work or finish a resource lifecycle without evidence.
3. Return Agent creation, deployment, and provisioning records through the
   existing Agent audit API. Check exact Agent grants and page authorization.
4. Record the scope and remaining gaps in the audit guide. Keep the request
   evidence, resource evidence, and audit read permissions distinct.

## Verification

| Required outcome                                        | Evidence                                                                                                                                                                |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Each documented HTTP operation has a recorder           | Real Fastify requests saved a result for 150 of 153 operations in PostgreSQL. Separate tests verified the Google and OIDC sign-in callbacks and runtime log disclosure. |
| Required evidence and state changes commit together     | PostgreSQL tests refused an audit write and checked password sessions, service API keys, and worker follow-up jobs. A successful retry saved the change and record.     |
| A reader can find creation and deployment for one Agent | The Agent audit API returned lifecycle records with a direct Agent grant. Tests checked a peer Agent, provisioning handoff, and a failed disclosure.                    |
| An upgrade preserves existing records                   | PostgreSQL 18.6 passed the canonical and Provider migration and restore cases for the lifecycle index.                                                                  |
| Saved OAuth connection cleanup records completion       | The required Keycloak CI lane runs the browser and worker test. The local fixture requires a loopback host entry.                                                       |

The route inventory checks the published HTTP operations. It excludes
arbitrary unmatched URLs. The worker checks durable job and resource changes.
The separate Harness exposure sweep logs its outcome. The Driver can report
the same result after removal, prior absence, or omission of the Sandbox hook.

## Milestone 2

Extend the existing ledger and Agent audit API to record sessions, turns,
and model-call attempts. Use the same audit switch. The
[enrollment proposal](../rfcs/0039-event-contract-ownership/runtime-audit-producers.md)
defines the producer scope, delivery rules, and acceptance checks.

1. Restore the earlier write and read path for Milestone 2.
2. Register and revoke Gateway producers from normal revision lifecycle work.
3. Add runtime recorders for embedded OpenClaw, dedicated OpenClaw, and
   dedicated Codex.
4. Exercise each runtime and two revisions through the installed workflow.
   Check the API response, request retries, cancellation, and restart.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-11-18 17:36: Refocus the draft on control-plane audit. (authoring-run/612e8009-6fb8-4bb3-8bca-d93dd03873a9 - cea7d46c6956c59ba9604a710022159930eb5aa4)
