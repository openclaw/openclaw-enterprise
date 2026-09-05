# Deploy OpenClaw Enterprise

Start OpenClaw Control Center (OCC), verify authenticated access, then deploy
Agents when you are ready to prove a workload. Run commands from the repository
root. Startup needs no model credential.

Trusted Installation YAML can also select the bundled
[SSH Compute Driver](../reference/drivers/ssh-compute.md) for embedded OpenClaw
on preprovisioned Linux hosts. That reference owns host configuration,
credentials, and operational limits; [SSH raw-host testing](../testing.md#ssh-raw-hosts)
owns the disposable verification rig. The Compose and Helm procedures below
retain their existing control-plane and Kubernetes packaging boundaries.

## Development

Prerequisites: Docker Engine with Docker Compose, socket access, Bash, `curl`,
Python 3, and a combined local runtime image or permission for the helper to
build `openclaw-enterprise-runtime:quickstart`.

```bash
./scripts/dev-up
```

The helper validates Compose without printing expanded credentials, starts the
database, migration, bootstrap, API, and worker services, privately copies the
initial service-key response, and checks `/installation`. Expected output starts
with `OpenClaw Enterprise development stack is ready.` and includes the loopback
URL, Installation ID, private key path, next check, and cleanup command.

### Verify development

`dev-up` runs this check before reporting success. To run it again, copy the
command under `Check API access again` in the output. It includes your API URL
and service-key file path. You can also set them yourself:

```bash
OCC_URL='http://127.0.0.1:3000' \
  OCC_SERVICE_KEY_FILE='/private/path/initial-admin-service-key.json' \
  scripts/occ-api GET /installation
```

Expect HTTP `200` with `data.id` matching `meta.installationId` in the key
file. This proves controller access, not an Agent deployment or model turn. For
startup internals, see the [Docker development flow](../flows/docker-compose-development.md).

For optional operational log export and Collector metrics, follow
[Configure platform observability](observability.md#docker-compose).

### Open the platform console

Open `/console/` on the API URL printed by `dev-up`, normally
`http://127.0.0.1:3000/console/`. Sign in with the provisioned human account
email and password. Production uses the same `/console/` path on the approved
internal HTTPS origin matching `OCC_AUTH_BASE_URL`; it retains the existing
ClusterIP/network boundary and secure cookie settings.

The browser uses the human administrator session path, not service keys. The
[console reference](../reference/console.md) describes Namespace selection,
Agent creation with editable starter Configuration JSON, Agent draft and revision
inspection, channel draft edits, initial Kubernetes runtime credential provisioning,
deployment, and live workspace-file editing. Rollback, Agent deletion,
Configuration listing, and live gateway health remain API or operator procedures.

## Production

### Production prerequisites

- Explicit Kubernetes context, enforcing NetworkPolicies, Helm, `kubectl`, and
  Python 3.
- `yq` v4 for validating and reading the protected YAML copies.
- Controller and runtime image digests (build them below).
- External PostgreSQL with separate migrator and application roles.
- Operator-managed HTTPS access for approved clients; the chart does not create TLS or Ingress.
- Operator-created startup, database, authentication, optional Provider Secrets,
  fresh protected bootstrap PVC, gateway storage, and exact egress destinations.

### Build and publish production images

Repository maintainers can use the separately approved
[private container publication workflow](../../.github/containers.md).
The manual operator-controlled registry path below remains available.

Build and push two images to a registry your cluster can access:

| Image      | Source                                                                                                 | Used by                                          |
| ---------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| Controller | Root [`Dockerfile`](../../Dockerfile), target `runtime`                                                | API, worker, migration, and bootstrap            |
| Runtime    | [`deploy/runtime/Dockerfile`](../../deploy/runtime/Dockerfile), installing OpenClaw and Codex from npm | Gateways and Agents (the same image serves both) |

You need Docker with Buildx and registry push access. Replace the example
registry and repository, and select the platform matching your Kubernetes
nodes. The base image below matches the [runtime recipe](../../deploy/runtime/README.md),
which also documents package-version overrides.

The runtime must include the channel plugins its Agents enable, with their
runtime dependencies available from a fresh home directory. The standard recipe
packages Slack and Codex. Verify plugin loading and the gateway's supported
Codex app-server version before publishing; use the
[runtime image checks](../../deploy/runtime/README.md#verify-the-local-image).
Use the same verified runtime image for both slots unless you have separately
verified the gateway/Codex image pair. Runtime package installation at gateway
startup is not part of this deployment procedure.

```bash
export OCC_IMAGE_REPOSITORY='registry.example.com/your-team/openclaw-enterprise'
export OCC_IMAGE_TAG="$(git rev-parse HEAD)"
export OCC_IMAGE_PLATFORM='linux/amd64'
export NODE_BASE_IMAGE='node:24-bookworm@sha256:934240a162082fd8b8a2f90cd5114446443f1eba1c5378f6687167ca405e6584'
docker login registry.example.com

docker buildx build --push --platform "$OCC_IMAGE_PLATFORM" --target runtime \
  --build-arg NODE_BASE_IMAGE="$NODE_BASE_IMAGE" \
  -t "$OCC_IMAGE_REPOSITORY/controller:$OCC_IMAGE_TAG" .
docker buildx build --push --platform "$OCC_IMAGE_PLATFORM" \
  --build-arg NODE_BASE_IMAGE="$NODE_BASE_IMAGE" \
  -f deploy/runtime/Dockerfile \
  -t "$OCC_IMAGE_REPOSITORY/runtime:$OCC_IMAGE_TAG" deploy/runtime

CONTROLLER_DIGEST="$(docker buildx imagetools inspect \
  "$OCC_IMAGE_REPOSITORY/controller:$OCC_IMAGE_TAG" \
  --format '{{json .Manifest}}' | yq -p=json -r '.digest')"
RUNTIME_DIGEST="$(docker buildx imagetools inspect \
  "$OCC_IMAGE_REPOSITORY/runtime:$OCC_IMAGE_TAG" \
  --format '{{json .Manifest}}' | yq -p=json -r '.digest')"
export CONTROLLER_IMAGE="$OCC_IMAGE_REPOSITORY/controller@$CONTROLLER_DIGEST"
export RUNTIME_IMAGE="$OCC_IMAGE_REPOSITORY/runtime@$RUNTIME_DIGEST"
```

Continue only after both builds and digest lookups succeed. Keep these exports
for the YAML configuration below; Kubernetes requires digest references, not
tags. For private registries, configure cluster/node pull credentials for both
control-plane and tenant Pods; `docker login` only authenticates your builder.

### Configure the Installation

Set the production shell inputs before the first Kubernetes command. For a local
Kubernetes trial, [build and import the test images](#build-images-for-local-kubernetes)
to produce YAML copies with real image digests, then set
`OCC_INPUT_DIRECTORY` to that generated directory and keep those files.
For production, use the registry digests from the build-and-publish step above.

```bash
umask 077
export OCC_INPUT_DIRECTORY="${OCC_INPUT_DIRECTORY:-/secure/occ}"
export KUBECONFIG_FILE="$OCC_INPUT_DIRECTORY/kubeconfig"
export CONTEXT='<production-context>'
install -d -m 700 "$OCC_INPUT_DIRECTORY"
install -d -m 700 /secure/occ
test -e "$OCC_INPUT_DIRECTORY/values.yaml" || \
  install -m 600 deploy/examples/production/values.yaml "$OCC_INPUT_DIRECTORY/values.yaml"
test -e "$OCC_INPUT_DIRECTORY/installation.yaml" || \
  install -m 600 deploy/examples/production/installation.yaml "$OCC_INPUT_DIRECTORY/installation.yaml"
test -e "$OCC_INPUT_DIRECTORY/bootstrap-pvc.yaml" || \
  install -m 600 deploy/examples/production/bootstrap-pvc.yaml "$OCC_INPUT_DIRECTORY/bootstrap-pvc.yaml"
chmod 600 "$KUBECONFIG_FILE" "$OCC_INPUT_DIRECTORY/values.yaml" \
  "$OCC_INPUT_DIRECTORY/installation.yaml" "$OCC_INPUT_DIRECTORY/bootstrap-pvc.yaml"
```

The default examples use native API-key operation. Helm values own the
controller image, API endpoint, Secret names, bootstrap claim, optional
Collector, and network selectors. Installation YAML owns gateway/Agent images,
Driver selection, projected identity, runtime networking/storage, and the shared
startup logging level.

For `logging.level`, follow [Choose the log level](observability.md#1-choose-the-log-level),
including when to restart OCC and deploy a new AgentRevision.

If you built the production images above, write their digest references into
the protected copies (skip this block for the local Kubernetes import path):

```bash
: "${CONTROLLER_IMAGE:?Set the controller digest reference}"
: "${RUNTIME_IMAGE:?Set the runtime digest reference}"
yq -i '.images.controller = strenv(CONTROLLER_IMAGE)' "$OCC_INPUT_DIRECTORY/values.yaml"
yq -i '.drivers.compute.configuration.images.gateway = strenv(RUNTIME_IMAGE) |
  .drivers.compute.configuration.images.agent = strenv(RUNTIME_IMAGE)' \
  "$OCC_INPUT_DIRECTORY/installation.yaml"
```

Edit the protected YAML copies before provisioning anything:

- `$OCC_INPUT_DIRECTORY/values.yaml`: set `images.controller` to the
  controller digest, `auth.baseUrl` to the production OCC URL,
  `bootstrap.adminEmail` to the first administrator, `database.cidr` to the
  exact PostgreSQL endpoint CIDR, `cluster.cidr` to the Kubernetes API endpoint
  CIDR, `api.clients` to approved client selectors, and
  `bootstrap.password.claimName` to the bootstrap PVC name.
- `$OCC_INPUT_DIRECTORY/installation.yaml`: set `occ.cluster`, `logging.level`,
  both `drivers.compute.configuration.images` digests, the DNS and gateway-client
  selectors, the service-principal token settings, the runtime Secret prefixes,
  and `runtime.gatewayStorageClassName`. Keep
  `drivers.compute.configuration.images.requireImmutableDigest: true`.
  For dedicated Codex command execution on nodes whose default syscall policy
  blocks user namespaces, install a reviewed compatibility profile on every
  eligible node and set `runtime.codexSeccompProfile` to its relative kubelet
  profile path. See the [Kubernetes runtime requirements](../reference/drivers/kubernetes-compute.md#requirements).
- `$OCC_INPUT_DIRECTORY/bootstrap-pvc.yaml`: set the bootstrap PVC name,
  namespace, size, and protected `storageClassName` for the cluster.

Validate the configured copies, render the Helm chart, and derive the helper
image from the same Helm values file:

```bash
yq e -e '.images.controller | test("@sha256:[a-f0-9]{64}$")' \
  "$OCC_INPUT_DIRECTORY/values.yaml" >/dev/null
yq e -e '.auth.baseUrl != "" and .bootstrap.adminEmail != "" and
  .database.cidr != "" and .cluster.cidr != "" and (.api.clients | length > 0)' \
  "$OCC_INPUT_DIRECTORY/values.yaml" >/dev/null
yq e -e '.drivers.compute.configuration.images.requireImmutableDigest == true and
  (.drivers.compute.configuration.images.gateway | test("@sha256:[a-f0-9]{64}$")) and
  (.drivers.compute.configuration.images.agent | test("@sha256:[a-f0-9]{64}$")) and
  .drivers.compute.configuration.runtime.gatewayStorageClassName != ""' \
  "$OCC_INPUT_DIRECTORY/installation.yaml" >/dev/null
yq e -e '.metadata.namespace == "openclaw-system" and .spec.storageClassName != ""' \
  "$OCC_INPUT_DIRECTORY/bootstrap-pvc.yaml" >/dev/null
helm template oce deploy/helm/openclaw-enterprise \
  --namespace openclaw-system -f "$OCC_INPUT_DIRECTORY/values.yaml" \
  >/tmp/oce-rendered.yaml
export CONTROLLER_IMAGE="$(yq e -r '.images.controller' "$OCC_INPUT_DIRECTORY/values.yaml")"
export BOOTSTRAP_CLAIM="$(yq e -r '.bootstrap.password.claimName' "$OCC_INPUT_DIRECTORY/values.yaml")"
test "$BOOTSTRAP_CLAIM" = "$(yq e -r '.metadata.name' "$OCC_INPUT_DIRECTORY/bootstrap-pvc.yaml")"
```

`$KUBECONFIG_FILE` must select the same cluster as `$CONTEXT`.

Prepare these local files under `/secure/occ`. Their contents become Kubernetes
Secret values in the next step; each file contains one raw value, without quotes
or a variable name such as `OCC_DATABASE_URL=`.

| File                  | Contents and source                                                                                                                                                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `occ-application-url` | PostgreSQL connection URL for the limited application role, used by bootstrap, the API, and the worker. Obtain it from your database administrator or provider. Example shape: `postgresql://occ_app:<url-encoded-password>@<postgres-host>:5432/<database>`.                   |
| `occ-migration-url`   | Connection URL for a separate role allowed to apply schema migrations. It targets the same database. Example shape: `postgresql://occ_migrator:<url-encoded-password>@<postgres-host>:5432/<database>`. Obtain this credential separately; do not give it to the API or worker. |
| `occ-auth-secret`     | A random secret used to sign and verify user sessions. Generate it once for this Installation with the command below, then retain it across redeployments. It is separate from the administrator password, service API key, and model-provider key.                             |

Save the two complete database URLs using your secret manager or a protected
editor, replacing the example placeholders and preserving provider-required TLS
options. Generate the auth secret for a new Installation; this command refuses
to overwrite an existing file:

```bash
(
  umask 077
  set -C
  openssl rand -hex 32 > /secure/occ/occ-auth-secret
)
chmod 600 /secure/occ/occ-application-url /secure/occ/occ-migration-url \
  /secure/occ/occ-auth-secret
test -s /secure/occ/occ-application-url
test -s /secure/occ/occ-migration-url
```

Keep these values out of Helm values, Installation YAML, Configurations, shell
history, and this repository.

### Provision system Secrets and install

Create the namespace and system Secrets from protected files:

```bash
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" create namespace openclaw-system
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" \
  apply --dry-run=server -f /tmp/oce-rendered.yaml
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" \
  apply --dry-run=server -f "$OCC_INPUT_DIRECTORY/bootstrap-pvc.yaml"
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n openclaw-system \
  create secret generic occ-installation-startup --from-file=installation.yaml="$OCC_INPUT_DIRECTORY/installation.yaml"
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n openclaw-system \
  create secret generic occ-database --from-file=application-url=/secure/occ/occ-application-url --from-file=migration-url=/secure/occ/occ-migration-url
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n openclaw-system \
  create secret generic occ-auth --from-file=secret=/secure/occ/occ-auth-secret
```

These commands provision operator-owned inputs; they are not a recurring Secret
synchronizer.

#### Optional operational log export

Before installing the chart, configure the Collector Secrets and Helm values
using [Configure platform observability](observability.md#kubernetes-and-helm).
That guide also covers reusing an existing cluster Collector, exporter
credentials, and verification. Return here to prepare the bootstrap PVC and
install OCC.

#### Prepare the fresh bootstrap output PVC

Create the fresh claim from the native example, then prepare the mounted root
with the same immutable Node-capable image selected for the controller:

```bash
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" \
  -n openclaw-system apply -f "$OCC_INPUT_DIRECTORY/bootstrap-pvc.yaml"

scripts/prepare-bootstrap-volume --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" \
  --namespace openclaw-system --claim "$BOOTSTRAP_CLAIM" --image "$CONTROLLER_IMAGE"
```

The helper refuses any nonfresh mounted root except filesystem-owned
`lost+found`, reports `Prepared bootstrap volume claim ... with UID/GID 1000
mode 0700.` on success, and retains a failed Pod for diagnosis. If policy
forbids the preparation Pod, have the storage administrator create the same root
state through the approved storage workflow.

Install the chart with native values:

```bash
helm upgrade --install oce deploy/helm/openclaw-enterprise \
  --kubeconfig "$KUBECONFIG_FILE" --kube-context "$CONTEXT" \
  --namespace openclaw-system -f "$OCC_INPUT_DIRECTORY/values.yaml" \
  --wait --timeout 5m
```

Helm owns migration and bootstrap ordering through its initialization hook.
Readiness covers the API and worker probes. It does not prove authenticated API
access, Agent deployment, or a model turn.

### Authenticate to the production API

Retrieve `initial-admin-service-key.json` from the protected bootstrap PVC
through approved storage access, then set:

```bash
export OCC_URL='https://<internal-occ-host>'
export OCC_SERVICE_KEY_FILE='/secure/occ/initial-admin-service-key.json'
scripts/occ-api GET /installation
```

Expect HTTP `200` with `data.id` matching the key file's
`meta.installationId`. A completed initialization Job is not an exec endpoint,
and neither the API nor worker mounts the bootstrap PVC.

After the production API authenticates, continue with Namespace preparation,
Agent deployment, production workload verification, and the production TUI proof.

### Prepare each Namespace

#### Use a driver-managed Kubernetes namespace

Fresh bootstrap creates a platform Namespace named `default`. Read
`scripts/occ-api GET /namespaces` and select its server-assigned ID as
`NAMESPACE_ID`. The worker creates
the backing Kubernetes namespace and labels it with
`openclaw.dev/namespace=$NAMESPACE_ID`. This is separate from Kubernetes'
built-in `default` namespace. Once the worker has created it, discover and
export its name for the tenant RoleBindings:

```bash
TENANT_NAMESPACE="$(kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" \
  get namespaces -l "openclaw.dev/namespace=$NAMESPACE_ID" -o json | \
  python3 -c 'import json,sys; items=json.load(sys.stdin)["items"]; assert len(items) == 1, "Expected one backing Namespace; check worker provisioning"; print(items[0]["metadata"]["name"])')" && export TENANT_NAMESPACE
```

If no backing namespace is found, check the worker logs and repeat discovery
after creation. Complete the tenant RoleBindings below, then wait until
`GET /namespaces/$NAMESPACE_ID` reports `ready` before creating Configurations.

#### Grant tenant RoleBindings

Grant the chart's worker, Configuration, and Secret ClusterRoles in each tenant
namespace. Replace the `oce-` prefix if the Helm release name differs:

```bash
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" \
  -n "$TENANT_NAMESPACE" create rolebinding openclaw-enterprise-worker \
  --clusterrole=oce-openclaw-tenant-worker --serviceaccount=openclaw-system:openclaw-enterprise-worker
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" \
  -n "$TENANT_NAMESPACE" create rolebinding openclaw-enterprise-api \
  --clusterrole=oce-openclaw-tenant-configuration --serviceaccount=openclaw-system:openclaw-enterprise-api
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" \
  -n "$TENANT_NAMESPACE" create rolebinding openclaw-enterprise-api-secrets \
  --clusterrole=oce-openclaw-tenant-api --serviceaccount=openclaw-system:openclaw-enterprise-api
```

The Secret RoleBinding grants tenant-local Secret access only to the API. It
does not give the worker Secret API permission or replace OCC IAM grants for
bound Secrets.

### Prepare each Agent

Prepare Agent deployment after the Namespace is ready. The operator shell must
have `OCC_URL`, `OCC_SERVICE_KEY_FILE`, `NAMESPACE_ID`,
`TENANT_NAMESPACE`, `KUBECONFIG_FILE`, and `CONTEXT` set. `TENANT_NAMESPACE`
is the Kubernetes namespace created by the driver during
[Namespace preparation](#prepare-each-namespace).

### Configure the Agent runtime

Choose one runtime mode and write the matching Namespace-owned
`kind: "agent"` Configuration. Use `embedded` for built-in OpenClaw:

```bash
export AGENT_EXECUTION_MODE='embedded'
cat > configuration.json <<'JSON'
{"kind":"agent","values":{"gateway":{"mode":"local","bind":"lan","auth":{"mode":"token","token":"${OPENCLAW_GATEWAY_TOKEN}"}},"agents":{"defaults":{"model":"openai/gpt-5.6-sol","skipBootstrap":true,"models":{"openai/gpt-5.6-sol":{"agentRuntime":{"id":"openclaw"}}}}},"models":{"providers":{"openai":{"baseUrl":"https://api.openai.com/v1","api":"openai-responses","models":[{"id":"gpt-5.6-sol","name":"gpt-5.6-sol"}]}}}}}
JSON
```

Or use `dedicated` for the Codex runtime and its app-server placeholders. The
Configuration keeps transport placeholders separate from the model Secret and
does not contain `OPENAI_API_KEY`:

```bash
export AGENT_EXECUTION_MODE='dedicated'
cat > configuration.json <<'JSON'
{
  "kind": "agent",
  "values": {
    "gateway": {"mode": "local", "bind": "lan", "controlUi": {"enabled": false}, "auth": {"mode": "token", "token": "${OPENCLAW_GATEWAY_TOKEN}"}, "http": {"endpoints": {"chatCompletions": {"enabled": true}}}},
    "agents": {"defaults": {"model": "codex/gpt-5.6-sol", "skipBootstrap": true, "models": {"codex/gpt-5.6-sol": {"agentRuntime": {"id": "codex"}}}}},
    "models": {"providers": {"codex": {"baseUrl": "http://127.0.0.1:9", "api": "openai-responses", "models": [{"id": "gpt-5.6-sol", "name": "gpt-5.6-sol"}]}}},
    "plugins": {"allow": ["codex"], "entries": {"codex": {"enabled": true, "config": {"appServer": {
      "mode": "guardian", "approvalPolicy": "on-request", "sandbox": "read-only",
      "transport": "websocket", "url": "${APP_SERVER_URL}", "authToken": "${APP_SERVER_TOKEN}"
    }}}}}
  }
}
JSON
```

When using native model fallbacks, keep them on the primary model provider and
give each model a compatible Harness policy. OCC validates the full selection
and preserves its fallback order; mixed Harnesses are rejected. See
[native runtime selection](../reference/harness-execution.md#native-runtime-selection).

Post the Configuration and capture the server-generated ID:

```bash
CONFIGURATION_RESPONSE="$(scripts/occ-api POST "/namespaces/$NAMESPACE_ID/configurations" configuration.json)"
CONFIGURATION_ID="$(printf '%s' "$CONFIGURATION_RESPONSE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["id"])')"
export CONFIGURATION_ID
```

Create the Agent with the captured Configuration ID and the matching execution
mode. Mismatched Harness and mode pairs fail before deployment. Optional
`serviceAccountId` must identify a same-Namespace service account the caller can
read.

```bash
: "${AGENT_EXECUTION_MODE:?choose embedded or dedicated above}"
printf '{"name":"production-agent","configurationId":"%s","executionMode":"%s"}\n' \
  "$CONFIGURATION_ID" "$AGENT_EXECUTION_MODE" > agent.json
AGENT_RESPONSE="$(scripts/occ-api POST "/namespaces/$NAMESPACE_ID/agents" agent.json)"
AGENT_ID="$(printf '%s' "$AGENT_RESPONSE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["id"])')"
export AGENT_ID
```

For an Agent without any revisions, the console can provision initial transport,
OpenAI API key, and Slack credentials through the exact-Agent API. See
[initial runtime credentials](../reference/console.md#initial-runtime-credentials).
The operator commands below remain available for installations using externally
provisioned inputs. Do not use both paths to replace an existing credential group.

Create the tenant transport Secret using the Agent ID suffix. Token-mode
gateways use `gateway-token`; dedicated Codex also uses `app-server-token`.
For native `gateway.auth.mode: "trusted-proxy"`, omit `gateway.auth.token`.
The Secret may still contain `gateway-token`, but Compute does not project
`OPENCLAW_GATEWAY_TOKEN` for that explicit mode.

```bash
umask 077
AGENT_SUFFIX="$(printf %s "$AGENT_ID" | shasum -a 256 | cut -c1-12)"
SECRET_DIRECTORY="$(mktemp -d)"
openssl rand -hex 32 | tr -d '\n' > "$SECRET_DIRECTORY/app-server-token"
openssl rand -hex 32 | tr -d '\n' > "$SECRET_DIRECTORY/gateway-token"
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" \
  -n "$TENANT_NAMESPACE" create secret generic "openclaw-agent-transport-$AGENT_SUFFIX" \
  --from-file=app-server-token="$SECRET_DIRECTORY/app-server-token" \
  --from-file=gateway-token="$SECRET_DIRECTORY/gateway-token"
```

Embedded OpenClaw uses only the gateway token. Dedicated Codex uses both
transport tokens. Model credentials stay in an Agent-owned model Secret or an
immutable service-account credential. They are not installed in controller runtime
environment, fixture output, or shell history. Console provisioning carries the
key transiently through the authorized API write without persisting it in the
controller database or logs.

For native API-key model turns through the native model Secret path, copy the
operator's protected source key into the private input file and require it to be
nonempty:

```bash
: "${OPERATOR_OPENAI_API_KEY_FILE:?set the protected source key path}"
install -m 600 "$OPERATOR_OPENAI_API_KEY_FILE" /secure/occ/openai-api-key
test -s /secure/occ/openai-api-key
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" \
  -n "$TENANT_NAMESPACE" create secret generic "openclaw-agent-model-$AGENT_SUFFIX" \
  --from-file=OPENAI_API_KEY=/secure/occ/openai-api-key
```

Do not store the native API key in Helm values, Installation YAML,
Configurations, shell history, or this repository.

Deploy the Agent and capture the immutable revision ID:

```bash
REVISION_RESPONSE="$(scripts/occ-api POST "/namespaces/$NAMESPACE_ID/agents/$AGENT_ID/deploy")"
REVISION_ID="$(printf '%s' "$REVISION_RESPONSE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["id"])')"
export REVISION_ID
printf '%s' "$REVISION_RESPONSE" | python3 -c 'import json,os,sys; data=json.load(sys.stdin)["data"]; assert data["id"] == os.environ["REVISION_ID"] and data["agentId"] == os.environ["AGENT_ID"] and data["configurationId"] == os.environ["CONFIGURATION_ID"]'
```

`scripts/occ-api` exits on non-2xx responses; deploy returns HTTP `202` with
the AgentRevision as `data`. If `configuration.json` includes OCC
`secretBindings`, the caller and Agent service principal must have `operate` on
every selected Secret before deploy. Binding changes are authorized by OCC IAM;
Kubernetes RoleBindings only allow the API to materialize backing tenant
Secrets.

### Agent workspace files

The [Envoy routing reference](../reference/gateway-routing.md) describes endpoints,
resource ownership, service keys, TLS, and failure behavior.

Enable private Agent routing to read and replace `AGENTS.md`, `SOUL.md`,
`IDENTITY.md`, and `USER.md` through OCC. Compute creates each Agent's HTTPRoute
when it provisions the gateway. One shared private hostname serves URLs of the
form `wss://<hostname>/namespaces/<namespaceId>/agents/<agentId>`; there is no
per-Agent endpoint map or API restart after provisioning.

This integration requires Kubernetes with enforced NetworkPolicies,
[Envoy Gateway v1.9](https://gateway.envoyproxy.io/docs/tasks/quickstart/),
Gateway API CRDs, and [cert-manager](https://cert-manager.io/docs/installation/).
Install and operate those controllers separately from this chart and provide
an existing Envoy GatewayClass. By default, the chart creates a namespaced
SelfSigned Issuer, a root CA Certificate, and a CA Issuer; cert-manager generates
the CA and Envoy's listener certificate. It also creates the shared Gateway,
ClusterIP EnvoyProxy, and API-key SecurityPolicy. No public listener is created.
The operator installing the chart needs permission for these infrastructure
resources; the OCC API does not.

The chart gives Envoy a stable Service name and derives its `.svc` hostname.
Normal Linux Pod DNS search resolves that name without a separate DNS record
or a fixed cluster DNS suffix. The certificate and Compute routes use the same
hostname. TLS verification remains enabled.

Create a dedicated high-entropy service key with no trailing newline, then
create its Secret in the controller namespace. Keep key files outside Git:

```sh
umask 077
python3 -c 'import secrets; print(secrets.token_hex(32), end="")' > /secure/operator/gateway-api-key
kubectl -n openclaw-system create secret generic occ-private-gateway-key \
  --from-file=occ=/secure/operator/gateway-api-key
```

Add the following to the existing Helm values. This example uses release
`oce` in `openclaw-system`; no hostname, issuer, or CA Secret is required:

```yaml
gatewayRouting:
  enabled: true
  gatewayClassName: eg
  apiKeySecretName: occ-private-gateway-key
```

The default Gateway name is `<release>-agent-gateways`, in the Helm release
namespace. Add matching routing settings to `drivers.compute.configuration`
in the Installation startup YAML:

```yaml
gatewayRouting:
  gatewayName: oce-agent-gateways
  gatewayNamespace: openclaw-system
  envoyNamespace: envoy-gateway-system
network:
  gatewayPort: 8080
  # Preserve the existing DNS namespace and Pod labels here.
```

Helm and Compute derive the hostname independently from these same settings;
Helm does not rewrite the Installation Secret. The
[Compute reference](../reference/drivers/kubernetes-compute.md#private-agent-gateway-routes)
defines the naming rule. It does not require an existing Agent gateway.

To use an existing issuer instead of creating a CA, set
`gatewayRouting.issuerRef.name`, with `kind` (default `ClusterIssuer`) and
`group` (default `cert-manager.io`). If OCC needs additional trust for that
issuer, create a Secret containing only the public CA bundle and set both
`gatewayRouting.caSecretName` and `caSecretKey`. Leave both empty when Node
already trusts the issuing CA. Explicit CA trust requires an explicit issuer;
it cannot replace the chart's generated CA bundle in automatic mode.
Root and leaf certificate outputs must use different Secrets, separate from
Installation, database, auth, provider, and service-key Secrets. An external
CA trust bundle must also remain separate from those credentials and the leaf
TLS Secret.

For custom DNS, set the same `gatewayRouting.hostname` in Helm and Compute and
make it resolve to the Envoy Service. The selected issuer must be able to issue
for that name. A custom hostname can use either the automatic CA or an existing
issuer; it does not change CA ownership.

The chart's `tenantGatewayPort` must match Compute's `network.gatewayPort`.
Remove `network.gatewayClients` when enabling routing. Compute derives the
Envoy peer from `gatewayRouting` and rejects explicit gateway clients in this mode.
Retain the Installation's other Compute settings. Restart the API and worker
when changing their Installation startup configuration. New Agent creation
thereafter needs no configuration update. The worker requires tenant-local
HTTPRoute permissions from the chart's worker role; the API needs no route
writes or gateway Pod/exec access.

Each Agent's native Configuration must explicitly select trusted-proxy auth.
This fragment shows only the relevant native fields; preserve the model,
Harness, and other existing configuration:

```yaml
gateway:
  trustedProxies:
    - <actual-proxy-source-cidr>
  allowRealIpFallback: true
  auth:
    mode: trusted-proxy
    trustedProxy:
      userHeader: x-occ-identity
      allowUsers:
        - occ-workspace-files
    identityScopes:
      occ-workspace-files:
        - operator.admin
```

Compute validates the fixed identity header, allowed identity, administrative
grant, real-IP fallback, and configured proxy sources before preparing a routed
revision. Omit `gateway.auth.token`; native OpenClaw rejects a simultaneous token
in this mode, and Compute omits automatic gateway-token projection. Do not require an
`x-forwarded-for` header in native `requiredHeaders`: the route removes it.
Envoy authenticates the service key, strips it, overwrites the fixed native
identity, and supplies `X-Real-IP` from its direct OCC connection. This supported
fallback works when OCC and Envoy share a Pod CIDR. Never fabricate an address
or admit direct workload access to compensate for native attribution failures.

NetworkPolicy must restrict native gateway ingress to those Envoy Pods. The
chart restricts proxy ingress to the OCC API and permits its required routing
and control-plane traffic. A trusted source CIDR by itself is not sufficient
isolation. Restrict Kubernetes writes to the Gateway, attached HTTPRoutes,
SecurityPolicy, native configuration, and namespace attachment labels to trusted
operators and the scoped worker. Untrusted tenants must not be able to replace
route authentication or attach their own routes.

The chart mounts the service key only into the API and sets
`OCC_GATEWAY_API_KEY_PATH`. Automatic CA mode projects only the root Secret's
public `tls.crt` as `ca.crt` and sets `NODE_EXTRA_CA_CERTS`; the signing key is
never mounted into OCC. The Pod waits for that Secret before starting. With an
explicit issuer, the API uses the optional configured CA bundle instead.
No credential or endpoint map is mounted into the worker,
Agent, or gateway. The key is an Installation-wide native administrative
credential; do not reuse a Better Auth signing key or model-provider token.
OCC still checks the human caller's exact Agent `read` or `operate` permission.

After applying the Helm and Installation changes, verify the actual resources:

```sh
kubectl -n openclaw-system get gateway oce-agent-gateways -o yaml
kubectl -n openclaw-system get issuer,certificate,securitypolicy
kubectl -n "$TENANT_NAMESPACE" get httproute
```

Require accepted/programmed routing, a ready certificate, and accepted security
policy before testing native access. Verify missing/invalid service keys and
spoofed identity headers cannot reach native administration. Then use OCC's
four-file GET/PUT routes and a fresh native session to prove consumption; a
ready proxy alone is insufficient.

For service-key rotation, first add the new key under another client ID in the
Envoy Secret while keeping `occ` unchanged. After Envoy accepts it, move the new
key to `occ` while retaining the previous value under a different client ID.
Wait for the API's mounted Secret to update and verify a new request, then
remove the previous key and verify rejection. OCC reads the file for each
operation; it does not require a restart for key rotation.

The generated root has a ten-year lifetime and reuses its private key on
renewal. The leaf has a 90-day lifetime; cert-manager renews both certificates
30 days before expiry. Automatic setup does not coordinate CA rollover:
preserve the CA Secret, plan backups, and control trust changes. For a CA key
replacement, distribute an overlapping old/new public trust bundle before
switching Envoy's certificate, restart the API to load that bundle, and remove
the old root only after no serving certificate depends on it.

cert-manager renews the server leaf certificate automatically. New WSS
connections continue using normal CA and hostname verification without an OCC
restart while the issuing CA remains trusted. Replacing a private root bundle
requires restarting the API because Node reads `NODE_EXTRA_CA_CERTS` at process
startup. This integration uses API-key authentication over WSS; the pinned
native client does not expose mTLS client-certificate options.

Without routing/key configuration, with an unsupported Driver, or when the
proxy/native gateway is unavailable, file requests return
`503 DEPENDENCY_UNAVAILABLE`. Docker does not implement this automatic routing
path. The [Agents reference](../reference/agents.md#workspace-files) owns file
limits and authorization behavior; [testing](../testing.md) distinguishes live
integration evidence from rendering and conformance checks.

### Verify production workloads

Wait for `GET /namespaces/$NAMESPACE_ID/agents/$AGENT_ID` to report the
expected `activeRevisionId`, then verify one denied and one allowed gateway
connection for the selected Agent. A Helm release, rendered chart, or ready
controller does not prove tenant runtime, gateway WebSocket authentication, or
a model turn. Use the production TUI proof below when the accepted evidence is
an interactive model-backed session.

### Attach with the OpenClaw TUI

Find the Ready gateway Pod for the active revision by matching the mounted
immutable ConfigMap:

```bash
AGENT_SUFFIX="$(printf %s "$AGENT_ID" | shasum -a 256 | cut -c1-12)"
REVISION_SUFFIX="$(printf %s "$REVISION_ID" | shasum -a 256 | cut -c1-12)"
EXPECTED_CONFIGMAP="gateway-$AGENT_SUFFIX-rev-$REVISION_SUFFIX"
GATEWAY_PODS_JSON="$(kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" \
  -n "$TENANT_NAMESPACE" get pods \
  -l "app.kubernetes.io/managed-by=openclaw-enterprise,openclaw.dev/workload-role=gateway,openclaw.dev/namespace=$NAMESPACE_ID,openclaw.dev/agent=$AGENT_ID" \
  -o json)"
GATEWAY_POD="$(printf '%s' "$GATEWAY_PODS_JSON" | python3 -c 'import json,sys; pods=[p for p in json.load(sys.stdin)["items"] if not p["metadata"].get("deletionTimestamp") and p.get("status",{}).get("phase")=="Running" and any(c.get("type")=="Ready" and c.get("status")=="True" for c in p.get("status",{}).get("conditions",[])) and any(v.get("configMap",{}).get("name")==sys.argv[1] for v in p["spec"].get("volumes",[]))]; assert len(pods)==1, f"expected exactly one Ready active gateway Pod, got {len(pods)}"; print(pods[0]["metadata"]["name"])' "$EXPECTED_CONFIGMAP")"
export GATEWAY_POD
```

Attach from the exported `$GATEWAY_POD`:

```bash
E2E_SESSION="production-tui-$(date +%Y%m%d%H%M%S)"
NONCE="$(python3 -c 'import secrets; print("OPENCLAW_TUI_" + secrets.token_hex(8))')"
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n "$TENANT_NAMESPACE" \
  exec -it "$GATEWAY_POD" -c gateway -- env -u OPENAI_API_KEY \
  OPENCLAW_STATE_DIR=/tmp/occ-tui-client node /app/openclaw.mjs tui \
  --session "$E2E_SESSION" --message "Reply exactly: $NONCE"
```

The TUI uses the Pod-local WebSocket listener and injected gateway token. The
extra client process unsets `OPENAI_API_KEY`; model access stays in the serving
gateway path. Ctrl+D exits only the client.

This Pod-local TUI procedure requires token authentication. It does not apply
to gateways configured with the trusted-proxy authentication used by private
workspace-file routing; that mode intentionally has no gateway token. Use the
OCC file API for the supported administration path in that configuration.

### End the operator session

Remove only temporary local delivery copies:

```bash
rm -- "$OCC_SERVICE_KEY_FILE"
test -z "${OCC_SERVICE_KEY_DIRECTORY:-}" || rmdir -- "$OCC_SERVICE_KEY_DIRECTORY"
unset OCC_SERVICE_KEY_FILE OCC_SERVICE_KEY_DIRECTORY
```

This does not revoke the key or remove protected bootstrap storage.

### Stop or remove a production deployment

Inventory tenant workloads before uninstalling the control plane:

```bash
helm uninstall oce --namespace openclaw-system
```

Helm does not own external PostgreSQL, operator-created Secrets, bootstrap PVCs,
or tenant workloads created by Compute. Retain database, bootstrap storage, and
tenant resources until recovery and retention requirements are satisfied.

For startup failure diagnosis and readiness behavior, see the
[production startup flow](../flows/production-startup.md). For the runtime path
from OCC deployment through native TUI attachment, see the
[production TUI flow](../flows/production-tui.md).

## Local Kubernetes and development operations

Use these optional procedures when you need digest-pinned images for a local
Kubernetes trial, development cleanup, or an end-to-end development TUI proof.
The production Namespace and Agent setup sequence appears above.

### Build images for local Kubernetes

This uses the same build/import path as the local Kubernetes tests. Build the
controller from this checkout and one combined OpenClaw/Codex image for both
Installation image slots. Local build digests vary by build and platform, so
read them from the imported images instead of copying a sample digest.

Prerequisites: Docker, k3d, and [yq v4](https://github.com/mikefarah/yq).
Create a disposable single-server cluster without changing your kubeconfig:

```bash
export CLUSTER="occ-images-$(date +%s)"
export OCC_EXAMPLE_DIRECTORY="$(mktemp -d)"
k3d cluster create "$CLUSTER" --servers 1 --agents 0 \
  --api-port 127.0.0.1:0 \
  --kubeconfig-update-default=false --kubeconfig-switch-context=false
k3d kubeconfig get "$CLUSTER" > "$OCC_EXAMPLE_DIRECTORY/kubeconfig"
chmod 600 "$OCC_EXAMPLE_DIRECTORY/kubeconfig"
export KUBECONFIG_FILE="$OCC_EXAMPLE_DIRECTORY/kubeconfig"
export CONTEXT="k3d-$CLUSTER"
```

Build and import the images:

```bash
docker build --target runtime \
  --build-arg NODE_BASE_IMAGE=node:24-bookworm@sha256:934240a162082fd8b8a2f90cd5114446443f1eba1c5378f6687167ca405e6584 \
  -t "localhost/$CLUSTER/controller:local" .
docker build -f deploy/runtime/Dockerfile \
  -t "localhost/$CLUSTER/runtime:local" deploy/runtime
k3d image import "localhost/$CLUSTER/controller:local" \
  "localhost/$CLUSTER/runtime:local" -c "$CLUSTER"
```

Register each imported manifest digest in k3s:

```bash
for role in controller runtime; do
  tag="localhost/$CLUSTER/$role:local"
  digest="$(docker exec "k3d-$CLUSTER-server-0" ctr -n k8s.io images list |
    awk -v image="$tag" '$1 == image { print $3 }')"
  printf '%s\n' "$digest" | grep -Eq '^sha256:[a-f0-9]{64}$' || exit 1
  reference="localhost/$CLUSTER/$role@$digest"
  docker exec "k3d-$CLUSTER-server-0" ctr -n k8s.io images tag "$tag" "$reference"
  if [ "$role" = controller ]; then
    export CONTROLLER_IMAGE="$reference"
  else
    export RUNTIME_IMAGE="$reference"
  fi
done
```

Populate private YAML copies with those references:

```bash
umask 077
cp deploy/examples/production/{values,installation,bootstrap-pvc}.yaml "$OCC_EXAMPLE_DIRECTORY/"
yq -i '.images.controller = strenv(CONTROLLER_IMAGE)' "$OCC_EXAMPLE_DIRECTORY/values.yaml"
yq -i '.drivers.compute.configuration.images.gateway = strenv(RUNTIME_IMAGE) |
  .drivers.compute.configuration.images.agent = strenv(RUNTIME_IMAGE)' "$OCC_EXAMPLE_DIRECTORY/installation.yaml"
printf 'Image-configured examples: %s\n' "$OCC_EXAMPLE_DIRECTORY"
```

These references work in this cluster and retain `requireImmutableDigest: true`.
Use the generated directory in place of `/secure/occ` in the production commands;
keep its image values and kubeconfig instead of copying the templates again.
Set the remaining database, HTTPS, network, and storage inputs for your trial
(k3d's default StorageClass is `local-path`). The images alone do not configure
those dependencies or prove an Agent model turn. When finished with the trial,
run `KUBECONFIG="$KUBECONFIG_FILE" k3d cluster delete "$CLUSTER"`.

### Stop development safely

```bash
docker compose down
```

This preserves PostgreSQL, Configuration, and bootstrap-key volumes. Use
`docker compose down --volumes` only when deliberately deleting the local
Installation after accounting for Agent containers and tenant networks owned by
Docker Compute.

### Development end-to-end TUI

Prerequisites: completed [development startup](#development), exported
`OCC_URL` and `OCC_SERVICE_KEY_FILE` from the `dev-up` output,
`OPENAI_API_KEY` available to the worker, and the quickstart runtime image.

Recreate the worker when it was already running without the model credential:

```bash
docker compose up -d --force-recreate worker
docker compose exec -T worker \
  node -e 'process.exit((process.env.OPENAI_API_KEY || "").trim() ? 0 : 1)'
```

Select the initial `default` Namespace and save its server-generated ID:

```bash
NAMESPACE_ID="$(scripts/occ-api GET /namespaces | python3 -c 'import json,sys; matches=[n for n in json.load(sys.stdin)["data"] if n["name"] == "default"]; assert len(matches) == 1, "Expected one bootstrap-created default Namespace"; print(matches[0]["id"])')"
export NAMESPACE_ID
```

Poll `scripts/occ-api GET "/namespaces/$NAMESPACE_ID"` until `data.status` is
`ready`. Create `configuration.json` from the embedded OpenClaw example in
[Configure the Agent runtime](#configure-the-agent-runtime), then create and
deploy the Agent:

```bash
CONFIGURATION_RESPONSE="$(scripts/occ-api POST "/namespaces/$NAMESPACE_ID/configurations" configuration.json)"
CONFIGURATION_ID="$(printf '%s' "$CONFIGURATION_RESPONSE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["id"])')"
printf '{"name":"tui-agent","configurationId":"%s","executionMode":"embedded"}\n' "$CONFIGURATION_ID" > agent.json
AGENT_RESPONSE="$(scripts/occ-api POST "/namespaces/$NAMESPACE_ID/agents" agent.json)"
AGENT_ID="$(printf '%s' "$AGENT_RESPONSE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["id"])')"
REVISION_RESPONSE="$(scripts/occ-api POST "/namespaces/$NAMESPACE_ID/agents/$AGENT_ID/deploy")"
REVISION_ID="$(printf '%s' "$REVISION_RESPONSE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["id"])')"
export AGENT_ID REVISION_ID
```

After `GET /namespaces/$NAMESPACE_ID` reports `ready` and
`GET /namespaces/$NAMESPACE_ID/agents/$AGENT_ID` reports the deployed
`activeRevisionId`, discover the single owned Docker gateway container:

```bash
GATEWAY_CONTAINER="$(docker ps -q \
  --filter label=org.openclaw.enterprise.managed=true \
  --filter label=org.openclaw.enterprise.compute-driver=docker \
  --filter label=org.openclaw.enterprise.namespace-id="$NAMESPACE_ID" \
  --filter label=org.openclaw.enterprise.agent-id="$AGENT_ID" \
  --filter label=org.openclaw.enterprise.revision-id="$REVISION_ID" \
  --filter label=org.openclaw.enterprise.role=gateway)"
test "$(printf '%s\n' "$GATEWAY_CONTAINER" | sed '/^$/d' | wc -l)" -eq 1
export GATEWAY_CONTAINER
```

Attach the TUI inside that container. It already has the gateway URL and token:

```bash
E2E_SESSION="occ-tui-$(date +%Y%m%d%H%M%S)"
NONCE="$(python3 -c 'import secrets; print("OCC_TUI_" + secrets.token_hex(8))')"
docker exec -it -e OPENCLAW_STATE_DIR=/tmp/occ-tui-client \
  "$GATEWAY_CONTAINER" node /app/openclaw.mjs tui \
  --session "$E2E_SESSION" --message "Reply exactly: $NONCE"
```

Verify the assistant replies with the nonce, send a second nonce in the same
TUI, then press Ctrl+D. Exiting the TUI does not stop the Agent gateway. Do not
pass OCC service keys, gateway tokens, `--url`, or `--token` on the command
line.

## Service API keys for automation

Use service keys for operator automation after startup has succeeded. Set
`OCC_URL` to the loopback development URL or approved production HTTPS endpoint.
Keep shell tracing and curl verbose output disabled.

### Retrieve the bootstrap service key

Development `dev-up` prints the private local key path after it copies the key.
For a manual copy, create a fresh private directory:

```bash
umask 077
export OCC_SERVICE_KEY_DIRECTORY="$(mktemp -d)"
export OCC_SERVICE_KEY_FILE="$OCC_SERVICE_KEY_DIRECTORY/initial-admin-service-key.json"
docker compose cp bootstrap:/var/lib/openclaw/bootstrap/initial-admin-service-key.json \
  "$OCC_SERVICE_KEY_FILE"
chmod 600 "$OCC_SERVICE_KEY_FILE"
```

For production, retrieve the same basename from the protected bootstrap PVC
through approved storage access and store it in `$OCC_SERVICE_KEY_FILE`.
Validate it immediately:

```bash
scripts/occ-api GET /installation
```

Expect HTTP `200` with response `data.id` matching `meta.installationId`. The
initial service key expires after 30 days.

### Recover an incomplete bootstrap

Bootstrap makes one attempt. On failure, preserve logs, non-secret IDs, and
protected output. Confirm database commit state before deleting anything. If the
attempt did not commit, remove only proven orphan accounts/keys and quarantine
only that attempt's output. If it did commit, retain the credentials and use
normal key recovery. Never delete output, reset the database, or rerun bootstrap
as an automatic fallback.

### Recover a lost or exposed service key

With retained key/principal IDs, sign in as the human administrator, revoke the
old key, then [issue a replacement](#issue-a-service-key). Without retained IDs,
inspect only non-secret key metadata and IAM bindings to identify the exact key.
Do not export secret key values, password hashes, sessions, or full table dumps.

### Sign in as a human administrator

Use human sign-in for key recovery, human-issued keys, or account-only APIs:

```bash
set -o pipefail
umask 077
export OCC_URL='https://<internal-occ-host>'
export OCC_ADMIN_EMAIL='<first-admin@example.com>'
export OCC_ADMIN_PASSWORD_FILE='/secure/occ/initial-admin-password'
OCC_SESSION_DIRECTORY="$(mktemp -d)"
export OCC_SESSION_COOKIE_JAR="$OCC_SESSION_DIRECTORY/cookies"
python3 -c 'import json, os, pathlib, sys; json.dump({"email": os.environ["OCC_ADMIN_EMAIL"], "password": pathlib.Path(os.environ["OCC_ADMIN_PASSWORD_FILE"]).read_text().rstrip("\n")}, sys.stdout)' |
  curl --fail-with-body --silent --show-error --cookie-jar "$OCC_SESSION_COOKIE_JAR" "$OCC_URL/api/auth/sign-in/email" -H 'Content-Type: application/json' --data-binary @- --output /dev/null
curl --fail-with-body --silent --show-error --cookie "$OCC_SESSION_COOKIE_JAR" "$OCC_URL/installation"
```

Development may use `OCC_URL="http://$(docker compose port controller 3000)"`
with the configured development administrator credentials. Sign out when done:

```bash
curl --fail-with-body --silent --show-error \
  --cookie "$OCC_SESSION_COOKIE_JAR" --cookie-jar "$OCC_SESSION_COOKIE_JAR" \
  --request POST "$OCC_URL/api/auth/sign-out" --output /dev/null
rm -- "$OCC_SESSION_COOKIE_JAR"
rmdir -- "$OCC_SESSION_DIRECTORY"
```

### Issue a service key

Issue into an owner-readable file. Omit `namespaceId` only for an
Installation-scoped principal:

```bash
umask 077
export OCC_SERVICE_KEY_DIRECTORY='/secure/occ/service-keys'
install -d -m 700 "$OCC_SERVICE_KEY_DIRECTORY"
export OCC_SERVICE_KEY_FILE="$(mktemp "$OCC_SERVICE_KEY_DIRECTORY/key.XXXXXX")"
curl --fail --silent --show-error --cookie "$OCC_SESSION_COOKIE_JAR" \
  "$OCC_URL/api/auth/service-keys" -H 'Content-Type: application/json' \
  --data '{"servicePrincipalId":"<service-principal-id>","namespaceId":"<namespace-id>","name":"nightly-reader","expiresIn":2592000}' \
  --output "$OCC_SERVICE_KEY_FILE"
```

Expect HTTP `201`. The response contains the one-time `data.key` and non-secret
`data.id` for revocation.

### Use a service key

```bash
export OCC_NAMESPACE_ID='<namespace-id>'
scripts/occ-api GET "/namespaces/$OCC_NAMESPACE_ID"
```

Expect HTTP `200` for an authorized Namespace, `401` for invalid/expired keys,
and `403` for authenticated principals missing exact IAM permission.

### Revoke or rotate a service key

```bash
OCC_SERVICE_KEY_ID="$(python3 -c 'import json, os, pathlib; print(json.loads(pathlib.Path(os.environ["OCC_SERVICE_KEY_FILE"]).read_text())["data"]["id"])')"
curl --fail --silent --show-error --cookie "$OCC_SESSION_COOKIE_JAR" \
  --request DELETE "$OCC_URL/api/auth/service-keys/$OCC_SERVICE_KEY_ID"
```

Expect HTTP `200` and `data.revoked: true`; the old key should then return
`401`. To rotate, issue a replacement, switch the client, verify access, then
revoke the old key.

### Manage keys with a service administrator

An Installation-scoped non-Agent ServicePrincipal with current `administer`
authority can issue and revoke keys without a human cookie. Send its protected
key through stdin as a header file:

```bash
python3 -c 'import json, os, pathlib, sys; key=json.loads(pathlib.Path(os.environ["OCC_ADMIN_SERVICE_KEY_FILE"]).read_text())["data"]["key"]; sys.stdout.write("x-api-key: " + key + "\n")' |
  curl --fail --silent --show-error --header @- "$OCC_URL/api/auth/service-keys" \
  -H 'Content-Type: application/json' \
  --data '{"servicePrincipalId":"<service-principal-id>","namespaceId":"<namespace-id>","name":"nightly-reader","expiresIn":2592000}' \
  --output "$OCC_SERVICE_KEY_FILE"
```

Namespace-scoped keys cannot manage other keys. Missing current grants return
`403`; invalid, expired, or revoked credentials return `401`.

## Customization

Use native surfaces for customization:

- Development: `.env`, Compose environment precedence, and optional Compose
  files passed after `--`.
- Production: extra Helm values files, ordinary Helm overrides, Kubernetes
  manifests, Installation startup YAML, and optional Collector Secrets.
- Runtime images: [`deploy/runtime`](../../deploy/runtime/README.md) for the
  recipe and package-version overrides.
  [Build and publish](#build-and-publish-production-images) before configuring the digests.
- Settings: [environment and tooling reference](../reference/settings.md).
- Driver contracts: [Kubernetes Compute](../reference/drivers/kubernetes-compute.md),
  [Kubernetes Secret](../reference/drivers/kubernetes-secret.md), and
  [Provider configuration](../reference/providers.md).

Example local override:

```bash
OPENCLAW_DEV_PORT=3100 OCC_DOCKER_RUNTIME_IMAGE=my-runtime:local \
  ./scripts/dev-up --key-output /secure/occ/session-key.json -- -f compose.yaml -f compose.local.yaml
```

If the Installation selects the ChatGPT Provider, create `occ-chatgpt-admin`
with `--from-file=admin-key=/secure/occ/occ-chatgpt-admin-key` and enable the
matching Provider/ServiceAccount Driver settings in native values and
Installation YAML.
