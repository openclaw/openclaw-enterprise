#!/usr/bin/env bash
# Materialize the exact upstream plus the small reviewable request-exchange hook, then build locked.
set -euo pipefail
cd "$(dirname "$0")"
rev=bd8578548047307a71bf29a4f2791ec7c03ee8af
mkdir -p build-input
stage=$(mktemp -d "$PWD/build-input/stage.XXXXXXXX")
trap 'rm -rf "$stage"' EXIT
if [[ -z ${STRANDS_BOX_SOURCE:-} ]]; then
    git init -q "$stage/source"
    git -C "$stage/source" fetch --depth=1 https://github.com/strands-agents/box "$rev"
    source="$stage/source"
else
    source=$STRANDS_BOX_SOURCE
fi
mkdir "$stage/box"
git -C "$source" archive "$rev" | tar -x -C "$stage/box"
(cd "$stage/box" && patch --batch --fuzz=0 -p1 < "$OLDPWD/upstream/strands-box-request-exchange.patch")
rm -rf build-input/strands-box
mv "$stage/box" build-input/strands-box
case ${1:-build} in
    --prepare-only) ;;
    --test-guarded-exchange)
        # Exercise the proposed Box API on its pinned source, including cancellation of a real pending connect.
        # Box's workspace test dependencies resolve in build-input; the OCE sender itself always builds locked.
        cargo test --manifest-path build-input/strands-box/crates/egress-gateway/Cargo.toml \
            --features request-exchange --test effect_interception terminal_exchange
        ;;
    build) cargo build --locked --profile "${CARGO_PROFILE:-distribution}" ;;
    *) echo "usage: $0 [--prepare-only | --test-guarded-exchange]" >&2; exit 2 ;;
esac
