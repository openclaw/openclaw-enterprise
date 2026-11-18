---
kind: reference/driver
---

# Credential Proxy Driver contract

## Overview

`CredentialProxyDriver` connects a selected enforcing transport to OpenClaw
Control Plane (OCC). Implement it with the paired Sandbox capability in one
Driver registration. Start with the [implementation walkthrough](../../contributing/credential-proxy-driver.md)
and [selection rules](selection.md#select-a-protected-sender).

OCC owns authorization, access bindings, execution identity, access expiry and
withdrawal. Token Service owns credential acquisition, freshness, renewal, material
custody and retirement. Provider adapters own provider-specific scope, injection
and response rules. The proxy enforces requests and obtains eligible material;
it does not run a credential renewal loop.

Selecting Credential Proxy does not adopt ordinary sources into protected delivery.
New and existing ordinary sources use Credential Gateway. Protected sources and
repository bindings require Proxy admission; an Agent with neither needs no Proxy
plan. An unavailable Proxy never permits Gateway fallback for a protected source.

## Interface

The public [contracts entry point](../../../packages/contracts/src/index.ts)
exports `CredentialProxyDriver`, `DriverRegistration`, the
[exchange types](../../../packages/contracts/src/credential-proxy-exchange.ts)
and [repository delivery types](../../../packages/contracts/src/protected-repository-git.ts).
The [Driver source](../../../packages/contracts/src/drivers/credential-proxy/index.ts) defines
these operations:

| Member                                      | Caller, inputs and result                                                                                                                                               | Requirement                                                                                              |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `sourceControl`                             | Admission and preparation use its Backend, sender, resolver and provider identities. `assertAvailable(signal, profile?)` checks the configured counterpart.             | Required property, not a method. Discovery alone is not installed enforcement evidence.                  |
| `bindExchange(createCredentialProxy)`       | API supplies a factory for `EgressExchangeOwner`; receive exchange and optional request-credential methods. Return a binding with `close()`.                            | Optional on the base interface; required to connect a request-time exchange transport.                   |
| `bindRepositoryGit(authority)`              | Worker composition supplies `ProtectedRepositoryGitAuthority`; return a binding with `close()`.                                                                         | Optional; required for selected protected repository delivery, together with Sandbox `repositoryAccess`. |
| `configureRevision(context)`                | Compute preparation supplies Namespace, revision, admitted plan and cancellation signal. Return `ProxyWiring` with that exact plan and nonsecret Sandbox configuration. | Required. Cannot broaden the admitted plan.                                                              |
| `wiringStatus(context, prepared)`           | Compute observes the prepared installation. Return authenticated `EgressInstallation` evidence or `undefined`.                                                          | Required. An accepted configuration request is not sufficient evidence.                                  |
| `verifyInstallation(context, installation)` | Compute rechecks the counterpart before release, including after recording custody. Return whether the exact evidence remains valid.                                    | Required. A stored receipt is not a readiness lease.                                                     |
| `removeRevision(context)`                   | Revision cleanup removes the owned installation and returns a boolean completion result.                                                                                | Required; failure must not be reported as completed cleanup.                                             |
| `policyReduction`                           | Withdrawal uses versioned `apply(context, reduction)`, then independent `observe(context, reduction)`.                                                                  | Optional on the interface; required when the plan records that capability.                               |

There is no `withdrawBinding` member in the current interface. Use OCC withdrawal
and the admitted `policyReduction` capability, or runtime retirement, rather than
adding a call under that older name. A reduction compares the registration,
execution, recipient and policy generation. It cannot create, replace or expand
access. Persist its operation identity and reduction tombstones so stale
configuration or enrollment cannot restore removed routes. An empty retained
route set must still enforce deny-all.

### Delivery profiles

`repositoryGitDeliveryProfile` maps a nonempty set of `github-repository`
bindings to `github_repository`. All members must have that profile. One
`git-write` binding maps to `repository_git` and keeps its ref restrictions.
One installation binding maps to `github_installation` and requires positive
counterpart confirmation. Mixed profiles, multiple legacy bindings, and standalone
`git-read` or `git-full` do not qualify for protected delivery. If a resolved
selection reaches protected admission without a supported profile, deploy returns
`409 REPOSITORY_GIT_PROFILE_UNSUPPORTED`.

For bundled OpenShell, `github_repository` and `repository_git` require a
mandatory pre-credentials request binding. Before release, OCE verifies the
registration and an authenticated denial for the held launcher request.
Installation-wide access still requires its separate preview opt-in.

`repositoryGitAuthorization` distinguishes exact dispatch, `online-request`,
`request-hook-observed` and unavailable. Admission versions 4, 5 and 6 preserve
these different guarantees. Version 3 covers protected request-time routes.
Version 6 is an explicitly admitted bundled preview for installation scope,
with per-start hook evidence. A hook observed at startup
does not prove that an operator cannot later disable it.

Version 7 adds verified Git policy reduction to **exact dispatch**. A capable
Driver supplies `policyReduction.version: 2` and positively verifies counterpart
support with `assertAvailable`. Admission can then combine repository Git with
independently admitted routes. Reduction can remove Git while preserving the exact
recipient and other bindings. It does not convert v5 online authorization or v6
observed hooks to exact dispatch. Existing v3–v6 admissions keep their semantics.
The [admission source](../../../packages/occ/src/index.ts) and
[version checks](../../../packages/contracts/src/drivers/credential-proxy/index.ts) implement
this support; they do not qualify stock OpenShell or any installed deployment.

### Online model requests

Omitted `authorization` uses the Installation's exact default for an eligible new model
source, if configured; otherwise ordinary Gateway or strict admission applies. Explicit
`authorization: "online-request"` selects an offered online provider. Retained sources and
revisions keep their provider ID, generation and profile. Driver execution admission remains explicit. Bundled
`openai-online-request` generation 1 requires same-state native IAM and one dedicated
Codex HTTPS Responses route, an explicit model and no provider-hosted tools.

`ProxyPlan.authorization` records the profile. Version 8 admits the model route.
Version 9 also requires separately authorized Git. The optional `requestTimeCredentials` provides
`assertAvailable` and `verifyRequestInstallation(context, installation, recipient)`.
The API checks the recipient against the persisted opaque `requestConfigurationId`.
OpenShell binds the full policy, model provider/profile and Sandbox/process identities.
Only `provider_env_revision` is excluded from stored admission/configuration hashes;
every read still requires current observations to agree, including that epoch.
The worker verifies Git custody at installation. The API refuses model releases
when retained evidence changes or disappears.

Git uses its own binding, approval, session and registry. Version 9 refuses
`policyReduction`. Removing [standing approval](../../guides/repository-credentials.md#keep-git-access-on-the-same-running-agent)
denies fresh Git requests and can retire the runtime. Removing either binding can
stop or redeploy execution. Installed proof that model-source IAM denial preserves
authorized Git remains pending.

`authorizeRequestCredential` commits the transport's accepted decision as a
nonsecret single-use approval. `resolveRequestCredential` authenticates redemption, consumes
approval and rechecks authority in `READ COMMITTED`. Two outside-lock
Secret observations must match the final read under the Namespace rotation lock;
external writers are uncoordinated. See the [release boundary](../../flows/credential-source-egress/model-requests.md#3-redeem-once-against-current-authority).

Approvals last at most 30 seconds from database admission. Callers deduct
monotonic time elapsed since resolver invocation from `releaseLifetimeMs` and
enforce `usableUntil`; these deadlines apply to approval, not key expiry.
Required middleware and `cache_ttl: 0` prevent reuse. The supervisor injects the
key; the guest gets a placeholder and the Gateway retains only metadata.
Withdrawal blocks pending redemption; already released requests may finish.
This profile gives neither exact dispatch nor response custody.
See [setup and installed qualification](../../guides/credential-proxy/model-requests.md).

## IAM

OCC authenticates and authorizes the exact resource operation through selected
IAM. The transport authenticates its peer and captures the actual request and
response destination. Workload headers cannot select the exchange owner,
execution, recipient or response custody. Refuse missing or stale authority;
do not substitute a cached allow decision.

Material stays in the trusted resolver, sender or verified recipient. Workload
configuration receives safe references or markers, not issuer inputs or provider
tokens. Keep material out of logs, receipts and public status. A material read
permits receipt or installation only; it does not authorize an upstream send.

## Lifecycle

### Registration and execution release

API and worker each construct one registration from the selected package and
configuration. Capability objects carry their selected `id`, `implementation`
and literal `capability`; shared hooks and `close()` belong to the registration.
OCC records its configuration digest in the plan and compares the durable
identity across processes and restarts.

[ProtectedExecutionDriver](../../../apps/controller/src/drivers/compute/protected-execution-driver.ts)
checks ownership, configures the plan, observes wiring, records installation
custody, verifies it again, then enrolls the Sandbox with a fresh startup
challenge. Release requires current committed evidence. Protected execution also
requires Sandbox provisioning, enrollment, endpoint and status methods.
In the bundled v6 preview, Compute may record and verify installation, then hold
the execution while material is installed. Only a later pass that verifies policy
and the same recipient may sign the startup release.

Evidence includes the exact execution and plan, sender, Sandbox, enforcement
instance, configuration and policy hash, with `authorityScope: "execution"`.
For protected static inference, the principal is the whole admitted execution,
including sibling processes; another execution of the same Agent cannot inherit it.
Exact-dispatch profiles require a peer key; online repository profiles instead
require their declared recipient authorization evidence. Repository delivery
also binds provider, attachment epoch, process and network identities. These
fields must describe authenticated backend observations. Matching names or a
shared registration do not prove no-bypass networking.

Provider `routes` receives the resolved revision Harness configuration during
admission. Request-time authority calls the same provider with the saved settings
and current source, then compares the requested route with that result. A mismatch
refuses credential delivery, send authorization, or refresh. Source registration
never chooses the Agent's inference destination. See the [model provider contract](kubernetes-compute/model-provider.md).

### Request-time exchange

[API binding](../../../apps/controller/src/composition/egress-authority.ts)
exposes `resolve`, `authorizeSend`, `beginResponse`, `renewResponse` and
`protectResponse`. `EgressExchangeOwner.verify`, `capture` and `owns` must bind
live transport custody, not just stored IDs.

`resolve` returns eligible material evidence and injection headers, an explicit
`ready_without_material`, or a refusal. `authorizeSend` rechecks the selected
version and request and returns a deadline-bound decision. Match request and
injection digests and enforce `sendStartBy` at the last controlled send boundary.
Do not treat resolution as send permission.

A provider's `classify` may synchronously report one stable rule ID (1–255) through
its optional refusal callback. IDs must not encode request data or be reassigned.
OCC records `classificationRule` only when no operation matches and exactly one
refused route reports a valid ID. Accepted operations, missing or repeated reports,
and ambiguous diagnostics provide no rule. The audit binds the authenticated
execution, source and exact request ID without inventing an operation or accessing
credentials. Interpretation belongs to the selected provider; the wire refusal
remains generic. See the [diagnostic flow](../../flows/credential-source-egress.md#debugging-and-verification).

Response acceptance and lease renewal remain bound to that exchange.
`protectResponse` processes the complete response, including trailers; an
undefined result must release no response. Positive provider rejection evidence
identifies the rejected version; an HTTP status alone does not. Do not switch
credentials and replay the request. See the [request flow](../../flows/credential-source-egress.md)
for transaction and response ordering.

### Installed material

For repository delivery, call `recipients.observe(installation)` to obtain the
current installation fence. Use the selected authority's `readMaterial(route,
signal)` to read committed material. `undefined` or an `absent` result provides
no credential; `withdrawn` and `unprepared` are distinct absence reasons.
The request path must not issue a token to fill a miss.

Before installation, call `recipients.beginInstall(route, version)` with both
`preparationAttemptId` and `materialVersion`. Independently verify that exact
version at the same recipient before `confirmInstall(pending)`. Preserve the
pair through renewal. A replacement process must re-observe the recipient;
a lost installation or confirmation remains pending and cannot be replayed or
adopted as success. OCC stores fences and delivery facts; Token Service stores
material. The [recipient evidence checks](../../../apps/controller/src/drivers/repo/access/protected-repository-git-installation.ts)
require installed state and the exact attempt/version for use.

Call `authorize` once for the captured request and installed version. An exact
permit binds exchange, request digest and material, with an exclusive
`sendStartBy`. Check before connection and before writing if setup took time.
The `online` authority instead returns `replyBy`: deliver the allow by that
boundary. An already authorized online request may finish after withdrawal.
Neither decision proves delivery or the provider outcome.

### Cancellation, retries and uncertainty

Pass context/read/request signals to backend operations and preserve absolute
deadlines across transport delays. Cancellation is not proof of remote rollback.
The base revision methods do not define a universal timeout or retry policy;
backend reconciliation must inspect owned state before another mutation.
Never retry or renew an uncertain installation or authorized business exchange.
A lost commit acknowledgment can leave possible use recorded. Preserve pending
writes and their original operation identities across restarts. Fence a replaced
worker or recipient before reconciliation; a new owner must independently observe
the current installation. A failed read is not proof that a write failed.

Reduction observation is read-only: it cannot repair or resend a mutation.
Withdrawal blocks fresh authority but does not undo provider effects or retract
an already authorized request. Credential retirement remains Token Service work.

## Limits

Protected release currently uses bundled Kubernetes Compute. The repository
`bindRepositoryGit` port supports Git, selected GitHub repository sets and the installation preview;
it is not a general arbitrary-provider installation API. Its `githubRepository` and
`githubInstallation` members are optional and scope-specific. `observedHook` is restricted to the
bundled version 6 preview. Do not infer support from interface membership alone.

Online request authorization does not establish exact dispatch or response
custody. Those stronger guarantees require the actual enforcing sender and
response transport. See [qualification requirements](../../testing/protected-repository-custody.md).

### Request-time capacity

Set `requestCapacity` beside the Driver's `id` and `configuration`. Operations
and strict exchange IDs are per API process. Online-model ID quotas are shared:

```yaml
drivers:
  credential_proxy:
    id: openshell-egress
    configuration: # unchanged: the selected Driver's own settings
    requestCapacity:
      operations: 1024
      authenticatingOperations: 256
      sandboxOperations: 256
      requestIds: 8192
      sandboxRequestIds: 2048
```

| Field                      | Bound                                 | Default                   | Maximum | Released                                                                                                         |
| -------------------------- | ------------------------------------- | ------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------- |
| `operations`               | Operations in progress, all Sandboxes | 1024                      | 8192    | When the handle closes or expires and no authentication, installation, policy, Secret or receipt work is pending |
| `authenticatingOperations` | Operations still authenticating       | A quarter of `operations` | 8192    | When peer verification settles; a verified request moves to its Sandbox's share                                  |
| `sandboxOperations`        | Operations in progress, per Sandbox   | A quarter of `operations` | 8192    | When the handle closes or expires and no installation, policy, Secret or receipt work is pending                 |
| `requestIds`               | Request IDs, all Sandboxes            | 8192                      | 131072  | Strict: UUIDv7 creation + 30 s; online model: authenticated replay horizon                                       |
| `sandboxRequestIds`        | Request IDs, per Sandbox              | A quarter of `requestIds` | 131072  | Same                                                                                                             |

Each value is an integer from 1 to its maximum. Omitted shares default to a
quarter of their pool, rounded down to at least 1. Oversized shares and unknown
fields fail startup and upgrade checks with `DRIVER_CONFIGURATION_INVALID`.
An operation can hold a 1 MiB body, or about 8 GiB at maximum concurrency.
Size the API Pods accordingly and restart them to apply changes.

An operation slot covers the handle until closure or deadline (at most 30 s)
and any pending work until settlement. Verified sender and Sandbox identities
determine each Sandbox share. Authentication uses the global budget before
verification. Incomplete HTTPS grants have 32 listener slots and a five-second
deadline. gRPC verification and complete grants share the authentication lease.
A canceled final Secret read releases policy locks and retains capacity until settlement.

Online reservations retain recipient/request IDs until the authenticated replay
horizon, even after revision deletion. Database time governs admission,
retention and redemption. Quota contention retries within the original deadline
after releasing policy locks. A reservation becomes redeemable only after the
transport accepts the decision and OCC commits the approval.
Strict ID maps and operation caps remain per process.

Strict defaults allow about 270 requests/s per process and 68 per Sandbox
(`requestIds / 30` and `sandboxRequestIds / 30`). Captured IDs stay reserved after
refusal. With default shares, four busy Sandboxes can exhaust the pool.
Strict `resolve` refuses with `unavailable`/`resolver` at capacity. Bundled OpenShell
allows 1024 pending exchange openings and 1024 online Git decisions, with 256
per Sandbox for each, plus 1024 accepted exchanges. It refuses excess Git
decisions with `online_authorization_denied` and excess model middleware requests.
Token authentication saturation returns HTTP 503.

## Troubleshooting

- No wiring evidence: inspect the authenticated counterpart and exact plan; do
  not manufacture a receipt from desired configuration.
- Material unavailable: check live authority and Token Service readiness. Do not
  bypass the fence, use a rejected version or acquire on the request path.
- Restart with pending installation or send: retain the unknown outcome and
  inspect its original owner. Do not repeat the operation to obtain a reply.

## Implementations

Bundled OpenShell has profile-specific limits in its
[Sandbox reference](openshell-sandbox.md). Installed packages can provide the
paired capabilities through the shared contract; selection is not production
qualification.

## Related

- [Implement a Credential Proxy Driver](../../contributing/credential-proxy-driver.md)
- [Protected credential request flow](../../flows/credential-source-egress.md)
- [Static exchange verification](../../testing/static-egress.md)
- [Repository and response custody qualification](../../testing/protected-repository-custody.md)
