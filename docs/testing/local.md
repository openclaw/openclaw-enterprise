# Local and browser tests

Run conformance, API, and browser checks against local source. Start with the
[shared requirements](README.md#requirements-and-credentials).

## Local checks

With infrastructure selectors unset:

```sh
pnpm check:workspace
pnpm format:check
pnpm typecheck
pnpm openapi:check
pnpm test:conformance
pnpm test:integration
```

`check:workspace` checks the active workspace.
The test scripts above run the same canonical workspace verification before
their selected Node.js tests. `openapi:check` compares generated routes and both
API artifacts with the checked-in versions. `typecheck` and `build` currently
invoke the same TypeScript build command.

The [conformance tests](../../tests/conformance) cover domain rules and selected
Driver contracts. Kubernetes conformance tests use fixtures and rendered
resources; they do not exercise a live cluster.
SSH conformance executes the real host helper with local transport, a fixture
`systemctl` that starts loopback readiness listeners, and a fixture `flock`
that wraps the same `flock(2)` syscall because macOS lacks util-linux `flock`.
Account-management fixtures exercise ownership and failure handling. They do
not prove OS account isolation, SSH reachability, real systemd, util-linux
`flock`, or real OpenClaw.

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
authored `docs/**/*.md`. The generated API reference is excluded and verified by
`pnpm openapi:check`. Run the complete authored-file check with:

```bash
pnpm format:check
git diff --check
```

After changing API routes or schemas, regenerate the API artifacts with
`pnpm openapi:generate` and verify them with `pnpm openapi:check`. To check the
generated Markdown against the checked-in OpenAPI contract without loading
controller dependencies, run `node scripts/generate-occ-api-reference.mjs --check`.

See the [architecture guide](../ARCHITECTURE.md) for ownership and runtime
boundaries, the [quickstart](../guides/quickstart.md) for the default local
startup helper, and the [deployment guide](../guides/deploy.md) for production
example files and Helm installation.

## Related

- [Choose another test suite](README.md).
- [Results, cleanup, and troubleshooting](README.md#results-cleanup-and-troubleshooting).
