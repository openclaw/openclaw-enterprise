# Preprovisioned Kubernetes Namespace

This page is part of the [Kubernetes Compute Driver](../kubernetes-compute.md) reference.

Use the Helm value `preprovisionedNamespace` when the controller cannot get
permission to create, list or delete Kubernetes namespaces. The operator
creates one tenant namespace, its RoleBindings and its OpenShell workspace
resources. The controller only reads and verifies that namespace, then
reconciles its own resources in it. The chart describes this profile as a
closed single-cluster OpenShell canary.

## Set the value

Bind one existing OCE Namespace ID and the Kubernetes UID of the namespace
that you created:

```yaml
preprovisionedNamespace:
  namespaceId: ns_example
  uid: 0f4c2a9e-6b1d-4c3e-9a7f-2d5e8b1c4a60
```

The chart refuses other keys, an ID that does not match
`^ns_[a-zA-Z0-9_-]{1,60}$` and a UID that is not a lowercase UUID. It also
refuses the value unless all of these are set:

- `executionCluster.enabled: false`
- `gatewayRouting.enabled: true` with `gatewayRouting.serviceType: ClusterIP`
- `egressAuthority.enabled: true` or `openshellGit.enabled: true`
- `auth.passwordSignIn: all`, with `auth.google` and `auth.oidc`
  and `agentNativeAdmin` disabled

Helm passes the binding to the API and worker as the JSON environment variable
`OCC_PREPROVISIONED_NAMESPACE`. At startup, the controller requires the bundled
Kubernetes Compute, Configuration and OpenShell Sandbox Drivers, an OpenShell
Backend, Compute `gatewayRouting` without `executionCluster`, and a Credential
Proxy or OpenShell Git transport. Otherwise startup stops with
`A preprovisioned Namespace requires single-cluster bundled Kubernetes and
OpenShell Drivers with Credential Proxy and gateway routing.`

## What the chart changes

- **No initialization Job.** The chart renders no migration, bootstrap or
  upgrade check Job, on install or upgrade. The database must already be
  migrated for this release and the Installation bootstrapped.
- **Named Namespace read only.** The API and worker ClusterRoles grant `get` on
  one namespace, `oce-` plus the first 15 hexadecimal characters of
  SHA-256(`namespaceId`). They grant no namespace `list`, `create`, `patch` or
  `delete`.
- **Tenant access is unchanged.** Grant the worker and API
  [tenant RoleBindings](../../../guides/deploy/production-agents.md#grant-tenant-rolebindings)
  in the bound namespace. [Check workspace reads](#check-the-workers-named-reads)
  before granting the ordinary worker role. Compute still applies its quota,
  limit range and NetworkPolicies there.

## Prepare the namespace

Create the namespace with the derived name. Compute refuses it unless it is
`Active`, not terminating, has the bound UID, and carries:

| Kind       | Key                                                        | Value                                                                          |
| ---------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Annotation | `openclaw.dev/namespace-lifecycle`                         | `preprovisioned`                                                               |
| Annotation | `openclaw.dev/namespace-id`                                | the Namespace ID                                                               |
| Label      | `app.kubernetes.io/managed-by`                             | `openclaw-enterprise`                                                          |
| Label      | `openclaw.dev/namespace`, `openclaw.dev/gateway-namespace` | the Namespace ID                                                               |
| Label      | `openclaw-enterprise.io/gateway`                           | first 12 hexadecimal characters of SHA-256(`<gatewayNamespace>/<gatewayName>`) |
| Label      | `pod-security.kubernetes.io/enforce`, `audit`, `warn`      | `restricted`                                                                   |

The gateway label is the selector of the Gateway's `https` listener; see
[Gateway routing](../../gateway-routing.md). Also add the OpenShell Sandbox
`gateway.operatorNamespaceLabels`.

Create every manifest in the OpenShell Sandbox
`gateway.operatorWorkspaceResources` and `gateway.networkPolicyResources`
in the namespace. Give each one the label
`app.kubernetes.io/managed-by: openclaw-enterprise`, the label
`openclaw.dev/namespace` and the annotation `openclaw.dev/namespace-id`, both
set to the Namespace ID. Their NetworkPolicies must use
`networking.k8s.io/v1` and declare a `spec`.

### Check the worker's named reads

If the workspace declares both objects below, check access **before** binding
the ordinary tenant-worker role or starting reconciliation. That role lacks
these reads. The workspace RoleBinding grants access to the Gateway, not the worker.

Stage the objects and the worker's read grants in the bound tenant; these two
checks need no `bind` or `escalate` grant. Confirm the tenant name and UID.
Use your installation's control-plane namespace and an operator context without
preset impersonation: `--as` does not clear inherited groups. The operator must
already be allowed to impersonate the worker ServiceAccount:

```bash
(
  worker="system:serviceaccount:${CONTROL_PLANE_NAMESPACE:?set the control-plane namespace}:openclaw-enterprise-worker"
  read_workspace() {
    kubectl --kubeconfig "${KUBECONFIG_FILE:?set the kubeconfig file}" \
      --context "${CONTEXT:?set the context}" --namespace "${TENANT_NAMESPACE:?set the bound tenant namespace}" \
      --as="$worker" get "$1.v1.rbac.authorization.k8s.io/openshell-workspace-sandbox" -o name
  }
  role=$(read_workspace roles) || exit 1
  binding=$(read_workspace rolebindings) || exit 1
  printf '%s\n' "$role" "$binding"
)
```

Continue only if both names print and the command succeeds. A forbidden `get`
naming the worker means it lacks that read. For `NotFound`, check the context,
tenant and object. An impersonation or discovery error leaves access unknown;
ask an authorized operator to check. Success does not verify contents or readiness.

## Runtime behavior

- Worker startup and the Configuration and Secret Drivers read the namespace by
  name and verify it, instead of listing namespaces.
- `ensureNamespace` never creates or patches the namespace. It refuses a
  NetworkPolicy that is not a Compute policy or a declared operator policy, or
  whose `spec` differs: `The sealed Namespace contains an undeclared or changed NetworkPolicy.`
- The OpenShell Sandbox Driver reads the namespace labels and each declared
  resource, and compares all fields except `metadata` and `status`. It applies
  nothing. A difference stops Namespace preparation with
  `Operator workspace resource does not match the OpenShell configuration.`
- Namespace cleanup removes the OpenShell Workspace and leaves the operator
  resources. Compute refuses Namespace deletion:
  `The operator retains the preprovisioned Namespace and owns its teardown.`
- Compute refuses `existingNamespace` placement and any other Namespace ID.

Both policy checks accept Kubernetes omitting an empty `ingress` or `egress`
list when `policyTypes` explicitly includes that direction. They still compare
policy types, selectors, nonempty rules and all other spec fields. An empty
rule object (`[{}]`) allows traffic and is never equivalent to an empty list.

Namespace mismatches report `KUBERNETES_OWNERSHIP_CONFLICT`, for example
`Preprovisioned Kubernetes Namespace identity, ownership, gateway membership,
Pod Security or lifecycle does not match the Installation.` Fix the namespace or
the binding; the controller does not repair it.

## Related

- [Networking and isolation](networking-and-isolation.md#namespaces-and-isolation)
- [OpenShell Sandbox Driver](../openshell-sandbox.md)
- [Production controller settings](../../settings/production.md)
