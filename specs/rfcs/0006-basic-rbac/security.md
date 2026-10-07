---
rfc: index.md
---

# RBAC security

Read the [current-source and release-scope amendment](index.md#current-source-amendment--2026-09-24)
before applying this original proposal. Its broader invocation scope is deferred
past 0.x; the requirements below are not implementation acceptance.

The [proposal](index.md) protects a person's content and the authority
used by their Agent request. Its controls are selected requirements. Missing
implementation or qualification is not an accepted residual risk.

## Assets, actors and trust

Protected assets include workspace content, conversation and run history, results,
human and service credentials, policy authority, and the integrity of admission and
withdrawal records. An enrolled human is the requester. An Agent ServicePrincipal
is the Agent's immutable platform identity. Connector, runtime and credential
owners mediate different trust boundaries.

Treat model output, tool execution, retrieved content and caller-supplied inputs as
potentially compromised. They must not choose a stronger identity, redirect a
reply, reuse another execution's material or reopen an uncertain effect. Current
IAM decisions and original-State custody constrain those actions.

Self-granting policy administrators and privileged infrastructure operators remain
trusted. This scope does not promise confidentiality from those designated actors.
Stronger operator resistance needs separately selected key custody, attestation and
protected execution. That recorded trust boundary does not waive the selected
controls against ordinary callers or compromised tools.

## Authority separation

Keep requester, Agent ServicePrincipal, execution, context and credential owner
distinct. An execution is an observed runtime incarnation, not a human identity.
A context selects personal or team authority, not a new source of grants. Caller
names, identity labels, credential profiles and destinations confer no authority.

Team use never falls back to requester credentials. Personal use never borrows
another user's or an operator's ambient login. Each invocation selects one
admitted authority owner and exact integrations. Replacing an execution requires
fresh admission rather than transferring evidence from its predecessor.

Installation administration and the retained administrator bundle imply neither
content nor audit access. [Exact permissions](interfaces.md#permissions-and-targets)
govern workspace actions, results and History independently. Safe status cannot
leak prompts or results. Direct human Groups and overriding deny Restrictions
remain effective for all matching grants.

## Disclosure and custody controls

The enforced runtime disables model-visible detached channel sends, broadcasts,
uploads, edits and proactive delivery. Per-Agent execution disables external native
channels. Connector credentials remain with native delivery, and ordinary Agent
configuration cannot enable another send path. Broader effects require the
[per-effect successor](delivery.md#decisions-and-follow-ups).

A completed protected profile keeps long-lived provider credentials outside tool
execution and uses protected model and repository routes. Direct-Harness credential
delivery is explicitly weaker. Reject unadmitted repository or channel credentials
in generic Secrets, native authentication stores, plugins or Configuration.
Installed network enforcement makes the selected repository route mandatory.
Alternate credentials or direct provider bypasses invalidate confinement claims.

Destination reachability does not authorize every operation at that domain. A
new provider adapter must parse and authorize the exact operation before credential
use and dispatch. The [repository assignment](interfaces.md#repository-assignments)
limits that authority. The [egress proposal](https://github.com/openclaw/openclaw-enterprise/pull/249)
owns actual transport enforcement. The [invocation workflow](invocation-and-content.md#audience-and-content)
requires the complete destination audience and current content authority immediately
before release.

Mutation, admission and credential-dispatch audit are mandatory and fail closed.
Safe facts exclude credentials, custody handles, identity claims and labels, URLs,
headers, commands, paths, prompts, response or provider bodies, and exception text.
Audit outage cannot prevent local refusal, expiry or closure. It also cannot
manufacture durable completion evidence.

[History](https://github.com/openclaw/openclaw-enterprise/pull/250) independently
requires current authorization, retention/recovery and acknowledged-disclosure
gates before serving. Its UI is not an invocation prerequisite. Producers still
owe their mandatory safe facts, and audit erasure must not erase the independent
invocation or native-submission fences.

## Withdrawal and failure

Policy commit closes new protected admission and results while atomically recording
narrowing intent for affected invocations and sessions. The controller's protective
worker survives the human's permission loss and can only narrow authority. It
cannot grant or widen it.

Target withdrawal by the removed authority. Member removal targets that person's
admitted work. Team-service revocation targets every affected service-grant use.
Until safe per-invocation cancellation exists, stop the affected exact Agent
revision and close all its sessions. Incident pause and termination remain
available. Resume requires a fresh authorized generation. A withdrawn waiter must
not cancel another requester's valid work.

The completed MVP must measure **at most 30 seconds** for both new-work refusal
and the last protected bytes, including loss of renewal connectivity. Preserve
`account-currentness-v1`'s stricter five-second ceilings for dependency calls,
operation starts, model rechecks and model closure. Those scoped ceilings are not
a global five-second revocation promise.

Producing identity, credential, egress and Compute owners must define the starting
event, evidence age, clock/skew handling, monotonic expiry, cadence and closure
reserve. Renewal preserves source, owner, profile and original immutable horizon.
It cannot extend that horizon or renew a withdrawn generation. The
[identity proposal](https://github.com/openclaw/openclaw-enterprise/pull/247) owns
currentness semantics, while RBAC must register and withdraw its consuming
authority. Timing mechanisms remain open until their owners close these contracts.

Finite credential close/expiry cancels owned traffic. Receiver expiry progresses
independently of the Harness and refuses new work before awaited cleanup. Durable
exact-Compute-stop retries continue. Reconciliation cadence alone is no outage
bound. Measure traffic closure and observed physical termination separately.

Withdrawal receipts distinguish policy commit, new-admission refusal, local
credential closure, observed cancellation/termination and unresolved provider
cleanup. A queued stop is not completion. Copied direct keys depend on provider
expiry or revocation, and already accepted provider effects may finish. Unknown
dispatch or cleanup remains visible without automatic replay. Neither late success
nor missing evidence authorizes another attempt.

## Accepted limits and closure

The recorded scope includes trusted administrators/operators and the weaker
compatibility/direct-Harness paths. It does not establish independent local process
termination during control-plane failure or provider revocation from local session
closure. Independent physical termination and exact-container origin need their
separately owned successor proofs.

The selected enforced profile still requires authentic receiving evidence, mandatory
routes and measured withdrawal. Unresolved audience procedures, concurrent-request
association and timing mechanics are missing design closure, not accepted risk.
[Delivery evidence](delivery.md#acceptance-evidence) must exercise actual boundaries,
resolve independent security and SQL findings, and bind qualification to exact
installed artifacts. An RFC, source definition or successful component test cannot
close those gates.
