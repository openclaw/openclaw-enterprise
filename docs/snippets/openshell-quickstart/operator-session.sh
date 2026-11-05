# Source from the private run directory after setting the documented session inputs.
# Commands target one recorded cluster, release and Agent. Credentials stay in files.
kube() {
  kubectl --kubeconfig "${KUBECONFIG:?}" --context "${CONTEXT:?}" "$@"
}
api_pod() {
  kube -n "$PLATFORM_NS" get pods \
    -l "app.kubernetes.io/instance=$RELEASE,app.kubernetes.io/component=api" -o json |
    jq -er '[.items[] | select(.metadata.deletionTimestamp==null and
      any(.status.containerStatuses[]?;.name=="api" and .ready))] |
      select(length==1) | first | [.metadata.name,.status.podIP] | @tsv'
}
_request() {
  local response_mode=$1 method=$2 path=$3 pod ip body_file
  shift 3
  body_file=$(mktemp "$RUN_DIR/request.XXXXXXXX") || return 1
  if (( $# == 0 )); then printf 'null' > "$body_file"
  elif (( $# == 2 )) && [[ $1 == --data-binary && $2 == @- ]]; then cat > "$body_file"
  elif (( $# == 2 )) && [[ $1 == --data ]]; then printf '%s' "$2" > "$body_file"
  else rm -f "$body_file"; return 2
  fi
  if ! read -r pod ip < <(api_pod); then rm -f "$body_file"; return 1; fi
  local rc=0
  jq -nc --arg method "$method" --arg path "$path" --arg ip "$ip" --arg mode "$response_mode" \
    --slurpfile key "$OCC_SERVICE_KEY_FILE" --slurpfile body "$body_file" \
    '{method:$method,path:$path,ip:$ip,key:$key[0].data.key,responseMode:$mode} +
      (if $body[0]==null then {} else {body:$body[0]} end)' |
    kube -n "$PLATFORM_NS" exec -i "$pod" -c api -- \
      node --input-type=module -e "$(cat "$RUN_DIR/request.mjs")" || rc=$?
  rm -f "$body_file"
  return "$rc"
}
request() { _request body "$@"; }
request_status() { _request status "$@"; }
turn() {
  local pod ip prompt
  prompt=$(cat "$1") || return 1
  read -r pod ip < <(api_pod) || return 1
  kube -n "$PLATFORM_NS" exec -i "$pod" -c api -- \
    env OCE_TEST_NAMESPACE_ID="$namespace" OCE_TEST_AGENT_ID="$agent" OCE_TEST_PROMPT="$prompt" \
    node --input-type=module < "$RUN_DIR/chat.mjs"
}
wait_deployment() {
  local revision=$1 result status attempt
  deployment_network || return 1
  for ((attempt=0;attempt<120;attempt++)); do
    result=$(request GET "$base/agents/$agent/deployments/$revision") || return 1
    status=$(jq -er .data.status <<<"$result") || return 1
    case "$status" in
      succeeded)
        test "$(request GET "$base/agents/$agent" | jq -er .data.activeRevisionId)" = "$revision"
        return $? ;;
      failed|cancelled)
        printf '%s\n' "$result" > "$RUN_DIR/failed-deployment.json"
        printf 'Deployment %s: %s\n' "$revision" "$status" >&2
        return 1 ;;
    esac
    sleep 5
  done
  printf 'Deployment %s is not confirmed. Read its state before retrying.\n' "$revision" >&2
  return 1
}
deploy_and_wait() {
  local revision
  deployment_preflight || return 1
  revision=$(request POST "$base/agents/$agent/deploy" | jq -er .data.id) || return 1
  printf '%s\n' "$revision" > "$RUN_DIR/requested-revision"
  wait_deployment "$revision"
}
upgrade_installation() {
  local evidence secret key installation checksum pod ip
  evidence=$(mktemp -d "$RUN_DIR/installation-upgrade.XXXXXXXX") || return 1
  printf 'Installation change evidence: %s\n' "$evidence"
  helm --kubeconfig "$KUBECONFIG" --kube-context "$CONTEXT" -n "$PLATFORM_NS" \
    get values "$RELEASE" --all -o json > "$evidence/live-values.json" || return 1
  secret=$(jq -er '.installation.secretName | strings | select(length>0)' "$evidence/live-values.json") || return 1
  key=$(jq -er '.installation.key | strings | select(length>0)' "$evidence/live-values.json") || return 1
  jq -e --arg secret "$secret" --arg key "$key" '
    (.installation.secretName // "occ-installation-startup") == $secret and
    (.installation.key // "installation.yaml") == $key' "$VALUES_FILE" >/dev/null || {
    printf 'Saved values do not match the installed Installation Secret binding.\n' >&2
    return 1
  }
  read -r pod ip < <(api_pod) || return 1
  kube -n "$PLATFORM_NS" get pod "$pod" -o json > "$evidence/api-pod.json" || return 1
  jq -e --arg secret "$secret" --arg key "$key" '
    any(.spec.volumes[]?; .name == "installation-startup" and
      .secret.secretName == $secret and
      any(.secret.items[]?; .key == $key and .path == "installation.yaml")) and
    any(.spec.containers[]?; .name == "api" and
      any(.env[]?; .name == "OCC_CONFIG_PATH" and
        .value == "/etc/openclaw/installation/installation.yaml") and
      any(.volumeMounts[]?; .name == "installation-startup" and
        .mountPath == "/etc/openclaw/installation"))' "$evidence/api-pod.json" >/dev/null || {
    printf 'Running API does not use the selected Installation Secret binding.\n' >&2
    return 1
  }
  installation=$(request GET /installation | jq -er '.data.id | strings | select(length>0)') || return 1
  kube -n "$PLATFORM_NS" get secret "$secret" -o json > "$evidence/secret-before.json" || return 1
  jq -e --arg installation "$installation" --arg key "$key" '
    ((.metadata.annotations // {} | has("openclaw.dev/installation-id") | not) or
      .metadata.annotations["openclaw.dev/installation-id"] == $installation) and
    (.metadata.uid | strings | length>0) and
    (.metadata.resourceVersion | strings | length>0) and
    (.data[$key] | strings | length>0) and .immutable != true' \
    "$evidence/secret-before.json" >/dev/null || {
    printf 'Installation Secret identity, data or mutability check failed.\n' >&2
    return 1
  }
  cp "$INSTALLATION_FILE" "$evidence/installation.yaml" || return 1
  checksum=$(sha256sum "$evidence/installation.yaml" | cut -d ' ' -f 1) || return 1
  jq --arg checksum "$checksum" '.controlPlane.installationChecksum=$checksum' "$VALUES_FILE" \
    > "$evidence/values.json" || return 1
  # UID and resourceVersion prevent a concurrent replacement or edit from accepting this patch.
  # Bind an unannotated initial Secret to the authenticated Installation; retain other contents.
  jq --arg installation "$installation" --arg key "$key" --rawfile document "$evidence/installation.yaml" '
    {metadata: {uid: .metadata.uid, resourceVersion: .metadata.resourceVersion,
       annotations: {"openclaw.dev/installation-id": $installation}},
     data: {($key): ($document | @base64)}}' "$evidence/secret-before.json" \
    > "$evidence/patch.json" || return 1
  kube -n "$PLATFORM_NS" patch secret "$secret" --type merge \
    --patch-file "$evidence/patch.json" -o json > "$evidence/secret-after.json" || return 1
  helm --kubeconfig "$KUBECONFIG" --kube-context "$CONTEXT" -n "$PLATFORM_NS" \
    upgrade "$RELEASE" "$OCE_CHART" -f "$evidence/values.json" --wait || {
    printf 'Installation Secret was patched; inspect the saved evidence before recovery or retry.\n' >&2
    return 1
  }
  cp "$evidence/values.json" "$VALUES_FILE" || return 1
  kube -n "$PLATFORM_NS" rollout status deployment/openclaw-enterprise-api || return 1
  kube -n "$PLATFORM_NS" rollout status deployment/openclaw-enterprise-worker
}
git_audit() {
  kube -n "$PLATFORM_NS" exec -i deployment/openclaw-enterprise-worker -c worker -- \
    node --input-type=module - "$namespace" "$agent" "$1" < "$RUN_DIR/git-revision-audit.mjs"
}
stop_and_retire() {
  local revision=$1 i
  request GET "$base/agents/$agent/repository-approvals" | jq -e '.data==[]' >/dev/null || return 1
  request GET "$base/agents/$agent" | jq -e --arg r "$revision" '.data.activeRevisionId==$r' >/dev/null || return 1
  request POST "$base/agents/$agent/stop" > "$RUN_DIR/git-stop.json" || return 1
  for ((i=0;i<100;i++)); do
    git_audit "$revision" > "$RUN_DIR/retirement-$revision.json" || return 1
    if jq -e 'any(.attempts[];.custody=="revoked" or .custody=="expired") and
      all(.attempts[];(.custody=="revoked" or .custody=="expired" or .custody=="not_issued") and (.sealed_present|not))' \
      "$RUN_DIR/retirement-$revision.json" >/dev/null && request GET "$base/agents/$agent" |
      jq -e '.data.desiredRuntimeState=="stopped" and .data.activeRevisionId==null' >/dev/null; then return 0; fi
    sleep 3
  done
  return 1
}
select_registry() {
  local registry=$1 permission=$2
  kube -n "$PLATFORM_NS" get cm "$registry" -o json |
    jq -e --arg ns "$namespace" --arg p "$permission" --arg ref "$ref" --arg repo "$repo" --arg id "$repo_id" '
      select(.immutable==true)|.data["registry.json"]|fromjson|.repositories|select(length==1)|first|
      select(.repositoryRef==$ref and .repository==$repo and (.repositoryId|tostring)==$id)|
      .namespaces|select(length==1)|first|.namespaceId==$ns and .profiles==["github-repository"] and
      .permissions=={metadata:"read",contents:$p}' >/dev/null || return 1
  helm --kubeconfig "$KUBECONFIG" --kube-context "$CONTEXT" -n "$PLATFORM_NS" \
    get values "$RELEASE" -o json |
    jq --arg r "$registry" '.repositoryCredentials.registryConfigMapName=$r' > "$VALUES_FILE" || return 1
  upgrade_installation || return 1
  deployment_preflight || return 1
  kube -n "$PLATFORM_NS" get pods \
    -l "app.kubernetes.io/instance=$RELEASE,app.kubernetes.io/component=worker" -o json |
    jq -e --arg r "$registry" '[.items[]|select(.metadata.deletionTimestamp==null)]|
      length>0 and all(.[];any(.status.conditions[]?;.type=="Ready" and .status=="True") and
        any(.spec.volumes[]?;.configMap.name==$r))'
}
save_session() {
  local variable
  {
    printf '%s\n' 'set -euo pipefail' 'set +x' 'umask 077'
    for variable in RUN_DIR PLATFORM KUBECONFIG CONTEXT PLATFORM_NS RELEASE OCE_CHART \
      INSTALLATION_FILE VALUES_FILE OCC_SERVICE_KEY_FILE CONSOLE_ORIGIN NATIVE_ADMIN_DOMAIN \
      namespace base agent principal modelSource name role MODEL TENANT_NAMESPACE \
      OCC_DEVELOPMENT_STATE_DIRECTORY CLUSTER_DOMAIN ENVOY_IMAGE EKS_CLUSTER AWS_REGION \
      repo repo_id ref READ_REGISTRY WRITE_REGISTRY branch first_sha BOT_NAME BOT_EMAIL; do
      if declare -p "$variable" >/dev/null 2>&1; then declare -p "$variable"; fi
    done
    printf 'source "$RUN_DIR/operator-session.sh"\nsource "$RUN_DIR/platform.sh"\n'
  } > "$RUN_DIR/session.sh"
  printf 'Resume in a fresh Bash shell:\nbash --noprofile --norc\nsource %q\n' "$RUN_DIR/session.sh"
}
