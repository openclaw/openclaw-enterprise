---
created: 2026-10-14
updated: 2026-10-15
last_updated_session: authoring-run/903d04fd-a3a7-4825-aca7-f94d828ab2d8
---

# Gateway Outbound Flow

## Overview

An administrator saves an Agent's additional Gateway access. Deployment freezes
that approval with trusted channel requirements and Installation exclusions.
Kubernetes Compute reconciles an isolated proxy before starting that dedicated
Gateway. This flow ends when the route is ready, withdrawn, or removed after drain.

## Entry Points

- Trigger: exact-Agent PATCH, deployment POST, revision preparation and maintenance.
- Sources: `packages/occ/src/index.ts:OpenClawController.updateAgent`,
  `OpenClawController.deployAgent`, and
  `apps/controller/src/drivers/compute/kubernetes/index.ts:KubernetesComputeDriver`.
- Assumptions: ready Namespace, supported dedicated topology, selected IAM and
  Compute Drivers, approved proxy image, and explicit infrastructure exclusions.
  Changing the Agent field requires exact Agent update and administer.

## Flow

```mermaid
graph TD
  A["<b>Agent network edit</b>"] --> B["<b>OCC approval</b><br/>Update and administer"]
  B --> C["<b>Save draft</b><br/>Agent selection"]
  C --> D["<b>Deploy</b><br/>Read Configuration"]
  D --> E["<b>Channel Driver</b><br/>Required destinations"]
  E --> F["<b>Compute admission</b><br/>Installation ceiling"]
  F --> G["<b>Admitted revision</b><br/>Selection and exclusions"]
  G --> H["<b>Prepare proxy</b><br/>Exact revision resources"]
  H --> I{"Proxy ready?"}
  I -->|No| J["<b>Gateway waits</b><br/>No fallback route"]
  I -->|Yes| K["<b>Start Gateway</b><br/>Managed proxy route"]
  K --> L["<b>CONNECT request</b><br/>Vet host and DNS answers"]
  L --> M{"Public IPv4 allowed?"}
  M -->|No| N["<b>Deny connection</b>"]
  M -->|Yes| O["<b>Pin address</b><br/>End-to-end TLS tunnel"]
  K --> P["<b>Maintenance</b><br/>Recheck ceiling"]
  P --> Q{"Ceiling tightened?"}
  Q -->|Yes| R["<b>Replace or withdraw</b><br/>Await old proxy Pods"]
  Q -->|No| K
  K --> S["<b>Stop Agent</b><br/>Drain, then remove proxy"]
  K --> T["<b>Terminal refusal</b><br/>Active maintenance"]
  T --> U["<b>Persist withdrawal</b><br/>Before removal effects"]
  U --> V["<b>Remove exact proxy</b><br/>Retry, then publish refusal"]
  classDef state fill:#e9eff5,stroke:#657a91,color:#24384b,stroke-width:1px;
  classDef operation fill:#e6efed,stroke:#668780,color:#243b37,stroke-width:1px;
  classDef gate fill:#f4eddf,stroke:#a18c62,color:#4e422b,stroke-width:1px;
  class A,B,C,D,E,F,G,U state;
  class H,K,L,O,P,R,S,V operation;
  class I,J,M,N,Q,T gate;
```

## Execution Trace

### 1. Save additional authority on the Agent

`packages/occ/src/index.ts:OpenClawController.updateAgent` validates the tagged
selection, checks exact update plus administer, and locks the Agent. The selected
Compute Driver validates newly submitted additional access or a topology change.
Ordinary updates retain saved authority even after an Installation tightening;
deployment rechecks it. State persists the selection beside other Agent settings.

`packages/occ/src/state/postgres-state.ts:updateConfiguration` writes
`gateway_outbound`; `migrations/0054_gateway_outbound.sql` constrains its shape,
DNS names, and dedicated-only extra authority. The memory adapter mirrors those
invariants. The normal mutation audit names the actor and exact Agent.

### 2. Freeze requirements at deployment

`packages/occ/src/index.ts:OpenClawController.deployAgent` reads the admitted Configuration and asks the
selected Channel Driver for `gatewayNetworkRequirements`. The Slack Driver
supplies requirements only for enabled supported accounts. Caller-authored
native settings cannot supply this trusted declaration.

For provisioning, `apps/controller/src/worker.ts:ControllerWorker.start` injects
only the pure declaration from
`apps/controller/src/composition/channel.ts:createBundledChannelNetworkRequirements`.
The worker freezes these requirements during transactional revision admission;
it receives no provider validation or directory methods. API credential validation
still runs before enqueueing provisioning, outside the write transaction.

`KubernetesComputeDriver.admitGatewayOutbound` enforces the Installation ceiling
and produces the snapshot. OCC validates it and `freezeAgentRevision` copies
selection, requirements and exclusions into the immutable revision. Missing
support refuses extra authority. A default selection with no channel requirements
needs no proxy. A snapshot requires Compute’s removal-only
`withdrawGatewayOutbound` hook. Persisted admission keeps the same snapshot across retries.

