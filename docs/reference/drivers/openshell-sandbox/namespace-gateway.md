# Create an OpenShell gateway during Namespace setup

Select `gateway.namespaceGatewayResources` in the trusted OpenShell Sandbox
configuration. This implementation is awaiting live qualification. Use the
[operator-owned mode](../openshell-sandbox.md#gateway-readiness-and-workspace)
unless the required integration proof passes for your selected configuration.

For namespace-owned gateways, supply `gateway.namespaceGatewayResources`: 1–64
namespaced manifests for the gateway Service, Deployment or StatefulSet, storage,
configuration, and policies. The Backend must resolve the readiness Service in
that same backing namespace. `${OCE_NAMESPACE}` substitutes only that namespace
in manifest values. Foreign ownership blocks updates and deletion. Owned workload updates use
server-side apply with exact UID and resource-version checks. Namespace
setup creates a private `<readiness.serviceName>-jwt-keys` signing Secret, then
reconciles resources, verifies readiness and health, and creates the Workspace.
No Agent or model credential is created. Cluster operators must prepare CRDs,
RuntimeClasses, RBAC and approved images. This mode is incompatible with
operator-owned preprovisioned resources. Its live qualification is tracked in
[OpenShell coverage](../../../testing/openshell-coverage.md#namespace-bootstrap).

The allowed manifest kinds are Service, ServiceAccount, ConfigMap, Secret,
PersistentVolumeClaim, Deployment, StatefulSet, Role, RoleBinding and NetworkPolicy.
RoleBindings may reference only namespace-local Roles and ServiceAccounts.
The selected client still needs its operator-provided tenant permissions;
configuration does not grant those permissions. Kubernetes Compute's Helm worker
role includes StatefulSets only within namespaces with its tenant RoleBinding.

Configured Secrets are created once. Retries verify their initial data and metadata
and preserve provider-managed fields. A changed initial value fails explicitly;
reconciliation does not rotate keys or replace gateway-managed tokens.

The gateway uses the private `<readiness.serviceName>-jwt-keys` Secret created by
the Driver. Do not include another manifest for that Secret or put Agent/model
credentials in gateway manifests. Configure the gateway to read its signing key
from that Secret. Retries keep the existing owned key.

In operator Workspace mode, configure the gateway to use the Sandbox ServiceAccount
from the Namespace's Workspace manifests. Agent accounts do not exist during
bootstrap, and the gateway chart's default account name can differ from that
Workspace account.

Deletion removes the owned Workspace before gateway resources and its signing key
when the managed gateway is reachable. Without a ready gateway Pod, or after a
recognized transport outage, cleanup removes the owned gateway resources directly.
Authorization or provider refusals still block cleanup. It retains operator-owned resources. A failed or incomplete deletion blocks
Compute teardown. After Compute removes the backing namespace, a cleanup retry
treats these namespace-owned resources as absent. Readiness failures remain pending; repair the configured images,
RBAC, or network access and allow reconciliation to retry. Ownership conflicts
require operator investigation; the Driver does not adopt foreign resources.

See [Namespace lifecycle](../namespace-lifecycle.md) for cancellation and ordering,
and [OpenShell proof](../../../testing/openshell-coverage.md#namespace-bootstrap)
for the test and remaining gaps.
