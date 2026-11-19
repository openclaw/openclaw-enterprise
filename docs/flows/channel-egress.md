---
created: 2026-11-19
updated: 2026-11-19
last_updated_session: authoring-run/64d7828e-4701-4e9c-8c92-0b3617945c7a
---

# Channel egress flow

## Overview

Kubernetes Compute prepares and retires channel access during the normal Agent
revision workflow. Channel Drivers declare destinations. Compute reserves a
listener, verifies Envoy's installed policy and grants access only to the
Gateway that carries the matching revision and binding labels. This flow ends
when the Gateway can start, or when revoked access is closed and its slot can
be reused. Source implementation alone does not establish live acceptance.

## Entry Points

- Trigger: an authorized Agent deployment, retry, stop or deletion.
- `apps/controller/src/composition/installation-config.ts:composeInstallationConfiguration`
- `apps/controller/src/drivers/compute/kubernetes/index.ts:KubernetesComputeDriver.prepareRevision`
- `apps/controller/src/drivers/compute/kubernetes/channel-egress.ts:KubernetesChannelEgress.prepare`

The worker holds its live PostgreSQL work claim and reauthorizes the original
actor before Compute effects. The managed fleet and enforcing NetworkPolicies
must be installed. See [controller work](controller-worker.md).

## Flow

```mermaid
graph TD
  A["Worker reads saved Agent revision"] --> B["Resolve current Channel Drivers"]
  B --> C{"Rules supported and fleet available?"}
  C -->|no| X["Fail activation without direct fallback"]
  C -->|yes| D["Reserve a port using resourceVersion"]
  D --> E["Install the binding's Envoy policy"]
  E --> F["Check active generation and exact network grants"]
  F --> G["Start Gateway with assigned HTTPS_PROXY"]
  R["Stop or retire the revision"] --> V["Remove old Gateway workloads"]
  V --> S["Replace its filter chain with deny"]
  S --> T["Wait for old chains and tunnels to close"]
  T --> U["Fence network grants and release the slot"]
```

## Execution Trace

### 1. Resolve one coherent set of requirements

`apps/controller/src/drivers/channel/routing.ts:resolveChannelRouting`

Trusted composition binds each provider ID to a Driver. Compute reads enabled
providers from the saved revision and resolves each to exactly one instance.
The shared validator rejects malformed rules and normalizes DNS names and ports.
Compute rejects unqualified IPv6 rules. Each attempt retains the resulting
requirements; a retry derives them again. Destination policies are not a
separate PostgreSQL snapshot.

### 2. Reserve and configure a listener

`apps/controller/src/drivers/compute/kubernetes/channel-egress.ts:KubernetesChannelEgress.reserve`

Compute checks the Gateway owner, dedicated Service ports and ready Envoy Pods.
It recovers an exact existing binding or reserves an idle port through the
stable EnvoyPatchPolicy's Kubernetes resource version. The initial policy denies
all targets. A conflicting reservation is read again; exhaustion rejects
activation. A different rules hash gets a different binding.

`apps/controller/src/drivers/compute/kubernetes/channel-egress-policy.ts:channelEgressFilterChain`

The allow chain checks CONNECT authority and port, resolves a strict-DNS
subcluster, and checks the selected upstream address before connecting. IPv4
special-use and installation exclusions remain mandatory. TLS stays end-to-end.

### 3. Verify enforcement before workload start

`apps/controller/src/drivers/compute/kubernetes/channel-egress.ts:KubernetesChannelEgress.waitInstalled`

The worker reads every serving Pod's configuration through the read-only
inspection listener. It requires the assigned actual TCP port, one matching listener, the intended
active filter chain, no alternate or older draining chain, and a stable Pod set. It installs the exact Gateway
source and Envoy ingress grants, then checks the complete additive policy sets.

`apps/controller/src/drivers/compute/kubernetes/index.ts:KubernetesComputeDriver.deployment`

Only the Gateway receives the assigned proxy URL and binding label. Harness
transport remains direct and its model credential placement is unchanged.

### 4. Revoke before reuse

`apps/controller/src/drivers/compute/kubernetes/channel-egress.ts:KubernetesChannelEgress.retire`

Cleanup selects only the revision's bindings. It marks each record revoking,
replaces its filter chain with deny, and checks the active generation plus the
fleet-wide `listener_manager.total_filter_chains_draining` gauge on every serving
Pod. Envoy omits in-place filter-chain drains from `config_dump`; a zero gauge
confirms that all workers removed those chains and their connections. It replaces
grants with empty policies. Before marking the slot idle, it requires the old
Gateway Pods to be absent and their Deployments and ReplicaSets to have no
desired replicas. The stop and retirement callers remove the Gateway first;
NetworkPolicy readback alone does not confirm CNI revocation. Stable resource versions fence late writes by old workers. Missing
inspection or uncertain ownership leaves the reservation for retry.

### 5. Keep OCC requests separate

`apps/controller/src/composition/installation-config.ts:composeInstallationConfiguration`

OCC derives its reserved provider endpoint from the same validated installation
settings. Its Slack Driver uses that listener for credential validation and
directory requests. Helm generates the OCC policy from the Driver declaration;
API-only grants do not expose an Agent listener. Envoy receives no Slack token.
See [directory lookup](agent-channel-directory.md) for Secret authorization.

## Debugging and Verification

Inspect the managed Gateway, EnvoyPatchPolicy bindings and network grants when
activation fails. Translation status alone is insufficient; the active listener
generation must match. Retained revoking records indicate incomplete cleanup.
Do not delete them to reclaim a port.

[The Kubernetes and Slack procedures](../testing/slack.md) select the real
runtime tests. Controlled endpoint probes prove transport, not another channel
provider's integration. The implementation plan records qualification results
and remaining acceptance evidence.

## Related docs

- [Managed channel egress](../reference/drivers/kubernetes-compute/channel-egress.md)
- [Channel Driver](../reference/drivers/channel.md)
- [RFC implementation plan](../../specs/plans/0043-channel-egress.md)

## Manual Notes

## Changelog

- 2026-11-19 05:02: Require Envoy drain acknowledgement and stopped source workloads before port reuse. (authoring-run/64d7828e-4701-4e9c-8c92-0b3617945c7a - fc683cdfe9b73215d0503cdfaf7917f54be7f17e)

- 2026-11-19 00:02: Documented channel declaration, listener ownership and revocation in the accompanying implementation (authoring-run/64d7828e-4701-4e9c-8c92-0b3617945c7a - e05a54b4b3daf86249c89aaeb2a8491dd52c80cc).
