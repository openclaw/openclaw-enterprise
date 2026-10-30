#!/usr/bin/env bash
# Materialize public Box source plus native transport and the protected exchange.
set -euo pipefail
cd "$(dirname "$0")"
revision=1ad7e987af6db807d66d896600c76a7d8d100b32
mkdir -p build-input
stage=$(mktemp -d "$PWD/build-input/stage.XXXXXXXX")
trap 'rm -rf "$stage"' EXIT
mkdir "$stage/box"
if [[ $# == 2 && $1 == --source ]]; then
    # A local object store is only a download cache; uncommitted files are never read.
    git -C "$2" archive "$revision" | tar -x -C "$stage/box"
elif [[ $# == 0 ]]; then
    curl --fail --location --proto '=https' --tlsv1.2 \
        "https://codeload.github.com/strands-agents/box/tar.gz/$revision" \
        --output "$stage/box.tar.gz"
    tar -xzf "$stage/box.tar.gz" --strip-components=1 -C "$stage/box"
else
    echo 'usage: prepare-box.sh [--source PUBLIC_BOX_OBJECT_STORE]' >&2
    exit 2
fi
patch --batch --fuzz=0 -d "$stage/box" -p1 < upstream/box-request-exchange.patch
# Replace only this script's generated input, never the optional source checkout.
if [[ -L build-input/box ]]; then
    rm build-input/box
else
    rm -rf build-input/box
fi
mv "$stage/box" build-input/box
printf 'Box source: %s\n' "$revision"
sha256sum upstream/box-request-exchange.patch
