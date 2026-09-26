ARG OPENCLAW_COMMIT=5f402bf7a8b510aa7489737c35621e9ad947469c
ARG NODE_BASE_IMAGE=docker.io/library/node:24-bookworm@sha256:934240a162082fd8b8a2f90cd5114446443f1eba1c5378f6687167ca405e6584
ARG NODE_RUNTIME_BASE_IMAGE=docker.io/library/node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03
ARG CODEX_RUST_BASE_IMAGE=docker.io/library/rust:1.95-bookworm@sha256:6258907abe69656e41cd992e0b705cdcfabcbbe3db374f92ed2d47121282d4a1
FROM ${CODEX_RUST_BASE_IMAGE} AS codex-broker-cli-build

ARG TARGETARCH
ARG CODEX_SOURCE_COMMIT=fe74a774532af67b5a4a3dec03ce9469e17f89af
ARG CODEX_SOURCE_ARCHIVE_SHA256=aec40816bf320ff9f7666ca262222992c9617b2ecb60319f8b411dd8eba5c824
ARG CODEX_BROKER_POLICY_COMMIT=6b469b0afb0daa131b4d2caf4ee487feed6a9983
ARG CODEX_BROKER_POLICY_PATCH_SHA256=3158a00e50cafeef1910ad201676bdeb041657da38052c393ceb31d50f8725b8
WORKDIR /codex-source
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*
RUN --mount=type=secret,id=build-ca,required=false \
    set -eu; \
    if [ -f /run/secrets/build-ca ]; then export CURL_CA_BUNDLE=/run/secrets/build-ca; fi; \
    curl --fail --location --silent --show-error \
      "https://codeload.github.com/openai/codex/tar.gz/${CODEX_SOURCE_COMMIT}" -o /tmp/codex-source.tar.gz; \
    echo "${CODEX_SOURCE_ARCHIVE_SHA256}  /tmp/codex-source.tar.gz" | sha256sum --check --strict; \
    tar -xzf /tmp/codex-source.tar.gz --strip-components=1; \
    rm /tmp/codex-source.tar.gz
COPY deploy/runtime/codex-repository-broker-policy.patch /tmp/codex-repository-broker-policy.patch
RUN --mount=type=cache,id=oce-codex-cargo-registry-${TARGETARCH},target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,id=oce-codex-cargo-git-${TARGETARCH},target=/usr/local/cargo/git,sharing=locked \
    --mount=type=cache,id=oce-codex-cargo-target-${TARGETARCH},target=/codex-source/codex-rs/target,sharing=locked \
    set -eu; \
    echo "${CODEX_BROKER_POLICY_PATCH_SHA256}  /tmp/codex-repository-broker-policy.patch" | sha256sum --check --strict; \
    git apply /tmp/codex-repository-broker-policy.patch; \
    architecture="${TARGETARCH:-amd64}"; \
    case "$architecture" in \
      amd64) built_target="x86_64-unknown-linux-gnu" ;; \
      arm64) built_target="aarch64-unknown-linux-gnu" ;; \
      *) echo "Unsupported Codex build architecture: $architecture" >&2; exit 1 ;; \
    esac; \
    cd codex-rs; \
    cargo build --locked -p codex-cli --bin codex --release; \
    install -m 0555 target/release/codex /opt/oce-codex-broker; \
    binary_sha256="$(sha256sum /opt/oce-codex-broker | awk '{print $1}')"; \
    printf '%s\n' "$binary_sha256" > /opt/oce-codex-broker.sha256; \
    { \
      printf '{\n'; \
      printf '  "source": "https://github.com/openai/codex",\n'; \
      printf '  "sourceCommit": "%s",\n' "$CODEX_SOURCE_COMMIT"; \
      printf '  "patchedCommit": "%s",\n' "$CODEX_BROKER_POLICY_COMMIT"; \
      printf '  "sourceArchiveSha256": "%s",\n' "$CODEX_SOURCE_ARCHIVE_SHA256"; \
      printf '  "patchSha256": "%s",\n' "$CODEX_BROKER_POLICY_PATCH_SHA256"; \
      printf '  "binarySha256": "%s",\n' "$binary_sha256"; \
      printf '  "binary": "codex-rs/target/release/codex",\n'; \
      printf '  "buildTarget": "%s",\n' "$built_target"; \
      printf '  "version": "0.156.0"\n'; \
      printf '}\n'; \
    } > /opt/oce-codex-broker.json

