---
rfc: index.md
---

# Invocation and authorized content

Read the [current-source and release-scope amendment](index.md#current-source-amendment--2026-09-24)
before applying this original proposal. Its broader invocation scope is deferred
past 0.x; the requirements below are not implementation acceptance.

A verified conversation selects the authority for one ordinary Agent turn. This
page owns that proposed workflow from native ingress to authorized disclosure.
The [interface reference](interfaces.md#agent-invocation) owns operation permissions
and durable fields. Return to the [overview](index.md) for scope and status.

## Contexts and selection

A personal context binds one human Principal, private Namespace and selected
Agent. A verified one-to-one Slack or Teams conversation selects that person's
personal authority. An explicit mention in an admitted team channel selects its
configured Agent and team service authority. The human remains the requester for
authorization and audit in either case.

A team context binds an Agent, a Namespace-local human Group, a reviewed shared
content baseline and service authority. The baseline defines what the whole team
may share across retained content, tools and integrations. It cannot silently
inherit a member's private authority.

**Proposal, OCC/IAM/connector decision pending:** OCC coordinates versioned contexts
in original State, IAM owns grants, and connectors own complete audience evidence.
Context changes must narrow affected authority even when policy revision does not
change. Creation ownership profiles do not implement context records. Exact
placement, schema and commands remain with the [named owners](interfaces.md#owner-decisions).

## Native ingress and runtime

Use one dedicated Gateway per enrolled app. It authenticates as the exact enrolled
non-Agent connector ServicePrincipal, bound to the app, tenant or workspace, and
registration generation. Pin the reviewed native-hook ABI to the deployed image.
The hook must require OCC admission before any default model dispatch.

The selected initial channel profile is direct Slack in one workspace and
authenticated Teams personal or standard-channel activities in one tenant. Other
channel forms need a new admission profile. Group DMs and implicit or relayed
activation remain separate work.

The connector supplies [verified native facts](interfaces.md#connector-admission)
and retains the native invocation/reply handle. OCC resolves current identity and
context bindings. Missing registration, stale ownership, denial, unavailability,
exception or timeout blocks default dispatch. No caller-supplied identity or reply
destination can replace the enrolled owner's evidence.

The selected Compute and Harness connect OCC to the actual private Agent Gateway
and real run/wait/history/cancel adapter. Dedicated Codex is first. Claude Code and
repository-session delivery to dedicated execution need separately supported and
installed-qualified adapters. Per-Agent execution disables external native channels.
The lifecycle reconciliation queue does not become logical invocation Work.

## Audience and content

Each team Agent has one shared audience. All retained state, tools and integrations
must fit that audience's baseline. Checking only the sender is insufficient because
a native response can disclose content to everyone at its destination.

Before admitting or releasing shared content:

1. Verify the complete destination audience against current team eligibility.
   An administrator-controlled channel still needs a concrete membership-change
   and withdrawal procedure supplied by the connector owner.
2. Stop delivery when audience changes cannot be verified. New members may read
   eligible history under the shared baseline. A stricter transition requires a
   fresh context so earlier broader content cannot leak through retained state.
3. Apply current content permissions to workspace reads and writes, conversation
   and run history, results and channel delivery.
4. Immediately before release, recheck current content permission, full audience
   eligibility and the original reply authority. A successful turn or earlier
   admission does not replace this final check.

The procedure's guarantees are selected. Exact provider membership enumeration,
change detection and withdrawal mechanics remain an unresolved connector/OCC
contract. [Security](security.md#disclosure-and-custody-controls) explains the
consequence for detached send paths and credential custody.

## Dispatch and reply fences

A fence is a durable record that prevents one logical operation from being
performed twice. Invocation dispatch and native reply submission have separate
fences because they cross different effect boundaries.

OCC stores the [invocation identity and admitted authority](interfaces.md#agent-invocation)
before actual dispatch. Duplicate native events return the original invocation.
Reusing an event/idempotency identity with different content rejects. Restart and
audit expiry must not erase the duplicate-dispatch fence. An unknown runtime start
never authorizes automatic redispatch.

The native reply owner retains a separate immutable submission reference. It binds
the original reply handle, result digest, audience revision and original deadline.
After the immediate disclosure recheck, only the original eligible submission may
send. Record provider-confirmed, failed or unknown delivery. An uncertain send or
mutation must never replay automatically.

Retain late provider observations to resolve what happened. They cannot reopen
posting eligibility, extend the deadline or create a fresh submission. Fence
lifetime is independent of audit retention, with its exact durable lifetime still
an owner decision. Do not grant an Agent `operate` merely to satisfy an older
effect adapter. The future per-effect integration must consume the correct narrow
authority instead.

## Protected operation handoff

One invocation selects exactly one personal/team authority owner and exact admitted
integration references. Reuse Secret, ServiceAccount and
[Harness authentication binding](https://github.com/openclaw/openclaw-enterprise/blob/e9766f35a25afa240ee109b41a6ef821fb68687e/specs/30-harness-auth-binding.md)
owners. The Harness adapter owns protected delivery, isolated authentication state,
environment scrubbing, refresh and cancellation. Personal authority cannot borrow
ambient user/operator credentials. Team authority never falls back to a requester's
personal credentials.

For protected model and repository use, consume the
[identity](https://github.com/openclaw/openclaw-enterprise/pull/247) and
[egress](https://github.com/openclaw/openclaw-enterprise/pull/249) owners in order:

1. Observe the actual execution and bind the immutable delivery attempt to that
   incarnation and selected authority.
2. Open the admitted session after authority registration commits. Read back and
   deliver the exact material. The protected probe needs separately admitted
   bootstrap authority whose mechanism remains unresolved. State/Compute serialize
   current-serving selection and predecessor withdrawal before enabling protected
   use. Readiness alone is insufficient.
3. Preserve the observed incarnation throughout delivery. A replacement execution
   requires fresh admission. Select a usable execution for each invocation rather
   than redeploying a substitute Agent for every request.
4. Bind concurrent protected operations to their original requester. Recheck
   currentness after waits and immediately before dispatch and delivery. A withdrawn
   waiter cannot cancel another requester's valid work.
5. Require actual connection/request proof at every protected receiver. Deny stale,
   retired, sibling and off-Pod replay. A copied bearer or serialized identity is
   insufficient evidence.

The exact concurrent-operation association and protected bootstrap/current-serving
mechanisms remain with their owners. The requirement is an actual managed Harness
turn reaching protected model and repository consumers with the original requester's
authority. Rearranging calls, naming a verifier or demonstrating component methods
does not establish that path. [Qualification](delivery.md#increments-and-qualification)
must prove the same source and installed artifacts through it.
