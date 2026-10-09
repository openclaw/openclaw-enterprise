# Runtime image recipe

Build a public local runtime image for the OpenClaw Enterprise quickstart and
real-runtime integration tests. The image contains both supported runtime
entrypoints:

- OpenClaw gateway: `node /app/openclaw.mjs`.
- Dedicated Codex app-server: `codex app-server`.

The image sets `NPM_CONFIG_UPDATE_NOTIFIER=false` so local npm commands do not
start npm's background version check. This avoids unrelated network approval
requests during commands such as `npm test`; package installation and explicit
network requests still use the configured network policy.

The Dockerfile builds OpenClaw from a verified public source archive, using its
pinned package manager, frozen dependency lockfile, and upstream Docker assembly.
The selected upstream source pins Codex `0.160.0`. A temporary
`stock-codex-0.163.0-alpha.1-dependency-pin.patch` updates its managed version,
package manifest, and frozen lockfile to the stock `0.163.0-alpha.1` npm release,
which supports plugin default enablement. Both Codex entrypoints use that same
installation; no Codex binary patch is applied. Remove the dependency patch
when the selected OpenClaw source pins a compatible Codex release.
Codex and Slack come from that same source. The selected commit contains
the restricted workspace-node commands and saved-token-first pairing required by
split storage; published `2026.9.5` packages do not contain that complete contract.

