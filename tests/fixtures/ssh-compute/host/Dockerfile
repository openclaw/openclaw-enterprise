# Disposable systemd host for the SSH Compute Driver real-host proof.
# Uses the runtime image's Node.js base so the host runs the same Node 24 on
# amd64 and arm64, with systemd as PID 1, sshd, an unprivileged openclaw
# account, and the pinned OpenClaw/Codex packages from deploy/runtime/Dockerfile.
FROM docker.io/library/node:24-bookworm

ARG OPENCLAW_VERSION=2026.9.1
ARG OPENCLAW_CODEX_PLUGIN_VERSION=2026.9.1
ARG OPENCLAW_SLACK_PLUGIN_VERSION=2026.9.1
ARG OPENAI_CODEX_VERSION=0.156.0
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends systemd systemd-sysv openssh-server ca-certificates curl \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --system --create-home --home-dir /var/lib/openclaw --shell /usr/sbin/nologin openclaw

WORKDIR /opt/openclaw
RUN npm init -y >/dev/null \
  && npm install --omit=dev --no-audit --no-fund \
    "openclaw@${OPENCLAW_VERSION}" \
    "@openclaw/codex@${OPENCLAW_CODEX_PLUGIN_VERSION}" \
    "@openclaw/slack@${OPENCLAW_SLACK_PLUGIN_VERSION}" \
    "@openai/codex@${OPENAI_CODEX_VERSION}" \
  && mkdir -p node_modules/openclaw/dist/extensions \
  && cp -R node_modules/@openclaw/codex node_modules/openclaw/dist/extensions/codex \
  && cp -R node_modules/@openclaw/slack node_modules/openclaw/dist/extensions/slack \
  && ln -s node_modules/openclaw current \
  && chmod -R a+rX /opt/openclaw \
  && node /opt/openclaw/current/dist/index.js --version \
  && npm cache clean --force

RUN mkdir -p /run/sshd /root/.ssh \
  && chmod 700 /root/.ssh \
  && touch /root/.ssh/authorized_keys \
  && chmod 600 /root/.ssh/authorized_keys \
  && printf '%s\n' 'PermitRootLogin prohibit-password' 'PasswordAuthentication no' 'KbdInteractiveAuthentication no' > /etc/ssh/sshd_config.d/occ-fixture.conf \
  && systemctl enable ssh

EXPOSE 22
STOPSIGNAL SIGRTMIN+3
CMD ["/lib/systemd/systemd"]
