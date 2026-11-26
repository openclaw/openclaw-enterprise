---
status: Proposed
implementation_status: Partially implemented
author: freeqaz-openai
---

# Report repository access risk before replacing a worker

## Proposed decision

Before `scripts/upgrade-production-images` stops either controller writer,
report whether each retained active Agent revision depends on its original
worker for repository access. Add a read-only disposition to the existing
complete deployment inventory, supplied by the revision's selected Compute and
Sandbox owners. Refuse retention when that dependency is known or cannot be
assessed.

This extends [RFC-0023's repository lifecycle](0023-egress-proxy-credential-lifecycle/github-installation-access.md).
The selected tradeoff is conservative refusal, including when an older server
returns inventory without the new disposition. Operators must stop and settle
affected Agents under an authorized interruption, or use normal runtime
replacement when its existing prerequisites hold. There is no controller-first
bypass. This RFC remains Proposed; implementation and verification do not establish
human review or RFC acceptance.

## Current behavior and problem

A healthy Agent can fetch from Git while its original worker is running, but
lose repository access after that worker stops. The
[OpenShell repository owner](../../apps/controller/src/drivers/egress-proxy/openshell-git-runtime.ts)
requires the original launch witness for supported held and observed-hook
executions. No current bundled owner supports finite or standing cold transfer.
A profile name or successful Git request does not establish restart support.

The existing
[Compute verification operation](../../packages/contracts/src/drivers/compute/index.ts)
and [Sandbox repository access](../../packages/contracts/src/drivers/sandbox/index.ts)
verify an execution. The terminal-result amendment to RFC-0023 reports an actual
replacement that cannot inherit a held launch. Neither operation is a
prospective restart assessment. Calling verification from the API process and
treating its missing worker cache as evidence would misclassify a healthy worker.

The [inventory implementation](../../packages/occ/src/index.ts) and
[wire schema](../../packages/contracts/src/api/resources.ts) on main expose the
active revision ID without a repository restart disposition. Merged
[#5000](https://github.com/openclaw/openclaw-enterprise/pull/5000) already requires
complete authorized inventory and readable saved Harness settings for
controller-only upgrades. This proposal reuses that authority and adds the owner
assessment. It does not newly introduce the inventory requirement or restore
[RFC-0011's historical controller-first path](0011-coordinated-image-upgrade.md#admission-and-fleet-selection).

## Proposed owner contract

Add optional `repositoryWorkerRestartDisposition` operations to `ComputeDriver`
and `SandboxRepositoryAccess`, taking the saved revision and cancellation signal
through their existing contexts. Expose the result as optional
`repositoryWorkerRestart` on `InstallationDeploymentInventoryAgent` and its wire
schema. Unsupported implementations provide no positive assessment.

The authorized inventory may report this field for an active, desired-running
Agent with a selected revision and no pending deployment. OCC asks the selected
Compute Driver outside the State transaction. Observations share a ten-second
budget; OCC then reauthorizes and compares the complete fleet, revision identities
and Driver selections. Kubernetes Compute verifies Namespace ownership with
bounded infrastructure reads, then delegates repository assessment to the
revision's selected Sandbox. A recognized unreadable saved configuration retains
its exact active revision ID with `unknown`; it does not become executable.
Other database, identity or unexpected read failures still fail the request.

| Disposition                | Required evidence                                                                                                                                                                                                                                  |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `original-worker-required` | The admitted mode, exact binding and selected implementation establish a dependency on the process-local launch witness. For a standing route, the owner also recognizes the revision's existing durable execution evidence.                       |
| `reverification-supported` | The selected owner supports cold observation for this admitted mode and identifies matching durable execution evidence. Replacement must still verify the actual predecessor, recipient and fence; this result does not promise successful access. |
| `not-applicable`           | The active revision positively has no repository access, or its identified repository delivery owner establishes that this worker dependency does not apply. Other credentials and components remain outside this assessment.                      |
| `unknown`                  | Evidence is missing, inconsistent or incomplete, the selection is unsupported, or the owner cannot establish another result.                                                                                                                       |

No bundled owner returns `reverification-supported`; it is a conditional contract
for an owner that can establish that evidence. Supported held and observed-hook
OpenShell launches report `original-worker-required`. Standing launches also
require current approval and matching protected recipient, route, execution and
fingerprint evidence. Unsupported legacy routes report `unknown`.

Kubernetes reports `not-applicable` for a no-repository revision only after
verifying Namespace ownership and the absence of repository credentials,
`repositoryGit` and `repositoryGitAuthorization`. Missing evidence never proves
absence. Do not infer restart support from profile names or grant duration.

This operation must work from the API process. It may read existing owner
metadata but must not adopt a route, take or advance a fence, issue or refresh
material, contact a credential provider or OpenShell to observe or adopt an
execution, enqueue work, impersonate the worker, or compare
the API process's instance ID as evidence of replacement. Return only the
disposition, not worker IDs, fingerprints, provider data or secrets. Do not set
`repositoryAccess.state=redeploy-required` before an actual terminal result.
Kubernetes Compute retains its existing read-only Namespace ownership GET. The
shared cancellation budget must cover that read and the delegated assessment;
a missing or unverifiable ownership witness cannot yield a positive result.

OCC reads immutable active revisions rather than mutable drafts. Changed fleet
or Driver selections require a fresh inventory; an old assessment cannot
authorize the next step. No new endpoint, permission, durable record or credential
protocol is proposed.

## Upgrade behavior and authority

Use `occ installation deployment-inventory` and the existing upgrade helper.
Share one active-revision inventory pass with the Harness check while keeping
the two results independent. A controller-only upgrade retaining a running revision refuses
`original-worker-required`, `unknown`, or an omitted or unrecognized field
before either writer is stopped. Report Namespace, Agent, revision and a bounded
reason. The operator can plan an interruption and stop and settle the affected
Agent, or use an already-authorized normal revision replacement. A controller-only upgrade must
not deploy automatically, force renewal or add a skip flag. Planning a
replacement is not evidence of continuity.

Before the first stop, refresh the inventory and refuse changed selections.
This read does not lock the fleet or fence concurrent operators: exclusive
maintenance ownership remains required. On resume, repeat preflight if the
worker stop still lies ahead. Stopping the API first can leave API replicas at
zero and the worker at one, making a fresh inventory unavailable. In that state,
refuse to continue and leave the worker untouched; report the partial stop for
reconciliation of the existing attempt. Do not reuse stale inventory, restart
the API automatically, submit Helm or deploy an Agent. Reassess when the inventory
is legitimately available again. If the worker stop already happened, reconcile
existing execution evidence without replaying the stop or claiming a prospective
check.

The existing inventory requires Installation `administer`, exact Namespace and
Agent reads, and both `deploy` and revision `read` for eligible running Agents.
Reuse these checks without weakening or expanding their authority. Merged #5000
already adopted these requirements for controller-only upgrades; they are no
longer a separate authority decision introduced by this proposal.

A complete authorized inventory with no retained running revisions needs no
disposition. An absent endpoint, denied inventory, incomplete response or missing
field is not an empty fleet. An inventory-capable older server without the field
cannot authorize retention, even for a revision without repository access: only
its owner can establish `not-applicable`. The selected first-adoption behavior is
to refuse that retention before stopping either writer. Use an explicit
stop-and-settle interruption or supported normal runtime replacement with its
existing dispatch journal. The CLI still requires readable baseline Harness
settings; returning `unknown` for an unreadable historical revision restores
diagnostics, not runtime-upgrade eligibility. The candidate server cannot provide
a pre-stop guarantee retroactively.

## Delivery and required proof

The [linked implementation plan](../plans/0033-repository-worker-restart-preflight.md)
records the implementation in [#5003](https://github.com/openclaw/openclaw-enterprise/pull/5003),
its verification and remaining delivery work. The separate
[production tooling plan](../plans/0050-production-deployment-tooling.md) leaves
Driver contracts unchanged; this RFC owns their extension. No renewal redesign,
trust relaxation, database migration or second deployment mechanism is included.

At candidate `bd26aa1e`, two native PostgreSQL journeys passed with separate
API and worker instances over the same database:

1. The [repository-owner journey](https://github.com/openclaw/openclaw-enterprise/blob/bd26aa1e8e43dd9c9b8bc5504344888ec7e887e9/tests/integration/postgres-openshell-standing-cold-worker.test.ts)
   reads `original-worker-required` while the original worker is healthy, checks
   unchanged custody, fences, issuance and work, then exercises the existing
   replacement and terminal outcome.
2. The [revision lifecycle journey](https://github.com/openclaw/openclaw-enterprise/blob/bd26aa1e8e43dd9c9b8bc5504344888ec7e887e9/tests/integration/postgres-worker-agent-revision-stop.test.mjs)
   normally admits a no-repository revision and reads `not-applicable` through a
   separately authenticated API. Namespace ownership loss yields `unknown`;
   restoration restores allowance. Recognized unreadable historical configuration
   retains its exact active ID with `unknown`; strict writes and execution still
   reject it. Both journeys check persisted owner state.

Each journey passed once without failures or skips, including scoped cleanup.
The unreadable-history assertion failed with HTTP 503 before the correction.
At parent `6665c7f7`, [shell integrations](https://github.com/openclaw/openclaw-enterprise/blob/6665c7f7e3c8ef13f8d7eb8962749840ff82f6c5/tests/integration/production-image-upgrade-recovery.test.mjs)
covered pre-stop fleet drift, unavailable inventory after partial shutdown,
no replay and reconciliation of unknown dispatch. Generic positive helper input
verifies only its consumer contract, not a bundled cold-transfer producer.

Infrastructure records, workload transport, Gateway/supervisor peers and test
password hashing were controlled. Live cluster, installed upgrade,
model/provider execution and cold transfer remain outside this proof. Independent
source review at `bd26aa1e` closed the original finding with no open P0–P3 findings.
The plan records later hosted CI separately. This RFC remains Proposed; its
review and CI do not establish implementation merge or deployment.

Keeping only the post-replacement diagnostic discovers risk after interruption.
Inferring safety from profile names or warm Git success cannot establish cold
behavior. The proposed operation keeps that decision with the owner that must
later verify the execution.
