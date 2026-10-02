# Dedicated Harness RWO workspace execution plan

## Outcome and scope

Status: Implemented; draft review pending. Current contracts live in [Compute](../../docs/reference/drivers/compute.md)
and [Kubernetes storage](../../docs/reference/drivers/kubernetes-compute/storage-and-credentials.md).

New dedicated Harness workspaces use a durable per-Agent ReadWriteOnce PVC.
Gateway private storage remains separate. Preserve owned existing ReadWriteMany
claims without changing their immutable spec or deleting their data. Base:
`14a4508baad876d3eea4e6fe6388f8d8a91559b7`.

## Decisions

- Extend the Compute Driver contract with an opt-in requirement to stop earlier
  revisions before preparing a replacement. Kubernetes selects this for dedicated
  execution; other implementations retain their existing ordering.
- The worker uses authoritative revision snapshots and its per-Agent queue lease.
  It closes predecessor credentials and invokes normal stop hooks, including
  SandboxDriver cleanup and bounded Pod termination, before starting a candidate.
- Once a newer exclusive revision is admitted, older revision reconciliation and
  maintenance are superseded. This prevents retries from recreating a predecessor
  between candidate readiness checks. No automatic rollback to a lower revision:
  recovery redeploys the intended configuration as a new higher revision.
- Replacement has a downtime window. Failed stopping blocks preparation; failed
  preparation leaves durable state intact for retry or a new deployment. The
  active pointer records the last committed revision, not proof of live Pods.
- RWO is node-scoped attachment, not fencing or storage replication. A portable
  CSI volume may detach/reattach; node-local storage remains tied to its node.
  No forced detach, manual Pod deletion, new storage abstraction, or migration.
- Validate in an isolated disposable cluster; preserve existing demonstrations.

## Work

- [x] Inspect current callers, contracts, storage, queue serialization and cleanup.
- [x] Implement exclusive revision preparation and new RWO claim validation.
- [x] Extend actual API/worker integration for replacement, stale maintenance,
      stop failures and recovery; verify PVC data and identity through Kubernetes.
- [x] Update lifecycle and storage references plus existing source-backed flows.
- [x] Run focused tests, real Kubernetes/PostgreSQL integration, type/lint/format
      and documentation checks; report proof limits.
- [x] Prepare draft PR evidence and the downtime/recovery contract. Review remains pending.

## Validation plan

The regression must catch old and new Harness Pods overlapping before preparation,
including pending candidate retries and provider-owned runtime cleanup. The real
Kubernetes fixture must use stock RWO-capable local-path storage and retain a file
and PVC UID across replacement, a failed candidate, and restoration through a new
revision. Existing owned RWX and foreign or malformed PVC behavior need explicit
coverage. No model turn is required to prove mount ordering; do not describe the
HTTP fixture as genuine model/runtime acceptance.

## Progress and evidence

Typecheck, lint, formatting, workspace boundaries, documentation links/length,
flow validation, and 157 focused conformance/worker cases passed. In isolated
PostgreSQL databases, all 62 revision-worker cases and both workspace-worker
cases passed with no skips. Use `TMPDIR=/private/tmp` on macOS so the Unix-socket
fixture receives a canonical path. Each worker test suite needs its own database;
concurrent suites on one queue can steal each other's work. The new exclusive
replacement case covers stop failure, stale maintenance, failed preparation,
and recovery through a higher revision.

All four Kubernetes integration cases passed on a disposable stock local-path
cluster (4 passed, 0 failed, 0 skipped; 406 seconds). The extended actual
API/worker readiness-failure and recovery case then passed separately (1 passed,
0 failed, 0 skipped; 139 seconds), retaining the PVC UID, the predecessor's file,
and a file written by the failed candidate. No RWX provisioner patch was used.
The old worker, loaded from the pinned base, fails the new exclusive-resource
regression because it attempts replacement before releasing its predecessor.

Optional model, ChatGPT credential, and OpenShell runtime suites were not selected.
No cloud CSI attach/detach, partition fencing, or cross-node data movement is
claimed by this single-node local-path proof.

The Compute reference, worker flow, and workspace flow remain between 1,500 and
2,500 words: each owns one complete contract or lifecycle with source-backed
failure/recovery behavior. Historical changelog and Manual Notes are retained.
No changes to existing deployed environments.

Follow-up audit checked first provisioning separately from replacement. Credential
provisioning still creates only Secrets; Compute creates claims during revision
preparation, then starts consumers for WaitForFirstConsumer binding. Removed stale
quickstart, handoff, test-setup, and lifecycle guidance and renamed private
shared-workspace helpers to Harness workspace helpers without changing PVC names.
The feature matrix remains a pinned historical snapshot with an explicit current
storage correction. Documentation inventory and historical experiments retain
their original evidence. Shortened the Kubernetes test guide after CI found it
above the word limit; documentation and source checks verify this cleanup separately from runtime proof.
