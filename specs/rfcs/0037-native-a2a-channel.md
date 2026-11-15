---
status: Proposed
implementation_status: Not implemented
author: sunnymodi21
---

# Proposal: A2A channels for dedicated Agents

- **ID:** RFC-0037
- **Created:** 2026-11-11
- **Implementation plan:** [Delivery and qualification](../plans/0037-native-a2a-channel.md)

## Summary

Allow an operator to connect a dedicated OpenClaw Enterprise (OCE) Agent to an
external agent through the bundled OpenClaw Agent2Agent (A2A) channel plugin.
Extend the Kubernetes Compute Driver's channel configuration contract and its
routing integration. Reuse existing Configuration, Secret, Agent revision, and
deployment primitives. Submit this contract for maintainer review before
implementation; this RFC does not enable A2A in a released installation.

## Motivation and current behavior

The [OpenClaw A2A plugin](https://docs.openclaw.ai/channels/a2a) supports Agent Card
discovery, authenticated incoming text tasks, task polling, and outgoing messages
to configured peers. A runtime capability does not establish OCE support.

At upstream commit `9ff173b40`, Kubernetes Compute's
[`CHANNEL_REQUIREMENTS`](../../apps/controller/src/drivers/compute/kubernetes/index.ts)
admits `slack` and `msteams`.
[`enabledChannelProviders`](../../apps/controller/src/drivers/compute/kubernetes/configuration-rules.ts)
rejects other enabled providers. A configuration with `channels.a2a.enabled: true`
therefore cannot use the normal Agent workflow. Removing that rejection alone
would leave credentials, inbound routing, network isolation, and lifecycle
behavior unspecified.

The [ChannelDriver](../../docs/reference/drivers/channel.md) currently owns
credential validation and directory lookup, not task delivery. The native Gateway
must continue to own A2A protocol processing; this proposal does not turn the
directory Driver into an agent invocation service.

Related discussions are [workflow orchestration, issue #2302](https://github.com/openclaw/openclaw-enterprise/issues/2302)
and [native Telegram, PR #5289](https://github.com/openclaw/openclaw-enterprise/pull/5289).
Neither supplies an A2A deployment contract. The issue and PR searches on
2026-11-11 found no A2A-specific proposal in this repository.

## Goals and scope

- Deploy A2A through the supported Configuration, Secret binding, Agent creation,
  revision, and deployment workflow, with errors before a serving Agent stops.
- Support a peer sending a text task and polling its result, and an Agent sending
  a task to an explicitly configured peer and receiving its submission receipt.
- Keep channel credentials in the dedicated Gateway and model credentials in the
  dedicated Harness, consistent with existing channel isolation.
- Preserve exact-Agent ownership, revision routing, default-deny networking, and
  operator control over discovery and exposed agents.

This proposal excludes embedded execution, a new workflow engine, automatic peer
discovery, delegated human identity, cross-Namespace grants, and an OCE-wide agent
directory. It does not implement the planned general external-admission system
in the [platform design](../../docs/design.md#remaining-design-work).

## Proposed contract

### Configuration and credentials

Kubernetes Compute admits `channels.a2a` only for a dedicated Agent on an
installation that supports the required channel runtime and selected routing
capability. Other enabled channel providers retain their current validation.

Use the native plugin's `peers`, `advertisedUrl`, and `exposeAgents` settings.
Each peer has a separate incoming bearer token. An outgoing peer also has an
explicit HTTPS endpoint and, when required, a distinct outgoing bearer token.
Require same-Namespace Secret bindings for token inputs; reject literal token
values and unresolved references at save and deployment admission. Reuse the
existing authorized Secret read and Gateway projection path. Do not add peer
tokens to model requests, Harness Pods, configuration responses, logs, or audit
payloads. Neither a peer token nor a protocol message role grants OCC API access.

Require an explicit nonempty `exposeAgents` allowlist. Initially permit only the
native agent belonging to the owning OCE Agent; reject other agent IDs. Do not
inherit the native plugin's expose-all default. Outbound-only configurations do
not create a discovery or task ingress route. They must still define the native
plugin's required peer authentication inputs.

`exposeAgents` alone does not constrain dispatch. At pinned OpenClaw
`513c12703`, the plugin uses it only to build the Agent Card; inbound dispatch
resolves the peer or context binding independently and runs the selected agent.
With an enabled A2A channel, every A2A task must therefore resolve to the owning
`main` entry: the native agent roster is omitted or contains only `main`, and no
binding that matches the A2A channel selects another entry. Admission refuses
any other roster or binding. Relaxing this rule requires the native runtime to
enforce the allowlist at dispatch, qualified by the same denial case.

### Inbound routing

An operator must explicitly enable inbound exposure. The selected Compute and
routing implementations publish the plugin's Agent Card and task endpoint for
the owning Agent's serving revision over HTTPS. Route only the documented A2A
paths: `/.well-known/agent-card.json`, its compatibility discovery path if
supported by the selected runtime, and `/a2a/v1`. Do not expose workspace,
Control UI, administrative, or unrelated Gateway paths through that route.

The advertised origin must match the installed route. Refuse a missing routing
capability or an unrepresentable route during preflight. The route must preserve
the peer Authorization header for native plugin validation and must not convert
it into a trusted-proxy human identity. Agent Cards are public on the enabled
route; require operator opt-in to that disclosure. Private deployments also
restrict network access to their selected peers.

The Gateway checks the configured peer token, maps the request to its allowed
native agent, and owns task state, polling, and peer/context session isolation.
OCE does not reinterpret the task as an authenticated human operation. Existing
native tool permissions and operator approval requirements remain in force.

### Outbound networking and lifecycle

The selected Driver owns peer destination validation and the channel egress
policy. Permit only admitted peer endpoints through an implementation that can
enforce their destination and port. Reuse the reviewed channel proxy where it
can enforce this contract; do not inherit the Slack/Teams destination list or
open general HTTPS egress. Deny private/control-plane destinations unless an
operator explicitly admits a specific private peer through supported network
policy. An implementation that cannot enforce the selected destination refuses
the configuration rather than weakening default-deny policy.

The runtime transport must match the selected enforcement path. Compute projects
`HTTPS_PROXY` into the Gateway, and the channel NetworkPolicy grants egress to
the proxy only. At pinned OpenClaw `513c12703`, the A2A adapter calls the strict
fetch guard without a proxy opt-in; unless managed proxy mode is active
(`OPENCLAW_PROXY_ACTIVE=1`), the guard uses a direct dispatcher that the
NetworkPolicy blocks. An implementation must use one of these paths:

- A qualified proxy-aware path: the runtime sends admitted peer requests through
  the reviewed proxy, and the proxy enforces the peer destination and port.
- A direct path with a NetworkPolicy grant for exactly each admitted peer
  destination and port, and no broader direct egress.

Refuse a configuration whose runtime transport cannot reach the selected path.

Configuration edits do not mutate a serving revision. Deploy validates tokens,
plugin availability, topology, route support, and networking before cutover.
Rotation uses the existing Secret and revision lifecycle and documents when the
old token stops working.

A peer name identifies one external party. At pinned OpenClaw `513c12703`, the
runtime derives a task's owner from the peer name, not the token, and restores
finished tasks under that owner; Enterprise retains Gateway state across
replacement. Same-party credential rotation therefore keeps the peer name and
replaces only its token. A different party requires a fresh peer name. Reusing
a name for a different party is permitted only when the reassignment makes the
earlier party's retained tasks unreachable to the new token; otherwise it is
unsupported, and the operator guide must say so.

Stop removes inbound access and execution; retained workspace and credentials
follow the existing Compute contract. A task ID that was held only in runtime
memory may be unavailable after replacement: report the
runtime's result and require caller reconciliation. Do not automatically resend
an uncertain task that could repeat a tool action.

The first delivery follows the selected plugin's documented text-task behavior.
Do not advertise unsupported cancellation, streaming, task continuation, or
durable cross-restart task recovery as enterprise guarantees.

Outbound delivery is submission only in the first delivery. At pinned OpenClaw
`513c12703`, the adapter sends `SendMessage` with `returnImmediately` and returns
the peer's task ID as a delivery receipt; it has no path that polls for or
returns the terminal artifact. The initiating Agent receives that receipt, not
the peer's result. Do not describe outbound A2A as returning a remote result
until the native runtime owns terminal-result retrieval; see open decisions.

## Acceptance Criteria

Use an owned disposable Kubernetes installation with enforcing NetworkPolicies,
an immutable runtime image that includes the A2A plugin, authorized model access,
and a real external A2A peer. Exercise the normal OCC API or CLI workflow.

- **AC-1 — Admission:** An authorized operator creates Secret bindings and an
  A2A Configuration, creates a dedicated Agent, and deploys a ready revision.
  Embedded mode, literal or inaccessible tokens, missing bindings, unsupported
  routes, and unlisted exposed agent IDs fail before serving-revision cutover.
  A synthetic two-entry native roster with a binding that routes A2A to the
  non-`main` entry also fails before cutover.
- **AC-2 — Incoming task:** An enabled HTTPS route returns a Card advertising
  only the allowed agent. A peer submits `SendMessage`, receives a task, and
  polls `GetTask` to a model-generated result. Missing or incorrect tokens cannot
  invoke the Agent. A valid peer cannot read another peer's task.
- **AC-3 — Outgoing task:** A genuine model turn invokes the native channel to
  send a task to the admitted peer. The peer records the authenticated request,
  and the Agent receives the submission receipt carrying the peer's task ID.
  Record evidence of which transport path carried the allowed request, such as
  the proxy access log or the direct-path flow. Unconfigured destinations fail,
  and an outbound-only Agent has no inbound route.
- **AC-4 — Isolation:** Inspect actual Pod projections and perform network
  probes. Among runtime Pods, peer tokens exist only in the owning Gateway and
  model credentials only in the Harness; another Agent/Namespace cannot read
  either. A peer cannot select an unlisted agent (see the AC-1 roster and
  binding denial), bypass an approval, reach OCC administration, or use the
  Gateway to contact a denied destination. Probe the denied destination through
  both the proxy and a direct connection, and confirm both stay blocked.
- **AC-5 — Lifecycle:** Rotate a token under the same peer name and deploy
  through normal revision cutover; verify the old token stops working, the new
  token can poll that peer's retained tasks, and route ownership holds. Introduce
  a different party under a fresh peer name and verify its token cannot read the
  first peer's retained tasks; if name reassignment is supported, verify the same
  denial after reassignment. Stop the Agent and verify invocation is unavailable.
  Replace the runtime during a task and verify an explicit unavailable/unknown
  outcome without an automatic duplicate send.

## Delivery and verification

The [plan](../plans/0037-native-a2a-channel.md) identifies owners and proof for
these criteria. This PR contains documents only. Source inspection establishes
the current admission gap; none of AC-1 through AC-5 has been qualified by this
proposal. Runtime integration and security denial coverage remain required for
an implementation PR. No runtime source, image pin, or supported reference changes
as part of RFC submission.

## Alternatives and open decisions

Standalone OpenClaw can use the plugin without OCE, but OCE then does not own that
agent's lifecycle. An external A2A adapter can translate requests to Gateway HTTP;
it adds protocol state and authentication ownership outside the native runtime.
Native channel integration reuses the existing protocol implementation while
making its Enterprise deployment boundary explicit.

Compute and routing maintainers must confirm the supported per-Agent route
contract and whether the existing reviewed proxy can enforce arbitrary admitted
peer destinations. Resolve those contracts before implementation; do not add
vendor-specific routing branches to platform core. Runtime maintainers must pin
the qualified plugin version and document its task-state limits. Release
maintainers determine whether this channel belongs in an approved milestone.

Returning the peer's terminal result to the initiating Agent is a native-runtime
dependency owned by runtime maintainers, outside this first delivery. Adopting it
requires defined completion, failure, and timeout behavior: a timed-out task
reports an unknown outcome with its task ID and is not resent. It must be
qualified against a peer that completes after its initial response before AC-3
requires result delivery.
