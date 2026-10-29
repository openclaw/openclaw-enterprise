#!/usr/bin/env bash
# Assemble local native executables from one prepared tree with locked dependencies.
set -euo pipefail
export CARGO_INCREMENTAL=0
export CARGO_PROFILE_DEV_DEBUG=0
export CARGO_BUILD_JOBS=2
cd "$(dirname "$0")"
if [[ $# != 1 ]]; then
    echo 'usage: package-native.sh OUTPUT_DIRECTORY' >&2
    exit 2
fi
output=$(realpath -m "$1")
test -f build-input/box/crates/box/src/lib.rs
cargo build --locked --features native-launcher --bin oce-protected-box
cargo build --locked --manifest-path build-input/box/Cargo.toml --target-dir "$PWD/target/box" -p strands-box --bin strands-box --bin strands-box-sock-alias
cargo build --locked --manifest-path build-input/box/Cargo.toml --target-dir "$PWD/target/box" -p strands-box-containment --bin strands-box-contain-trampoline
mkdir -p "$output"
install -m 0755 target/debug/oce-protected-box "$output/oce-protected-box"
for binary in strands-box strands-box-sock-alias strands-box-contain-trampoline; do
    install -m 0755 "target/box/debug/$binary" "$output/$binary"
done
sha256sum Cargo.lock build-input/box/Cargo.lock upstream/box-request-exchange.patch > "$output/build-inputs.sha256"
(cd "$output" && sha256sum oce-protected-box strands-box strands-box-sock-alias strands-box-contain-trampoline > binaries.sha256)
