# Local and browser tests

Run conformance, API, and browser checks against local source. Start with the
[shared requirements](README.md#requirements-and-credentials).

## Local checks

With infrastructure selectors unset:

```sh
pnpm check:workspace
pnpm lint
pnpm format:check
pnpm typecheck
pnpm openapi:check
pnpm test:conformance
pnpm test:integration
```

`check:workspace` checks the active workspace, including the
[repository credential source boundary](repository-credentials.md#check-source-authority-boundaries).
The test scripts above run the same canonical workspace verification before
their selected Node.js tests. `openapi:check` compares generated routes and the
OpenAPI contract, HTTP API reference, and API cheat sheet with the checked-in
versions. `typecheck` and `build` currently invoke the same TypeScript build command.

The [repository credential checks](repository-credentials.md) use that controller
output for the private common engine, GitHub backend, and configuration loader.
`pnpm credentials:build` builds the workspace and emits separate service and
Git/gh client artifacts. The service includes configuration checking and its
own process entrypoint; building does not start that process. Detached package
tests exercise both artifacts without workspace source or runtime dependencies.

The [conformance tests](../../tests/conformance) cover domain rules and selected
Driver contracts. Kubernetes conformance tests use fixtures and rendered
resources; they do not exercise a live cluster.
SSH conformance executes the real host helper with local transport, a fixture
`systemctl` that starts loopback readiness listeners, and a fixture `flock`
that wraps the same `flock(2)` syscall because macOS lacks util-linux `flock`.
Account-management fixtures exercise ownership and failure handling. They do
not prove OS account isolation, SSH reachability, real systemd, util-linux
`flock`, or real OpenClaw.

`workspace-node-supervisor` runs the Kubernetes entrypoint with real fixture
processes on Linux. It checks independent restarts and descendant termination,
not native node pairing or Codex execution. It is skipped on macOS because
Darwin's process-group signaling differs. When running it in a Linux container,
use `/usr/bin/tini -s -- node --test tests/conformance/workspace-node-supervisor.test.mjs`
as in the Harness command; the init process must reap orphaned descendants.
The runtime-image initialization case separately runs native `setup --baseline`
through the Harness entrypoint, checking document creation before either child
starts, preservation of owner edits on restart, the bootstrap opt-out, and
startup failure on invalid native initialization config. It substitutes the long-lived
node and Codex bodies, so it does not prove pairing or model execution.

The local [integration tests](../../tests/integration) include these groups:

- `occ-api`, `configuration-controller`, `secret-api`, and `service-api-keys`:
  actual Fastify routes with test Drivers and in-memory state.
- `controller-lifecycle`, `configuration-startup`, `secret-driver-startup`, and
  `sandbox-driver-startup`: admission, lifecycle, and startup validation.
- `production-controller-security` and `production-healthcheck`: internal
  request admission, HTTP cancellation, and readiness-marker behavior.
- `driver-plugin-installation` and `git-hooks`: local package installation,
  Driver selection, and hook installation/preservation in temporary checkouts.
- `compute-singleton-worker`: two local validation cases. The six database-backed
  cases live in `compute-singleton-worker-postgres` and require `OCC_TEST_DATABASE_URL`.

To target a file or one named case:

```sh
node --test tests/integration/secret-api.test.mjs
node --test --test-name-pattern='part of the test name' tests/integration/secret-api.test.mjs
```

## Linting and formatting

Run `pnpm lint` for authored JavaScript and TypeScript, and `pnpm lint:fix` for
safe automatic fixes. The root [ESLint configuration](../../eslint.config.mjs)
uses ESLint and typescript-eslint recommended rules. Browser console and docs
scripts receive browser globals; other modules receive Node.js globals.
Require a blank line after the final import, one variable per declaration, and
braces around every `if`, `else`, and loop body. Consecutive imports may stay
together; imports are not reordered. These readability rules are autofixable and
must not be added to the suppression baseline.
Underscore-prefixed unused bindings and object-rest omissions are allowed.
Generated build output, dependencies, archived code, and vendored skills and docs
renderer code are excluded.

The initial [suppression baseline](../../eslint-suppressions.json) records existing
findings by file and rule so adoption does not rewrite unrelated runtime code.
`pnpm lint` fails on findings above those recorded counts and on unused
suppressions. When fixing a recorded finding, run
`pnpm exec eslint . --prune-suppressions` and commit the reduced baseline.
Do not regenerate or expand the baseline to make new code pass. Because counts
are per file and rule, replacing an existing finding with another of the same
rule may not increase the count; review still needs to catch that case.

TypeScript 7 remains the build compiler (`tsc`). ESLint needs the TypeScript 6
JavaScript API, so the manifest uses Microsoft's
[side-by-side aliases](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-6-0):
`@typescript/native` provides TypeScript 7 and `typescript` resolves to
`@typescript/typescript6`. Lint uses syntax rules; `pnpm typecheck` owns type checking.

Prettier owns layout: 100-column print width, two spaces, double quotes,
semicolons, trailing commas, spaces inside object braces, parenthesized arrow
parameters, and LF line endings. The print width is a wrapping preference, not
a hard line-length limit. Run `pnpm format` (an alias for `pnpm format:fix`),
review the diff, and run `pnpm format:check`. Root JavaScript and TypeScript
configuration files are included in both the scripts and the pre-push check.
Go retains `gofmt` and `go vet` through `pnpm cli:check`.
The shared CI baseline runs lint and formatting as separate required steps.

## Authentication and authorization coverage

`tests/conformance/iam.test.mjs` covers explicit identities, exact scopes, Group
membership, Restrictions, current policy loading, and failures.
`tests/integration/occ-api.test.mjs` covers safe session inspection,
administrator-provisioned accounts, resource filtering, Namespace isolation,
audit attribution, and failures without orphaned state.

`tests/integration/service-api-keys.test.mjs` exercises Fastify HTTP with Better
Auth memory storage and native IAM. It covers valid, invalid, expired, revoked,
unauthorized, and cross-Namespace requests, authorized key management, human
session preservation, Agent exclusion, audit attribution, and JSON-body and
bodyless operations through the compiled OCC CLI. See
[PostgreSQL tests](postgresql.md#service-key-persistence) for database-backed
verification.

## Packaged-driver integration

`tests/integration/driver-plugin-installation.test.mjs` installs scoped,
precompiled IAM, Compute, and Configuration tarballs with real pnpm into an
isolated dependency root, with package lifecycle scripts disabled. It selects
all three through production startup and session admission backed by in-memory
OCC state. The checks include `401`/`403` responses, audited identity and
restriction evidence, Configuration CRUD, disabled public signup, and Namespace
reconciliation writing its identity to `/tmp/local-test`. Cleanup removes only
the test's own file; the suite does not alter checkout dependencies.

This suite does not verify PostgreSQL persistence, cross-process policy
visibility, private-registry authentication, Kubernetes workloads, a real
OpenClaw gateway, or a Codex model turn.

## Console browser checks

The [console](../reference/console.md) uses real controller routes in
`tests/integration/console-api.test.mjs`, `tests/browser/console.test.mjs`, and
`tests/browser/console-agents.test.mjs`. The shared browser fixture runs
Fastify, Better Auth memory storage, Native IAM, and in-memory platform storage
on an ephemeral loopback port. Configuration and Compute helpers are test-only.
The Agent browser suite seeds active revision pointers only to render admitted
history; that fixture does not prove runtime dispatch, worker leases, Compute
Driver effects, PostgreSQL persistence, live Provider health, or deployed Agent
runtime behavior.

Native admin UI coverage in this suite should prove panel visibility, warning
copy, shared-cookie Agent-host admission, denied service API keys, wrong or
unknown Agent hosts, and revision-change reconnect behavior. It does not prove
a real gateway, private Envoy routing, or that the OCE session cookie is stripped
before the native gateway; cover those in the native admin integration proof.

Run the API/static boundary checks without a browser:

```sh
node --test tests/integration/console-api.test.mjs
```

On a host approved for browser automation, provision Playwright's Chromium and
run the dedicated browser suite:

```sh
pnpm exec playwright install chromium
pnpm test:console-browser
```

`OCC_TEST_BROWSER_EXECUTABLE` optionally selects an approved existing browser
executable. The suite always uses a fresh context. Browser setup is explicit;
the test command does not install software or silently skip a missing browser.
Do not change managed browser policies to make the suite run. A managed Chrome
debugging policy can currently block the browser suite on locked-down hosts; use
an approved browser environment instead. Set `OCC_TEST_CONSOLE_ARTIFACT_DIR` to
retain screenshots at a chosen path; otherwise the suite uses a temporary
directory. The existing
[image smoke test](images.md#images-and-helm) also loads console assets from the built
controller image; it does not claim a live production deployment.

## Repository and tooling configuration

The active workspace requires Node.js 24 or newer and pins pnpm `11.15.1` in
[`package.json`](../../package.json). Repository-wide settings are defined in:

- [`pnpm-workspace.yaml`](../../pnpm-workspace.yaml): one controller application
  and five platform packages.
- [`tsconfig.base.json`](../../tsconfig.base.json): strict TypeScript,
  `NodeNext` modules, ES2022 output, and declaration generation.
- [`tsconfig.json`](../../tsconfig.json): the six active TypeScript project
  references.
- [`.prettierrc.json`](../../.prettierrc.json): a `100`-column print width.
- [`.githooks/pre-push`](../../.githooks/pre-push): the repository-managed
  formatting check invoked by a normal Git push. It runs the installed Prettier
  executable directly without invoking a package manager or installing
  dependencies, and blocks pushes when Prettier is unavailable.

Dependency installation installs the hook in Git's native hooks directory.
Run `pnpm hooks:install` to reinstall it. Installation preserves an existing
`core.hooksPath` setting and refuses to replace an unmanaged pre-push hook.
The hook checks active source and root files; authored documentation also needs
the full formatting check below.

The root formatting scripts cover active source files, root Markdown, and
`docs/**/*.md` except the full generated HTTP API reference, which
`pnpm openapi:check` verifies. Run the complete authored-file check with:

```bash
pnpm format:check
git diff --check
```

After changing API routes or schemas, run `pnpm openapi:generate` to update the
OpenAPI contract, [HTTP API reference](../reference/api.md), and
[API cheat sheet](../reference/cheatsheets/api.md); then verify them with
`pnpm openapi:check`. To check both Markdown pages against
the checked-in OpenAPI contract without loading controller dependencies, run
`node scripts/generate-occ-api-reference.mjs --check`.

See the [architecture guide](../ARCHITECTURE.md) for ownership and runtime
boundaries, the [quickstart](../guides/quickstart.md) for the default local
startup helper, and the [deployment guide](../guides/deploy.md) for production
example files and Helm installation.

## Related

- [Choose another test suite](README.md).
- [Results, cleanup, and troubleshooting](README.md#results-cleanup-and-troubleshooting).

## Standard Codex Preset

Run `node --test tests/integration/presets-controller.test.mjs`. The standard
Preset case posts the shipped JSON through Fastify with native IAM, reads it
from the Namespace catalog, renders variables, and creates a Configuration
and dedicated Agent. It checks credential references, native policy retention,
and rejection of a cross-Namespace model credential. The password workflow in
`tests/browser/console-agents.test.mjs` exercises the real chooser, masked input,
same-Namespace Secret creation, credential grant, and retry after a name conflict.
The API suite also loads Installation YAML and checks default seeding, preserved
customizations, and authorization rollback. The
[production PostgreSQL suite](postgresql.md) checks bootstrap-namespace seeding,
API restart preservation, and new-Namespace defaults with real persisted state.
Persistence is in-memory with the filesystem Configuration Driver; no workload
or model starts.

The [runtime verification procedure](../guides/topics/standard-codex-preset.md#verify-before-use)
requires compatible native images, working Linux sandbox enforcement, authorized
model credentials, and controlled network destinations. API success alone does
not prove deny-by-default tool egress, cached model search, or Pod isolation.
