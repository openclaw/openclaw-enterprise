# Operators must select an approved, immutable Node 24 base image explicitly.
ARG NODE_BASE_IMAGE
ARG NODE_RUNTIME_BASE_IMAGE=docker.io/library/node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
FROM ${NODE_BASE_IMAGE} AS dependencies
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN node -e 'const [major, minor, patch] = process.versions.node.split(".").map(Number); if (major !== 24 || minor < 22 || (minor === 22 && patch < 1)) throw new Error(`Select a Node.js 24.22.1+ base image in the 24 series; found ${process.version}.`);'
COPY LICENSE package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/controller/package.json apps/controller/package.json
COPY packages/audit/package.json packages/audit/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/iam/package.json packages/iam/package.json
COPY packages/occ/package.json packages/occ/package.json
COPY packages/utils/package.json packages/utils/package.json
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false \
    corepack pnpm install --frozen-lockfile --prod --ignore-scripts

# The stamp needs only Node, so it starts from the runtime base image the runtime stage already
# uses. On the dependencies stage, every build that changed runtime source had to unpack the
# full build base and its dependencies just to rewrite one HTML file.
FROM ${NODE_RUNTIME_BASE_IMAGE} AS console-build
WORKDIR /app
ARG OCC_BUILD_REVISION=""
COPY apps/controller/src/console/index.html apps/controller/src/console/index.html
COPY scripts/build-console-metadata.mjs scripts/build-console-metadata.mjs
RUN node scripts/build-console-metadata.mjs "$OCC_BUILD_REVISION"

FROM dependencies AS development
ENV NODE_ENV=development
WORKDIR /app

COPY --chown=node:node package.json pnpm-workspace.yaml ./
COPY --chown=node:node packages packages
COPY --chown=node:node apps/controller apps/controller
COPY --from=console-build --chown=node:node /app/apps/controller/src/console/index.html apps/controller/src/console/index.html
COPY --chown=node:node migrations migrations
COPY --chown=node:node scripts scripts
COPY --chown=node:node deploy/presets deploy/presets
RUN mkdir -p /app/.development/configurations /var/lib/openclaw/bootstrap \
    && chown -R node:node /app/.development \
    && chown 1000:1000 /var/lib/openclaw/bootstrap \
    && chmod 0700 /var/lib/openclaw/bootstrap
# The route validators and serializers, precompiled with this image's Node and dependencies
# so the server loads them instead of compiling every schema at start
# (apps/controller/src/http/route-compilers.ts).
RUN node apps/controller/src/precompile-route-schemas.mjs

USER node
ENTRYPOINT ["node"]
CMD ["apps/controller/src/server.mjs"]

FROM ${NODE_RUNTIME_BASE_IMAGE} AS runtime
RUN node -e 'const [major, minor, patch] = process.versions.node.split(".").map(Number); if (major !== 24 || minor < 22 || (minor === 22 && patch < 1)) throw new Error(`Select a Node.js 24.22.1+ base image in the 24 series; found ${process.version}.`);'
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app

COPY --from=dependencies --chown=node:node /app/ ./
COPY --chown=node:node package.json pnpm-workspace.yaml ./
COPY --chown=node:node packages/audit/package.json packages/audit/package.json
COPY --chown=node:node packages/audit/src packages/audit/src
COPY --chown=node:node packages/contracts/package.json packages/contracts/package.json
COPY --chown=node:node packages/contracts/src packages/contracts/src
COPY --chown=node:node packages/iam/package.json packages/iam/package.json
COPY --chown=node:node packages/iam/src packages/iam/src
COPY --chown=node:node packages/occ/package.json packages/occ/package.json
COPY --chown=node:node packages/occ/src packages/occ/src
COPY --chown=node:node packages/utils/package.json packages/utils/package.json
COPY --chown=node:node packages/utils/src packages/utils/src
COPY --chown=node:node apps/controller/src apps/controller/src
COPY --from=console-build --chown=node:node /app/apps/controller/src/console/index.html apps/controller/src/console/index.html
COPY --chown=node:node migrations/[0-9]*.sql migrations/
COPY --chown=node:node migrations/meta/_journal.json migrations/meta/_journal.json
COPY --chown=node:node migrations/meta/_canonical-history.json migrations/meta/_canonical-history.json
COPY --chown=node:node scripts/migrate-production.mjs scripts/migrate-production.mjs
COPY --chown=node:node scripts/migration-history.mjs scripts/migration-history.mjs
COPY --chown=node:node scripts/migration-catalog.mjs scripts/migration-catalog.mjs
COPY --chown=node:node scripts/bootstrap-installation.mjs scripts/bootstrap-installation.mjs
COPY --chown=node:node scripts/lib/bootstrap-configuration.mjs scripts/lib/bootstrap-configuration.mjs
COPY --chown=node:node scripts/auth-maintain.mjs scripts/auth-maintain.mjs
COPY --chown=node:node scripts/lib/auth-maintain-arguments.mjs scripts/lib/auth-maintain-arguments.mjs
COPY --chown=node:node deploy/presets deploy/presets
COPY --chown=node:node scripts/production-healthcheck.mjs scripts/production-healthcheck.mjs
# As in the development stage: precompiled route validators and serializers for this image.
RUN node apps/controller/src/precompile-route-schemas.mjs

USER node
ENTRYPOINT ["node"]
CMD ["apps/controller/src/server.mjs"]
