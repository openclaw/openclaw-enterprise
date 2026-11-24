# Kubernetes Secret Driver

The Kubernetes Secret Driver stores OCC Secret values in the Kubernetes
verified tenant storage namespace for the owning OpenClaw Namespace. Each Secret belongs to one
Namespace, returns metadata only through OCC, and can be delivered as an
environment variable through an Agent `harnessAuth` API-key binding or a
Configuration `secretBindings` entry for gateway-only credentials.

The [SecretDriver base contract](secret.md) defines the shared interface, IAM, and
lifecycle. This page owns Kubernetes setup and operator procedures.

The Driver stores values for environment delivery, transient server-side
hosted plugin discovery, and [credential source](../credential-sources.md)
registration. OCC stores [Codex device-login sessions](kubernetes-compute/codex-oauth-storage.md)
in PostgreSQL.

Single-cluster Compute uses the tenant workload namespace, including adopted
namespaces. The two-cluster profile retains separate control-cluster storage.
Namespace workload managers are trusted with both Gateway and Harness roles.

## Requirements

- The bundled Kubernetes Compute Driver must select or create the backing
  tenant storage namespace for the OpenClaw Namespace.
- The OpenClaw Namespace must be `ready` before Secret create, update, or
  projection validation or server-side credential use can succeed.
- The controller API needs tenant-local Kubernetes Secret `get`, `create`,
  `update`, `patch`, and `delete` permission in each tenant storage namespace.
  The trusted worker reads admitted sources and manages selected runtime projections
  in the data plane. Workload ServiceAccounts receive no Secret API permissions.
