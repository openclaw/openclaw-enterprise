# Operators must select an approved, immutable Node 24 base image explicitly.
ARG NODE_BASE_IMAGE
ARG NODE_RUNTIME_BASE_IMAGE=docker.io/library/node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03
FROM ${NODE_BASE_IMAGE} AS dependencies

WORKDIR /app
RUN node -e "if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('The approved production base image must use Node.js 24.')"
COPY LICENSE package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/controller/package.json apps/controller/package.json
COPY packages/audit/package.json packages/audit/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/iam/package.json packages/iam/package.json
COPY packages/occ/package.json packages/occ/package.json
COPY packages/utils/package.json packages/utils/package.json
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false \
    corepack pnpm install --frozen-lockfile --prod --ignore-scripts

FROM dependencies AS console-build
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

USER node
ENTRYPOINT ["node"]
CMD ["apps/controller/src/server.mjs"]

FROM ${NODE_RUNTIME_BASE_IMAGE} AS runtime
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
COPY --chown=node:node migrations/meta/canonical-history.json migrations/meta/canonical-history.json
COPY --chown=node:node scripts/migrate-production.mjs scripts/migrate-production.mjs
COPY --chown=node:node scripts/migration-history.mjs scripts/migration-history.mjs
COPY --chown=node:node scripts/migration-catalog.mjs scripts/migration-catalog.mjs
COPY --chown=node:node scripts/bootstrap-installation.mjs scripts/bootstrap-installation.mjs
COPY --chown=node:node deploy/presets deploy/presets
COPY --chown=node:node scripts/production-healthcheck.mjs scripts/production-healthcheck.mjs

USER node
ENTRYPOINT ["node"]
CMD ["apps/controller/src/server.mjs"]
