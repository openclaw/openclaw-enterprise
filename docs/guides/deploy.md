# Deploy OpenClaw Enterprise

Deploy one embedded OpenClaw Agent and use its terminal UI (TUI) to exchange
messages through the running gateway.

Complete [Requirements](#requirements), choose one setup below, then follow
[Retrieve the bootstrap service key](#retrieve-the-bootstrap-service-key),
[Create and deploy an Agent](#create-and-deploy-an-agent), and
[Connect the TUI](#connect-the-tui) in order. Your setup selects `OCC_DEPLOYMENT`;
the shared command blocks use that value, so you choose the environment once:

| Setup                       | Where it runs                             | OCC API                     |
| --------------------------- | ----------------------------------------- | --------------------------- |
| [Development](#development) | Local Docker Compose and Docker Engine    | Host loopback               |
| [Production](#production)   | Helm, Kubernetes, and external PostgreSQL | Your private HTTPS endpoint |

An OCC Namespace groups Agents; each deployed Agent owns a gateway. The
**OCC service API key** authorizes provisioning. The **gateway token** connects
the TUI to that Agent. The **OpenAI API key** authorizes model calls. These are
three separate credentials; never copy the OCC key into a workload.

## Requirements

- an interactive terminal with Bash, Docker, `curl`, `jq`, `openssl`, and Python 3
- this repository checked out; run all host commands from its root in the same
  Bash shell (`bash`), unless a step explicitly runs inside a container
- an existing OpenAI API key and a model ID that key can use, obtained from your
  model provider or administrator

Run `bash` at the repository root, then use this dedicated shell throughout.
A failed command stops the procedure. Replace every
`<placeholder>` before running its block. Keep credentials out of command
history, diagnostics, and Git; leave shell tracing disabled.

```bash
set -euo pipefail
umask 077
export OCC_MODEL='<authorized-openai-model-id>'
```

Load `OPENAI_API_KEY` through your credential manager, or enter it without echo:

```bash
read -r -s -p 'OpenAI API key: ' OPENAI_API_KEY
printf '\n'
export OPENAI_API_KEY
: "${OPENAI_API_KEY:?A model credential is required for the TUI reply.}"
```

The examples select `executionMode: embedded` with the built-in OpenClaw
runtime. Dedicated Codex and managed service accounts have additional
[execution-mode](../reference/agents.md#execution-mode) and
[credential-delivery](../reference/service-accounts.md#revision-snapshots-and-credential-delivery)
requirements; configure those after first success.

## Development

### Development prerequisites

- running Docker Engine with Compose and permission to use its socket
- free loopback ports `3000` (OCC) and `55432` (PostgreSQL)

The worker runs as root with the host Docker socket; treat it and its runtime
images as having control of that Docker host. Keep the development API, database,
and socket private. Override occupied ports or the default bridge subnet through
[development settings](../reference/settings.md).

### Configure and start development

Build the checked-in [runtime recipe](../../deploy/runtime/README.md), which
supplies Node, OpenClaw, the bundled Codex plugin, and the TUI:

```bash
docker build -f deploy/runtime/Dockerfile \
  --tag openclaw-enterprise-runtime:quickstart deploy/runtime

test -f .env || cp .env.example .env
export OCC_DOCKER_RUNTIME_IMAGE=openclaw-enterprise-runtime:quickstart
export OCC_DOCKER_GATEWAY_IMAGE="$OCC_DOCKER_RUNTIME_IMAGE"
export OCC_DOCKER_AGENT_IMAGE="$OCC_DOCKER_RUNTIME_IMAGE"
export OCC_DEPLOYMENT=development

docker compose config --quiet
docker compose up --build -d
docker compose ps -a
```

The image exports select the same built image for both required runtime slots,
including when an existing `.env` names separate images. The worker uses the
exported model key; it does not pull missing runtime images. Compose initializes
an empty database and creates the singleton Installation, a human administrator,
and a service administrator automatically.

### Verify development

Wait for `migrate` and `bootstrap` to exit with code `0`, PostgreSQL and the
controller to become healthy, and the worker to stay running:

```bash
docker compose logs --tail=50 bootstrap controller worker
docker compose exec -T worker \
  node -e 'process.exit(process.env.OPENAI_API_KEY?.trim() ? 0 : 1)'
export OCC_URL="http://$(docker compose port controller 3000)"
```

The worker log should contain `worker.started` with
`compute-docker-development`, then `worker.health`. If the key check fails,
load the key and run `docker compose up -d --force-recreate worker` before
creating the Agent.

The initial human account defaults to `admin@openclaw.local` /
`openclaw-development-password`. Set `OPENCLAW_DEV_EMAIL` and
`OPENCLAW_DEV_PASSWORD` in `.env` before first startup to override them. Existing
volumes retain the original accounts and credentials; changing `.env` does not
rotate a password.

### Development end-to-end TUI

Continue to [Retrieve the bootstrap service key](#retrieve-the-bootstrap-service-key),
then follow the shared provisioning and TUI steps. Skip the Production setup.
If the [quickstart](quickstart.md) already supplied your key, continue directly
to [Create and deploy an Agent](#create-and-deploy-an-agent) after loading the
model key, setting `OCC_MODEL` and `OCC_DEPLOYMENT=development`, and recreating
the worker as shown above.

## Production

### Production prerequisites

Prepare these with your infrastructure administrator before installing:

- a dedicated Kubernetes cluster with enforced NetworkPolicies and Pod Security
  Admission; Helm, `kubectl`, and an explicit kubeconfig/context
- operator permission to install the chart's RBAC, create system and tenant
  resources, read the bootstrap volume, and exec into the selected gateway
- external PostgreSQL with separate migrator and application role URLs, following
  the [production database requirements](../reference/settings.md)
- a private HTTPS endpoint forwarding to `openclaw-enterprise-api:8080` in
  `openclaw-system`; its proxy Pods must match `api.clients` below. The chart
  creates neither an Ingress nor TLS. Arrange DNS, certificates, and a trusted
  client environment through your platform's endpoint provisioning process
- approved controller and runtime images in a registry the cluster can pull,
  matching the cluster's CPU architecture and pinned as `image@sha256:<digest>`
- a StorageClass providing SQLite-compatible block/local storage for each
  gateway's `10Gi` ReadWriteOnce disk; NFS/SMB is unsuitable. See the
  [storage contract](../reference/drivers/kubernetes-compute.md#storage-and-credentials)
- a separate protected `1Gi` ReadWriteOnce bootstrap PVC, prepared below

The bundled Compute Driver currently permits the model-calling gateway outbound
public IPv4 TCP/443, excluding private and metadata ranges. It has no model-host
allowlist setting. This is a [documented production security gap](../reference/security.md#namespace-admission-and-resource-isolation);
if your policy requires destination-restricted model egress, that deployment is
blocked pending implementation. A narrower additive NetworkPolicy does not
remove the existing allowance.

Build and publish on a builder matching the cluster architecture. Obtain the
approved Node 24.15+ base digest and registry repository names from your image owner;
use your normal registry login. The runtime recipe owns its pinned package inputs.

```bash
export NODE_BASE_IMAGE='<approved-node-24-image>@sha256:<digest>'
export CONTROLLER_TAG='<registry/controller>:<release>'
export RUNTIME_TAG='<registry/runtime>:<release>'
docker build --build-arg NODE_BASE_IMAGE="$NODE_BASE_IMAGE" -t "$CONTROLLER_TAG" .
docker build --build-arg NODE_BASE_IMAGE="$NODE_BASE_IMAGE" \
  -f deploy/runtime/Dockerfile -t "$RUNTIME_TAG" deploy/runtime
docker push "$CONTROLLER_TAG"
docker push "$RUNTIME_TAG"
docker image inspect --format '{{json .RepoDigests}}' "$CONTROLLER_TAG" "$RUNTIME_TAG"
```

Select the matching registry digest from each result. The combined runtime image
fills both gateway and Agent image fields even though this path uses embedded
OpenClaw. Complete your image approval process before installation. Host Node
24+ can run the [controller image smoke](../../tests/integration/production-image-startup.test.mjs)
and [runtime image smoke](../../deploy/runtime/README.md#verify-the-local-image).

### Configure the Installation

Keep all files in an operator-owned directory outside the checkout. Set these
non-secret inputs in the same shell; `k` scopes every Kubernetes command without
changing your default context:

```bash
export OCC_DEPLOYMENT=production
export KUBECONFIG_FILE='<absolute-path-to-kubeconfig>'
export CONTEXT='<approved-context>'
export OCC_INPUT_DIR='<absolute-path-to-private-input-directory>'
export OCC_URL='https://<internal-occ-host>'
export CONTROLLER_IMAGE='<registry/controller>@sha256:<digest>'
export RUNTIME_IMAGE='<registry/runtime>@sha256:<digest>'
export BOOTSTRAP_STORAGE_CLASS='<protected-rwo-storage-class>'
mkdir -p "$OCC_INPUT_DIR"
chmod 700 "$OCC_INPUT_DIR"
k() { kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" "$@"; }
k cluster-info
```

Save the following as `$OCC_INPUT_DIR/installation.yaml`. Replace both image
placeholders with `RUNTIME_IMAGE`, the cluster name with your Installation's
cluster identifier, and the StorageClass with its exact Kubernetes name. The
TUI connects inside the Pod; `gatewayClients` reserves remote gateway access
for an explicitly approved client selector.

```yaml
occ:
  cluster: "<cluster-name>"
drivers:
  configuration:
    id: config-kubernetes
    configuration:
      authentication: { mode: inCluster }
  iam:
    id: native-iam
    configuration: {}
  compute:
    id: compute-kubernetes
    configuration:
      authentication: { mode: inCluster }
      images:
        gateway: "<registry/runtime>@sha256:<digest>"
        agent: "<registry/runtime>@sha256:<digest>"
        requireImmutableDigest: true
      resources:
        gateway:
          requests: { cpu: 250m, memory: 512Mi }
          limits: { cpu: 1000m, memory: 1Gi }
        agent:
          requests: { cpu: 100m, memory: 128Mi }
          limits: { cpu: 500m, memory: 256Mi }
        namespace:
          quota: { pods: "10" }
          containerDefaults:
            requests: { cpu: 100m, memory: 128Mi }
            limits: { cpu: 500m, memory: 256Mi }
      network:
        dns:
          namespace: kube-system
          podLabels: { k8s-app: kube-dns }
        gatewayPort: 8080
        gatewayClients:
          - namespace: openclaw-system
            podLabels: { app: approved-gateway-client }
      servicePrincipalCredentials:
        mode: projectedServiceAccountToken
        audience: openclaw-enterprise
        expirationSeconds: 900
      runtime:
        gatewayStorageClassName: "<sqlite-block-storage-class>"
        transportSecretPrefix: openclaw-agent-transport
        modelSecretPrefix: openclaw-agent-model
  secret:
    id: secret-kubernetes
    configuration:
      authentication: { mode: inCluster }
```

The gateway's `1Gi` memory limit allows room for the serving gateway and temporary
TUI process. Keep the runtime Secret prefixes unchanged for the commands below.
Confirm the DNS selector with your cluster administrator. Driver options are
owned by the [Kubernetes Compute reference](../reference/drivers/kubernetes-compute.md#configuration).

Have the database administrator deliver the two connection URLs into private
files `occ-application-url` and `occ-migration-url` in `OCC_INPUT_DIR`. Create a
new signing secret once, and retain it for restarts:

```bash
test ! -e "$OCC_INPUT_DIR/occ-auth-secret"
openssl rand -hex 32 | tr -d '\n' > "$OCC_INPUT_DIR/occ-auth-secret"
chmod 600 "$OCC_INPUT_DIR/installation.yaml" "$OCC_INPUT_DIR/occ-"*
k create namespace openclaw-system
k -n openclaw-system create secret generic occ-installation-startup \
  --from-file=installation.yaml="$OCC_INPUT_DIR/installation.yaml"
k -n openclaw-system create secret generic occ-database \
  --from-file=application-url="$OCC_INPUT_DIR/occ-application-url" \
  --from-file=migration-url="$OCC_INPUT_DIR/occ-migration-url"
k -n openclaw-system create secret generic occ-auth \
  --from-file=secret="$OCC_INPUT_DIR/occ-auth-secret"
```

These are first-install commands. If any named resource already exists, verify
its ownership and retained configuration before proceeding; do not regenerate
credentials or overwrite another Installation.

### Prepare the fresh bootstrap output PVC

Create this claim only for a new Installation. Its mounted root must be owned
by UID/GID `1000` with mode `0700`, and contain no bootstrap outputs. Use the
storage administrator's preparation workflow if cluster policy prohibits the
bounded root preparation Pod below; keep cluster policy unchanged.

```bash
(
  BOOTSTRAP_PREPARE_POD="occ-bootstrap-prepare-$(openssl rand -hex 4)"
  trap 'pod_rc=$?; if [ "$pod_rc" -ne 0 ]; then
    k -n openclaw-system logs "$BOOTSTRAP_PREPARE_POD" --tail=30 >&2 || true
  fi
  k -n openclaw-system delete pod "$BOOTSTRAP_PREPARE_POD" --ignore-not-found --timeout=60s >/dev/null ||
    { echo "Remove temporary Pod $BOOTSTRAP_PREPARE_POD after inspecting its diagnostics." >&2; exit 1; }
  exit "$pod_rc"' EXIT
  k -n openclaw-system apply -f - <<YAML
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: occ-bootstrap
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: ${BOOTSTRAP_STORAGE_CLASS}
  resources:
    requests: { storage: 1Gi }
---
apiVersion: v1
kind: Pod
metadata:
  name: ${BOOTSTRAP_PREPARE_POD}
spec:
  restartPolicy: Never
  automountServiceAccountToken: false
  securityContext:
    runAsUser: 0
    runAsGroup: 0
    seccompProfile: { type: RuntimeDefault }
  containers:
    - name: prepare
      image: ${CONTROLLER_IMAGE}
      command:
        - node
        - -e
        - "const fs=require('node:fs'),p='/bootstrap';if(fs.readdirSync(p).some(n=>n.startsWith('initial-admin-')))throw Error('Bootstrap output already exists');fs.chownSync(p,1000,1000);fs.chmodSync(p,0o700);const s=fs.statSync(p);console.log(JSON.stringify({uid:s.uid,gid:s.gid,mode:s.mode&511}));"
      securityContext:
        allowPrivilegeEscalation: false
        capabilities: { drop: [ALL], add: [CHOWN, FOWNER] }
      volumeMounts:
        - { name: output, mountPath: /bootstrap }
  volumes:
    - name: output
      persistentVolumeClaim: { claimName: occ-bootstrap }
YAML
  k -n openclaw-system wait --for=jsonpath='{.status.phase}'=Succeeded \
    "pod/$BOOTSTRAP_PREPARE_POD" --timeout=120s
  k -n openclaw-system logs "$BOOTSTRAP_PREPARE_POD"
)
```

Expect `{"uid":1000,"gid":1000,"mode":448}`. The temporary Pod is removed on
exit, including failure; the PVC is retained. If output already exists, stop;
do not delete it to force another bootstrap.

### Install the control plane

Save this as `$OCC_INPUT_DIR/values.yaml`. Obtain the proxy's exact namespace
and Pod labels from its owner, PostgreSQL's `/32` destination from your database
network configuration, and the Kubernetes API's policy-visible destination and
port from your cluster administrator. Use the destination after Service address
translation; the API Service's `:443` is not necessarily the enforced destination.

```yaml
images:
  controller: "<registry/controller>@sha256:<digest>"
auth:
  baseUrl: "https://<internal-occ-host>"
bootstrap:
  adminEmail: "<first-admin@example.com>"
  password:
    claimName: occ-bootstrap
api:
  clients:
    - namespace: "<https-proxy-namespace>"
      podLabels: { app: "<https-proxy-label>" }
database:
  cidr: "<postgresql-ip>/32"
  port: 5432
cluster:
  cidr: "<policy-visible-kubernetes-api-ip>/32"
  port: 6443
```

Use the same controller digest and `OCC_URL` selected above. Adjust the ports to
your actual endpoints (`6443` is the local k3d example). Other settings retain
the [chart defaults](../../deploy/helm/openclaw-enterprise/values.yaml), including
DNS selection; adjust them if your cluster differs.

```bash
helm lint deploy/helm/openclaw-enterprise -f "$OCC_INPUT_DIR/values.yaml"
helm upgrade --install oce deploy/helm/openclaw-enterprise \
  --kubeconfig "$KUBECONFIG_FILE" --kube-context "$CONTEXT" \
  --namespace openclaw-system -f "$OCC_INPUT_DIR/values.yaml" --timeout 10m
k -n openclaw-system wait --for=condition=complete job/oce-initialization --timeout=300s
k -n openclaw-system rollout status deployment/openclaw-enterprise-api --timeout=300s
k -n openclaw-system rollout status deployment/openclaw-enterprise-worker --timeout=300s
```

The initialization Job creates the Installation and administrators and writes
`initial-admin-password` and `initial-admin-service-key.json` to the protected
PVC. API and worker Pods do not mount it. A failed initialization needs
[manual recovery](#recover-an-incomplete-bootstrap), not blind retries.

### Authenticate to the production API

Continue below to retrieve the key and check `/installation` through your
configured HTTPS endpoint. Healthy Pods alone do not prove API authorization,
gateway deployment, or a model turn.

## Retrieve the bootstrap service key

After successful initialization, prepare a private local delivery directory:

```bash
case "${OCC_DEPLOYMENT:-}" in
  development|production) ;;
  *) echo "Complete one environment setup first." >&2; exit 1 ;;
esac
export OCC_SERVICE_KEY_DIRECTORY="$(mktemp -d)"
export OCC_SERVICE_KEY_FILE="$OCC_SERVICE_KEY_DIRECTORY/initial-admin-service-key.json"
```

For development, this copies from the completed bootstrap container:

```bash
if [ "$OCC_DEPLOYMENT" = development ]; then
    docker compose cp bootstrap:/var/lib/openclaw/bootstrap/initial-admin-service-key.json \
      "$OCC_SERVICE_KEY_FILE"
fi
```

For production, this uses a temporary read-only reader Pod in
`openclaw-system`. It preserves owner-only permissions
by omitting `fsGroup`; a completed Job is not an exec endpoint. The cleanup
trap removes this per-run reader Pod on success or failure. RWO storage must
allow the reader to mount after initialization, on the appropriate storage node.

```bash
if [ "$OCC_DEPLOYMENT" = production ]; then
  (
    BOOTSTRAP_READER_POD="occ-bootstrap-reader-$(openssl rand -hex 4)"
    trap 'pod_rc=$?; if [ "$pod_rc" -ne 0 ]; then
      k -n openclaw-system logs "$BOOTSTRAP_READER_POD" --tail=30 >&2 || true
    fi
    k -n openclaw-system delete pod "$BOOTSTRAP_READER_POD" --ignore-not-found --timeout=60s >/dev/null ||
      { echo "Remove temporary Pod $BOOTSTRAP_READER_POD after inspecting its diagnostics." >&2; exit 1; }
    exit "$pod_rc"' EXIT
    k -n openclaw-system apply -f - <<YAML
apiVersion: v1
kind: Pod
metadata:
  name: ${BOOTSTRAP_READER_POD}
spec:
  restartPolicy: Never
  automountServiceAccountToken: false
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    runAsGroup: 1000
    seccompProfile: { type: RuntimeDefault }
  containers:
    - name: reader
      image: ${CONTROLLER_IMAGE}
      command: [node, -e, 'setInterval(()=>{},1000)']
      resources:
        requests: { cpu: 100m, memory: 128Mi }
        limits: { cpu: 500m, memory: 256Mi }
      securityContext:
        readOnlyRootFilesystem: true
        allowPrivilegeEscalation: false
        capabilities: { drop: [ALL] }
      volumeMounts:
        - { name: output, mountPath: /bootstrap, readOnly: true }
  volumes:
    - name: output
      persistentVolumeClaim: { claimName: occ-bootstrap, readOnly: true }
YAML
    k -n openclaw-system wait --for=condition=Ready "pod/$BOOTSTRAP_READER_POD" --timeout=180s
    k -n openclaw-system exec "$BOOTSTRAP_READER_POD" -- node -e \
      'const fs=require("node:fs"),p="/bootstrap/initial-admin-service-key.json";if((fs.statSync(p).mode&511)!==384)throw Error("Unsafe file permissions");process.stdout.write(fs.readFileSync(p));' \
      > "$OCC_SERVICE_KEY_FILE"
  )
fi
```

**Both environments:** verify authenticated access with the checked-in
[`scripts/occ-api`](../../scripts/occ-api) helper. It reads `data.key`, sends
`x-api-key` through a private header file, and validates the response envelope.
Do not use the helper for key issuance, which returns a one-time secret.

```bash
chmod 600 "$OCC_SERVICE_KEY_FILE"
scripts/occ-api GET /installation | jq -e --slurpfile key "$OCC_SERVICE_KEY_FILE" \
  '.data.id == $key[0].meta.installationId'
```

Expect `true`. Import the original key and its non-secret IDs into your protected
credential store; the initial key expires after 30 days. Keep this shell open.

## Create and deploy an Agent

### Create the Namespace

Run every block below in order for either environment. Production-only blocks
are guarded by `OCC_DEPLOYMENT` and do nothing in development.

Create a private request directory and a bounded wait helper. A returned `202`
accepts deployment work; only the later active revision confirms activation.

```bash
set -euo pipefail
umask 077
: "${OCC_URL:?Complete the environment setup first.}"
: "${OCC_SERVICE_KEY_FILE:?Retrieve the bootstrap key first.}"
: "${OCC_MODEL:?Select a model available to your key.}"
export OCC_WORK_DIR="$(mktemp -d)"
export OCC_AGENT_NAME="tui-$(date +%Y%m%d%H%M%S)"

wait_occ() {
  local route="$1" condition="$2" attempt
  for attempt in $(seq 1 120); do
    scripts/occ-api GET "$route" > "$OCC_WORK_DIR/current.json"
    if jq -e "$condition" "$OCC_WORK_DIR/current.json" >/dev/null; then return 0; fi
    if jq -e '.data.status == "failed" or .data.status == "deleting"' \
      "$OCC_WORK_DIR/current.json" >/dev/null; then break; fi
    sleep 2
  done
  cat "$OCC_WORK_DIR/current.json" >&2
  echo "Resource did not reach the required state: $route" >&2
  return 1
}

jq -n --arg name "$OCC_AGENT_NAME" '{name: $name}' > "$OCC_WORK_DIR/namespace.json"
NAMESPACE_ID="$(scripts/occ-api POST /namespaces "$OCC_WORK_DIR/namespace.json" | jq -er '.data.id')"
```

### Grant production tenant access

In production, the worker creates the backing Kubernetes namespace, then waits
for your RoleBindings. Discover exactly one namespace with matching OCC
ownership. Complete this before the worker's default 15-minute convergence
window expires:

```bash
if [ "$OCC_DEPLOYMENT" = production ]; then
  TENANT_NAMESPACE=''
  for attempt in $(seq 1 120); do
    k get namespaces -l "openclaw.dev/namespace=$NAMESPACE_ID" -o json > "$OCC_WORK_DIR/tenants.json"
    if [ "$(jq '.items | length' "$OCC_WORK_DIR/tenants.json")" -gt 0 ]; then
      TENANT_NAMESPACE="$(jq -er --arg id "$NAMESPACE_ID" \
        '.items | if length == 1 and .[0].metadata.annotations["openclaw.dev/namespace-id"] == $id
         then .[0].metadata.name else error("Ambiguous or foreign tenant namespace") end' \
        "$OCC_WORK_DIR/tenants.json")"
      break
    fi
    sleep 2
  done
  : "${TENANT_NAMESPACE:?Backing namespace did not appear; inspect worker logs.}"

  k -n "$TENANT_NAMESPACE" create rolebinding openclaw-enterprise-worker \
    --clusterrole=oce-openclaw-tenant-worker \
    --serviceaccount=openclaw-system:openclaw-enterprise-worker
  k -n "$TENANT_NAMESPACE" create rolebinding openclaw-enterprise-configuration \
    --clusterrole=oce-openclaw-tenant-configuration \
    --serviceaccount=openclaw-system:openclaw-enterprise-api
fi
```

These grants are tenant-local. The direct model Secret path below does not need
an API Secret RoleBinding or additional OCC Secret grants. If you later use OCC
Secret bindings, follow the [Secret authorization requirements](../reference/drivers/kubernetes-secret.md#bind-a-secret-to-gateway-environment).

### Create the Configuration and Agent

Wait for the Namespace to be ready, create the native
configuration, then create its Agent. IDs come from API responses; do not invent
Namespace, Configuration, Agent, or revision IDs.

```bash
wait_occ "/namespaces/$NAMESPACE_ID" '.data.status == "ready"'

jq -n --arg model "$OCC_MODEL" '
  ("openai/" + $model) as $ref |
  {kind: "agent", values: {
    gateway: {
      mode: "local", bind: "lan", controlUi: {enabled: false},
      auth: {mode: "token", token: "${OPENCLAW_GATEWAY_TOKEN}"},
      http: {endpoints: {chatCompletions: {enabled: true}}}
    },
    agents: {defaults: {
      model: $ref, skipBootstrap: true,
      models: {($ref): {agentRuntime: {id: "openclaw"}}}
    }},
    models: {providers: {openai: {
      baseUrl: "https://api.openai.com/v1", api: "openai-responses",
      models: [{id: $model, name: $model}]
    }}}
  }}' > "$OCC_WORK_DIR/configuration.json"
CONFIGURATION_ID="$(scripts/occ-api POST "/namespaces/$NAMESPACE_ID/configurations" \
  "$OCC_WORK_DIR/configuration.json" | jq -er '.data.id')"

jq -n --arg name "$OCC_AGENT_NAME" --arg configuration "$CONFIGURATION_ID" \
  '{name: $name, configurationId: $configuration, executionMode: "embedded"}' \
  > "$OCC_WORK_DIR/agent.json"
AGENT_ID="$(scripts/occ-api POST "/namespaces/$NAMESPACE_ID/agents" \
  "$OCC_WORK_DIR/agent.json" | jq -er '.data.id')"
AGENT_ROUTE="/namespaces/$NAMESPACE_ID/agents/$AGENT_ID"
```

Keep `${OPENCLAW_GATEWAY_TOKEN}` literal: the gateway resolves it from its own
injected environment. The configuration contains no credential value.
`skipBootstrap` skips first-workspace onboarding so the connectivity demo can
answer the first prompt. It does not alter existing workspace files.

### Supply production gateway credentials

In development, Docker Compute supplies the gateway token and model key.
The next block creates the two required Agent-owned Secrets only in production.
Embedded OpenClaw consumes only `gateway-token` from its transport Secret.

```bash
if [ "$OCC_DEPLOYMENT" = production ]; then
  AGENT_SUFFIX="$(python3 -c 'import hashlib,sys; print(hashlib.sha256(sys.argv[1].encode()).hexdigest()[:12])' "$AGENT_ID")"
  SECRET_DIRECTORY="$(mktemp -d)"
  openssl rand -hex 32 | tr -d '\n' > "$SECRET_DIRECTORY/gateway-token"
  k -n "$TENANT_NAMESPACE" create secret generic "openclaw-agent-transport-$AGENT_SUFFIX" \
    --from-file=gateway-token="$SECRET_DIRECTORY/gateway-token"
  printf %s "$OPENAI_API_KEY" | k -n "$TENANT_NAMESPACE" create secret generic \
    "openclaw-agent-model-$AGENT_SUFFIX" --from-file=OPENAI_API_KEY=/dev/stdin
  rm -- "$SECRET_DIRECTORY/gateway-token"
  rmdir -- "$SECRET_DIRECTORY"
fi
```

The prefixes match `installation.yaml`; the suffix is the first 12 hexadecimal
characters of SHA-256 of the exact Agent ID. This path deliberately creates an
Agent without `serviceAccountId` or `secretBindings`. Associated accounts and
bound Secrets must use their [own credential delivery rules](../reference/service-accounts.md#revision-snapshots-and-credential-delivery).

### Deploy and wait for activation

```bash
REVISION_ID="$(scripts/occ-api POST "$AGENT_ROUTE/deploy" | jq -er '.data.id')"
wait_occ "$AGENT_ROUTE" ".data.activeRevisionId == \"$REVISION_ID\""
printf 'Namespace: %s\nAgent: %s\nActive revision: %s\n' "$NAMESPACE_ID" "$AGENT_ID" "$REVISION_ID"
```

Continue with the matching TUI attachment below. OCC activation does not yet
prove a successful model reply.

## Connect the TUI

Run the client **inside the active gateway**, using its injected
`OPENCLAW_CONFIG_PATH`, `OPENCLAW_GATEWAY_PORT`, and `OPENCLAW_GATEWAY_TOKEN`.
It connects to `ws://127.0.0.1:8080` inside that container with the settings
above. The host OCC URL and OCC service key are not TUI connection parameters.

### Select the active gateway

Development selects one running container by exact Namespace, Agent, and
revision labels. Production also checks the mounted immutable ConfigMap because
its Pod labels remain stable across revisions; it requires one Ready,
nonterminating Pod.

```bash
if [ "$OCC_DEPLOYMENT" = development ]; then
  GATEWAY_CONTAINER="$(docker ps -q \
    --filter label=org.openclaw.enterprise.managed=true \
    --filter label=org.openclaw.enterprise.compute-driver=docker \
    --filter label=org.openclaw.enterprise.namespace-id="$NAMESPACE_ID" \
    --filter label=org.openclaw.enterprise.agent-id="$AGENT_ID" \
    --filter label=org.openclaw.enterprise.revision-id="$REVISION_ID" \
    --filter label=org.openclaw.enterprise.role=gateway |
    jq -Rsr 'split("\n") | map(select(length > 0)) |
      if length == 1 then .[0] else error("Expected one active gateway container") end')"
  docker inspect --format '{{.State.Status}} {{.State.Health.Status}}' "$GATEWAY_CONTAINER"
else
  AGENT_SUFFIX="$(python3 -c 'import hashlib,sys; print(hashlib.sha256(sys.argv[1].encode()).hexdigest()[:12])' "$AGENT_ID")"
  REVISION_SUFFIX="$(python3 -c 'import hashlib,sys; print(hashlib.sha256(sys.argv[1].encode()).hexdigest()[:12])' "$REVISION_ID")"
  EXPECTED_CONFIGMAP="gateway-$AGENT_SUFFIX-rev-$REVISION_SUFFIX"
  k -n "$TENANT_NAMESPACE" rollout status "deployment/gateway-$AGENT_SUFFIX" --timeout=300s
  GATEWAY_POD="$(k -n "$TENANT_NAMESPACE" get pods -l \
    "app.kubernetes.io/managed-by=openclaw-enterprise,openclaw.dev/workload-role=gateway,openclaw.dev/namespace=$NAMESPACE_ID,openclaw.dev/agent=$AGENT_ID" -o json |
    jq -er --arg config "$EXPECTED_CONFIGMAP" '
      [.items[] | select(.metadata.deletionTimestamp == null and .status.phase == "Running") |
        select(any(.status.conditions[]?; .type == "Ready" and .status == "True")) |
        select(any(.spec.volumes[]?; .configMap.name == $config))] |
      if length == 1 then .[0].metadata.name else error("Expected one active gateway Pod") end')"
fi
```

Expect `running healthy` in development or a successful gateway rollout in
production. Missing or multiple matches stop attachment.

### Tests: exchange two messages

Generate two distinguishable replies and keep the second prompt visible for
manual entry. The next command selects the client attachment for your environment:

```bash
E2E_SESSION="occ-tui-$(date +%Y%m%d%H%M%S)"
NONCE="OCC_TUI_$(openssl rand -hex 8)"
SECOND_NONCE="OCC_TUI_FOLLOWUP_$(openssl rand -hex 8)"
printf 'First expected reply: %s\nThen type: Reply exactly: %s\n' "$NONCE" "$SECOND_NONCE"
```

```bash
if [ "$OCC_DEPLOYMENT" = development ]; then
  docker exec -it -e OPENCLAW_STATE_DIR=/tmp/occ-tui-client \
    "$GATEWAY_CONTAINER" env -u OPENAI_API_KEY node /app/openclaw.mjs tui \
    --session "$E2E_SESSION" --message "Reply exactly: $NONCE"
else
  k -n "$TENANT_NAMESPACE" exec -it "$GATEWAY_POD" -c gateway -- \
    env -u OPENAI_API_KEY OPENCLAW_STATE_DIR=/tmp/occ-tui-client \
    node /app/openclaw.mjs tui --session "$E2E_SESSION" --message "Reply exactly: $NONCE"
fi
```

Completion requires all of the following:

1. The TUI reports a connected gateway session.
2. An **assistant reply**, not the echoed user prompt, contains exactly the first
   nonce. Type the printed follow-up prompt in the same TUI and receive the
   second nonce as an assistant reply.
3. Press Ctrl+D; only the TUI exits. Re-run the container health check or gateway
   Deployment rollout check above to confirm the serving gateway remains ready.

The temporary client has no model API key; the running embedded gateway makes
the model calls. Do not add `--local`, which selects local embedded execution,
or disable device pairing. No host port-forward or extracted gateway token is
needed. To reconnect after deploying another revision, read the Agent again,
set `REVISION_ID` from `data.activeRevisionId`, and repeat discovery.

The [Docker integration](../../tests/integration/docker-compute-real.test.mjs)
and [production TUI integration](../../tests/integration/production-tui-k3d-real.test.mjs)
exercise native TUI replies, invalid-token denial, and client exit; the latter
also covers revision cutover. See [testing](../testing.md) for their opt-in
runtime/credential requirements. These checks are stronger than HTTP health or
OCC activation alone.

## Stop and retain recovery state

After API work, remove only the temporary local delivery/request files:

```bash
rm -- "$OCC_SERVICE_KEY_FILE"
rmdir -- "$OCC_SERVICE_KEY_DIRECTORY"
rm -- "$OCC_WORK_DIR/namespace.json" "$OCC_WORK_DIR/configuration.json" \
  "$OCC_WORK_DIR/agent.json" "$OCC_WORK_DIR/current.json"
[ ! -f "$OCC_WORK_DIR/tenants.json" ] || rm -- "$OCC_WORK_DIR/tenants.json"
rmdir -- "$OCC_WORK_DIR"
unset OPENAI_API_KEY OCC_SERVICE_KEY_FILE OCC_SERVICE_KEY_DIRECTORY OCC_WORK_DIR
```

Removing a local copy does **not** revoke the service key. Retain the original
bootstrap output and imported credentials in protected storage.

For development, `docker compose down` stops the control plane and preserves its
three data volumes. It leaves Compute-created Agent containers and tenant
networks running. For an intentional production decommission,
`helm uninstall oce --kubeconfig "$KUBECONFIG_FILE" --kube-context "$CONTEXT" --namespace openclaw-system`
removes the release, but not external PostgreSQL, operator Secrets/PVCs, or
Compute-created tenant workloads; hook resources may also remain.

Inventory exact Agent/Namespace ownership before separate workload cleanup.
Never use broad Docker pruning, shared-namespace deletion, or
`docker compose down --volumes` as routine recovery. Preserve database,
configuration, bootstrap output, and signing material together for restart.

## Troubleshooting

| Symptom                                              | Check and recovery                                                                                                                                                                                                     |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Initializer fails                                    | Read `docker compose logs bootstrap`, or `k -n openclaw-system logs job/oce-initialization -c bootstrap`. Preserve partial outputs and follow [bootstrap recovery](#recover-an-incomplete-bootstrap).                  |
| Worker exits or cannot find runtime image            | Read `startup-error` / `worker.startup-error`. Build or pull the configured image into the same Docker Engine; for Kubernetes, check the selected digests and registry pull access.                                    |
| Namespace remains `provisioning`                     | Check worker logs and the exact tenant worker RoleBinding. Complete its grant before convergence expires; do not create a second Namespace to hide a pending operation.                                                |
| Configuration creation is denied                     | Check the tenant API Configuration RoleBinding and the caller's OCC authority; Kubernetes grants and OCC IAM grants are separate.                                                                                      |
| Gateway Pending or `CreateContainerConfigError`      | Check Pod events, its PVC/StorageClass, and the exact hashed transport/model Secret names and keys. Do not dump Secret values.                                                                                         |
| Initializer or reader cannot mount bootstrap PVC     | Check volume attachment/topology and UID/GID `1000`, root mode `0700`, files `0600`. Do not use `fsGroup` to broaden credential access.                                                                                |
| Production API cannot reach PostgreSQL or Kubernetes | Verify actual policy-visible `/32` endpoints and ports after address translation; check the proxy Pod selector for client access.                                                                                      |
| API key returns `401`                                | Key may be expired or revoked. Recover with the human administrator below; bootstrap never rotates it.                                                                                                                 |
| TUI token/pairing error or no reply                  | Verify exact active workload selection, runtime image, model access, and gateway logs. Keep pairing enabled; never substitute `--local`. For first-run onboarding, use the fresh demo configuration's `skipBootstrap`. |

### Recover an incomplete bootstrap

Bootstrap makes one attempt and preserves accounts, keys, and partial output on
failure. `installation.bootstrap-failed` reports available non-secret IDs and
paths; file existence alone does not establish a committed Installation.

Use approved database access to establish whether the original transaction
committed and compare its Installation, human, service-principal, and key IDs
with current records. If the database is unavailable, the outcome remains
unresolved. Preserve storage and diagnostics; do not delete output or retry.

For a confirmed noncommitted attempt, manually remove only proven orphan
accounts/keys and quarantine that attempt's output in protected storage. Retain
credentials for a matching committed seed and use ordinary key recovery. A
losing concurrent attempt may have separate orphan records. Retry only after
repair, or after an explicitly authorized reset of an identified disposable
Installation's dedicated database and credential storage.

## Service API keys for automation

The bootstrap key works for the provisioning commands above. Full key scope,
issuance fields, expiry, and errors are defined in the
[authentication reference](../reference/authentication.md#service-api-keys).

### Sign in as a human administrator

For development recovery, use the [quickstart human sign-in](quickstart.md#sign-in-and-read-the-installation).
For production, obtain the initial email from `bootstrap.adminEmail` and password
from `initial-admin-password` on the protected bootstrap PVC, through the same
approved storage access used for the key. Do not regenerate either.

With `OCC_URL` set to the production HTTPS endpoint, enter credentials at these
prompts; the password is hidden:

```bash
OCC_SESSION_DIRECTORY="$(mktemp -d)"
export OCC_SESSION_COOKIE_JAR="$OCC_SESSION_DIRECTORY/cookies"
python3 -c 'import getpass,json,sys
print("Administrator email: ",end="",file=sys.stderr,flush=True)
email=sys.stdin.readline().strip()
print(json.dumps({"email":email,"password":getpass.getpass("Administrator password: ")}))' |
  curl --fail-with-body --silent --show-error --cookie-jar "$OCC_SESSION_COOKIE_JAR" \
    "$OCC_URL/api/auth/sign-in/email" -H 'Content-Type: application/json' \
    --data-binary @- --output /dev/null
```

### Issue a service key

Use the recorded non-Agent service principal ID from the original key file.
The controller has no public IAM-management API; new principals and grants
must first be provisioned through your selected IAM authority.

```bash
export OCC_SERVICE_KEY_FILE="$(mktemp "$OCC_SESSION_DIRECTORY/key.XXXXXX")"
curl --fail --silent --show-error --cookie "$OCC_SESSION_COOKIE_JAR" \
  "$OCC_URL/api/auth/service-keys" -H 'Content-Type: application/json' \
  --data '{"servicePrincipalId":"<existing-service-principal-id>","name":"operator","expiresIn":2592000}' \
  --output "$OCC_SERVICE_KEY_FILE"
chmod 600 "$OCC_SERVICE_KEY_FILE"
scripts/occ-api GET /installation
```

Expect issuance HTTP `201` and a successful Installation read. The example is
Installation-scoped. Namespace keys also require the exact `namespaceId` in
the request and can access only that principal's granted scope.

### Revoke or rotate a service key

For planned rotation, issue a replacement, switch the client, verify its granted
operation, then revoke the old non-secret key ID. For exposure, revoke first.

```bash
OCC_OLD_KEY_ID='<old-key-id>'
curl --fail --silent --show-error --cookie "$OCC_SESSION_COOKIE_JAR" \
  --request DELETE "$OCC_URL/api/auth/service-keys/$OCC_OLD_KEY_ID"
```

Expect `data.revoked: true`; an authenticated read using the old file must now
return `401`. Deleting the local JSON does not revoke a key. Revocation does not
cascade to keys an administrator issued; investigate those separately after
exposure. An existing Installation-scoped service administrator can also manage
keys with `x-api-key`, per the [same API contract](../reference/authentication.md#issuance).

If both the bootstrap file and IDs are lost, there is no discovery endpoint.
Use approved database access to inspect only non-secret `occ.apikey` fields
(`id`, `reference_id`, `name`, `metadata`, `expires_at`), match `reference_id`
to `occ.iam_identities.id`, and verify Installation and current
`occ.iam_access_bindings`/`occ.iam_roles` ownership. Never dump keys, password
hashes, or sessions. Key issuance cannot restore removed IAM authority; loss of
all administrator credentials requires operator recovery.

Sign out when finished:

```bash
curl --fail --silent --show-error --cookie "$OCC_SESSION_COOKIE_JAR" \
  --request POST "$OCC_URL/api/auth/sign-out" --output /dev/null
rm -- "$OCC_SESSION_COOKIE_JAR"
```

Import any replacement key into protected storage before removing its delivery
file and the now-empty temporary directory.

## Use an existing Kubernetes namespace

For installations that need operator-owned tenant namespaces, use
`POST /namespaces` with `{"name":"support","existingNamespace":"<exact-kubernetes-namespace>"}`
instead of the default Namespace creation block. This requires Installation
`administer` authority. Before the request, the namespace must be Active,
exclusively dedicated to this tenant, free of foreign NetworkPolicies, labeled
with all three `pod-security.kubernetes.io/{enforce,audit,warn}=restricted`
settings, and annotated `openclaw.dev/namespace-lifecycle=external`.

Create the same tenant worker and Configuration RoleBindings before submitting
the request. Verify the returned Namespace ID matches its Kubernetes label and
annotation, then wait for OCC `ready` before continuing. Do not overwrite
foreign tenant markers or change Pod Security to force adoption. Deletion and
reuse preserve external ownership; follow the
[namespace ownership contract](../reference/drivers/kubernetes-compute.md#namespaces-and-isolation).

## Related

- [Settings](../reference/settings.md) and [Configuration](../reference/configuration.md)
- [Development startup](../flows/development-startup.md), [production startup](../flows/production-startup.md), and [production TUI flow](../flows/production-tui.md)
- [Security controls and verification limits](../reference/security.md)
- [API reference](../reference/api.md) and [integration testing](../testing.md)
