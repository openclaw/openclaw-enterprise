# Cluster setup records a pinned Envoy peer set and stages these helpers privately.
deployment_preflight() {
  local peers
  peers=$(bash "$RUN_DIR/kubernetes/trusted-envoy-peers.sh" "$RUN_DIR/kubeconfig") || return 1
  jq -e --argjson actual "$peers" '.==$actual' "$RUN_DIR/trusted-peers.json" >/dev/null
}
# Save each rendered set before applying it: kubectl may apply only part of a List.
apply_service_peers() {
  local record
  record=$(mktemp "$RUN_DIR/service-peers.XXXXXXXX") || return 1
  printf '%s\n' "$1" > "$record" && mv "$record" "$record.json" || return 1
  kube apply -f "$record.json"
}
delete_service_peers() {
  local record
  for record in "$RUN_DIR/agent-service-peers.json" "$RUN_DIR/protected-service-peers.json" "$RUN_DIR"/service-peers.*.json; do
    [[ -f $record ]] || continue
    kube delete -f "$record" --ignore-not-found || return 1
  done
}
deployment_network() {
  local i git_service rendered
  local git_option=""
  git_service=$(kube -n "$PLATFORM_NS" get service openclaw-enterprise-openshell-git --ignore-not-found -o name) || return 1
  if [[ -n $git_service ]]; then git_option=--repository-credentials; fi
  for ((i=0;i<120;i++)); do
    if rendered=$(python3 "$RUN_DIR/kubernetes/service-policies.py" --tenant "$TENANT_NAMESPACE" \
      --namespace-id "$namespace" --agent-id "$agent" ${git_option:+"$git_option"}); then
      apply_service_peers "$rendered"
      return $?
    fi
    sleep 3
  done
  printf 'Could not render service policies; inspect the recorded revision before retrying.\n' >&2
  return 1
}
repository_network() {
  local rendered
  rendered=$(python3 "$RUN_DIR/kubernetes/service-policies.py" --tenant "$TENANT_NAMESPACE" \
    --namespace-id "$namespace" --repository-credentials) || return 1
  apply_service_peers "$rendered"
}
