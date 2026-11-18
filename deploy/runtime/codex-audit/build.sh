#!/bin/sh
set -eu

version=0.164.0
revision=6aaac694803004a63c6f393d153c96d22521a6b9
source_sha=07197c09e577d0a4634bbfa3f451e012e4743430afe61b5925f6501c72b32f90
patch_sha=ea0e048e3d8833079d35a3fcf005f534531397ef33e5973af3be6dfe8879cba2
lock_sha=7ec2bfabf3b967c00409b85489076f8df3849745d3e469473d88288322adeb4a
build_lock_sha=bc5f7352658f51deace9dddb4bc404742b06c6402cc825b6d37051c008d989bd
v8_bindings_sha=3e4d5fecdbe0f98a6017e69d7ca82519a77fb032c5eb5e4cdbecdd3e2ec519d5
case "$2" in
  amd64)
    machine=x86_64
    v8_archive_sha=b3b490f2aa809eda7f6ac727f851fb00ce8355be72827577cfaac28c7137dbcd
    stock_package_sha=366ae46e0a22b62d4dadea055b3786652e0d69221e309f2b7394757c65ef6820
    ;;
  arm64)
    machine=aarch64
    v8_archive_sha=1054464a623006cdf5e25ae20877002bf3edb9a2c2f3e64f44a8714742b15e87
    stock_package_sha=54e96bde76977d5e761396a20f8506465075278c0522fcf26a33a8b77037da9e
    ;;
  *) exit 2 ;;
esac
test "$(dpkg --print-architecture)" = "$2"
target="${machine}-unknown-linux-gnu"
rustc --version | grep -q '^rustc 1\.99\.1 '

verify() {
  printf '%s  %s\n' "$1" "$2" | sha256sum --check --strict
}

fetch() {
  curl --fail --location --no-progress-meter --retry 6 --retry-all-errors "$1" -o "$3"
  verify "$2" "$3"
}

case "$1" in
  fetch)
    mkdir /codex-source /codex-inputs
    fetch "https://codeload.github.com/openai/codex/tar.gz/${revision}" "$source_sha" /tmp/codex.tar.gz
    tar -xzf /tmp/codex.tar.gz --strip-components=1 -C /codex-source
    rm /tmp/codex.tar.gz
    cd /codex-source
    patch=/codex-audit/provider-attempts.patch
    verify "$patch_sha" "$patch"
    git apply --whitespace=error-all "$patch"
    verify "$lock_sha" codex-rs/Cargo.lock
    # The upstream release sets the version in Cargo.toml. Normalize its lock
    # with the same exact resulting bytes as the reviewed release source build.
    python3 - "$version" <<'PY'
from pathlib import Path
import sys

lock = Path("codex-rs/Cargo.lock")
packages = lock.read_text().split("[[package]]")
for index, package in enumerate(packages):
    if "\nsource = " not in package:
        packages[index] = package.replace('\nversion = "0.0.0"\n', f'\nversion = "{sys.argv[1]}"\n', 1)
lock.write_text("[[package]]".join(packages))
PY
    verify "$build_lock_sha" codex-rs/Cargo.lock

    v8_url=https://github.com/openai/codex/releases/download/rusty-v8-v152.2.0
    v8_target="ptrcomp_sandbox_release_${target}"
    fetch "$v8_url/librusty_v8_${v8_target}.a.gz" "$v8_archive_sha" /codex-inputs/v8.a.gz
    fetch "$v8_url/src_binding_${v8_target}.rs" "$v8_bindings_sha" /codex-inputs/v8.rs
    stock_url="https://github.com/openai/codex/releases/download/rust-v${version}"
    fetch "$stock_url/codex-app-server-package-${machine}-unknown-linux-musl.tar.gz" "$stock_package_sha" /tmp/codex-stock.tar.gz
    tar -xOf /tmp/codex-stock.tar.gz codex-resources/bwrap > /tmp/codex-stock-bwrap
    test -s /tmp/codex-stock-bwrap
    sha256sum /tmp/codex-stock-bwrap | cut -d ' ' -f 1 > /codex-inputs/bwrap.sha256
    rm /tmp/codex-stock.tar.gz /tmp/codex-stock-bwrap

    cd codex-rs
    cargo fetch --locked --target "$target"
    ;;
  build)
    export RUSTY_V8_ARCHIVE=/codex-inputs/v8.a.gz
    export RUSTY_V8_SRC_BINDING_PATH=/codex-inputs/v8.rs
    export STABLE_GIT_COMMIT="$revision"
    CODEX_BWRAP_SHA256="$(cat /codex-inputs/bwrap.sha256)"
    export CODEX_BWRAP_SHA256
    cd /codex-source/codex-rs
    cargo build --locked --offline --release --target "$target" --package codex-app-server --bin codex-app-server
    mkdir /out
    strip --strip-debug -o /out/codex-app-server "$CARGO_TARGET_DIR/$target/release/codex-app-server"
    test "$(/out/codex-app-server --version)" = "codex-app-server $version"
    binary_sha="$(sha256sum /out/codex-app-server | cut -d ' ' -f 1)"
    cat > /out/provenance.json <<EOF
{
  "version": "$version",
  "sourceRevision": "$revision",
  "sourceArchiveSha256": "$source_sha",
  "patchSha256": "$patch_sha",
  "cargoLockSha256": "$build_lock_sha",
  "rustVersion": "1.99.1",
  "target": "$target",
  "v8ArchiveSha256": "$v8_archive_sha",
  "v8BindingsSha256": "$v8_bindings_sha",
  "stockPackageSha256": "$stock_package_sha",
  "bwrapSha256": "$CODEX_BWRAP_SHA256",
  "binarySha256": "$binary_sha"
}
EOF
    ;;
  *) exit 2 ;;
esac
