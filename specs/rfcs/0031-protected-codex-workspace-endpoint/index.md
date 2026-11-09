---
status: Proposed
implementation_status: Not implemented
author: freeqaz-openai
---

# Proposal: Verify protected Codex workspace endpoints

- **ID:** RFC-0031
- **Created:** 2026-11-09

## Problem and decision

An operator deploying a protected dedicated Codex Agent needs the Agent Gateway
to use the workspace that the selected Sandbox provisioned for that revision.
The [current Sandbox transport contract](../../../docs/reference/drivers/sandbox.md#harness-transport)
supplies an endpoint and a startup check. Neither pins the endpoint to one
original workspace process through protected startup. A replacement could
otherwise look like the same destination.

Let the selected Sandbox verify the original workspace and let Compute prepare
the Gateway from that binding. Require proof that the same original acknowledged
its signed release, then verify the serving peer before the Gateway accepts
workspace traffic.

## Scope

The operator opts in by selecting a trusted Sandbox registration that supports
this contract for a protected dedicated Codex revision. The operator deploys
through the existing Agent revision path. The new revision stays pending until
the workspace can serve; preparing it does not switch traffic away from a
serving predecessor. Ordinary revisions and the bundled OpenShell path keep
their current behavior. Storage placement, credential delivery, and permissions
for repository access or tool calls stay with their existing owners.

## Contract

### Prepare the exact workspace

After the Sandbox provisions the workspace, Compute asks that same registration
for a read-only binding scoped to the admitted revision and execution. The
proposal adds an optional `protectedWorkspaceEndpoint` read to the Sandbox
Driver, separate from release and status. It does not reconstruct the launch
request or take a transport token. The Sandbox uses its retained provisioning record and authenticated observation to
verify the Installation, Agent, revision, execution, and exact workspace.
It checks that the original was admitted for this purpose and that the endpoint
still leads to it. A Pod name, a selected
profile, or a header from the workload cannot establish ownership.

The binding contains a canonical secure WebSocket origin, the provider's public
certificate authority (CA) bundle, the exact remote workspace root, and a
generation fingerprint for the original workspace process. For example, a
reserved binding for one revision lets Compute configure that revision's
Gateway with those four values before the remote workspace can answer. Compute
pins them in immutable, read-only configuration for that Gateway. No transport
token, model key, repository credential, or tool traffic goes into the binding
or its diagnostics. Only the matching Gateway receives the binding; existing
per-turn Sandbox checks still apply.

### Serve only after release

Compute rechecks the binding and requires the Sandbox to observe the same
original's acknowledgement of its signed release. The acknowledgement must
match both the pinned generation and the admitted startup. The binding does not
change between reservation and acknowledgement. Compute still requires the
independent authenticated serving check before making the new revision available.

On each connection the serving endpoint checks the existing transport
authorization and that the released original is still current. The Gateway
validates TLS against the pinned provider CA and checks the generation proof
from the authenticated serving endpoint during the WebSocket upgrade. It
accepts no workspace messages until both checks pass. A missing, duplicate, or
different generation proof closes the connection.

A reserved original, or an observation that is temporarily unavailable, leaves
the new revision pending during bounded reconciliation. An invalid, changed, or
retired original refuses activation. A bound revision never falls back to the
ordinary endpoint or adopts a replacement process. If the original cannot be
verified again, the operator retires the affected revision and deploys a new
one through normal admission.

[View the proposed lifecycle](request-lifecycle.svg) or
[edit its Mermaid source](request-lifecycle.mmd).

## Delivery and verification

Submit this Driver contract for human review before implementation. Then connect
the selected Sandbox producer, Compute preparation and activation, and Gateway
verification. Exercise the real call sites with one protected revision:
preparation without serving, acknowledgement without changing the binding, and
an authenticated connection to the same original. Try a held release, an
unavailable or replaced owner, changed or missing pinned values, and a forged
generation proof. Check that no workspace traffic flows for a refused
connection and that ordinary and OpenShell revisions retain their current path.
The proposal does not establish installed behavior.

## Rationale

Using the current endpoint and status alone would leave the original generation
unbound. Waiting for a serving connection before preparing the Gateway would
tie preparation to a release that has not happened yet. The separate reservation
and serving checks let Compute prepare the revision without trusting an
unreleased or substituted workspace.

See [Gateway–Harness storage split](../0003-gateway-harness-storage-split.md) for
workspace placement and [Sandbox Driver selection](../../../docs/reference/drivers/selection.md)
for how an Installation selects its Drivers.
