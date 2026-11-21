---
status: Proposed
implementation_status: Not implemented
author: kevinlin-openai
---

# Proposal: Configure an upstream proxy for Agent Gateway channels

- **ID:** RFC-20261119-agent-network-proxy
- **Created:** 2026-11-19
- **Last updated:** 2026-11-20
- **Related:** [Managed channel egress](20261118-channel-egress.md)

## Summary

Add an optional **Network proxy URL** setting to each Agent in the Console and
API, explicitly labeled as applying to Gateway channel traffic only. Save its
selection in each Agent revision. On the next deployment, Kubernetes Compute
configures the Gateway's existing Envoy listener to forward permitted channel
connections through the selected upstream proxy.

Without a selection, preserve Gateway → Envoy → channel provider. With a
selection, use Gateway → Envoy → upstream proxy → channel provider. Enabled
channels still require managed Envoy in both cases. Support private proxy
endpoints and HTTP/HTTPS proxy URLs.

Harness proxying, model and tool traffic, OpenShell configuration, and transparent
Kubernetes traffic capture are out of scope. OCC's own requests, including Slack
credential validation and directory lookup, keep their existing route.

## Motivation

[Current channel egress](../../docs/reference/drivers/kubernetes-compute/channel-egress.md)
assigns an Envoy listener to a dedicated Gateway and sets its `HTTPS_PROXY`.
Users need that channel route to work through a customer upstream proxy.
Extending the existing listener preserves channel destination enforcement and
avoids changes to the separate Harness networking path.

