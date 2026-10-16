#!/usr/bin/env bash
# Run on an isolated Linux Docker host. No model key, cloud account or current kube context is needed.
set -euo pipefail
umask 077
cd "$(dirname "$0")/../.."
run="strands-proxy-$(date -u +%m%d%H%M)-$(od -An -N3 -tx1 /dev/urandom | tr -d ' ')"
k3d=${K3D:-k3d}
node_image=${STRANDS_QUAL_NODE_IMAGE:-node:24-bookworm}
client_image=${STRANDS_QUAL_WORKLOAD_IMAGE:-node:24-bookworm-slim}
gateway="oce-strands-qualification:${run}"
runner="$run-driver"
work=$(mktemp -d)
cluster_created=
runner_created=
image_created=
cleanup() {
  result=$?
  trap - EXIT
  set +e
  if [[ -n $runner_created ]]; then docker rm -f "$runner" >/dev/null || result=1; fi
  if [[ -n $cluster_created ]]; then "$k3d" cluster delete "$run" || result=1; fi
  if [[ -n ${next_image_created:-} ]]; then docker image rm "$next_gateway" >/dev/null || result=1; fi
  if [[ -n $image_created ]]; then docker image rm "$gateway" >/dev/null || result=1; fi
  rm -rf "$work"
  echo "Qualification and cleanup exit: $result"
  exit "$result"
}
trap cleanup EXIT

# Neither a registry nor the test host receives a provider credential.
deploy/strands-credential-proxy/build-image.sh "$gateway" "${STRANDS_QUAL_GATEWAY_BINARY:-}"
image_created=1
[[ $(docker image inspect "$gateway" --format '{{.Config.User}}') == '65532:65532' ]]
# The distroless image has no shell. Inspect the installed bytes and ordinary-user permissions
# without starting it, then exercise its real packaged binary at the image's own UID.
notice_container=$(docker create --network=none "$gateway")
docker cp "$notice_container:/usr/share/doc/strands-credential-proxy/licenses" "$work/notices"
docker rm "$notice_container" >/dev/null
diff -r deploy/strands-credential-proxy/licenses "$work/notices"
[[ -z $(find "$work/notices" -type f ! -perm -004 -print) ]]
[[ -z $(find "$work/notices" -type d ! -perm -005 -print) ]]
echo "Checking gateway entrypoint as its packaged non-root UID, with read-only filesystem"
set +e
docker run --rm --network=none --read-only --cap-drop=ALL "$gateway" >"$work/preflight" 2>&1
result=$?
set -e
[[ $result == 1 ]] && grep -q 'usage: strands-credential-proxy CONFIG.json' "$work/preflight" || {
  echo "Gateway packaging or runtime entrypoint check failed (exit $result)" >&2
  exit 1
}

# K3s embeds kube-router's NetworkPolicy controller. The test checks the actual network boundary.
kubelet_args=()
if [[ ${STRANDS_QUAL_LARGE_DISK_RESERVE:-} == 60Gi ]]; then
  # For 2TiB scratch filesystems where the default percentage exceeds 150GiB. This retains
  # the pressure guard and a hard 60GiB reserve. Never tolerate or clear a pressure taint.
  kubelet_args+=(--k3s-arg='--kubelet-arg=eviction-hard=nodefs.available<60Gi,imagefs.available<60Gi,nodefs.inodesFree<5%,imagefs.inodesFree<5%,memory.available<100Mi@server:0')
  kubelet_args+=(--k3s-arg='--kubelet-arg=image-gc-high-threshold=98@server:0')
  kubelet_args+=(--k3s-arg='--kubelet-arg=image-gc-low-threshold=97@server:0')
fi
cluster_created=1
"$k3d" cluster create "$run" --servers 1 --agents 0 --no-lb "${kubelet_args[@]}" \
  --image "${STRANDS_QUAL_K3S_IMAGE:-rancher/k3s:v1.35.8-k3s1}" --api-port 127.0.0.1:0 \
  --kubeconfig-update-default=false --kubeconfig-switch-context=false \
  --k3s-arg=--disable=traefik@server:0 --k3s-arg=--disable=servicelb@server:0 --timeout 240s
