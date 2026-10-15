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

## Automatic checks and blocking failures

| Checks                                                                      | When they run                                                                                  | Blocks merge               | Blocks container publication                  |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------- | --------------------------------------------- |
| Selected CI suites, including integration tests                             | PRs, pushes to `main`, merge groups, and manual CI runs                                        | Yes, through `CI Required` | Yes, for the exact source's main-push CI run  |
| First Agent Smoke                                                           | Full CI mode; installs, chats with, stops, and restarts Agents using a stand-in model provider | No; outside `CI Required`  | Yes; the entire main-push CI run must succeed |
| QA advisory: Codex model/UI and Calendar, OpenShell, and local installation | Trusted PRs or manual advisory dispatch                                                        | No                         | No                                            |
| Full Integration: selected lanes; `all` includes the complete QA matrix     | Manual dispatch                                                                                | No                         | No                                            |
| Native controller and runtime image smoke tests on AMD64 and ARM64          | Container preparation before publication, or manual image checks                               | No                         | Yes                                           |

Docs-only PRs run static checks without product tests. Test-only PRs select
affected CI suites; other changes and main pushes run full CI. See
[CI selection and lane coverage](ci.md) and [QA advisory coverage](qa-matrix.md#ci-evidence-and-recovery).

These workflows check source changes and publication artifacts. They do not run
integration tests automatically for each deployment. A successful publication
requires the exact source's successful main-push CI run and native image checks;
it does not require Full Integration or QA advisory. See the
[container publication gates](../flows/container-publication.md).

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

Choose the scope you need:

| Scope                     | What it runs                                                                                                                                                  | Setup and commands                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Local integration tests   | Component workflows in `tests/integration`; real-service cases skip unless configured.                                                                        | `pnpm test:integration`; use the suite guides under [Further reading](#further-reading) for external dependencies. |
| Full Integration workflow | Manually selected CI lanes for databases, containers, clusters, and real providers. `all` runs every selectable lane, including `qa-matrix` and `dev-up-k3d`. | [Lane coverage and hosted dispatch](ci.md#run-a-protected-integration-lane).                                       |
| QA matrix                 | Agent journeys across Compose and Kubernetes installations: model/UI, Git, Calendar, and Slack. PR advisory runs a subset.                                    | [Scenarios, credentials, and commands](qa-matrix.md).                                                              |

For real-service cases, prepare the selected suite first. Some create remote
resources or send messages. Use authorized disposable resources, scope selectors
to one run, and run prepared suites one at a time.

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
