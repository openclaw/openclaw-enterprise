# OpenClaw Enterprise

<img src="docs/assets/lobster-mech-transparent.png" alt="Comic-style lobster in a mech suit" width="200" />

The open control plane for deploying and managing Agents. Under active construction.

## Getting Started

Requires Node.js 24+, Docker Engine with Docker Compose, and an authorized
OpenAI model/key. From the repository root:

```sh
# Load OPENAI_API_KEY into this shell using your credential manager.
node scripts/setup.mjs dev --model gpt-5.1
```

Choose a model your key can access. Setup builds the runtime image when needed,
starts the controller, deploys an Agent, and opens its terminal UI. Follow the
[quickstart](docs/guides/quickstart.md) to verify a conversation, or the
[deployment guide](docs/guides/deploy.md) for production Kubernetes setup.

## Develop

Requires Node.js 24 or newer and the pnpm version pinned in
[`package.json`](package.json).

```sh
pnpm install --frozen-lockfile
pnpm check:workspace
pnpm format:check
pnpm typecheck
pnpm openapi:check
pnpm test
```

PostgreSQL, Docker, and Kubernetes integration suites require additional setup;
see [Testing](docs/testing.md) for suite coverage, credentials, setup, and commands.

## Code layout

| Path                                          | Responsibility                                       |
| --------------------------------------------- | ---------------------------------------------------- |
| `apps/controller/`                            | HTTP API, worker, and Driver implementations.        |
| `packages/contracts/`                         | Resource models, Driver interfaces, and API schemas. |
| `packages/occ/`                               | Resource lifecycle, persistence, and work queue.     |
| `packages/iam/`                               | Identities, roles, and resource authorization.       |
| `packages/audit/`                             | Audit events and sensitive-value sanitization.       |
| [`packages/utils/`](packages/utils/README.md) | Shared validation, hashing, and object helpers.      |
| `tests/`                                      | Conformance and integration tests.                   |

## Documentation

- [Documentation map](docs/README.md): guides, references, and runtime flows.
- [Platform design](docs/design.md) and [current architecture](docs/ARCHITECTURE.md): target design and implemented components.
- [Feature reference](docs/reference/README.md): supported behavior and Driver contracts.
- [HTTP API](docs/reference/api.md): routes, request and response schemas, authentication, and permissions.
- [Spec archive](specs/README.md): proposals and implementation history, with recorded statuses.

## License

[MIT](LICENSE). Third-party components retain their own licenses.
