# Basic observability: audit retention contract

[Overview](../31-basic-observability.md) · [History contract](contract.md#history-query-and-disclosure)

**Status:** Proposed protected-History contract. Not implemented or qualified.

**Owners:** State/SQL owns policy, receipt, expiry and live-ledger erasure. Composition/operators own installed enforcement and supported restore.

<a id="decision"></a>

## Policy and trusted time

The selected protected-audit retention default is configurable **90 days**. An explicitly authorized indefinite mode is also selected; supported finite values and configuration details remain owner decisions. A deployment with an explicit existing policy keeps it until an authorized, audited change. This contract gates [History and exact mutation recovery](contract.md#history-query-and-disclosure), not operator-owned diagnostic files. Existing [append-only SQL protection](https://github.com/openclaw/openclaw-enterprise/blob/724dcb5cb80b5e76a62e8267a21185a2e91a85c2/migrations/0001_occ_immutability_and_grants.sql#L12) is a foundation, not this proposed retention implementation.

The singleton Installation stores mode, monotonic revision, database-stamped change time and a monotonic expired-anchor frontier recording irreversible expiry progress.

Current `manage_audit_retention` authorizes policy changes by expected-revision compare-and-swap. Policy and its mandatory event commit together in original State. The event follows the new mode. Stale revisions fail even for the current mode.

New records receive database-stamped `received_at` and `retention_anchor_at`, tagged `database_receipt`. Producer observation time is separate. Legacy records retain null `received_at` and use supported OCC-produced `occurred_at`, capped at migration time, as a `legacy_occurrence` anchor. Reject or explicitly disposition records without sufficient producer/time provenance. The [public receipt](contract.md#facts-and-events) distinguishes these cases.

Preserve the audit primary key. Add an immutable bigint identity sequence and constrained historical Agent/operation/revision facts without a live-Agent foreign key. Every row requires `audit_event_retention` metadata: missing metadata is an integrity failure, never indefinite retention.

<a id="expiry-and-concurrency"></a>

## Expiry and policy changes

A finite policy expires a record at its trusted anchor plus the selected duration. The explicitly authorized indefinite mode gives new events no automatic age expiry. Disclosure hides expired records, and an authorized worker deletes them from the **live ledger within another 24 hours**.

Append, sweep and disclosure take policy-row **`FOR SHARE`**. Policy change takes its exclusive lock before appending evidence or changing expiries. `FOR KEY SHARE` is insufficient. A narrow definer lock/read function supplies the shared lock without application UPDATE permission. Sample one `clock_timestamp()` after locking. Disclosure uses the [short READ COMMITTED State write transaction with IAM read-bound authorization](contract.md#history-query-and-disclosure), not generic repeatable-read or read-only access.

Acquire Installation, account/session, policy and protected-resource guards before the first append trigger takes retention. An audit-only transaction cannot later acquire earlier guards. Retention functions cannot call back into IAM after locking. Review every writer's SQL, including already accepted protective worker transitions: they need correct stamping and order without an invented human session. New authority/effects retain their admission checks.

State proposes the following transition arithmetic. It requires fresh source and security review. Take one database time `T` after the exclusive policy lock. Let `A` be the trusted receipt or eligible capped legacy anchor, `N` a newly selected finite duration, and `E` a stored finite expiry. At `E <= T`, preserve `E` and its original `E + 24 hours` erasure deadline, even if overdue.

1. Finite to indefinite: clear only `E > T`. Continue to hide and sweep expired values.
2. Indefinite to finite: for a null expiry, set `E = greatest(A + N, T)`. If `A + N <= T`, hide at `T` and erase within 24 hours of `T`. Preserve an existing expired finite value. An unexplained future finite expiry is an integrity failure.
3. Finite to finite: preserve expired values. For unexpired rows propose `E = greatest(A + N, T)`. A shorter duration can hide a row at `T`, and a longer duration can retain only an unexpired row.

Lock, compare-and-swap and evidence must commit together. Advance the irreversible frontier entering or leaving finite mode, and treat current trusted time as an implied frontier under finite policy. The frontier must remain sound across finite durations, late rows and restore. Owners must review its representation rather than infer one from this arithmetic. Missing recovery evidence cannot be reconstructed.

Indefinite provides no legal hold, unlimited storage, arbitrary deletion authority or credential-cleanup exception. Required operations fail closed when local audit cannot commit.

**Proposal, owner decision pending:** State/Audit/API must resolve [expiry crossing during pages and exact recovery](contract.md#history-query-and-disclosure). Preserve transition arithmetic. No timer reset is approved.

<a id="database-and-runtime-enforcement"></a>

## Enforcement and purge

Use the existing raw-SQL migration runner. Backfill legacy rows under the migrator's exclusive table lock and restore final triggers before commit. All tables are logged. State and standalone work-queue writes require effective `fsync` and `synchronous_commit` waiting for local write-ahead log (WAL) flush. Preserve unknown-COMMIT classification.

<a id="every-insert-and-ordinary-application-role"></a>

### Every insert and ordinary application role

A BEFORE INSERT trigger locks policy and stamps trusted fields. An AFTER INSERT trigger atomically creates retention metadata. Privileges or equivalent construction prevent forged receipt, sequence and anchor. This includes [direct queue CTEs](https://github.com/openclaw/openclaw-enterprise/blob/724dcb5cb80b5e76a62e8267a21185a2e91a85c2/packages/occ/src/state/postgres-work-queue.ts#L216) and non-Agent account/login writers, not just lifecycle API appends.

Ordinary application roles cannot UPDATE, DELETE or TRUNCATE facts, change policy/metadata directly or manipulate sequence. Audit UPDATE remains unconditionally forbidden.

<a id="restricted-purge"></a>

### Restricted purge

A security-invoker delete trigger admits only the trusted purge-function owner after independently verifying that recorded expiry has elapsed. The function uses fixed schema-qualified SQL and a secure fixed search path with `pg_temp` last. It enforces a batch ceiling and accepts no caller event IDs or cutoff.

It locks an ordered eligible batch with `SKIP LOCKED`, deletes ledger rows and cascades metadata removal through its foreign key. A trusted migrator may own it. A separately provisioned runtime role has only EXECUTE and `occ_app` is not a member. Current selected-IAM retention authority is also required. Return aggregate progress and sanitized failures only.

**Proposal, owner decision pending:** State/composition/IAM/SQL must bind current authorization and separate purge-role execution under one reviewed guarded boundary. Checking one connection and executing unguarded elsewhere, lending a foreign unit of work, granting purge to `occ_app` or granting policy writes to History readers cannot satisfy it.

<a id="policy-change-and-runtime-checks"></a>

### Policy change and runtime checks

The sole metadata-update function takes the exclusive lock first, applies the CAS and eligible expiry/frontier changes, and appends mandatory evidence in original State. The insert trigger creates initial metadata.

Composition provides authorized configuration and a bounded, restart-safe sweeper with pressure/overdue-erasure health. After migration **and restore**, verify effective function ACLs, `PUBLIC`/application exclusion, role memberships and fixed definer search path. A role name alone does not prove effective privileges.

## Restore and copy ownership

The product owns its live ledger and product-created copies. Operators own independent backups, replicas, snapshots, WAL archives and downloads. Live deletion does not certify erasure from those copies.

Before any replica serves History or exact recovery, require authoritative current mode/revision/frontier or complete replay continuity through an independently established terminal policy revision. Apply filtering and required purge first. A restored database, signature, file timestamp or largest restored revision cannot prove no later policy exists. Unprovable continuity keeps disclosure unavailable. Unrelated diagnostics retain their own controls.

**Proposal, owner decision pending:** product, State and operators must select a supported procedure that fences the source against further changes, exports its final committed checkpoint outside the rolled-back database and imports under restricted restore mode. It must:

1. **Issue and retain authoritative material.** Define the State issuer, bounded/versioned envelope, integrity/custody and exact Installation binding against the operator-established target. Preserve complete authority/frontier continuity.
2. **Authorize export and import.** Define custody access/replacement and outcomes for missing or stale material and unsupported recovery. Export/import authority implies neither History-read permission nor ordinary application DML.
3. **Validate and apply.** Use the State/SQL guard protocol and reconcile current trusted database time with immutable facts, finite expiries, frontier and the **original finite-expiry/24-hour obligations**.
4. **Activate every replica.** Gate startup/readiness on restart-safe filtering/purge and acknowledged completion. Interrupted or unknown import/activation stays closed until exact committed state is established. A restored ready bit is insufficient.

This is operator recovery, not remote audit delivery or independent rollback detection. The custody/freshness procedure needs acceptance before implementation is accepted. No new recovery service is prescribed.

<a id="acceptance-and-follow-ups"></a>

## Verification and open decisions

Use real PostgreSQL roles and concurrent connections to test forged stamps/sequence, missing metadata, exact-expiry transitions, post-lock timing, long waits/cancellation and append/change/sweep/disclosure races. Prove residual finite purge under indefinite, stale CAS, rollback/lost acknowledgment, direct-DML denial, definer isolation, fresh/legacy migration and bigint pagination. Test current authorization and effective role/function ACLs through actual consumers.

Restore an older indefinite backup across subsequent finite expiry and return to indefinite. Wrong Installation, missing/stale continuity, malformed/unsupported checkpoint, unauthorized import, incomplete replay or later policy changes must prevent premature disclosure. Exercise interruption, restart, multiple replicas and unknown COMMIT too.

Record effective installed durability, sweeper restart/overdue health, the actual custody/restore procedure and copy-specific erasure deadlines separately from database tests. These are required future checks, not recorded passes.

Arbitrary periods/classes and legal holds await a selected richer-policy use case. State/product/operators must qualify migration, transitions, races, erasure and restore. Remote custody or independent witnessing awaits a stronger recovery/trust requirement and [acknowledgment, replay and custody evidence](contract.md#security-and-failure). Neither is an excuse to waive already-expired erasure obligations or the restore gate.
