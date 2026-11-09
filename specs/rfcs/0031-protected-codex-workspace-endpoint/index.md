---
status: Proposed
implementation_status: Not implemented
author: freeqaz-openai
---

# Proposal: Verify protected Codex workspace endpoints

- **ID:** RFC-0031
- **Created:** 2026-11-09

## Problem and decision

Suppose Compute releases workspace A for an Agent revision. A exits, and its
Kubernetes Service now routes the same URL to workspace B. B can answer a
startup check, but the release was for A.

[Today’s Sandbox contract](../../../docs/reference/drivers/sandbox.md#harness-transport)
returns an endpoint and a startup check. Both A and B can pass that check.
For a protected revision, the selected Sandbox would identify A before release.
Compute would verify that A is serving after release, and the Gateway would
verify A on each connection.

![Current and proposed behavior when a workspace is replaced at the same address](request-lifecycle.png)

[Open full-size SVG](request-lifecycle.svg) · [Edit Mermaid source](request-lifecycle.mmd)

## Scope

Operators opt in through [Sandbox Driver selection](../../../docs/reference/drivers/selection.md)
for protected dedicated Codex revisions. Ordinary revisions and bundled OpenShell
keep their existing behavior. [Storage placement](../0003-gateway-harness-storage-split.md),
credential delivery, repository access, and tool permissions are unchanged.

## Contract

### Prepare the exact workspace

After provisioning, Compute calls the selected Sandbox registration’s optional,
read-only `protectedWorkspaceEndpoint`. The Sandbox uses its retained signed
reservation and authenticated observation to verify the Installation, Agent,
revision, execution, and original workspace. A workload header or Pod name
cannot establish that identity.

Compute pins four values in immutable, read-only configuration for that
revision’s Gateway: **secure WebSocket origin, provider CA bundle, remote
workspace root, and original process generation**. The binding and diagnostics
contain no credentials or tool traffic. Preparation needs no transport token
and does not move traffic off the serving predecessor.

### Serve only after release

1. **Compute checks release and readiness.** The same Sandbox must observe A’s
   acknowledgement of its signed release for the admitted startup and pinned
   generation. Compute reads the binding again and compares all four pins
   without replacing them. It then calls the same Driver’s bearer-authenticated
   `harnessStatus` with the retained revision requirements. Only `serving`
   permits activation.
2. **The Gateway checks every connection.** It authenticates the pinned origin
   using only the pinned CA before sending the HTTP Upgrade or bearer. The
   relay verifies the bearer and that A is still current, then returns HTTP 101
   with exactly one generation proof header. If the proof is missing, duplicated,
   or different, the Gateway closes without sending or accepting a native frame.
   The provider must keep the TLS identity for this origin exclusive to the
   admitted Host: the bearer is already sent by the time the proof arrives.
   Existing per-turn Sandbox checks still apply.

## Rationale

Separating preparation from activation lets Compute configure the Gateway while
A is held. A temporary observation failure leaves the revision pending during
bounded reconciliation. If B replaces A, no fallback or adoption is allowed:
retire the affected revision and admit a new one.

## Delivery and verification

To verify the proposal, test the Sandbox, Compute, and Gateway call sites
together: a held A, a released and serving A, and B at A’s address. Change a
pin, fail status after acknowledgement, and reject invalid TLS or generation
proof at the relevant connection step. Verify ordinary and OpenShell paths stay
unchanged.
