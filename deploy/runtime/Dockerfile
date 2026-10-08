ARG OPENCLAW_COMMIT=90d30a1178a79dddd92e6190b66b95d89dfb3ca8
ARG NODE_BASE_IMAGE=docker.io/library/node:24-bookworm@sha256:934240a162082fd8b8a2f90cd5114446443f1eba1c5378f6687167ca405e6584
ARG NODE_RUNTIME_BASE_IMAGE=docker.io/library/node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03

# The credential client build needs only Node and pnpm. The slim runtime base
# is already in the final image, so a CI build whose controller sources changed
# does not also fetch the full build base from the layer cache.
FROM ${NODE_RUNTIME_BASE_IMAGE} AS repository-client-build

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

# Build the service from the same checkout as the runtime client. Keep the
# service closure separate from the Agent runtime and its unprivileged client.
FROM ${NODE_BASE_IMAGE} AS repository-credentials-service
WORKDIR /app
COPY --from=repository-client-build /build/.build/repository-credentials/service/package.json ./package.json
COPY --from=repository-client-build /build/.build/repository-credentials/service/dist ./dist
RUN chmod -R a=rX /app
USER node
ENTRYPOINT ["node", "/app/dist/repository-credentials.js"]

FROM ${NODE_BASE_IMAGE} AS openclaw-source

# Keep the source identity separate from its unreleased package version.
ARG OPENCLAW_COMMIT
ENV GIT_COMMIT=${OPENCLAW_COMMIT}
ENV OPENCLAW_BUILD_TIMESTAMP=2026-10-07T22:05:23Z
ENV OPENCLAW_PREFER_PNPM=1
WORKDIR /source
RUN --mount=type=secret,id=build-ca,required=false \
    set -eu; \
    if [ -f /run/secrets/build-ca ]; then export CURL_CA_BUNDLE=/run/secrets/build-ca; fi; \
    curl --fail --location --silent --show-error \
      "https://codeload.github.com/openclaw/openclaw/tar.gz/${GIT_COMMIT}" -o /tmp/openclaw-source.tar.gz; \
    echo 'c56ea921a033efd95c2c9e43e4255c675939b0aa927c6aaf5bbdb51d5b693a8b  /tmp/openclaw-source.tar.gz' | sha256sum --check --strict; \
    tar -xzf /tmp/openclaw-source.tar.gz --strip-components=1; \
    rm /tmp/openclaw-source.tar.gz
# TODO: Remove this bridge patch when OpenClaw supports networkProxy.readOnlyPaths.
COPY deploy/runtime/openclaw-codex-read-only-paths.patch /tmp/openclaw-codex-read-only-paths.patch
RUN echo '1d8b670e7029872262375a21da7222768c2fe2390ff7a159ed1616ee9c9de1ca  /tmp/openclaw-codex-read-only-paths.patch' | sha256sum --check --strict \
    && git apply /tmp/openclaw-codex-read-only-paths.patch
# TODO: Remove this bridge patch when OpenClaw `connect --ephemeral` accepts an expired
# replayed setup code for a node whose saved device token can reconnect.
COPY deploy/runtime/openclaw-connect-ephemeral-expired-setup.patch /tmp/openclaw-connect-ephemeral-expired-setup.patch
RUN echo 'c57722da9a88ec4295577ab9a9ba6e2ca37fceda11ce8b51b08ee1425e00851f  /tmp/openclaw-connect-ephemeral-expired-setup.patch' | sha256sum --check --strict \
    && git apply /tmp/openclaw-connect-ephemeral-expired-setup.patch
COPY scripts/build-runtime-assets.mjs /tmp/build-runtime-assets.mjs
RUN node /tmp/build-runtime-assets.mjs inputs /source /inputs

