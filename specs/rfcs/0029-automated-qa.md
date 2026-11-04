---
status: Proposed
implementation_status: Not implemented
author: kevinlin-openai
---

# Proposal: Automated QA with feature and flow tags

- **ID:** RFC-0029
- **Created:** 2026-11-04
- **Last updated:** 2026-11-04
- **Related:** [Existing CI implementation plan](../plans/19-github-actions-test-coverage/index.md)

## Summary

Organize OpenClaw Enterprise (OCE) verification into **CI**, the required PR
checks, and **QA**, the broader integration tests. Both use one test inventory
with stable identifiers and feature, flow, and trigger tags. Execution groups retain their infrastructure, credentials, and cleanup requirements.

Run required CI and a lightweight QA subset on code PRs, tagged QA hourly on
`main`, and the complete required release selection against each release
candidate. Consolidate Full Integration into QA without removing unique coverage.
Platform contracts are unchanged.

## Motivation and current behavior

The [suite inventory](../../scripts/ci/test-suites.json) contains 44 lanes:
20 in `ci`, 33 in `full`, and 11 outside both. The full group includes all 20 CI
lanes. [QA Advisory](../../.github/workflows/qa-advisory.yml) separately selects
QA matrix, OpenShell, and local installation tests. Its schedule is every six
hours; eligible labeled PRs can request additional coverage.
[Full Integration](../../.github/workflows/full-integration.yml) is manual.

Overlapping selections obscure feature and flow coverage. Current `all` selectors
also have exclusions: [manual lanes](../../docs/testing/manual-tests.md) are
outside Full Integration, and [QA scenario selection](../../tests/helpers/qa-selection.mjs)
omits four explicit scenarios. First Agent Smoke exercises installed lifecycle
behavior but is outside the [CI Required aggregate](../../.github/workflows/ci.yml).

## Goals and scope

- Protect core supported behavior before merge and detect broader regressions
  through regular integration runs.
- Keep PR feedback lightweight, with optional heavier coverage for a change.
- Select tests by product features and flows across CI and QA without duplicating
  test definitions or confusing selection with execution evidence.
- Make release coverage explicit and fail when required proof is missing.

Initial core-flow review covers installation, authentication and authorization,
Agent deployment/chat/stop/start, configuration persistence, Git credential use
and withdrawal, and supported plugin and sandbox behavior. Feature maintainers
must identify the supported configurations and expected success, denial, and
recovery outcomes before assigning required coverage. A tag does not promote an
experimental capability into supported behavior.

A maturity dashboard and complete documentation-to-feature mapping are future
work. This proposal does not authorize new product capabilities or public release.

## Proposed inventory and selection

### Families, groups, and tests

An **integration test** exercises cooperating components through supported
interfaces. Its definition states which dependencies are real or simulated;
fixture success does not prove real model or provider behavior.

| Concept         | Responsibility                                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Family          | `ci` or `qa`; identifies the purpose of the coverage. Integration tests can belong to either.                                         |
| Execution group | Owns shared setup, runner requirements, credentials, isolation, concurrency, and cleanup. Existing lanes provide the starting groups. |
| Test ID         | Stable identity for an independently selectable file or scenario, with its source and assertions.                                     |
| Tags            | Describe product features, user flows, and scheduled membership.                                                                      |
| Run selection   | Resolves an expression into test IDs and applicable configuration cells before execution.                                             |

Extend the existing [suite loader](../../scripts/ci/test-suites.mjs) and
[runner](../../scripts/ci/run-tests.mjs), rather than adding a competing inventory.
A configuration cell identifies an installation type, preset, platform, and provider combination.
A test has one owning definition and group; multiple tags do not create multiple copies. Numbered execution shards need not
become permanent product categories.

Illustrative metadata, not an implemented schema:

```yaml
id: repository.credentials.withdrawal
family: qa
group: installed-agent
tags:
  - feature:git
  - feature:credentials
  - flow:agent-deploy
  - trigger:hourly
  - trigger:release
```

Every product test needs at least one feature and one flow tag. Contributor-tooling
checks may use explicit tooling categories instead of invented product flows.
Maintain a reviewed tag vocabulary with definitions and owners. Add tags as
features expand; reject unknown values and duplicate IDs. Feature maintainers
own mappings; CI maintainers own inventory validation and execution policy.

### Selection contract

Support family filters, exact tag matches, `AND`, `OR`, `NOT`, and parentheses.
Precedence is `NOT`, then `AND`, then `OR`. Examples below describe selection
semantics, not current command syntax:

| Request                          | Expression                                     |
| -------------------------------- | ---------------------------------------------- |
| Git coverage in both families    | `feature:git`                                  |
| Git during OCE setup             | `feature:git AND flow:oce-setup`               |
| Either setup or Agent deployment | `flow:oce-setup OR flow:agent-deploy`          |
| Hourly QA                        | `family=qa AND trigger:hourly`                 |
| Release verification             | `family=ci OR (family=qa AND trigger:release)` |

A read-only selection command must show IDs, source selectors, configuration
cells, group prerequisites, exclusions, and the inventory revision. Local and
hosted execution consume the same resolved selection. Deduplicate overlapping
matches by test ID **and configuration cell**; OpenClaw and Codex cells are not
duplicates. Expand required setup even when a filter does not name it.

