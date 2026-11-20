---
rfc: ../rfcs/20261106-installation-network-policy-ceiling.md
---

# Implementation plan: Manage the Installation network policy ceiling

- **ID:** RFC-20261106-installation-network-policy-ceiling
- **Delivery status:** In progress
- **Owner:** russellb
- **Authority:** [RFC-20261106-installation-network-policy-ceiling](../rfcs/20261106-installation-network-policy-ceiling.md)
- **Source baseline:** `6bf16386658e8b1f81a7f90a04ccd0697c23805c`

## Outcome and scope

Administrators edit the persisted Installation ceiling in Settings. Startup seeds
absent state. Running access stays unchanged.

## Global Constraints

- Preserve exact Installation `administer` authorization, attributable audit,
  transactional writes, explicit empty state, and fail-closed reads.
- Reuse existing grant validation and Sandbox Driver contracts. No Driver contract
  changes, automatic revocation, process-local fallback, or general settings store.
- Preserve the PR branch, published history, Proposed decision status, and human-only merge.
- New behavior requires PostgreSQL and regular Agent workflow integration proof;
  simulated UI proof does not establish runtime enforcement.

## Contract and source touchpoints

The Installation repository owns `{ installationId, version, rules, updatedAt, updatedBy }`.
GET and PUT at `/installation/sandbox-network-policy-ceiling` use the standard
data envelope. PUT takes `{ expectedVersion, rules }`; POST adds `/validate` to
that path and returns `ConfigurationResult<{ rules }>` without writes. Both
check Installation authority and version. Preview grants no later write
authority. Agent policy reads expose only rules.

Shared ceiling locks precede Namespace/Agent locks in admission and worker
transactions. Updates and initialization take the exclusive lock, including when
the record is absent. Initialization precedes HTTP admission; workers require
saved state and never seed it. Replicas retain no startup ownership lease.

## Implementation

### Task 1: Persistence, startup, API and real callers

Extend contracts, Installation repositories, schema/migrations, composition,
HTTP handlers, admission and worker rechecks. Reject the retired overwrite key.
Extend PostgreSQL Agent workflows to prove persistence, restart, stale saves,
denials, audit rollback, concurrency and absent state. Register coverage in CI.

### Task 2: Console Settings and UI evidence

Reuse shared Settings controls. Cover loading, empty, invalid, forbidden,
conflict, uncertain-save, success and permission-loss states. Preserve drafts;
require review before saving. Update and rebuild Storybook, inspect controls,
and capture before/after screenshots and video outside the checkout. Upload
native GitHub attachments and label simulated proof.

### Task 3: Current documentation and verification

Update references, guides, flows, cheat sheets and navigation; generate API docs
from route schemas. Run formatting, lint, types, boundaries, API/docs checks and
PostgreSQL Agent integrations. Run Fedora/Podman/k3d/OpenShell qualification with
the selected host and authorized credentials. Complete independent review.
Preserve ready-for-review status as requested; list outstanding merge requirements.

## Review Focus

- Empty persisted rules must survive a different seed and restart.
- Concurrent saves must reject stale editor versions.
- Tightening rejects later admission and pending work without changing running access.
- Failed audit commits roll back the setting; missing state cannot use a local seed.
- Lost save responses require reading present state, without automatic retry.

<a id="verification"></a>

## Initial verification record

| Outcome                     | Required proof                                                                               | Result or remaining proof                                                                     |
| --------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Durable ownership and audit | Real Fastify, Native IAM and PostgreSQL, including startup lease loss and session revocation | Owner suite 11/11 passed, no skips                                                            |
| Agent workflow              | Real controller/worker queues and PostgreSQL admission/concurrency                           | Agent policy suite 37/37 passed, no skips                                                     |
| Console behavior            | Real Console, Fastify and IAM with in-memory state                                           | Combined browser suite 15/15 passed; status correction 5/5 passed                             |
| Visual behavior             | Rebuilt Storybook, desktop/phone controls, screenshots and paced video                       | Desktop/phone captures and a 21-second walkthrough inspected; native GitHub uploads pending   |
| Runtime enforcement         | Selected Fedora VM, Podman, k3d and OpenShell                                                | VM started but waits for manual disk unlock; no runtime proof claimed                         |
| Repository contracts        | Format, lint, types, workspace, OpenAPI and docs checks                                      | Lint, types, formatting, workspace, OpenAPI, docs checks/build and flow render passed         |
| Independent review          | Task gates and full shared autoreview                                                        | Task gates passed at reviewed revisions; CI repairs await full review and disclosure approval |

