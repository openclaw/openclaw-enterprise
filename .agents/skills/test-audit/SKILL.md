---
name: test-audit
description: Gate new or changed Enterprise tests and audit existing tests for observable behavior, credible regressions, duplicate coverage, and test-only production seams.
---

# Test Audit

Use the authoring gate when writing or changing tests. For a requested audit,
inspect the selected scope before proposing edits; keep each batch coherent.
Read [repository test integrity rules](../../../AGENTS.md#test-integrity) first.

## Authoring gate

Before adding a test, answer all four questions:

1. What observable behavior, invariant, or independent contract does it protect?
2. What credible regression makes it fail?
3. Why does existing coverage not already catch that failure? Prefer extending
   an existing case or fixture over duplicating the same proof.
4. Does it need an export, flag, wrapper, or injection hook that no production
   caller needs? If so, test at the real owning boundary instead.

A missing answer means the test is not ready. Demonstrate that a bug regression
test fails on the pre-fix implementation for the intended reason and passes with
the repair. If that comparison cannot run, report the gap rather than claiming
the regression was proved. Do not replace real behavior with a self-fulfilling
mock or copy application logic into a fixture.

## Audit and retention

Read the complete candidate test, production owner, callers, overlapping tests,
relevant history, and [CI selection](../../../docs/testing/ci.md). Inspect the
dependency contract when the test claims dependency-backed behavior.

Look for assertion-free probes, self-comparisons, source-string assertions,
copied inventories, duplicate contract invocations, private call-shape assertions,
and exports or wrappers retained only for tests. These are candidates, not
automatic deletions. A test that fails after behavior-preserving refactoring
may need to move to a stable boundary.

Retain independent API, Driver, storage, security, configuration, protocol,
packaging, generated-artifact, or architecture contract checks. Observable call
ordering and credible regressions remain valuable. Static or slow tests are not
low-value merely because of their form; source inspection can be an independent
guard, but checking a SQL string does not prove database behavior.

Before deleting or rewriting a candidate, record:

- Exact test name and path, and the failure it can detect.
- Non-test callers of any covered production seam.
- Stronger remaining proof, or why the behavior no longer needs coverage.
- Relevant history, intended simplification, risk, and focused validation command.

Keep uncertain candidates and explain why. Within the authorized audit scope,
remove confirmed obsolete test-only seams with their tests; do not preserve
aliases or add new production seams to replace them. Optimize confidence rather
than deletion counts. Report potential product changes separately.

## Validate and hand off

Use [enterprise-testing](../enterprise-testing/SKILL.md) to choose the smallest
real proof. Run commands from the repository root, for example:

```sh
node --test tests/conformance/contracts.test.mjs
node --test tests/integration/console-api.test.mjs
git diff --check
```

Select actual owner/sibling files for the change; the examples are not mandatory
targets. Use `pnpm test:conformance` or `pnpm test:integration` when broader
contracts warrant them. Persistence and runtime claims require the existing
[PostgreSQL](../../../docs/testing/postgresql.md),
[Docker](../../../docs/testing/docker.md), or
[Kubernetes](../../../docs/testing/kubernetes.md) procedures. Do not edit inputs
while tests run. Retain integration-test comments that explain intent and invariants.

After audit edits, use [deslop](../deslop/SKILL.md) for behavior-neutral cleanup
before requested [autoreview](../autoreview/SKILL.md). Report changed candidates,
retained false positives, production versus test changes, exact proof and skips,
and unresolved gaps. Follow [contribution rules](../../../CONTRIBUTING.md) for
authorized commits and PRs; an audit does not authorize a merge or another workstream.

## Provenance

Adapted from OpenClaw; see [source and intentional adaptations](../../../docs/testing/developer-skills.md#provenance-and-updates).
