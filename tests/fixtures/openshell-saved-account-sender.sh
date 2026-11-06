#!/bin/sh
# This launcher lives next to the disposable native sender binary and SPIRE test bundle.
set -eu
dir=$(dirname "$0")
if [ "${1:-}" = jwt-bundle ]; then
  exec cat "$dir/jwt-bundle.json"
fi

sandbox_id=$(jq -er '.sandboxId | select(test("^[0-9a-f]{8}-[0-9a-f-]{27}$"))' "$OPENSHELL_TEST_BROKER_REQUEST")
export OPENSHELL_TEST_SPIFFE_SOCKET="$dir/$sandbox_id.sock"
test -S "$OPENSHELL_TEST_SPIFFE_SOCKET"
exec "$dir/supervisor-network-tests" --ignored --exact \
  l7::relay::occ_saved_account::external_stock_sender --nocapture
