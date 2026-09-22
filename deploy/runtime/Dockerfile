ARG NODE_BASE_IMAGE=docker.io/library/node:24-bookworm@sha256:934240a162082fd8b8a2f90cd5114446443f1eba1c5378f6687167ca405e6584
FROM ${NODE_BASE_IMAGE}

# TODO: Pin the OpenClaw release providing `plugins install --no-enable` before
# shipping managed plugin preparation; 2026.9.1 cannot preserve install policy.
ARG OPENCLAW_VERSION=2026.9.1
ARG OPENCLAW_CODEX_PLUGIN_VERSION=2026.9.1
ARG OPENCLAW_SLACK_PLUGIN_VERSION=2026.9.1
ARG OPENAI_CODEX_VERSION=0.152.1

ENV NODE_ENV=production
ENV PATH=/app/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

WORKDIR /app

RUN node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major !== 24 || minor < 15) throw new Error(`OpenClaw Enterprise runtime images require Node.js 24.15+; found ${process.version}.`);'

RUN npm init -y >/dev/null \
  && npm install --omit=dev --no-audit --no-fund \
    "openclaw@${OPENCLAW_VERSION}" \
    "@openclaw/codex@${OPENCLAW_CODEX_PLUGIN_VERSION}" \
    "@openclaw/slack@${OPENCLAW_SLACK_PLUGIN_VERSION}" \
    "@openai/codex@${OPENAI_CODEX_VERSION}" \
  && npm cache clean --force

RUN mkdir -p node_modules/openclaw/dist/extensions ./plugin-skills /etc/openclaw /home/node/.codex/generated_images \
  && chown node:node /home/node/.codex /home/node/.codex/generated_images \
  && chmod 700 /home/node/.codex /home/node/.codex/generated_images \
  && cp -R node_modules/@openclaw/codex node_modules/openclaw/dist/extensions/codex \
  && cp -R node_modules/@openclaw/slack node_modules/openclaw/dist/extensions/slack \
  && cp -R node_modules/@openclaw/slack/skills/slack ./plugin-skills/slack \
  && ln -s node_modules/openclaw/openclaw.mjs ./openclaw.mjs \
  && ln -s node_modules/openclaw/dist ./dist \
  && cp -R node_modules/openclaw/skills ./skills \
  && chmod -R a+rX /app \
  && test -L /app/dist \
  && test -d /app/skills \
  && test ! -L /app/skills \
  && test -d /app/plugin-skills/slack \
  && test "$(stat -c '%U:%G:%a' /home/node/.codex)" = "node:node:700" \
  && test "$(stat -c '%U:%G:%a' /home/node/.codex/generated_images)" = "node:node:700" \
  && node /app/openclaw.mjs --version \
  && codex --version \
  && test -f /app/dist/extensions/codex/openclaw.plugin.json \
  && test -f /app/dist/extensions/slack/openclaw.plugin.json

USER node
