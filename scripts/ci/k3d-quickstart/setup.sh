#!/usr/bin/env bash
# Run only from a trusted release checkout. Execute the quickstart's Bash blocks
# in one operator shell so steps use precisely the variables established above.
set -euo pipefail
set +x
umask 077
: "${RUN_DIR:?}" "${MODEL:?}" "${CODEX_TOKEN_FILE:?}"
[[ -f $CODEX_TOKEN_FILE && -s $CODEX_TOKEN_FILE ]]
mkdir -p -m 700 "$RUN_DIR"
[[ -O $RUN_DIR && ! -L $RUN_DIR && ! -e $RUN_DIR/session.sh && ! -e $RUN_DIR/k3d-state ]]
install -m 600 docs/snippets/openshell-quickstart/plugin-network-policy.yaml "$RUN_DIR/artifacts.yaml"
install -m 600 docs/snippets/openshell-quickstart/configure-installation.mjs "$RUN_DIR/configure-installation.mjs"
source docs/snippets/openshell-quickstart/stage-session.sh
node scripts/ci/k3d-quickstart/setup-blocks.mjs "$RUN_DIR"
source "$RUN_DIR/setup-before-browser.sh"
save_session
export agent namespace revision CONSOLE_ORIGIN
node scripts/ci/k3d-quickstart/browser.mjs onboard
source "$RUN_DIR/setup-after-browser.sh"
