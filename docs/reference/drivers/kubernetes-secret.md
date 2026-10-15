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
registration. **Experimental** Codex OAuth device login keeps private provider
state in the same backend and uses atomic compare-and-swap to fence concurrent
completion and cancellation. Once an
OAuth source is claimed for runtime handoff, ordinary value updates and
compare-and-swap are rejected, so it can no longer be cancelled, only deleted;
reconnect creates a new Secret. Hosted existing-Agent discovery uses its bound `codex_pat` Secret
or a separate Agent-scoped OAuth login;
Create Agent discovery can use a selected Secret. Curated discovery needs no
Secret. Values never enter Console responses. The Driver does not issue
credentials, share Secrets across Namespaces, keep value history, restart
workloads after an update, roll values back, or broker per-access Secret reads.
Native OpenClaw
`SecretRef` handling for `env`, `file`, and `exec` configuration remains the
gateway's responsibility.

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
SECRET_VALUE_FILE=/secure/operator/agent-model-key
export NAMESPACE_ID

node --input-type=module - "$SECRET_VALUE_FILE" <<'JS'
import { readFileSync } from "node:fs";
const value = readFileSync(process.argv[2], "utf8").replace(/\n$/, "");
const { data: { key } } = JSON.parse(readFileSync(process.env.OCC_SERVICE_KEY_FILE, "utf8"));
const url = new URL(`/namespaces/${encodeURIComponent(process.env.NAMESPACE_ID)}/secrets`, process.env.OCC_URL);
const response = await fetch(url, {
  method: "POST", redirect: "error",
  headers: { "x-api-key": key, "content-type": "application/json" },
  body: JSON.stringify({ name: "model-api-key", value }),
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
    "name": "model-api-key",
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

Before deployment, the selected IAM policy must grant both the deploying actor
and the consuming Agent's existing stable service principal `operate` on every
bound Secret. Native IAM policy is controller-owned persisted state, not
Installation YAML, Driver YAML, or Kubernetes RoleBindings. Authorized Agent
responses expose the Agent service principal ID, and administrators can create
the exact Secret grant through the Namespace IAM policy API before a
Secret-backed deployment is admitted.

Deployment freezes the normalized bindings and selected Secret Driver ID in the
immutable AgentRevision. It does not snapshot backend locators or value bytes.
The API authorizes the deploying actor and the consuming Agent service principal,
then asks the selected Secret Driver to validate the backend during admission.
The worker rechecks the actor and Agent service principal before resolving
current OCC metadata and passing an ephemeral projection context to the Compute
Driver; it does not call the Secret Driver or Kubernetes Secret API. The Compute
Driver renders Kubernetes `secretKeyRef` environment variables only into each
explicitly selected consuming gateway. Native OpenClaw configuration then
resolves the env SecretRefs normally.

For model credentials, use [Agent harness authentication](../agents.md#harness-authentication).
The API-key binding uses this same Secret Driver and exact authorization, but
Kubernetes places the projection only in the selected model-executing Harness.
Dedicated gateways cannot receive model credentials through Configuration
bindings. Embedded OpenClaw also selects its key through `harnessAuth`.

## Update and redeploy

Patch only the value with
`PATCH /namespaces/:namespaceId/secrets/:secretId { "value": "..." }`. Keep the
value in a protected file or secret manager output and send it with the protected
request pattern above, changing the method, exact-Secret URL, and body to match
the PATCH operation. The Secret reference stays stable.

The response returns the same metadata and `ref`. Update success means the
driver stored the new value; it does not restart a gateway, edit an existing
AgentRevision, or prove that a running process has consumed the value.

For a Harness model API key, update the OCC Secret, explicitly deploy every
[consuming Agent](#find-a-secrets-consumers) through OCE, wait for each new revision to become active, and
verify a model request before revoking the old key upstream. Revision preparation
reads the current CP source and delivers the admitted fields into the DP runtime
Secret before starting the Harness. An unchanged Configuration or Secret reference
does not remove the need to deploy again.

Recreating a Harness Pod or running `kubectl rollout restart` only reads its
existing revision projection; neither is a credential-delivery operation.
Embedded Gateway bindings also use revision projections and require explicit
OCE deployment to refresh. Dedicated Gateway restarts read current canonical
channel values directly.
See the [replacement procedure](../../guides/deploy/credential-lifecycle.md#replace-runtime-values-and-verify-consumption)
for verification and safe upstream revocation.

There is no value history, automatic rotation, automatic workload restart, or
value rollback. Updating or deleting an OCC Secret does not remove credentials
already delivered to a running process environment, and deletion is blocked while
current Configurations, credential sources, Agent drafts, active revisions, or pending
deployments still depend on the Secret. For a compromised credential, stop the affected workloads and revoke
the credential at the upstream provider; then update the OCC Secret with a
replacement value and redeploy the intended consumers. Delete the Secret only
after its reference dependencies are cleared; see [Delete](#delete).

### Find a Secret's consumers

The exact Secret read, `GET /namespaces/:namespaceId/secrets/:secretId` or
`occ secret get "$SECRET_ID"`, returns `consumers`: the IDs of the Agents,
Configurations, credential sources, and pending Agent provisioning requests
that currently reference the Secret. An Agent is listed when its draft, active
revision, or a pending deployment references the Secret. These are the same
references that block deletion.

```bash
./bin/occ secret get "$SECRET_ID" -o json | jq -r '.consumers.agents[]'
```

Only resources you may read are named; `unreadable` counts the others without
naming them, so someone with wider read access must find those. A provisioning
request is named only for the actor that started it. OCC examines at most 50
references, ordered by kind and ID; `truncated: true` means more exist. An Agent
that uses a listed Configuration but has not deployed it is not listed; its next
deployment reads the current value.

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
referenced by any current Configuration, credential source, Agent draft, active revision, pending deployment, or queued or running Agent provisioning request.
The `409` names the references you may read, as many as fit the message, for
example `The Secret is still referenced by Agent agt_…; 1 resource you cannot
read. Remove those references first.` [Find its consumers](#find-a-secrets-consumers)
for the full list.
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
- **Secret delete returns `409` `RESOURCE_CONFLICT`:** Remove each named
  reference, then retry. For references you cannot read, ask someone with read
  access to the Namespace's Agents and Configurations to clear them.
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
- **A rotated value is not visible:** Secret update does not restart workloads.
  Deploy each consuming Agent through OCE and verify the new revision became
  active; restarting a Pod does not refresh revision projections.

## Related

- [Namespace configuration](../configuration.md)
- [Settings](../settings.md)
- [Production Kubernetes deployment](../../guides/deploy.md)
- [Kubernetes Compute Driver](kubernetes-compute.md)
- [Platform design](../../design/safeguards.md#secret-access)
- [SecretDriver storage and delivery spec](../../../specs/.archive/14-secret-driver.md)
