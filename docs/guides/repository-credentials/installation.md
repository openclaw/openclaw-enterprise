# Install repository access for Kubernetes Agents

Enable the optional repository credential service alongside the single OCC
worker. Complete the [production installation prerequisites](../deploy/production-installation.md)
and use its operator shell, `KUBECONFIG_FILE`, `CONTEXT`, `OCC_INPUT_DIRECTORY`
and `openclaw-system` namespace. Run these commands from the repository root.
Use Kubernetes Compute-owned embedded OpenClaw or dedicated Codex with compatible
[Harness authentication](../../reference/agents.md#harness-authentication) and no
Sandbox Driver.

## Prepare the registry and protected inputs

Create `registry.json` using the [canonical registry schema](../../reference/repository-credentials.md#canonical-platform-registry).
Use the real GitHub App, installation and numeric repository IDs, and the
server-assigned OCC Namespace IDs. Installations always use a GitHub App; the
[development token authority](../../reference/repository-credentials/development-token.md)
is standalone and development-only. One App installation can serve several
repository entries; each Agent binding still admits a separate single-repository
session. The example below uses Backend ID `repository-backend`, registry
maximum duration `86400`, and all three profiles.

Choose the Namespace first with `occ namespace list` on an existing installation.
For a fresh installation, initially leave this optional capability disabled,
bootstrap OCC, then obtain its Namespace IDs before enabling it. Repository
names or Kubernetes namespace names do not substitute for those IDs.

Place these operator inputs in a private directory such as `/secure/occ/repositories`:

| File                 | Required contents                                                |
| -------------------- | ---------------------------------------------------------------- |
| `registry.json`      | Nonsecret canonical registry with exact Namespace/profile policy |
| `config.json`        | Service configuration below                                      |
| `private-key.pem`    | Existing RSA private key for the registry's GitHub App           |
| `tls.crt`, `tls.key` | Gateway certificate chain and matching private key               |
| `ca.crt`             | Public PEM CA trust for that certificate, without private keys   |

Leave `tls.crt`, `tls.key`, and `ca.crt` absent until Helm renders the broker
origin in the next section. The certificate's exact DNS SAN must cover the
rendered internal Service hostname. Wildcard or Common Name fallback does not
satisfy the Kubernetes projection check. The internal Service exposes HTTPS 443
and forwards to sidecar port 8443. Do not disable certificate verification or
use the TLS private-key Secret as the public trust input.

Write `config.json` with the same Backend ID and duration policy as the registry:

```json
{
  "gateway": {
    "listen": "0.0.0.0:8443",
    "controlSocket": "/run/openclaw/repository-control/private/control.sock"
  },
  "sessionPolicy": {
    "maximumDurationSeconds": 86400,
    "defaultProfile": "git-write",
    "allowedProfiles": ["git-read", "git-write", "git-full"]
  },
  "backend": {
    "kind": "github-app-registry",
    "backendId": "repository-backend"
  }
}
```

This is the Kubernetes projection input. The sidecar supplies the broker origin
from Helm's repository credential hostname helper, then supplies protected
registry, App-key and TLS file paths after copying its selected projection into
private owned files. It rejects an explicit `gateway.publicOrigin` that differs
from the Helm-derived origin and rejects a serving certificate that does not
cover that host. For direct standalone startup, use the
[standalone configuration](../../reference/repository-credentials.md#standalone-service-inputs)
with explicit file paths instead.

Plan session capacity before enabling many Agents. The single sidecar holds
every repository session in the installation: one per binding of each deployed
revision. A closing session keeps its slot until disposal, so stopped or
replaced revisions can hold slots for a while. The default limit is 16
sessions, and one Agent may have up to 16 bindings. When the limit is reached, new sessions
fail with a retryable `overloaded` error until slots free. To raise it, add
`"limits": { "sessions": 64 }` (any positive integer) to `config.json`. Other
[service bounds](../../reference/repository-credentials.md#client-routing-and-limits),
such as 32 concurrent exchanges, stay unchanged; raise them only with measured
load.

```bash
chmod 700 /secure/occ/repositories
chmod 600 /secure/occ/repositories/config.json \
  /secure/occ/repositories/private-key.pem
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n openclaw-system \
  create configmap occ-repository-registry-v1 \
  --from-file=registry.json=/secure/occ/repositories/registry.json \
  --dry-run=client -o json | \
  python3 -c 'import json,sys; value=json.load(sys.stdin); value["immutable"]=True; json.dump(value,sys.stdout)' | \
  kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" apply -f -
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n openclaw-system \
  create secret generic occ-repository-service \
  --from-file=config.json=/secure/occ/repositories/config.json
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n openclaw-system \
  create secret generic occ-repository-app \
  --from-file=private-key.pem=/secure/occ/repositories/private-key.pem
```

These commands create new operator-owned inputs and intentionally fail on
existing ConfigMap or Secret names. Keep key contents out of Installation YAML,
Helm values, Agent configuration and command arguments.

## Select composition and network access

Add the [GitHub Backend and Driver fragment](../../reference/backends.md#github-repository-credentials)
to the existing Installation YAML. Set its Backend ID to `repository-backend`
and `sessionDurationSeconds` to `86400`. Select the optional capability through
`drivers.repo` and the matching Backend `drivers.repo` member; keep the configured
Driver ID unchanged. Keep the shown registry, control socket
and public CA paths; Helm mounts exactly those locations.

Add this peer under the existing
`drivers.compute.configuration.network` object, retaining its other settings:

```yaml
repositoryCredentials:
  namespace: openclaw-system
  podLabels:
    app.kubernetes.io/name: openclaw-enterprise
    app.kubernetes.io/instance: oce
    app.kubernetes.io/component: worker
  port: 8443
```

The broker origin comes from admitted repository session material; fresh Helm
installs mint sessions for `git.<release-namespace>.svc.<clusterDomain>`, using
the configured repository credential cluster domain. Use the runtime image with
the OpenClaw bridge that forwards stock Codex network settings. No custom Codex
binary or Installation capability declaration is required. Compute derives the
bound Agent's broker hostname and policy from admitted session material.

Use the actual Helm release name for `app.kubernetes.io/instance`. Grant the
chart's tenant-worker RoleBinding in each tenant namespace as described in the
[Agent preparation guide](../deploy/production-agents.md#grant-tenant-rolebindings).
With the feature enabled, that role includes the material Secret operations
needed by Compute. The Agent never mounts the control socket or App key.

Build the service with `pnpm credentials:build` and `pnpm credentials:image`,
then publish and select its immutable image reference. Also build the full
Agent runtime using the [repository-root Docker context](../repository-credentials.md#prepare-the-platform-installation).
Add the following to your existing Helm values, replacing image and network
placeholders before rendering:

```yaml
repositoryCredentials:
  enabled: true
  image: "<credential-service-image>@sha256:<digest>"
  serviceName: git
  hostname: "" # Empty selects git.<release-namespace>.svc.<clusterDomain>.
  backendId: repository-backend
  registryConfigMapName: occ-repository-registry-v1
  serviceConfigSecretName: occ-repository-service
  appKeySecretName: occ-repository-app
  tlsSecretName: occ-repository-tls
  publicCaSecretName: occ-repository-ca
  upstreamCidrs:
    - "<approved GitHub upstream CIDR>"
```

`backendId` must follow the Backend ID rule: 1 to 200 characters, with no
leading or trailing whitespace and no control characters or line or paragraph
separators. It must also fit in 200 UTF-16 code units, because repository
bindings store a GitHub Backend ID under that bound: 100 emoji fit and 101 do
not. The chart refuses any other spelling, the same checks Installation
startup applies before it saves the GitHub Backend. Supply current
operator-approved ranges for GitHub HTTPS destinations. The chart
adds worker-Pod egress on port 443 and ingress from tenant embedded gateways and
dedicated Agent Pods on port 8443. Compute grants corresponding egress only to
the repository consumer; see the
[network selectors](../../reference/drivers/kubernetes-compute/networking-and-isolation.md#networking). Existing model/network
rules still apply. For repository-bound dedicated Codex or embedded OpenClaw
using `occ/codex-plugin`, Compute allows the exact broker hostname and sets stock Codex `allow_local_binding = true` and
`mode = "full"`. This permits local binding, disables Codex's additional
private-address guard, and permits all HTTP methods at otherwise allowed
destinations. Explicit denies, TLS verification, and broker authorization remain
in effect. Unbound Agents receive no generated policy change. Because worker and
sidecar share a Pod network namespace, these rules do not isolate containers
within that Pod.

Render the chart and use the rendered broker origin as the source of truth for
the certificate. The helper reads the worker sidecar argument from the rendered
manifests; it does not construct a second hostname.

```bash
node scripts/render-repository-credentials-origin.mjs \
  --release oce --namespace openclaw-system \
  --values "$OCC_INPUT_DIRECTORY/values.yaml" \
  > "$OCC_INPUT_DIRECTORY/repository-broker.json"
export REPOSITORY_BROKER_HOSTNAME="$(yq -p=json -r '.hostname' \
  "$OCC_INPUT_DIRECTORY/repository-broker.json")"
export REPOSITORY_BROKER_ORIGIN="$(yq -p=json -r '.origin' \
  "$OCC_INPUT_DIRECTORY/repository-broker.json")"
test "$REPOSITORY_BROKER_ORIGIN" = "https://$REPOSITORY_BROKER_HOSTNAME"
```

Provision the certificate through your issuer with
`$REPOSITORY_BROKER_HOSTNAME` as a DNS SAN, then save the resulting public chain,
private key, and public CA as `/secure/occ/repositories/tls.crt`,
`/secure/occ/repositories/tls.key`, and `/secure/occ/repositories/ca.crt`.
If you change namespace, Service name, or cluster domain, rerun the helper and
reissue the certificate before applying the chart.

Create the TLS and public-CA Secrets after the files exist:

```bash
chmod 600 /secure/occ/repositories/tls.key
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n openclaw-system \
  create secret tls occ-repository-tls \
  --cert=/secure/occ/repositories/tls.crt --key=/secure/occ/repositories/tls.key
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n openclaw-system \
  create secret generic occ-repository-ca \
  --from-file=ca.crt=/secure/occ/repositories/ca.crt
```

The [image upgrade helper](../deploy/production-upgrade.md) carries forward the
running broker's Service name and exact hostname automatically. For direct Helm
upgrades of an existing installation with active repository sessions, keep
`repositoryCredentials.serviceName` and `repositoryCredentials.hostname` set to
the current Service name and exact broker hostname. The hostname must be
`<serviceName>.<namespace>.svc` or that name followed by `.<clusterDomain>`;
URLs, ports, and unrelated hosts are rejected. For example, a broker using
`openclaw-enterprise-repository-credentials.openclaw-system.svc` must retain that
full value in `hostname`, even with the same Service name. Preserve its CA and
certificate until sessions drain. Then issue a certificate for
`git.<namespace>.svc.<clusterDomain>`, set `serviceName` to `git`, clear
`hostname` to use the derived name, and deploy new Agent revisions. Restarting the broker process can lose in-memory sessions, and
an old mounted session also pins the broker origin and public trust material it
received at admission. The chart cannot detect whether sessions have drained;
upgrades fail unless `serviceName` is explicit so operators choose the current
name or the deliberate cutover name.

## Install and verify

Update the operator-owned startup Secret from the edited Installation YAML. The
command replaces only the Installation key, which keeps the Secret's
`openclaw.dev/installation-id` annotation, and does not print the file. Render and review the
complete chart, then apply the values through the existing release:

```bash
export OCC_INSTALLATION_SECRET="$(yq -er '.installation.secretName // "occ-installation-startup"' "$OCC_INPUT_DIRECTORY/values.yaml")"
export OCC_INSTALLATION_KEY="$(yq -er '.installation.key // "installation.yaml"' "$OCC_INPUT_DIRECTORY/values.yaml")"
jq -n --arg key "$OCC_INSTALLATION_KEY" --rawfile document "$OCC_INPUT_DIRECTORY/installation.yaml" \
  '{data: {($key): ($document | @base64)}}' |
  kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n openclaw-system \
    patch secret "$OCC_INSTALLATION_SECRET" --type merge --patch-file /dev/stdin
helm template oce deploy/helm/openclaw-enterprise --namespace openclaw-system \
  -f "$OCC_INPUT_DIRECTORY/values.yaml" > /tmp/oce-rendered.yaml
helm upgrade --install oce deploy/helm/openclaw-enterprise \
  --kubeconfig "$KUBECONFIG_FILE" --kube-context "$CONTEXT" \
  --namespace openclaw-system -f "$OCC_INPUT_DIRECTORY/values.yaml" \
  --wait --timeout 5m
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n openclaw-system \
  rollout status deployment/openclaw-enterprise-worker
```

Expect one worker Pod containing worker and credential-service containers, a
`Recreate` deployment, and the internal HTTPS Service. The API mounts only the
registry and public CA; the worker additionally mounts the private control
socket; App/TLS private inputs stay in the service container. In the worker
Pod, only the worker container receives a Kubernetes API service-account token;
the credential-service container (`repository-credentials`) gets none. Confirm
those mounts from the rendered manifests before deploying an Agent.

A ready sidecar confirms protected startup and the control listener. Continue
with [Agent creation, deployment and a repository task](../repository-credentials.md#create-and-deploy-an-agent)
to verify the actual consumer. Registry or certificate mismatch fails closed;
check IDs, exact paths, DNS SAN and public trust first. A service restart loses
in-memory sessions. A lost session already delivered to an Agent fails its
revision and queues runtime retirement; worker maintenance does not recreate it.
Inspect retained cleanup obligations before explicitly deploying a new authorized
revision. That deployment does not settle old cleanup or replay repository
operations. See [restart and cleanup limits](../../reference/repository-credentials.md#repo-driver-contract).
Updating policy requires a new immutable registry ConfigMap and consistent
selection by all three consumers; existing admitted grants are not silently widened.
