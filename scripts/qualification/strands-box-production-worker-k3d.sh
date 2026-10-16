#!/usr/bin/env bash
# Second lane, called by strands-box-credential-proxy-k3d.sh only with the fresh cluster it owns.
# Provision genuine workspace routing and node enrollment; exercise production composition, real
# PostgreSQL work, Kubernetes Compute, signed release and supplier's actual Codex app-server.
set -euo pipefail
umask 077
cluster=$1; runtime=$2; gateway=$3; kubeconfig=$4
server="k3d-$cluster-server-0"
network="k3d-$cluster"
case $cluster in strands-proxy-*) ;; *) echo 'Refusing a non-qualification cluster' >&2; exit 2;; esac
k() { docker exec -i "$server" kubectl "$@"; }
k get nodes -o name | grep -Fx "node/$server"
grep -Fq "$network" "$kubeconfig"
ns="strands-control-$(od -An -N3 -tx1 /dev/urandom | tr -d ' ')"
# create, not reuse. Parent owns cleanup of the whole cluster.
k create namespace "$ns"

driver_image=${STRANDS_QUAL_NODE_IMAGE:-node:24-bookworm}
import_image() {
  docker save --platform linux/amd64 "$1" |
    docker exec -i "$server" ctr -n k8s.io images import --platform linux/amd64 -
  docker exec "$server" crictl inspecti "$1" >/dev/null
}
digest_ref() {
  local canonical digest ref
  canonical=$(docker exec "$server" crictl inspecti "$1" | jq -er '.status.repoTags[0]')
  digest=$(docker exec "$server" ctr -n k8s.io images ls | awk -v x="$canonical" '$1 == x { print $3 }')
  [[ $digest == sha256:* ]] || { echo "Missing imported manifest digest: $1" >&2; return 1; }
  ref="${canonical%:*}@$digest"
  if ! docker exec "$server" crictl inspecti "$ref" >/dev/null 2>&1; then
    docker exec "$server" ctr -n k8s.io images tag "$canonical" "$ref" >&2
  fi
  docker exec "$server" crictl inspecti "$ref" | jq -er '.status.repoDigests[0]'
}
import_image "$driver_image"
import_image "$runtime"
runtime_ref=$(digest_ref "$runtime")
gateway_ref=$gateway

work=$(mktemp -d)
pg="$cluster-${ns#strands-control-}-worker-postgres"
pg_id=
cleanup() {
  result=$?; trap - EXIT; set +e
  if [[ -n $pg_id ]]; then docker rm -f -v "$pg_id" >/dev/null || result=1; fi
  rm -rf "$work"
  echo "Production release qualification and PostgreSQL cleanup exit: $result"
  exit "$result"
}
trap cleanup EXIT
# Use the repository's pinned routing releases. Verify each manifest *before* installation.
manifest() {
  local file="$work/$1.yaml"
  curl --fail --location --silent --show-error --connect-timeout 10 --max-time 120 "$2" -o "$file"
  echo "$3  $file" | sha256sum -c -
  k apply --server-side -f - < "$file"
}
manifest cert-manager 'https://github.com/cert-manager/cert-manager/releases/download/v1.18.4/cert-manager.yaml' \
  aff085b4f0126f67372e3a02cb18feb70eed37dbd4de01973a159e6c13482f83 > "$work/cert-manager.log"
manifest envoy 'https://github.com/envoyproxy/gateway/releases/download/v1.6.7/install.yaml' \
  9a250c698d78b92c670d9d2bd6bd54615f1dee41ddd520ece9704edf63088df8 > "$work/envoy.log"
k -n cert-manager rollout status deployment/cert-manager --timeout=240s
k -n envoy-gateway-system rollout status deployment/envoy-gateway --timeout=240s

# Dedicated database, no published ports. App never receives the administrative or migration role.
pg_id=$(docker run -d --name "$pg" --network "$network" -e POSTGRES_DB=openclaw_enterprise \
  -e POSTGRES_PASSWORD="$(openssl rand -hex 32)" postgres:18.6)
# The image's temporary initialization server accepts socket connections before creating POSTGRES_DB.
# Wait for an authenticated query on the exact database over TCP, which only the final server accepts.
# Use the bridge hostname so this check cannot pass due to a local trust rule.
for attempt in {1..30}; do
  if docker exec "$pg_id" sh -ec '
    export PGCONNECT_TIMEOUT=2 PGPASSWORD="$POSTGRES_PASSWORD"
    exec psql -Xw -h "$HOSTNAME" -U postgres -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -Atqc "SELECT 1"
  ' >/dev/null 2>&1; then
    break
  fi
  if (( attempt == 30 )); then
    echo "PostgreSQL did not accept an authenticated TCP query on the qualification database" >&2
    exit 1
  fi
  sleep 1
