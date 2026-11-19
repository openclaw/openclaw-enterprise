#!/bin/bash
set -euo pipefail
source "$(dirname "$0")/../common.sh"

IMAGE="${TEST_IMAGE:?TEST_IMAGE must be set}"
# The commit the image was built from; defaults to this checkout.
OCE_COMMIT="${OCE_COMMIT:-$(git -C "$(dirname "$0")" rev-parse HEAD)}"

assert_hummingbird_base "$IMAGE"

echo "=== OCE controller: Node.js ==="
assert_node_major "$IMAGE" 24
assert_node_min "$IMAGE" 24.22.1

echo "=== OCE controller: image layout ==="
REVISION=$(podman image inspect --format '{{index .Labels "org.opencontainers.image.revision"}}' "$IMAGE")
assert_ok "revision label matches OCE_COMMIT" test "$REVISION" = "$OCE_COMMIT"
VERSION_LABEL=$(podman image inspect --format '{{index .Labels "io.openshell.harness.version"}}' "$IMAGE")
assert_ok "harness version label matches OCE_COMMIT" test "$VERSION_LABEL" = "$OCE_COMMIT"
assert_ok "console carries the OCE build revision" podman run --rm "$IMAGE" -e \
    'const html = require("node:fs").readFileSync("/app/apps/controller/src/console/index.html", "utf8"); process.exit(html.includes(`<meta name="occ-build-revision" content="${process.argv[1]}" />`) ? 0 : 1)' "$OCE_COMMIT"
assert_ok "migrations are present" podman run --rm --entrypoint bash "$IMAGE" \
    -c 'compgen -G "/app/migrations/[0-9]*.sql" > /dev/null && test -f /app/migrations/meta/_journal.json'
assert_ok "Google Workspace plugin is installed" run_in "$IMAGE" \
    test -f /app/apps/controller/plugins/oce-google-workspace/ai.openclaw.oce/release.json
assert_ok "route compilers are precompiled" podman run --rm --entrypoint bash "$IMAGE" \
    -c 'test -s /app/apps/controller/dist/route-compilers.cjs'
assert_ok "presets are present" podman run --rm "$IMAGE" -e \
    'process.exit(require("node:fs").readdirSync("/app/deploy/presets").length > 0 ? 0 : 1)'
assert_ok "default console theme is bundled and readable" podman run --rm "$IMAGE" -e \
    'const fs = require("node:fs"); const dir = process.env.OCC_CONSOLE_THEME_DIR;
    if (dir !== "/etc/openclaw/console-theme") process.exit(1);
    const theme = JSON.parse(fs.readFileSync(`${dir}/theme.json`, "utf8"));
    process.exit(["logo", "favicon", "appleTouchIcon"].every((k) => fs.statSync(`${dir}/${theme[k]}`).isFile()) ? 0 : 1)'
assert_ok "no native addons" podman run --rm --entrypoint bash "$IMAGE" \
    -c 'test -z "$(find -L /app/node_modules -name "*.node" -type f -print -quit)"'

echo "=== OCE controller: non-root ==="
USERID=$(podman run --rm --entrypoint id "$IMAGE" -u)
assert_ok "UID is 1000" test "$USERID" = "1000"
PRIMARY_GID=$(podman run --rm --entrypoint id "$IMAGE" -g)
assert_ok "primary GID is 1000" test "$PRIMARY_GID" = "1000"
assert_ok "HOME is /home/node" podman run --rm --entrypoint bash "$IMAGE" -c 'test "$HOME" = /home/node'

echo "=== OCE controller: entry points with read-only root (Helm pod shape) ==="
run_controller() {
    podman run --rm --read-only --user 1000:1000 "$IMAGE" "$@" 2>&1 || true
}
assert_contains "API stops on missing configuration" \
    "$(run_controller apps/controller/src/server.mjs)" '"event":"startup-error"'
assert_contains "worker stops on missing database configuration" \
    "$(run_controller apps/controller/src/worker.mjs)" '"code":"DATABASE_CONFIGURATION_INVALID"'
assert_contains "migration job stops on missing database" \
    "$(run_controller scripts/migrate-production.ts)" '"event":"migration.failed"'
assert_contains "bootstrap job stops on missing auth secret" \
    "$(run_controller scripts/bootstrap-installation.mjs)" '"code":"AUTH_SECRET_INVALID"'
assert_contains "auth-maintain prints usage" \
    "$(run_controller scripts/auth-maintain.ts)" 'OCC_MIGRATION_DATABASE_URL'
assert_contains "worker healthcheck requires a readiness marker" \
    "$(run_controller scripts/production-healthcheck.ts worker)" 'readiness marker must be an explicit absolute path'

# Start the proxy and connect to it inside one container, so the check needs
# neither container logs nor host networking.
PROXY_OUTPUT=$(podman run --rm --read-only --user 1000:1000 --entrypoint bash "$IMAGE" -c '
    node apps/controller/src/slack-proxy.mjs &
    for _ in $(seq 1 30); do
        if node -e "require(\"node:net\").connect(3128, \"127.0.0.1\").on(\"connect\", () => process.exit(0)).on(\"error\", () => process.exit(1))"; then
            echo "connected to 3128"
            exit 0
        fi
        sleep 1
    done
    exit 1' 2>&1 || true)
assert_contains "Slack proxy starts listening" "$PROXY_OUTPUT" "Slack proxy listening on 3128"
assert_contains "Slack proxy accepts connections" "$PROXY_OUTPUT" "connected to 3128"
[[ "$PROXY_OUTPUT" == *"connected to 3128"* ]] || printf 'Slack proxy output:\n%s\n' "$PROXY_OUTPUT"
