# Disposable SSH host using the same assembled runtime as Docker and Kubernetes.
ARG RUNTIME_IMAGE=localhost/openclaw-runtime:local
FROM ${RUNTIME_IMAGE} AS runtime
FROM docker.io/library/node:24-bookworm

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends systemd systemd-sysv openssh-server ca-certificates curl \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --system --create-home --home-dir /var/lib/openclaw --shell /usr/sbin/nologin openclaw

WORKDIR /opt/openclaw
COPY --from=runtime /app/node_modules ./node_modules
RUN ln -s node_modules/openclaw current \
  && chmod -R a+rX /opt/openclaw \
  && node /opt/openclaw/current/dist/index.js --version

RUN mkdir -p /run/sshd /root/.ssh \
  && chmod 700 /root/.ssh \
  && touch /root/.ssh/authorized_keys \
  && chmod 600 /root/.ssh/authorized_keys \
  && printf '%s\n' 'PermitRootLogin prohibit-password' 'PasswordAuthentication no' 'KbdInteractiveAuthentication no' > /etc/ssh/sshd_config.d/occ-fixture.conf \
  && systemctl enable ssh

EXPOSE 22
STOPSIGNAL SIGRTMIN+3
CMD ["/lib/systemd/systemd"]
