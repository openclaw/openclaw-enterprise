# Existing split-layout installations

This page is part of the [Kubernetes Compute Driver](../kubernetes-compute.md) reference.

Releases before #925 kept each Namespace's Gateways, Gateway state and canonical
Secrets in a separate `oce-gateways-<hash>` namespace. In a single cluster, API
and worker startup refuse these storage namespaces without the tenant discovery
label. The check changes nothing. Inspect the storage
targets before replacing the controller images:

```sh
kubectl get namespaces -l openclaw.dev/gateway-namespace -L openclaw.dev/namespace
```

In a single cluster, a row with an empty `NAMESPACE` column is a split-layout
tenant. The two-cluster profile's control-cluster rows are expected.

Adopt each tenant in place with the
[split-layout upgrade](../../../guides/deploy/split-layout-upgrade.md):
the storage namespace becomes the tenant namespace and keeps its Secrets,
Configurations and Gateway state, and the old namespace's claims and Agent
Secrets move into it. Compute accepts the `oce-gateways-<hash>` name as a tenant
namespace only while it keeps its own storage label. Do not add the tenant label
by hand: the old namespace's claims, routes and transport Secrets would not move.
