#!/bin/bash
set -euo pipefail
source "$(dirname "$0")/../common.sh"

IMAGE="${TEST_IMAGE:?TEST_IMAGE must be set}"
# The commit the image was built from; defaults to this checkout.
OCE_COMMIT="${OCE_COMMIT:-$(git -C "$(dirname "$0")" rev-parse HEAD)}"

assert_hummingbird_base "$IMAGE"

echo "=== OCE runtime: Node.js ==="
assert_node_major "$IMAGE" 24
assert_node_min "$IMAGE" 24.22.1
assert_ok "/usr/local/bin/node runs" run_in "$IMAGE" /usr/local/bin/node --version
# OpenShell matches OCE's workspace-node-enrollment policy on the resolved executable path.
# OCE runs /usr/local/bin/node by absolute path and starts the runtime as `tini -- node` from PATH.
assert_ok "/usr/local/bin/node resolves to itself" run_in "$IMAGE" \
    /usr/local/bin/node -e 'process.exit(require("fs").readlinkSync("/proc/self/exe") === "/usr/local/bin/node" ? 0 : 1)'
assert_ok "node from the image PATH under tini resolves to /usr/local/bin/node" \
    podman run --rm --entrypoint "" "$IMAGE" /usr/bin/tini -s -- \
    node -e 'process.exit(require("fs").readlinkSync("/proc/self/exe") === "/usr/local/bin/node" ? 0 : 1)'
assert_ok "Intl.Segmenter handles non-ASCII graphemes without NODE_ICU_DATA" run_in "$IMAGE" node -e '
if (process.env.NODE_ICU_DATA) process.exit(1);
const fs = require("node:fs");
const dataDir = process.config.variables.icu_default_data;
const dataFile = `${dataDir}/icudt${process.versions.icu.split(".")[0]}l.dat`;
if (!fs.existsSync(dataFile)) process.exit(1);
const segments = [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment("👩🏽‍💻")];
if (segments.length !== 1) process.exit(1);
'

echo "=== OCE runtime: tools at OCE's hard-coded paths ==="
assert_ok "/usr/bin/tini runs" run_in "$IMAGE" /usr/bin/tini --version
assert_ok "/usr/bin/git runs" run_in "$IMAGE" /usr/bin/git --version
assert_ok "/usr/local/bin/gh runs" run_in "$IMAGE" /usr/local/bin/gh --version
assert_ok "/usr/bin/flock runs" run_in "$IMAGE" /usr/bin/flock --version
assert_ok "/usr/bin/prlimit runs" run_in "$IMAGE" /usr/bin/prlimit --version
assert_ok "/usr/bin/tar -czf round-trips" run_in "$IMAGE" \
    bash -c '/usr/bin/tar -czf - -C /etc hostname | /usr/bin/tar -tzf - | grep -qx hostname'
assert_ok "python3 runs" run_in "$IMAGE" python3 --version
assert_ok "ps (procps) present" run_in "$IMAGE" bash -c "command -v ps"
assert_ok "ssh client present" run_in "$IMAGE" bash -c "command -v ssh"
assert_ok "git includes repository-credentials config" run_in "$IMAGE" \
    bash -c '/usr/bin/git config --system --get-all include.path | grep -qx /run/oce/repository-credentials/gitconfig'
# README.md lists these as the paths to name in OpenShell policies, which never match a symlink.
for pinned in /usr/local/bin/node /usr/bin/git /usr/local/bin/gh /usr/bin/curl /usr/bin/python3.14; do
    assert_ok "${pinned} resolves to itself" run_in "$IMAGE" bash -c 'test -f "$1" && test "$(readlink -f "$1")" = "$1"' _ "$pinned"
done

echo "=== OCE runtime: OpenClaw and Codex ==="
OPENCLAW_COMMIT=$(podman image inspect --format '{{index .Labels "org.openclaw.image.revision"}}' "$IMAGE")
assert_ok "OpenClaw revision label is a full commit" bash -c '[[ "$1" =~ ^[0-9a-f]{40}$ ]]' _ "$OPENCLAW_COMMIT"
assert_ok "openclaw --version" podman run --rm "$IMAGE" node /app/openclaw.mjs --version
CODEX_VERSION=$(podman image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$IMAGE" |
    sed -n 's/^OPENAI_CODEX_VERSION=//p')
CODEX_OUTPUT=$(podman run --rm "$IMAGE" codex --version 2>&1 || true)
assert_ok "OPENAI_CODEX_VERSION is set" test -n "$CODEX_VERSION"
assert_ok "codex --version matches OPENAI_CODEX_VERSION" \
    grep -qxF "codex-cli ${CODEX_VERSION}" <<< "$CODEX_OUTPUT"
