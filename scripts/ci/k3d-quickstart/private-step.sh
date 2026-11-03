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
  grep -Ex 'Control UI verification failed during (initialize|launch trusted Chromium|sign in to Console|resolve the running revision|complete onboarding|verify Workspace identity and preference|verify ready reply|reopen original conversation from chat history|search signed-in session history|open matching session history row|verify original session selected|recall saved preference)\.|OCE REST request failed with HTTP [1-5][0-9]{2}' "$log" | tail -3 || true
  grep -Ex 'quickstart-location browser\.mjs:[0-9]{1,5}|Control UI navigation HTTP (0|[1-5][0-9]{2})' "$log" | tail -2 || true
  if [[ $phase == linear ]]; then
    node scripts/ci/k3d-quickstart/linear-evidence.mjs diagnose "$RUN_DIR" || true
    # Nested Bash blocks keep their visible examples in private files. Surface
    # only script locations; command text can contain credentials.
    grep -Eh '^quickstart-location (linear-(deploy|catalog|send|transcript)|operator-session)\.sh:[0-9]{1,5}$' \
      "$RUN_DIR"/linear-*.log 2>/dev/null | tail -5 || true
    if [[ -s "$RUN_DIR/session.sh" && -s "$RUN_DIR/requested-revision" ]]; then
      (
        source "$RUN_DIR/session.sh"
        revision=$(cat "$RUN_DIR/requested-revision")
        request GET "$base/agents/$agent/deployments/$revision" > "$RUN_DIR/linear-status.json" || exit 0
        jq -r '.data.status | select(.=="succeeded" or .=="running" or .=="failed" or .=="cancelled" or .=="pending") | "Linear deployment status: " + .' "$RUN_DIR/linear-status.json"
        # The API contract strips provider text. Only emit codes also present
        # in this checkout, never server messages, URLs, or response bodies.
        jq -r '.data | [(.warnings[]?.code), .error.code, .error.data.runtimeFailure.code,
          .error.data.runtimeFailure.cause.kind, .error.data.preparation.code] | .[] |
          strings | select(test("^[A-Z][A-Z0-9_]{2,63}$"))' "$RUN_DIR/linear-status.json" |
          while IFS= read -r code; do
            if git grep -q -F -e "\"$code\"" -- apps/controller/src packages/contracts/src; then printf 'Linear deployment: %s\n' "$code"; fi
          done
        # The disposable cluster has one tenant. Inspect the Gateway, Sandbox
        # supervisor and operator, including an earlier supervisor if retained.
        # Print only regional package hostnames, never paths or signed queries.
        for scope in "$TENANT_NAMESPACE:openshell.ai/boundary-role=supervisor" "$TENANT_NAMESPACE:openclaw.dev/agent=$agent" "$PLATFORM_NS:app.kubernetes.io/instance=openshell-gateway"; do
          kube -n "${scope%%:*}" logs -l "${scope#*:}" --all-containers --tail=4000 --prefix --ignore-errors=true
        done | grep -Ei 'den(y|ied)|block(ed)?|reject|403|download|failed to fetch' |
          grep -Eio 'sdmntpr[a-z]{2,25}[0-9]{0,2}\.oaiusercontent\.com' | sort -u |
          sed 's/^/Linear package host in diagnostic: /'
      ) 2>/dev/null || true
    fi
  fi
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
