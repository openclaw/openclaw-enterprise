---
status: Proposed
---

# Proposal: Generic Token Service and pluggable token leasing

- **ID:** RFC-0056
- **Owner:** OCE maintainers
- **Created:** 2026-10-02
- **Related:** [Repository credentials](../31-repository-credentials/index.md), [recovery](../39-repository-credential-recovery.md), [credential injection](../39-sandbox-credential-injection.md)

## Summary

Refactor the repository credential broker into an Installation-scoped **Token
Service** deployed independently of OCC workers, with standalone support. It owns
Agent-scoped bearer access with durable verification records, internal credential
leases, memory-only upstream token custody, replacement, and cleanup.
Named **TokenDriver** instances implement upstream issuance and revocation;
`GitHubTokenDriver` is the first implementation. Keep repository discovery,
Git/`gh` routing, and repository permission checks in the existing RepoDriver and
repository gateway adapter. Managed Agents authenticate with opaque bearers
bound to the Agent, not its revision. Upstream tokens remain inside the service. Repository metadata lookups use short
Installation-owned leases, independent of Agents and drafts.

This proposed architecture changes managed access lifetime and restart recovery
while retaining exact authority and truthful cleanup accounting. YAML is
not yet supported; an implementation plan follows interface review.

## Motivation and scope

The [current broker](../../../docs/reference/repository-credentials.md) separates
session and token lifetimes, replaces tokens without changing grants, and
distinguishes closure from disposal. Its private
[Backend interface](../../../apps/controller/src/drivers/repo/credentials/backend-contracts.ts)
combines token lifecycle with HTTP planning and authentication, coupling reuse
to repository-specific policy and recovery.

First delivery must carry the regular Agent repository workflow
through the generic service, including renewal, stop, deletion, and recovery.
It does not replace SecretDriver, ServiceAccountDriver, or
[CredentialGatewayDriver](../../../docs/reference/drivers/credential-gateway.md).
General model inference, new Sandbox support, arbitrary HTTP forwarding,
interactive OAuth login, raw-token delivery, and a general public token API are outside first
delivery. OAuth below demonstrates the extension seam; it is not a second
promised integration without a supported caller.

The broker backend is not pluggable. OCE owns the lifecycle of platform-minted
credentials, including repository tokens. OpenShell may directly manage
user-supplied credentials. Supplying platform-minted credentials to OpenShell
requires a separate trusted-service handoff from OCC; until it exists, retain
the OCC repository gateway path rather than delegate issuance to OpenShell.
This does not enable raw Agent delivery. See the [OpenShell FAQ](faq.md) for
overlap, refresh ownership, and integration limits.

Remove OCE-managed Git hooks and `pushRefAllowlist` in this refactor. The
[current push-ref guardrail](../../../docs/reference/repository-credentials/push-ref-guardrail.md)
is bypassable; its accidental-push protection is intentionally dropped. Remove
its configuration, grant-fingerprint inputs, client metadata, hook dispatcher,
and generated `core.hooksPath` override. Reject the removed configuration field.
Ordinary Git hooks remain user-controlled. GitHub repository rules enforce
remote-ref restrictions; this refactor does not provision those rules. Reconsider
managed hooks only for a concrete future need.

