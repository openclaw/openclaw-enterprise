ARG NODE_BASE_IMAGE=node:24-bookworm@sha256:934240a162082fd8b8a2f90cd5114446443f1eba1c5378f6687167ca405e6584
FROM ${NODE_BASE_IMAGE}

ARG OPENCLAW_VERSION=2026.7.1
ARG OPENCLAW_CODEX_PLUGIN_VERSION=2026.7.1-1
ARG OPENAI_CODEX_VERSION=0.147.0

ENV NODE_ENV=production
ENV PATH=/app/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

WORKDIR /app

RUN node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major !== 24 || minor < 15) throw new Error(`OpenClaw Enterprise runtime images require Node.js 24.15+; found ${process.version}.`);'

RUN npm init -y >/dev/null \
  && npm install --omit=dev --no-audit --no-fund \
    "openclaw@${OPENCLAW_VERSION}" \
    "@openclaw/codex@${OPENCLAW_CODEX_PLUGIN_VERSION}" \
    "@openai/codex@${OPENAI_CODEX_VERSION}" \
  && npm cache clean --force

RUN mkdir -p node_modules/openclaw/dist/extensions ./plugin-skills /etc/openclaw \
  && cp -R node_modules/@openclaw/codex node_modules/openclaw/dist/extensions/codex \
  && ln -s node_modules/openclaw/openclaw.mjs ./openclaw.mjs \
  && ln -s node_modules/openclaw/dist ./dist \
  && cp -R node_modules/openclaw/skills ./skills \
  && chmod -R a+rX /app \
  && test -L /app/dist \
  && test -d /app/skills \
  && test ! -L /app/skills \
  && node /app/openclaw.mjs --version \
  && codex --version \
  && test -f /app/dist/extensions/codex/openclaw.plugin.json

USER node