## Delivery record

Implementation source is in PR #4920. Backend commits `3711facad` and `7721b9951`
add the saved owner and fence session/IAM authority through writes. Console commits
`5ffe67229` and `402abe0e9` add Settings, shared server preview and current draft
feedback. The RFC decision remains Proposed.

The new owner suite first failed with the missing route, then passed against
PostgreSQL 18.6. A real blocked-write/sign-out probe found a session authority
race. Its regression failed before the fence fix and passed after it. A browser
regression likewise proved the stale draft-status text before its correction.
Final serial PostgreSQL verification passes 59/59 (owner, Agent policy and worker
fixtures), and final combined browser verification passes 15/15, with no skips.
The inspected UI revision is `4be93f5a2`; desktop is 1440 × 1050 and phone is
390 × 844. The saved WebM opens and plays at normal speed for 21 seconds.
Storybook is simulated UI proof; native attachments remain a merge requirement.

The first implementation CI run exposed additional startup, build, navigation and
fixture gaps. Commits `4be93f5a2` and `fb4f4c742` separate actual PUT activity from
reads, hide an unchanged ceiling after confirmed administration loss, install the
Storybook workspace dependency graph, qualify restored migration catalogs, and
close lost startup leases without querying a broken client. Original migration
receipts and reviewed hashes remain unchanged. The affected browser cases pass
8/8, module policy passes 2/2, lifecycle/security cases pass 54/54, and the complete
selected logical-restore workflow passes. A 261/262 API/worker run had one missing-Go
failure; after installing the pinned Go toolchain, that CLI case passes 3/3.
The exact native-CI inventory and Kubernetes fixtures still need hosted verification.
The prepared-CI database contract is also checked with the migration-only URL
unset: owner and Agent suites pass 48/48 using the actual selected application
host, port and database. The stored-name startup and two-connection readiness
cases pass in separate fresh databases. The separate worker-process shutdown
fixture initializes through API startup; its local run requires the Docker Engine
socket available in hosted CI. These fixture corrections still need the next
hosted run. The first implementation CI run is not a passing result.

The existing registered `sandbox-policy` QA scenario now exercises administrator
ceiling saves and subsequent Agent policy traffic, but it has not run here.

Checks use Node 24.22.1, pnpm 11.15.1, Bun 1.4.4 and a disposable PostgreSQL
18.6 database. Application tests use `occ_app`; migration and intentional storage
failure setup use `occ_migrator`. Passing PostgreSQL/HTTP and simulated UI proof
do not establish Kubernetes, OpenShell or model execution.

The broad conformance run completed 3,537 tests: 3,486 passed and 51 failed.
Ten task-related fixture failures were corrected and the affected 220-test run
passed. A further 71 SSH/TLS cases passed with the required local toolchain.
Repository-credential container cases remain unverified in this environment;
their fixtures require fixed executable paths and container prerequisites.
An earlier full `pnpm test` was interrupted after fixture failures and is not a
passing result. Final handoff must retain these limits.