FROM ${NODE_BASE_IMAGE} AS repository-client-build

WORKDIR /build
COPY LICENSE package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/controller/package.json apps/controller/package.json
COPY packages/audit/package.json packages/audit/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/iam/package.json packages/iam/package.json
COPY packages/occ/package.json packages/occ/package.json
COPY packages/utils/package.json packages/utils/package.json
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false \
    corepack pnpm install --frozen-lockfile --ignore-scripts --store-dir=/tmp/pnpm-store \
    && rm -rf /tmp/pnpm-store
COPY tsconfig.base.json tsconfig.json ./
COPY packages packages
COPY apps/controller apps/controller
COPY scripts/build-repository-credentials.mjs scripts/build-repository-credentials.mjs
COPY deploy/runtime/repository-credentials/.dockerignore deploy/runtime/repository-credentials/.dockerignore
COPY deploy/runtime/repository-credentials/hooks.json deploy/runtime/repository-credentials/hooks.json
RUN corepack pnpm credentials:build

FROM ${NODE_BASE_IMAGE} AS openclaw-source

# Keep the source identity separate from its unreleased package version.
ARG OPENCLAW_COMMIT
ENV GIT_COMMIT=${OPENCLAW_COMMIT}
ENV OPENCLAW_BUILD_TIMESTAMP=2026-09-24T23:13:58Z
ENV OPENCLAW_PREFER_PNPM=1
WORKDIR /source
RUN --mount=type=secret,id=build-ca,required=false \
    set -eu; \
    if [ -f /run/secrets/build-ca ]; then export CURL_CA_BUNDLE=/run/secrets/build-ca; fi; \
    curl --fail --location --silent --show-error \
      "https://codeload.github.com/openclaw/openclaw/tar.gz/${GIT_COMMIT}" -o /tmp/openclaw-source.tar.gz; \
    echo '800e96a619db7fa2714be4432f705b72da823e75724a51b61bbb3482561145d6  /tmp/openclaw-source.tar.gz' | sha256sum --check --strict; \
    tar -xzf /tmp/openclaw-source.tar.gz --strip-components=1; \
    rm /tmp/openclaw-source.tar.gz
COPY deploy/runtime/codex-0.156.0.patch /tmp/codex.patch
RUN git apply /tmp/codex.patch
COPY scripts/build-runtime-assets.mjs /tmp/build-runtime-assets.mjs
RUN node /tmp/build-runtime-assets.mjs inputs /source /inputs

FROM ${NODE_BASE_IMAGE} AS openclaw-dependency-inputs
ARG OPENCLAW_COMMIT
ENV GIT_COMMIT=${OPENCLAW_COMMIT}
ENV OPENCLAW_BUILD_TIMESTAMP=2026-09-24T23:13:58Z
ENV OPENCLAW_PREFER_PNPM=1
WORKDIR /source
COPY --from=openclaw-source /inputs/ ./

