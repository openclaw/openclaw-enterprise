#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077
source "${RUN_DIR:?}/session.sh"
revision=$(request GET "$base/agents/$agent" | jq -er '.data.activeRevisionId')
export agent namespace revision CONSOLE_ORIGIN
node scripts/ci/k3d-quickstart/browser.mjs final