server="k3d-$run-server-0"
network="k3d-$run"
ip() { docker inspect "$1" --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'; }
# Drive the test from an unprivileged container on this cluster's private bridge. It works even
# with a remote Docker daemon and never mounts the Docker socket, operator home or shared trust.
server_ip=$(ip "$server")
"$k3d" kubeconfig get "$run" | sed "s@server: https://.*@server: https://$server_ip:6443@" > "$work/kubeconfig"
import_image() {
  # k3d image import can exit zero even when containerd rejects the import. Verify the actual CRI image.
  docker save --platform linux/amd64 "$1" |
    docker exec -i "$server" ctr -n k8s.io images import --platform linux/amd64 - >&2
  docker exec "$server" crictl inspecti "$1" >/dev/null
}
manifest_ref() {
  local canonical manifest ref
  import_image "$1"
  canonical=$(docker exec "$server" crictl inspecti "$1" | jq -er '.status.repoTags[0]')
  manifest=$(docker exec "$server" ctr -n k8s.io images ls | awk -v x="$canonical" '$1 == x { print $3 }')
  [[ $manifest == sha256:* ]] || return 1
  ref="${canonical%:*}@$manifest"
  docker exec "$server" ctr -n k8s.io images tag "$canonical" "$ref" >&2
  docker exec "$server" crictl inspecti "$ref" | jq -er '.status.repoDigests[0]'
}
docker image inspect "$client_image" >/dev/null 2>&1 || docker pull "$client_image"
import_image "$client_image"
gateway_ref=$(manifest_ref "$gateway")
# A second genuine manifest with exactly the same sender bytes, not a mutable tag or invented digest.
next_gateway="${gateway}-next"
docker build -t "$next_gateway" - <<DOCKERFILE
FROM $gateway
LABEL openclaw.dev/qualification-sender-generation=next
DOCKERFILE
next_image_created=1
next_gateway_ref=$(manifest_ref "$next_gateway")
[[ ${gateway_ref##*@} != ${next_gateway_ref##*@} ]]
docker run -d --name "$runner" --user 1000:1000 --cap-drop=ALL --security-opt=no-new-privileges \
  --network "$network" "$node_image" sleep 3000 >/dev/null
runner_created=1
runner_ip=$(ip "$runner")
repo=/tmp/strands-proxy-test
d() { docker exec -i "$runner" "$@"; }
d mkdir -m 700 "$repo"
d sh -c "umask 077; cat > $repo/kubeconfig" < "$work/kubeconfig"
d sh -c "cat > $repo/kubectl; chmod 0700 $repo/kubectl" < "$(command -v kubectl)"
d sh -c "cat > $repo/helm; chmod 0700 $repo/helm" < "${STRANDS_QUAL_HELM_BIN:-$(command -v helm)}"
# Stage the lockfile-installed local dependencies and selected test code, never a checkout's
# .git, .env or qualification receipts. Extract as the same uid that runs the test.
test_file=tests/integration/strands-box-credential-proxy-installed-k3d-real.test.mjs
tar -cf - package.json tsconfig.base.json node_modules apps/controller packages tests/helpers \
    "$test_file" deploy/helm/openclaw-execution tests/fixtures/egress-custody-origin-wire.mjs tests/fixtures/repository-credentials tests/fixtures/strands-box-enrolled-workload.cjs runtimes/strands-credential-proxy/policy/one-attempt.dw |
  d tar -xf - -C "$repo"
echo "Running installed qualification on $run (fresh tenant, private TLS origin)"
docker exec -i -w "$repo" -e KUBECONFIG="$repo/kubeconfig" \
  -e OCC_TEST_STRANDS_INSTALLED=1 -e STRANDS_PROXY_FIXTURE_IP="$runner_ip" \
  -e STRANDS_PROXY_GATEWAY_IMAGE="$gateway_ref" -e STRANDS_PROXY_NEXT_GATEWAY_IMAGE="$next_gateway_ref" \
  -e STRANDS_PROXY_WORKLOAD_IMAGE="$client_image" \
  "$runner" sh -c "PATH=$repo:\$PATH exec node --test '$test_file'"

# With the supplier's Linux OCE runtime image, also prove the ordinary production work queue,
# genuine Kubernetes Compute signed release, actual Codex startup, and an actual app-server turn.
if [[ -z ${STRANDS_QUAL_OCE_RUNTIME_IMAGE:-} ]]; then
  echo "Installed data-path lane only. Set STRANDS_QUAL_OCE_RUNTIME_IMAGE to also test production ControllerWorker/Compute/Codex."
  exit 0
fi
scripts/qualification/strands-box-production-worker-k3d.sh "$run" "$STRANDS_QUAL_OCE_RUNTIME_IMAGE" "$gateway_ref" "$work/kubeconfig"
