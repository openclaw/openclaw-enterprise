# OpenClaw Enterprise repository instructions

## Active workspace boundary

Stay within approved implementation milestones: the active TypeScript/pnpm
workspace, selected controller and Drivers, reviewed PostgreSQL persistence, and
production Kubernetes packaging. Do not add platform resources or deployment
behavior outside those milestones.

The development API must bind only to loopback, reject nondevelopment
configuration, admit only explicitly provisioned development identities,
authorize every exact resource operation through the selected IAM Driver, and
emit attributable audit evidence for bootstrap, successful mutations, and
authorization denials.

The authoritative architecture is the repository's
[platform design](docs/design.md).
Read its [implementation status](docs/design.md#implementation-status) before
treating a target-design capability as implemented; verify current code and tests.
Do not create a competing architecture specification in this checkout.

## Repository layout

Follow [Repository layout and conventions](docs/layout.md) before adding or
moving files. Preserve existing ownership and workspace/package boundaries.
Update the guide and navigation when directories, ownership, or placement
conventions change.

## Keep agents in their lane

"Our PRs" and "my PRs" mean PRs authored by the requesting user's GitHub
account unless the user explicitly selects a broader scope. Verify identity
and filter by author before making changes; ask if unclear.

Keep other authors' PRs, branches, and worktrees read-only unless explicitly
assigned. Repository permissions and dependencies do not expand scope.
Subagents inherit these limits.

For new PRs, default to pushing a topic branch to the requesting user's fork
and opening it against `openclaw/openclaw-enterprise`, including when the user
has write access to the upstream repository. Use upstream topic branches when
the user's instructions or an authorized maintainer workflow selects that path.
Maintainers retain their review, merge, and approved bypass permissions.
When assigned to update an existing PR, preserve its head repository and branch.
Follow the [fork workflow](CONTRIBUTING.md#prepare-a-pull-request);
verify repository URLs and ownership rather than assuming `origin` is the fork.
Preserve existing remotes. Keep fork PRs editable by maintainers
as described in the contribution policy.

"Refresh against main" does not authorize force pushes. Preserve published
history by default. Rewrite history only with explicit authorization for the
selected branches, using `--force-with-lease` against a freshly verified head;
never use `--force`.
Before each push, verify the PR author, destination ref, and remote head;
stop on unexpected changes.

Follow the [contribution and review policy](CONTRIBUTING.md#prepare-a-pull-request)
through merge. Core team authors may use their authorized merge bypass for their
own PRs after the applicable review, CI, and specific holds are satisfied. Ask
for human feedback on architectural RFCs early; implementation and RFC revision
can proceed in parallel. Follow the [RFC process](docs/contributing/rfcs.md).
New contributors wait for maintainer feedback.

## Development style

Follow these rules when developing or changing code.

### Build platform capabilities

Every new capability must belong to a platform primitive. Identify its existing
owner, extend that contract when insufficient, or introduce a primitive only
when none fits and the approved architecture and milestones permit it.

Implement the primitive's contract and integrate it with platform lifecycle and
composition. Internal helpers may support this work; a standalone helper or
suitably named class does not establish platform integration.

Deliver capabilities with callers in the regular Agent workflow. Defer
speculative components; test-only callers do not satisfy this requirement.

For example, GitHub App token issuance implemented as a Backend must follow the
[Backend contract](docs/reference/backends.md) and participate in composition.
Token minting and revocation alone are insufficient; see
[PR #136](https://github.com/openclaw/openclaw-enterprise/pull/136).

### Require integration tests; reject low-value tests

**Do not add or run tests for documentation changes, including docs-site
presentation.** Use builds, formatting, link checks, and visual inspection.
**Do not add low-value tests** that restate implementation or duplicate coverage.

**New platform functionality requires integration tests. Omitting them requires an
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

Use [spec](.agents/skills/spec/SKILL.md) to draft or update RFCs and implementation
plans. Its `rfc` and `plan` commands follow the
[specification process](docs/contributing/specifications.md).

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

- Root `README.md` and `docs/README.md` own orientation and navigation.
  `docs/design.md` owns the authoritative architecture, with implemented behavior
  and remaining design work distinguished explicitly. `docs/design/` owns its
  detailed requirements and implementation limits.
- `docs/reference/` owns living specifications for supported features and Driver
  contracts. State development, production, and verification-only limits explicitly;
  do not promote a proposed capability into current reference before implementation.
- `docs/testing/` owns contributor test setup, test-only environment variables,
  fixtures, real-runtime test hooks, and coverage or proof notes. Keep those details
  out of `docs/reference/`; link to the relevant testing page instead. Supported
  configuration and operator verification remain in the feature references and guides.
- `docs/flows/` explains runtime execution through the current source. Link to
  reference for normative behavior and to guides for operator procedures.
- `docs/guides/` owns procedures for product users and operators, including
  people using the console, CLI, or HTTP API. Keep overview pages concise and
  split coherent tasks into named child pages linked from their overview.
- `docs/contributing/` owns onboarding and workflows for people changing the
  platform. Link the root `CONTRIBUTING.md` for contribution policy and the
  relevant reference, flow, or testing page for detailed behavior.
- The site has six menu sections: **Getting Started**, **Topics**, **Integrations**,
  **Operate**, and **Reference** serve people using or administering the product;
  **Contribute** serves people changing the platform. Each menu switches sidebars.
  Register each Markdown page once in `docs/docs.json`; put deep implementation
  and testing pages in the owning tab's `hidden` list when an index links them.
  Hidden pages keep their routes and search entries. Cross-link shared subjects;
  keep existing file paths and heading anchors when changing navigation.
- Use short Title Case sidebar labels and descriptive sentence-case article
  titles. Use nested groups when they clarify the reader's task; give menus a
  useful overview and list prerequisite steps before actions that need them.
- `specs/rfcs/` records architectural proposals and decisions. `specs/plans/`
  holds all implementation plans and historical delivery records. Plans link
  relevant RFCs through `rfc` frontmatter. Completed specifications do not
  override current feature reference.

Keep `docs/design.md` and its chapters about system structure, ownership,
trust boundaries, and major interactions; update them for architectural changes
or corrections to implementation status.
Put feature details, configuration, edge cases, and delivery history in their
owning reference, guide, flow, or spec. Link as needed, without per-PR entries.

Document new components under `docs/` in the same change: purpose, setup,
boundaries, verification, and troubleshooting. Update navigation and affected
adjacent pages.
Do not add migration documentation, migration-specific rollout instructions,
or per-migration database preparation guidance unless explicitly requested.

### Keep reference cheat sheets current

When adding or changing documentation in one of the areas below, check every
affected [Reference cheat sheet](docs/reference/README.md#cheat-sheets) and
update it in the same change if its inventory or short descriptions change.
Link to the owning documentation for detail instead of copying it.

- [API](docs/reference/cheatsheets/api.md): public operations and their summaries.
  Update the owning route or OpenAPI schema, then run `pnpm openapi:generate`
  and `pnpm openapi:check`. Do not edit the generated sheet by hand.
- [Permissions](docs/reference/cheatsheets/permissions.md): IAM actions, resource
  kinds, scopes, and required grants.
- [Database entities](docs/reference/cheatsheets/database-entities.md): PostgreSQL
  tables, their purpose, and columns.
- [Environment variables](docs/reference/cheatsheets/environment-variables.md):
  supported configuration variables; test-only variables stay in `docs/testing/`.

Check the manually maintained sheets against their owning sources and run `pnpm docs:check`.

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

Files named exactly `AGENTS.md`, including nested instruction documents, are
also exempt from the length thresholds. The checker still reports their word
counts. Exemptions follow the resolved file: an `AGENTS.md` symlink pointing to
an ordinary document does not exempt that document.

## Documentation editing

Use [technical-writing](.agents/skills/technical-writing/SKILL.md) when creating,
editing, or reviewing documentation and specifications. It bundles the relevant
writing guidance locally; no personal skill installation is required.
Follow its [page-scope guidance](.agents/skills/technical-writing/SKILL.md#choose-the-smallest-useful-page)
to keep main guides focused and route edge-case diagnostics to troubleshooting.

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

Follow the [specification process](docs/contributing/specifications.md) for
document choice, numbering, status, and preservation. Write architectural RFCs
under `specs/rfcs/` and all implementation plans directly under `specs/plans/`.
Link a relevant RFC through the plan's `rfc` frontmatter field, using a path
relative to the plan file. Preserve RFC-linked and independent task numbering.
Use one Markdown file by default. When companions are needed, use
`<number>-<topic>/index.md` for the main document and keep supporting
files in that folder, without a separate top-level Markdown file.
A larger feature with an RFC needs a separate implementation plan;
an independent plan can build on the existing architecture without a new RFC.
Keep verification in the owning document or its supporting pages, not a separate
reports area. Keep completed and superseded records in place.

RFC entry points require `status` in YAML frontmatter. Companion notes link to
their parent through `rfc` frontmatter instead of duplicating its decision
status. Follow the specification process for historical status uncertainty.

Implementation specifications are point-in-time records. When a later spec
changes or supersedes an implementation described by an earlier spec, document
the change in the later spec and the affected current documentation. Do not
retroactively update the earlier spec to match the later implementation;
preserve its original design decisions and implementation details.

Use stable feature names in `docs/reference/` and preserve grandfathered
specification names and IDs when grouping companions under `index.md`.
This first organization phase preserves `specs/.archive/` content and placement;
only the removed console-image links change to a preserved Git revision. Do not
add new records to it. A behavior-changing implementation PR
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

Use `tests/fixtures/synthetic-credential-url.mjs` to construct synthetic credential-bearing URLs at runtime; do not commit complete credential-bearing URL literals, which TruffleHog treats as secrets.

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

## Browser automation

On a devbox without an X server, run Playwright with `headless: true`.

## Console Storybook

UI changes require reviewable visual evidence, not just passing checks.
When adding or changing console pages, shared components, or Agent lifecycle
controls:

- Update matching stories, scenarios, and workflow instructions in
  `scripts/console-storybook/` in the same change. Cover the changed states,
  including relevant empty, missing-credential, loading, error, and permission
  states. Follow [Console Storybook](docs/contributing/console-storybook.md).
- Rebuild Storybook from the changed source, inspect the affected previews in a
  browser, and walk through the changed controls. A successful build alone is
  not visual verification; stale prepared assets are not proof of the change.
- Capture screenshots of the new or changed UI states and a short video of the
  feature in use. Show the relevant user actions and visible result, not only a
  static screen or terminal output. Keep the walkthrough within the requested
  behavior; do not invent additional acceptance criteria.
- Do not commit PR evidence, including screenshots, recordings, or generated
  evidence reports, to the repository. Keep local captures outside the checkout.
  Upload screenshots and a short video as native GitHub attachments in the
  PR's Verification section. Both are required before merging UI changes.
- Include the screenshots, video, and Storybook story names or links in the task
  conversation. Include the story names or links and uploaded media in the
  PR's Verification section. Embed media where supported; otherwise provide
  direct, reviewer-accessible links with captions. A local path or a claim that
  evidence exists is not a usable PR attachment.
  When no PR exists yet, deliver the evidence in the conversation and carry the
  verification details into the PR when opened.
- Identify the tested revision and environment, what the evidence demonstrates,
  and what remains unverified. Label Storybook fixtures as simulated UI proof;
  they do not establish backend persistence, credential propagation, deployment,
  or real runtime behavior. When end-to-end proof is requested, also exercise
  the real supported workflow and report its actual outcome.
- Check that the media opens and shows the final UI. Refresh evidence after
  material UI changes and exclude credentials, tokens, and private data. If
  recording, upload, or runtime proof is blocked, state the missing evidence and
  blocker in both places; do not claim the requested verification is complete.
  Missing uploads or media that no longer shows the final UI block merging,
  even when CI passes.

## TypeScript style and verification

- Separate imports from following code with a blank line, declare one variable
  per declaration, and use braces for control-flow bodies. Apply these rules with
  `pnpm lint:fix`, then run `pnpm format:fix` for Prettier layout.
- Run `pnpm lint` for JavaScript and TypeScript changes; `pnpm lint:fix` applies
  supported automatic fixes. Follow `eslint.config.mjs` and the
  [linting guide](docs/testing/local.md#linting-and-formatting). Do not expand
  `eslint-suppressions.json` to admit new findings; prune entries as they are fixed.

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
