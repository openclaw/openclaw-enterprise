FROM docker.io/library/node:24-bookworm-slim AS base

FROM base AS build
WORKDIR /build
COPY server.mts probe.mts openclaw.mts ./
RUN node --input-type=module -e '\
    import { readFileSync, writeFileSync } from "node:fs"; \
    import { stripTypeScriptTypes } from "node:module"; \
    for (const name of process.argv.slice(1)) { \
      writeFileSync(`${name}.mjs`, stripTypeScriptTypes(readFileSync(`${name}.mts`, "utf8"))); \
    }' -- server probe openclaw

FROM base

# Compute starts runtime wrappers under tini, as the runtime image provides it.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/* \
    && test -x /usr/bin/tini

COPY --from=build --chown=node:node /build/server.mjs /build/probe.mjs /fixture/
COPY --from=build --chown=node:node /build/openclaw.mjs /app/openclaw.mjs

USER 1000:1000
EXPOSE 8080

CMD ["node", "/fixture/server.mjs"]
