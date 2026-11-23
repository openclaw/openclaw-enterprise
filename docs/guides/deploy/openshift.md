---
tags: [human_verified]
last_verified: "2026-11-18"
---

# Prepare OCE for OpenShift

Use this page for OpenShift-specific networking before the shared
[Kubernetes control plane installation](production-installation.md).
Start with [cluster, storage, and network preparation](kubernetes.md).

## Requirements

- The shared [Kubernetes requirements](production-installation.md#requirements).
- The `oc` CLI, an explicitly selected cluster context, and access to inspect DNS Pods and Kubernetes API endpoints.

## Configure DNS and API access

On OpenShift, select the actual DNS backend namespace and Pod labels; the
[Helm DNS grants](../../reference/settings/production.md#required-production-controller-environment)
permit both Service and backend ports. Helm merges `dns.podLabels` into the chart
default `k8s-app: kube-dns`. Profile rendering removes that default for you. In
hand-written values, set `dns.podLabels.k8s-app: null` when the DNS Pods lack that
label.

On OpenShift with OVN-Kubernetes, the CNI applies egress policy after the
`kubernetes` Service translates port 443 to the API server port, usually 6443.
Set Helm `cluster.cidrs` to the API server endpoint IPs and `cluster.port` to
that port. In a profile input, set `controlPlane.clusterCidrs` and
`controlPlane.clusterPort`. With the default 443, the API and worker fail with
`KUBERNETES_API_UNAVAILABLE`. List the endpoints with
`oc get endpoints kubernetes -n default`.

## Continue installation

Save the DNS selectors and API endpoint settings in your profile input or
protected Helm values. Continue with [control plane installation](production-installation.md)
in the same operator shell.

If the installation runs an initialization Job, check DNS from its Pod while the
Job runs. Check the API, worker and enabled supporting workloads as they start.
For each workload, verify that DNS resolution works over UDP and TCP. Confirm
that DNS traffic to a Pod outside the configured DNS selectors is denied.
