#!/usr/bin/env bash
# Follow Delete Agent and Local cleanup in the same checkout as setup.
set -euo pipefail
umask 077
test "$RUN_DIR" = "$RUNNER_TEMP/oce-quickstart"
state="$RUN_DIR/k3d-state"
if [[ ! -f "$state/state.json" ]]; then
  # Setup can fail before it creates an installation. Detect a partial cluster
  # instead of deleting a cluster with an unconfirmed identity.
  k3d cluster list -o json | jq -e 'length == 0' >/dev/null
  exit 0
fi
cluster=$(jq -er '.cluster | select(test("^[a-z0-9][a-z0-9-]*$"))' "$state/state.json")
test "$(kubectl --kubeconfig "$state/kubeconfig" config current-context)" = "k3d-$cluster"
if [[ -f "$RUN_DIR/session.sh" ]]; then
  source "$RUN_DIR/session.sh"
  test "$PLATFORM" = local-k3d
  test "$OCC_DEVELOPMENT_STATE_DIRECTORY" = "$state"
  case "$(request_status GET "$base/agents/$agent")" in
    200)
      request DELETE "$base/agents/$agent" > /dev/null
      for ((i=0; i<120; i++)); do
        status=$(request_status GET "$base/agents/$agent")
        [[ "$status" != 404 ]] || break
        test "$status" = 200
        sleep 5
      done
      test "$status" = 404 ;;
    404) ;;
    *) exit 1 ;;
  esac
fi
env OCC_DEVELOPMENT_STATE_DIRECTORY="$state" OCC_DEVELOPMENT_COMPUTE_DRIVER=kubernetes \
  OCC_DEVELOPMENT_SANDBOX_DRIVER=openshell ./bin/occ dev down
test ! -e "$state"
k3d cluster list -o json | jq -e --arg cluster "$cluster" 'all(.[]; .name != $cluster)' > /dev/null
