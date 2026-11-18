# Shared by the normal upgrade and explicit interrupted-preflight cleanup.
preflight_cleanup_error() {
  local resource=$1 errors=$2
  printf '%s\n%s\n' "${resource:0:300}:" "$errors" >>"$evidence_dir/preflight-cleanup.err"
  if [[ "$errors" == *"Precondition failed: UID in precondition"* ]]; then
    warn "could not confirm cleanup of ${resource:0:300}: an object with a different UID now holds this name, so it was left in place; see preflight-cleanup.err in the evidence directory."
  else
    warn "could not confirm cleanup of ${resource:0:300}: the delete request failed; see preflight-cleanup.err in the evidence directory."
  fi
}
# The API may return a replacement Job or Secret. Persist only its identity,
# never its contents. Empty successful output means absence; malformed or failed reads do not.
read_preflight_identity() {
  "${kube[@]}" --request-timeout=10s --namespace "$namespace" get "$1" \
    --ignore-not-found -o json 2>>"$evidence_dir/preflight-cleanup.err" |
    jq -cs '
      if length == 0 then empty
      elif length == 1 and (.[0].metadata.uid | type == "string" and length > 0)
      then {metadata: {uid: .[0].metadata.uid}}
      else error("invalid preflight identity") end
    ' >"$2" 2>/dev/null
}
cleanup_preflight() {
  local entry resource name uri delete_options errors uid deadline remaining child child_name child_uid
  local consumers_stopped=1 cleanup_failed=0
  ((preflight_consumer_unknown == 0)) || consumers_stopped=0
  # Stop controllers first. Foreground deletion keeps each Job until its dependent Pods end.
  for entry in ${preflight_resources[@]+"${preflight_resources[@]}"}; do
    resource=${entry%% *}
    [[ "$resource" == job.batch/* ]] || continue
    name=${resource#*/}
    delete_options=${entry#* }
    if ! uid=$(jq -er '.preconditions.uid' <<<"$delete_options") ||
      ! delete_options=$(jq -ce '.propagationPolicy = "Foreground"' <<<"$delete_options"); then
      printf 'Cannot build UID-guarded deletion for %s.\n' "$resource" >>"$evidence_dir/preflight-cleanup.err"
      consumers_stopped=0
      continue
    fi
    uri="/apis/batch/v1/namespaces/$namespace/jobs/$name"
    if ! errors=$("${kube[@]}" --request-timeout=15s delete --raw="$uri" -f - \
      <<<"$delete_options" 2>&1 >/dev/null); then
      # A prior cleanup may have deleted the original. Re-read instead of
      # interpreting kubectl's error text; child settlement is still required.
      if ! read_preflight_identity "$resource" "$evidence_dir/preflight-cleanup-job.json" ||
        [[ -s "$evidence_dir/preflight-cleanup-job.json" ]]; then
        preflight_cleanup_error "$resource" "$errors"
        consumers_stopped=0
        continue
      fi
    fi
    child_name= child_uid=
    for child in ${preflight_children[@]+"${preflight_children[@]}"}; do
      [[ "${child%% *}" == "$uid" ]] || continue
      child=${child#* }
      child_name=${child%% *}
      child_uid=${child#* }
    done
    deadline=$((SECONDS + 30))
    while true; do
      : >"$evidence_dir/preflight-cleanup-child.json"
      if ! read_preflight_identity "$resource" "$evidence_dir/preflight-cleanup-job.json" ||
        ! { "${kube[@]}" --request-timeout=10s --namespace "$namespace" get pods -o json \
          2>>"$evidence_dir/preflight-cleanup.err" |
          jq -ce --arg uid "$uid" 'if (.items | type) != "array" then error("invalid Pod inventory") else
            {items: [.items[] | select(
              .metadata.labels["batch.kubernetes.io/controller-uid"] == $uid or
              any(.metadata.ownerReferences[]?; .uid == $uid)
            ) | {metadata: (.metadata | {uid, name, namespace, ownerReferences})}]} end' \
          >"$evidence_dir/preflight-cleanup-pods.json" 2>>"$evidence_dir/preflight-cleanup.err"; }; then
        consumers_stopped=0
        break
      fi
      if [[ -n "$child_name" ]] && ! read_preflight_identity "pod/$child_name" \
        "$evidence_dir/preflight-cleanup-child.json"; then
        consumers_stopped=0
        break
      fi
      if ! remaining=$(node scripts/upgrade-startup-preflight.ts remaining \
        "$evidence_dir/preflight-cleanup-job.json" "$uid" "$evidence_dir/preflight-cleanup-pods.json" \
        "$evidence_dir/preflight-cleanup-child.json" "$child_uid" 2>>"$evidence_dir/preflight-cleanup.err"); then
        consumers_stopped=0
        break
      fi
      [[ "$remaining" != false ]] || break
      if ((SECONDS >= deadline)); then
        printf 'Timed out stopping %s and its child Pods.\n' "$resource" >>"$evidence_dir/preflight-cleanup.err"
        consumers_stopped=0
        break
      fi
      sleep 1
    done
  done
  if ((consumers_stopped == 0)); then
    warn "preflight Job or child Pod cleanup is unconfirmed; retained the candidate Secret and NetworkPolicy. Reconcile identities and preflight-cleanup.err before proceeding."
    preflight_resources=()
    return 1
  fi
  for entry in ${preflight_resources[@]+"${preflight_resources[@]}"}; do
    resource=${entry%% *}
    delete_options=${entry#* }
    name=${resource#*/}
    case "$resource" in
      job.batch/* | pod/*) continue ;;
      secret/*) uri="/api/v1/namespaces/$namespace/secrets/$name" ;;
      networkpolicy.networking.k8s.io/*)
        uri="/apis/networking.k8s.io/v1/namespaces/$namespace/networkpolicies/$name" ;;
    esac
    # Compare the original UID atomically; leave same-name replacements untouched.
    if ! errors=$("${kube[@]}" --request-timeout=15s delete --raw="$uri" -f - \
      <<<"$delete_options" 2>&1 >/dev/null); then
      if read_preflight_identity "$resource" "$evidence_dir/preflight-cleanup-dependency.json" &&
        [[ ! -s "$evidence_dir/preflight-cleanup-dependency.json" ]]; then
        continue
      fi
      preflight_cleanup_error "$resource" "$errors"
      cleanup_failed=1
      continue
    fi
    # DELETE acceptance is not disappearance: finalizers may retain the object.
    uid=$(jq -er '.preconditions.uid' <<<"$delete_options") || { cleanup_failed=1; continue; }
    deadline=$((SECONDS + 30))
    while true; do
      if ! read_preflight_identity "$resource" "$evidence_dir/preflight-cleanup-dependency.json"; then
        warn "could not confirm cleanup of ${resource:0:300}; see preflight-cleanup.err."
        cleanup_failed=1
        break
      fi
      [[ -s "$evidence_dir/preflight-cleanup-dependency.json" ]] || break
      if ! jq -e --arg uid "$uid" '.metadata.uid == $uid' \
        "$evidence_dir/preflight-cleanup-dependency.json" >/dev/null 2>>"$evidence_dir/preflight-cleanup.err"; then
        printf 'Cannot confirm original identity for %s after deletion.\n' "$resource" >>"$evidence_dir/preflight-cleanup.err"
        warn "could not confirm cleanup of ${resource:0:300}; original identity could not be verified."
        cleanup_failed=1
        break
      fi
      if ((SECONDS >= deadline)); then
        printf 'Timed out deleting %s.\n' "$resource" >>"$evidence_dir/preflight-cleanup.err"
        warn "could not confirm cleanup of ${resource:0:300}; deletion is still pending."
        cleanup_failed=1
        break
      fi
      sleep 1
    done
  done
  preflight_resources=()
  return "$cleanup_failed"
}
