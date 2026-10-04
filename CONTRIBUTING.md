# Contributing to OpenClaw Enterprise

Do not post unpatched vulnerabilities, exploits, credentials, or tenant data in
issues, pull requests, or paste sites. Report suspected vulnerabilities privately to
[security@openclaw.ai](mailto:security@openclaw.ai), identifying OpenClaw Enterprise.

For a practical introduction, use [Contribute](docs/contributing/README.md)
and [Make your first platform change](docs/contributing/first-change.md). For
documentation changes, start with the [writing guide](docs/contributing/documentation.md).
This page owns the contribution and review policy.

## Before changing code

Read [AGENTS.md](AGENTS.md) for repository boundaries and verification rules.
The [platform design](docs/design.md) owns architecture; the
[documentation map](docs/README.md) identifies current references and procedures.
Check open issues and pull requests before starting overlapping work. For an
architectural change that the team needs to understand, open an
[RFC](docs/contributing/rfcs.md) early and request human feedback. Implementation
can proceed while the RFC is reviewed and revised. Changes outside approved
milestones still need a decision from the responsible maintainers.

Use [RFCs and implementation plans](docs/contributing/specifications.md) to
choose the document, number it, and track delivery. Larger features with an RFC
need an implementation plan; standalone plans can build on existing architecture.

Use a focused branch or worktree. Preserve other contributors' changes, local
configuration, dependency trees, and running services. Never use a shared or
production database, cluster, or credential for tests without explicit approval.

## Set up a development checkout

Use Node.js 24 or newer, the exact pnpm version in [`package.json`](package.json),
and the Go version selected by [`go.mod`](go.mod). In a trusted checkout,
explicitly prepare dependencies with:

```sh
pnpm install --frozen-lockfile
```

Installation runs the repository's `prepare` script, which installs the managed
pre-push hook in the shared Git hooks directory. It refuses to replace an
unmanaged hook and does not override `core.hooksPath`. Preserve existing hook
configuration; run the checks directly when a custom hook path bypasses the
managed hook.

Dependency installation is setup, not an implicit verification step. Do not
reconcile dependencies in a shared checkout or worktree while another job uses
them. If the installed graph does not match the manifests, report the gap or
use dependency-independent checks rather than installing as an agent side effect.

For a running local platform, follow [Local Setup](docs/guides/quickstart.md).
It uses Kubernetes; see the [contributor profile](docs/guides/deploy/local-kubernetes-development.md)
for development commands and teardown. The separate Docker/Podman control-plane
preview cannot deploy Agents. Source-only checks do not need a running platform.

### Dependency release waiting period

The root and independent docs package require registry releases to be at least
seven days old (`minimumReleaseAge: 10080` minutes). The pinned pnpm checks direct,
transitive, and frozen-lockfile dependencies and rejects missing publication dates.
If installation rejects a release, wait until it matures or select a compatible
older version. This policy applies to pnpm registry installs; Git/local dependencies
and separate npm-based image builds are outside its scope.

## Validate the change

With matching dependencies installed and infrastructure selectors unset:

```sh
pnpm check:workspace
pnpm lint
pnpm format:check
pnpm typecheck
pnpm cli:check
pnpm cli:test
pnpm openapi:check
pnpm test:conformance
pnpm test:integration
```

Use `pnpm format:fix` to format active workspace changes, then inspect the diff
for unrelated formatting. `typecheck` and `build` currently invoke the same
TypeScript build. Do not run `npm run precommit`.

