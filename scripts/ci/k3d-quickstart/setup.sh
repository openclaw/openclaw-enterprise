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

# Verify the bootstrap file in the same Agent workspace before and after onboarding.
revision=$(request GET "$base/agents/$agent" | jq -er .data.activeRevisionId)
agent_pod=$(kube -n "${TENANT_NAMESPACE:?}" get pods \
  -l "openclaw.dev/agent=$agent,openclaw.dev/revision=${revision:?}" -o json |
  jq -er '[.items[] | select(.metadata.deletionTimestamp == null and
    any(.status.containerStatuses[]?; .name == "agent" and .ready))] |
    select(length == 1) | first.metadata.name')
workspace_check() {
  kube -n "$TENANT_NAMESPACE" exec "$agent_pod" -c agent -- sh -c \
    'cd /sandbox/enterprise && test -x . && test "$@"' sh "$@"
}
workspace_check -f BOOTSTRAP.md

save_session
export agent namespace revision CONSOLE_ORIGIN
node scripts/ci/k3d-quickstart/browser.mjs onboard
workspace_check ! -e BOOTSTRAP.md
source "$RUN_DIR/setup-after-browser.sh"