### 3. Prepare an isolated route before starting the Gateway

`apps/controller/src/drivers/compute/kubernetes/index.ts:KubernetesComputeDriver.enforceGatewayOutboundCeiling` withdraws an old route
when current configuration refuses its admitted authority.
`reconcileGatewayOutbound` creates the exact revision's immutable policy ConfigMap,
ServiceAccount, Deployment, Service, proxy egress policy and Gateway peer policy.
All resource names and ownership selectors include Agent and revision identity.

`apps/controller/src/gateway/proxy-configuration.mjs:readProxyConfiguration` checks
and reads the same opened regular file with a 1 MiB bound. Both proxy entrypoints
use it; Kubernetes ConfigMap projection symlinks remain supported.

The proxy Pod uses its separate network profile, has no Secret or API token, and
receives public IPv4 TCP/443 plus DNS under exclusions. Its ingress admits only
its owning Gateway revision. The Gateway receives no new direct public grant.
Compute checks proxy readiness before preparing the Gateway with HTTP(S) proxy,
Node proxy opt-in and exact internal bypass hosts. Harness environment and
networking retain their existing contract. Older Node versions fail managed
Gateway startup before plugin execution.

### 4. Admit each tunnel without moving credentials

`apps/controller/src/gateway/outbound-proxy.mjs:createOutboundProxyServer`
handles CONNECT/443. It validates authority syntax and destination policy,
resolves through the OS resolver once, rejects any prohibited answer, then
connects to a vetted literal IPv4 address. Subsequent TLS remains between the
native client and destination. The proxy holds neither provider nor model
credentials. Health and bounded denial diagnostics contain no request secrets.

`apps/controller/src/gateway/control-plane-outbound-proxy.mjs` loads a separate
restricted policy from trusted Driver composition. The Helm instance admits
only OCC API clients; Agent selections never broaden it. See the
[channel directory flow](agent-channel-directory.md) for management requests.

### 5. Persist withdrawal before terminal maintenance

`apps/controller/src/worker.ts:ControllerWorker.finalizeRevision` defers a terminal
active-version result as `GATEWAY_OUTBOUND_WITHDRAWAL_PENDING` before any removal.
Work-bound audit evidence preserves the refusal, bounded failure details and any
required runtime retirement. The next pass finishes only
`KubernetesComputeDriver.withdrawGatewayOutbound`, validating ownership and waiting
for exact proxy Pods and tunnels to terminate. Restored permissions cannot repair
the old route during this wait; a new authorized revision restores service.
Queue retries and stale-lease recovery preserve the pending withdrawal.

### 6. Reconcile tightening and tear down after drain

`apps/controller/src/drivers/compute/kubernetes/index.ts:KubernetesComputeDriver.reconcileGatewayOutbound` combines current exclusions
with admitted exclusions. A changed immutable policy stops old proxy Pods before
recreation. Disabled outbound or withdrawn public approval removes the route and
returns a typed refusal. Maintenance scheduling is owned by the existing worker;
its interval does not bound queue and shutdown time.

`removeGatewayOutbound` deletes only resources matching exact revision ownership
and waits on Namespace, Agent, revision and workload-role Pod labels. Stop retains the proxy while the Gateway drains;
retirement and deletion remove it afterward. Old cleanup cannot match a successor.
Existing tunnels end with the proxy process rather than surviving a policy change.

## Debugging and Verification

Read the selected revision's network snapshot and deployment result before
inspecting its exact owned proxy resources. A draft save does not mean its route
is active. Preparation must show a ready proxy and Gateway.

The [testing page](../testing/gateway-outbound.md) separates API, database,
real proxy, Kubernetes and simulated UI proof. No single result establishes
compatibility with every native plugin transport or provider.

## Related docs

- [Gateway outbound reference](../reference/gateway-outbound.md)
- [Harness topology](harness-execution-topology.md)
- [Configuration persistence and revisions](configuration-driver/persistence-and-revisions.md)
- [Controller worker](controller-worker.md)

## Manual Notes

## Changelog

- 2026-10-15 10:01: Preserve Channel Driver requirements during worker provisioning admission. (authoring-run/903d04fd-a3a7-4825-aca7-f94d828ab2d8 - 313a70262e432192306a2db431bf0b6f0459a957)

- 2026-10-14 17:45: Add durable terminal-maintenance withdrawal (authoring-run/068ea9ef-c548-4e2e-86e6-a75b33ec5ae3 - 27562ebf56a8315a663583731a303ca362cbfc5d)
- 2026-10-14 16:16: Document accompanying Gateway outbound implementation (authoring-run/068ea9ef-c548-4e2e-86e6-a75b33ec5ae3 - bd8fe1f7b0b798dca84d6f90b7377ddda79d88a6)
