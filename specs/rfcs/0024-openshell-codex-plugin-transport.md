---
status: Proposed
implementation_status: Not implemented
author: kevinlin-openai
---

# Proposal: Prepare Codex plugins before accepting native requests

## Decision and observed problem

Keep OpenShell's existing bearer-passthrough WebSocket and verifier-only
provisioning. Add a trusted Harness startup gate that prepares and checks every
selected plugin on the final native process before forwarding client requests.
Require a real native initialization result for provider readiness. Do not add
credential registration or a separate control API.

On the existing development profile, a dedicated Codex Agent completed a real
model turn. Selecting the existing Codex Plugin Driver allowed managed GitHub
and Linear selections to save and deployment to queue. The worker then failed
with `SANDBOX_HARNESS_UNSUPPORTED`. This was reproduced with product source
`c4d98ab574f2`, OpenClaw `762a2fe60cc3`, Codex `0.163.0-alpha.2`, and OpenShell
`0.1.5`. The first profile also needed the Plugin Driver selected explicitly.

The [OpenShell admission check](../../apps/controller/src/drivers/sandbox/openshell.ts)
rejects nonempty selections. The existing
[runtime launcher](../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts)
needs a raw base token for local plugin preparation and ordinary Compute's
per-start authentication. OpenShell provisions only its verifier. Removing the
rejection alone does not connect these paths.

An empty managed selection map is not a workaround: the production renderer
turns native app/plugin features off. A real native catalog read with that
configuration returned no marketplaces. Upstream native bridge configuration
does not establish equivalent OCE managed selection and readiness guarantees.

The initial proposal used stdio preparation and verifier registration. Source
review and the live reproduction support the smaller gate described here.
[RFC-0016](0016-sandbox-credential-injection/index.md) excluded this transport
work. [RFC-0014](0014-plugin-policy-enforcement.md) continues to own plugin policy.

## Scope

The supported caller is the normal managed Agent deployment and conversation
workflow. The first proof is one Slack request whose Codex Agent reads an
authorized GitHub repository file and Linear issue or project, then replies in
the original thread with verifiable facts.

Keep account grants, app approval rules, source-scoped credential injection,
TLS verification, Landlock, and network restrictions. Every selected plugin must
succeed on this provider path. Ordinary Compute retains its existing best-effort
handling, private status, and per-start HMAC authentication.

Protected Git, new platform resources, account-policy expansion, production
qualification, and EKS deployment are outside this change. Successful development
proof does not qualify the shared OpenShell management/service listener.

## Owners and interfaces

The Sandbox Driver declares that its Harness prepares selected plugins before
native initialization. Compute consumes this capability instead of applying the
ordinary peer-status/HMAC protocol to that provider. Missing capability continues
to refuse selected plugins; do not silently infer support from an endpoint.

The existing trusted Harness launcher owns one native child and its startup gate.
The Sandbox Driver owns exposure, public CA trust, adoption, and cleanup. Compute
owns candidate preparation and activation; Gateway configuration contains the
full immutable selection map because partial provider startup is forbidden.
OCC gains no provider-specific branch.

The native child listens on one fixed loopback endpoint, distinct from the
exposed gate, with its existing SHA-256 bearer verifier. Failure to start that
child is fatal; never discover and adopt an unrelated listener. Loopback access
still requires native authentication.

## Startup and credential lifetime

1. The launcher authenticates the model as today, starts the final native child,
   and opens the existing provider endpoint through the gate. Its state is
   unprepared. An absent or incorrect bearer fails before any installation or
   local native connection.
2. The first correctly authenticated WebSocket owns preparation. Accept its
   WebSocket upgrade within the pinned client's ten-second handshake budget,
   but forward no application frame. Buffer at most four messages and 64 KiB
   until preparation finishes; reject overflow. Admit at most sixteen clients.
