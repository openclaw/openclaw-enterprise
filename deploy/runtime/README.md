# Runtime image recipe

Build a public local runtime image for the OpenClaw Enterprise quickstart and
real-runtime integration tests. The image contains both supported runtime
entrypoints:

- OpenClaw gateway: `node /app/openclaw.mjs`.
- Dedicated Codex app-server: `codex app-server`.

The Dockerfile installs only public npm packages:

| Input                           | Default                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------ |
| `NODE_BASE_IMAGE`               | `node:24-bookworm@sha256:934240a162082fd8b8a2f90cd5114446443f1eba1c5378f6687167ca405e6584` |
| `OPENCLAW_VERSION`              | `2026.7.1`                                                                                 |
| `OPENCLAW_CODEX_PLUGIN_VERSION` | `2026.7.1-1`                                                                               |
| `OPENAI_CODEX_VERSION`          | `0.147.0`                                                                                  |

Build it from the repository root:

```bash
docker build -f deploy/runtime/Dockerfile \
  --tag openclaw-enterprise-runtime:quickstart \
  deploy/runtime
```

Set `OCC_DOCKER_RUNTIME_IMAGE=openclaw-enterprise-runtime:quickstart` for the
Compose quickstart. The Docker Compute Driver uses the same image for embedded
OpenClaw gateways and dedicated Codex app-server containers.

The image preserves the installed `openclaw` package under
`/app/node_modules/openclaw` and exposes `/app/openclaw.mjs` and `/app/dist` as
symlinks into that package. `/app/skills` is copied into a real directory so the
Kubernetes gateway entrypoint can publish it into the shared runtime-assets
volume for dedicated Codex Pods. Do not flatten `/app/dist`; OpenClaw resolves
package-local runtime dependencies from its installed package root.

Production Kubernetes installations can use this recipe as a starting point,
but must push the resulting image to an operator-controlled registry and
configure the Kubernetes Compute Driver with immutable `@sha256:` image
references.

## Verify the local image

```bash
docker run --rm openclaw-enterprise-runtime:quickstart \
  node /app/openclaw.mjs --version

docker run --rm openclaw-enterprise-runtime:quickstart \
  codex --version
```

Then run the runtime startup smoke from the repository root with host Node.js
24+:

```bash
OCC_TEST_RUNTIME_IMAGE=openclaw-enterprise-runtime:quickstart \
  node --test tests/integration/runtime-image-startup.test.mjs
```

The smoke starts task-owned containers with the Docker Compute Driver gateway
entrypoint and the Kubernetes Compute Driver gateway entrypoint, UID
`1000:1000`, a read-only root filesystem, and tmpfs-backed runtime directories.
Passing means an embedded OpenClaw gateway reaches `/readyz` from a fresh home,
the bundled Codex plugin can be discovered without missing package
dependencies, and the Kubernetes dedicated-gateway startup path publishes the
bundled skills directory into `/home/node/openclaw-runtime-assets`. It does not
make a model call.

The Codex plugin is copied into `/app/dist/extensions/codex`, where OpenClaw
discovers it as a bundled plugin when Enterprise starts an Agent with a fresh
runtime state directory. The copy includes the plugin's installed package
dependencies.
