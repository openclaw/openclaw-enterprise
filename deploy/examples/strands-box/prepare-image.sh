#!/usr/bin/env bash
# Assemble the context expected by deploy/runtime/strands-box/Dockerfile.
set -euo pipefail
if [[ $# -ne 1 || -z "$1" ]]; then
  echo 'Usage: bash prepare-image.sh NEW_CONTEXT_DIRECTORY' >&2
  exit 2
fi
if [[ "$(uname -s)/$(uname -m)" != Linux/aarch64 ]]; then
  echo 'The container-agent backend requires native Linux ARM64.' >&2
  exit 1
fi
revision=6e46f190d8f953f519ae03d47a342a95f8701beb
runtime=$(cd "$(dirname "$0")/../../runtime/strands-box" && pwd)
mkdir -- "$1"
context=$(cd -- "$1" && pwd)
scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT
git -C "$scratch" init -q
git -C "$scratch" fetch -q --depth=1 https://github.com/Kimiyu-186/box.git "$revision"
git -C "$scratch" checkout -q --detach FETCH_HEAD
test "$(git -C "$scratch" rev-parse HEAD)" = "$revision"
cd "$scratch"
target=aarch64-unknown-linux-gnu
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$scratch/target}"
cargo build --locked --release --target "$target" \
  --bin strands-box --bin strands-box-sock-alias --bin strands-box-contain-trampoline
install -m 0555 "$CARGO_TARGET_DIR/$target/release/"{strands-box,strands-box-sock-alias,strands-box-contain-trampoline} "$context/"
mkdir "$context/bridge"
install -m 0444 "$runtime"/*.mjs "$context/bridge/"
install -m 0444 "$runtime/Dockerfile" "$context/"
printf '%s\n' "$revision" > "$context/box-revision"
(cd "$context" && sha256sum Dockerfile box-revision bridge/*.mjs strands-box* > SHA256SUMS)