Retain the repository clients and gateway adapter over the generic lease engine.
Preserve the supported [Git/`gh` behavior](../../../docs/reference/repository-credentials.md#client-routing-and-limits):
native configuration, exact destination checks, explicit duplicate-binding
selection, response filtering, and no automatic replay of uncertain mutations.
Managed bearer ownership moves to the Agent and has no mandatory session expiry.
Client configuration generations still pin the admitted binding; stale clients
cannot silently select newer or broader authority. Standalone sessions retain
explicit deadlines. Workload-identity authentication is future work, not a
condition for accepting a managed bearer.

## Ownership

| Owner                         | Responsibility                                                                                                          |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| OCC and selected IAM Driver   | Authorize platform operations; bind Agent grants and active admission; persist lifecycle and cleanup intent.            |
| Token Service                 | Validate admissions; own leases, custody, renewal, capacity, reservations, and terminal receipts.                       |
| TokenDriver                   | Normalize issuer-specific grants; acquire replacement tokens; report actual scope, expiry, revocation, and uncertainty. |
| Repository gateway adapter    | Validate Git/`gh` requests and destinations; use a lease internally; preserve existing response filtering.              |
| RepoDriver and GitHub Backend | Own discovery, metadata caching, profile resolution, and private lease coordination.                                    |
| Compute Driver                | Own Agent bearer artifacts and binding configuration; withdraw retired workload access.                                 |

Deploy one active Token Service per Installation, independently of workers.
Workers call its authenticated HTTPS control API; Agents use Agent-scoped bearers on
its separate HTTPS gateway. The service accesses admission and restricted bearer
verification records and writes receipts directly, replacing Unix control sockets and worker callbacks
in OCC mode. [Deployment and recovery](deployment.md) defines authentication,
state ownership, failure behavior, and the proposed topology. General
[Agent-to-OCC workload authentication remains planned](../../../docs/design.md#implementation-status).

## Installation YAML

Illustrative Installation fragment; required Configuration, IAM, Compute, and
Secret selections are omitted. Files are operator-provisioned mounts.

```yaml
tokenService:
  id: installation-tokens
  mode: occ
  control:
    origin: https://token-control.example.internal
    tlsCertFile: /run/token-service/control.crt
    tlsKeyFile: /run/token-service/control.key
    clientCaFile: /run/token-service/control-clients-ca.crt
    clients:
      - identity: spiffe://oce.example/worker
        admissionKinds: [agent]
      - identity: spiffe://oce.example/api
        admissionKinds: [installation-operation]
  state:
    databaseUrlFile: /run/token-service/state-database-url
  gateway:
    publicOrigin: https://credentials.example.internal
    tlsCertFile: /run/token-service/tls.crt
    tlsKeyFile: /run/token-service/tls.key
  recovery:
    minimumIntervalSeconds: 60
    maximumUnresolvedAttemptsPerAgent: 3
    maximumUnresolvedAttemptsPerDriver: 100
  leasePolicy:
    maximumOperationDurationSeconds: 30
    credentialMarginSeconds: 60
  drivers:
    - id: github-production
      type: github-app
      configuration:
        appId: "123456"
        privateKeyFile: /run/token-service/github-app.pem
  grants:
    - id: platform-read
      driverId: github-production
      namespaces: ["11111111-1111-4111-8111-111111111111"]
      audience: repository-gateway
      parameters:
        installationId: "789012"
        repositoryId: "345678"
        repository: example/platform
        profile: git-read

backend:
  - id: github-primary
    type: github
    configuration:
      tokenServiceId: installation-tokens
      repositories:
        - repositoryRef: platform
          profiles:
            git-read: platform-read
    drivers:
      repo: repository-credentials
drivers:
  repo:
    id: repository-credentials
    configuration:
      publicCaPath: /etc/openclaw/token-service/ca.crt
      controlClient:
        certFile: /run/occ/token-control/client.crt
        keyFile: /run/occ/token-control/client.key
        caFile: /run/occ/token-control/server-ca.crt
```

`tokenService` is optional and singular. Its `drivers` collection is a private
service registry, not an array-valued replacement for the existing singleton
`drivers.<capability>` selectors. `backend[].drivers.repo` retains exact Backend
membership. The GitHub Backend references the service and maps repository
profiles to grants instead of owning a second grant registry. Mapping validation
requires the GitHub issuer, numeric repository identity, and profile to agree.

Each token Driver selects exactly one bundled `type` or installed `package`.
The main example uses the first-delivery GitHub implementation and its current
exact profile permission maps. The following separate registry entry illustrates
the installed-package seam; it is not a shipping integration:

```yaml
# Illustrative entry under tokenService.drivers; not part of the GitHub example.
- id: graph-production
  package: "@example/oce-oauth-token-driver"
  configuration:
    tokenEndpoint: https://login.microsoftonline.com/example-tenant/oauth2/v2.0/token
    clientId: example-client-id
    clientSecretFile: /run/token-service/graph-client-secret
```

An OAuth integration also needs a supported consumer adapter and reviewed grants;
unknown packages and unsupported audiences fail startup. OAuth `.default` uses
administrator-approved application permissions, not proof of narrower scope.
Its Driver must validate the configured application authority before admission.

In OCC mode, grant and Driver IDs are Installation-unique. `namespaces`
contains exact platform Namespace IDs, not Kubernetes namespace names. Unknown
fields, missing references, unsupported audiences, invalid duration bounds, and
incompatible profile mappings fail startup. No wildcard Namespace admission.
These allowlists constrain issuance; they do not substitute for IAM grants.

The API, worker, and service bind authority to the same `configurationDigest`.
Compute it from a deterministic, nonsecret projection of the authority
configuration: service identity and mode, pinned Driver implementation identity,
public issuer configuration, grant IDs and parameters, Namespace restrictions,
audiences, repository/profile mappings, bounded-consumer duration policy, and authorization
generation. Canonical serialization fixes object-key order and normalizes
unordered collections without executing Driver packages. Private credential
contents are excluded; rotating an equivalent signing key does not change the
digest. Semantically equivalent configuration edits may change it and invalidate
leases. There is no generated semantic catalog or digest-advertisement handshake.

Admissions bind `configurationDigest` and `grantId`, along with the exact owner,
authority, authorization generation, and any bounded-operation deadline. API and worker retain public
GitHub identity and profile policy resolution. Only the service loads TokenDriver
packages and private issuer files. Before becoming ready, it validates every
Driver configuration and grant against its schemas, normalizes all grants, and
checks Backend/profile mappings. At admission it independently compares the
committed authority with the selected grant and its active configuration; matching
a digest alone does not authorize access. Retiring Drivers remain available for
cleanup until their obligations settle.

Preserve existing protected-file, TLS, queue, byte, timeout, and capacity limits,
including override bounds and enforcement. The additional positive recovery
limits above bound managed GitHub restart issuance; their durable accounting and
Driver eligibility are defined in [restart recovery](deployment.md#state-and-recovery).

## Lease contract and lifecycle

Managed access belongs to `agent`: `(installationId, namespaceId, agentId)`.
The opaque bearer identifies that Agent across revisions. Its current admitted
grants record `revisionId` as configuration provenance, an
`authorizationGeneration`, exact authority, and `configurationDigest`; revision
identity is not the bearer subject. Draft or inactive revisions grant no access.

Managed Agent bearers have no mandatory wall-clock expiry or renewal operation.
On every request the service validates the bearer, the Agent's active state, the
selected current admitted binding, and configuration authority. No workload
certificate, SPIFFE identity, Pod identity, or caller-location proof is required.
Possession of a valid bearer authenticates the Agent; it does not bypass the
current authorization checks. Stop, deletion, explicit bearer revocation, or
withdrawal of the relevant grant denies access. Persist the bearer hash, Agent
owner, credential generation, and active/revoked state; service restart does not
revoke the bearer. Plaintext bearer recovery is never provided.

Internal leases hold one grant's upstream credential generations. Their owners are:

- `agent`: `(installationId, namespaceId, agentId)`, with the authorizing admission
  generation retained for scope checks and cleanup; no fixed session deadline.
- `installation-operation`: `(installationId, backendId, operationId, purpose)`,
  with `purpose: repository-metadata` and an absolute deadline.
- `operator-session`: `(serviceInstanceId, operatorSessionId)` in standalone mode,
  with an absolute deadline and its own opaque bearer.

Each lease retains `leaseId`, `admissionId`, `grantId`, `configurationDigest`,
`audience`, nonsecret status, and separately accounted token generations. One
Agent bearer selects only that Agent's current admitted grants; it is not an
upstream token or a grant to arbitrary repositories.

The authenticated control client exposes three lease controls:

| Operation              | Result and authority                                                                                                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openLease(admission)` | Validate committed Agent authority and return binding/status; return a new Agent bearer once when first established or explicitly replaced. Standalone returns its session bearer once. |
| `leaseStatus(leaseId)` | Owner-scoped status and cleanup counters; never bearer recovery.                                                                                                                        |
| `closeLease(leaseId)`  | Deny that grant's further use and request retirement; preserve the Agent bearer for other admitted grants. Disposal is separate.                                                        |

Agent-wide revocation uses OCC’s durable lifecycle state, not another control
RPC. Stop/delete and credential replacement follow the
[revocation contract](deployment.md#durable-bearer-verification). A separate
operator-facing revoke action is deferred.

Repository descriptions use the bounded operation below. No caller-facing
renewal or proactive refresh is added. The internal
`withCredential(leaseId, minimumValidity, use)` supplies upstream credentials only
to trusted forwarding code. The request's repository/binding selector is checked
within the authenticated Agent's admitted authority; it cannot select an issuer
or supply arbitrary scopes.

### Installation-owned repository metadata

The Installation's GitHub Backend owns description lookup and five-minute caching
by provider/repository identity. Descriptions are optional; failure never blocks
approved selection. No draft or revision is required.

OCC preserves the existing repository-options authorization: Agent `create` in
the requested Namespace, or `update` on the edited Agent. It checks repository
eligibility before fetching or returning cached data. Before external work, OCC
durably records the requesting principal, Namespace, Backend, exact approved
repositories and source grant IDs, `configurationDigest`, authorization
generation, and absolute operation deadline under an Installation-operation
admission ID. Shared caching never grants cross-Namespace visibility.

The trusted Backend calls `describeRepositories(admissionId, repositoryRefs)` on
authenticated HTTPS control with the bounded, approved repository set. Only a
caller admitted for `installation-operation` may use it; `openLease` rejects that
kind. The service compares the request with the committed record and its current
configuration, validates Backend membership and Namespace eligibility, and derives
Metadata-read authority from each source grant's GitHub issuer and exact
repository. These internal grants are not selectable Agent profiles or another
YAML registry. Only the trusted metadata adapter uses them, for
`GET /repos/OWNER/REPO` with numeric repository identity validation.

The service opens, uses, and closes Installation-owned metadata leases internally,
retaining each source `grantId` and the derived Metadata-read authority.
It returns sanitized descriptions or pending status, never lease handles, bearers,
or issuer response bodies. Retries with the same admission ID recover the same
operation's result or pending status; changing its repository set is rejected.
A retry does not dispatch a second acquisition while the original is in flight or
uncertain. Keep the existing batch bound and five-minute cache; timeout or failure
still leaves descriptions optional.

The operation and its leases last at most 30 seconds, capped by configured
`leasePolicy.maximumOperationDurationSeconds`. Leases close on completion,
failure, cancellation, or expiry.
They share provider capacity and cleanup accounting with Agent leases;
uncertain issuance retains cleanup obligations and blocks replacement. Pending
cleanup can outlive the operation deadline, without permitting more use.
Configuration or policy withdrawal invalidates them independently of Agent
lifecycle.

Installation ownership requires no new
[ServicePrincipal](../../../docs/reference/authorization.md#principals) or bootstrap
administrator credential. The Installation is not an IAM principal; the
TokenDriver authenticates to GitHub. Other internal purposes fail admission.

### Standalone admission

Standalone leases use [service-local operator admission](standalone.md), with
process-local custody and recovery limits. OCC-managed admissions remain durable;
standalone access cannot bypass them.

### Managed Agent lifecycle

See [deployment and recovery](deployment.md) for credential delivery and handover.

1. **Admit.** Preserve Agent create/update/deploy authorization and worker rechecks.
   OCC commits exact Agent grants and revision provenance. The service checks
   that record and atomically reserves the admission before returning binding
   data or a newly created bearer. Duplicate admission IDs recover status, not
   bearer material. Compute retains the Agent-owned credential artifact across
   eligible revision changes and publishes the active binding configuration.
2. **Use.** Validate the bearer and current authority before dispatch. Acquire on
   demand, reusing a sufficiently valid token or coalescing replacement into one
   attempt per internal lease. Idle leases mint nothing. Required validity covers
   the bounded exchange plus margin; the first request needing replacement pays
   issuance latency. Replacement never widens the admitted grant.
3. **Fail.** Retry only definitely safe acquisition failures with bounded delay.
   Reauthorization-required makes the grant unavailable. Uncertain issuance
   blocks acquisition except for the explicit, bounded managed-GitHub recovery
   path after predecessor fencing. Old cleanup remains unresolved even when a
   recovery attempt succeeds. Never replay an uncertain Git push or API mutation.
   Missing required authorization state denies dispatch.
4. **Change or close.** Close withdrawn or replaced grant generations before
   activating new authority. OCC commits Agent bearer revocation with the
   accepted stop/delete transition; lease cleanup proceeds separately. A later
   start needs fresh authorized
   admission and credential delivery. `CLOSED` denies new use and cancels owned
   exchanges. `DISPOSED` additionally requires settlement, revocation or proven
   expiry, and auxiliary cleanup.

Do not share token generations between leases in first delivery. Revision changes
need not rotate an otherwise valid Agent bearer, but its permissions always come
from the current active admission. Retiring a grant preserves its cleanup debt.

Unknown disposal of old GitHub tokens alone must not block Agent deployment or
activation of replacement grants. Continue to require current authorization and
confirmed termination or fencing of the old workload and any predecessor service.
Repository operations may remain unavailable while acquisition is blocked by
recovery eligibility, rate limits, or outstanding-debt caps; do not make that
credential availability a deployment or grant-handover gate. Preserve the old
obligations and accounting across handover.

Audit records contain Agent, revision provenance, admission generation, grant,
Driver, and outcome identifiers, never credentials. Per-operation and bounded
consumer deadlines retain elapsed-time checks; managed access no longer has a
session-duration clock. Upstream token expiry remains enforced.

## TokenDriver extension contract

Extract the existing custody and lifecycle outcomes from the repository-private
interface; preserve their semantics rather than replacing them with
`Promise<string>`. The proposed public shape is:

```ts
interface TokenDriver<Grant> extends Driver {
  readonly capability: "token";
  readonly replacement: "overlap" | "drain-before";
  readonly cleanup: "revocable" | "expiry-only";
  normalizeGrant(parameters: unknown): Grant;
  acquire(
    attempt: TokenAttempt<Grant>,
    previous: CredentialRef | undefined,
    minimumValidityMs: number,
  ): Promise<AcquireOutcome>;
  retire(attempt: TokenAttempt<Grant>, token: CredentialRef): Promise<RetireOutcome>;
  finalize(attempt: TokenAttempt<Grant>): Promise<FinalizeOutcome>;
  settle(outcome: OriginalOutcome): Promise<void>;
}
```

`TokenAttempt` carries the service-owned lease identity, normalized grant,
absolute operation deadline, cancellation signal, and dispatch accounting.
`CredentialRef` is service custody, not serializable bearer material. The
[existing outcomes](../../../apps/controller/src/drivers/repo/credentials/backend-contracts.ts)
distinguish acquired, rejected, reauthorization-required, not-dispatched, and
uncertain. Authentication eligibility and cleanup expiry remain separate.
The service validates outcomes and retains late completions after cancellation.

`GitHubTokenDriver` extracts acquisition and retirement from the
[existing GitHub implementation](../../../apps/controller/src/drivers/repo/github/credentials/driver.ts).
It signs an App JWT, requests a token for the exact installation/repository and
profile permissions, validates returned authority/expiry, and revokes owned
tokens. Renewal mints a replacement; it does not extend a GitHub token.
HTTP route planning and Git/`gh` authentication stay in the repository adapter.

An `OAuthClientCredentialsTokenDriver` instead exchanges its configured client
credential for a grant's fixed audience/scopes. Drivers that require durable
rotating refresh-token storage need a separate design and are outside this RFC.
Issuer endpoints come only from reviewed operator configuration, with exact HTTPS origins and
redirect restrictions; callers cannot turn the service into a URL fetcher.

Installed implementations follow the existing
[package contract](../../../docs/reference/drivers/selection.md#package-identity-and-factory-exports):
closed `configurationSchema`, semantic `validateConfiguration`, and `createDriver`.
For capability `token`, the service supplies `id`, resolved `implementation`,
configuration, custody, and clock; it supplies no platform state or IAM bypass.
Each package also exports a closed `grantSchema`; `normalizeGrant` rejects
unsupported authority and produces canonical parameters for service-side scope
checks. These normalized parameters do not create a second cross-process
configuration identity.
Public types export through the contracts package's top-level index. Packages
are reviewed, exact-version production dependencies of the service artifact,
precompiled and image-pinned; no runtime installation or hot loading. They run
with service authority, so package review remains a trust boundary.

## Persistence and recovery

Issued upstream tokens remain memory-only. Managed Agent bearer hashes, owner
bindings, revocation state, and credential generations survive service restart.
OCC grants, service reservations, issuance-attempt evidence, recovery budgets,
and terminal receipts remain durable. Do not persist raw bearers, upstream
tokens, refresh tokens, or recoverable token ciphertext in this state.

[Recovery rules](deployment.md#state-and-recovery) let the same active Agent
bearer authenticate after restart. Once the predecessor is confirmed stopped or
fenced, the next request may acquire a fresh, exactly scoped GitHub token despite
old unresolved cleanup, within persisted rate and outstanding-attempt limits.
This explicitly replaces the current blanket block on replacement for that case;
it does not prove old tokens revoked or authorize replay of the Agent's operation.
Metadata and standalone recovery remain unchanged. Other TokenDrivers remain
fail-closed until an equivalent bounded recovery contract is reviewed and proven.

## Delivery and verification

Create a separate plan after interface review. First delivery extracts the engine,
integrates `GitHubTokenDriver`, Agent-scoped bearer ownership, repository and
operator callers, and delivers the [independent service and control boundary](deployment.md)
through a published, versioned Token Service image with the bundled GitHub Driver.
Standard installation uses release packaging without requiring users to build an image.
Update references, flows, Installation parsing, and Kubernetes packaging together. Historical RFCs remain unchanged. Retire the old
configuration path when the canonical replacement ships; no compatibility shim
is proposed.

Required integration proof extends the
[regular Agent repository test](../../../tests/integration/repository-credentials-platform.test.mjs):
deploy, Git read/write and `gh` use, forced upstream-token expiry, unchanged
scope, continued managed access beyond the former session deadline, stop/delete,
and confirmed cleanup. Include real PostgreSQL competing
workers, lost admission responses, crash-after-dispatch uncertainty, expired
tokens, late completion, and authority withdrawal. Service restart must accept
the same active Agent bearer without changing client files, acquire within the
GitHub recovery limits, and preserve unresolved predecessor cleanup. Revoked
bearers must stay rejected after restart. Exercise stop/delete while Token
Service is unavailable, rejection of the old bearer when it returns, and fresh
credential delivery on a later start. Standalone restart still invalidates
its process-local bearers.
Verify no private issuer material reaches API/worker/Agent artifacts. Exercise the packaged Driver through
service composition, not a direct test-only call. Qualify actual GitHub issuance
and revocation separately with authorized disposable resources; fixtures do not
prove upstream behavior. Future Drivers need a supported consumer and equivalent
integration proof before being advertised.

Also verify metadata discovery before Agent creation, authorized cache reuse,
cross-Namespace denial, Metadata-read scope, timeout/uncertain cleanup, and no
credential delivery to API or Agent callers through the real repository-options
path.

Through the regular Agent workflow, verify duplicate-binding selection, stale
binding generations, revision replacement with an Agent-scoped bearer, rejected
destinations, and uncertain mutations. Verify stopped Agents are denied, inactive revisions never become authority,
current grants override old authority, and missing workload identity does not
prevent valid bearer authentication. Redeploy with unresolved old GitHub-token
cleanup: after fencing the old workload, activate the authorized replacement
grants while retaining that debt. Repeat with exhausted issuance limits: deployment
still completes, while repository operations report temporary unavailability.
Unknown workload or predecessor-service termination must still block handover.
Reject the removed managed `sessionDurationSeconds` setting.
Verify Git operations without OCE hooks, ordinary user-hook execution, and rejection
of removed `pushRefAllowlist` configuration.

This RFC implements no runtime behavior; validation is documentation-only.

<!-- User-approved length exception for RFC-0056: keep the configuration,
lease interface, and lifecycle decisions together for review. Deployment and
standalone details already have companions; further splitting separates the
contract from its authority and cleanup requirements. -->

## Future work

The following capabilities are outside first delivery:

- **GitHub metadata access by Namespace and user.** Add finer-grained policy for
  which repositories and metadata each Namespace or user can discover, beyond
  the IAM checks and approved repository grants required by this RFC.
- **Built-in OAuth TokenDriver.** Provide a bundled OAuth implementation with
  defined authorization, refresh, revocation, and recovery behavior. The OAuth
  package example illustrates the extension contract; it is not a shipped Driver.
- **Custom TokenDrivers.** Support authoring and operating additional Drivers
  through the package extension contract, with documented configuration,
  packaging, distribution, lifecycle requirements, and integration verification.
  First delivery defines that contract and ships the GitHub implementation; it
  does not require users to package custom Drivers or build a broker image.
- **ChatGPT service-account TokenDriver.** Define the supported service-account
  credential source, permitted consumers, and token lifecycle before adding a
  dedicated Driver.
- **Agent/workload identity on bearer-authenticated calls.** Authenticate the
  calling workload and verify that it belongs to the Agent identified by the
  bearer on each request. See the [workload-identity design considerations](deployment.md#future-workload-identity-authentication),
  including a possible move to identity-only authentication. First delivery
  continues to accept valid bearers without a workload-identity check.

## Alternatives and review decisions

- Keeping the broker GitHub-specific avoids new configuration but duplicates
  lifecycle/security work for every issuer. Extracting only a minting helper
  fails to integrate ownership, recovery, and the real Agent caller.
- A pluggable broker backend would require translating OCC authorization,
  lease, and recovery contracts into another engine. OpenShell may manage
  user-supplied credentials directly; platform-minted credentials remain
  OCE-owned and require the future trusted-service handoff, as described in
  the [FAQ](faq.md).
- Encrypted persistent custody enables token recovery after restart but adds
  storage and key management. It is excluded from this refactor.
- **Platform maintainers** should confirm the independent service, authenticated
  control and state ownership, named TokenDrivers, and private package factory. Review
  must preserve Namespace, scope, bounded-operation deadlines, and cleanup guarantees.
- Managed bearers have no mandatory expiry and are not sender-bound. A copied
  bearer can impersonate the Agent until revocation; lifecycle
  authorization still applies. [Workload identity](deployment.md#future-workload-identity-authentication)
  is deferred rather than required for this delivery.
