# Runtime image recipe

Build a public local runtime image for the OpenClaw Enterprise quickstart and
real-runtime integration tests. The image contains both supported runtime
entrypoints:

- OpenClaw gateway: `node /app/openclaw.mjs`.
- Dedicated Codex app-server: `codex app-server`.

The Dockerfile builds OpenClaw from a verified public source archive, using its
pinned package manager, frozen dependency lockfile, and upstream Docker assembly.
The reviewed `codex-0.156.0.patch` updates only Codex dependency versions and package
integrities before the frozen install. Both Codex entrypoints share that installation.
Codex and Slack come from that same source. The selected commit contains
the restricted workspace-node commands and saved-token-first pairing required by
split storage; published `2026.9.5` packages do not contain that complete contract.

| Input                                        | Selection                                                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Build base                                   | `docker.io/library/node:24-bookworm@sha256:934240a162082fd8b8a2f90cd5114446443f1eba1c5378f6687167ca405e6584` |
| OpenClaw source commit                       | `2765f7a3341b8be4835afacbff3d04c6e3c3c79b`                                                                   |
| Source archive SHA-256                       | `42a420286dcad558b9710b7b583dd9e489bb07b3a835e3e19b69184b22fd416b`                                           |
| Dedicated Codex CLI (`OPENAI_CODEX_VERSION`) | `0.156.0`                                                                                                    |

The source's package version remains `2026.9.5`; it does not identify this custom
build. `/opt/oce/runtime/provenance.json` records the source commit, verified archive
hash, lockfile hash, pinned package manager, selected plugins, architecture, and
Codex patch hash and version, and the SHA-256 of `contents.json`, which inventories
packaged files, modes, hashes, and symlinks. The final stage copies the assembled
directory directly, without an intermediate compressed archive. Its pinned
`node:24-bookworm-slim` base retains required runtime libraries, Git/SSH, GitHub CLI,
Python, and process utilities. Build compilers stay in the full Bookworm stages.
The build selects upstream required bundled plugins plus Codex and Slack before
installing dependencies for the target architecture with lifecycle
scripts enabled and runs upstream postinstall, plugin pruning, import-closure,
and native filesystem-addon checks. Extension tests, QA source, and documentation
media are excluded; help text, skills, and runtime templates remain. A dependency
walk removes unreachable pnpm store entries while retaining importer-specific
versions and installed optional dependencies. Building
requires registry access.

Build it from the repository root:

```bash
docker build -f deploy/runtime/Dockerfile \
  --tag openclaw-enterprise-runtime:quickstart \
  .
```

Set `OCC_DOCKER_RUNTIME_IMAGE=openclaw-enterprise-runtime:quickstart` for the
Compose quickstart. The Docker Compute Driver uses the same image for embedded
OpenClaw gateways and dedicated Codex app-server containers.

The image preserves the assembled OpenClaw runtime under
`/app/node_modules/openclaw` and exposes `/app/openclaw.mjs` and `/app/dist` as
symlinks into that package. `/app/skills` is copied into a real directory so the
Kubernetes gateway entrypoint can publish it into the shared runtime-assets
volume for dedicated Codex Pods. Do not flatten `/app/dist`; OpenClaw resolves
package-local runtime dependencies from its installed package root.

Codex and Slack are packaged under `/app/dist/extensions/` with their runtime
dependencies. They must load from a fresh runtime home without downloading or
installing packages at gateway startup. Slack credentials remain operator-owned
runtime Secrets; do not put them in the image.

