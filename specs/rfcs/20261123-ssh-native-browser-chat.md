# Native browser chat on SSH Compute

Status: proposed. No browser access is provided by this document.

## Decision

Use OCC's existing browser session, authorization and proxy. Support chat for exact-Agent operate and administration for exact-Agent
administer, without granting host administration. Return unsupported for a
missing route, mismatched revision, or a
gateway that cannot enforce the delegated session scope. Do not grant students
an SSH account, a gateway password or a direct gateway URL.

## Implementation boundary

Implement the existing getGatewayBrowserRequest contract, not a new public
API. Resolve the Installation, Namespace, Agent and active served revision
from controller-owned data. Bind the principal and mode-specific authority on the
server side. Do not accept destination URLs or identity headers from clients.

SSH gateways listen on the compute host's loopback, not the controller's.
A reachable authenticated private transport from OCC to that exact listener
is a prerequisite. A bare WSS URL, SSH probe success, or loopback password is
not such a transport. Require revision-bound backend authentication, not
trust in all local callers. Stop serving stale routes on stop, retirement,
or port reuse; keep host-key verification. No changes to other agents.

Do not transplant only the legacy getGatewayChatEndpoint method into the
deployment backport: first qualify the session identity and scope ceiling on
the installed OCC and gateway pair. Otherwise leave availability unsupported.

## Acceptance

1. With no opt-in, deployment and loopback readiness remain unchanged.
2. An administrator can operate both assigned Agents in admin mode; a
   principal with operate receives only chat mode.
3. A student can submit a chat turn on their own tutor but cannot open the
   designer or another student's tutor, including by following a copied URL.
4. Neither a browser header nor an existing local profile can widen chat
   to administration. Revoking operate closes access including WebSocket renewal.
5. After redeployment or port reuse, an old session cannot reach a different
   revision or agent. Rollback restores private-only operation.