3. Use the owning connection's credential only for existing local native RPCs.
   Run the production installation, app/tool ownership, configuration, and
   reviewer checks against this same final child. Every selected plugin must
   pass. Preserve a preparation deadline of at most sixty seconds and bound
   individual RPCs within it.
4. After successful preparation, forward each client's original initialization
   request and relay the real native response. Do not synthesize initialization
   success or leak bootstrap responses, notifications, or approvals to clients.
   Forwarding remains restricted to the fixed native child, with backpressure,
   message limits, and socket cleanup.
5. Compute requires successful native initialization before reporting serving.
   A WebSocket `101` alone now means authenticated connection acceptance on this
   capability, not readiness. Keep handshake-only protected-Git checks outside
   this supported combination.

The bearer already crosses the existing passthrough route during native
WebSocket authentication. This change lets the trusted launcher use that
in-flight credential for preparation. It does not provision a bearer through
provider files, process environments, or disk. Parameterize the local RPC client;
never temporarily put the credential into environment variables. Do not log
headers, bodies, native auth files, or credential-bearing exceptions. Release
credential references after preparation settles; this is not a secure-erasure
claim for JavaScript memory.

Exactly one connection owns preparation for a native-process generation. Other
authenticated clients wait within the fixed limits; they cannot replace the
owner or run concurrent installers. If the owner disconnects before preparation
commits, stop preparation, close waiting clients, and terminate and reap that
native generation. Closing its administrative socket alone is insufficient:
an interrupted installation could otherwise finish a late write. Restart must
restore managed configuration and revalidate any retained package state.

## Readiness, failure, and recovery

Give the control-plane native initialization check a deadline that includes the
preparation budget. The pinned Gateway already distinguishes WebSocket upgrade
from native initialization; its startup budget can still be shortened by the
caller's remaining turn budget. A timeout cancels that attempt rather than
bypassing preparation or becoming a plugin-policy denial.

Remove the ordinary private plugin-status wait only when the provider declares
this capability. Compute must be able to initiate candidate preparation before
Gateway readiness depends on it. Keep candidate cutover in its existing owner;
do not redirect a serving predecessor merely to obtain a bootstrap credential.

On preparation failure, the gate serves the existing authenticated runtime
failure document and refuses application traffic. Do not start a second
held-failure listener on the same port. GitHub authentication required, for
example, remains fatal even when Linear is ready.

Bind preparation success to the actual native child. Its exit synchronously
closes forwarded sockets and clears readiness. A restart repeats all preparation
before forwarding a stale Gateway's request. This provider guarantee is
**no request reaches an unprepared replacement**. Ordinary Compute keeps its
separate guarantee that an earlier startup credential cannot reconnect.
Deletion retains the existing Sandbox-before-provider cleanup ordering.

## Verification and delivery

[PR #3985](https://github.com/openclaw/openclaw-enterprise/pull/3985) was submitted
before product implementation. The
[implementation plan](../plans/0024-openshell-codex-plugin-transport.md) tracks
code, current documentation, and required proof. This RFC remains Proposed and
unimplemented until delivery evidence is recorded.

Extend the real Agent QA workflow and verify:

- Wrong/missing authentication causes no preparation; direct loopback access
  without the bearer fails.
- A fast WebSocket upgrade does not establish readiness. Delayed native
  initialization succeeds only after actual plugin/policy checks.
- Failed or partly successful installation never serves. Concurrent probes
  have one owner, and an owner's disconnect cannot leave late writes or a
  surviving native generation.
- Native exit during verification invalidates readiness. An immediate Slack
  reconnect after restart cannot execute before replacement preparation.
- Candidate preparation and Gateway-only restart preserve existing lifecycle
  ownership and the final-process verification boundary.
- The actual pinned OpenShell and native clients complete the same-Agent
  Slack/GitHub/Linear chain. Record source/image identities, resource and
  turn/tool identities, sanitized results, and the Slack permalink.

Native installation metadata is not an app read. Catalog availability is not an
app connection. Missing credentials remain a proof gap, not permission to
replace the dependency with a fake or broaden access.