# @matrix-org/matrix-sdk-crypto-nodejs downloads its native library from GitHub during
# install, with no retry or checksum. Fetch the pinned library with the retrying,
# checksum-verifying helper; both installs below get it from a loopback server.
FROM ${NODE_BASE_IMAGE} AS matrix-sdk-crypto
COPY scripts/ci/download-pinned.sh /tmp/download-pinned.sh
RUN --mount=type=secret,id=build-ca,required=false \
    set -eu; \
    if [ -f /run/secrets/build-ca ]; then export CURL_CA_BUNDLE=/run/secrets/build-ca; fi; \
    case "$(node -p 'process.arch')" in \
      x64) library=matrix-sdk-crypto.linux-x64-gnu.node; sha256=aeb21029ac6bb29cd06493f67b19a5a75b3d0371a1ab452fe59f78249350f0f7 ;; \
      arm64) library=matrix-sdk-crypto.linux-arm64-gnu.node; sha256=c43c347f39786ee9f2d11b5ae3088d182c1a81636f2b68dc2297fe6716be2891 ;; \
      *) echo "Unsupported architecture for matrix-sdk-crypto: $(node -p 'process.arch')" >&2; exit 1 ;; \
    esac; \
    mkdir -p /out/v0.6.6; \
    bash /tmp/download-pinned.sh \
      "https://github.com/matrix-org/matrix-rust-sdk-crypto-nodejs/releases/download/v0.6.6/${library}" \
      "/out/v0.6.6/${library}" "$sha256"

FROM ${NODE_BASE_IMAGE} AS openclaw-dependency-inputs
ARG OPENCLAW_COMMIT
ENV GIT_COMMIT=${OPENCLAW_COMMIT}
ENV OPENCLAW_BUILD_TIMESTAMP=2026-10-07T22:05:23Z
ENV OPENCLAW_PREFER_PNPM=1
WORKDIR /source
COPY --from=openclaw-source /inputs/ ./
# Copy the public helper rather than binding a context file on enforcing hosts.
COPY deploy/runtime/with-pinned-matrix-sdk-crypto.mjs /tmp/with-pinned-matrix-sdk-crypto.mjs

FROM openclaw-dependency-inputs AS openclaw-build
# Keep package-store downloads out of retained layers; installed files remain.
RUN --mount=type=secret,id=build-ca,required=false \
    --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false \
    --mount=type=bind,from=matrix-sdk-crypto,source=/out,target=/tmp/matrix-sdk-crypto \
    set -eu; \
    if [ -f /run/secrets/build-ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build-ca; fi; \
    corepack enable; \
    node /tmp/with-pinned-matrix-sdk-crypto.mjs /tmp/matrix-sdk-crypto \
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
    --mount=type=bind,from=matrix-sdk-crypto,source=/out,target=/tmp/matrix-sdk-crypto \
    set -eu; \
    if [ -f /run/secrets/build-ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build-ca; fi; \
    corepack enable; \
    node /tmp/with-pinned-matrix-sdk-crypto.mjs /tmp/matrix-sdk-crypto \
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
COPY scripts/build-runtime-assets.mjs /tmp/build-runtime-assets.mjs
RUN --mount=type=bind,from=openclaw-source,source=/source/scripts,target=/verification/scripts \
    --mount=type=bind,from=openclaw-build,source=/source/node_modules,target=/verification/node_modules \
    node /tmp/build-runtime-assets.mjs package /source /out \
    && node /verification/scripts/check-package-dist-imports.mjs /source

FROM ${NODE_RUNTIME_BASE_IMAGE} AS runtime

ARG TARGETARCH
ENV OPENAI_CODEX_VERSION=0.160.0

ENV NODE_ENV=production
# Keep local npm commands from issuing unrelated background update requests.
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
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

COPY scripts/build-runtime-assets.mjs /tmp/build-runtime-assets.mjs

RUN mkdir -p node_modules/openclaw/dist/extensions ./plugin-skills /etc/openclaw /home/node/.codex/generated_images \
  && chown node:node /home/node/.codex /home/node/.codex/generated_images \
  && chmod 700 /home/node/.codex /home/node/.codex/generated_images \
  && cp -R node_modules/openclaw/dist/extensions/slack/skills/. ./plugin-skills/ \
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
  && test -f /app/plugin-skills/block-kit/references/official-block-kit.md \
  && test "$(stat -c '%U:%G:%a' /home/node/.codex)" = "node:node:700" \
  && test "$(stat -c '%U:%G:%a' /home/node/.codex/generated_images)" = "node:node:700" \
  && node /app/openclaw.mjs --version \
  && node -e 'if (typeof require("ws") !== "function") throw new Error("Runtime WebSocket dependency unavailable")' \
  && test "$(codex --version)" = "codex-cli ${OPENAI_CODEX_VERSION}" \
  && test -f /app/dist/extensions/codex/openclaw.plugin.json \
  && test -f /app/dist/extensions/slack/openclaw.plugin.json \
  && node /tmp/build-runtime-assets.mjs inventory /app/node_modules/openclaw /opt/oce/runtime \
  && rm /tmp/build-runtime-assets.mjs

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
