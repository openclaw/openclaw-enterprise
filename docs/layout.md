# Repository layout and conventions

Use this guide to choose where a change belongs in OpenClaw Enterprise (OCE).
The repository contains the OpenClaw Control Plane (OCC), its Go CLI, deployment
packaging, and documentation. Read [AGENTS.md](../AGENTS.md) for agent instructions
and [Contributing](../CONTRIBUTING.md) for setup and contribution workflow.

## Workspace boundaries

The root [pnpm workspace](../pnpm-workspace.yaml) explicitly selects
`apps/controller` and five packages: `utils`,
`contracts`, `occ`, `iam`, and `audit`. [TypeScript project references](../tsconfig.json) select the same
projects. Adding a directory does not enroll it in the workspace: intentional
workspace changes must also update these declarations and the
[workspace boundary check](../scripts/verify-workspace-boundary.mjs).
The configuration excludes `legacy/`; do not import archived implementations.

The Go CLI uses the root [Go module](../go.mod). The documentation renderer in
`scripts/docs-site/` has its own package manifest, pnpm workspace, and lockfile;
keep its dependency installation separate from the root workspace.
The console Storybook in `scripts/console-storybook/` is also an isolated tool
with its own manifest and lockfile. See [Console Storybook](contributing/console-storybook.md).

## Source ownership

| Path                                                      | Responsibility                                                                                               |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `apps/controller/src/`                                    | HTTP API, console serving, and API/worker entrypoints. `server.mjs` and `worker.mjs` start the processes.    |
| `apps/controller/src/admission/`                          | Request admission and resource validation at the API boundary.                                               |
| `apps/controller/src/auth/`                               | Authentication integrations.                                                                                 |
| `apps/controller/src/composition/`                        | Runtime assembly and wiring of selected implementations.                                                     |
| `apps/controller/src/drivers/`                            | Bundled infrastructure Driver implementations, organized by capability.                                      |
| `apps/controller/src/providers/`                          | Provider implementations.                                                                                    |
| `apps/controller/src/gateway/`                            | Agent gateway transport and workspace access.                                                                |
| `apps/controller/src/console/`                            | Browser console modules, styles, and assets.                                                                 |
| `apps/controller/src/drivers/repo/credentials/`           | Private repository credential contracts, sessions, custody, lifecycle, listeners, and transport.             |
| `apps/controller/src/drivers/repo/github/credentials/`    | GitHub credential backend, grant policy, authentication, provider transport, and Git/gh clients.             |
| `apps/controller/src/composition/repository-credentials/` | Protected file loading, key/TLS assembly, configuration checking, and separate service startup.              |
| `packages/contracts/src/`                                 | Shared resource models, Driver interfaces, and API schemas under `api/`.                                     |
| `packages/occ/src/`                                       | Platform lifecycle and resource ownership, persistence ports and state implementations, and controller work. |
| `packages/iam/src/`                                       | Native identity lookup and authorization.                                                                    |
| `packages/audit/src/`                                     | Audit event construction and sensitive-value sanitization.                                                   |
| `packages/utils/src/`                                     | Shared, focused utilities used across packages.                                                              |
| `cmd/occ/`                                                | Go CLI executable entrypoint.                                                                                |
| `internal/occcli/`                                        | CLI commands and terminal interface.                                                                         |
| `internal/occclient/`                                     | Go HTTP client for OCC.                                                                                      |
| `internal/occdev/`                                        | CLI development-stack lifecycle commands.                                                                    |

Start from the existing primitive that owns a capability. Keep platform core
behavior dependent on contracts; put implementation-specific behavior in the
owning Driver or Provider and wire it through composition. See
[current architecture](ARCHITECTURE.md) for component interactions and the
[platform design](design.md) for the approved target and implementation status.

