# Implementation plan: one tenant namespace in a single cluster

- **ID:** TASK-0043
- **Delivery status:** In progress
- **Owner:** Kimi Yu
- **Authority:** [Platform architecture](../../docs/design.md)
- **Source baseline:** b9613e5d1b7b55f02c685fb61a2ff2a2f1edc968

## Outcome and scope

Single-cluster Kubernetes Compute places dedicated Gateways, Harnesses and
canonical tenant configuration and credentials in one tenant namespace. Separate
Pods, identities, credential groups, private volumes, node placement and exact
Agent/revision network peers remain. Two-cluster execution retains its separate
control target. This supersedes the same-cluster namespace allocation in
[the earlier placement plan](36-control-plane-gateways-plan.md).

Namespace workload managers are trusted for both roles. Namespace quotas and
namespace-wide operations cover both roles; this change adds no admission system.
Existing split-layout resources and volumes are not migrated or deleted.
Single-cluster startup refuses that layout before tenant reconciliation; see
[upgrade requirements](../../docs/reference/drivers/kubernetes-compute.md#existing-split-layout-installations).

## Contract and source touchpoints

Kubernetes Compute owns placement, credential provisioning and lifecycle.
Kubernetes Secret and Configuration Drivers discover the canonical storage target
through verified namespace metadata. A single-cluster tenant advertises that
storage role itself; the two-cluster control namespace retains it separately.
Gateway/Harness credential delivery uses execution roles rather than namespace
inequality. Ownership, Secret UID and revision guards continue to apply.

## Implementation

- [x] Unify same-cluster placement and canonical storage discovery, including
      adopted namespaces, without changing the two-cluster target.
- [x] Preserve role-specific credentials, storage and network policies; update
      stop, retirement, deletion and development/fixture resource grants.
- [x] Extend existing credential, ownership and real-cluster lifecycle tests.
- [x] Update current architecture, references, guides and topology flow.
- [x] Run focused conformance, type/lint/format/docs and real-cluster checks.

## Review follow-up

- [x] Merge `ad15e741` without reverting single-cluster placement; preserve the
      bounded runtime-image observation and worker liveness checks from main.
- [x] Handle concurrent legacy password creation by accepting only an exact-owned
      Secret with identical bytes; retain refusal of foreign or conflicting sources.
- [x] Reject an unsafe in-place split-layout upgrade in API/worker startup preflight,
      before tenant reconciliation can add a duplicate storage label or create empty
      replacement state. Inspect all namespace pages and document retained resources.
- [x] Cover configured development API composition and all worker starts through
      optional Compute preflight, with real PostgreSQL/Kubernetes caller regressions.
- [x] Use explicit upgrade refusal, as permitted by the repository's compatibility
      boundary. Automatic transfer of existing volumes and UID-bound references
      remains unsupported; the guard and operator instructions state that limit.
- [x] Run the selected real-cluster proof and focused local checks for the merged
      implementation; required GitHub CI is checked separately before merge.

The namespace tradeoff remains unchanged: namespace workload managers are trusted
for both roles. This follow-up does not restore a separate single-cluster target.

### Review follow-up verification

The merged implementation passes 271 focused contracts with zero failures and
one macOS argument-size skip. Typecheck, focused lint/format, workspace/module
boundaries, flow structure, docs and spec checks pass. All four real Kubernetes
fixture cases pass without skips on disposable K3s 1.35.8 and PostgreSQL, including
legacy-layout startup refusal, lifecycle/network isolation, adopted namespace
preservation, provisioning and authenticated API/worker deployment. Total runtime
is 410.6 seconds. The old implementation fails both new conformance regressions:
HTTP 409 for identical concurrent password creation and missing rejection of
legacy storage on a later namespace page. The real-cluster lifecycle case also
fails with missing expected rejection when run against the old preflight.
Configured development API and worker startup also run optional Compute
preflight. Real PostgreSQL/Kubernetes caller checks reject the old layout before
admission, preserving its namespace UID and labels and creating no tenant target.
The three other real-cluster scenarios pass in the follow-up run; the API/worker
scenario passes separately in 165.6 seconds after shortening an invalid synthetic
label value. Production bootstrap, authentication, restart and revocation tests
also pass (two tests, no skips). Reverting API and worker startup separately
causes the caller regression to fail at its respective missing-rejection assertion;
fixed sources were restored and their local/VM hashes match. Historical native model receipts below predate
this merge; these current fixtures do not prove native model execution.

## Main refresh on 2026-10-05

Merge pinned main `dd934c39` into the published branch without rewriting history.
Preserve the shared placement and upgrade refusal while adopting main's runtime
credential RBAC diagnostics, scheduling-event filtering and test cleanup.
Main moved the lifecycle/isolation case into
`tests/integration/kubernetes-compute-driver-real.test.mjs` and common helpers
into `tests/helpers/kubernetes-compute-real.mjs`; carry the namespace, credential
projection and legacy upgrade assertions into those owners. Keep all four real
Kubernetes scenarios selected by their existing CI lanes.

The reviewer scope note remains intentional: every worker and configured
development API runs optional Compute preflight. Docker or SSH Compute preflight
failure therefore prevents development startup. The unconfigured Docker entrypoint
retains its cheap read-only early preflight before opening the database pool.

Focused contracts pass (275 passed, no failures, one macOS argument-size skip).
Local typecheck is blocked by main's new direct compiler dependency, absent from
the installed graph; clean CI must verify the merged source before merge.

## Verification

| Required outcome                                   | Check                                                                                             | Result |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------ |
| One namespace; role-specific credentials and PVCs  | Kubernetes Compute and runtime-credential conformance; real Kubernetes lifecycle/API-worker suite | Passed |
| Adopted tenant ownership and preservation          | Secret/Configuration conformance and real adopted-namespace case                                  | Passed |
| Cross-Agent network denial and replacement cleanup | Existing Kubernetes integration suite                                                             | Passed |
| Two-cluster placement preserved                    | Two-cluster OAuth handoff, logs and missing-execution-target cleanup conformance                  | Passed |

## Delivery record

Implemented the shared target, storage-role discovery, role-based delivery,
Agent/revision cleanup and single-target fixture grants. Focused validation has
512 passing tests with one macOS skip for the Linux argument-size limit;
typecheck, focused lint, formatting, workspace/module boundaries, docs/link and
spec checks pass. All four real Kubernetes 1.35 fixture cases pass across the
full run and scoped reruns: lifecycle/isolation, adopted namespace preservation,
provisioning handoff, and authenticated PostgreSQL API/worker deployments. The
lifecycle case checks that the Harness mounts its revision projection rather than
the canonical model source. The handoff case checks canonical sources in the
shared tenant; it does not assert runtime activation. The full API/worker case
checks activation separately. Native model turns, production node-pool isolation
and two-cluster real execution are outside this fixture proof.

A broader local conformance attempt reported 1521 passes, eight failures and four
skips. Failures included unavailable Linux-only fixture paths, a local control
directory restriction and timing-sensitive cancellation, redaction, SSH and
Gateway startup cases. The Gateway startup case passes the focused rerun; this
is not a claim that the broader suite is green.

Follow-up validation fixed the Console mock's storage-role label lookup. CI on
`697c2576` passes all required jobs, including 2394 baseline checks and 228
Console browser cases, both with zero failures or skips. Local approved native
runtime proof now passes dedicated Codex (including four workspace subcases)
and embedded OpenClaw: real model turns, enforced network denials, credential
rejection/recovery, and conversation/image/SQLite persistence across Pod
replacement. This uses a disposable single-cluster environment; its API/worker
Deployments reuse installed Linux dependencies and are not a Helm-install proof.

Runtime-test maintenance preserves actual password authentication, exact
Agent/revision Service selectors and worker completion evidence. Dedicated
startup-failure cases now forward configured worker options to the real in-cluster
worker and restart the actual API Deployment. Secret lifecycle expectations
follow the existing revision-projection contract: Pod recreation retains the
admitted projection; explicit OCE deployment refreshes canonical values. The
remaining native receipts are recorded with the PR validation results.

A further cleanup audit reproduced premature credential deletion during
dedicated-to-embedded cutover, both with an existing Harness Deployment and a
terminating orphan Pod. The replacement now retains predecessor projections
until normal Harness retirement. Both regression cases failed before the fix
and pass afterward; full Compute conformance has 213 passes and one platform
skip. A real Agent API mode-cutover assertion extends the native lifecycle proof.
Startup durability checks now expect the existing immediate authentication
failure code rather than an obsolete convergence-deadline result.

Native cutover also exposed a canonical transport format collision between modes.
New Agents now use separate transport/password Secrets in either mode. Legacy
combined sources remain readable and retained for older Pods; workload delivery
copies the same password to its separate owned source without changing the old
Secret. Both mode-transition regressions failed before the change and pass after;
compatibility coverage checks retained bytes, idempotence and conflicting sources.
A network interruption required a clean-database runtime rerun; the PR validation
records its results separately from interrupted attempts. Plugin-status fixtures
also provision the modern separate, owned credential sources so strict ownership
validation exercises the same contract as production.

## Manual Notes

## Changelog

- 2026-10-02: Complete implementation and focused/local real-cluster verification.
- 2026-10-02: Begin authorized same-cluster namespace simplification (b9613e5d; 01a0fe72-58b2-7cc3-b770-7310f5401deb).
