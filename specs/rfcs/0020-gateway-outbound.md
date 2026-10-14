---
status: Proposed
implementation_status: Partially implemented
author: miguelbranco80
---

# Proposal: managed outbound HTTPS for dedicated Gateways

- **ID:** RFC-0020
- **Created:** 2026-10-14
- **Implementation plan:** [RFC-0020 delivery](../plans/0020-gateway-outbound.md)
- **Source baseline:** `d3ccc54781d0d50b40e9aeb814f0573d38c0a585`
- **Related:** [Agent egress for 0.x](0017-agent-egress-0x/index.md),
  [Compute](../../docs/reference/drivers/compute.md),
  [Channel Driver](../../docs/reference/drivers/channel.md)

## Problem and decision

Dedicated Gateways host trusted native OpenClaw plugins, channel clients and
administrative services. Their network fence currently admits approved internal
transports and a shared Slack proxy. Ordinary integration HTTPS, including plugin
discovery and Connections provider requests, cannot use that Slack-only route.
Native plugin manifests do not describe every destination their code may contact.

Give each dedicated Agent an approved Gateway outbound selection. Kubernetes
Compute supplies an isolated CONNECT proxy for each admitted revision requiring
external access. Enabled supported channels contribute their requirements
automatically; additional integration access is separately authorized. The
installation establishes the ceiling without enumerating future Agents.

Native plugins remain trusted in-process Gateway code. Harness placement,
networking, model credentials and Sandbox contracts retain their existing owners.
This extends the existing channel transport rather than implementing credential
injection or a universal remote plugin host.

## Configuration and authority

The OCE Agent field `gatewayOutbound` selects `channelsOnly` (default),
`restricted` with exact DNS `hosts`, or `publicHttps`. The field is outside native
Configuration values. Enabling a supported channel adds its destinations to the
effective policy, without changing the manually selected hosts. Disabling it
removes only its contribution on the next deployment.

Kubernetes Compute installation configuration owns
`runtime.gatewayOutbound.enabled`, `allowPublicHttps`, the approved proxy image
and resources, and additional forbidden infrastructure CIDRs. Public HTTPS is
disabled by default. Installation limits and mandatory address exclusions always
win. A required channel destination conflicting with a limit fails admission.
No private-network exception is included in this first delivery.

Agents are created with `channelsOnly`. Changing the Agent selection requires
both exact Agent `update` and `administer`; this adds a documented operation to
the existing `administer` action. Configuration editors and plugin installation
cannot widen it. Deploy still requires `deploy` and current protected-reference
checks. Mutations and authorization denials retain existing attributable audit
evidence. Worker dispatch rechecks admitted authority before infrastructure work.

Compute declares its capability and validates selections through a platform
contract. OCC must not hardcode Kubernetes settings or Slack destinations.
Trusted Channel Drivers declare bounded management and Gateway network
requirements. Admission snapshots the selected access and those requirements in
the immutable revision; Compute enforces the installation ceiling again.

## Runtime and enforcement

Each revision owns a nonsecret proxy policy, Deployment, ClusterIP Service and
NetworkPolicies. Only that revision's owning Gateway may connect to the proxy.
Different Agents never pool permissions. The proxy has no provider credentials,
Kubernetes API token, shared workspace or persistent state. Reserved labels and
NetworkPolicies remain under trusted platform control; namespace administrators
retain their existing infrastructure trust.

The Gateway receives one proxy route for channels and ordinary integration
HTTPS. Internal exclusions are derived from exact approved runtime endpoints;
caller-supplied proxy variables or broad bypasses cannot replace that route.
There is no direct public Gateway TCP/443 grant. Clients ignoring the proxy fail
at the network fence. Compatibility must be established with the actual native
clients, including global fetch and channel WebSockets.

The CONNECT proxy accepts port 443, validates hostname policy, resolves through
trusted DNS, rejects forbidden answers and pins the vetted address for connection.
It rejects loopback, private, link-local, metadata, multicast, reserved and actual
cluster/control-plane addresses. Mixed allowed/forbidden DNS answers fail closed.
Unsupported address families fail closed; IPv4-mapped forms receive equivalent
checks. Redirects to a different destination undergo another CONNECT admission.