Keep the source commit and archive checksum together when updating OpenClaw.
Follow the [pinned upstream Docker assembly](https://github.com/openclaw/openclaw/blob/2765f7a3341b8be4835afacbff3d04c6e3c3c79b/Dockerfile)
to keep plugin dependencies and runtime assets consistent. Its plugin-local
dependency layout preserves dependencies that differ from core versions.
Plugin chunks emitted directly under `dist` also need package-root resolution.
The assembly links missing plugin dependencies into that root without replacing
existing core dependencies.
The custom npm-distribution packer rejects that combination because it requires
one shared dependency version. Alternate
`NODE_BASE_IMAGE` values must provide Node.js 24.16 or newer within the 24 series.
The Dedicated command and bundled plugin both resolve the same
[Codex 0.156.0](https://github.com/openai/codex/releases/tag/rust-v0.156.0) installation.
Update the reviewed dependency patch and compatibility assertion together when
changing that version. Run the compatibility
check below against the resulting image. Provider model availability still
requires a real model turn with the selected credential.

Production Kubernetes installations can use this recipe as a starting point,
but must push the resulting image to an operator-controlled registry and
configure the Kubernetes Compute Driver with immutable `@sha256:` image
references. Follow [Build and publish production images](../../docs/guides/deploy/production-installation.md#build-and-publish-production-images)
for the controller and runtime build commands, registry publishing, and digest
configuration.

## Select a storage-split test image

Build Gateway and Harness images from this same pinned distribution, record each
immutable image digest, and follow the existing
[Kubernetes test procedures](../../docs/testing/kubernetes.md). The complete
upstream interfaces and remaining Enterprise acceptance are tracked in
[#76](https://github.com/openclaw/openclaw-enterprise/issues/76). Source inclusion
and image startup do not prove routed enrollment, saved-token reconnect, all seven
workspace operations, or model execution in a deployed environment.

## Rebuild an existing image

`scripts/dev-up` reuses the configured image tag and builds the default
`openclaw-enterprise-runtime:quickstart` image only when that tag is absent.
After changing this recipe or its pinned inputs, run the build command above
explicitly, verify the rebuilt image, then run `./scripts/dev-up` again. For a
custom `OCC_DOCKER_RUNTIME_IMAGE`, build or pull that selected tag yourself.

For Kubernetes, publish the rebuilt image and update both Installation image
references to its verified immutable digest. Separate gateway and Codex images
require verification of that exact pair through the
[Kubernetes runtime tests](../../docs/testing/kubernetes.md#kubernetes-model-turns-and-secrets).

## Verify both native architectures

Dispatch **Check Native Container Images** (`container-check.yml`) on the branch
to build and smoke controller and runtime on native AMD64 and ARM64 runners without
publishing. It uses the same reusable preparation jobs as Enterprise Containers.
Manual `CI` dispatches also call this native verification workflow, including on
a branch before its first merge. The default Blacksmith runner labels can be overridden with repository
variables `CONTAINER_AMD64_RUNNER` and `CONTAINER_ARM64_RUNNER`. Each override must
name a provisioned Linux runner with the matching architecture, at least four
CPUs and 12 GiB RAM, and sufficient disk.

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
the bundled Codex and Slack plugins load without missing package dependencies,
the installed Codex plugin successfully initializes the image's real Codex
app-server, and the Kubernetes dedicated-gateway startup path publishes the
bundled skills directory into `/home/node/openclaw-runtime-assets`. These checks
run without external network access or provider credentials. The smoke also
enrolls a real restricted workspace node, checks its exact seven-command inventory,
and restarts it with the redeemed setup code and saved identity. It requires the
original bootstrap completion to remain unchanged. These checks do not exercise
all workspace command payloads, make a model call, or establish a Slack connection.

Before enabling Slack in an Installation, run the
[live Slack test](../../docs/testing/slack.md#slack) with the verified image, projected
credentials, and the required proxy configuration. It must prove a real mention,
Codex turn, and gateway-authored reply; gateway readiness alone is insufficient.

## Build provenance

The publisher passes the checked Enterprise source SHA as `OCC_BUILD_REVISION`.
The runtime image records it in the OCI revision label and
`/opt/oce/runtime/build.json`. The private runtime status endpoint exposes only
that validated commit and the upstream OpenClaw commit from
`/opt/oce/runtime/provenance.json` for the console's `debug=true` image panel.
The `org.openclaw.image.revision` label records the same upstream commit for
Docker inspection; the build checks that it matches packaged provenance. Local builds
can pass `--build-arg OCC_BUILD_REVISION=<full-lowercase-git-sha>`; omitted metadata
remains unknown. Rebuild the runtime image to include this metadata.
