# Agent identity interfaces

[Overview](../basic-agent-identity-mvp.md) · [Architecture](architecture.md) · [Security](security.md)

These internal contracts distinguish pinned main, separate suppliers, and proposed
extensions. Their definitions establish neither connected producers nor installed
enforcement. They introduce no HTTP endpoints.

## Execution and registration

**Pinned-main source:** [Agent, AgentRevision, ServicePrincipal, and IAMDriver](https://github.com/openclaw/openclaw-enterprise/blob/e9766f35a25afa240ee109b41a6ef821fb68687e/packages/contracts/src/index.ts)
retain existing ownership. The Agent's immutable Namespace-scoped ServicePrincipal
survives revisions. `IAMDriver.lookupIdentity(input: IdentityLookup)` returns
`Promise<Identity | undefined>`, and `authorize(request: AuthorizationRequest)`
returns `Promise<AuthorizationDecision>`. An identity lookup is not permission.
`IdentityLookup` carries scope and either `issuer`/`subject` or a mutually
exclusive `servicePrincipalId`. The latter requires prior credential verification
or authorized credential management. `AuthorizationRequest` carries `principalId`,
`action`, and the exact `ResourceRef`. The decision contains `allowed`, `reason`,
`driverId`, and evidence with optional `identityId` and arrays of group, binding,
role, and restriction IDs. These source methods are internal IAM boundaries.
Actual OCC admission and identity resolution must be extended for verified Agent
execution. The [historical admission path](https://github.com/openclaw/openclaw-enterprise/blob/724dcb5cb80b5e76a62e8267a21185a2e91a85c2/apps/controller/src/index.ts#L1257-L1325)
accepts human sessions and non-Agent API keys.

[ComputeDriver](https://github.com/openclaw/openclaw-enterprise/blob/e9766f35a25afa240ee109b41a6ef821fb68687e/packages/contracts/src/index.ts#L714-L745)
owns `prepareRevision(revision, context?)`, optional `activateRevision(revision,
context?)` and `deactivateRevision(revision)`, plus `stopRevision(revision)` and
`retireRevision(revision)`. Preparation returns `ComputeReadiness`, containing
scope, Namespace, Agent, revision, and `ready`. [Newer main](https://github.com/openclaw/openclaw-enterprise/blob/12fddc4805a1b090331af363ad10bf3b58ea5897/packages/contracts/src/index.ts#L680-L691)
adds `warnings?: readonly PluginDeploymentWarning[]`, containing only admitted
`pluginId` and `code: "PLUGIN_INSTALL_FAILED" | "PLUGIN_AUTH_REQUIRED"`.
[Warnings accompany `ready: true`](https://github.com/openclaw/openclaw-enterprise/blob/12fddc4805a1b090331af363ad10bf3b58ea5897/docs/reference/drivers/compute.md#L66-L80)
only after failed selections are safely disabled and remaining readiness checks
pass. Required protected capabilities cannot degrade into optional warnings.
Other lifecycle methods return `Promise<void>`. `ComputeRevisionContext` contains
resolved Harness authentication and secret-environment projections. Readiness,
warnings, and void stop results establish neither verified execution,
current-serving authority, nor physical termination.

**Proposed execution contract:** State/Compute retain an opaque assignment
reference, generation, exact Agent/revision/principal/component, observed
incarnation, original lifetime, and current/retired state. Only independent Compute
observation can bind it. Retirement is terminal. The separately defined
[RuntimeAssignmentRecordV1 and target](https://github.com/openclaw/openclaw-enterprise/blob/f6f47f967a3c480dd7c7770072cd8a806978596d/packages/contracts/src/runtime-authority-v1.ts)
retain Installation/Namespace/Agent IDs, assignment and create-effect references,
lifecycle/runtime generations, revision, component, profile references, binding,
and assignment-record version. Their source states are `allocated`, `bound`,
`identity-ready`, `active`, `retiring`, `retired`, and `abandoned`. These supplier
labels do not replace authoritative serving selection. The supplier component
union is `gateway | harness`. It does not select the proposed relay's exact peer
mapping, which remains an identity/egress owner decision. API resource IDs retain
their [existing prefixed UUID schemas](https://github.com/openclaw/openclaw-enterprise/blob/e9766f35a25afa240ee109b41a6ef821fb68687e/packages/contracts/src/api/common.ts).

Registrar create/readback/delete remains a required owner contract without a
selected OCE wire schema. The registrar authenticates separately and may create
only the assigned identity under the operator-selected trust domain and SPIRE
parent. Derive selectors from trusted observation. Reject broad or caller-authored
registrations. Retain exact registration cleanup ownership and original operation
identity. Uncertain create/delete requires exact readback, without duplicate create
or unrelated deletion.

Observation must distinguish an observed bound incarnation, observed termination
of that exact incarnation, and unavailable or termination-unverified evidence.
A missing Pod or deletion acknowledgment is insufficient. This semantic distinction
does not prescribe new serialized result tags. State commit and concurrency rules
remain in [withdrawal and recovery](architecture.md#withdrawal-and-recovery).

## Verified workload evidence

**Separate supplier source:** the following signatures are from
[runtime-identity-v1.ts at `f6f47f9`](https://github.com/openclaw/openclaw-enterprise/blob/f6f47f967a3c480dd7c7770072cd8a806978596d/packages/contracts/src/runtime-identity-v1.ts).
The brand symbols are private to that module. No exported constructor or JSON codec
creates proof, transport, or stream handles.

```ts
export interface VerifiedWorkloadV1 extends RuntimeWorkloadDiagnosticV1 {
  readonly [verifiedWorkload]: true;
  readonly transportBinding: RuntimeWorkloadTransportBindingV1;
}
export interface RuntimeWorkloadTransportBindingV1 {
  readonly [workloadTransport]: true;
}
export interface TrustedRuntimeRegistrationReaderV1<OwnedConnection> {
  resolve(
    connection: OwnedConnection,
    expected: RuntimeWorkloadExpectationV1,
    call: RuntimeAuthorityCallBoundsV1,
  ): Promise<RuntimeRegistrationResultV1>;
}
export interface RuntimeWorkloadVerifierV1<OwnedConnection> {
  verify(
    connection: OwnedConnection,
    expected: RuntimeWorkloadExpectationV1,
    call: RuntimeAuthorityCallBoundsV1,
  ): Promise<RuntimeWorkloadVerificationResultV1>;
  inspect(
    proof: VerifiedWorkloadV1,
    call: RuntimeAuthorityCallBoundsV1,
  ): Promise<RuntimeWorkloadVerificationResultV1>;
}
```

`RuntimeWorkloadExpectationV1` requires `target`, `expectedPeerSPIFFEId`,
`recipientRef`, `identityProfileRef`, and `limits`. The accepting service obtains
these from trusted configuration, never request destination data. Call bounds
require `requestRef`, `recipientRef`, absolute canonical UTC `deadline`, and
`signal: AbortSignal`. The provider also applies its trusted monotonic clock.
Resolution must complete within the smaller of remaining validity and the
supplier's three-second lookup ceiling. `AuthorityCallV1` additionally requires
the process-local `RuntimeAuthorityTrustedContextV1`.

`RuntimeRegistrationResultV1` is `{kind: "observed", observation}` or
`RuntimeIdentityFailureV1`. The observation contains `assignment`, `spiffeId`,
`registrationId`, `registrationVersion`, `identityProfileRef`, `bundleSetVersion`,
`sourceEvidenceRef`, `observedAt`, and `validUntil`.
`RuntimeWorkloadVerificationResultV1` is `{kind: "verified", proof}` or the same
failure union. `verify` requires actual X.509-SVID verification and exact trusted
registration/bound-instance checks. `inspect` freshly checks the same owned proof's
recipient, connection incarnation, certificate, source/trust, registration,
profile, bundle, and original expiry. Inspection never renews proof by delivery.

The diagnostic projection has `schemaVersion: 1`, `spiffeId`, `component`,
`assignmentRef`, `bindingVersion: 1`, `identityProfileRef`, registration and bundle
versions, `registrationId`, `verifiedAt`, `expiresAt`, `peerEvidenceRef`, `recipientRef`, and
`connectionRef`. Reference strings are bounded, versions are positive safe
integers, and timestamps use canonical millisecond UTC. The diagnostic decoder
limits input to 4,096 bytes, depth 8, 256 nodes, and 2,048 bytes per string.
Decoding establishes shape only.

Failures carry `schemaVersion: 1`, `requestRef`, a `kind` of
`verification-failure` or `transport-failure`, and a closed `reasonCode` from the
source. Verification codes cover invalid, untrusted, expired, or mismatched peers,
binding/component rejection, stale or invalid observation, denied/invalid/unresolved
profiles, unsupported version, missing capability, invalid/rolled-back bundle,
and unavailable lookup. Transport codes are `cancelled`, `deadline-exceeded`,
`connection-closed`, `transport-unavailable`, `protocol-invalid`,
`buffer-exhausted`, and `cleanup-unsettled`. Unauthenticated recipients receive
generic failure, not scoped internal diagnostics.

Every [RuntimeIdentityLimitsV1](https://github.com/openclaw/openclaw-enterprise/blob/f6f47f967a3c480dd7c7770072cd8a806978596d/packages/contracts/src/runtime-identity-v1.ts#L66-L124)
field is required, without defaults. `schemaVersion` is `1`. References are
1–200 characters matching `[A-Za-z0-9._:/-]+`. Numeric values are positive safe
integers except the explicitly zero-permitting skew:

| Required fields                                                                                                                                                            | Bounds and relationships                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `limitsProfileRef`, `bundleRollbackPolicyRef`, `invalidationProtocolRef`, `effectFenceProfileRef`, `requestBoundsRef`, `connectionBoundsRef`, `registrationChurnBoundsRef` | References.                                                                                                     |
| `svidLifetimeMs`, `renewBeforeExpiryMs`, `renewalRetryBudgetMs`                                                                                                            | Retry budget ≤ renewal lead < lifetime.                                                                         |
| `runtimeEvidenceMaxAgeMs`, `policyEvidenceMaxAgeMs`, `identityEvidenceMaxAgeMs`                                                                                            | Each ≤15,000ms.                                                                                                 |
| `identityHealthMaxAgeMs`, `identityHealthPollMs`                                                                                                                           | Poll interval ≤ maximum age.                                                                                    |
| `assignmentDeadlineMs`, `policyDeadlineMs`                                                                                                                                 | Each ≤3,000ms.                                                                                                  |
| `clockSkewAllowanceMs`                                                                                                                                                     | 0–2,000ms.                                                                                                      |
| `connectionMaxAgeMs`, `streamRecheckMs`, `streamCloseDeadlineMs`                                                                                                           | Recheck ≤5,000ms and ≤ connection age.                                                                          |
| `bundleUpdateMaxAgeMs`, `bundleOverlapMs`, `disableBudgetMs`                                                                                                               | Positive safe integers.                                                                                         |
| `maxFrameBytes`, `maxBufferedBytes`, `maxBufferedMessages`, `maxConnections`, `maxStreamsPerConnection`, `maxPendingChecks`                                                | Frame ≤ buffered bytes. Connections × streams and buffered bytes × connections × streams must be safe integers. |

[Cross-field validation](https://github.com/openclaw/openclaw-enterprise/blob/f6f47f967a3c480dd7c7770072cd8a806978596d/packages/contracts/src/runtime-identity-v1.ts#L407-L421)
and [selected ceilings](https://github.com/openclaw/openclaw-enterprise/blob/f6f47f967a3c480dd7c7770072cd8a806978596d/packages/contracts/src/runtime-authority-v1.ts#L7-L20)
constrain configuration. Parsing neither admits a profile nor measures its guarantee.

Actual producers must bind the exact request/stream to its original live
connection, recipient, and incarnation across the protected Go/TypeScript bridge.
Cover every receiving route, including `checkContinue`, and reject unsupported
alternate/upgrade/CONNECT routes. Strings, headers, serialized proofs, routing
hints, copied diagnostics, and repository bearers cannot create evidence. Resolve
verified evidence through selected IAM to the existing Agent ServicePrincipal.
Identity-purpose currentness remains separate from operation authorization.

## Repository session binding

**Separate supplier source:** [repository-credentials.ts at `eb52cc4`](https://github.com/openclaw/openclaw-enterprise/blob/eb52cc4cfe68f08017e7ece6585fe7e937e0747a/packages/contracts/src/repository-credentials.ts)
defines the complete existing Driver and material shapes:

```ts
export interface RepositoryCredentialDriver extends Driver {
  readonly capability: "repository_credentials";
  readonly maintenanceIntervalMs: number;
  resolve(input: {
    readonly namespaceId: string;
    readonly bindings: readonly RepositoryBindingRequest[];
  }): RepositoryCredentialResolution;
  open(
    input: OpenRepositorySessionInput,
    signal: AbortSignal,
  ): Promise<OpenRepositorySessionResult>;
  status(
    sessionId: string,
    signal: AbortSignal,
  ): Promise<RepositoryCredentialSessionStatus | undefined>;
  close(
    sessionId: string,
    signal: AbortSignal,
  ): Promise<RepositoryCredentialSessionStatus | undefined>;
}
```

Each binding request contains `repositoryRef` and optional `profile`. Resolution
returns `bindings` and `sessionDurationSeconds`. Each admitted binding contains
`repositoryRef`, resolved `profile`, `providerId`, and `grant`. The grant contains
`providerInstanceId`, `repositoryId`, and `grantId`, each nonempty, at most 512 UTF-8
bytes, and without ASCII controls. `RepositoryRevisionState` stores the Driver's
`id`/`implementation`, `deadlineWallMs`, and admitted bindings.

`OpenRepositorySessionInput` requires `namespaceId`, `admissionId`, `binding`,
`durationSeconds`, and `deadlineWallMs`. Optional `recoverOnly: true` restricts
lookup to recovered/missing results without creating authority. The complete result
union is:

```ts
export type OpenRepositorySessionResult =
  | {
      readonly kind: "created";
      readonly session: RepositoryCredentialSessionStatus;
      readonly files: RepositoryCredentialSessionFiles;
    }
  | { readonly kind: "recovered"; readonly status: RepositoryCredentialSessionStatus }
  | { readonly kind: "missing" };
export type RepositoryCredentialSessionFiles = Readonly<{
  bearer: string;
  "client.json": string;
  gitconfig: string;
  "gh/hosts.yml": string;
  "gh/config.yml": string;
  "ca.pem"?: string;
}>;
export type RepositoryCredentialRuntimeBinding = RepositoryCredentialMaterialRef & {
  readonly deadlineWallMs: number;
} & (
    | { readonly kind: "new"; readonly files: RepositoryCredentialSessionFiles }
    | { readonly kind: "retained" }
  );
```

`RepositoryCredentialMaterialRef` contains `repositoryRef` and `sessionId`.
Compute owns material paths, modes, and runtime objects. The client configuration
contains `gatewayOrigin`, `gitRemote`, `gitUsername`, `canonicalApiHost`, `apiHost`,
and `repository`. Session status contains `sessionId`, state `OPEN | CLOSED |
DISPOSED`, `deadlineWallMs`, grant `binding`, `activeUses`, and cleanup counts
`active`, `pending`, `revoked`, `expired`, `uncertain`, plus `auxiliaryPending`.
Undefined status is not proof of provider revocation.

The supplier's [configuration and profiles](https://github.com/openclaw/openclaw-enterprise/blob/eb52cc4cfe68f08017e7ece6585fe7e937e0747a/docs/reference/repository-credentials.md#L26-L125)
remain authoritative. It permits up to 16 distinct 1–128-character repository
selectors and defaults an omitted profile to `git-write`. This proposal's first
read explicitly selects `git-read`, and contribution explicitly selects `git-full`.
Registry drift denies admission. Revision deadlines survive renewal and recovery.

**Proposed extension:** persist the execution expectation before opening the
session and preserve it identically through open, status, recovery, and material
delivery. Unsupported binding capability denies enforcement. A successor requires
fresh admission and closure of the old attempt, never rebinding an open session.
The receiver must check current verified evidence before credential acquisition
or dispatch. No extension field or wire format is selected here.

For example, `created` supplies files through the actual Harness after exact
admission. `recovered` carries status without files. The [existing worker](https://github.com/openclaw/openclaw-enterprise/blob/eb52cc4cfe68f08017e7ece6585fe7e937e0747a/apps/controller/src/worker/repository-credentials.ts#L354-L402)
closes that admission rather than rediscovering its lost bearer. Recovery must
retain the original deadline and identical execution expectation. A `recoverOnly`
missing result creates no session. Retained status cannot authorize a replacement.
Preserve existing grants, profiles, Git semantics, renewal,
recovery, durable cleanup, and uncertain outcomes.

## Currentness and expiry

Consume the original stable Principal/account/method/session facts and RBAC's
`AgentAuthorityContext`/`AgentInvocation`. Retain the original connection, grant,
scope, complete audience, authority generation, and absolute deadline. Before
acquisition or dispatch, require current assignment and exact Agent
`use_repository`, profile, resource, and operation permission. A legacy
`operate`/`read` mapping cannot broaden access.

After authority/acquisition waits, inspect the same proof within its original
budget. A current original waiter must still authorize shared acquisition.
Immediately before effects and authority-sensitive delivery, synchronously check
currentness and the session fence without an intervening await. Preserve
no-positive-cache guards and [account withdrawal semantics](security.md#currentness-controls).

The separate supplier `RuntimeIdentityPurposeGuardV1.check(proof, request, call)` returns
`Promise<RuntimeIdentityCheckResultV1>`. Its
`openStream(proof, request, call, limits)` returns
`Promise<RuntimeIdentityOpenStreamResultV1>`. Inputs are respectively
`VerifiedWorkloadV1`, `ResolveAssignmentRequestV1`, `AuthorityCallV1`, and
`RuntimeIdentityLimitsV1`. Opening returns `{kind: "opened", stream}`,
`{kind: "not-opened", observation}`, or `RuntimeIdentityFailureV1`. The observation
is a `ResolveAssignmentResultV1`. Opening is not permission for even the first
dispatch or delivery, which needs its own fresh check and operation authorization.

`ResolveAssignmentRequestV1` requires `schemaVersion: 1`, `installationId`,
`namespaceId`, `agentId`, `assignmentRef: {schemaVersion: 1, id}`, `requestRef`,
and `purpose`. Assignment IDs and operation references are lowercase UUIDv4.
Scope IDs retain their prefixed schemas, references the bounds above, counters
positive safe integers, and times canonical millisecond UTC.

| Purpose                                             | Additional required request members                                                                                                                              |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runtime-peer`, `model-call`, `repository-issuance` | None.                                                                                                                                                            |
| `identity-registration`, `readiness-probe`          | `operationRef`, `expectedResponsibilityVersion`.                                                                                                                 |
| `cleanup`                                           | Those operation members plus `requestedOperation`: `cancel-execution`, `remove-route`, `terminate-instance`, `retire-registration`, or `remove-provider-object`. |
| `completed-context-restore`                         | Those operation members plus `purposeContract: "completed-context-restore-v1"` and `requestedSuboperation`: `importCompletedContext` or `readImportedContext`.   |

The [purpose/result contract](https://github.com/openclaw/openclaw-enterprise/blob/f6f47f967a3c480dd7c7770072cd8a806978596d/packages/contracts/src/runtime-authority-v1.ts#L410-L625)
requires every positive observation to carry `schemaVersion: 1`, `evaluatedAt`,
`validUntil`, `requestRef`, `result`, `purpose`, and `reasonCode`:

- Serving purposes return `current` / `conditions-satisfied`, with `snapshot`,
  `runtimeEvidence`, `policyEvidence`, `lifecycleGeneration`, `selectionVersion`,
  `identityEvidence`, `servingEvidence`, and `mutationEligibilityEvidence`.
- Registration returns `candidate-eligible` / `registration-allowed`, with
  `snapshot`, `runtimeEvidence`, `policyEvidence`, `operationRef`,
  `responsibilityVersion`, `allowedOperation: "register" | "maintain-registration"`,
  `registrationTemplateRef`, `parentBindingRef`, and `selectorEvidenceRef`.
- Readiness returns `candidate-eligible` / `probe-allowed`, with `snapshot`,
  `runtimeEvidence`, `policyEvidence`, `operationRef`, `responsibilityVersion`,
  `allowedOperation: "readiness-probe"`, `peerPairingRef`, `peerPairingVersion`,
  `permittedEndpointRef`, `peer`, `identityEvidence`, and `peerIdentityEvidence`.
- Cleanup returns `cleanup-eligible` / `cleanup-allowed`, with `operationRef`,
  `responsibilityVersion`, `snapshot`, `allowedOperation`,
  `successorExclusionEvidence`, `effectPreconditionEvidence`, and
  `cleanupPolicyEvidence`. The unbound-object variant replaces `snapshot` with
  `targetKind: "owned-provider-object"`, `target`, `assignmentRecordVersion`,
  the three profile references, `profileDigests`, `providerObject`, and
  `ownershipEvidence`. Its operation is only `remove-provider-object`.
  `providerObject` pairs `occ/kubernetes-gvisor`/`harness` or
  `occ/kubernetes-gateway`/`gateway` with `clusterRef`, `kubernetesNamespaceUid`,
  and `deploymentUid`. It proves retained create-effect ownership without a Pod.
- Restore returns `candidate-eligible` / `restore-operation-eligible`,
  `purposeContract: "completed-context-restore-v1"`, `allowedSuboperation`,
  `binding`, `currentPolicyEvidence`, and `pairingEvidence`. Its complete
  [restore binding](https://github.com/openclaw/openclaw-enterprise/blob/f6f47f967a3c480dd7c7770072cd8a806978596d/packages/contracts/src/runtime-authority-v1.ts#L468-L493)
  contains scope IDs, `conversationRef`, `preparationRef`, `restoreRef`,
  `responsibilityVersion`, `lifecycleGeneration`, `gatewayAssignmentRef`,
  `harnessAssignmentRef`, `gatewayBindingVersion`, `harnessBindingVersion`,
  `pairingRecordRef`, `pairingRecordVersion`, `checkpointId`, `checkpointHeadVersion`,
  `completionSequence`, `contextDigest`, `gatewayStoreBindingRef`,
  `workspaceStoreBindingRef`, `admittedRevisionRef`, `admittedConfigurationDigest`,
  `producerTupleRef`, `currentPolicyEvidenceRef`, `restoreFenceEpoch`, and
  `nativeEffectRef`. This retained-consumer contract does not gate disposable delivery.

`snapshot` and `peer` contain `target`, [binding: RuntimeBindingV1](https://github.com/openclaw/openclaw-enterprise/blob/f6f47f967a3c480dd7c7770072cd8a806978596d/packages/contracts/src/runtime-authority-v1.ts#L174-L221),
`assignmentRecordVersion`, `providerProfileRef`, `runtimeProfileRef`,
`identityProfileRef`, and `profileDigests: {provider, runtime, identity}`.
The target requires `installationId`, `namespaceId`, `agentId`, `assignmentRef`,
`revisionId`, `component`, `lifecycleGeneration`, `runtimeGeneration`, and
`createEffectRef`. Binding versions equal `1`.
Digests use `sha256:` plus 64 lowercase hex digits. Source evidence contains
`reference`, `version`, `sourceObservedAt`, `receivedAt`, `validUntil`, and
`uncertaintyMs` (0–2,000). Identity evidence contains `registrationId`,
`registrationVersion`, `bundleSetVersion`, `identityProfileRef`, and `evidence`.

Refusals carry `schemaVersion: 1`, `evaluatedAt`, and `requestRef`.
`pending` adds `purpose` and `reasonCode: "evidence-incomplete"`.
`not-current` adds `purpose` and a [closed negative reason](https://github.com/openclaw/openclaw-enterprise/blob/f6f47f967a3c480dd7c7770072cd8a806978596d/packages/contracts/src/runtime-authority-v1.ts#L264-L289).
`not-visible` uses `scope-hidden`, and `unavailable` uses `lookup-unavailable`,
without a purpose field. None permits serving. Candidate and cleanup positives
are consumable only for their stated purpose, never ordinary operations.

The supplier `RuntimeIdentityStreamV1` exposes `signal`,
`check(call: AuthorityCallV1): Promise<RuntimeIdentityCheckResultV1>`,
`invalidate(reason: RuntimeIdentityInvalidationV1): void`, and
`close(): Promise<RuntimeIdentityCloseResultV1>`. Check returns `{kind: "resolved",
observation: ResolveAssignmentResultV1}` or identity failure.
The [supplier resolver](https://github.com/openclaw/openclaw-enterprise/blob/f6f47f967a3c480dd7c7770072cd8a806978596d/packages/occ/src/runtime-authority/service.ts#L309-L352)
does not yet produce current-serving results.

Invalidation reasons are authority/identity change, watch loss/gap, stale evidence,
deadline, cancellation, exhausted buffer, and closed connection. Invalidation and
close synchronously deny before cleanup. Close is idempotent and returns
`{kind: "closed"}` or a transport failure, including `cleanup-unsettled`.
Terminal streams cannot reopen. Late work retains custody/capacity until actual
settlement, and borrowed connections remain their owner's responsibility.

The installed profile must measure **≤30 seconds** from the defined authority-owner
event to both refusal of new work and last protected bytes/closure of active
exchanges, including renewal-connectivity loss. Specify evidence age, receiving
expiry, clocks/skew, monotonic budget, renewal cadence, stream cancellation, and
closure reserve. No stage restarts the bound. Expiry must progress independently
of the Harness, blocked readers, and listener saturation.

Retain applicable **five-second** dependency-call, operation-start, model-recheck,
and model-closure ceilings. They do not establish global five-second revocation.
Maintenance intervals and constants are not installed timing evidence.

For a repository-serving illustration, `owner` below denotes an authentic current
resolver observation for `repository-issuance`, with the complete nested source
types above. These are structural request/result examples, not proof construction:

```ts
type Current = Extract<ResolveAssignmentResultV1, { result: "current" }>;
declare const owner: Current & { purpose: "repository-issuance" };
const request: ResolveAssignmentRequestV1 = {
  schemaVersion: 1,
  installationId: owner.snapshot.target.installationId,
  namespaceId: owner.snapshot.target.namespaceId,
  agentId: owner.snapshot.target.agentId,
  assignmentRef: owner.snapshot.target.assignmentRef,
  requestRef: owner.requestRef,
  purpose: "repository-issuance",
};
const success: RuntimeIdentityCheckResultV1 = {
  kind: "resolved",
  observation: {
    schemaVersion: 1,
    result: "current",
    purpose: "repository-issuance",
    reasonCode: "conditions-satisfied",
    requestRef: owner.requestRef,
    evaluatedAt: owner.evaluatedAt,
    validUntil: owner.validUntil,
    snapshot: owner.snapshot,
    runtimeEvidence: owner.runtimeEvidence,
    policyEvidence: owner.policyEvidence,
    lifecycleGeneration: owner.lifecycleGeneration,
    selectionVersion: owner.selectionVersion,
    identityEvidence: owner.identityEvidence,
    servingEvidence: owner.servingEvidence,
    mutationEligibilityEvidence: owner.mutationEligibilityEvidence,
  },
};
const failure: RuntimeIdentityCheckResultV1 = {
  schemaVersion: 1,
  kind: "transport-failure",
  reasonCode: "connection-closed",
  requestRef: request.requestRef,
};
```

Success still requires exact operation authorization and final synchronous fencing
on the actual verified request. The failure forbids dispatch and buffered output.
Reconnection needs new evidence within the original authority horizon.

## Observations and owner decisions

Audit separately retains initiator, Agent/revision, selected authority, exact
operation, result, and truthful assurance. Actual verifier/guard facts retain
original assignment, generation, component, profile, and verification/expiry
times. Follow the [repository observation contract](https://github.com/openclaw/openclaw-enterprise/pull/250)
without credentials, custody/proof handles, or raw request/result material.
Protected references require authorized owner lookup. Serialized observations
never authorize effects.

The following mechanisms remain undecided while their required guarantees remain
mandatory:

- Identity, Compute, and credential owners must select protected bootstrap purpose,
  immutable material delivery, and a genuine current-serving producer.
- Egress and identity must select actual receiving peers and the authenticated
  Go/TypeScript bridge while preserving same-request/connection custody.
- RBAC, connector, and Harness owners must associate concurrent operations with
  their authentic requester and complete audience, retaining durable fences.
- Installation/admission owners must resolve the proposed stronger-minimum
  transition. Runtime/identity/egress owners must select timing mechanics and
  measure both withdrawal endpoints.

Close these decisions through real producer/consumer integration and the
[delivery qualification](delivery.md#acceptance-evidence), not invented routes,
defaults, response codes, or proof-shaped JSON.
