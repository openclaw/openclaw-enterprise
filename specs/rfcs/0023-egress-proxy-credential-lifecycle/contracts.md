---
rfc: index.md
---

# Interfaces and records

[RFC-0023](index.md) defines the proposed components and their records here. The
[protocol](protocol.md) specifies their ordering and failure behavior; [security and
migration](security.md) define qualification and retirement requirements. These are
behavioral contracts, not a prescribed wire format.

For the MVP's [online authorization profile](online-authorization.md), the trust and
release requirements there apply. The stronger dispatch and response guarantees below
remain a distinct profile; an existing admission does not change meaning.

## Admission and configuration

OpenClaw Control Plane (OCC) records the version 2 `ExecutionAdmission` decision in
both the admitted revision and the execution. The deployment selects the composition, which establishes
execution identity. Protection is explicit even with no plan or bindings. Fence readers that could
ignore it, refuse missing or unsupported admission, and require a new execution to change protection.

| Protection | What Compute may release |
| --- | --- |
| `unprotected` | An explicit no-op for local development or minimal CI. The Agent has a control-plane identity, but OCE does not govern its direct requests. Refuse managed routes, bindings, preparation or clone. Supply no managed or ambient substitute credential. |
| `protected {authority: execution}` | Sandbox prevents bypass. Every process in the execution shares its egress authority. A route may explicitly require no provider credential. Zero allowed routes means deny all. Carry forward narrower legacy authority only with evidence of equivalence or fresh consent to the wider boundary. |

OCC validates closed, versioned schemas before reading a Secret or causing effects. A reference is
an immutable ID and configuration generation. Recreating an object gives it a new ID. Changing
policy, custody or approved material advances the affected generations. Routine material rotation
changes a *value version*, not the admitted configuration. The minimum associations are:

```text
SourceKey = (OCE installation, namespace, source ref, backend ref, provider ref)
Execution = (OCE installation, namespace, Agent, service principal, revision, execution ID, admission)
Binding   = (ref, exact execution or management context, SourceKey, normalized grant,
             grant hash, isolation ID, required for startup)
Route     = (ref, same context, HTTPS origin, methods, segment-aware path prefix,
             operation policy, response policy, binding or none, grant, deadline)
```

Normalize grants without implicit wildcards. For GitHub, bind App, GitHub installation, repository
IDs and permissions. Inference binds models, OAuth binds audience and scopes, and API grants bind
audience and operation policy. Isolate per Agent unless sharing is explicitly admitted. Freeze the
trusted Backend composition at admission, including permitted sender, resolver, owner and issuer.
Its provider definition supplies `normalizeInput`, `normalizeGrant`, `classify`, `injectionPlan`,
`responsePolicy` and `validateIssued`. Requests cannot load code or choose a Driver. Control commands carry a request ID,
absolute deadline, local cancellation signal and an OCC-issued permit binding principal, purpose,
action, exact target generations, audience, input digest and expiry.

| Owner and methods | Required result |
| --- | --- |
| OCC via Backend `CredentialSourceControl.describeTypes`, `applySource`, `sourceStatus`, `removeSource` | Admit the schema, source and custody. Project schema identity, kind and nonsecret routing fields to Credential Proxy, never a root or its Secret reference. Catalog withdrawal ends new admission, not responsibility for status, references or cleanup. |
| Compute via `CredentialProxyDriver.capabilities`, `configureRevision`, `wiringStatus` | Configure the whole `ProxyPlan` or make none of it usable. Return authenticated `ProxyWiring` binding execution, plan, Sandbox, sender, audience, version 2, policy generation and exact route and binding sets. Qualify the actual composition at startup and admission. |
| Sandbox via `sandbox.applyCredentialProxy(wiring, command)`, `credentialProxyStatus` | Verify and enforce that plan. Attest the wiring, execution, trusted gateway, immutable sandbox ID, runtime generation, supervisor installation, applied policy and effective sets. Reject a stale install. |


Compute builds the `ProxyPlan` from admitted routes, bindings and source projections. A Sandbox receipt records what was applied;
wiring and receipts do not authorize requests.

### Select Sandbox and Credential Proxy from one Driver

An Installation registers a Driver once, with one identity, configuration generation and lifecycle
owner. It exposes the typed capabilities it implements. A Driver can provide Sandbox, Credential
Proxy or both. In each API or worker process, load the configuration once, start and stop the
Driver once, and give each consumer only its selected interface. Reject conflicting registrations
before activation.
Preserve existing single-capability selections and the identities recorded in admitted revisions.