TLS remains end-to-end with normal native certificate and hostname verification.
CONNECT cannot inspect encrypted HTTP paths, methods or bodies. `publicHttps`
grants the whole trusted Gateway public TCP/443 authority; it cannot establish
per-plugin isolation or prevent disclosure to an allowed destination. Existing
provider credentials and plugin action authorization remain necessary.

## Control-plane requests and Slack replacement

The OCC API validates credentials and queries directories before an Agent Gateway
exists. It uses a separately restricted control-plane instance of the same proxy
implementation. Its requirements come from trusted selected Driver management
operations, never the union of Agent permissions. Driver clients receive the
transport explicitly; database, Kubernetes and internal requests retain their
own transports.

Replace the Slack-specific proxy process, Helm component and configuration with
this generic facility once validation, directory lookup, Gateway HTTPS/Socket
Mode and cleanup are preserved. Slack endpoints remain in the Slack integration
owner. Future Teams support can contribute its requirements through the same
contract, but its credentials, inbound callback, native configuration and runtime
qualification are separate delivery work.

## Lifecycle and user experience

Each admitted revision retains the Installation exclusion CIDRs. Runtime policy
combines those exclusions with current exclusions, so loosening cannot broaden an
old revision. Compute maintenance reconciles running proxies after a ceiling
tightens and waits for old proxy Pods to stop, closing established tunnels before
reporting the new policy applied. The maintenance interval is not a total
revocation deadline; queue and shutdown delay also count. Test tightening with an
already established tunnel and prove a successor remains intact.

Saving changes updates desired state. Deployment prepares the revision proxy
before starting the Gateway with its exact route. Failed preparation grants no
fallback. During stop, retain the proxy while the Gateway drains, then remove it
after Gateway termination. Retirement deletes only exact revision resources;
stale cleanup must not remove a successor. Agent deletion removes all its proxy
resources.

Installation tightening withdraws forbidden access before it is reported applied;
loosening cannot broaden existing revisions. The immutable admitted selection
remains evidence of the requested authority even if enforcement revokes it.

The Console presents channel-required access, the additional selection, requested
versus deployed state, and bounded readiness/denial evidence. It does not expose
proxy URLs or Kubernetes object settings. Non-administrators can inspect but
cannot change additional access. Diagnostics exclude credentials, HTTP bodies
and unbounded provider output.

## Alternatives and limits

An operator-supplied proxy is smaller to integrate but leaves policy and Agent
isolation outside OCE lifecycle. A shared authenticated proxy could isolate
policies, but requires a new policy identity/authentication contract. Separate
revision proxies reuse existing NetworkPolicy ownership and simplify cleanup.

A separate trusted plugin host would require plugin adaptation and another
credential/lifecycle boundary. It does not preserve arbitrary existing native
plugins automatically. Keep that outside this networking change.

Embedded execution is excluded: its current direct model HTTPS means attaching
a proxy would not establish mandatory mediation. This proposal does not qualify
dedicated native OpenClaw, non-Codex models, plugin installation/persistence or
Teams delivery. RFC-0017 prefers native Sandbox and credential mechanisms; this
bounded trusted-Gateway transport must be reviewed alongside that direction and
does not claim to implement the broader proposed egress/credential RFC.

## Required proof

Exercise ordinary API admission, persistence, revision preparation and native
Gateway requests. Prove restricted and public requests, automatic Slack plus
extra access, direct-socket and forbidden-address denials, cross-Agent proxy
isolation, unchanged Harness credentials/networking, replacement and deletion.
Test DNS answer classification and pinned connections through the real proxy.
Establish real control-plane validation/directory routing independently of a
Gateway. UI evidence includes rebuilt Storybook screenshots and a walkthrough;
provider-backed Slack proof requires authorized credentials. Record missing
provider or production prerequisites without substituting synthetic proof.
