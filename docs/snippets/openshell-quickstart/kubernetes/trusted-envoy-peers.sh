#!/usr/bin/env bash
# Print only the ready, pinned private Envoy data-plane Pod addresses for this installation.
set -euo pipefail
k=(kubectl --kubeconfig "${KUBECONFIG:?}" --context "${CONTEXT:?}" -n envoy-gateway-system)
selector=$("${k[@]}" get service occ-gateway-362888b35fce -o json |
  jq -er 'select(.metadata.labels["gateway.envoyproxy.io/owning-gateway-name"]=="oce-agent-gateways"
    and .metadata.labels["gateway.envoyproxy.io/owning-gateway-namespace"]=="oce-system") |
    .spec.selector | select(length>0) | to_entries | map(.key+"="+.value) | join(",")')
"${k[@]}" get pods -l "$selector" -o json |
  jq -ce --arg image "${ENVOY_IMAGE:?}" '
    [.items[] | select(.metadata.deletionTimestamp==null and any(.status.conditions[]?;.type=="Ready" and .status=="True"))] |
    if length>0 and all(.[];
      .metadata.labels["gateway.envoyproxy.io/owning-gateway-name"]=="oce-agent-gateways" and
      .metadata.labels["gateway.envoyproxy.io/owning-gateway-namespace"]=="oce-system" and
      any(.spec.containers[];.name=="envoy" and .image==$image) and
      (.status.podIP | test("^[0-9]+(\\.[0-9]+){3}$")))
    then map(.status.podIP+"/32") | unique
    else error("No verified ready Envoy peer set; inspect the data-plane rollout") end'
