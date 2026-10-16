#!/usr/bin/env bash
# Build a local image. Does not push it, contact a provider or load cluster credentials.
set -euo pipefail
cd "$(dirname "$0")/../.."
: "${1:?usage: build-image.sh <local-image:tag> [built-linux-binary]}"
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
binary=${2:-runtimes/strands-credential-proxy/target/distribution/strands-credential-proxy}
if [[ ! -f "$binary" && -z ${2:-} ]]; then
    runtimes/strands-credential-proxy/build-gateway.sh
fi
install -m 0555 "$binary" "$stage/strands-credential-proxy"
install -d -m 0755 "$stage/licenses"
cp -R deploy/strands-credential-proxy/licenses/. "$stage/licenses/"
find "$stage/licenses" -type d -exec chmod 0755 {} +
find "$stage/licenses" -type f -exec chmod 0644 {} +
docker build --tag "$1" -f deploy/strands-credential-proxy/Dockerfile "$stage"
