# Existing split-layout installations

This page is part of the [Kubernetes Compute Driver](../kubernetes-compute.md) reference.

Releases before #925 kept each Namespace's Gateways, Gateway state and canonical
Secrets in a separate `oce-gateways-<hash>` namespace. During single-cluster
namespace discovery, API and worker startup refuse a storage namespace when all
three conditions hold.

- `openclaw.dev/gateway-namespace` has a nonempty value.
- The name is `oce-gateways-` followed by the first 24 hexadecimal digits of
  the SHA-256 hash of that value.
- `openclaw.dev/namespace` is absent. An empty value is still present.

The check changes nothing.
[Preprovisioned installations](preprovisioned-namespace.md#what-the-chart-changes)
use a named namespace read. Before replacing the controller images, set
`KUBECONFIG_FILE` and `CONTEXT` to the release's reviewed kubeconfig file and
context. Require a complete, successful read before drawing a conclusion.

```sh
kubectl --kubeconfig "${KUBECONFIG_FILE:?}" --context "${CONTEXT:?}" get namespaces \
  -l 'openclaw.dev/gateway-namespace,!openclaw.dev/namespace' \
  -L openclaw.dev/gateway-namespace
```

The output rows are candidates only. Check each against all three startup
conditions. The two-cluster profile's control-cluster rows are expected.

Adopt each tenant in place with the
[split-layout upgrade](../../../guides/deploy/split-layout-upgrade.md):
the storage namespace becomes the tenant namespace and keeps its Secrets,
Configurations and Gateway state, and the old namespace's claims and Agent
Secrets move into it. Compute accepts the `oce-gateways-<hash>` name as a tenant
namespace only while it keeps its own storage label. Do not add the tenant label
by hand: the old namespace's claims, routes and transport Secrets would not move.
