ARG NODE_BASE_IMAGE=node:24-bookworm
FROM ${NODE_BASE_IMAGE}

WORKDIR /app
COPY ws /app/node_modules/ws
COPY openclaw.mjs /app/openclaw.mjs
COPY codex.mjs /app/codex.mjs
COPY provenance.json /opt/oce/runtime/provenance.json

RUN ln -s /app/codex.mjs /usr/local/bin/codex && chmod 755 /app/codex.mjs && mkdir -p /app/skills