FROM openclaw-dependency-inputs AS openclaw-build
# Keep package-store downloads out of retained layers; installed files remain.
RUN --mount=type=secret,id=build-ca,required=false \
    --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false \
    set -eu; \
    if [ -f /run/secrets/build-ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build-ca; fi; \
    corepack enable; \
    pnpm install --frozen-lockfile --store-dir=/tmp/pnpm-store \
      --config.supportedArchitectures.os=linux \
      --config.supportedArchitectures.cpu="$(node -p 'process.arch')" \
      --config.supportedArchitectures.libc=glibc; \
    rm -rf /tmp/pnpm-store
COPY --from=openclaw-source /source/ ./
# Follow the pinned upstream Docker assembly; plugin-local dependencies remain
# separate when a plugin and core require different versions.
RUN OPENCLAW_INTERNAL_DOCKER_BUILD_PLUGIN_IDS=codex,slack \
    OPENCLAW_RUN_NODE_SKIP_DTS_BUILD=1 pnpm_config_verify_deps_before_run=false \
    pnpm build:docker \
    && pnpm_config_verify_deps_before_run=false pnpm ui:build

FROM openclaw-dependency-inputs AS openclaw-production-deps
RUN --mount=type=secret,id=build-ca,required=false \
    --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false \
    set -eu; \
    if [ -f /run/secrets/build-ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build-ca; fi; \
    corepack enable; \
    pnpm install --frozen-lockfile --prod --store-dir=/tmp/pnpm-store \
      --config.supportedArchitectures.os=linux \
      --config.supportedArchitectures.cpu="$(node -p 'process.arch')" \
      --config.supportedArchitectures.libc=glibc; \
    node scripts/docker/verify-fs-safe-native.mjs --package-root /source --mode require; \
    rm -rf /tmp/pnpm-store

FROM openclaw-build AS openclaw-build-output
RUN rm -rf node_modules ui/node_modules \
    && find packages extensions -name node_modules -prune -exec rm -rf {} +

FROM openclaw-production-deps AS openclaw-runtime-assets
COPY --from=openclaw-build-output /source/ ./
RUN node scripts/postinstall-bundled-plugins.mjs \
    && OPENCLAW_EXTENSIONS=codex,slack node scripts/prune-docker-plugin-dist.mjs \
    && find dist -type f \( -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' -o -name '*.map' \) -delete \
    && if [ -L node_modules/@openclaw/ai ]; then \
      target="$(readlink -f node_modules/@openclaw/ai)"; \
      temporary="$(mktemp -d)"; \
      cp -a "$target" "$temporary/ai"; \
      rm node_modules/@openclaw/ai; \
      mv "$temporary/ai" node_modules/@openclaw/ai; \
      rmdir "$temporary"; \
    fi \
    && rm -rf node_modules/openclaw node_modules/.bin/openclaw node_modules/.pnpm/openclaw@*/node_modules/openclaw \
    && node scripts/check-package-dist-imports.mjs /source \
    && node scripts/docker/verify-fs-safe-native.mjs --package-root /source --mode require
# Bundled plugin chunks also live directly under dist and resolve dependencies
# from the package root. Link missing names there without replacing core versions.
RUN node --input-type=module <<'NODE'
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
for (const plugin of ["codex", "slack"]) {
  const root = resolve("dist/extensions", plugin);
  const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    const destination = resolve("node_modules", name);
    if (existsSync(destination)) continue;
    const source = realpathSync(resolve(root, "node_modules", name));
    mkdirSync(dirname(destination), { recursive: true });
    symlinkSync(relative(dirname(destination), source), destination);
  }
}
NODE
COPY --from=openclaw-source /tmp/codex.patch /tmp/codex.patch
COPY scripts/build-runtime-assets.mjs /tmp/build-runtime-assets.mjs
RUN --mount=type=bind,from=openclaw-source,source=/source/scripts,target=/verification/scripts \
    --mount=type=bind,from=openclaw-build,source=/source/node_modules,target=/verification/node_modules \
    node /tmp/build-runtime-assets.mjs package /source /out /tmp/codex.patch \
    && node /verification/scripts/check-package-dist-imports.mjs /source

FROM ${NODE_RUNTIME_BASE_IMAGE} AS runtime

ARG TARGETARCH
ENV OPENAI_CODEX_VERSION=0.156.0

ENV NODE_ENV=production
ENV PATH=/app/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

WORKDIR /app

RUN node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major !== 24 || minor < 16) throw new Error(`OpenClaw Enterprise runtime images require Node.js 24.16+; found ${process.version}.`);'

RUN apt-get update && apt-get install -y --no-install-recommends tini git ca-certificates curl openssh-client libstdc++6 libgomp1 python3 procps && rm -rf /var/lib/apt/lists/*
RUN --mount=type=secret,id=build-ca,required=false \
    set -eu; \
    if [ -f /run/secrets/build-ca ]; then export CURL_CA_BUNDLE=/run/secrets/build-ca; fi; \
    architecture="${TARGETARCH:-amd64}"; \
    case "$architecture" in amd64|arm64) ;; *) exit 1 ;; esac; \
    cd /tmp; \
    curl --fail --location --silent --show-error -O "https://github.com/cli/cli/releases/download/v2.100.0/gh_2.100.0_linux_${architecture}.tar.gz"; \
    curl --fail --location --silent --show-error -O "https://github.com/cli/cli/releases/download/v2.100.0/gh_2.100.0_checksums.txt"; \
    grep " gh_2.100.0_linux_${architecture}.tar.gz$" gh_2.100.0_checksums.txt | sha256sum --check --strict; \
    tar -xzf "gh_2.100.0_linux_${architecture}.tar.gz"; \
    install -m 0755 "gh_2.100.0_linux_${architecture}/bin/gh" /usr/local/bin/gh; \
    rm -rf /tmp/gh_2.100.0*; \
    /usr/bin/git --version; \
    /usr/local/bin/gh --version | grep '^gh version 2.100.0 '

COPY --from=openclaw-runtime-assets /out/ /opt/oce/runtime/
COPY --from=openclaw-runtime-assets /source/ /app/node_modules/openclaw/
# Both gateway plugins and the Dedicated Harness resolve the same pinned Codex.
RUN mkdir -p node_modules/.bin \
    && ln -s openclaw/node_modules/ws node_modules/ws \
    && ln -s ../openclaw/openclaw.mjs node_modules/.bin/openclaw \
    && ln -s ../openclaw/node_modules/@openai/codex/bin/codex.js node_modules/.bin/codex

COPY --from=codex-broker-cli-build /opt/oce-codex-broker /tmp/oce-codex-broker
COPY --from=codex-broker-cli-build /opt/oce-codex-broker.json /tmp/oce-codex-broker.json
RUN TARGETARCH="${TARGETARCH:-amd64}" node --input-type=module <<'NODE'
import { chmodSync, copyFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
const platformByArchitecture = {
  amd64: {
    packageName: "@openai/codex-linux-x64",
    packageDirectory: "codex-linux-x64",
    binaryPath: "vendor/x86_64-unknown-linux-musl/bin/codex",
  },
  arm64: {
    packageName: "@openai/codex-linux-arm64",
    packageDirectory: "codex-linux-arm64",
    binaryPath: "vendor/aarch64-unknown-linux-musl/bin/codex",
  },
};
const platform = platformByArchitecture[process.env.TARGETARCH];
if (!platform) {
  throw new Error(`Unsupported Codex runtime architecture: ${process.env.TARGETARCH}`);
}
const require = createRequire("/app/node_modules/openclaw/dist/extensions/codex/package.json");
const codexPackageRoot = dirname(require.resolve("@openai/codex/package.json"));
const platformBinary = resolve(codexPackageRoot, "..", platform.packageDirectory, platform.binaryPath);
copyFileSync("/tmp/oce-codex-broker", platformBinary);
chmodSync(platformBinary, 0o555);
const provenancePath = "/opt/oce/runtime/provenance.json";
const provenance = JSON.parse(readFileSync(provenancePath, "utf8"));
provenance.codexBrokerPolicy = {
  ...JSON.parse(readFileSync("/tmp/oce-codex-broker.json", "utf8")),
  architecture: process.env.TARGETARCH,
  package: platform.packageName,
  installedBinary: platformBinary,
};
writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
rmSync("/tmp/oce-codex-broker");
rmSync("/tmp/oce-codex-broker.json");
NODE

RUN mkdir -p node_modules/openclaw/dist/extensions ./plugin-skills /etc/openclaw /home/node/.codex/generated_images \
  && chown node:node /home/node/.codex /home/node/.codex/generated_images \
  && chmod 700 /home/node/.codex /home/node/.codex/generated_images \
  && cp -R node_modules/openclaw/dist/extensions/slack/skills/slack ./plugin-skills/slack \
  && ln -s node_modules/openclaw/openclaw.mjs ./openclaw.mjs \
  && ln -s node_modules/openclaw/dist ./dist \
  && cp -R node_modules/openclaw/skills ./skills \
  && find /app -type d ! -perm -0555 -exec chmod a+rx {} + \
  && find /app -type f ! -perm -0444 -exec chmod a+r {} + \
  && find /app -type f -perm /0111 ! -perm -0111 -exec chmod a+x {} + \
  && test -L /app/dist \
  && test -d /app/skills \
  && test ! -L /app/skills \
  && test -d /app/plugin-skills/slack \
  && test "$(stat -c '%U:%G:%a' /home/node/.codex)" = "node:node:700" \
  && test "$(stat -c '%U:%G:%a' /home/node/.codex/generated_images)" = "node:node:700" \
  && node /app/openclaw.mjs --version \
  && node -e 'if (typeof require("ws") !== "function") throw new Error("Runtime WebSocket dependency unavailable")' \
  && test "$(codex --version)" = "codex-cli ${OPENAI_CODEX_VERSION}" \
  && test -f /app/dist/extensions/codex/openclaw.plugin.json \
  && test -f /app/dist/extensions/slack/openclaw.plugin.json

COPY --from=repository-client-build /build/.build/repository-credentials/client/package.json /opt/oce/repository-credentials/package.json
COPY --from=repository-client-build /build/.build/repository-credentials/client/dist /opt/oce/repository-credentials/dist
COPY deploy/runtime/bin /opt/oce/repository-credentials/bin
RUN chmod -R a+rX /opt/oce/repository-credentials \
    && chmod 0555 /opt/oce/repository-credentials/bin/gh \
    && test -f /opt/oce/repository-credentials/dist/drivers/repo/github/credentials/client/router.js \
    && test -f /opt/oce/repository-credentials/dist/drivers/repo/github/credentials/client/native-git.js \
    && test -x /opt/oce/repository-credentials/dist/drivers/repo/github/credentials/client/hooks/pre-push \
    && /usr/bin/git config --system --add include.path /run/oce/repository-credentials/gitconfig

ARG OPENCLAW_COMMIT
ARG OCC_BUILD_REVISION=""
LABEL org.openclaw.image.revision=${OPENCLAW_COMMIT}
RUN node -e 'const fs = require("node:fs"); const provenance = JSON.parse(fs.readFileSync("/opt/oce/runtime/provenance.json", "utf8")); if (!/^[a-f0-9]{40}$/.test(process.argv[1]) || provenance.commit !== process.argv[1]) throw new Error("OpenClaw label must match packaged provenance");' "$OPENCLAW_COMMIT"
LABEL org.opencontainers.image.revision=${OCC_BUILD_REVISION}
RUN node -e 'const fs = require("node:fs"); const revision = process.argv[1]; if (revision && !/^[a-f0-9]{40}$/.test(revision)) throw new Error("Invalid OCE build revision"); fs.writeFileSync("/opt/oce/runtime/build.json", JSON.stringify({commit: revision || null}));' "$OCC_BUILD_REVISION"

USER node