For documentation changes, including docs-site presentation, use formatting,
the [docs build and link checks](docs/contributing/documentation.md#preview-and-check),
and visual inspection; do not add or run tests for those changes.

Choose focused tests and infrastructure setup from [Testing](docs/testing/README.md).
`pnpm test:console-browser` runs the separate browser suite with an explicitly
prepared browser. PostgreSQL, Docker, Kubernetes, and model-backed suites need
their documented disposable resources and, where applicable, authorized
credentials. Scope infrastructure variables to the selected test process.

A green test command with skipped cases does not prove those integrations ran.
Record exact commands, failures, skips, and unavailable prerequisites. Fixture
and in-memory tests do not establish production deployment or real model behavior.
Regression tests must exercise supported behavior and fail for the original
defect, not merely restate mocks.

## Prepare a pull request

Use the [developer skills](docs/testing/developer-skills.md) for test quality,
proof selection, diff cleanup, and requested independent review.

- Keep one coherent change per PR. Stack only when a dependency is real, and
  link the prerequisite PR and intended base.
- Explain the problem, behavior change, evidence, and remaining risks. Link
  related issues; use a closing reference only when the change resolves one.
- Update affected feature references, guides, and flows with behavior changes.
  Preserve historical implementation specifications and their Manual Notes.
- Request relevant maintainers' feedback. Resolve substantive findings and
  required checks before merging.
- Before merging Console UI changes, upload screenshots and a short video of
  the final UI as native GitHub attachments in the PR's Verification section.
  Missing or stale media blocks merging even when CI passes. Follow the
  [Console evidence requirements](AGENTS.md#console-storybook) for capture,
  review, and reporting.
- Inspect the entire diff and attachments for credentials, tenant data, private
  hostnames, and personal paths. Use synthetic fixtures and redacted evidence.

Open a draft while implementation or proof is incomplete, then mark it ready for
review. New contributors wait for maintainer feedback before merging. Once a
contributor's last push is 48 hours old, a maintainer may merge `main` into
their branch and fix failing checks, with a comment for each push. Core team
members are expected to carry their own changes through merge. When the PR
author and authenticated account match, an authorized maintainer may use their
merge bypass if the review rule otherwise prevents self-merging. They must still
check the final head, independent review, required CI, review conversations, and
any specific holds; record the reason for the bypass. Do not bypass an
unresolved finding or claim a missing review succeeded.

An RFC is needed for architectural changes that the team needs to understand,
not for ordinary bug fixes, small features, or polish. Request human review early,
but do not wait to write or revise the implementation. Keep the RFC consistent
with the final code and land them together when ready, either in one PR or as
linked PRs merged in dependency order. Core team members do not wait for an RFC
response unless a specific decision or hold requires it.

Use `node scripts/pr-status.mjs PR_NUMBER` to inspect a PR before the final
checks. The command is read-only; it does not establish merge readiness. After
the applicable checks and review, set `PR_NUMBER` and `HEAD_SHA` to the observed
PR number and final head, then merge from this checkout:

```sh
gh pr merge "$PR_NUMBER" --merge --match-head-commit "$HEAD_SHA"
```

If the review rule prevents an authorized core team author from merging their
own PR, use the same command with `--admin` after checking the conditions above.
If the result is uncertain, inspect the PR before trying anything else; do not
repeat an uncertain merge. Verify the merged commit and `main` after success.

Repository access and a green check do not authorize a release, deployment, or
settings change. Keep the existing [MIT license](LICENSE) and third-party
attribution intact.

## Recognize contributors

Preserve original commit authors when preparing someone else's change. When
transplanting or jointly authoring work, add a verified human `Co-authored-by`
trailer where needed. Credit material review, documentation, and other non-code
help in the PR description. Credit follows the work; running the merge does not
make someone its author. Recognition does not grant repository permissions.

Before a release, or when correcting an omission, refresh the README wall from
the repository root with Node.js 24 or newer and an authenticated GitHub CLI:

```sh
pnpm contributors:update
```

You can also run `node scripts/update-contributors.mjs` directly; the generator
uses only Node built-ins and does not require installing npm packages.

The command needs only read access to repository metadata, contributors, pull
requests, and public user profiles. Existing `gh` authentication is sufficient;
no administrator access or GitHub App is needed. It prints the observed default
branch SHA and writes only the README contributor block. Review the diff and
submit it through the normal PR process. Refreshes are manual.

The wall combines GitHub contributors and authors of PRs merged into the default
branch, deduplicates by account ID, and sorts by current login. Documentation
contributors and default avatars are included. GitHub bot accounts are omitted.
The contributor API can lag, and co-authors or people helping outside merged PRs
may need explicit inclusion. Merged PRs whose author is unavailable are skipped;
previously published credit still requires an explicit correction before removal.

Use [scripts/contributors.json](scripts/contributors.json) for corrections. Keys
are numeric GitHub account IDs, which survive login changes. Each entry requires
an HTTPS `url` pointing to public evidence and a nonempty `reason`, plus one of:

- `include: true` to credit a missing contributor.
- `displayName` to change an included person's avatar alt text. Combine it with
  `include: true` when that person is absent from automatic discovery.
- `exclude: true` for a service account or requested opt-out.

Find the ID with `gh api users/LOGIN --jq .id`. Do not copy upstream's contributor
list or store private email addresses. Never set both `include` and `exclude`.
For an opt-out without a public request, link the correction PR and keep private
correspondence out of the repository.

Collection and validation finish before the README is written. If authentication,
rate limits, or connectivity fail, fix access or wait and rerun. If an account is
missing or deleted, inspect its previous credit and add an evidence-backed
inclusion or exclusion; the generator refuses to silently remove it. Correct
malformed JSON and duplicate or missing README markers before retrying. If the
default branch or README changes during collection, rerun against the new state.
