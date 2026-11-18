#!/bin/sh
set -eu

cd /node-repair
version=$(node -p 'require("./source.json").version')
test "$(node -p 'process.versions.node')" = "$version" || {
  echo "The Node termination repair requires matching Node $version bases; review newer overrides before changing the source pin." >&2
  exit 1
}
. /etc/os-release
test "$VERSION_CODENAME" = bookworm
mkdir -p /build/node
curl --fail --location --silent --show-error --retry 6 --retry-all-errors \
  --retry-max-time 600 --max-time 300 \
  "https://nodejs.org/dist/v$version/node-v$version.tar.xz" -o /build/node.tar.xz
archive_sha=$(node -p 'require("./source.json").sourceArchiveSha256')
patch_sha=$(node -p 'require("./source.json").patchSha256')
printf '%s  /build/node.tar.xz\n%s  worker-esm-termination.patch\n' "$archive_sha" "$patch_sha" | sha256sum --check --strict
tar -xJf /build/node.tar.xz -C /build/node --strip-components=1
rm /build/node.tar.xz
cd /build/node
git apply /node-repair/worker-esm-termination.patch
