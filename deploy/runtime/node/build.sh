#!/bin/sh
set -eu

jobs=${NODE_BUILD_JOBS-4}
case "$jobs" in
  ""|0*|*[!0-9]*)
    echo "NODE_BUILD_JOBS must be a positive decimal integer without leading zeros" >&2
    exit 1
    ;;
esac

# TODO: Remove this source-build bridge after a pinned upstream Node release
# fixes worker termination during require(esm) and passes both native image lanes.
cd /build/node
./configure --with-intl=full-icu
# Build the executable and its dependencies, without unrelated cctest/embedtest targets.
make -C out BUILDTYPE=Release -j"$jobs" node PYTHON=/usr/bin/python3
sh /node-repair/test.sh /build/node/out/Release/node /build/node
mkdir -p /out/usr/local/bin /out/usr/local/share/oce-node
cp out/Release/node /out/usr/local/bin/node
cp /node-repair/source.json /out/usr/local/share/oce-node/source.json
out/Release/node --input-type=module - <<'NODE'
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const source = JSON.parse(readFileSync('/node-repair/source.json', 'utf8'));
const receipt = {
  source: 'https://github.com/nodejs/node',
  ...source,
  version: process.versions.node,
  architecture: process.arch,
  platform: process.platform,
  modules: process.versions.modules,
  napi: process.versions.napi,
  icu: process.versions.icu,
  executable: '/usr/local/bin/node',
  sha256: createHash('sha256').update(readFileSync(process.execPath)).digest('hex'),
};
writeFileSync('/out/usr/local/share/oce-node/provenance.json', `${JSON.stringify(receipt, null, 2)}\n`);
NODE
# Do not export compiler objects through BuildKit's intermediate layer cache.
# Slim verification mounts the unchanged source-only stage, not this build tree.
cd /
rm -rf /build/node
