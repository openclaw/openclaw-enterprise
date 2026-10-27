# OCE entrypoint linked to the matching, unmodified Codex host/runtime libraries.
# Context: oce-code-mode-host and the provider's proxy-preload.mjs.
ARG OCE_RUNTIME_IMAGE
FROM ${OCE_RUNTIME_IMAGE}
USER root
COPY --chmod=0555 oce-code-mode-host /app/node_modules/openclaw/node_modules/.pnpm/@openai+codex@0.163.0-alpha.2/node_modules/@openai/codex-linux-arm64/vendor/aarch64-unknown-linux-musl/bin/codex-code-mode-host
COPY --chmod=0444 proxy-preload.mjs /opt/oce/strands-box/proxy-preload.mjs
LABEL org.openai.codex.code-mode-source="a6274249d5877030676db098914db686bab7c921"
LABEL org.openclaw.code-mode.entrypoint="oce-interpreter"
USER node
