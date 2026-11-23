# Use this optional ARM64 image for a Codex Harness whose sandbox prohibits JIT.
# Build from the repository root with the OCE checkout that produced the runtime image.
ARG OCE_RUNTIME_IMAGE
ARG CODEX_SOURCE_COMMIT=6aaac694803004a63c6f393d153c96d22521a6b9
FROM docker.io/library/rust:1.99.1-slim-bookworm@sha256:b78cfbe4c0fd96b8a06b259092f1f412cb3ad3c5aed89d188bc40a1b8637f8f6 AS compiler
ARG CODEX_SOURCE_COMMIT
RUN apt-get update --error-on=any && apt-get install -y --no-install-recommends \
      ca-certificates clang cmake g++ git libclang-dev libssl-dev make pkg-config protobuf-compiler \
    && rm -rf /var/lib/apt/lists/* \
    && test "$(dpkg --print-architecture)" = arm64

ADD --checksum=sha256:07197c09e577d0a4634bbfa3f451e012e4743430afe61b5925f6501c72b32f90 https://codeload.github.com/openai/codex/tar.gz/${CODEX_SOURCE_COMMIT} /tmp/codex.tar.gz
WORKDIR /src
RUN tar -xzf /tmp/codex.tar.gz --strip-components=1 && rm /tmp/codex.tar.gz

# Use the sandbox-enabled V8 archive and matching bindings from the Codex release.
ADD --checksum=sha256:1054464a623006cdf5e25ae20877002bf3edb9a2c2f3e64f44a8714742b15e87 https://github.com/openai/codex/releases/download/rusty-v8-v152.2.0/librusty_v8_ptrcomp_sandbox_release_aarch64-unknown-linux-gnu.a.gz /v8/archive.a.gz
ADD --checksum=sha256:3e4d5fecdbe0f98a6017e69d7ca82519a77fb032c5eb5e4cdbecdd3e2ec519d5 https://github.com/openai/codex/releases/download/rusty-v8-v152.2.0/src_binding_ptrcomp_sandbox_release_aarch64-unknown-linux-gnu.rs /v8/binding.rs
ENV RUSTY_V8_ARCHIVE=/v8/archive.a.gz \
    RUSTY_V8_SRC_BINDING_PATH=/v8/binding.rs \
    RUSTUP_TOOLCHAIN=1.99.1-aarch64-unknown-linux-gnu
WORKDIR /src/codex-rs
COPY deploy/runtime/code-mode/main.rs code-mode-host/src/bin/oce-code-mode-host.rs
# The release tag stamps Cargo.toml while its lock still records local crates at 0.0.0.
# Check the entire normalized lock before building it, including all external pins.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/src/codex-rs/target \
    cargo update --workspace \
    && echo 'bc5f7352658f51deace9dddb4bc404742b06c6402cc825b6d37051c008d989bd  Cargo.lock' | sha256sum --check --strict \
    && cargo build --locked --release -p codex-code-mode-host --bin oce-code-mode-host \
    && mkdir /out && strip --strip-debug -o /out/codex-code-mode-host target/release/oce-code-mode-host

FROM ${OCE_RUNTIME_IMAGE}
ARG CODEX_SOURCE_COMMIT
USER root
RUN --mount=type=bind,from=compiler,source=/out,target=/out \
    CODEX_SOURCE_COMMIT="$CODEX_SOURCE_COMMIT" node --input-type=commonjs <<'JS'
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const root = "/app/node_modules/openclaw";
const app = createRequire(path.join(root, "package.json"));
const cli = app.resolve("@openai/codex/package.json");
const platform = createRequire(cli).resolve("@openai/codex-linux-arm64/package.json");
const target = "aarch64-unknown-linux-musl";
const vendor = path.join(path.dirname(platform), "vendor", target);
const metadata = require(path.join(vendor, "codex-package.json"));
if (require(cli).version !== "0.164.0" || metadata.version !== "0.164.0" ||
    metadata.target !== target || metadata.layoutVersion !== 1 ||
    metadata.resourcesDir !== "codex-resources") {
  throw new Error("The base runtime must contain the matching Codex 0.164.0 Linux ARM64 package");
}
const host = path.join(vendor, metadata.resourcesDir, "codex-code-mode-host");
fs.copyFileSync("/out/codex-code-mode-host", host, fs.constants.COPYFILE_EXCL);
fs.chmodSync(host, 0o555);
// The inventory below keeps this field and adds the host to contents.json.
const provenancePath = "/opt/oce/runtime/provenance.json";
const provenance = JSON.parse(fs.readFileSync(provenancePath, "utf8"));
provenance.codeModeHost = {
  source: "https://github.com/openai/codex",
  commit: process.env.CODEX_SOURCE_COMMIT,
  v8JitMode: "disabled",
  installedBinary: path.relative(fs.realpathSync(root), host),
  sha256: crypto.createHash("sha256").update(fs.readFileSync(host)).digest("hex"),
};
fs.writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
JS
# Refresh the final-image inventory with its owning script, as the base image does.
RUN --mount=type=bind,source=scripts/build-runtime-assets.ts,target=/tmp/build-runtime-assets.ts \
    --mount=type=bind,source=scripts/lib/openclaw-source.ts,target=/tmp/lib/openclaw-source.ts \
    --mount=type=bind,source=scripts/lib/runtime-download-clients.ts,target=/tmp/lib/runtime-download-clients.ts \
    --mount=type=bind,source=deploy/runtime/additional-download-clients.json,target=/tmp/additional-download-clients.json \
    node /tmp/build-runtime-assets.ts inventory /app/node_modules/openclaw /opt/oce/runtime \
      /tmp/additional-download-clients.json
USER node
RUN --network=none --mount=type=bind,source=deploy/runtime/code-mode/verify.mjs,target=/tmp/verify-code-mode.mjs \
    node /tmp/verify-code-mode.mjs