- The caller must be authenticated through OCC and authorized to create or
  mutate the exact Secret. Configuration and Agent assignment changes that bind a
  Secret separately require caller `operate` on each exact Secret. Deployment
  also requires the deploying actor and the consuming Agent's service principal
  to have `operate` on every bound Secret; see
  [binding and deployment requirements](#bind-a-secret-to-gateway-environment).
  Plugin discovery requires Agent `create` and exact Secret `operate` by the caller.
- Secret values must be nonempty UTF-8 strings without NUL bytes, at most
  65,536 UTF-8 bytes, and fit the OCC request-body limit.

The Installation operator remains responsible for Kubernetes at-rest
encryption, safe backups, tenant-local RoleBindings, metadata-only audit
configuration for Kubernetes Secret operations, and IAM policy provisioning for
Secret consumption.

## Configure the driver

Select the bundled driver in the trusted Installation startup YAML. The API and
worker must read the same file through `OCC_CONFIG_PATH`.

```yaml
drivers:
  secret:
    id: secret-kubernetes
    configuration:
      authentication:
        mode: inCluster
```

The driver also supports an explicit kubeconfig for local verification:

```yaml
drivers:
  secret:
    id: secret-kubernetes
    configuration:
      authentication:
        mode: kubeconfig
        kubeconfigPath: /secure/operator/oce-kubeconfig
        context: oce-production
```

The driver does not accept installed packages, injected Kubernetes clients,
ambient kubeconfig fallback, unverified TLS, caller-selected Kubernetes
namespaces, or caller-selected Kubernetes Secret names. Backend identity is
OCC-owned metadata.

## Installation-private OAuth client secrets

Helm provisions a separate Kubernetes namespace for confidential registrations and configures both the API and worker to use it. Outside Helm, use `OCC_INSTALLATION_SECRET_NAMESPACE` to select a dedicated namespace. The driver defaults to `oce-installation-secrets`. Grant the API permission to get, create, update, and delete Secrets there. Grant the worker get and delete. Keep workloads and tenant RoleBindings out of this namespace.

The Driver creates one Opaque Secret per registration. Rotation replaces its value in place. Before using or deleting the Secret, the Driver checks its Installation, registration, and Driver identity. Kubernetes resource versions fence concurrent changes.

If Kubernetes confirms creation but returns an object that fails these checks, the Driver attempts to delete the requested object with the returned UID and resourceVersion. A replacement or changed object is preserved. Confirmed removal keeps the original refusal; missing preconditions or an unconfirmed delete report an unknown outcome. OCC retains its hidden registration until the cleanup worker confirms that the private object is absent.

## Create a Namespace-owned Secret

Create the Secret after the OpenClaw Namespace is ready. An Agent does not need
to exist yet. Keep the value in a protected file or secret manager output; do
not put it in a shell command, URL, log line, or example JSON checked into
source.

Use `OCC_URL` and the protected `OCC_SERVICE_KEY_FILE` from
[operator authentication](../../guides/deploy/production-installation.md#authenticate-to-the-production-api),
plus `NAMESPACE_ID`. This Node.js example sends the key and value from protected
files, follows no redirects, and prints only the metadata response. If the API
uses a private CA, configure `NODE_EXTRA_CA_CERTS` with its CA bundle first.

```bash
umask 077
SECRET_VALUE_FILE=/secure/operator/slack-bot-token
export NAMESPACE_ID

node --input-type=module - "$SECRET_VALUE_FILE" <<'JS'
import { readFileSync } from "node:fs";
const value = readFileSync(process.argv[2], "utf8").replace(/\n$/, "");
const { data: { key } } = JSON.parse(readFileSync(process.env.OCC_SERVICE_KEY_FILE, "utf8"));
const url = new URL(`/namespaces/${encodeURIComponent(process.env.NAMESPACE_ID)}/secrets`, process.env.OCC_URL);
const response = await fetch(url, {
  method: "POST", redirect: "error",
  headers: { "x-api-key": key, "content-type": "application/json" },
  body: JSON.stringify({ name: "slack-bot-token", value }),
});
if (response.status !== 201) {
  const error = (await response.json().catch(() => null))?.error;
  throw new Error(`Secret creation failed: HTTP ${response.status} ${error?.code ?? ""}: ${error?.message ?? ""}`);
}
console.log(JSON.stringify(await response.json()));
JS
```

A successful create returns HTTP `201` with metadata only:

```json
{
  "data": {
    "id": "sec_123e4567-e89b-42d3-a456-426614174000",
    "namespaceId": "ns_123e4567-e89b-42d3-a456-426614174000",
    "name": "slack-bot-token",
    "ref": {
      "kind": "secret",
      "namespaceId": "ns_123e4567-e89b-42d3-a456-426614174000",
      "id": "sec_123e4567-e89b-42d3-a456-426614174000"
    }
  },
  "meta": { "requestId": "req_123e4567-e89b-42d3-a456-426614174000" }
}
```

OCC stores the Secret ID, Namespace ID, selected driver ID, and opaque
Kubernetes backend reference. The value is stored only by the driver and is
never returned by OCC. When a credential source is registered, the API reads the
value with the same labels, annotations, UID, and key checks as `resolve` and
passes it only to the Credential Gateway.

List readable metadata with `GET /namespaces/:namespaceId/secrets`; see the
[SecretDriver IAM contract](secret.md#iam) for collection and exact-Secret checks.
The list does not query Kubernetes or return values.

## Bind a Secret to gateway environment

Add the returned reference to `secretBindings` on the Agent's Configuration. The
[Configuration reference](../configuration/secrets.md#secret-bindings) owns the binding
shape and full native OpenClaw example. OCC validates binding sources, env
delivery, and reserved environment destinations; the selected SecretDriver only
resolves and validates the stored backend identity:

```json
{
  "secretBindings": {
    "SLACK_BOT_TOKEN": {
      "source": {
        "kind": "secret",
        "namespaceId": "ns_123e4567-e89b-42d3-a456-426614174000",
        "id": "sec_123e4567-e89b-42d3-a456-426614174000"
      }
    }
  }
}
```

All bound Secrets must belong to the same Namespace as the Configuration and
consuming Agent. OCC rejects cross-Namespace references. It permits
same-Namespace sharing only when the caller has the normal Configuration or
Agent mutation permission and `operate` on each exact Secret. Namespace
membership, Configuration access, Agent access, or possession of a ref is not
enough.

Deployment requires `operate` on each bound Secret for both the caller and
the Agent’s stable service principal. With transactional Native IAM,
[deployment can supply missing Agent grants](../authorization/default-users.md#grant-an-agent-its-credentials-at-deployment).
OCC stores these grants outside Installation YAML, Driver YAML and Kubernetes
RoleBindings. If policy is managed externally, have the IAM administrator
grant the Agent access before deployment. Authorized Agent responses include
its service principal ID.

Deployment freezes the normalized bindings and selected Secret Driver ID in the
AgentRevision. It does not snapshot backend locators or value bytes.
The API authorizes the deploying actor and the consuming Agent service principal,
then asks the selected Secret Driver to validate the backend during admission.
The worker rechecks the actor and Agent service principal before resolving
current OCC metadata and passing an ephemeral projection context to the Compute
Driver. That metadata lookup calls neither the Secret Driver nor the
Kubernetes Secret API. Kubernetes Compute runs in the trusted worker. It checks
and references the original channel Secrets for dedicated Gateways. For embedded
Gateways and direct Harness API keys, it copies approved fields into revision
Secrets. Only selected Gateways receive the environment bindings through
`secretKeyRef`. Native OpenClaw then resolves the environment SecretRefs.

For model credentials, use [Agent harness authentication](../agents.md#harness-authentication).
The API-key binding uses this same Secret Driver and exact authorization, but
Kubernetes places the projection only in the selected model-executing Harness.
Use `harnessAuth` for direct model keys in dedicated and embedded deployments.
Never bind a model key as a channel credential.

## Update and redeploy

If the credential is exposed, revoke it at the provider immediately and stop
affected workloads. For routine rotation, [identify all consumers](#find-a-secrets-consumers)
first. Review each Agent's draft before deploying. Deploy only Agents intended
to run. Leave stopped or never-deployed Agents offline until their next
intended deployment.

To replace related channel Secrets together, stop the affected running Agents
and wait for shutdown before changing any values. Updates are separate writes.
Keep the Agents stopped until every update succeeds.

Patch only the value with
`PATCH /namespaces/:namespaceId/secrets/:secretId { "value": "..." }`. Keep the
value in a protected file or secret manager output and send it with the protected
request pattern above. Change the method to `PATCH`, use the exact Secret URL
and send only `JSON.stringify({ value })`. Change the error check to `response.status !== 200`
and the message prefix to `Secret update failed`.

HTTP `200` returns unchanged metadata and `ref` in `data`. The Driver has
stored the replacement. This does not restart a Gateway, edit an AgentRevision
or confirm that any running process uses the new value.

For a direct Harness API key, deploy a new revision of each
[consuming Agent](#find-a-secrets-consumers) that should run with the replacement.
Revision preparation delivers the current fields to the runtime Secret even
if the Configuration and reference are unchanged. Wait for each revision to
become active and make a model request. For routine rotation, verify use of
the new key before revoking the old one. A successful request alone cannot
identify the key.

If a [credential source](../credential-sources.md) holds the key as a Gateway
copy, also run `occ credential-source update ID` after updating the Secret and
before deploying. A deployment alone starts the new version with the old copy.
See [Update a source](../credential-sources/other-delivery-modes.md#update-a-source).

With OpenShell, that source update briefly disconnects the workspace node of
every running Agent that uses the source, even when nothing changed. A turn that
starts meanwhile can fail with HTTP 500, and so can a native OpenClaw turn
already in progress. Update the source while those Agents are idle.

Recreating a Harness Pod or running `kubectl rollout restart` only reads its
existing revision projection; neither is a credential-delivery operation.
Embedded Gateway environment bindings also require a new OCE deployment to
refresh their revision copies.

Enabled channels require dedicated execution. The dedicated Gateway reads
current channel Secrets at startup. Once the updates are
complete, deploy the Agents that should resume through OCE. Wait for Gateway readiness
and check delivery through that channel.

A [channel proxy credential](../agents/network-proxy.md#agent-operations)
is separate. After rotating the Secret in `networkProxy.credentialSecretId`,
deploy a new revision when the Agent should run. Restarting the Gateway cannot update the proxy
binding’s Secret version. Verify that the proxied channel works with the
replacement.

See the [replacement procedure](../../guides/deploy/credential-lifecycle.md#replace-runtime-values-and-verify-consumption)
for verification and safe upstream revocation.

There is no value history, automatic rotation, workload restart on update or
rollback. Updating or deleting a Secret leaves delivered values in process
environments. After revoking a compromised credential, store and [deliver the replacement](#update-and-redeploy)
before resuming work. Clear references before [deletion](#delete).

### Find a Secret's consumers

The exact Secret read, `GET /namespaces/:namespaceId/secrets/:secretId` or
`occ secret get "$SECRET_ID"`, returns `consumers`: the IDs of the Agents,
Configurations, credential sources, and pending Agent provisioning requests
that currently reference the Secret. An Agent is listed when its draft, selected
version, or a pending deployment references the Secret. These are the same
references that block deletion.

```bash
./bin/occ secret get "$SECRET_ID" -o json | jq '.consumers'
```

OCC examines up to 50 references, ordered by kind and ID. `unreadable` counts
hidden entries among those examined. Only the initiating actor with the
required current grants can see a provisioning request. `truncated: true`
means more references exist. Wider access cannot remove this limit.
Follow listed Configurations and credential sources to their consumers.
The list can omit Agents that use a Secret indirectly.
Before routine revocation, account for missing consumers with authorized
owners or a separate inventory.

The same read returns `callerPermissions`: whether you may replace (`update`) and
delete (`delete`) the Secret now. It is advisory and records no denial; the write
is still authorized when you send it.

## Delete

Delete only unreferenced Secrets. This example uses an authenticated human
session from [service-key recovery](../../guides/deploy/service-keys.md#sign-in-as-a-human-administrator)
at the configured `OCC_URL`. Set `OCC_ORIGIN` to the configured Console origin
from `OCC_AUTH_BASE_URL` (scheme, host, and optional port only):

```bash
curl --fail-with-body -sS \
  "$OCC_URL/namespaces/$NAMESPACE_ID/secrets/$SECRET_ID" \
  -X DELETE \
  -H "Origin: $OCC_ORIGIN" \
  -b "$OCC_SESSION_COOKIE_JAR"
```

Successful deletion returns HTTP `204`. OCC denies deletion while the Secret is
referenced by any current Configuration, credential source, Agent draft, selected version, pending deployment, or queued or running Agent provisioning request.
The `409` names the references you may read, as many as fit the message, for
example `The Secret is still referenced by Agent agt_…; 1 resource you cannot
read. Remove those references first.` [Find its consumers](#find-a-secrets-consumers)
for readable references and lookup limits.
Inactive historical revisions alone do not prevent deletion.
Namespace removal is also blocked while owned Secrets remain. Agent removal does
not own or garbage-collect Namespace Secret storage.

Missing or foreign backend objects fail closed during binding validation and
mutation. The driver never silently adopts an existing Kubernetes Secret. If a
delete partially succeeds, retrying the same exact Secret delete can finish
metadata cleanup after OCC verifies the stored backend identity.

## Troubleshooting

- **Secret create returns `409`:** For `RESOURCE_CONFLICT` with "A Secret with
  this name already exists in this Namespace", choose another name or update the
  existing Secret. For `NAMESPACE_NOT_READY`, wait until the platform Namespace is
  `ready` and its backing Kubernetes namespace is bound to the exact Namespace ID.
- **Secret delete returns `409` `RESOURCE_CONFLICT`:** Check
  [all reference types](#find-a-secrets-consumers). Ask the owners to clear
  unwanted references and settle pending provisioning. Repeat the lookup
  as blockers clear.
- **Secret operation returns `403`:** Verify OCC permission for the exact Secret
  or parent Namespace. For binding or Agent assignment, also verify caller
  `operate` on each exact Secret. For deployment, verify both the deploying actor
  and the consuming Agent service principal have `operate` on every bound Secret.
  Kubernetes tenant-local Secret RBAC is a separate requirement and does not
  grant IAM authority.
- **Secret operation returns `503`:** Check Kubernetes authentication, TLS,
  tenant namespace readiness, API RoleBinding, and whether the backend object
  still has exact OCC labels and annotations. A message naming a fix instead means the
  Secret was stored through a previously selected Secret Driver; see the
  [SecretDriver lifecycle](secret.md#lifecycle).
- **Configuration update is rejected:** Confirm every binding references a
  Secret in the same Namespace and that the caller has `operate` on every
  selected Secret, including retained bindings when PATCH omits `secretBindings`.
  Omit `secretBindings` on PATCH to preserve existing bindings, or send an empty
  map to clear them.
- **A rotated value is not visible:** Follow [Update and redeploy](#update-and-redeploy)
  for the delivery mode. Restarting a Pod cannot refresh a revision copy.

## Related

- [Namespace configuration](../configuration.md)
- [Settings](../settings.md)
- [Production Kubernetes deployment](../../guides/deploy.md)
- [Kubernetes Compute Driver](kubernetes-compute.md)
- [Platform design](../../design/safeguards.md#secret-access)
- [SecretDriver storage and delivery spec](../../../specs/.archive/14-secret-driver.md)