The [repository capability](reference/repository-credentials.md#repo-driver-contract)
uses `RepoDriver` in `packages/contracts/src/repo.ts` and the bundled
`drivers/repo/github/driver.ts` adapter. Under `apps/controller/src/`, its owners are:

- `drivers/repo/credentials/`: private common sessions, custody, lifecycle,
  transport and contracts, including the private client-configuration type.
- `drivers/repo/github/credentials/`: GitHub policy, backend and closed Git/gh client bundle.
- `providers/repository-credentials/control-client.ts`: configured private-service
  connection and complete response validation.
- `composition/repository-credentials/`: registry and protected-file loading,
  platform wiring and separate-process assembly.

OCC owns immutable Agent bindings and safe session State; worker helpers connect
those records to Compute delivery. Public status omits private cleanup diagnostics.
The common engine's `RepositoryBackend` protocol is separate from `RepoDriver`.
Only the dedicated service process initializes signing and provider-token custody.
See the [Agent repository flow](flows/agent-repository-credentials.md).

## Deployment, tooling, and checks

| Path                                                     | Responsibility                                                                                   |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `deploy/helm/openclaw-enterprise/`                       | Helm chart for Kubernetes installation.                                                          |
| `deploy/runtime/`, `deploy/logging/`, `deploy/examples/` | Runtime packaging, logging configuration, and deployment examples.                               |
| `deploy/presets/`                                        | Installable Agent Preset requests; see [standard Codex](guides/topics/standard-codex-preset.md). |
| `Dockerfile`, `compose*.yaml`                            | Controller image and local stack definitions or overlays.                                        |
| `migrations/`, `drizzle.config.ts`                       | Database migrations and Drizzle tooling configuration.                                           |
| `scripts/`                                               | Build, bootstrap, migration, generation, and maintenance commands.                               |
| `scripts/ci/`, `.github/workflows/`                      | CI execution helpers and workflow definitions.                                                   |
| `.agents/skills/`                                        | Repository-owned development workflows; see the [skills catalog](testing/developer-skills.md).   |
| `.githooks/`                                             | Managed Git hooks; installation is described in [Contributing](../CONTRIBUTING.md).              |
| `tests/conformance/`                                     | Platform and Driver contract checks.                                                             |
| `tests/integration/`                                     | API, persistence, and infrastructure integrations.                                               |
| `tests/browser/`, `tests/docs/`                          | Browser-console and documentation-tooling suites.                                                |
| `tests/fixtures/`, `tests/helpers/`                      | Suite fixtures and reusable test support.                                                        |

Repository credential Dockerfiles live under
`deploy/runtime/repository-credentials/`, with the standalone Compose example
under `deploy/examples/repository-credentials/`. The build stages only the
selected emitted modules and minimal manifests in
`.build/repository-credentials/service` and `.build/repository-credentials/client`;
the standalone service/client images do not include the controller dependency
graph. The full `deploy/runtime/Dockerfile` uses the repository root as its build
context to include the emitted client router in the Agent image.

Select checks using the [testing guide](testing/README.md). Follow AGENTS.md's
integration requirements for runtime changes. For documentation-only changes,
use formatting, builds, and link checks; do not add or run tests solely for prose.
Do not install dependencies as a verification side effect.

## Code conventions

- Use the existing TypeScript ES module structure and strict settings in
  [tsconfig.base.json](../tsconfig.base.json). Match neighboring import style.
- Expose package APIs through a curated top-level `src/index.ts`; use `export type`
  for public types. Keep implementation helpers private and avoid ad hoc package
  subpath exports. Separate entrypoints require a deliberate runtime or platform
  boundary.
- Place shared utilities in focused modules under `packages/utils/src/` when
  they serve multiple consumers. Keep feature-specific helpers with their owner.
- Use `ts-pattern` for tagged unions and exhaustive multi-case branches; ordinary
  two-way conditions can remain `if` statements or simple ternaries.
- Use the repository's Prettier configuration for authored TypeScript, JavaScript,
  configuration, and Markdown, and `gofmt` for Go. With matching dependencies
  installed, run `pnpm format:fix`, inspect the diff, then `pnpm format:check`.
- Keep generated outputs owned by their generator. Update API schemas and routes,
  then use `pnpm openapi:generate` and `pnpm openapi:check` for
  `packages/contracts/openapi/occ-api.openapi.json`, `docs/reference/api.md`, and
  `docs/reference/cheatsheets/api.md`.

## Documentation placement

| Location                              | Use it for                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------------- |
| Root `README.md` and `docs/README.md` | Project orientation and the documentation map.                                  |
| `docs/layout.md`                      | Repository organization and file-placement conventions.                         |
| `docs/design.md` and `docs/design/`   | Authoritative target architecture.                                              |
| `docs/ARCHITECTURE.md`                | Current system structure and ownership boundaries.                              |
| `docs/reference/`                     | Living supported-feature specifications and Driver contracts.                   |
| `docs/guides/`                        | Product user and operator procedures, including console, CLI, and API tasks.    |
| `docs/contributing/`                  | Onboarding and workflows for people changing the platform source or docs.       |
| `docs/flows/`                         | Source-backed runtime execution traces.                                         |
| `docs/testing/`                       | Contributor test setup, environments, fixtures, and proof limits.               |
| `specs/`                              | Numbered implementation proposals, milestones, and historical delivery records. |
| `docs/assets/`                        | Documentation images and other shared assets.                                   |

Use stable feature names for living references and preserve existing numbered
specification paths. Update affected current references, guides, and flows with
behavior changes; shipped specifications remain historical records. Keep Manual
Notes unchanged. Put detailed contracts in their owning reference rather than
expanding architecture pages for every feature.

Put contributor workflows for documentation in `docs/contributing/`, starting
with the [writing guide](contributing/documentation.md). Existing site-tooling
guides and inventories may remain directly under `docs/`; `docs/testing/` owns
code verification and test setup. Reusable writing templates belong to the local
technical-writing skill.

The [documentation map](README.md) has six menus. **Getting Started**, **Topics**,
**Integrations**, **Operate**, and **Reference** serve product users and operators;
**Contribute** serves people changing the platform. A menu opens its sidebar.
Register every Markdown page once in [docs/docs.json](docs.json) and link it from
its owning overview. Deep implementation and testing pages can use the owning
tab's `hidden` list when a contributor index links them; they keep their routes
and remain searchable. Cross-link subjects useful to both audiences.

Use relative Markdown links and sentence-case article titles and headings. Keep
sidebar labels short and in Title Case; the navigation can assign a separate
label. Changing a menu or label does not require moving a file: preserve existing
URLs and heading anchors. See the [local preview guide](local-preview.md) for
rendering. Review pages above 1,500 visible words and keep them within the
2,500-word hard limit from AGENTS.md.

When directories, package boundaries, or placement conventions change, update
this guide and affected navigation in the same change.