Reject malformed expressions, unknown tags, and unexpectedly empty selections
before provisioning. Select only at a granularity the runner supports. If a file
cannot select individual scenarios, register the whole file and report that it
runs in full.

## Triggers and gates

| Invocation                        | Selection                                                                          | Result policy                                                   |
| --------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Code PR and merge queue           | Required CI baseline plus lightweight `family=qa AND trigger:pr` coverage          | Required selection blocks merge.                                |
| Optional PR request or manual run | Explicit feature/flow expression or broader QA selection                           | Additional evidence; cannot replace the required baseline.      |
| Hourly on `main`                  | `family=qa AND trigger:hourly`                                                     | Failure requires triage; this run alone is not a PR merge gate. |
| Release candidate                 | All CI and `family=qa AND trigger:release`, across required release configurations | Failure or missing proof blocks release promotion.              |

Documentation-only changes retain documentation checks. Tags and impact filters
must not silently narrow the required baseline. CI maintainers define the
lightweight QA set using measured duration and core-flow coverage. Prefer real
platform components with simulated provider responses for this set; preserve
live-provider proof in the appropriate QA groups.

Every supported QA test must carry `trigger:release` or a reviewed exclusion
naming its scope, reason, owner, and expiry. `trigger:hourly` implies release
membership. Disabled or unavailable required tests block qualification; they do
not disappear from the result. Experimental/manual coverage must have an explicit
disposition before claiming complete release coverage.

Run the hourly selection once through QA, rather than starting overlapping
QA Advisory and Full Integration runs. Bind it to the selected `main` commit.
Permit one active scheduled run per conflicting resource group; retain cleanup
and coalesce pending requests to the newest commit. Report skipped schedule
slots and coverage age. A cadence change requires measured capacity, not just a
cron edit.

## Trust, artifacts, and failures

Tags grant no permission. Retain group-specific protected environments and
credential boundaries. Untrusted PR code cannot receive provider credentials or
use privileged persistent resources. Required PR coverage must have a path that
works without those credentials. Heavier credentialed PR execution requires a
reviewed source and an approved isolated environment; a label alone is not trust.

The authoritative required selection must not be weakenable by the candidate PR
removing tags or editing its workflow. Bind enforcement to trusted policy and
require explicit review for baseline, inventory, and exclusion changes. The
implementation plan must identify the mechanism before enabling release gates.

Release qualification records the source commit, inventory and workflow revision,
configuration cells, and candidate image digests/chart identity. Artifact tests
exercise the candidate artifacts; promote those same artifacts without rebuilding.
Reuse earlier results only when their relevant source, policy, configuration,
artifact identities, and approved freshness requirements match.

The aggregate compares expected cells with received results. Missing, skipped,
cancelled, or blocked required cells cannot produce success. Record test and
cleanup outcomes separately; uncertain credential disposal prevents qualification
and retains protected recovery state. Remove only run-owned resources.

Report product, harness, infrastructure, and credential failures distinctly.
Feature maintainers triage product failures; CI maintainers triage orchestration
and infrastructure, with credential owners handling access failures. Retry only
under a documented transient-failure policy, retain all attempts, and report
retry-dependent passes. Quarantines require an owner and expiry and remain visible
coverage gaps; quarantine alone cannot waive release requirements.

## Delivery and verification

Create a separate implementation plan after review. No runtime implementation
or new test execution is included in this RFC.

1. Map existing files, scenarios, special jobs, and configuration cells to the
   shared inventory. Include First Agent Smoke, native image checks, and manual
   lanes; preserve their distinct proof and cleanup requirements.
2. Implement selection and audit checks through the existing runner. Verify
   Boolean selection, overlap deduplication, required setup, invalid/empty
   selections, and rejection of missing results and unauthorized credentials.
3. Run old and proposed selections on matched revisions and compare executed
   coverage and outcomes. Consolidate workflows only after accounting for every
   unique test. Measure latency, cost, reliability, and cleanup behavior.
4. Enable required PR QA, hourly scheduling, and release qualification only when
   their prerequisites and capacity targets are met. Update the current test
   guides and release procedures together.

For future maturity reporting, retain the relationship
**feature → documentation/flow → test → configuration → execution result**.
Report implementation status, intended coverage, and recent successful proof
separately. Tag membership alone is not a maturity score.

## Rationale and alternatives

- **Keep current workflows:** least immediate work, but retains overlapping
  inventories and incomplete meanings of `all`.
- **One giant QA suite:** simplifies the entry point but couples credentials,
  failure diagnosis, setup, and resource lifetimes. Shared selection with separate
  execution groups provides consolidation without that coupling.
- **Infer coverage only from changed paths:** useful for optional selection, but
  indirect dependencies and shared infrastructure still require a core baseline.

## Unresolved decisions

- **Feature maintainers:** approve the initial core-flow/configuration matrix and
  disposition of manual or disabled tests. Required release proof cannot be
  silently excluded.
- **CI maintainers:** choose PR latency, hourly completion/coverage-age, concurrency,
  cost, and flake targets from measurements; choose the trusted enforcement
  mechanism. Do not enable a schedule that cannot sustain its target.
- **Release maintainers:** define evidence freshness and the authority for any
  release exception. Exceptions must record missing proof and accepted risk.
