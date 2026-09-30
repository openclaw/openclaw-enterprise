# gVisor interfaces

[Overview](../31-gvisor-container-support.md) · [Request lifecycle](architecture.md#request-lifecycle)

See the [2026-09-24 amendment](../31-gvisor-container-support.md#current-disposition--2026-09-24-amendment)
for release scope and changes to the historical source and storage baseline.

This page distinguishes current internal Compute contracts, a separate
repository supplier and proposed gVisor extensions. It defines no new public
HTTP route. Linked source types remain normative for their exact revision.
Unselected native-context and protected-bootstrap mechanisms remain owner work.

## Configuration and admission

**Current source:** [KubernetesComputeDriverOptions](https://github.com/openclaw/openclaw-enterprise/blob/12fddc4805a1b090331af363ad10bf3b58ea5897/apps/controller/src/drivers/compute/kubernetes/index.ts#L167)
requires authentication, gateway/Agent images, resources, network and
ServicePrincipal credential settings. Optional runtime and gateway-routing
settings retain their source constraints. Authentication selects in-cluster
credentials or an explicit kubeconfig path and context. Runtime configuration
includes transport-secret prefix, gateway StorageClass and optional reviewed
Codex seccomp/channel settings. The existing contract contains no gVisor selector.

The complete current option shape is below. `V1ResourceRequirements` is the
Kubernetes client resource-requirements type. The trusted production configuration
requires verified API TLS and immutable SHA-256 image references. There is no
ambient kubeconfig fallback. The runtime field is optional in the generic type,
but real gateways require its storage and credential settings. The optional
`pluginStatusProxySourceCidrs` permits only the precise API-proxy sources
described in [architecture](architecture.md#components-and-dependencies).

```ts
export interface KubernetesWorkloadPeer {
  readonly namespace: string;
  readonly podLabels: Readonly<Record<string, string>>;
}

export interface KubernetesGatewayRoutingOptions {
  readonly hostname?: string;
  readonly gatewayName: string;
  readonly gatewayNamespace: string;
  readonly envoyNamespace: string;
}

export interface KubernetesComputeDriverOptions {
  readonly authentication:
    | { readonly mode: "inCluster" }
    | { readonly mode: "kubeconfig"; readonly kubeconfigPath: string; readonly context: string };
  readonly images: {
    readonly gateway: string;
    readonly agent: string;
    readonly requireImmutableDigest: boolean;
  };
  readonly resources: {
    readonly gateway: V1ResourceRequirements;
    readonly agent: V1ResourceRequirements;
    readonly namespace: {
      readonly quota: Readonly<Record<string, string>>;
      readonly containerDefaults: V1ResourceRequirements;
    };
  };
  readonly network: {
    readonly dns: KubernetesWorkloadPeer;
    readonly gatewayPort: number;
    readonly gatewayClients?: readonly KubernetesWorkloadPeer[];
    readonly pluginStatusProxySourceCidrs?: readonly string[];
  };
  readonly servicePrincipalCredentials:
    | { readonly mode: "disabled" }
    | {
        readonly mode: "projectedServiceAccountToken";
        readonly audience: string;
        readonly expirationSeconds: number;
      };
  readonly runtime?: {
    readonly transportSecretPrefix: string;
    readonly gatewayStorageClassName: string;
    readonly codexSeccompProfile?: string;
    readonly channels?: {
      readonly secretPrefix: string;
      readonly proxyUrl: string;
    };
  };
  readonly gatewayRouting?: KubernetesGatewayRoutingOptions;
}
```

**Proposed selection:** trusted Installation configuration adds:

```yaml
drivers:
  compute:
    id: compute-gvisor
    configuration:
      isolationProfile: gvisor-systrap
      # Supply normal Kubernetes authentication, images, resources,
      # network, servicePrincipalCredentials, and runtime configuration.
```

This is a proposal fragment, not a complete runnable configuration. Omission
preserves ordinary Kubernetes behavior. Docker/Podman remain available within
their [actual supported contract](https://github.com/openclaw/openclaw-enterprise/blob/e9766f35a25afa240ee109b41a6ef821fb68687e/docs/reference/drivers/docker-compute.md),
including rejection of Harness authentication bindings.

Admitted revisions pin `compute.implementation: "occ/kubernetes-gvisor"`.
Ordinary Kubernetes cannot later execute them after configuration changes.
Changed requirements require fresh admission. The first profile supports
direct dedicated Codex in OCE-owned tenant namespaces. Reject embedded
execution, SandboxDriver composition, existing-namespace adoption, unknown
profile values and unsupported configuration. No new error code is selected here.

Runtime isolation and network/credential assurance are independent choices.
An operator may explicitly select a supported weaker profile. A failed stronger
selection never automatically downgrades. The controller may read only the
named `oce-gvisor-systrap` RuntimeClass. Node-runtime configuration remains
operator-owned. [Architecture](architecture.md#placement-and-observation) owns
the exact startup and every-readiness observation rule.

## Compute lifecycle and observation

**Current source:** the complete [ComputeDriver](https://github.com/openclaw/openclaw-enterprise/blob/e9766f35a25afa240ee109b41a6ef821fb68687e/packages/contracts/src/index.ts#L714)
declaration below extends `Driver`, whose fields are `id`, `capability`,
`implementation` and optional `computeLifecycleHooks`.

```ts
interface ComputeDriver extends Driver {
  readonly capability: "compute";
  readonly runtimeLogging?: "platform" | "driver";
  readonly activationOrder?: "beforeCommit" | "afterCommit";
  readonly maintenanceIntervalMs?: number;
  validateHarnessAuth?(
    harness: RevisionHarnessDescriptor,
    auth: HarnessAuthSnapshot,
    configuration: OpenClawConfigurationDocument,
  ): void;
  preflight?(): Promise<void | ComputePreflightResult>;
  setLifecycleDrivers?(drivers: readonly Driver[]): void;
  bindAgent?(binding: ComputeAgentBinding): void | Promise<void>;
  getAgentRuntimeCredentialStatus?(
    binding: ComputeAgentBinding,
  ): Promise<AgentRuntimeCredentialStatus>;
  provisionAgentRuntimeCredentials?(
    binding: ComputeAgentBinding,
    input: AgentRuntimeCredentialsInput,
  ): Promise<AgentRuntimeCredentialStatus>;
  getGatewayEndpoint?(revision: AgentRevision): string | undefined;
  ensureNamespace(namespace: Namespace): Promise<NamespaceEnsureResult>;
  deleteNamespace(namespace: Namespace): Promise<NamespaceDeleteResult>;
  prepareRevision(
    revision: AgentRevision,
    context?: ComputeRevisionContext,
  ): Promise<ComputeReadiness>;
  activateRevision?(revision: AgentRevision, context?: ComputeRevisionContext): Promise<void>;
  deactivateRevision?(revision: AgentRevision): Promise<void>;
  stopRevision(revision: AgentRevision): Promise<void>;
  retireRevision(revision: AgentRevision): Promise<void>;
}
```

The [shared input and result types](https://github.com/openclaw/openclaw-enterprise/blob/e9766f35a25afa240ee109b41a6ef821fb68687e/packages/contracts/src/index.ts)
retain these meanings. The newer preparation result is defined below:

- `ComputeAgentBinding` contains read-only admitted `namespace` and `agent`.
  `AgentRevision` freezes Namespace/Agent/revision identities, provider,
  configuration identity/generation/document, Harness id/version/mode, Compute
  id/implementation, ServicePrincipal, creation time and authentication snapshot.
  Optional fields select Sandbox, Secret Driver, Secret bindings and plugins.
- `ComputeRevisionContext` requires `harnessAuth` and `secretEnvironment`.
  Resolved Harness auth is `runtime`, an API-key source with its current backend
  reference, or the admitted managed-account access-token credential and Provider
  binding. These carry references, not credential bytes. Secret environment
  projections contain name, Secret/Namespace/Agent identity and exact backend
  namespace/name/key/UID. Gateway Secrets remain distinct from model auth.
- Namespace ensure/delete results contain string `namespaceId`,
  boolean `namespaceReady`/`namespaceDeleted`, and optional `failure` of
  `retryable | permanent`.
- Preflight returns nothing or `{ warnings: readonly { code: string, message:
string }[] }`. A warning continues startup, while a thrown error blocks it.
- Endpoint resolution returns a trusted private WSS address or `undefined`.

At current main `12fddc4`, [preparation](https://github.com/openclaw/openclaw-enterprise/blob/12fddc4805a1b090331af363ad10bf3b58ea5897/packages/contracts/src/index.ts#L680-L691)
adds optional closed plugin warnings:

```ts
export interface PluginDeploymentWarning {
  readonly code: "PLUGIN_INSTALL_FAILED" | "PLUGIN_AUTH_REQUIRED";
  readonly pluginId: string;
}

export interface ComputeReadiness extends Scope {
  readonly namespaceId: string;
  readonly agentId: string;
  readonly revisionId: string;
  readonly ready: boolean;
  readonly warnings?: readonly PluginDeploymentWarning[];
}
```

`Scope.namespaceId` is optional generally and required here. Unlike preflight warnings, these
warnings identify only an admitted plugin and a closed code. [Ready with warnings](https://github.com/openclaw/openclaw-enterprise/blob/12fddc4805a1b090331af363ad10bf3b58ea5897/docs/reference/drivers/compute.md#plugin-startup-warnings)
requires safely disabled failed selections and every remaining readiness check.
[Requested selections](https://github.com/openclaw/openclaw-enterprise/blob/12fddc4805a1b090331af363ad10bf3b58ea5897/docs/reference/agent-plugins.md#L49-L77)
remain immutable. Successful selections retain their policy,
and restart recomputes the effective configuration. Catalog, policy, integrity,
core authentication, transport and malformed-response failures remain fatal.
Warnings cannot bypass RuntimeClass checks, complete candidate observation or
positive isolation containment. Required status unavailability withholds
readiness and alone authorizes no destructive cleanup. Saved deployment outcomes
are historical completion evidence, not live health or protected History.

OCC authenticates and authorizes exact resources before handing admitted records
to Compute. The worker reauthorizes the immutable revision before preparation
and activation. Although optional in TypeScript, Harness-auth validation is
required by deployment, and production requires activation and deactivation.
Missing required stages fail closed. Validation is side-effect-free.

The [current lifecycle contract](https://github.com/openclaw/openclaw-enterprise/blob/e9766f35a25afa240ee109b41a6ef821fb68687e/docs/reference/drivers/compute.md)
defaults to post-commit activation unless the Driver selects `beforeCommit`.
Activation is idempotent and cannot succeed before effective configuration and
authenticated readiness. Stop idempotently removes exact-revision routing and
execution while retaining persistent state. Retirement preserves a gateway
already owned by a successor. Optional maintenance uses a positive safe-integer
interval and the existing durable queue, reauthorizing the original actor on
each pass. Runtime logging defaults to `platform`.

[Initial runtime credentials](https://github.com/openclaw/openclaw-enterprise/blob/e9766f35a25afa240ee109b41a6ef821fb68687e/docs/reference/drivers/compute.md#optional-initial-runtime-credential-provisioning)
use `AgentRuntimeCredentialsInput`, with optional
`slack: { appToken: string, botToken: string }`. `AgentRuntimeCredentialStatus`
contains boolean `transportConfigured` and `slackConfigured`. These flags mean
complete, correctly owned stored groups, not provider authentication or readiness.
[OCC requires](https://github.com/openclaw/openclaw-enterprise/blob/e9766f35a25afa240ee109b41a6ef821fb68687e/packages/occ/src/index.ts#L767-L846)
exact-Agent `read` for status and `read` plus `operate` for provisioning. It holds
Namespace and Agent locks, requires a ready Namespace and rejects provisioning
after any historical revision. Drivers receive the admitted binding, never
caller-selected storage names. Unsupported Drivers fail explicitly. Model
authentication remains the separate deployment check.

Kubernetes creates missing whole Secrets, generating transport tokens and the
gateway password internally. Foreign or malformed objects and conflicting values
are rejected. Matching complete groups survive retries without rotation or
deletion. Partial external writes survive database or audit failure, so refresh
stored status before retrying. Credential values stay out of response metadata,
Configuration, audit and errors.

For example, with those checks satisfied and no stored groups, provisioning
input `{}` returns `{ transportConfigured: true, slackConfigured: false }` after
transport storage succeeds. If the subsequent audit fails, the external Secret
may remain. Refresh status before retry: the same result confirms storage only,
and a retry preserves that group. It must neither rotate credentials nor claim
that deployment succeeded. These examples describe the existing methods, not a
new endpoint or executed proof.

[Selected-driver hooks](https://github.com/openclaw/openclaw-enterprise/blob/e9766f35a25afa240ee109b41a6ef821fb68687e/docs/reference/drivers/compute.md#optional-selected-driver-hooks)
retain four `Promise<void>` calls: `afterNamespacePrepared(namespace, signal)`,
`beforeWorkloadStart(revision, launch, signal)`, `beforeWorkloadStop(revision, signal)`
and `beforeNamespaceDelete(namespace, signal)`. Hooks run in selection order
and unwind in reverse. `launch.environment` is a mutable string record accepting
only bounded `opaque-` placeholders for the selected workload. In this dedicated
topology it reaches Codex, never the gateway. Reject reserved names, plaintext
credentials and changes to images, commands, placement, networking, authorization
or immutable revision data. Core revision calls gain no cancellation parameter.

Hooks must be idempotent. For selected owners A then B, successful preparation
runs A then B and teardown revokes B then A. If B's preparation fails after A
completes, compensate A and do not launch. A revocation failure preserves the
owned resource and blocks teardown for safe retry. Cancelled rollback receives
a bounded cleanup signal so cancellation cannot suppress compensation.

**Proposed optional observation:** State/OCC owns assignment and current serving.
Compute supplies a closed `observed | terminated | unavailable` result. Positive
results bind the original create and exact incarnation, not a matching name.
The producer must validate Installation, Namespace, Agent/revision,
ServicePrincipal, component, Driver/profile, generation and original deadline.
Reject duplicate component allocations. Retries retain allocation and create
identity.

Observation verifies Namespace UID, the complete Deployment–ReplicaSet–Pod
owner chain, image/container identity and restart discriminator. Ordinary
Kubernetes evidence stays distinct from actual gVisor sandbox, distribution,
binary, platform and STRICT-policy evidence. Relay resource/incarnation and
private-ingress observation join identity-owned verified registration and
provider readback. Changed execution or relay needs fresh proof.

`terminated` requires the exact bound incarnation, authenticated observation,
observation time and provider-supported termination evidence. Unsupported,
missing, ambiguous, substituted or stale evidence cannot bind. Unproved stop
returns unavailable with termination unverified. This is the complete required
producer behavior, not a claim that current main exports a new observation ABI.

## Repository material

The separate supplier at `eb52cc4` defines the full
[RepositoryCredentialRuntimeBinding](https://github.com/openclaw/openclaw-enterprise/blob/eb52cc4cfe68f08017e7ece6585fe7e937e0747a/packages/contracts/src/repository-credentials.ts)
shape:

```ts
type RepositoryCredentialSessionFiles = Readonly<{
  bearer: string;
  "client.json": string;
  gitconfig: string;
  "gh/hosts.yml": string;
  "gh/config.yml": string;
  "ca.pem"?: string;
}>;

interface RepositoryCredentialMaterialRef {
  readonly repositoryRef: string;
  readonly sessionId: string;
}

type RepositoryCredentialRuntimeBinding = RepositoryCredentialMaterialRef & {
  readonly deadlineWallMs: number;
} & (
    | { readonly kind: "new"; readonly files: RepositoryCredentialSessionFiles }
    | { readonly kind: "retained" }
  );
```

Files contain ephemeral UTF-8 content. Compute owns paths, modes and material
objects. The supplier adds optional `repositoryCredentials: readonly
RepositoryCredentialRuntimeBinding[]` to `ComputeRevisionContext`, optional
`repositoryCredentialMaterialMissing: readonly RepositoryCredentialMaterialRef[]`
to readiness, and `validateRepositoryCredentials?(harness:
RevisionHarnessDescriptor, sandboxDriverId?: string): void` to Compute.
Its implemented topology is embedded-only. Dedicated delivery remains proposed.

Deliver only the service's ephemeral repository session to dedicated Codex.
The separate gateway receives none. App keys, App JWTs, installation tokens
and service-control sockets remain service-private. Package managed Git/`gh`
in the actual tool-child PATH, with the correct private service route and trust.

Preserve IAM, immutable session attempts, the original deadline,
close-before-reopen and retryable cleanup. Delivery, repair and retirement are
generation-sensitive. Before repaired material is published, complete observation
must show no old-generation candidate Pods and exactly one expected-generation
Running/Ready Pod. Preserve successors during stale repair. This material
barrier is not retained-writer fencing.

For example, a retained binding with missing runtime material must report that
exact repository/session reference and withhold readiness. Recovery keeps the
original deadline. It does not infer new authority from the missing file.
The contribution explicitly selects [git-full](https://github.com/openclaw/openclaw-enterprise/blob/eb52cc4cfe68f08017e7ece6585fe7e937e0747a/docs/reference/repository-credentials.md#profiles),
whose broader selected Git/REST/GraphQL/PR/issue/comment ceiling is not a
single-PR grant. [Restart cleanup limits](security.md#accepted-limits-and-closure)
continue to apply after local material replacement.

## Storage contract index

**Proposed revision extension:** `AgentRevision.compute.storage` is optional and
contains this closed immutable policy:

```ts
type ComputeRevisionStorageV1 = Readonly<{
  schemaVersion: 1;
  disposition: "disposable";
  storageProfileRef: string;
  storageProfileDigest: string;
}>;

interface ComputeRevisionStorageAdmissionInput extends ComputeAgentBinding {
  readonly revisionId: string;
  readonly harness: Readonly<RevisionHarnessDescriptor>;
  readonly sandboxDriver?: SandboxDriver;
}

// Proposed optional ComputeDriver member, pure and synchronous.
admitRevisionStorage?(
  input: ComputeRevisionStorageAdmissionInput,
): ComputeRevisionStorageV1 | undefined;
```

The profile reference is 1–128 ASCII characters matching
`[A-Za-z0-9][A-Za-z0-9._-]{0,127}`. The digest is `sha256:` followed by 64 lowercase
hexadecimal characters. Unknown fields or malformed values are rejected.
`undefined` leaves the existing two-key Compute record and authorizes no disposal.
The trusted profile binds class choices, sizes, access modes, volume mode,
mount layout and cleanup semantics. OCC validates and freezes a detached copy
in the original admission transaction after Harness checks.

Create custody must retain original plan/operation, Namespace UID, profile and
specification identity, confirmed PVC UIDs and partial/closed receipts. These
are owner records, not public selectors. Their lifecycle and unknown-outcome
rules belong to [storage and recovery](storage-and-recovery.md).

Current [storage configuration](https://github.com/openclaw/openclaw-enterprise/blob/e9766f35a25afa240ee109b41a6ef821fb68687e/docs/reference/drivers/kubernetes-compute/storage-and-credentials.md)
provides a 40Gi shared ReadWriteMany dedicated workspace and a separate 10Gi
ReadWriteOnce SQLite-compatible gateway store. It does not define a retained
handoff, a quiet-import API or a fresh-store recovery service. Actual approved
store binding and canonical completed-context artifact interfaces remain prerequisites.

## Owner decisions

- **Compute, State and storage:** choose the disposable terminal transition.
  Stop, eligibility and confirmed disposal remain distinct, and retained stop
  continues to preserve data. Close the decision with the complete lifecycle.
- **Compute, State, identity and credential owners:** finish actual observation
  exports, immutable runtime binding, material delivery, bootstrap probes and
  current-serving consumption. Prove observation before session opening without
  circular readiness or incarnation replacement.
- **Persistence and native owners:** select the supported shared/private binding
  and canonical native artifact, quiet import and digest readback. Close with a
  resumed genuine turn under fresh authority. No recovery RPC is selected here.
- **Installation/OCC and consumers, proposal pending:** choose finite offered
  profile combinations and distinguish prospective default edits from explicit
  audited withdrawal of existing weaker admissions. No retroactive upgrade,
  implicit grace, automatic replacement or continuation after withdrawal.
- **Security, Compute and CNI, proposal pending:** qualify containment before
  every untrusted init/startup/replacement instruction. Egress owns this
  strengthening beyond the mandatory pre-readiness boundary.

These decisions preserve the [selected increments](delivery.md) and their
[actual composition dependencies](architecture.md#protected-composition).