Current owners are the [ceiling reference](../../docs/reference/sandbox-policies.md#installation-ceiling),
[operator guide](../../docs/guides/topics/agent-sandbox-policy.md#manage-installation-network-limits),
and [runtime flow](../../docs/flows/agent-sandbox-policy.md).
Automatic approval review rejected the final shared autoreview launch because it
would send private source and supporting context to the configured Codex review
service without explicit approval for that destination. Approval is requested;
no final shared report exists. The author requested ready-for-review status;
outstanding proof and review still block merge. Main at `f51ca631c` merged
without conflicts. Later, main assigned RFC-0037 to OIDC enrollment claims
and RFC-0038 to operator scratch storage. This proposal and its primary plan
now use RFC-0039. Published history is preserved; migration 0077 is unchanged.

Main later assigned RFC-0039 to shared event contract ownership. The merge of
`8bb72bbb1` renumbers this proposal and its primary plan to RFC-0040. Decision
status remains Proposed; migration 0077 and published history are unchanged.
The merged source passes typecheck, lint, formatting, workspace, OpenAPI and
documentation checks. The owner API and regular Agent PostgreSQL scenarios pass
48/48 with no skips; the ceiling browser suite passes 5/5 with no skips. Hosted
CI for that merge is pending. Main advanced during validation; a subsequent
merge of `919dc42dc` preserves its atomic save-and-apply flow while reading the
persisted ceiling. The combined PostgreSQL owner and Agent suite passes 52/52,
including atomic edit/apply cases, and the ceiling browser suite passes 5/5.
These checks do not close the runtime, media or independent-review gaps above.

No Driver contract or default runtime image changed. Real runtime qualification,
reviewable native media attachments and final CI remain delivery requirements.

## Review follow-up, 2026-11-16

Main at `591cb4463` owns migrations 0077 and 0078. The ceiling migration and
snapshot now use 0079; its SQL bytes are unchanged. Main's migration receipts,
catalogs and restore aliases remain intact. The full logical-restore scenario
passes on PostgreSQL 18.6, including canonical and Provider archives, upgrades
from prefixes 51 and 74–78, and refusal of altered history or grants.

Review requires one startup attempt, with rules, audit and fingerprint committed
on the lease-owning connection; readiness and liveness must reject lost ownership. Admission and
queued application must explicitly use Read Committed, and unrelated lifecycle
operations must avoid the ceiling lock. The owning regressions and current
[flow](../../docs/flows/agent-sandbox-policy.md) track these repairs.

The owner and Agent PostgreSQL suites pass 58/58 without skips. The production
bootstrap/readiness case passes separately on a fresh migrated database,
including lease termination and recovery through recomposition. The affected
API/lifecycle suite passes 271/271 and the ceiling browser suite passes 5/5.
Both provisioning handoff/Stop orderings pass. The native-admin PostgreSQL
deployment/proxy case also passes after explicit fixture initialization; its
pre-fix run failed because the persisted ceiling was missing.
Bounded comparisons against the earlier behavior reproduce stale HTTP admission,
an extra worker attempt under Repeatable Read, a blocked unrelated Stop, startup
writes surviving lease loss, and healthy probes after that loss.

The exploratory merged-source conformance run passed 3,667 of 3,674 tests.
Four credential-fixture cases could not find OpenSSL on their restricted executable
path; three found an older GitHub CLI than their required version. These local
prerequisite failures do not establish a passing suite. Hosted verification,
external review disclosure approval, live runtime qualification and native media
attachments remain required.

## Main refresh, 2026-11-16

Main at `b63f1138a` owns migrations 0079 and 0080. The ceiling migration and
snapshot now use 0081, with unchanged ceiling SQL. The merge preserves main's
predecessor replacement state, revision runtime inputs and historical migration
records. The PostgreSQL catalog and logical restore aliases are measured again
through 0081; the compatibility scenarios include the completed 0080 predecessor.
RFC decision status remains Proposed. The earlier verification records above
refer to their original revisions.

The combined PostgreSQL restore and rollback scenarios pass 44/44, and the
startup/owner and Agent policy suites pass 13/13 and 45/45, all without skips.
The singleton suites use separate fresh databases; an initial parallel run
shared one database and failed during competing fixture bootstrap, before the
owner assertions. Typecheck, formatting, workspace, OpenAPI, CI inventory and
documentation checks pass. Current-head hosted CI is required after publication;
the external review, live runtime and native media requirements remain open.

## Worker refresh, 2026-11-17

The merge of main at `555698eff` retains its stale-provider checks and recovery
after a refused policy write. Queued application still reads the saved ceiling,
holds its shared lock before Namespace/Agent locks and starts with Read Committed.
The repository-credentials fixture uses the actual Installation state and retains
main's caller-supplied shutdown signal. The Agent policy PostgreSQL suite passes
45/45 without skips, and the repository-credentials admission file passes. The
extracted ceiling browser suite passes 5/5 without skips. Typecheck, workspace,
module boundaries, OpenAPI and both CI inventory audits pass. Repeated CLI and
Console descriptions are removed from the merged flow to retain its length limit.
Migration 0081 and RFC decision status remain unchanged. New hosted CI and the
previously recorded external review, runtime and media requirements remain open.

## RFC numbering refresh, 2026-11-17

Main at `974d701e9` assigns RFC-0040 to Agent chat completions. This proposal
and its primary plan now use RFC-0041. The index and old-to-new lookup retain
both owners. Decision status remains Proposed, implementation status remains
Partially implemented, and migration 0081 is unchanged. Published history and
the earlier records above are preserved. Live runtime qualification, native
media attachments and final external review remain incomplete.

On the merged source, the PostgreSQL startup/owner and Agent policy suites pass
13/13 and 45/45; ceiling browser checks pass 5/5, all without skips. The broader
API/startup run passes 175/182, with seven failures before repository certificate
setup: its fixed executable path has no OpenSSL. The available task-local binary
is outside that path. No fixture isolation or system executable is changed to
hide this prerequisite gap. Hosted CI must verify the new head.

## Dynamic ownership review, 2026-11-17

[Review feedback](https://github.com/openclaw/openclaw-enterprise/pull/4920#issuecomment-6960433647)
removes startup overwrite mode. The ceiling has one dynamic owner: its saved
Installation state. Startup seeds absent state once; it never changes existing
rules. Remove management mode, startup fingerprint, replica agreement leases and
their probe coupling. Keep versioned API/Console edits, exact administration,
transactional audit and admission/worker checks. Append a migration to remove
obsolete columns while preserving published migration bytes and receipts.
Update contracts, Console stories, browser/integration proof and current docs.
The generic Guardrails API alignment is a later refactor, explicitly not a merge
blocker. This revision does not record RFC acceptance.

The dynamic-only revision passes PostgreSQL owner 9/9, readiness 1/1 with a
one-connection pool, regular Agent policy 45/45, migration restore/rollback 45/45,
and ceiling browser 5/5, without skips. The retired configuration regression
passes 1/1. Scoped local backend and Console reviews report no actionable defects;
they do not replace final external review. Rebuilt Storybook captures show the
dynamic editor, but native GitHub uploads remain unavailable.

## RFC numbering refresh, 2026-11-17, continued

Main at `2821a6004` assigns RFC-0041 to RuntimeClass-agnostic deployment.
This ceiling proposal and its primary plan now use RFC-0042. The lookup preserves
both proposals and the ceiling's former filenames. Proposed / Partially
implemented status, dynamic-only ownership, migrations 0081–0082 and published
history remain unchanged. Earlier verification records refer to their original
revisions; the merged source needs current-head CI.

Merged-source owner 9/9, readiness 1/1, Agent policy 45/45 and ceiling browser
5/5 checks pass without skips. The platform-state memory contract file passes;
types, formatting, workspace/module boundaries, OpenAPI, CI inventories and
documentation/specification checks pass. No runtime or native attachment gap is
closed by this numbering refresh.

## RFC numbering refresh, 2026-11-18

Main at `d8d985bc5` assigns RFC-0042 to redeployment continuation. The ceiling
proposal and primary plan now use RFC-0043; both proposals and all old ceiling
filenames remain in their owning indexes. The PostgreSQL CI registration keeps
the renamed transaction test, main's parallel Agent policy registration and the
ceiling owner scenario. Decision status, dynamic-only ownership, migrations
0081–0082 and published history remain unchanged. Main now runs migrations through
`scripts/migrate-production.ts`; validation uses that current entry point.

The merged source passes owner 9/9, readiness 1/1, Agent policy 45/45, ceiling
browser 5/5 and migration restore/rollback 45/45 checks, without skips. The
typed bootstrap fixture now uses its prepared environment URL and existing
resolved passive Drivers; its real stored-name API/worker refusal passes 1/1.
Typecheck, lint, formatting, boundaries, OpenAPI, both CI inventories and
documentation checks pass. These checks retain the earlier runtime and media gaps.

## Migration numbering refresh, 2026-11-18

Main at `749ffa37b` owns migration 0081 for restart continuation. Ceiling creation
and dynamic ownership now use 0082 and 0083, with unchanged SQL bytes. Combined
snapshots retain both schemas; PostgreSQL catalog and restore qualification is
repeated. RFC-0043 status and published history remain unchanged.

Main at `4237a824c` subsequently owns 0082 for authentication state. Ceiling
migrations now use 0083–0084 with unchanged SQL; combined snapshots and measured
native/restore catalogs include that schema. Published history and RFC status stay
unchanged.

Main `30fb467c8` subsequently owns RFC-0043 and migration 0083. The ceiling now uses
RFC-0044 and migrations 0084–0085. SQL, published history, Manual Notes and decision
status remain unchanged.

Main `a99a9c852` owns RFC-0044; the ceiling now uses RFC-20261106-installation-network-policy-ceiling under date-and-title naming.

Main `ebcc46a14` owns 0084; ceiling migrations move to 0085–0086 with unchanged SQL.

## Manual Notes

## Changelog

- 2026-11-11: Created the implementation plan against `6bf163866` for PR #4920.
