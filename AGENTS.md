# OpenClaw Enterprise repository instructions

## Active workspace boundary

Approved milestones permit the active TypeScript/pnpm workspace, its selected
controller and Driver implementations, reviewed PostgreSQL persistence, and
production Kubernetes packaging described in the current implementation specs.
Do not introduce platform resources or deployment behavior outside those
approved milestones.

The development API must bind only to loopback, reject nondevelopment
configuration, admit only explicitly provisioned development identities,
authorize every exact resource operation through the selected IAM Driver, and
emit attributable audit evidence for bootstrap, successful mutations, and
authorization denials.

Preserve Git history, registered worktrees, ignored local `.env` files, and
existing root or nested `node_modules/` directories.

The authoritative architecture is the repository's
[platform design](docs/design.md).
Read its [implementation status](docs/design.md#implementation-status) before
treating a target-design capability as implemented; verify current code and tests.
Do not create a competing architecture specification in this checkout.

## Development style

Follow these rules when developing or changing code.

### Build platform capabilities

We are developing a platform. Every new capability must belong to a platform
primitive, rather than exist as a one-off implementation. First identify the
existing primitive that owns the capability. Extend that primitive when its
contract is insufficient, or introduce a new primitive when none fits, within
the approved architecture and milestone scope.

Implement the owning primitive's contract and connect the capability to its
platform lifecycle and composition. A standalone helper or a class named after
a primitive does not establish that integration. Internal helpers may support
the implementation, but must not substitute for the platform capability.

In general, do not add a capability without a caller in the regular Agent
workflow. Deliver the capability with that caller; defer speculative components
until a real workflow needs them. A test-only caller does not satisfy this rule.

For example, GitHub App token issuance should belong to an appropriate platform
primitive. If implemented as a Provider, it must conform to the
[Provider contract](docs/reference/providers.md) and participate in Provider
composition; exposing only token minting and revocation methods is insufficient.
This is the design concern illustrated by
[PR #136](https://github.com/openclaw/openclaw-enterprise/pull/136).

### Require integration tests; reject low-value tests

**Do not add low-value tests.** We place low value on unit tests in general.
Prefer tests that prove new functionality works through real platform boundaries
and produces observable results.

**New functionality requires integration tests. Omitting them requires an
explicit human override.** Record the approved scope and reason in the PR.
Missing infrastructure, passing unit tests, or an agent's judgment cannot grant
that override.

Integration tests must exercise the supported implementation path and relevant
dependencies, including consequential failure behavior. Extend an existing
end-to-end integration test for the regular Agent workflow to exercise the new
capability through its real caller. If no existing test covers that workflow,
add one at the workflow boundary. Direct calls to an otherwise unused component
do not prove workflow integration. Mocks that replace the
behavior being proved do not satisfy this requirement. Follow the repository's
[testing skills](#developer-skills) for test selection and proof.

Avoid tests that merely restate implementation details, assert mock behavior,
check framework guarantees, or duplicate existing coverage without protecting
an additional behavior. Add a unit test only when it protects a meaningful
behavior economically; it does not replace required integration coverage.

### Export public modules through a top-level index

**Do not use `package.json` to export random modules.** Prefer explicit, curated
exports from the package's top-level `index.ts`. Keep implementation files
separate and expose their intended public API through that entry point.

Use `export type` for public types. Keep helpers private unless consumers need
them. The package export map should route consumers to the public entry point,
not mirror internal files with ad hoc subpath exports. Any separate entry point
must represent a deliberate platform or runtime boundary, not a shortcut for
accessing an internal module.

## Developer skills

Use [local-dev](.agents/skills/local-dev/SKILL.md) for repository development
changes. It requires creating or updating a source-backed flow doc for non-trivial
runtime changes and defines when trivial maintenance needs no new flow doc.
Update the existing behavior owner under `docs/flows/` whenever possible.

Use [test-audit](.agents/skills/test-audit/SKILL.md) when authoring or reviewing
tests, and [enterprise-testing](.agents/skills/enterprise-testing/SKILL.md) to
select proof or diagnose CI. For requested diff cleanup, use
[deslop](.agents/skills/deslop/SKILL.md) before independent review.

Use [mermaid-diagrams](.agents/skills/mermaid-diagrams/SKILL.md) when a diagram
clarifies a change, architecture, lifecycle, or dependency in documentation or a
PR. It provides a shared template and distinguishes implemented from pending paths.

When the user or owning workflow requests an independent code review, use
[autoreview](.agents/skills/autoreview/SKILL.md). Follow the
[Enterprise review guide](docs/testing/autoreview.md) for usage and upstream sync.
Keep the vendored skill unchanged; shared fixes belong in `openclaw/agent-skills`.
See [Developer skills](docs/testing/developer-skills.md) for provenance and updates.

## Product terminology

- **OCE** means **OpenClaw Enterprise**, the product.
- **OCC** means **OpenClaw Control Plane**, its control plane.

Use these expansions consistently in documentation and interface labels.

## User-facing documentation

Use the [documentation map](docs/README.md) and keep these ownership boundaries:

- Root `README.md`, `docs/README.md`, `docs/design.md`, and `docs/ARCHITECTURE.md`
  own orientation, navigation, authoritative target design, and current architecture.
- `docs/reference/` owns living specifications for supported features and Driver
  contracts. State development, production, and verification-only limits explicitly;
  do not promote a proposed capability into current reference before implementation.
- `docs/testing/` owns contributor test setup, test-only environment variables,
  fixtures, real-runtime test hooks, and coverage or proof notes. Keep those details
  out of `docs/reference/`; link to the relevant testing page instead. Supported
  configuration and operator verification remain in the feature references and guides.
- `docs/flows/` explains runtime execution through the current source. Link to
  reference for normative behavior and to guides for operator procedures.
- `docs/guides/` owns operator procedures. Keep overview pages concise and
  split coherent tasks into named child pages linked from their overview.
- Top-level `specs/` records implementation proposals, milestones, and delivery
  history. Completed specifications do not override current feature reference.

Keep `docs/design.md` and `docs/ARCHITECTURE.md` focused on system-level
structure, ownership, trust boundaries, and major interactions. Update them only
when a change alters that architectural understanding. Put feature details,
configuration, edge cases, and delivery history in their owning reference, guide,
flow, or specification. Add a concise link when needed; do not append an entry
for every feature or PR.

Document new components under `docs/` in the same change: purpose, setup,
boundaries, verification, and troubleshooting. Update navigation and affected
adjacent pages.
Do not add migration documentation, migration-specific rollout instructions,
or per-migration database preparation guidance unless explicitly requested.

## Documentation length budget

Review pages above **1,500 visible words** for repetition and scope. Pages of
1,500–2,500 words may stay together when they cover one complete workflow or
coherent reference topic; record that rationale in the change review. **2,500
words is the hard limit.** These are thresholds, not writing targets: overview
pages often need only 150–300 words.

Count headings, tables, lists, and examples; exclude Markdown syntax, link
destinations, frontmatter, and comments. Run `pnpm docs:check-length` before
publishing. It reports pages needing review and fails above the hard limit
across repository Markdown, including instructions, specs, and generated pages.

Remove repetition before splitting. Keep required inputs, commands, expected
results, consequential limits, and recovery together. Split only independently
useful topics; repair navigation and incoming links. Change generated references
through their generator. Preserve historical decisions, statuses, and Manual Notes.

Exceeding 2,500 words requires **no logical destination for the excess content**
and **explicit human approval**. Record the approved scope and reason before
adding a narrow checker allowance.

Approved exception: `docs/reference/api.md` may exceed the length thresholds.
The user approved keeping the complete generated HTTP API reference in one page
for browsing and search. Keep it generated from the OpenAPI contract; the checker
reports its word count without requiring a split. This exception covers no other
page.

## Documentation editing

Use [technical-writing](.agents/skills/technical-writing/SKILL.md) when creating,
editing, or reviewing documentation and specifications. It bundles the relevant
writing guidance locally; no personal skill installation is required.

- Give each fact one owning page: concepts define terms, references define
  behavior, guides give procedures, and flows explain implementation. Other pages
  link to that owner and state only the consequence relevant to their reader.
- Lead with the reader's task and first useful action. Prefer a command and its
  expected result over narration of the helper's internal steps.
- Remove repeated background, feature inventories, and implementation details
  from overview and task pages. Link existing detail instead of creating more pages.
- Keep permissions, credential handling, destructive effects, concurrency limits,
  and recovery beside the affected action. Consolidate repeated caveats without
  removing their scope or force.
- Verify current behavior before tightening prose. Update stale current claims;
  do not rewrite historical specifications to match later implementation.

## Deferred implementation

Add a concise `TODO` immediately beside code that exists temporarily because a
feature is unimplemented or work is deferred. Explain what is missing and name
the milestone, capability, or removal condition that will replace it. Remove
the comment when that work is implemented. Do not label permanent security
boundaries or intentional architecture as temporary.

## Implementation specifications

Write implementation and milestone specifications under `specs/`, following the
authoritative platform design.

Implementation specifications are point-in-time records. When a later spec
changes or supersedes an implementation described by an earlier spec, document
the change in the later spec and the affected current documentation. Do not
retroactively update the earlier spec to match the later implementation;
preserve its original design decisions and implementation details.

Use stable feature names in `docs/reference/` and retain existing numbered
implementation-spec paths under `specs/`. A behavior-changing implementation PR
updates its affected reference, guides, and flows together. Record completion
and the owning current reference when a specification ships.
Keep Manual Notes unchanged. Link maintenance after document moves is permitted
outside preserved sections; do not treat recorded spec statuses as release evidence.

## Production and compatibility boundary

This platform has no production consumers yet. Use one canonical current-state
implementation; do not preserve older development helpers, persisted formats,
fixture shapes, migration shims, or silent fallbacks solely for backward
compatibility. Fail explicitly on unsupported state instead.

## Validation boundary

Prefer enforcing persisted-data invariants in database constraints. Do not
repeat database-enforced validation in application logic; an in-memory storage
adapter may mirror a constraint when it substitutes for the database.

## Test integrity

Tests must verify real, supported application behavior. A test that merely
confirms behavior invented by its own mock, monkeypatch, fixture, or hand-written
adapter is invalid and must be rewritten or deleted.

- Use actual API routes, request methods, server-owned resource scope, response
  envelopes, authorization rules, and lifecycle transitions. Never invent
  endpoints, caller-selected singleton Installation IDs, nonexistent response
  shapes, or resource states the production system cannot reach.
- Assert observable outcomes from the real component under test. Do not patch a
  method and assert its patched return value, inspect hand-written SQL strings
  instead of executing persistence behavior, or recreate application logic in a
  fixture and present the fixture's decisions as product verification.
- Seed only realistic ownership and lifecycle states. A ready tenant with
  admitted revisions is not a provisioning tenant; test fixtures must preserve
  the same invariants and boundaries as the application.
- State exactly what an integration test exercises. A lightweight HTTP adapter
  is not the production Fastify app; a manually aborted signal is not a lost
  database lease; a mocked Kubernetes client is not live SDK or cluster proof.
- When required dependencies, credentials, or infrastructure are unavailable,
  skip the affected integration explicitly or report the verification gap.
  Never replace missing infrastructure with a self-fulfilling fake and claim
  the original integration passed.
- When a test outcome is not obvious, add a concise comment explaining the
  expected behavior, business invariant, or security boundary.
- In integration tests, add concise comments before non-obvious setup,
  verification, or state transitions to explain the scenario being simulated,
  the outcome being proved, and its business or security significance. Explain
  intent and invariants; do not narrate obvious syntax.

## Running integration tests

Run all integration tests with `pnpm test:integration`, or target one case with
`node --test tests/integration/<name>.test.mjs`. Real-runtime coverage uses the
Docker Compose or Kubernetes integrations with explicitly selected runtime
images and existing authorized model credentials. Follow the
[testing guide](docs/testing/README.md) and
[test environment settings](docs/testing/docker.md#docker-compose-development-test-environment)
for each selected suite. Never substitute a fake runtime or skip a requested
runtime integration.

For PostgreSQL integration, follow the [database setup](docs/testing/postgresql.md).
Migrate with the migrator role and run the application with its less-privileged
role. Production bootstrap requires a separately migrated, disposable database
without an Installation; omitting its URL skips only that proof.

For Kubernetes integration, follow the [cluster setup](docs/testing/kubernetes.md).
Explicitly select a disposable loopback k3d cluster with enforcing
NetworkPolicies. Preserve the default kubeconfig, active context, and unrelated
clusters. API-and-worker tests require a dedicated `openclaw_k8s_*` database,
created by the administrator, migrated by the migrator, and used by the limited
application role. All three real-cluster fixture cases must pass without skips.
Missing fixtures, permissions, networking enforcement, or an explicitly requested
cluster must fail; never substitute a fake. Remove only the disposable cluster.

Fixture coverage proves API, RBAC, workload, reconciliation, and NetworkPolicy
behavior, not genuine gateway, Codex WebSocket, or model execution. For those
outcomes follow the [real-runtime procedures](docs/testing/kubernetes.md#kubernetes-model-turns-and-secrets):
use approved digest-pinned gateway/Codex images, import local tags into k3d, and
register their immutable references inside k3s. Select an authorized model and
provide existing credentials without printing them. Preserve exact Agent-owned
transport/model Secrets, projected workload identity, bounded Pod-local writable
state, and default-deny networking. Model credentials belong only in the embedded
OpenClaw Pod or dedicated Codex Pod, never a separate gateway, controller,
fixture, log, or shell history. Missing Agent-owned credentials fail closed.
Dedicated native configuration must register only its selected `codex/<model>`
under `models.providers.codex`, with `api: "openai-responses"` and a fail-closed
`baseUrl: "http://127.0.0.1:9"`; authenticated WebSocket execution remains in
the Codex Agent, which alone receives the model credential.

Routing, Slack, and OTLP proofs have separate prerequisites. Follow the
[Slack guide](docs/testing/slack.md#slack) before running a case that posts real
messages. Genuine production proof additionally requires Helm-installed controller
and PostgreSQL, tenant-local RoleBindings, model turns before and after revision
cutover, and allowed/denied NetworkPolicy checks. Configure API egress for its
actual translated `/32` endpoint and port. The fixture suite's scoped RBAC does
not verify shared-cluster admission guardrails.

## TypeScript style and verification

- Use `ts-pattern` for tagged unions and branches that would otherwise become
  nested ternaries. Prefer `match(value).with(...).exhaustive()` so every case
  is explicit and checked by TypeScript.
- Keep ordinary two-way conditions as a simple ternary or `if`; do not wrap
  them in `match` just to use the library.
- Format active workspace changes with `pnpm format:fix` and verify them with
  `pnpm format:check` when an installed dependency graph matches the current
  manifests. These checks include authored `docs/**/*.md`; the generated
  `docs/reference/api.md` is excluded and verified by `pnpm openapi:check`.
  Never reconcile or install dependencies as a side effect of agent
  verification; use dependency-independent Node tests if manifests changed.
- Check root workspace isolation with `pnpm check:workspace`.
- Never run `npm run precommit`.
