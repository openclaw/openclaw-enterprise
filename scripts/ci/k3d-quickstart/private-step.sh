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
# Record source locations without tracing command arguments or variable values.
if bash -E -c '
  location() { printf "quickstart-location %s:%d\n" "${1##*/}" "$2" >&2; }
  trap "location \"\${BASH_SOURCE[0]}\" \"\$LINENO\"" ERR
  source "$0"
' "scripts/ci/k3d-quickstart/$phase.sh" >"$log" 2>&1; then
  printf '%s passed.\n' "$phase"
else
  status=$?
  printf '::error::%s failed (exit %s).\n' "$phase" "$status"
  for diagnostic in 'no space left on device' 'ImagePullBackOff' 'CrashLoopBackOff' 'connection refused' 'context deadline exceeded' 'too many open files'; do
    if grep -Fqi -- "$diagnostic" "$log"; then printf 'Detected: %s\n' "$diagnostic"; fi
  done
  # Accept only known script names, numeric locations and fixed browser stage names.
  grep -Ex 'quickstart-location (setup|git|linear|browser-recall|git-cleanup|teardown|operator-session|setup-(before|after)-browser|git-guide-step|linear-(catalog|deploy|prompt|send|transcript))\.sh:[0-9]{1,5}' "$log" | tail -5 || true
  grep -Ex 'Control UI verification failed during (initialize|launch trusted Chromium|sign in to Console|resolve the running revision|complete onboarding|verify Workspace identity and preference|verify ready reply|reopen original conversation from chat history|recall saved preference)\.|OCE REST request failed with HTTP [1-5][0-9]{2}' "$log" | tail -3 || true
  # File presence distinguishes cluster bootstrap, model registration and Agent deployment.
  for milestone in k3d-state/state.json values.json model-source agent transport requested-revision session.sh; do
    if [[ -s "$RUN_DIR/$milestone" ]]; then printf 'Created: %s\n' "$milestone"; fi
  done
  if [[ -s "$RUN_DIR/failed-deployment.json" ]]; then
    # Print only codes documented by this checkout. Never print a provider message.
    grep -Eo '`[A-Z][A-Z0-9_]{3,}`' docs/reference/agents/deployment.md | tr -d '`' | sort -u |
      while IFS= read -r code; do
        if grep -Fq -- "$code" "$RUN_DIR/failed-deployment.json"; then printf 'Deployment: %s\n' "$code"; fi
      done
  fi
  if [[ -s "$RUN_DIR/k3d-state/kubeconfig" ]]; then
    kubectl --kubeconfig "$RUN_DIR/k3d-state/kubeconfig" --request-timeout=5s get events -A -o json 2>/dev/null |
      jq -r '[.items[] | select(.type=="Warning") | .reason | select(
        .=="FailedScheduling" or .=="FailedMount" or .=="FailedCreatePodSandBox" or
        .=="FailedAttachVolume" or .=="FailedCreate" or .=="BackOff" or .=="Unhealthy"
      )] | unique[] | "Kubernetes event: " + .' || true
  fi
  exit "$status"
fi
