# OpenClaw Enterprise

<img src="docs/assets/lobster-mech-transparent.png" alt="Comic-style lobster in a mech suit" width="200" />

OpenClaw Enterprise (OCE) includes the [OpenClaw Control Plane (OCC)](docs/guides/concepts.md#control-plane)
for deploying and managing [Agents](docs/guides/concepts.md#agents-and-revisions).

## Getting Started

Requires either Docker Engine with Docker Compose, or Podman with
`podman-compose` and `yq` v4. Bash, Python 3, and the Go version selected by
[`go.mod`](go.mod) are also required. Install the OCC CLI and start the local
stack with:

```bash
go install ./cmd/occ
./scripts/dev-up
```

The helper prefers a usable Docker Engine and otherwise selects Podman directly;
a `docker` compatibility alias is not required. It prepares the default
quickstart runtime image when needed and prints the selected engine, loopback
OCC URL, Installation ID, and private
[service-key](docs/guides/concepts.md#identity-and-access) file path. Open the
printed API URL with `/console/` to sign in, browse accessible Agents, Providers,
and Namespaces, create Agents with editable Configuration JSON, and edit supported
channel draft settings. To deploy an Agent and attach the OpenClaw terminal UI
to a real model-backed [runtime](docs/guides/concepts.md#gateways-and-harnesses),
continue to [development docs](docs/guides/deploy/local-operations.md#development-end-to-end-tui).
A model credential is required to run Agent model turns, but not to start the
stack.

The verified Podman boundary includes control-plane startup, authenticated API
access, Namespace isolation, one embedded OpenClaw Agent deployment, a real
provider-backed model turn, and exact test cleanup. Dedicated Codex, interactive
TUI, and Fluentd/OTLP verification remain Docker-only.

The local worker has access to the selected engine's Docker-compatible API
socket. Use the
[quickstart](docs/guides/quickstart.md) for the first local API request, the
[deployment guide](docs/guides/deploy.md) for host requirements and production
Kubernetes setup, and the [runtime image recipe](deploy/runtime/README.md) for
image versions and build options.

## Develop

Requires Node.js 24 or newer, the pnpm version pinned in
[`package.json`](package.json), and the Go version selected by [`go.mod`](go.mod).

```sh
pnpm install --frozen-lockfile
pnpm check:workspace
pnpm format:check
pnpm typecheck
pnpm cli:check
pnpm cli:test
pnpm openapi:check
pnpm test
```

PostgreSQL, Docker/Podman, and Kubernetes integration suites require additional setup;
see [Testing](docs/testing/README.md) for suite coverage, credentials, setup, and commands.
[GitHub Actions coverage](docs/testing/ci.md#github-actions) separates five PR-safe lanes from protected model and service integrations.

## Code layout

| Path                                          | Responsibility                                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `apps/controller/`                            | HTTP API, browser console, worker, and [Drivers](docs/guides/concepts.md#drivers-and-providers). |
| `packages/contracts/`                         | Resource models, Driver interfaces, and API schemas.                                             |
| `packages/occ/`                               | Resource lifecycle, persistence, and work queue.                                                 |
| `packages/iam/`                               | Identities, roles, and resource authorization.                                                   |
| `packages/audit/`                             | Audit events and sensitive-value sanitization.                                                   |
| `cmd/occ/`                                    | Go entry point for the OCC domain CLI.                                                           |
| `internal/occcli/`                            | OCC resource commands and human or structured output.                                            |
| `internal/occclient/`                         | Internal Go client that owns OCC transport and authentication.                                   |
| [`packages/utils/`](packages/utils/README.md) | Shared validation, hashing, and object helpers.                                                  |
| `tests/`                                      | Conformance and integration tests.                                                               |

## Documentation

Run `npm run docs:install` once, then `npm run docs:dev` to preview the docs at <http://127.0.0.1:4173>.
Use `npm run docs:build` for the full static build. See the
[local preview instructions](docs/local-preview.md) for setup and checks.

- [Concepts](docs/guides/concepts.md): tenancy, revisions, execution, [configuration and Secrets](docs/guides/concepts.md#configuration-and-secrets), and access.
- [Documentation map](docs/README.md): guides, references, and runtime flows.
- [Observability](docs/guides/observability.md): configure operational log export, Collector metrics, and delivery checks.
- [Platform design](docs/design.md) and [current architecture](docs/ARCHITECTURE.md): target design and implemented components.
- [Feature reference](docs/reference/README.md): supported behavior and Driver contracts.
- [Platform console](docs/reference/console.md): login, Namespace selection, Agent creation, revision inspection, and supported channel draft edits.
- [Providers](docs/reference/providers.md): authenticated clients, related Drivers, and optional Agent association.
- [Agent plugins](docs/reference/agent-plugins.md): Agent-owned curated plugin selections and native policy prepared during startup.
- [Agent workspace files](docs/reference/agents.md#workspace-files): read and replace four native Agent workspace files through private Kubernetes routes managed by Compute, Envoy Gateway, and cert-manager.
- [HTTP API](docs/reference/api.md): routes, request and response schemas, authentication, and permissions.
- [Spec archive](specs/README.md): proposals and implementation history, with recorded statuses.

## License

[MIT](LICENSE). Third-party components retain their own licenses.