done
docker exec -i "$pg_id" psql -U postgres -d openclaw_enterprise -v ON_ERROR_STOP=1 < migrations/init-local.sql
pg_ip=$(docker inspect "$pg_id" --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')

# Run the real API and worker in a non-root fixture Pod with the expected private gateway path.
# Only this test controller has the fresh cluster's admin identity. We do not claim this exercises
# least-privilege controller RBAC. The untrusted released Harness remains subject to the actual,
# separate workload restrictions provisioned by Compute, Sandbox and Credential Proxy.
pod=strands-installation-observer
k apply -f - <<YAML
apiVersion: v1
kind: Pod
metadata:
  namespace: $ns
  name: $pod
  labels:
    qualification: strands-installation-observer
    app.kubernetes.io/name: openclaw-enterprise
    app.kubernetes.io/instance: oce-workspace-files
    app.kubernetes.io/component: api
spec:
  automountServiceAccountToken: false
  restartPolicy: Never
  hostAliases: [{ip: "$pg_ip", hostnames: ["$pg"]}]
  securityContext: {runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, seccompProfile: {type: RuntimeDefault}}
  containers:
    - name: test-controller
      image: $driver_image
      imagePullPolicy: Never
      command: ["sleep", "3000"]
      securityContext: {allowPrivilegeEscalation: false, capabilities: {drop: ["ALL"]}}
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: {namespace: $ns, name: strands-test-controller-connectivity}
spec:
  podSelector: {matchLabels: {qualification: strands-installation-observer}}
  policyTypes: [Egress, Ingress]
  egress: [{}]
  ingress: [{ports: [{port: 38443}, {port: 39443}]}]
YAML
k -n "$ns" wait --for=condition=Ready "pod/$pod" --timeout=180s
p() { k -n "$ns" exec -i "$pod" -- "$@"; }
repo=/tmp/strands-prod-test
p mkdir -m 700 "$repo"
p sh -c "umask 077; cat > $repo/kubeconfig" < "$kubeconfig"
p sh -c "cat > $repo/kubectl; chmod 0700 $repo/kubectl" < "$(command -v kubectl)"
p sh -c "cat > $repo/helm; chmod 0700 $repo/helm" < "${STRANDS_QUAL_HELM_BIN:-$(command -v helm)}"
host=$(k -n "$ns" get pod "$pod" -o jsonpath='{.status.podIP}')
file=tests/integration/strands-box-credential-proxy-production-worker-k3d-real.test.mjs
tar -cf - package.json tsconfig.base.json node_modules apps/controller packages tests/helpers \
  "$file" tests/fixtures/synthetic-egress-provider.mjs tests/fixtures/synthetic-credential-url.mjs \
  deploy/helm/openclaw-enterprise deploy/helm/openclaw-execution \
  deploy/examples/production/values.yaml deploy/presets migrations scripts |
  p tar -xf - -C "$repo"
# Build fixture URLs only inside the staged Pod. Send the role and host through kubectl, never the URL.
fixture_database='
import { syntheticCredentialUrl } from "./tests/fixtures/synthetic-credential-url.mjs";
const [host, role] = process.argv.slice(1);
process.stdout.write(syntheticCredentialUrl({
  protocol: "postgresql", username: `occ_${role}`, password: `occ-${role}-local`,
  host, port: 5432, pathname: "/openclaw_enterprise",
}));'
p env NODE_ENV=development sh -ec '
  cd "$1"
  url=$(node --input-type=module -e "$2" "$3" migrator)
  export OCC_MIGRATION_DATABASE_URL="$url"
  exec node scripts/migrate-production.mjs
' sh "$repo" "$fixture_database" "$pg"
echo "Full production release qualification. Context $network, runtime $runtime_ref, sender $gateway_ref"
p env KUBECONFIG="$repo/kubeconfig" OCC_TEST_STRANDS_PRODUCTION_WORKER=1 \
  STRANDS_PROXY_TEST_PLATFORM_NAMESPACE="$ns" STRANDS_PROXY_FIXTURE_IP="$host" STRANDS_PROXY_KUBERNETES_CONTEXT="$network" \
  STRANDS_PROXY_RUNTIME_IMAGE="$runtime_ref" STRANDS_PROXY_GATEWAY_IMAGE="$gateway_ref" \
  sh -ec '
    cd "$1"
    url=$(node --input-type=module -e "$2" "$3" app)
    export STRANDS_PROXY_TEST_DATABASE_URL="$url" PATH="$1:$PATH"
    exec node --test "$4"
  ' sh "$repo" "$fixture_database" "$pg" "$file"
