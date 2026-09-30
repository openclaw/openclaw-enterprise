# Basic observability: trusted repository read

[Overview](../31-basic-observability.md) · [History contract](contract.md)

**Status:** Proposed selected behavior. Shared invocation/runtime exports, credential-owner acceptance and connected qualification remain pending.

**Owners:** OCC/RBAC admission, Compute/Harness execution, identity/egress receiving controls, credential sessions/provider results and Audit/State projection.

## Decision

Deployer A creates and deploys a personal/team Agent. Different authenticated human B requests one approved GitHub HEAD read. Separately granted audit-only reader C follows B's admission through the real Harness turn, managed Git child, session and strongest observed or unknown result.

[Lifecycle History](contract.md#verification-and-delivery) is the first milestone. The cross-person History demonstration is a stretch. Real GitHub and model access and eligible session capture and backfill remain in the connected MVP. One qualified admission/runtime/channel profile and local accounts suffice. Full neighboring provider, Harness and retained-workspace deliveries remain separate.

<a id="current-source-amendment--2026-09-24"></a>

## Current boundary and scope

**Current-source amendment — 2026-09-24.**

The amendment recorded the [repository-credentials source](https://github.com/openclaw/openclaw-enterprise/blob/5ebd7305b0876db33276a249934bc82073b63424/docs/reference/repository-credentials.md). [Pinned main](https://github.com/openclaw/openclaw-enterprise/blob/e4a807e785e1a242e27200c8e8396f58136cbbc6/docs/reference/repository-credentials.md) supports embedded OpenClaw and dedicated Codex through the selected `RepoDriver`, whose `listOptions`, `resolve`, `open`, `status` and `close` own repository admission and sessions. State retains immutable admission context and cleanup obligations after Agent deletion. Consume these contracts. The older supplier limits below are historical evidence.

This foundation does not establish B's authentic per-invocation attribution, connected A/B/C acceptance, or receiving and withdrawal evidence for the stronger proposed identity/egress profile. Session closure, provider cleanup, runtime retirement and observed Git results remain separate facts.

The separate [credential supplier](https://github.com/openclaw/openclaw-enterprise/blob/02f8fe0b1266462a5726c6684344394324a8bdf7/docs/reference/repository-credentials.md) supports Kubernetes embedded OpenClaw, rejects dedicated Harnesses and defaults omitted profiles to `git-write`. It checks the open session, exact grant/profile and original finite deadline. Closure or expiry denies new exchanges and aborts owned exchanges while preserving possible dispatch.

Worker checks concern the queued deployment actor, not per-exchange human currentness or outage revocation. A revision bearer identifies neither B nor a native turn. Restart loses provider-token cleanup inventory. Tokens may survive to expiry. Retained platform IDs cannot prove revocation.

That supplier is not the historical baseline. A separate historical integration supplier outside main at `6538069` has a [purpose resolver](https://github.com/openclaw/openclaw-enterprise/blob/65380694085693d6edb5218372ccddbc2ba493d9/packages/occ/src/runtime-authority/service.ts#L349) that returns unavailable on eligible lookup.

## Admit one operation

Consume the [RBAC owner's](https://github.com/openclaw/openclaw-enterprise/pull/245) proposed `AgentInvocation` admission/status/result/cancel, server-owned `AgentAuthorityContext` and `AgentInvocationRuntime`. Current account/method/session and exact `invoke` admit the original human and personal/team authority. The common owner selects the immutable revision and registers authority under the State/policy barrier.

Repository use requires an approved assignment and current exact Agent-ServicePrincipal `use_repository`. The credential owner's accepted source defines guarantees. Preserve owner-issued opaque IDs, selected authority, actual authorization principal, IAM Driver, exact action/resource and admission reference. Initiator and authorization principal may differ.

Callers cannot choose another human, generation, ServicePrincipal, session, URL, command, profile or output destination. Freeze the one-operation shape/vocabulary only after accepted owner exports. Observability adds no invocation API, record, queue, Work implementation, authority lease or native Gateway client.

The real managed Git child uses explicit **`git-read`** on the admitted repository. Qualify packaged Git and GitHub against the proposed fixed operation:

```sh
git -c protocol.version=0 ls-remote --symref --exit-code -- <admitted-url> HEAD
```

The runtime supplies the invocation. Callers cannot supply the placeholder. Provider permission ceilings establish neither one-use command authority nor human initiation. The credential owner retains profiles, protocol and credential custody.

## Connect authentic handoffs

These handoffs remain proposed: existing ledger/credential source does not prove their composition, installed receiving control or genuine live-Agent execution.

Compute/Harness must supply the actual turn, status/result/cancel, unknown-dispatch reconciliation and private credential delivery. Dedicated Codex/separate Gateway needs a reviewed `RepositoryCredentialRuntimeBinding` consumer in the executing child/role, covering PATH, trust, material, initialization and generation. Relaxing a topology check is insufficient.

For the protected profile:

1. Observe preparation with traffic disabled, then bind the exact incarnation.
2. Persist the immutable session attempt, open the session and read it back.
3. Deliver material without changing incarnation.
4. Validate current execution, material and serving selection, then enable traffic.

Replacement requires fresh admission, never session rebinding or downgrade. Coordinate bootstrap-probe authority with the [identity](https://github.com/openclaw/openclaw-enterprise/pull/247) and [egress](https://github.com/openclaw/openclaw-enterprise/pull/249) owners. Readiness alone is not current-serving selection. Protected bootstrap and current-serving mechanisms remain unresolved joins. Egress containment before any untrusted instruction is a proposed strengthening of mandatory pre-readiness containment, not qualification.

Each reference needs its original source record and authorized diagnostic lookup. Independently authenticate request-to-authority and per-operation turn/session association, including concurrent turns sharing an execution. DTOs, copied IDs, deployment actor, Git author/configuration, model text and headers cannot establish B.

Admission/dispatch and native reply submission need independent durable fences that survive audit erasure. Reconcile unknown start/send/provider outcomes without blind redispatch. A native reply also needs current content authority, complete eligible audience and original reply custody under the [common invocation/content owner](https://github.com/openclaw/openclaw-enterprise/pull/245).

The closed observation contains original invocation/authority references, provider-neutral repository/grant/session/profile IDs, admitted operation kind, dispatch state and strongest established transport/provider result. These are expanded producer obligations, not fields already present in the proposed lifecycle-only contract. Apply [fact contract and safe projection exclusions](contract.md#facts-and-events). A bearer without authentic invocation association leaves attribution unresolved. New credential dispatch requires established local evidence. Audit outage permits protective refusal/closure, not a newly claimed durable revoke.

## Currentness and closure

Authentication owns account/method/session validity. IAM owns exact authorization. The receiver owns execution assurance. Compute owns observation/termination. Egress owns protected transport/streams. Credential owners own deadlines, closure and provider cleanup. History records facts and implements none of these controls.

Only actual receiving verification supplies assignment, generation, component, admitted profile and original verification/expiry times. Protected evidence references require owner-authorized lookup. Compatibility records absent/unverified assurance. Serialized observations are not proof objects, leases or transferable authority. SVID/session strings do not prove physical origin.

Keep same-connection/request and current-serving evidence in owner custody across waits and final dispatch/delivery fences. A withdrawn waiter cannot authorize acquisition or cancel another current waiter's work. The [identity currentness contract](https://github.com/openclaw/openclaw-enterprise/pull/247) owns this evidence. The actual [egress receiver](https://github.com/openclaw/openclaw-enterprise/pull/249) must consume it at the accepting transport.

The selected protected composition must measure **at most 30 seconds** from the defined authority-owner event to both new-work refusal and last protected bytes, including renewal-connectivity loss. Owners must specify event, evidence age, clock/skew, monotonic deadline, cadence and closure reserve.

Preserve the separate integration supplier's [scoped five-second ceilings](https://github.com/openclaw/openclaw-enterprise/blob/65380694085693d6edb5218372ccddbc2ba493d9/packages/contracts/src/account-authority-v1.ts#L28) for dependency calls, operation starts, model rechecks and model closure. They are not global five-second revocation. These end-to-end guarantees remain unqualified. Timers or maintenance intervals do not prove them.

Renewal cannot change owner, source grant/profile, generation or original absolute deadline. Enforced profiles cannot downgrade. Separately record route/stream closure, credential-session closure, provider cleanup, requested stop and observed termination. Durable runtime termination awaits Compute observation. Local closure proves no remote cancellation. Accepted external effects may remain possibly dispatched/unknown, retaining settlement custody.

## Acceptance and delivery

Run A/B/C through one genuine ordinary Agent/Harness turn and real managed Git child to an owner-approved read-only live GitHub repository. C must see B, separate Agent/revision executor, selected authority/session, truthful assurance, exact authorization/resource, durable acceptance and strongest result/unknown. Pod exec, controller Git and fixture submitters do not pass.

Exercise stale/cross-Agent/revision/session authority, duplicate/unknown dispatch, concurrent turns, revoke before final dispatch, local audit outage, runtime closure, off-Pod denial and secret/reference exclusion. For native replies, exercise audience change and unknown/late send without replay.

Qualify receiving and both withdrawal endpoints, renewal loss, delayed positives, blocked consumers and saturation on the same installed artifact. Record exact revisions, dependencies, cleanup and missing proof separately for source/database, composed, installed, controlled transport, live-provider and release evidence. These gates are future work, not executed tests.

## Alternatives and follow-ups

A revision bearer or synthetic submitter provides component evidence, not authentic requester attribution. Retain existing owners. Add no OBS execution service.

Exact-container origin remains deferred until a stronger same-Pod guarantee is selected. Identity/Compute must prove real caller-to-incarnation receiving custody. Independent physical termination during controller/Compute failure remains later hardening owned by Compute/trusted runtime supervision. It closes only with trusted expiry and measured observed stop. Neither weakens selected off-Pod protection or traffic withdrawal.

Future durable provider-cleanup recovery belongs to the credential owner and needs protected custody/recovery plus provider-observed outcomes.

<a id="design-and-failure-behavior"></a>
The design and failure behavior are in [admission](#admit-one-operation), [handoffs](#connect-authentic-handoffs) and [closure](#currentness-and-closure).