assert_ok "Codex plugin is bundled" podman run --rm "$IMAGE" test -f /app/dist/extensions/codex/openclaw.plugin.json
assert_ok "Slack plugin is bundled" podman run --rm "$IMAGE" test -f /app/dist/extensions/slack/openclaw.plugin.json
assert_ok "ws resolves from /app" podman run --rm "$IMAGE" \
    node -e 'if (typeof require("ws") !== "function") process.exit(1)'

echo "=== OCE runtime: image layout ==="
assert_ok "/app/openclaw.mjs and /app/dist are symlinks" podman run --rm "$IMAGE" \
    bash -c 'test -L /app/openclaw.mjs && test -L /app/dist'
assert_ok "windows-security-helper.exe ships next to the sealed dist" run_in "$IMAGE" \
    test -f /app/dist/windows-security-helper.exe
assert_ok "/app/skills is a real directory" podman run --rm "$IMAGE" \
    bash -c 'test -d /app/skills && test ! -L /app/skills'
assert_ok "/app/plugin-skills/slack exists" podman run --rm "$IMAGE" test -d /app/plugin-skills/slack
assert_ok "provenance matches the OpenClaw label" podman run --rm "$IMAGE" node -e \
    'const p = require("/opt/oce/runtime/provenance.json"); process.exit(p.commit === process.argv[1] ? 0 : 1)' "$OPENCLAW_COMMIT"
assert_ok "download clients are curl and node, without apt" podman run --rm "$IMAGE" node -e \
    'const c = require("/opt/oce/runtime/provenance.json").downloadClients; process.exit(Object.keys(c).sort().join() === "/usr/bin/curl,/usr/local/bin/node" ? 0 : 1)'
assert_ok "build.json records OCE_COMMIT" podman run --rm "$IMAGE" node -e \
    'const b = require("/opt/oce/runtime/build.json"); process.exit(b.commit === process.argv[1] ? 0 : 1)' "$OCE_COMMIT"
REVISION=$(podman image inspect --format '{{index .Labels "org.opencontainers.image.revision"}}' "$IMAGE")
assert_ok "revision label matches OCE_COMMIT" test "$REVISION" = "$OCE_COMMIT"
assert_ok "OCE Google skill ships with the managed Google CLI" run_in "$IMAGE" \
    test -f /usr/local/lib/oce/plugins/google/skills/oce-google/SKILL.md
assert_ok "managed Google CLI matches its release manifest" run_in "$IMAGE" node -e '
const root = "/usr/local/lib/oce/plugins/google";
const release = require(`${root}/release.json`);
const reported = require("node:child_process").execFileSync(`${root}/bin/${release.executable}`, ["--version"], { encoding: "utf8" });
process.exit(reported.split(/\s/, 1)[0] === `v${release.version}` ? 0 : 1);
'
assert_ok "repository-credentials client is installed" podman run --rm "$IMAGE" \
    test -x /opt/oce/repository-credentials/bin/gh
assert_ok "repository-credentials oce-github is installed" podman run --rm "$IMAGE" \
    test -x /opt/oce/repository-credentials/bin/oce-github

echo "=== OCE runtime: non-root ==="
USERID=$(podman run --rm "$IMAGE" id -u)
assert_ok "UID is 1000" test "$USERID" = "1000"
PRIMARY_GID=$(podman run --rm "$IMAGE" id -g)
assert_ok "primary GID is 1000" test "$PRIMARY_GID" = "1000"
assert_ok "/home/node/.codex is private to node" podman run --rm "$IMAGE" \
    bash -c 'test "$(stat -c "%U:%G:%a" /home/node/.codex)" = node:node:700'
assert_ok "no setuid or setgid files" podman run --rm --user 0 "$IMAGE" \
    bash -c 'found=$(find / -xdev -perm /6000 -type f) && test -z "$found"'

echo "=== OCE runtime: read-only root with tmpfs home (OCE pod shape) ==="
assert_ok "HOME is /home/node" podman run --rm "$IMAGE" bash -c 'test "$HOME" = /home/node'
READ_ONLY_OUTPUT=$(podman run --rm --read-only --user 1000:1000 \
    --mount type=tmpfs,destination=/home/node,tmpfs-mode=0700,U=true --tmpfs /tmp \
    "$IMAGE" /usr/bin/tini -- /usr/local/bin/node /app/openclaw.mjs --version 2>&1 || true)
assert_contains "openclaw starts with read-only rootfs" "$READ_ONLY_OUTPUT" "^OpenClaw "
