---
rfc: ../rfcs/0037-installation-network-policy-ceiling.md
---

# Implementation plan: Manage the Installation network policy ceiling

- **ID:** RFC-0037
- **Delivery status:** In progress
- **Owner:** russellb
- **Authority:** [RFC-0037](../rfcs/0037-installation-network-policy-ceiling.md)
- **Source baseline:** `6bf16386658e8b1f81a7f90a04ccd0697c23805c`

## Outcome and scope

Implement the submitted RFC in PR #4920. Administrators manage the Installation
ceiling in Settings. PostgreSQL owns the effective rules; startup seeds them once
or explicitly replaces them in startup-managed mode. Every Agent policy admission
and pending application uses the saved ceiling. Running access is unchanged.

## Global Constraints

- Preserve exact Installation `administer` authorization, attributable audit,
  transactional writes, explicit empty state, and fail-closed reads.
- Reuse existing grant validation and Sandbox Driver contracts. No Driver contract
  changes, automatic revocation, process-local fallback, or general settings store.
- Preserve the PR branch, published history, Proposed decision status, and human-only merge.
- New behavior requires PostgreSQL and regular Agent workflow integration proof;
  simulated UI proof does not establish runtime enforcement.

## Contract and source touchpoints

Add a ceiling record owned by the Installation persistence repository. Its public
shape is `{ installationId, version, rules, managementMode, updatedAt, updatedBy }`;
managementMode is `console` or `startup`. GET and PUT at
`/installation/sandbox-network-policy-ceiling` use the standard data envelope.
PUT takes `{ expectedVersion, rules }`. POST at the same path plus `/validate`
previews that input through the shared server validator and returns a
`ConfigurationResult<{ rules }>` in the data envelope without writes. It checks
the same Installation authority, current mode and version. Preview success grants
no authority to PUT. Agent policy reads expose only rules.

The ceiling lock precedes Namespace and Agent locks in admission and worker
application transactions. Shared admission locks permit unrelated Agents to
proceed; updates and startup replacement use an exclusive lock. Initialization
holds the same lock even when the record is absent. Startup must finish before
HTTP admission; workers require an existing record and never seed it. API replicas
must agree on management mode and startup-managed rules. A dedicated PostgreSQL
session lease rejects conflicting live settings; mode or startup-rule changes
require stopping old API replicas. Console seeds do not hold runtime authority.
The API reserves one pool connection, so its pool maximum must be at least two.

## Implementation

### Task 1: Persistence, startup, API and real callers

Extend contracts, Installation state repositories, PostgreSQL schema and migration,
controller composition, HTTP schemas/handlers, all policy admission callers, and
worker rechecks. Add startup overwrite validation and attributable transactional
audit. Extend existing PostgreSQL Agent policy workflows and add focused TypeScript
integration coverage for persistence, restart, stale saves, mode changes, denials,
rollback, concurrency and absent state. Register new tests in their actual CI lane.

### Task 2: Console Settings and UI evidence

Use the existing rule editor and shared browser components for the administrator
Settings section. Cover loading, empty, invalid, forbidden, read-only startup mode,
conflict reload, uncertain-save recovery, successful saves, and permission loss.
Preserve drafts on failure and require review before saving reductions. Add matching
Storybook scenarios and workflow instructions. Rebuild, inspect controls, and
capture before/after screenshots and a paced interaction video outside the checkout.
Upload native GitHub attachments and identify simulated proof accurately.

### Task 3: Current documentation and verification

Update the network policy reference, operator guide, owning runtime flow, affected
cheat sheets and navigation. Generate API references from route schemas. Update
RFC implementation status from actual delivery evidence and link this plan.
Run applicable formatting, lint, types, workspace, OpenAPI and docs checks plus
PostgreSQL and regular Agent workflow integrations. Run Fedora/Podman/k3d/OpenShell
qualification when the selected host and authorized credentials are available.
Complete independent review and address findings before pushing the final PR head.

## Review Focus

- Empty persisted rules must survive a different seed and a restart.
- Startup mode changes and concurrent saves must invalidate stale editor versions.
- Ceiling tightening must reject later admission and pending work without changing running access.
- A failed audit commit must roll back the setting; missing state must not use a local seed.
- A lost save response must be recovered by reading present state without automatic retry.

## Verification

| Outcome                     | Required proof                                                                               | Result or remaining proof                                                                      |
| --------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Durable ownership and audit | Real Fastify, Native IAM and PostgreSQL, including startup lease loss and session revocation | Owner suite 11/11 passed, no skips                                                             |
| Agent workflow              | Real controller/worker queues and PostgreSQL admission/concurrency                           | Agent policy suite 37/37 passed, no skips                                                      |
| Console behavior            | Real Console, Fastify and IAM with in-memory state                                           | Combined browser suite 15/15 passed; status correction 5/5 passed                              |
| Visual behavior             | Rebuilt Storybook, desktop/phone controls, screenshots and paced video                       | Desktop/phone captures and a 21-second walkthrough inspected; native GitHub uploads pending    |
| Runtime enforcement         | Selected Fedora VM, Podman, k3d and OpenShell                                                | VM started but waits for manual disk unlock; no runtime proof claimed                          |
| Repository contracts        | Format, lint, types, workspace, OpenAPI and docs checks                                      | Lint, types, formatting, workspace, OpenAPI, docs checks/build and flow render passed          |
| Independent review          | Task gates and full shared autoreview                                                        | Both task gates pass; authority and draft-status regressions fixed; full shared review pending |

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
The inspected UI revision is `402abe0e9`; desktop is 1440 × 1050 and phone is
390 × 844. The saved WebM opens and plays at normal speed for 21 seconds.
Storybook is simulated UI proof; native attachments remain a merge requirement.

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
No Driver contract or default runtime image changed. Real runtime qualification,
reviewable native media attachments and final CI remain delivery requirements.

## Manual Notes

## Changelog

- 2026-11-11: Created the implementation plan against `6bf163866` for PR #4920.
