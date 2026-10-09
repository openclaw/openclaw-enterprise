---
rfc: index.md
---

# Egress Proxy security model

This companion describes the proposed security contract for
[RFC-0019](index.md). It is for reviewers assessing authorization, credential
custody and failure boundaries. It does not establish an implemented or
qualified system. [Lifecycle](lifecycle.md) owns preparation, rotation, startup
and recovery; the examples and APIs in the RFC are conceptual.

## Assets and threat model

The design protects provider credentials and refresh inputs; admitted sources,
routes and grants; Agent and caller identities; provider operations and their
responses; and workspace data preserved during parking or a fork. An Agent can
be compromised, issue malicious requests, or try to obtain provider material.
A Secret writer can change values used by admitted consumers. A provider, store
or network can fail, return unexpected content, or leave an effect uncertain.

The trust boundary is between Agent workloads and trusted senders, resolvers,
lifecycle owners, Secret Drivers and OCC. Trusted components and their
configuration need their own protection and isolation. A resolver handle
guards mistakes among trusted callers; it does not defend against hostile code
in the same process. A route constrains mediated use, but cannot narrow the
authority of a bearer stolen from a trusted component or provider.

| Abuse or failure                                                     | Proposed boundary                                                                                                       |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| An Agent tries to steal credentials or bypass its grant.             | Enforce egress and keep material and handles outside the workload. OCC checks each operation against current authority. |
| A caller substitutes an operation, route or material after approval. | Bind the final check to the actual immutable operation and selected material identity and version.                      |
| A shared source or warm token is used across the wrong scope.        | Authorize each Agent; partition resolver reuse by admitted source generation, normalized grant and isolation boundary.  |
| A provider returns a credential in a response.                       | Apply provider-specific response policy; redact or refuse forms that cannot be handled safely.                          |
| A refresh, send or clone has an unknown outcome.                     | Retain the attempt and reconcile the effect or reauthorize; do not blindly replay it.                                   |
| An owner loses access or a workspace is copied.                      | Hold and park on confirmed last-owner loss; a deep fork receives a fresh stopped identity and no inherited authority.   |

These boundaries depend on qualified enforcement and custody. Source inspection
or fixture behavior alone cannot prove them.

## Callers and trust boundaries

OCC admits source, binding, backend, provider, route and grant configuration.
The trusted sender derives caller context from an authenticated boundary, not
from the request's assertions. An Agent has a stable Namespace-scoped
ServicePrincipal and a separate bearer for an individual execution. Each Agent
must be authorized to use a binding, even when the source is shared.

