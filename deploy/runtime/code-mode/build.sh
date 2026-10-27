#!/bin/sh
set -eu

if [ "$#" -ne 2 ]; then
  echo "usage: build.sh CODEX_STAGING_SOURCE ARTIFACT_DIRECTORY" >&2
  exit 2
fi
source_root=$(cd "$1" && pwd)
mkdir -p "$2"
artifacts=$(cd "$2" && pwd)
entrypoint=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/main.rs
target="$source_root/codex-rs/code-mode-host/src/bin/oce-code-mode-host.rs"
if [ -e "$target" ] && ! cmp -s "$entrypoint" "$target"; then
  echo "refusing to overwrite another code-mode entrypoint" >&2
  exit 1
fi

# Cargo discovers this OCE-owned binary without changes to upstream manifests,
# libraries, or the native host entrypoint. Use a staging source tree.
mkdir -p "$(dirname "$target")"
cp "$entrypoint" "$target"
cd "$source_root/codex-rs"
cargo build --locked --release -p codex-code-mode-host --bin oce-code-mode-host
cp "${CARGO_TARGET_DIR:-target}/release/oce-code-mode-host" "$artifacts/oce-code-mode-host.unstripped"
cp "$artifacts/oce-code-mode-host.unstripped" "$artifacts/oce-code-mode-host"
strip --strip-debug "$artifacts/oce-code-mode-host"
