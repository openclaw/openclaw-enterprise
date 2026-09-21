# Agent identity security

[Overview](../basic-agent-identity-mvp.md) · [Architecture](architecture.md) · [Delivery](delivery.md)

The proposal must prevent a copied credential or stale execution from becoming
fresh authority. Its controls apply at the receiver and credential owner, where
the system can refuse effects and output. Successful authentication alone does
not establish the requester, permitted operation, or response audience.

## Assets, actors, and trust

Protected assets include provider credentials, refresh tokens, signing material,
workload private keys, registration authority, and authorized outputs. Execution
and invocation evidence are also sensitive because consumers use their original
scope and lifetime to constrain effects. A diagnostic copy must never act as that
evidence.

Treat Agent tools, tool children, supplied input, and caller-authored request
fields as untrusted. The selected boundary trusts the node, Kubernetes control
plane, enforcing CNI, SPIRE, constrained registrar, and receiving transport. The
Container Network Interface (CNI) implements the networking policy on which
private ingress depends. A compromised trusted component is outside this recorded
scope and must not be described as resisted by ordinary workload mTLS.

The human requester, Agent ServicePrincipal, executing component, and credential
owner remain separate actors. Login, creator Roles, and unselected provider
sessions confer no Agent authority. Login alone grants neither connector nor
repository access. Explicit admission selects the personal or team integration.
Callers cannot substitute a person, team, connection, grant, or audience.

## Receiving and custody controls

A stolen repository bearer or copied proof-shaped object must fail to establish
execution identity. The receiver verifies the actual X.509 connection, recipient,
component, trust domain, registration, and assignment. Ordinary operations also
require current-serving selection. Selected IAM resolves the verified identity to
the existing Agent ServicePrincipal and evaluates the exact operation.

Egress must preserve opaque request/connection custody through its accepting Go
listener and authenticated Go/TypeScript bridge. Every route must obey the
[receiving and forbidden-constructor rules](interfaces.md#verified-workload-evidence),
so copied diagnostics and bearer material cannot become authority.

Compute prepares one trusted egress Go service per assignment. Its private ingress
must be independently enforced before readiness. The certificate identifies the
relay component. Trusted assignment and enforced ingress associate that relay
with the Agent. Every protected route must deny ordinary off-Pod replay from both
external and sibling workloads. These requirements apply even when copied session
material or an unexpired certificate is presented.

**Proposed strengthening, owner decision pending:** the [egress proposal](https://github.com/openclaw/openclaw-enterprise/pull/249)
would require containment before any untrusted init, startup, or replacement code
executes. Compute and CNI owners must qualify that first-execution boundary.
NetworkPolicy readback alone does not establish it. This proposed earlier boundary
does not weaken the required pre-readiness protection.

Workload private keys, long-lived provider credentials, refresh tokens, signing
keys, and registration authority stay outside tool execution. Qualification must
inventory material available to init and probe processes, tool children, relay,
and Gateway mounts. The separate Gateway receives no repository session. Permit a
short-lived execution bootstrap credential only when the selected transport
requires it. Bootstrap probe authority remains distinct from serving admission.

Egress owns mandatory routing and destination/operation enforcement. Managed
Git/`gh` must retain its private credential route and service trust. The credential
owner keeps exchange, injection, renewal, and cleanup. Neither a shared session nor
the deploy actor identifies the human initiator. RBAC must bind the actual
invocation and turn to each operation and verify the current complete audience.
Ambiguity denies dispatch and delivery, including where multiple requests share
one execution.

## Currentness controls

A valid certificate may outlive its assignment or the requester's authority.
Retired execution and withdrawn authority generations must therefore lose
admission, renewal, credential acquisition, and dispatch immediately at their
guarded boundary. Loss of requester eligibility, connection authority, or audience
access denies further use.

Retain original stable Principal, account, method, and session facts. Consume the
[account lifecycle proposal](https://github.com/openclaw/openclaw-enterprise/pull/246)
and RBAC's dependent-authority rules. Ordinary logout is session-scoped. Account
disablement, method repair, and team-grant changes have distinct consequences.
Re-enabling an account cannot resurrect withdrawn authority.

Preserve the supplier guards' no-positive-cache behavior. Any separately allowed
cache may not outlive admitted validity. Rotation, reconnection, retry, and delayed
positive results retain the original source, generation, and absolute deadline.
An apparently fresh envelope cannot extend an older proof's budget.

Receivers must enforce the [post-wait and synchronous delivery fences](interfaces.md#currentness-and-expiry).
Shared acquisition requires a still-current original exchange waiter at dispatch
and after waits. A withdrawn waiter cannot authorize minting, cancel another
current waiter's work, or abandon settlement.

Invalidation must synchronously refuse new work and buffered delivery before
awaiting cleanup, even during audit outage. Receiving expiry progresses without
Harness cooperation, blocked-reader progress, or free listener capacity. The
[currentness and expiry contract](interfaces.md#currentness-and-expiry) retains
the whole 30-second bound and separately scoped five-second ceilings. Constants
and maintenance reconciliation do not prove those installed limits.

## Accepted limits and closure

The following are recorded trust or scope limits. Missing implementation and
unresolved mechanisms remain acceptance work, not accepted residual risk.

**mTLS proves possession of a key.** A copied certificate and matching private key
remain usable wherever the receiver is reachable. Pod networking does not identify
the sending container. Required off-Pod denial therefore remains distinct from
deferred exact-container assurance. Stronger container or host claims, including
gVisor, require a runtime-aware broker with verified caller, incarnation, and
request correspondence plus separate host-boundary qualification.

**Intermediate model delivery can have weaker custody.** A checkpoint that gives
the model key directly to the workload must disclose that exposure. The recorded
[baseline model probe](https://github.com/openclaw/openclaw-enterprise/blob/724dcb5cb80b5e76a62e8267a21185a2e91a85c2/apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts#L552-L589)
receives the key. That source behavior does not qualify the selected protected
model or bootstrap probe route.

**Local closure does not prove physical stop or provider revocation.** A stop
request, missing Pod, or timeout is not exact-incarnation termination evidence.
Independent outage-time physical expiry remains later Compute/runtime hardening.
Already accepted upstream effects may complete after local traffic closes.

The [repository supplier](https://github.com/openclaw/openclaw-enterprise/blob/eb52cc4cfe68f08017e7ece6585fe7e937e0747a/docs/reference/repository-credentials.md#L17-L24)
loses provider-token cleanup inventory on service restart. Local session loss
cannot prove revocation, and issued tokens may survive until their original
expiry. Durable recovery needs protected recovered custody and provider-observed
settlement before the credential owner can claim closure.

Explicit `git-full` also carries a broader ceiling than one PR. It admits selected
Git, REST, GraphQL, PR, issue, and comment operations. GraphQL uses the exact
installation-token grant without per-field authorization. Identity must preserve
that [supplier profile meaning](https://github.com/openclaw/openclaw-enterprise/blob/eb52cc4cfe68f08017e7ece6585fe7e937e0747a/docs/reference/repository-credentials.md#L102-L125)
rather than imply a narrower capability.

Bootstrap admission, peer selection and bridge custody, concurrent operation
association, current-serving production, and timing mechanics remain
[owner decisions](interfaces.md#observations-and-owner-decisions).
[Composition qualification](delivery.md#acceptance-evidence) must exercise their
real consumers and complete independent security review and fixes before support.