The source pin is an OpenClaw main commit, not a published OpenClaw release.
Until [OpenClaw #158724](https://github.com/openclaw/openclaw/pull/158724) or
an equivalent implementation is available upstream, the build applies its
`readOnlyPaths` compatibility change as
`openclaw-codex-read-only-paths.patch`. This preserves the restricted Codex
filesystem profile required by the repository broker and selected plugins.
The build also applies `openclaw-connect-ephemeral-expired-setup.patch`. Upstream
`connect --ephemeral` rejects an expired setup code before it checks saved node
credentials, so a dedicated native worker that restarts more than ten minutes
after enrollment cannot reconnect. The patch lets that path decode an expired
code and hands the expiry to the node host. The node host then reconnects with
the saved device token for the same Gateway, or still refuses the code, as
upstream `node run --pair-if-needed` already does.
The source archive and patch hashes identify the resulting custom build.

Dedicated native OpenClaw requires both required worker placement
(`cloudWorkers.requiredProfile`) and node-local inference from canonical
`models.providers` configuration. The node snapshots its model credentials and
projects each worker's managed workspace from its authorized launch descriptor;
OCE does not write the retired `nodeHost.workerRuns.nativeInferenceConfig` field.

The selected image remains unqualified for the complete dedicated native flow.
`PINNED_OPENCLAW_RUNTIME_SUPPORTS_NATIVE_WORKERS` in
`packages/occ/src/native-worker-support.ts` stays false, so admission refuses
that topology unless the operator declares an explicitly selected custom image.
The images-runtime-startup lane validates both generated configurations with the
image's CLI. Schema acceptance alone does not qualify enrollment, workspace
access, or native model execution.

| Input                                        | Selection                                                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Build base                                   | `docker.io/library/node:24-bookworm@sha256:3d27e5c11e5786e309ec3e03f93ae536eb36e6e5eb3714d5eb3300a36157add0` |
| OpenClaw source commit                       | `90d30a1178a79dddd92e6190b66b95d89dfb3ca8`                                                                   |
| Source archive SHA-256                       | `c56ea921a033efd95c2c9e43e4255c675939b0aa927c6aaf5bbdb51d5b693a8b`                                           |
| Dedicated Codex CLI (`OPENAI_CODEX_VERSION`) | `0.163.0-alpha.1`                                                                                            |
| Matrix crypto native library                 | `@matrix-org/matrix-sdk-crypto-nodejs` `v0.6.6`, SHA-256 per architecture                                    |

The source's package version is `2026.9.8`; it does not identify this custom
build. `/opt/oce/runtime/provenance.json` records the source commit, verified archive
hash, bridge and dependency patch hashes, lockfile hash, pinned package manager, selected plugins, architecture, stock Codex
package identity, and the SHA-256 of `contents.json`, which inventories
packaged files, modes, hashes, and symlinks after final-stage permission
normalization. The final stage copies the assembled
directory directly, without an intermediate compressed archive. Its pinned
`node:24-bookworm-slim` base retains required runtime libraries, Git/SSH, GitHub CLI,
Python, and process utilities. Both bases apply available Debian package updates
during the build, including updates published after the pinned Node images.
Build compilers stay in the full Bookworm stages.
The repository credential client stage needs only Node and pnpm, so it builds on the
slim base too. It compiles only the client's own sources without a type check, so
other controller changes keep it cached; the service stage builds the full,
type-checked workspace.
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
symlinks into that package. `/app/skills` is copied into a real directory so each
Kubernetes runtime can initialize its own bundled Skill assets. Gateway and
Harness do not share a runtime-assets volume. Do not flatten `/app/dist`; OpenClaw resolves
package-local runtime dependencies from its installed package root.

Codex and Slack are packaged under `/app/dist/extensions/` with their runtime
dependencies. They must load from a fresh runtime home without downloading or
installing packages at gateway startup. Slack credentials remain operator-owned
runtime Secrets; do not put them in the image.

Keep the source commit and archive checksum together when updating OpenClaw.
The `matrix-sdk-crypto` stage fetches the Matrix crypto library with the retrying,
checksum-verifying download helper, and both installs read it from a loopback server
instead of GitHub. When an OpenClaw update changes the locked
`@matrix-org/matrix-sdk-crypto-nodejs` version, update that stage's version, URL and
both SHA-256 values. Until then the install fails with a "no pinned file" message.
Follow the [pinned upstream Docker assembly](https://github.com/openclaw/openclaw/blob/90d30a1178a79dddd92e6190b66b95d89dfb3ca8/Dockerfile)
to keep plugin dependencies and runtime assets consistent. Its plugin-local
dependency layout preserves dependencies that differ from core versions.
Plugin chunks emitted directly under `dist` also need package-root resolution.
The assembly links missing plugin dependencies into that root without replacing
existing core dependencies.
The custom npm-distribution packer rejects that combination because it requires
one shared dependency version. Alternate
`NODE_BASE_IMAGE` values must provide Node.js 24.16 or newer within the 24 series.
The Dedicated command and bundled plugin both resolve the same
[Codex 0.163.0-alpha.1](https://github.com/openai/codex/releases/tag/rust-v0.163.0-alpha.1) installation.
For multi-architecture builds, the frozen npm install selects the stock
`@openai/codex-linux-x64` or `@openai/codex-linux-arm64` package for the target
architecture. The image rebuilds `/opt/oce/runtime/contents.json` from
`/app/node_modules/openclaw` and updates
`/opt/oce/runtime/provenance.json#runtimeContentsSha256` after final permission
normalization. Its `codex` provenance records the stock package source, version,
lockfile integrities, platform package, and installed binary path and digest.
The OpenClaw bridge forwards the repository-bound Agent's stock
`allow_local_binding = true` and `mode = "full"` settings; the
[networking contract](../../docs/reference/drivers/kubernetes-compute/networking-and-isolation.md#networking)
defines their scope and remaining controls.
Update the dependency pin, sandbox review, and compatibility assertions together
when changing that version. The alpha pin requires successful native AMD64 and
ARM64 image verification before merge. Run the compatibility
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
CPUs and 12 GiB RAM, and sufficient disk. The workflow installs checksum-pinned
kubectl, k3d, Helm, and yq for both Linux architectures before runtime verification.

## Verify the local image

```bash
docker run --rm openclaw-enterprise-runtime:quickstart \
  node /app/openclaw.mjs --version

docker run --rm openclaw-enterprise-runtime:quickstart \
  codex --version
```

Then run the runtime startup smoke from the repository root with host Node.js
24+. The image test environment and Docker fixture requirements are documented in
[Image and Helm tests](../../docs/testing/images.md#runtime-image-startup-test-environment):

```bash
node scripts/ci/prepare.mjs --lane images-runtime-startup --state /tmp/images-runtime-startup.json --github-env /tmp/images-runtime-startup.env
set -a
. /tmp/images-runtime-startup.env
set +a
OPENCLAW_ENTERPRISE_CI_STATE=/tmp/images-runtime-startup.json \
  node --test tests/integration/runtime-image-startup.test.mjs \
    tests/integration/runtime-image-startup-probe.test.mjs \
    tests/integration/runtime-image-gateway-peer.test.mjs \
    tests/integration/runtime-image-native-worker.test.mjs
```

The smoke starts task-owned containers with the Docker Compute Driver gateway
entrypoint, the Kubernetes Compute Driver gateway entrypoint, and the native
Codex command execution path, UID `1000:1000`, a read-only root filesystem, and
tmpfs-backed runtime directories. The private broker endpoint smoke requires the
reviewed Codex 0.163.0-alpha.1 seccomp profile above so the nested bubblewrap sandbox can
start without broadening to an unconfined Docker seccomp profile.
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
When running this suite from inside another container that talks to a host Docker
daemon, mount the repository and any temporary fixture directory at the same
absolute host path and set `TMPDIR` inside that shared path; otherwise nested
Docker bind mounts can turn missing host files into directories.

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
