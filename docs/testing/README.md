# Testing

## Overview

Run tests from the repository root. This page lists the test suites and links to
setup for suites that need external services.

| Test                  | Purpose                                               | Location                                                                    |
| --------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------- |
| Conformance           | Unit-style domain and Driver contract checks.         | [`tests/conformance`](../../tests/conformance)                              |
| Integration           | Component workflows, using fixtures or real services. | [`tests/integration`](../../tests/integration)                              |
| Browser               | Console and docs site behavior in Chromium.           | [`tests/browser`](../../tests/browser)                                      |
| Go                    | CLI and other Go packages.                            | `cmd/` and `internal/`                                                      |
| Docs and test tooling | Docs site, generated references, and test helpers.    | [`tests/docs`](../../tests/docs) and [`tests/helpers`](../../tests/helpers) |

## Requirements and credentials

Install Node.js 24 or newer, the pnpm version in [`package.json`](../../package.json),
the Go version in [`go.mod`](../../go.mod), Git, and `tar`:

```sh
pnpm install --frozen-lockfile
```

Browser tests also need Chromium; see [browser setup](local.md#console-browser-checks).
Real-service tests may need Docker, Kubernetes, databases, or credentials; follow
their linked guides. Keep credentials outside the repository. Commands do not
automatically load `.env`; exported variables override `node --env-file` values.

## Quickstart

### Run all test files

Start with a shell without integration opt-in variables; otherwise prepared
suites can run concurrently:

```sh
pnpm test                     # Conformance and integration files
pnpm cli:test                 # Go
pnpm docs:install             # Browser and docs dependencies
pnpm test:console-browser     # Chromium
node --test tests/docs/*.test.mjs tests/helpers/*.test.mjs
```

These commands select test files, but real-service cases may skip without their
prerequisites. Check the skip count and use the suite guides to run those cases.
For conformance tests alone, use `pnpm test:conformance`.

### Run one test

```sh
pnpm test:files --test-reporter=spec -- tests/conformance/contracts.test.mjs
pnpm test:files --test-name-pattern='the Driver contract exposes' -- tests/conformance/contracts.test.mjs
```

The second command selects one named case. `test:files` does not prepare
fixtures or run the workspace check. Run `node scripts/test-files.mjs --help`
for options.

## Integration tests

```sh
pnpm test:integration
```

For real-service cases, prepare and run the specific suite below. Some create
remote resources or send messages. Use authorized disposable resources, scope
selectors to one run, and run prepared suites one at a time.

### Run the hosted local installation lane

For the six `dev-up-k3d` cases, see [local Kubernetes setup](kubernetes.md#local-kubernetes-installation)
or [hosted dispatch](ci.md#run-the-hosted-local-installation-lane).

## Results, cleanup, and troubleshooting

Check pass, failure, and skip counts; a skip is not a pass. If a case is skipped,
check its selectors and prerequisites. For provider failures, check credential
and model access without printing secrets. Retain failure evidence and remove
only resources created by the run.

## Further reading

- [Local, browser, and metrics tests](local.md)
- [CI and hosted test lanes](ci.md)
- [QA matrix](qa-matrix.md)
- [PostgreSQL](postgresql.md)
- [Docker, images, and Helm](docker.md)
- [Kubernetes, Keycloak, gateway routing, and production TUI](kubernetes.md)
- [OpenShell](openshell.md)
- [SSH](ssh.md)
- [Agent plugins](plugins.md)
- [Repository credentials](repository-credentials.md)
- [Slack and ChatGPT service accounts](slack.md)
- [Test fixtures and scenarios](fixtures-and-scenarios.md)
- [Module and repository boundaries](module-boundaries.md)
- [Developer skills](developer-skills.md)
- [Code review](autoreview.md)
