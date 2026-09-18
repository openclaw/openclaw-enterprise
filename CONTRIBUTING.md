# Contributing to OpenClaw Enterprise

Keep contributions in this private repository. Do not copy source, logs, test
artifacts, or implementation details into public issues, forks, or paste sites.
Report suspected vulnerabilities privately to
[security@openclaw.ai](mailto:security@openclaw.ai), identifying OpenClaw Enterprise.

## Before changing code

Read [AGENTS.md](AGENTS.md) for repository boundaries and verification rules.
The [platform design](docs/design.md) owns architecture; the
[documentation map](docs/README.md) identifies current references and procedures.
Check open issues and pull requests before starting overlapping work. Discuss
new capabilities and changes outside approved milestones with maintainers first.

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

For a running local stack, follow the [quickstart](docs/guides/quickstart.md).
It uses Docker Compose and has different prerequisites from source-only checks.

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
- Request the relevant maintainers' review. Resolve substantive review feedback
  and required checks before asking for merge.
- Inspect the entire diff and attachments for credentials, tenant data, private
  hostnames, and personal paths. Use synthetic fixtures and redacted evidence.

Open a draft while implementation or proof is incomplete, then mark it ready for
review. Repository access and a green check do not authorize a release,
publication, settings change, or merge. Keep the existing [MIT license](LICENSE)
and third-party attribution intact.