For this protected composition, Compute requires both interfaces from the same registration. It
verifies the authenticated wiring against the Sandbox's report of what it actually installed, as
specified above. An implementation name, matching Driver IDs or a `supportsProxy` flag cannot
establish that provenance. Exercise installation and admission with a differently named Driver.
Reject a missing interface, views from different owners, or an installed policy that differs from
the plan. Qualify the actual transport and [protection level](online-authorization.md) separately.

## Request authorization and forwarding

| Interface | Responsibility |
| --- | --- |
| `CredentialProxy.capture(peer, exchange, bounds)` | Bind and seal an exchange. |
| `CredentialProxy.forward(operation)` | Own authorization, resolution, send and response protection. |
| `RequestAuthorizer.check(before_access, operation)` | Authorize material access. |
| `RequestAuthorizer.check(before_send, operation, evidence)` | Authorize the selected material or its absence; commit before releasing a send permit. |

The [request protocol](protocol.md#capture-and-authorize-a-request) defines the
ordering, bound fields and refusal or uncertainty outcomes.

## Credential access and lifecycle

`CredentialResolver.resolve(operation, accessPermit, maxStaticAgeMs, minRemainingValidityMs)`
returns a single-use custody handle and nonsecret evidence, or a refusal. Enforce associations at
runtime. Only the admitted trusted sender can consume the handle, never an Agent, UI, arbitrary
callback or diagnostic. Bind evidence to SourceKey, binding, grant hash, isolation, store-qualified material
identity, value version and `usableUntil`. Caller limits may tighten, never widen, admitted policy.
Resolve neither contacts the provider nor signs, issues, refreshes or schedules work.

| Interface | Responsibility |
| --- | --- |
| `SecretDriver.readCredentialInput(secret, material, permit, retention, bounds)` | Read the authorized static target with an immutable version, authoritative observation time and expiry where present. |
| `WarmCredentialReader.readWarm` | Read eligible committed dynamic material for the exact grant and isolation; a cold or expired read starts no preparation. |

| Lifecycle owner interface | Responsibility |
| --- | --- |
| `CredentialRefreshDriver.configureRefresh`, `refreshStatus` | Admit family, single owner, issuer, input authority, grant keys, renewal lead and minimum validity. Report configuration, eligibility, current attempt, activity, next renewal and required recovery separately. |
| `prepare`, `removeRefresh` | Separately authorized management may ensure readiness or request rotation. Removal stops preparation and settles owned artifacts. Retain a family while another admitted source or grant depends on it. |
| `CredentialIssuer.issue`, `inspect`, `retire` | Bind attempt, input version, grant, family, epoch and deadline. Distinguish known refusal, no dispatch, candidate and uncertain exchange. Inspect without repeating issuance. Retire exact custody and report provider revocation only where supported. |

For OCE-managed dynamic credentials, the **Token Service** owns this lifecycle and the warm
reader. Start with the worker's existing background preparation, encrypted custody and fenced
issuer attempts. The GitHub adapter issues, validates and retires an installation token. A trusted
sender can receive only eligible, committed material for its admitted grant and isolation. The
authorizer can check that the exact installed attempt and value version are still current without
reading the token. A cold or expired lookup issues nothing. Distinguish confirmed retirement,
expiry without confirmed revocation, and an operation whose outcome is still unknown.

These interfaces can run in one process. [Protected Git](github-installation-access.md#let-a-team-keep-git-access-until-it-removes-approval)
uses this owner. OpenShell can remain the lifecycle owner for a different credential family.

## Control operation recovery

Every mutating control facet supports `inspect(operationId, bounds)` and
`reconcile(operationId, cleanupPermit, bounds)`. Record request ID, input digest, purpose, action,
exact targets, owner, attempt, deadline and cleanup obligations. An identical request returns its
recorded result, changed input conflicts, and a superseded generation cannot apply even on late
completion. Distinguish refusal before acceptance, pending, applied, known failure with cleanup,
and uncertain effect. Accepted cleanup obligations survive loss of the requester's access. OCC can
issue a cleanup permit for that exact work after use rights expire; it permits no new use, issuance
or broader deletion. Local cancellation does not establish that a remote operation stopped.
