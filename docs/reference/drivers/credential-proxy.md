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

Credential Proxy does not replace every Credential Gateway. Existing static
Gateway-owned attachments retain their own delivery path.

## Interface

The public [contracts entry point](../../../packages/contracts/src/index.ts)
exports `CredentialProxyDriver`, `DriverRegistration`, the
[exchange types](../../../packages/contracts/src/credential-proxy-exchange.ts)
and [repository delivery types](../../../packages/contracts/src/protected-repository-git.ts).
The [Driver source](../../../packages/contracts/src/credential-proxy.ts) defines
these operations:

| Member                                      | Caller, inputs and result                                                                                                                                               | Requirement                                                                                              |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `sourceControl`                             | Admission and preparation use its Backend, sender, resolver and provider identities. `assertAvailable(signal, profile?)` checks the configured counterpart.             | Required property, not a method. Discovery alone is not installed enforcement evidence.                  |
| `bindExchange(createCredentialProxy)`       | API composition supplies a factory. Call it once with the transport's `EgressExchangeOwner`; receive only the five exchange methods. Return a binding with `close()`.   | Optional on the base interface; required to connect a request-time exchange transport.                   |
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

`repositoryGitDeliveryProfile` admits exactly one repository binding:
`git-write` maps to `repository_git`; installation profiles map to
`github_installation`. The latter requires positive counterpart confirmation;
a Driver that ignores the profile argument does not qualify. Deploy refuses any
other binding (`git-read`, `git-full`, or more than one) before reading the
counterpart, with `409 REPOSITORY_GIT_PROFILE_UNSUPPORTED`.

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
[version checks](../../../packages/contracts/src/credential-proxy.ts) implement
this support; they do not qualify stock OpenShell or any installed deployment.

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
material. The [recipient evidence checks](../../../apps/controller/src/drivers/repo/credentials/protected-repository-git-installation.ts)
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
`bindRepositoryGit` port is specifically for Git and GitHub installation delivery;
it is not a general arbitrary-provider installation API. Its `githubInstallation`
member is optional and scope-specific. `observedHook` is restricted to the
bundled version 6 preview. Do not infer support from interface membership alone.

Online request authorization does not establish exact dispatch or response
custody. Those stronger guarantees require the actual enforcing sender and
response transport. See [qualification requirements](../../testing/protected-repository-custody.md).

### Request-time capacity

The OCC [request registry](../../../packages/occ/src/credential-proxy.ts) keeps
its bounds in memory, per API process:

| Bound                                 | Limit                         | Released                                                                                                         |
| ------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Operations in progress, all Sandboxes | 1024                          | When the handle closes or expires and no authentication, installation, policy, Secret or receipt work is pending |
| Operations still authenticating       | 256, shared by all Sandboxes  | When peer verification settles; a verified request moves to its Sandbox's share                                  |
| Operations in progress, per Sandbox   | 256 (a quarter of the cap)    | When the handle closes or expires and no installation, policy, Secret or receipt work is pending                 |
| Request IDs, all Sandboxes            | 8192                          | 30 s after each ID's UUIDv7 creation time                                                                        |
| Request IDs, per Sandbox              | 2048 (a quarter of the table) | Same                                                                                                             |

A ready handle holds its operation slot until it closes or its deadline (at most
30 s) passes. Per-Sandbox shares are keyed on the verified sender and Sandbox, so
one Sandbox's traffic cannot spend another's. Before verification only an unverified
Sandbox ID is known, so that budget is global. The bundled OpenShell verification is
in memory, so the budget only bounds bursts; a Driver whose verification does I/O lets
one Sandbox hold the budget for that latency. The ID bounds allow about 270 protected
requests per second per API process, and about 68 per Sandbox. One Sandbox cannot use
the whole operation cap or ID table, but four busy Sandboxes can. A request refused
by the installation or route checks reserves no ID. From exchange capture on, its ID
stays reserved for the whole window, even if the request is refused.
Past any bound, `resolve` refuses with `unavailable`/`resolver`. The bundled
OpenShell authority also admits at most 1024 pending exchange openings and 1024
accepted exchanges.

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
