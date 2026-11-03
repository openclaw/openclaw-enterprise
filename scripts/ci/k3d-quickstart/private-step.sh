#!/usr/bin/env bash
# The launcher prints its bootstrap credentials and tool failures can include
# provider output. Expose only the failing phase, exit code and static diagnoses.
set -euo pipefail
umask 077
case "${1:-}" in
  setup|git|linear|browser-recall|git-cleanup|teardown) phase=$1 ;;
  *) exit 2 ;;
esac
log="$RUNNER_TEMP/oce-credentials/$phase.log"
if bash "scripts/ci/k3d-quickstart/$phase.sh" >"$log" 2>&1; then
  printf '%s passed.\n' "$phase"
else
  status=$?
  printf '::error::%s failed (exit %s).\n' "$phase" "$status"
  for diagnostic in 'no space left on device' 'ImagePullBackOff' 'CrashLoopBackOff' 'connection refused' 'context deadline exceeded' 'too many open files'; do
    if grep -Fqi -- "$diagnostic" "$log"; then printf 'Detected: %s\n' "$diagnostic"; fi
  done
  exit "$status"
fi