Trusted bootstrap is a separate caller with authenticated delegation limited to
the execution and configured repository. It need not traverse the Agent's
proxy. Its clone and cleanup duties are in [repository preparation](lifecycle.md#2-prepare-the-optional-repository).

Control-plane discovery is also a separate authenticated caller, not a
fabricated Agent execution. Its authority is limited to the exact Installation
and Namespace, source, purpose, operation, scope and destination, plus any
applicable initiating-user and saved-binding rights. It can use a bounded
trusted callback over warm material and minimum account metadata, or a trusted
service can make the call. It checks current authority after resolution and
before each provider send; it receives no refresh roots and starts no second
refresher. Sanitize results and record secret-free audit of caller, initiating
principal, source and grant, destination, purpose and outcome. Denial,
withdrawal, unavailable authority or cold or expired material refuses use.

## Authorize each operation

For every supported operation, including credential-free egress, the trusted
sender authenticates the caller and captures an immutable description of the
operation, including its destination, protocol authority and policy-relevant
content. It selects an admitted route and grant; a credentialed operation also
needs a binding. Before material access, OCC checks current authority online over
the authenticated caller, versioned route, grant and captured operation.
Unavailable authority, ambiguous routes,
unsupported operations and insufficient scope are refused. Provider adapters
classify operations against normalized grants, including repository ID and
action for GitHub. Requests cannot select another source or backend, load a
driver or widen scope.

After transformations and awaited preparation, OCC freshly checks the actual
immutable operation, authenticated caller, versioned route and grant, and the
selected material's nonsecret identity and version, or explicit absence of
material. Policy receives no credential bytes; a send cannot substitute another
operation or material after the check. Changed routes or grants require
re-admission and repeated checks. Cached allows cannot substitute for either
check, even with cached material.

The sender rechecks material usability and sends once. Each HTTP subrequest,
redirect, retry or new operation on a reused connection repeats authorization
and any required resolution. A finite short send-start deadline and the original
absolute operation deadline bound the send; retries cannot extend the latter.
Deadline values, time protocol and transport enforcement remain open.

## Resolution and custody

The resolver accepts admitted binding and operation context and returns a
use-bound, single-use handle to trusted code or `Denied`, `NotReady` or
`Unavailable`. A handle conveys no authority to send. Material version can
change independently of configuration generation. The implementation must
provide nonsecret identity, version and expiry evidence for the final check and
dispatch; its representation and verification remain open.

Dynamic token reuse is confined behind the resolver by source generation,
normalized grant and isolation boundary. A narrower grant cannot borrow a
broader token. Every credentialed operation resolves again. There is no dynamic
token push, reusable proxy-side cache or fallback, and static stale grace does
not apply. A healthy resolver may serve eligible unexpired material during an
issuer outage; resolver failure refuses use. Cold or expired material yields
`NotReady` without request-time issuance, signing, refresh or scheduling.

Source policy must permit material at the trusted sender, and its implementation
must qualify that custody. Registering a refresh source does not itself authorize
delivery of signing or refresh inputs to the Credential Gateway or other
consumers; those inputs remain confined to the roles that need them under the
admitted custody policy. Keep provider credentials and resolver handles out of
Agent workloads, files and diagnostics; strip Agent authentication before
forwarding. Static freshness and typed failures are specified in
[live Secret cutover](lifecycle.md#live-secret-cutover); rotating input custody,
fencing and durable replacement are specified in
[withdrawal and recovery](lifecycle.md#4-withdraw-and-recover).

## Protect responses

A trusted, provider-specific policy handles successful responses, errors and
streams, including headers, bodies, trailers and encodings. It passes content
only when safe, otherwise redacts or refuses it. Refuse a form that cannot be
handled safely; a provider that can return credentials cannot have unchecked
pass-through. The Agent receives the permitted response or a placeholder, not
provider material.

A blocked response, provider rejection or local timeout after dispatch does not
establish that the provider performed no action. Distinguish refusal before
send from a known response and a possible dispatch. Preserve uncertain attempts
for the [recovery owner](lifecycle.md#4-withdraw-and-recover).

## Protocol and bypass boundaries

Prevent unmediated Agent egress. Bind the selected destination and protocol
authority to the authorized operation. Deny opaque SSH, database and other
traffic without individually authorizable operations. UDP and QUIC must not
bypass enforcement. Additional protocols require explicit operation boundaries
and evidence. Hardened deployment must not silently fall back to no-op egress
when enforcement or a dependency fails.

## Withdrawal and owner loss

A check observing a committed reduction or hold denies removed access. The
Egress Proxy MVP accepts a race: a send may start after a reduction is
acknowledged if its final check raced that change. Finite in-flight work may
continue until the original deadline. Cancellation is best effort; a timeout
neither proves remote cancellation nor undoes an effect. Ordered admission and
renewable stream leases are follow-up work, not guarantees of this proposal.
Scope expansion waits for required warm material and a fresh check; narrower
access may continue.

When an operator disables or removes an owner in OCE, confirmed loss of the last
authorized owner installs a hold and fence for new admissions, subject to the
race above. A team Agent with remaining owners does not park solely because one
leaves. Unknown owner or directory state is not confirmed loss. Report incomplete
containment and `parking` until stop and preservation evidence supports `parked`.

Deployment, restart, repair, deletion and garbage collection cannot bypass the
hold or remove protected data. Platform-owned cleanup continues for the exact
accepted work even if its requester loses access. Release requires current
authorization and fresh execution admission. External identity-provider
offboarding synchronization is later work.

## Authorized forks

An authorized reader can fork the declared readable artifact set from an
immutable captured version. Recheck source-read and destination-create
authority before visibility. The deep copy has independent application data and
mutable references, a fresh stopped identity and runtime home, and no inherited
credentials, grants, approvals or sessions. Copied schedules, hooks and pending
work remain inert until admitted. The original remains available for authorized
read-only review. Copy-on-write and deeper incident preservation require
separate designs.

## Accepted limits and open questions

The accepted check-to-send race and best-effort cancellation are described
above. The other choices below are open work, not additional risk acceptance:

- How are execution bearers issued, bound, delivered and expired? How are
  bootstrap delegation and discovery identity and transport established?
- How do external authorization and native IAM relate? What are the final
  deadline values and time and transport enforcement mechanisms?
- Which component owns GitHub lifecycle scheduling, and what authenticated
  issuer hook is needed? How are material identity, version and expiry proved?
- How will DNS and the pinned Codex HTTP/SSE path be enforced and qualified?

Identity exchange, mTLS identity, workload-token verification, horizontal proxy
high availability and proxy fallback need separate work. Alert channels and
thresholds remain open. Open questions do not weaken the requirements above.

## Required validation

A hardened Egress Proxy MVP must qualify its declared provider slice with actual
enforcement. Evidence must cover caller and tenant isolation; scope and grant
checks; withdrawal and partitions; protocol bypass; safe response handling;
cache and renewal bounds; bounded startup; and uncertain cleanup. Any slice
using rotating inputs must prove concurrency fencing, durable replacement,
restart and uncertain-effect recovery. OCE 1.0 must qualify the full static
inference, GitHub preclone, Codex OAuth and custom dynamic paths.

Check profile capabilities at startup and Agent admission. Minimal CI and
fixture/no-op adapters cannot prove enforcement or injection; deployment
acceptance alone does not prove material or Agent readiness. Keep source,
fixture, installed-runtime and live-provider evidence distinct. The
[qualification plan](lifecycle.md#implementation-discovery-and-qualification)
describes remaining integration and proof work.
