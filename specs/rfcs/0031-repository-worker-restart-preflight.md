---
status: Proposed
implementation_status: Not implemented
author: freeqaz-openai
---

# Report repository access risk before replacing a worker

## Decision requested

Before `scripts/upgrade-production-images` stops either controller writer,
report whether each retained active Agent revision depends on its original
worker for repository access. Add a read-only disposition to the existing
complete deployment inventory, supplied by the revision's selected Compute and
Sandbox owners. Refuse the retention path when that dependency is known or
cannot be assessed.

This is a proposed extension to
[RFC-0023's repository lifecycle](0023-egress-proxy-credential-lifecycle/github-installation-access.md).
It proposes changing [RFC-0011's controller-only inventory and first-upgrade
assumptions](0011-coordinated-image-upgrade.md#admission-and-fleet-selection);
that historical text remains intact. Human review must resolve the authority and
older-server boundary below before this contract ships. No implementation or
runtime qualification is included here.

## Current behavior and problem

A healthy Agent can fetch from Git while its original worker is running, but
lose repository access after that worker stops. The
[OpenShell repository owner](../../apps/controller/src/drivers/egress-proxy/openshell-git-runtime.ts)
requires the original launch witness for some admitted executions. Other modes
can observe the retained execution after replacement. A profile name or a
successful Git request does not distinguish these cases.

The existing
[Compute verification operation](../../packages/contracts/src/drivers/compute/index.ts)
and [Sandbox repository access](../../packages/contracts/src/drivers/sandbox/index.ts)
verify an execution. The terminal-result amendment to RFC-0023 reports an actual
replacement that cannot inherit a held launch. Neither operation is a
prospective restart assessment. Calling verification from the API process and
treating its missing worker cache as evidence would misclassify a healthy worker.

The [inventory implementation](../../packages/occ/src/index.ts) and
[wire schema](../../packages/contracts/src/api/resources.ts) expose the active
revision ID but no repository restart disposition. At source baseline
`e658fa14b627fc6d55c8d67a68f5668efc27397c`, the upgrade helper requests this
inventory only for runtime selection. A separate Harness-only preflight can use
that existing API without changing a Driver contract; it does not establish the
repository disposition proposed here.

## Proposed owner contract

Add an optional `repositoryWorkerRestartDisposition` operation to
`ComputeDriver`, taking the immutable `AgentRevision` and an abort signal.
Kubernetes Compute delegates to an optional operation on
`SandboxRepositoryAccess`, using its existing owned Namespace context with the
same revision and signal. Unsupported implementations provide no positive
assessment. Expose the result as optional `repositoryWorkerRestart` on the
existing `InstallationDeploymentInventoryAgent` and its wire schema.

| Disposition                | Required evidence                                                                                                                                                                                                                                  |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `original-worker-required` | The admitted mode, exact binding and selected implementation establish a dependency on the process-local launch witness. For a standing route, the owner also recognizes the revision's existing durable execution evidence.                       |
| `reverification-supported` | The selected owner supports cold observation for this admitted mode and identifies matching durable execution evidence. Replacement must still verify the actual predecessor, recipient and fence; this result does not promise successful access. |
| `not-applicable`           | The active revision positively has no repository access, or its identified repository delivery owner establishes that this worker dependency does not apply. Other credentials and components remain outside this assessment.                      |
| `unknown`                  | Evidence is missing, inconsistent or incomplete, the selection is unsupported, or the owner cannot establish another result.                                                                                                                       |

Share the held-launch classification with the actual OpenShell verification
path. Preserve the observed-hook preview's separate refusal of cold inheritance;
recognizing that limitation does not issue the terminal reason code used for an
actual held-launch replacement. A missing route or cache entry alone proves
nothing. Do not classify finite grants as renewable or broker grants as
worker-independent by name. An otherwise recognized finite held launch can still
require its original worker.

This operation must work from the API process. It may read existing owner
metadata but must not adopt a route, take or advance a fence, issue or refresh
material, contact a provider, enqueue work, impersonate the worker, or compare
the API process's instance ID as evidence of replacement. Return only the
disposition, not worker IDs, fingerprints, provider data or secrets. Do not set
`repositoryAccess.state=redeploy-required` before an actual terminal result.

OCC authorizes the complete inventory and loads each selected active revision
through State, rather than the Agent's mutable draft. It calls the selected
owner outside the State transaction, with bounded cancellation, then rechecks
that the active revision and relevant selection remain current. A changed fleet
requires a fresh inventory; an old assessment cannot authorize the next step.
No new endpoint, permission, durable record or credential protocol is proposed.

## Upgrade behavior and authority

Use `occ installation deployment-inventory` and the existing upgrade helper.
Share one active-revision inventory pass with the Harness check while keeping
the two results independent. An upgrade retaining an active revision refuses
`original-worker-required`, `unknown`, or an omitted or unrecognized field
before either writer is stopped. Report Namespace, Agent, revision and a bounded
reason. The operator can plan an interruption and stop and settle the affected
Agent, or use an already-authorized normal revision replacement. The helper must
not deploy automatically, force renewal or add a skip flag. Planning a
replacement is not evidence of continuity.

Before the first stop, refresh the inventory and refuse changed selections.
This read does not lock the fleet or fence concurrent operators: exclusive
maintenance ownership remains required. On resume, repeat preflight if the
worker stop still lies ahead. If it already happened, reconcile existing
execution evidence without replaying the stop or claiming a prospective check.

The current inventory requires Installation `administer`, exact Namespace and
Agent reads, and both `deploy` and revision `read` for eligible running Agents.
Reuse those checks without silently weakening or expanding their authority.
This means the proposed controller retention path needs more authority than
RFC-0011's original Installation-read-only path. **Decision for the RFC owners
and deployment maintainers:** accept those existing inventory permissions for
this guarantee, or define a different authorized read in the RFC before coding
that alternative.

A complete authorized inventory with no retained running revisions needs no
disposition. An absent endpoint, denied inventory, incomplete response or
missing field is not an empty fleet. The candidate server cannot supply a
pre-stop guarantee retroactively. For an older server that cannot enumerate,
the retention path refuses; any separately managed interruption and bootstrap
must be explicit and cannot claim this preflight succeeded. This proposal does
not silently extend RFC-0011's controller-first bootstrap guarantee.

## Delivery and required proof

After submission for human review, implement through the existing owners and
[production tooling work](../plans/0050-production-deployment-tooling.md), subject
to the contract decision. That plan currently leaves Driver contracts unchanged
and does not itself authorize this extension. Update current Driver references,
the coordinated-upgrade flow and guide, and generated OpenAPI with the eventual
implementation. No renewal redesign, trust relaxation, database migration or
second deployment mechanism is part of this proposal.

Required integration evidence remains unrun:

1. Extend the [selected-repository cold-worker journey](../../tests/integration/postgres-openshell-standing-selected-repository.test.ts): read authenticated inventory while the original worker and Git are healthy; identify its exact revision as requiring that worker. Prove the read changes no owner, fence, issuance, queued work or runtime. Then exercise the existing real replacement and terminal outcome, preserving the independent withdrawal and runtime decision.
2. Extend the [standing-route cold-transfer case](../../tests/integration/postgres-openshell-standing-route.test.ts): report supported re-verification, then exercise actual predecessor verification after replacement. Cover the preview, missing evidence, no repository access and an unsupported delivery. Include similar public profile descriptions with different actual restart behavior; schema-only mocks cannot prove the classification.
3. Extend the [upgrade recovery integration](../../tests/integration/production-image-upgrade-recovery.test.mjs): retained at-risk, unknown, missing-field and unauthorized inventories refuse before any scale, leaving both writer replica counts intact. A complete empty fleet and a positively assessed fleet proceed. Changed revisions cannot reuse stale assessments; resume adds no deployment or duplicate stop.

Keeping the current post-replacement diagnostic alone is simpler but discovers
risk after interruption. Inferring safety from profile names or warm Git success
would avoid the owner operation but cannot establish cold behavior. The proposed
operation keeps that decision with the owner that must later verify it.
