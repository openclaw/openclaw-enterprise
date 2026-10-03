# OpenClaw Enterprise

OpenClaw Enterprise (OCE) is the open source, vendor neutral platform for managing agents. Think of it as Kubernetes for agents.

<img src="docs/assets/oce-mascot.png" alt="OpenClaw in a mech suit, the OpenClaw Enterprise mascot" width="200" />

OCE includes the [OpenClaw Control Plane (OCC)](docs/guides/concepts.md#control-plane)
for deploying and managing [Agents](docs/guides/concepts.md#agents-and-revisions).
Start with [Getting Started](docs/README.md) to use the platform, [Operate](docs/guides/operate/README.md) to administer it, or [Contribute](docs/contributing/README.md) to change its source.

## Getting started

Choose [Local Setup](docs/guides/quickstart.md) to run OCC on your machine, or [Kubernetes Setup](docs/guides/kubernetes-setup.md) to install it on a cluster you already operate. For local setup, run from the repository root:

```bash
pnpm cli:build
export OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes
export OCC_DEVELOPMENT_CONTROL_PLANE=kubernetes
export OCC_DEVELOPMENT_SANDBOX_DRIVER=none
./bin/occ dev up
```

This selects the Kubernetes-only profile for Agent deployment. With no profile
selection, `occ dev up` starts a Compose control-plane preview that cannot deploy
Agents.

You need Docker Engine or Podman, k3d, kubectl, Helm, Bash, Python 3, Go (the version in [`go.mod`](go.mod)), Node.js 24 or newer, and the pnpm version in [`package.json`](package.json). The quickstart covers installation checks, the local API credentials, and cleanup.

After local setup, [deploy your first Agent](docs/guides/first-agent.md) and send it a model request. You need an OpenAI API key with access to the [default model or your selected override](docs/guides/first-agent.md#before-you-start) for that step. If you installed on an existing cluster, [deploy and verify an Agent on that installation](docs/guides/deploy/production-agents.md).

Reuse settings with [Agent Presets](docs/guides/topics/agent-presets.md), then fill variables and review the copied draft in the console.

## Develop

Follow [Make your first platform change](docs/contributing/first-change.md) for
setup, a small source edit, and focused verification. You need Node.js 24 or
newer, the pnpm version pinned in [`package.json`](package.json), and the Go
version selected by [`go.mod`](go.mod).

Use the [local checks](docs/testing/local.md) for the current formatting, lint,
type, CLI, and API commands; follow the [contribution policy](CONTRIBUTING.md)
before opening a PR. [Testing](docs/testing/README.md) explains additional
PostgreSQL, Docker/Podman, and Kubernetes setup; [CI coverage](docs/testing/ci.md#github-actions)
distinguishes PR-safe checks from protected integrations.

## Code layout

| Path                                          | Responsibility                                                                                  |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `apps/controller/`                            | HTTP API, browser console, worker, and [Drivers](docs/guides/concepts.md#drivers-and-backends). |
| `packages/contracts/`                         | Resource models, Driver interfaces, and API schemas.                                            |
| `packages/occ/`                               | Resource lifecycle, persistence, and work queue.                                                |
| `packages/iam/`                               | Identities, roles, and resource authorization.                                                  |
| `packages/audit/`                             | Audit events and sensitive-value sanitization.                                                  |
| `cmd/occ/`                                    | Go entry point for the OCC domain CLI.                                                          |
| `internal/occcli/`                            | OCC resource commands and human or structured output.                                           |
| `internal/occclient/`                         | Internal Go client that owns OCC transport and authentication.                                  |
| [`packages/utils/`](packages/utils/README.md) | Shared validation, hashing, and object helpers.                                                 |
| `tests/`                                      | Conformance and integration tests.                                                              |

## Documentation

Run `npm run docs:install` once, then `npm run docs:dev` to preview the docs at <http://127.0.0.1:4173>.
Use `npm run docs:build` for the full static build. See the
[local preview instructions](docs/local-preview.md) for setup and checks.

- [Getting Started](docs/README.md) and [Concepts](docs/guides/concepts.md): setup, the first Agent, and the product model.
- [Topics](docs/guides/topics/README.md) and [Integrations](docs/guides/integrations/README.md): feature behavior and named implementations.
- [Operate](docs/guides/operate/README.md) and [Reference](docs/reference/README.md): platform operations, the CLI, and the HTTP API.
- [Contribute](docs/contributing/README.md): development, design, and documentation.

## Contributors

Thanks to everyone contributing code, documentation, reviews, and ideas.
See the [full contributor graph](https://github.com/openclaw/openclaw-enterprise/graphs/contributors)
and [how to update recognition](CONTRIBUTING.md#recognize-contributors).

<!-- contributors:start -->

<a href="https://github.com/derekwaynecarr"><img src="https://avatars.githubusercontent.com/u/6233452?s=48&amp;v=4" width="48" height="48" alt="derekwaynecarr"></a> <a href="https://github.com/drew"><img src="https://avatars.githubusercontent.com/u/385?s=48&amp;v=4" width="48" height="48" alt="drew"></a> <a href="https://github.com/ericcaiwx-star"><img src="https://avatars.githubusercontent.com/u/287630876?s=48&amp;v=4" width="48" height="48" alt="ericcaiwx-star"></a> <a href="https://github.com/freeqaz"><img src="https://avatars.githubusercontent.com/u/4573221?s=48&amp;v=4" width="48" height="48" alt="freeqaz"></a> <a href="https://github.com/freeqaz-openai"><img src="https://avatars.githubusercontent.com/u/323300293?s=48&amp;v=4" width="48" height="48" alt="freeqaz-openai"></a> <a href="https://github.com/jacobtomlinson"><img src="https://avatars.githubusercontent.com/u/1610850?s=48&amp;v=4" width="48" height="48" alt="jacobtomlinson"></a> <a href="https://github.com/kevinlin-openai"><img src="https://avatars.githubusercontent.com/u/177054202?s=48&amp;v=4" width="48" height="48" alt="kevinlin-openai"></a> <a href="https://github.com/kevinslin"><img src="https://avatars.githubusercontent.com/u/409321?s=48&amp;v=4" width="48" height="48" alt="kevinslin"></a> <a href="https://github.com/Kimiyu-186"><img src="https://avatars.githubusercontent.com/u/202845257?s=48&amp;v=4" width="48" height="48" alt="Kimiyu-186"></a> <a href="https://github.com/mrunalp"><img src="https://avatars.githubusercontent.com/u/53798?s=48&amp;v=4" width="48" height="48" alt="mrunalp"></a>
<a href="https://github.com/natedemoss"><img src="https://avatars.githubusercontent.com/u/198101284?s=48&amp;v=4" width="48" height="48" alt="natedemoss"></a> <a href="https://github.com/rclarke0"><img src="https://avatars.githubusercontent.com/u/146747548?s=48&amp;v=4" width="48" height="48" alt="rclarke0"></a> <a href="https://github.com/RomneyDa"><img src="https://avatars.githubusercontent.com/u/6581799?s=48&amp;v=4" width="48" height="48" alt="RomneyDa"></a> <a href="https://github.com/russellb"><img src="https://avatars.githubusercontent.com/u/309258?s=48&amp;v=4" width="48" height="48" alt="russellb"></a> <a href="https://github.com/sallyom"><img src="https://avatars.githubusercontent.com/u/11166065?s=48&amp;v=4" width="48" height="48" alt="sallyom"></a> <a href="https://github.com/sjenning"><img src="https://avatars.githubusercontent.com/u/493891?s=48&amp;v=4" width="48" height="48" alt="sjenning"></a> <a href="https://github.com/steipete"><img src="https://avatars.githubusercontent.com/u/58493?s=48&amp;v=4" width="48" height="48" alt="steipete"></a> <a href="https://github.com/stevenlee-oai"><img src="https://avatars.githubusercontent.com/u/213687449?s=48&amp;v=4" width="48" height="48" alt="stevenlee-oai"></a> <a href="https://github.com/vincentkoc"><img src="https://avatars.githubusercontent.com/u/25068?s=48&amp;v=4" width="48" height="48" alt="vincentkoc"></a>

<!-- contributors:end -->

## License

[MIT](LICENSE). Third-party components retain their own licenses.
