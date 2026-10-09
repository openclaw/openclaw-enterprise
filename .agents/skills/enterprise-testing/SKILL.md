---
name: enterprise-testing
description: Select proportional Enterprise validation and diagnose exact CI runs, distinguishing product, harness, infrastructure, and credential failures.
---

# Enterprise Testing

Prove the changed contract with the smallest meaningful check, complete required
checks, then stop. Broaden or repeat for new changes, failures, or unresolved
risks. Use [test-audit](../test-audit/SKILL.md) when authoring or reviewing tests;
do not create tests that merely mirror a reversible documentation or style edit.

Read the touched scope's `AGENTS.md` and the selected
[testing guide](../../../docs/testing/README.md). Run commands from the repository
root. Use Node.js 24 or newer and repository-pinned pnpm with matching installed
dependencies. Do not install or reconcile dependencies as a verification side
effect. Report missing prerequisites; dependency-independent checks prove only
their own scope. Never run `npm run precommit`.

## Select proof

| Changed contract                         | Starting proof and owner                                                                                                                                         |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain or Driver behavior                | `node --test tests/conformance/<name>.test.mjs`; broaden to `pnpm test:conformance` when relevant.                                                               |
| API or controller behavior               | `node --test tests/integration/<name>.test.mjs`; broaden to `pnpm test:integration`. See [local checks](../../../docs/testing/local.md).                         |
| PostgreSQL persistence                   | `pnpm test:postgres` after the [database prerequisites](../../../docs/testing/postgresql.md); use the actual database for persisted invariants.                  |
| Docker runtime                           | `pnpm docker:test` with explicit selectors, images, and credentials from [Docker testing](../../../docs/testing/docker.md).                                      |
| Kubernetes                               | Select the exact fixture or runtime file from [Kubernetes testing](../../../docs/testing/kubernetes.md), with its disposable cluster and database prerequisites. |
| Console UI                               | `pnpm test:console-browser` with the prepared browser described in [browser testing](../../../docs/testing/local.md#console-browser-checks).                     |
| Types, package boundaries, generated API | `pnpm typecheck` (also the current build command); `pnpm openapi:check` for API changes.                                                                         |
| Documentation or skills                  | `pnpm docs:check`, relevant links, and `git diff --check`; no runtime tests solely for prose changes.                                                            |
| CI or test selection                     | `node scripts/ci/run-tests.mjs audit`; inspect [CI ownership](../../../docs/testing/ci.md), and use `actionlint` for workflow edits when available.              |

Run `pnpm check:workspace` and applicable `pnpm format:check` with the installed
graph. The root formatter does not include `.agents/skills/**/*.md`; inspect
adapted skill Markdown separately. Keep autoreview implementation and test changes in `openclaw/agent-skills`.
Use the [local checks guide](../../../docs/testing/local.md) for formatting and
generated-artifact procedures. Resolve `<name>` to existing owner/sibling tests;
do not run placeholder commands. When all conformance and integration contracts
need proof, `pnpm test` selects both; browser and credentialed coverage still
depend on their documented selection and prerequisites.

## Real-runtime boundaries

Use only owned disposable resources and authorized credentials. Scope selection
variables to the chosen process; preserve shared dependencies, services,
databases, kubeconfig, and unrelated clusters. Do not run untrusted contributor
tooling against a credentialed local environment; use an approved isolated CI
environment. Setup and credentialed execution need their existing authorization.

Follow [repository integration requirements](../../../AGENTS.md#running-integration-tests)
and each suite's guide for images, model selection, database roles, credential
placement, networking, and cleanup. Do not bypass missing credentials, disable
isolation, or substitute a fake for requested runtime proof. Selected required
cluster/runtime cases must pass without skips. Fixture or in-memory success does
not prove genuine gateway, Codex WebSocket, model execution, or production
deployment. A green PR aggregate does not prove manual credentialed lanes ran.

## Diagnose CI

```sh
gh pr view <pr> --json headRefOid,statusCheckRollup
gh run view <run-id> --json status,conclusion,headSha,url,jobs
gh run view <run-id> --job <job-id> --log
```

Bind evidence to the PR head, actual run SHA, run ID, and job ID. A pull-request
run may test a merge commit: record that relation rather than assuming its SHA
equals the branch head. Inspect the latest attempt for that source; confirm
whether a newer run superseded a cancellation. Fetch relevant leaf logs and
result artifacts, not just the rollup status. Use [CI result accounting and
coverage](../../../docs/testing/ci.md) to interpret selected lanes and skips.

- **Product:** supported behavior fails with valid setup; reproduce narrowly,
  repair the owning implementation, and rerun that proof.
- **Harness:** selection, setup, assertions, or result accounting are wrong;
  repair the harness without weakening required outcomes.
- **Infrastructure:** provisioning, image availability, networking, or capacity
  fails; retain evidence and retry the affected job only when justified.
- **Credentials:** approved credentials, access, or protected-environment approval
  is missing; report the gap without exposing values or substituting mock proof.

Do not infer a category solely from a check name. State uncertainty when logs
are unavailable. Route unrelated failures with evidence instead of expanding
the task; never rerun a broad workflow merely to erase a failure. Report commands,
source/run/job identity, pass/fail/skip counts, proof limits, and remaining blockers.

## Provenance

Adapted from OpenClaw; see [source and intentional adaptations](../../../docs/testing/developer-skills.md#provenance-and-updates).
