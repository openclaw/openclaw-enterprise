---
kind: reference/driver
---

# Credential Proxy Driver contract

## Overview

Implement `CredentialProxyDriver` with its paired Sandbox capability in one
Driver registration. See the [implementation walkthrough](../../contributing/credential-proxy-driver.md)
and [selection rules](selection.md#select-a-protected-sender).

OpenClaw Control Plane (OCC) owns authorization, bindings, execution identity,
expiry and withdrawal. Token Service owns acquisition, freshness, renewal,
custody and retirement for prepared credentials. For live static sources,
Credential Gateway owns the source metadata; material stays in the Namespace
Secret and OCC reads it through the Secret Driver with retention `none`.
Provider adapters define scope, injection and response rules.

Ordinary sources use Credential Gateway where Installation policy permits.
Selecting a Proxy does not migrate them. Protected sources and repository
bindings require Proxy admission and cannot fall back to Gateway.
Installation policy can also require protected admission for an empty plan.

## Interface

The public [contracts entry point](../../../packages/contracts/src/index.ts)
exports the [Driver](../../../packages/contracts/src/drivers/credential-proxy/index.ts),
`DriverRegistration`, [exchange types](../../../packages/contracts/src/credential-proxy-exchange.ts)
and [repository delivery types](../../../packages/contracts/src/protected-repository-git.ts).

| Member                                      | Requirement                                                               | Contract                                                                                                                                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capability`                                | Required                                                                  | Literal `"credential_proxy"`.                                                                                                                                                                  |
| `sourceControl`                             | Required property                                                         | Supplies Backend, sender, resolver and provider identities. `assertAvailable(signal, profile?)` checks the configured counterpart.                                                             |
| `bindExchange(createCredentialProxy)`       | Required for request-time exchange transport                              | The API supplies a factory that takes an `EgressExchangeOwner` and returns strict exchange and optional request-credential methods. Return a binding with `close()`.                           |
| `bindRepositoryGit(authority)`              | Required for selected protected Git, alongside Sandbox `repositoryAccess` | The worker supplies `ProtectedRepositoryGitAuthority`. Return a binding with `close()`.                                                                                                        |
| `configureRevision(context)`                | Required                                                                  | Given the Namespace, revision, plan and signal, return `ProxyWiring` with the exact admitted plan and nonsecret Sandbox configuration.                                                         |
| `wiringStatus(context, prepared)`           | Required                                                                  | Return authenticated `EgressInstallation` evidence or `undefined`.                                                                                                                             |
| `verifyInstallation(context, installation)` | Required                                                                  | Recheck the exact evidence with the counterpart before release, including after OCC records custody.                                                                                           |
| `removeRevision(context)`                   | Required                                                                  | Remove the owned installation and return whether cleanup completed.                                                                                                                            |
| `policyReduction`                           | Required when admitted                                                    | Apply and independently observe a versioned reduction.                                                                                                                                         |
| `requestTimeCredentials`                    | Required for online model admission                                       | Check counterpart availability with `assertAvailable(signal)` and reobserve the authenticated recipient and retained fence with `verifyRequestInstallation(context, installation, recipient)`. |

Capabilities marked as required for a particular admission or transport are
optional on the base interface. OCC withdraws bindings through the admitted
`policyReduction` capability or runtime retirement. Reduction compares the
registration, execution, recipient and policy generation and can only remove
access. Persist operation identity and tombstones so stale configuration or
enrollment cannot restore routes. An empty retained plan enforces deny-all.

### Delivery profiles

`repositoryGitDeliveryProfile` maps a nonempty set of `github-repository`
bindings to `github_repository`, one `git-write` binding with its ref
restrictions to `repository_git`, and one installation binding to
`github_installation`. Mixed profiles, multiple legacy bindings and standalone
`git-read` or `git-full` yield `409 REPOSITORY_GIT_PROFILE_UNSUPPORTED`
if they reach protected admission.

For bundled OpenShell, the first two profiles require a pre-credential request
binding and authenticated denial of the held launcher request before release.
Installation scope requires preview opt-in and positive counterpart confirmation.

Admission v2 is unprotected. V3 admits strict request-time routes with reduction
v1 when selected. For Git, `repositoryGitAuthorization` distinguishes exact
dispatch (v4), `online-request` (v5), `request-hook-observed` (v6) and
unavailability. V6 is a bundled installation preview with per-start hook
evidence. Startup observation leaves later operator disablement possible.
V7 adds verified reduction v2 to exact dispatch. Its `assertAvailable` must
confirm counterpart support. It allows independently admitted routes alongside
Git and can remove Git while preserving the exact recipient and other bindings.
Existing v3–v6 records retain their guarantees.
Admission support does not qualify stock OpenShell or an installed runtime.
See the [admission source](../../../packages/occ/src/index.ts).

### Online model requests

`CreateCredentialSourceInput` has no `authorization` field. OCC selects the
eligible provider using the source type and Installation policy. When policy
retires a matching provider, exactly one eligible provider must remain.
`CredentialProviderDefinition.authorization` defines that provider's enforcement
semantics. The source retains its provider ID and generation; the Agent
revision's `ProxyPlan.authorization` records the admitted profile. Deployment still requires explicit protected execution
admission and source `operate` permission for the operator and Agent.

Bundled `openai-online-request` generation 1 requires native IAM for the same
OCC state and a dedicated Codex HTTPS Responses route. Body-scoped authorization
checks the admitted model and rejects provider-hosted tools. V8 admits this model
route. V9 adds independently authorized online Git with a separate binding,
approval, session and registry.
Both versions refuse `policyReduction`. Withdrawing Git standing approval
denies fresh Git requests and can retire the runtime. Removing either binding
can stop or redeploy it. Installed proof that model-source IAM denial preserves
authorized Git remains pending. See [repository standing approval](../../guides/repository-credentials.md#keep-git-access-on-the-same-running-agent)
and [installed model qualification](../../guides/credential-proxy/model-requests.md).

Setting `drivers.credential_proxy.configuration.endpointOnly` selects
endpoint-only authorization for a single dedicated Codex Agent and bound
CredentialSource by `agentId` and `sourceId` on deployment. This profile requires the signed OpenShell
supervisor identity and an approved HTTPS origin, `POST /v1/responses`, an empty
query and approved headers visible to the hook. Header names must be unique.
If the Codex Responses Lite header is present, its value must be exactly `true`.
OpenShell can exclude headers
such as `Cookie` from the hook's view. Apply any required filtering for
hidden headers before the hook or at the upstream provider. OpenShell sends zero payload bytes to the mandatory
`HTTP_REQUEST` hook at `PRE_CREDENTIALS`. On approval, OCC returns
`continue_without_body`. OCC receives neither request nor response body.
The upstream provider enforces model, tool, storage and body rules. OCC still
checks the current revision, binding and IAM and requires one-use redemption
with `cache_ttl: 0`. Other bindings, including other Agents using the same
CredentialSource, use the body-scoped unary hook.
OpenShell's unary transport caps requests at 4 MiB, and OCC authorization
caps the inspected body at 1 MiB. See the
[endpoint-only setup](../../guides/credential-proxy/model-requests.md#enable-endpoint-only-authorization).

The API verifies the live recipient against the opaque `requestConfigurationId`.
OpenShell binds the full policy, model provider and profile, and Sandbox and
process identities. Only `provider_env_revision` is excluded from the stored
admission and configuration hashes. Current observations must agree on that
epoch too. The worker verifies Git custody at installation. Missing or changed
model evidence refuses release.

`authorizeRequestCredential` checks policy for the captured request and
reserves its replay ID. The transport must accept the affirmative decision
before OCC commits a redeemable, nonsecret approval. If acceptance fails,
only the reservation remains. After acceptance, cancellation or an uncertain
commit can interrupt delivery. The approval may still be redeemable. The
transport cannot turn acceptance into a denial. After an acknowledged commit,
OCC returns the accepted decision even if Driver selection changes.

`resolveRequestCredential` independently authenticates the redeemer, consumes
the exact recipient, request and binding approval once, and rechecks current
authority in `READ COMMITTED`. The final Secret read under the Namespace
rotation lock must match the version, identity and value of two outside-lock
observations. External Secret writers do not share that lock. Withdrawal blocks
pending redemption. An already released request may finish.

Database admission caps the approval at 30 seconds. Replay IDs stay reserved
through the authenticated horizon, at least the approval deadline and at most
one hour from admission. Callers subtract monotonic elapsed time since resolver
invocation from `releaseLifetimeMs` and enforce `usableUntil`. Those limits
bound material release. Provider key lifetime is independent.
Required middleware and `cache_ttl: 0` prevent reuse. The supervisor injects
the key, the guest gets a placeholder and Gateway retains only metadata.
This profile grants online authorization. Exact dispatch and response custody
require a different transport guarantee. See the [release boundary](../../flows/credential-source-egress/model-requests.md#3-redeem-once-against-current-authority).

## IAM

OCC authorizes the exact resource operation through selected IAM. The transport
authenticates its peer and captures the actual request and response destination.
Refuse missing or stale authority. Workload headers and cached allow decisions
cannot establish exchange ownership, execution, recipient or response custody.

Keep material in the trusted resolver, sender or verified recipient and out of
workload configuration, logs, receipts and public status. Workloads receive safe
references or markers. A material read permits receipt or installation only.

## Lifecycle

### Registration and execution release

API and worker construct the selected registration and compare its durable
identity and configuration digest with the plan. Capability objects carry the
selected `id`, `implementation` and literal `capability`. Shared hooks and
`close()` belong to the registration. The paired Sandbox supplies provisioning,
enrollment, endpoint and status methods. Compute requires current authenticated
evidence and fresh Sandbox enrollment before startup release. In v6, Compute
can hold the launch during installation and must verify the policy and same
recipient again before release. See the [execution flow](../../flows/credential-source-egress.md#1-admit-source-and-install-the-revision-plan).

Evidence binds the exact plan, execution, sender, Sandbox, enforcement instance,
configuration and policy hash with `authorityScope: "execution"`. Protected
static inference includes sibling processes in that execution. Exact dispatch
requires a peer key. Online Git requires its declared recipient evidence,
including provider, attachment epoch, process and network identities.
Discovery, successful configuration and stored custody cannot substitute for
a live check or prove absence of a bypass.

The provider derives routes from the saved Harness configuration and current
source. A route mismatch refuses delivery, send or refresh. Source registration
does not choose the inference destination. See the [model provider contract](kubernetes-compute/model-provider.md).

### Request-time exchange

`EgressExchangeOwner.verify`, `capture` and `owns` establish live transport
custody. `resolve` returns eligible material evidence and injection headers,
`ready_without_material` or a refusal. `authorizeSend` separately rechecks
the version and request. Match request and injection digests and enforce
`sendStartBy` at the last controlled send boundary.

`beginResponse` and `renewResponse` remain bound to that exchange.
`protectResponse` processes the complete response, including trailers, and
`undefined` releases none. Only positive provider evidence identifies a
rejected version. Never switch versions and replay the request.

A provider can report a stable classification rule ID (1–255) without
encoding request data or reassigning IDs. OCC audits `classificationRule`
only when no operation matches and exactly one refused route reports a valid
ID exactly once. The audit binds the authenticated execution, source and request
without reading credentials. The wire refusal stays generic. See the [exchange flow and diagnostics](../../flows/credential-source-egress.md#debugging-and-verification).

### Installed material

For repository delivery, use `recipients.observe` for the live installation
fence and `readMaterial` for committed material. An `undefined` or `absent`
result supplies no credential. `withdrawn` and `unprepared` are distinct absence
reasons. Never issue on a request miss. `beginInstall` and `confirmInstall` carry the exact
`preparationAttemptId` and `materialVersion`, including through renewal.
Confirm only after independently observing both at the same recipient.
See the [recipient evidence checks](../../../apps/controller/src/drivers/repo/access/protected-repository-git-installation.ts).

Call `authorize` once for the captured request and installed version. An
exact permit binds the exchange, digest and material to an exclusive
`sendStartBy`. Check it before connecting and again before writing if setup
took time. Online authority requires delivery of the allow by `replyBy`.
Either decision can leave delivery and provider effects unknown. An authorized
online request may finish after withdrawal.

### Cancellation, retries and uncertainty

Propagate cancellation and absolute deadlines. Inspect owned state before
another mutation. Preserve pending writes and operation identities across
restarts, including possible use after a lost commit acknowledgment. An
uncertain installation or authorized exchange cannot be replayed, renewed or
adopted as success. Fence a replaced owner and independently observe the
recipient before reconciliation. Reduction observation is read-only.
Withdrawal denies fresh authority and leaves existing provider effects intact.

## Limits

Protected release currently uses bundled Kubernetes Compute. The repository
port serves Git, selected GitHub repository sets and the installation preview.
`githubRepository` and `githubInstallation` are optional scope-specific
members. `observedHook` is restricted to bundled v6.
See the [custody qualification requirements](../../testing/protected-repository-custody.md).

### Request-time capacity

Set `drivers.credential_proxy.requestCapacity` beside `id` and
`configuration`. Operations and strict exchange IDs are per API process.
Online model replay quotas are shared across API processes.

| Field                      | Scope                                       | Default                  | Maximum | Release                                                                                                      |
| -------------------------- | ------------------------------------------- | ------------------------ | ------- | ------------------------------------------------------------------------------------------------------------ |
| `operations`               | All in-progress operations                  | 1024                     | 8192    | After the handle closes or expires and authentication, installation, policy, Secret and receipt work settles |
| `authenticatingOperations` | All authenticating operations               | ¼ of `operations` (256)  | 8192    | When verification settles. Verified requests move to their Sandbox share                                     |
| `sandboxOperations`        | In-progress operations per verified Sandbox | ¼ of `operations` (256)  | 8192    | After the handle closes or expires and installation, policy, Secret and receipt work settles                 |
| `requestIds`               | All request IDs                             | 8192                     | 131072  | UUIDv7 creation + 30 s (strict) or authenticated replay horizon (online model)                               |
| `sandboxRequestIds`        | Request IDs per Sandbox                     | ¼ of `requestIds` (2048) | 131072  | Same horizon as `requestIds`                                                                                 |

Values are integers from 1 to the maximum. Shares cannot exceed their pool.
Omitted shares round down to at least 1. Invalid values and unknown fields fail
startup and upgrade checks with `DRIVER_CONFIGURATION_INVALID`. An operation
can hold a 1 MiB body, or about 8 GiB of bodies at maximum concurrency.
Restart API Pods to apply changes.

Handle deadlines are at most 30 seconds. Authentication charges the global
pool before Sandbox verification. Incomplete HTTPS grants have 32 listener
slots and a five-second deadline. gRPC verification and complete grants share
the authentication budget. A canceled final Secret read releases policy locks
while retaining capacity until settlement.

Replay reservations survive refusal and, for online models, revision deletion.
Database time governs online admission, retention and redemption. Quota
contention retries within the original deadline after releasing policy locks.
Strict defaults sustain about 270 requests/s per process and 68 per Sandbox.
Four busy Sandboxes can exhaust the pool with default shares.

Strict `resolve` refuses capacity with `unavailable`/`resolver`. Bundled
OpenShell allows 1024 pending exchange openings and 1024 online Git decisions,
each capped at 256 per Sandbox, plus 1024 accepted exchanges. It refuses
excess Git decisions with `online_authorization_denied` and excess model
middleware requests. Token authentication saturation returns HTTP 503.

## Troubleshooting

Check live counterpart evidence for missing wiring, and current authority and
Token Service readiness for missing material. For pending effects after restart,
inspect the original operation before mutating. See the [diagnostic flow](../../flows/credential-source-egress.md#debugging-and-verification).

## Implementations

See the [Sandbox reference](openshell-sandbox.md) for bundled OpenShell limits.
Installed packages can provide the paired capabilities. Selection alone does
not qualify an installation.

## Related

- [Implement a Credential Proxy Driver](../../contributing/credential-proxy-driver.md)
- [Protected credential request flow](../../flows/credential-source-egress.md)
- [Static exchange verification](../../testing/static-egress.md)
- [Repository and response custody qualification](../../testing/protected-repository-custody.md)
