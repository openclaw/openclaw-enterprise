---
rfc: ../rfcs/20261125-gateway-startup-credentials.md
---

# Implementation plan: Gateway startup credentials

- **ID:** RFC-20261125-gateway-startup-credentials
- **Delivery status:** Planned; Source delivery is not enabled.
- **Owner:** Gateway startup delivery maintainers
- **Authority:** [Gateway startup credentials](../rfcs/20261125-gateway-startup-credentials.md)
- **Source baseline:** `986e04b3123f7bdbcb782596875045d628e46bf3`

## Outcome and scope

A dedicated Gateway can consume an explicitly bound, supported static CredentialSource after OCC authorizes the exact binding and resolves its recorded TokenService owner. Compute owns startup delivery. Preserve existing dedicated and embedded Namespace Secret behavior, Slack directory and preflight, and their authorization paths. OpenShell qualification is separate.

At this baseline, OpenShell accepts generic static Sources, but Gateway delivery remains unqualified. See [OpenShell TokenService](../../apps/controller/src/drivers/token-service/openshell.ts).

## Accepted decisions

- Gateway namespace workload managers may access the staged usable copy. Kubernetes Compute may use the proposed revision-specific Secret without adding stronger placement or admission controls for those managers. Ordinary workload identities must still lack permission to read the copy or mount it through a workload they create.
- Exact Source `operate`, the normal Configuration and deployment permissions, and an explicit Gateway binding authorize raw export, including reuse of a Source already used by Credential Proxy. No Gateway-specific Source profile or native field allowlist is required. Keep reserved environment names and existing Configuration validation. Slack discovery and preflight remain Namespace Secret-only; refuse unsupported Source selection by an enabled Slack credential input, not by environment name.
- OCC-managed redeploy is the freshness guarantee. Updating or revoking a Source does not immediately remove a running Gateway's credential or its staged copy. A bare Pod restart can reuse that copy. The submitted RFC requires a managed start to fail if a selected binding is no longer authorized.

## Implementation order

1. **Contract and persistence.** Extend [SecretBinding and AgentRevision](../../packages/contracts/src/index.ts), [API schema](../../packages/contracts/src/api/common.ts), and [normalization](../../packages/contracts/src/secret-bindings.ts) for exact discriminated references. Update the PostgreSQL constraints owned by [Secret validation](../../migrations/0013_secret_state.sql) and [revision validation](../../migrations/0088_standalone_credential_deployment.sql) through a new migration, plus the [PostgreSQL decoder](../../packages/occ/src/state/postgres-state.ts). Freeze one private selected TokenService instance on the revision. Keep one canonical binding map. If API generation produces a substantial diff, keep contract definitions and generated outputs reviewable separately from runtime logic.
2. **Callers and Worker.** Extend [Configuration checks](../../packages/occ/src/configuration-operations.ts), [Agent assignment](../../packages/occ/src/agent-drafts.ts), [Agent credential access](../../packages/occ/src/agent-credential-access.ts), [provisioning](../../packages/occ/src/agent-provisioning-requests.ts), [provisioning worker](../../packages/occ/src/agent-provisioning-worker.ts), and [deployment admission](../../packages/occ/src/agent-deployment-admission.ts) by reference kind. Persist Source-only bindings without requiring a Namespace Secret Driver. Extend [Source deletion](../../packages/occ/src/state/postgres-state.ts) and its [in-memory mirror](../../packages/occ/src/state/platform-state.ts) to check all references, including queued/running provisioning plans. Extend [Agent/revision/Source withdrawal](../../packages/occ/src/agent-credential-withdrawal.ts) for that target's uses, without modifying other Agents, shared Configurations, or queued plans. Preserve existing Proxy update effects and other consumer bindings when only a Gateway binding is removed. In the [deployment Worker](../../apps/controller/src/worker.ts), bind the RFC's `authorize` and `resolve` callbacks to the claim, immutable revision, both principals, exact Source and selected instance; recheck after owner I/O. Require the callbacks only for exported delivery and preserve legacy Secret-only dispatch.
3. **Compute delivery and lifecycle.** Extend [ComputeRevisionContext](../../packages/contracts/src/drivers/compute/index.ts) as submitted. In [Kubernetes Compute](../../apps/controller/src/drivers/compute/kubernetes/index.ts), stage a revision-specific Secret in the Gateway namespace, project it only into the dedicated Gateway, and authorize immediately before every launch-triggering preparation or activation mutation. Restage the live owner value for an unlaunched retry; observe uncertain launches before retrying. Clean up in the Gateway namespace, which may differ from the Harness namespace used by existing cleanup. Refuse embedded or unsupported Source delivery. Preserve canonical dedicated Secret references and embedded Secret copies.
4. **Documentation and proof.** Update the owning [Configuration Secret reference](../../docs/reference/configuration/secrets.md), [Kubernetes Compute reference](../../docs/reference/drivers/kubernetes-compute/storage-and-credentials.md), and [Configuration deployment flow](../../docs/flows/configuration-driver/persistence-and-revisions.md) when implemented. Arrange independent implementation review only after a candidate exists.

## Verification

- [Kubernetes Compute real workflow](../../tests/integration/kubernetes-compute-real.test.ts): real API, PostgreSQL Worker, Kubernetes Compute, and the native Gateway process observe A, retain A after update, then observe B on managed redeploy; an unlaunched retry staged with A starts with B. Check Gateway-only projection, ordinary workload identity access, cleanup, and canonical Secret update followed by bare Pod replacement. Use a disposable enforcing cluster, migrated application database, approved digest-pinned runtime images and authorized model prerequisites; do not put secret values in command arguments or logs.
- [PostgreSQL Worker Source cases](../../tests/integration/postgres-worker-agent-revision-credential-sources.test.ts): deny each principal, revoke during owner I/O, deny staged reuse, and sanitize owner/staging failures before candidate Gateway mutation. Correlate existing audit and immutable revision evidence with the actor and exact Source without exposing values.
- Bind a Source also used through Credential Proxy, verify the new copy reaches only Gateway, preserve Proxy request restrictions and its binding when the Gateway binding is removed, and prove no Gateway copy exists without explicit selection.
- [Provisioning admission cases](../../tests/integration/postgres-agent-provisioning-admission-cases.ts): a queued plan alone blocks deletion of its Gateway Source before a Configuration or Agent exists. Retain existing [Slack authorization](../../tests/integration/occ-api.test.mjs) and [directory](../../tests/integration/occ-api-channel-directory.test.ts) cases. Register genuine QA workflow coverage through the existing QA matrix when implemented.
- Qualify OpenShell operator export and Gateway delivery separately. Model Source success does not prove Gateway support.

## Delivery record

Planning only. Exposure, explicit reuse, and freshness decisions are accepted. No implementation candidate, runtime test, PR, or deployment exists for this plan.

## Manual Notes

## Changelog

- 2026-11-26 06:32 Asia/Taipei: Created the plan from merged main `986e04b3`.
- 2026-11-26 06:38 Asia/Taipei: Recorded the accepted workload-manager exposure and managed-redeploy freshness decisions; retained the revocation deployment outcome as an open question.
- 2026-11-26 06:49 Asia/Taipei: Accepted explicit Source reuse with exact IAM and Gateway Configuration permissions; removed the proposed profile and field allowlist.
- 2026-11-26 06:51 Asia/Taipei: Retained the submitted RFC's refusal of unauthorized managed starts; credential omission is outside the approved behavior.
