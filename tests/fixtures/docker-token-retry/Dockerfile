ARG NODE_BASE_IMAGE=node:24-bookworm
FROM ${NODE_BASE_IMAGE} AS base

FROM base AS build
WORKDIR /build
COPY openclaw.mts codex.mts ./
RUN node --input-type=module -e '\
    import { readFileSync, writeFileSync } from "node:fs"; \
    import { stripTypeScriptTypes } from "node:module"; \
    for (const name of process.argv.slice(1)) { \
      writeFileSync(`${name}.mjs`, stripTypeScriptTypes(readFileSync(`${name}.mts`, "utf8"))); \
    }' -- openclaw codex

FROM base

WORKDIR /app
COPY ws /app/node_modules/ws
COPY --from=build /build/openclaw.mjs /build/codex.mjs /app/
COPY --chmod=644 provenance.json /opt/oce/runtime/provenance.json

# The Driver runs as UID 1000 even when the build context has private host modes.
RUN chmod 755 /opt/oce /opt/oce/runtime \
    && chmod -R a+rX /app/node_modules/ws \
    && ln -s /app/codex.mjs /usr/local/bin/codex \
    && chmod 755 /app/codex.mjs \
    && mkdir -p /app/skills