The shipped [OpenClaw source pin](../../deploy/runtime/openclaw-source.json)
is `82b682c627ba8bfc2c2bd51cf46ad8f51c583857`. Its
[Node proxy adapter](https://github.com/openclaw/openclaw/blob/82b682c627ba8bfc2c2bd51cf46ad8f51c583857/src/infra/net/node-proxy-agent.ts)
accepts HTTP/HTTPS proxies and rejects SOCKS/PAC URLs. Use that proxy URL support
as the compatibility target for this Gateway feature, including authentication
and HTTPS/WebSocket channel connections. Keep the existing CONNECT-only listener;
this proposal does not add ordinary HTTP forwarding or new channel destinations.

## Goals

- Apply one Agent selection to its Gateway's permitted channel connections.
- Preserve channel destination permissions and separation between Agents.
- Reach an approved private or public proxy without opening other private
  network destinations.
- Apply edits only when a new Agent revision is deployed. Requests selected for
  the proxy fail without a direct fallback when that proxy is unavailable.

## Proposal

### Setting and lifecycle

Propose an optional `networkProxy` object on Agent create/update/read operations,
with `url` as its endpoint. Omission on update leaves the selection unchanged;
`null` clears it for future deployments. A new Agent without a selection keeps
current behavior. The Console labels the endpoint **Network proxy URL** and
explains that deployment applies changes.

Accept HTTP and HTTPS proxy URLs. Match the shipped runtime's supported URL
semantics through qualification, including authenticated endpoints. Store
authentication material through the existing Secret primitive, with only a
same-Namespace Secret reference in Agent and revision data. A credential-bearing
URL must not be echoed, audited, or saved as ordinary Agent configuration. Reuse
the existing Secret selection flow for authentication; do not introduce a proxy
credential resource. Specify the input format before implementation.

Use normal certificate and hostname verification for HTTPS proxies. Reuse
installation trust configuration for private CAs rather than adding a per-Agent
CA editor. Proxy credentials remain distinct from channel credentials.

Admission verifies exact-Agent authorization, Secret access, and Compute support
for the selected route. Deployment saves
the endpoint, references, and admitted routing intent in the revision. Workers
recheck authority and referenced material through the normal deployment path.
Unsupported Compute configurations fail admission rather than partially applying
the setting. Retry, replacement, stop, and deletion use the existing revision
lifecycle and retire only the resources owned by that revision.

### Ownership and routing

Core owns Agent state, revision snapshots, authorization, and lifecycle.
Kubernetes Compute owns Gateway provisioning and Envoy configuration. Add the
selection to that existing path; no generic routing contract is needed for
Sandbox or Credential Proxy Drivers.

Gateway `HTTPS_PROXY` continues to point to its assigned Envoy listener, never
directly to the customer's proxy. Envoy applies the same channel host/port rules
before forwarding through the selected upstream. Proxy selection grants no new
channel destinations. Agents without enabled channels receive no new listener
or egress grant from this setting.

Reuse the existing binding allocation, installed-policy checks, and drain
lifecycle. Include upstream selection in the binding's configuration identity
so changes cannot alter a serving revision's route. Capacity exhaustion still
rejects deployment. Retire old tunnels and binding-owned resources through
normal revision cleanup.

Harness and OCC routes, internal Gateway/Harness transport, and their network
grants remain unchanged. No additional listener pool or transparent capture
layer is introduced.

### Private endpoints and trust

Use installation network configuration to make the selected proxy reachable
from Envoy, limited to its addresses and ports or constrained service identity.
Private proxy reachability requires that scoped grant; never remove private,
metadata, or cluster exclusions globally. DNS changes must remain inside the
configured endpoint scope. Do not add a separate proxy approval workflow.

Envoy continues to authorize the requested final host and port. When the
customer proxy resolves the final destination, it owns the last-hop address
check: Envoy can no longer prove that the proxy selected a public destination
address. Configuring reachability to such a proxy establishes trust in its
resolution and destination enforcement. Preserve source-role restrictions and document that
trust boundary; do not describe it as equivalent to today's direct upstream-IP
verification.

Proxy authentication is scoped to that Agent's binding and sent only to its
selected proxy. Exclude credentials from Envoy inspection output, patch policies,
ConfigMaps, logs, and audit data. Secret delivery and any necessary inspection
changes require qualification before rollout. Keep provider TLS end-to-end;
TLS interception is not part of this proposal.

## Interface changes

### APIs

Extend the existing Agent create, update, read, and revision projections with
`networkProxy`. Return endpoint and safe Secret references only. Extend the
Console editor and deployment summary through those same APIs. Validate the
whole selection before saving it and return errors without credential values.

### IAM

Reuse exact Agent create/update/read/operate and Secret permissions. Require
the normal caller and Agent-principal Secret authorization at the relevant
admission and dispatch boundaries. Agent update permission does not grant the
ability to approve new installation network destinations.

### Database entities

Persist the optional selection on Agents and its deployment snapshot on Agent
revisions. Use database constraints for persisted shape invariants. Store no
proxy credential bytes in either entity. No separate proxy resource is proposed.

### Driver contracts

- Compute admits the Gateway upstream selection, rejects unsupported
  configurations, and confirms installed enforcement before Gateway startup.
- No changes to Sandbox or Credential Proxy contracts.
- Channel destination declarations retain their meaning. The route changes,
  not the destinations they authorize.

## Simplifications

Extend the existing channel route with one optional upstream selection. Reuse
its listener, binding lifecycle, Secret storage, and installation network
configuration. No new proxy resource, approval workflow, Harness integration,
listener pool, or cluster traffic-capture system is required.

Pointing Gateway `HTTPS_PROXY` directly at the customer proxy would be smaller,
but would skip managed Envoy's channel destination checks. Retain Envoy in the
path and configure chaining there. A dependency fork is not part of this proposal.

## Acceptance Criteria

Use the normal authorized Agent create/update/deploy workflow, real PostgreSQL,
an enforcing disposable Kubernetes cluster, the shipped runtimes, and controlled
HTTP/HTTPS proxies. Extend the existing real Agent QA journey; mocks are not
evidence for routing or containment.

- **AC-1 — Gateway routing:** Deploy a channel-enabled Agent with and without
  the setting. Exercise a real Gateway channel connection. Proxy and destination
  observations establish the selected route; Gateway `HTTPS_PROXY` points to
  Envoy in both cases. Unsupported Compute configurations fail admission.
- **AC-2 — Compatibility:** Exercise the shipped OpenClaw proxy URL behavior,
  authentication, streaming, and WebSockets. Verify HTTPS proxy certificate
  validation, configured private trust, and rejection of SOCKS/PAC URLs. Record
  exact runtime versions. Existing CONNECT-only listener restrictions remain.
- **AC-3 — Isolation:** With two Agents and distinct proxy selections, prove
  neither can use the other's binding. Preserve channel destination checks and
  direct channel-egress denial. A configured private proxy is reachable;
  neighboring private endpoints and metadata remain denied.
- **AC-4 — Lifecycle:** Editing or clearing the setting leaves a running revision
  unchanged. The next deployment uses its saved selection. Retry and retirement
  preserve binding ownership, terminate old tunnels, and do not release ports
  early. Proxy outage and authentication failure never trigger direct fallback
  for a request selected for proxying.
- **AC-5 — Scope:** OCC Slack credential validation and directory lookup retain
  their existing route. Harness networking and proxy configuration remain
  unchanged, and required internal Agent transport still works. Setting the
  field on an Agent without enabled channels creates no egress grant.
- **AC-6 — Secrets and UI:** Prove unauthorized Secret selection is rejected and
  credentials are absent from public reads, inspection, and logs. Capture Console
  screenshots and a deployment walkthrough, including validation and error states.

## Delivery and verification

Submit this RFC for human review before Driver implementation. A separate
implementation plan must settle the field/Secret format, installation
reachability and trust inputs, and Envoy qualification before runtime changes.
Preserve the historical channel RFC; this proposal extends its scope.

Current evidence is source inspection only. No forwarding, credential-delivery,
or lifecycle acceptance criterion has passed. Implementation must update the
owning Agent, Compute, security, and channel references and runtime
flows together. Update the architecture's egress trust claim when that behavior
is implemented, not while it remains a proposal.

## Scope decision

The requesting product owner narrowed this proposal to Gateway channel
traffic and deferred Harness proxying. OpenClaw's HTTP/HTTPS proxy URL support
remains the compatibility target for that route. Private proxy endpoints,
unchanged OCC routing, and Console/API edits applied on the next deployment
remain required. This scope decision does not mark the RFC accepted.
