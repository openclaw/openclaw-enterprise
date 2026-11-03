# Cluster setup records a pinned Envoy peer set and stages these helpers privately.
deployment_preflight() {
  local peers
  peers=$(bash "$RUN_DIR/kubernetes/trusted-envoy-peers.sh" "$RUN_DIR/kubeconfig") || return 1
  jq -e --argjson actual "$peers" '.==$actual' "$RUN_DIR/trusted-peers.json" >/dev/null
}
deployment_network() {
  local i git_service
  local git_option=""
  git_service=$(kube -n "$PLATFORM_NS" get service openclaw-enterprise-openshell-git --ignore-not-found -o name) || return 1
  if [[ -n $git_service ]]; then git_option=--repository-credentials; fi
  for ((i=0;i<120;i++)); do
    if python3 "$RUN_DIR/kubernetes/service-policies.py" --tenant "$TENANT_NAMESPACE" \
      --namespace-id "$namespace" --agent-id "$agent" ${git_option:+"$git_option"} > "$RUN_DIR/agent-service-peers.json"; then
      kube apply -f "$RUN_DIR/agent-service-peers.json"
      return $?
    fi
    sleep 3
  done
  printf 'Could not render service policies; inspect the recorded revision before retrying.\n' >&2
  return 1
}
repository_network() {
  python3 "$RUN_DIR/kubernetes/service-policies.py" --tenant "$TENANT_NAMESPACE" \
    --namespace-id "$namespace" --repository-credentials > "$RUN_DIR/protected-service-peers.json" || return 1
  kube apply -f "$RUN_DIR/protected-service-peers.json"
}
