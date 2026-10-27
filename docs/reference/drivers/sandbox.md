# SandboxDriver contract

## Overview

`SandboxDriver` confines an Agent Harness's network, filesystem, or processes.
OpenClaw Control Plane (OCC) selects the Driver, authorizes deployment, and
saves the immutable Agent revision. [ComputeDriver](compute.md) owns the gateway, workload
identity, baseline isolation, routing, and activation. Sandbox can create a
dedicated Harness while Compute keeps those responsibilities.

Selection is optional and currently works only with bundled Kubernetes Compute
and dedicated execution. Choosing an installed Sandbox does not enable Docker,
SSH, or installed Compute combinations. See [Driver selection](selection.md).

## Interface

### Driver interface

The [shared interface](../../../packages/contracts/src/index.ts) exposes the
required `facets` and `cleanup` members, an optional `harnessHome`, and optional lifecycle, policy and transport methods.

| Member                                           | Contract                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `facets`                                         | Declare at least one distinct facet. Unknown, duplicate, or empty declarations are rejected.                                                                                                                                                                                                                                                                                                                        |
| `harnessHome`                                    | Optional normalized absolute HOME of the Harness user inside the Sandbox. Compute renders Harness-local paths, such as the native hook credential directory, under it. Defaults to `/home/node`.                                                                                                                                                                                                                    |
| `configureAgent(configuration, harness)`         | Optional synchronous transform. OCC passes the read-only native configuration and resolved Harness descriptor, then validates and freezes the returned configuration. The transform cannot change the selected Harness runtime. If absent, the original configuration is used. Installation reads call it with an empty configuration; a `ConfigurationHarnessError` moves that mode to `openclaw.settingRefusals`. |
| `validateWorkspaceSetup(harness, configuration)` | Optional synchronous admission check for initial workspace files. Its presence declares private initialization support. Compute delegates validation of the projected configuration; without it, Compute refuses initial files with a Sandbox. Compute retains its runtime-storage and identity checks.                                                                                                             |
| `ensureNamespace(context)`                       | Optional backend preparation after Compute has prepared baseline Namespace isolation. If absent, Compute continues without a Sandbox setup call.                                                                                                                                                                                                                                                                    |
| `provisionHarness(context)`                      | Optional creation of the dedicated Harness; returns a stable Sandbox resource reference. If absent, Compute creates the ordinary Harness workload.                                                                                                                                                                                                                                                                  |
| `cleanup(context)`                               | Required for Agent revision stop, retirement, and Namespace cleanup. Agent revision cleanup receives the immutable Agent revision; Namespace cleanup omits it.                                                                                                                                                                                                                                                      |
| `harnessResource(context)`                       | Optional. Returns the Sandbox reference `provisionHarness` creates for an Agent revision, without side effects. Compute needs it to [withdraw a credential source](credential-gateway.md#optional-additions) from a running Agent revision.                                                                                                                                                                         |
| `workspaceNodePeerLabels(context)`               | Optional. Exact Pod labels of the provider Pods that open the Agent revision's workspace-node connection, or `undefined` before its Sandbox exists. Compute admits only these Pods to that Agent's Gateway port, plus those of the serving Agent revision while a successor prepares, so the labels must select that Sandbox alone. OpenShell returns the supervisor's `openshell.ai/sandbox-id`.                   |
| `readSandboxLogs(context, request)`              | Optional read of the Agent revision's Sandbox log: at most `lines` raw lines at or after `sinceTime`, plus how many lines the source examined. It must use a read-only interface and derive the Sandbox from the Agent revision. OCC classifies and redacts every line. See [Agent logs](../../guides/topics/agent-logs.md#sandbox-source).                                                                         |

Two optional methods serve a provider-owned Harness transport.
`harnessEndpoint(context)` returns the transport for the provisioned Harness, and
Compute routes the Agent Gateway through it instead of its own Harness Service.
For Codex, Compute derives the native hook credential directory from `harnessHome`.
The Sandbox must create that owner-only directory outside the Harness workspace
and file-transfer roots. Compute validates the path and retains ownership of the
relay URL and authentication.
`harnessStatus(context)` observes the Harness's exposed port with the Agent
transport token. It answers `serving` only after an authenticated handshake, or
`failed` with the Harness's held startup failure, which Compute validates and
fails the Agent revision with; anything else is `starting`. A read the provider does
not answer is a transient dependency failure, not evidence. Compute activates
only a `serving` Codex Harness, reads its status while its workspace node is
pending (a hold before Codex starts), and reads a dedicated OpenClaw worker's status
only before its node has enrolled (`workspaceNodeEnrolled` in the context); then
it calls `withdrawHarnessExposure(context)`, which removes that worker's exposure
and resolves only once the provider confirms it gone, through a read the
controller's identity still passes (a missing answer alone is no proof). Its
context carries no requirements: Compute also calls it outside a pass, for an
Agent revision already serving at startup or one that failed permanently. An endpoint may select
`codexPermissionProfile: ":danger-full-access"` when the provider supplies the
sandbox boundary. Kubernetes Compute projects that selection to the Gateway;
without it, the Codex bridge retains its configured sandbox behavior.

The endpoint may supply `tls.caBundle`: public PEM CA certificates for a WSS
origin. It accepts no private keys, client credentials or source paths. Omission
keeps system trust. Kubernetes Compute mounts this trust read-only into only the
exact dedicated Agent Gateway, combining any execution-cluster root into one
`NODE_EXTRA_CA_CERTS` bundle. Certificate and hostname verification remain enabled.
The separate immutable revision ConfigMap precedes Gateway rollout and is removed
after revision workloads terminate; changing its certificates requires a new revision.

`enrollHarness(context, installation)` is required when a revision has a protected
egress plan. Compute calls it after committing the verified installation and
checking current evidence again. The Driver authenticates the exact Harness
transport and binds a fresh startup challenge to that execution and plan before
releasing its first model probe. A starting transport can remain pending for the
next reconcile. Enrollment conveys neither credential material nor permission to
send; see [protected static inference](../credential-sources/protected-inference.md).

`observeHarness(context)` reads the provider's own lifecycle record of a dedicated
Agent revision's Harness Sandbox, without contacting the Harness. It answers `running`,
`starting`, `unknown`, or `lost` with a code: `SANDBOX_MISSING`, `SANDBOX_DELETING`,
`SANDBOX_STOPPED`, `SANDBOX_FAILED` (for example a deleted Pod) or `HARNESS_EXITED`.
OCC adds it to the runtime description and diagnostics. It reports a missing or
deleting Sandbox as lost only when the Agent is set to run and the Agent revision ID
matches its current selection. Nothing
recovers a lost Sandbox until the Agent is deployed again. The OpenShell Driver
asks the gateway to restart an exited Harness (`restart_policy: ALWAYS`); while
the gateway restarts it, the observation is `starting` with code
`HARNESS_RESTARTING`, the last `exitCode` and the gateway's `restarts` number
(GetSandbox `exit_code` and `restart_count`, set together only during a policy
restart). A first start is plain `starting`. Diagnostics report a restarting
Harness as a failed `sandbox` check. Only Sandboxes created before that policy
existed report `HARNESS_EXITED`.

### Harness Sandbox status

`GET /namespaces/:namespaceId/agents/:agentId/harness-status` requires Agent
`read`. For a running Agent whose selected version has a dedicated Harness
Sandbox, OCC calls `observeHarness` on each request and answers `observed` with
that `revisionId` and its `harness` state. Otherwise it answers `unobserved`.
`lost` means that the Sandbox does not serve the version, for example after a
node restart stopped it. OCC does not restart it: deploy a new version. A record
that OCC cannot read is `unknown`, never `lost`. `occ agent get` and the
Console's **Live serving** show this status; Agent lists do not.

### Containment facets

| Facet        | What the Driver enforces                                                           |
| ------------ | ---------------------------------------------------------------------------------- |
| `networking` | Connections only to approved destinations and peers.                               |
| `filesystem` | Approved image paths and Agent-owned workspace paths, with their read/write modes. |
| `process`    | Approved process identity, capabilities, and operating-system limits.              |

### Provisioning inputs

`SandboxNamespaceContext` carries the Namespace, Compute's Kubernetes client,
and a cancellation signal. `SandboxHarnessContext` adds the immutable Agent revision
and `HarnessWorkloadRequirements`: image and startup command, Agent ServiceAccount,
projected token audience/expiration/mount/path/read-only setting, approved PVC
subpaths and mount modes, literal environment or Kubernetes `secretKeyRef`,
explicit Harness login mode, `credentialAttachments`, and Agent and Agent revision labels.
Sandbox must use these prepared values rather than guessing login mode or
resolving another credential.

Optional `workspaceSetup` carries `{id, defaultsId?, secretKeyRef: {name, key}}`.
Compute stages an Agent-owned, same-Namespace setup Secret; OCC retains
completion state. Requirements exclude document contents. A receiving
Sandbox must initialize the approved workspace and verify its
completion marker before Harness execution, or reject the handoff.
Private initialization must preserve the [workspace setup lifecycle](../../flows/workspace-files.md#2-deployment-initializes-storage-before-execution),
including safe retries and preserved later edits. Throw
`SandboxWorkspaceSetupRefusedError` for a refusal; Compute fails at once.

`credentialAttachments` holds one opaque `{ sourceId, ref }` entry per
credential source the Agent revision uses; it is empty otherwise. The selected
[CredentialGatewayDriver](credential-gateway.md) issues them, and only its
paired Sandbox can consume them. The Sandbox must apply every attachment and
reject any it did not issue. After the Harness is ready, Compute asks the
gateway whether each attachment is applied before activating the Agent revision.

### Sandbox resource identity

`SandboxResourceRef` contains `namespaceName`, `resourceName`, `agentId`, and
`revisionId`. It stays stable when a controller replaces the underlying Pod;
retirement must find the provider resource even if that Pod is already gone.

## Optional network policy operations

`networkPolicy` declares `wildcards`, `portRanges`, and `live` support. An
implementation advertising it must declare the configuration contribution
`{ scope: "agent", key: "sandbox-network-policy" }` for `{ additions }`, using the
[shared definition contract](selection.md#configuration-definitions-and-discovery).
OCC resolves it through the registry before admission. Expected provider refusals
throw the shared `ConfigurationValidationError` with safe `error.details`.
`admitNetworkPolicy(additions, version, defaults?, scope?)` validates every requested
constraint and returns a detached snapshot of Driver identity, version, defaults,
and additions. The snapshot is consumed by provisioning; changed startup defaults
cannot reinterpret an admitted revision. `scope.repositoryCredentials` marks an
Agent with repository bindings: a Driver that routes repository hosts only through
its own path refuses a rule that reaches them with a
`SandboxNetworkPolicyConflictError` naming the rule.

`observeNetworkPolicy(context, snapshot)` returns the provider resource version,
policy version, load state, and whether the complete candidate matches.
`applyNetworkPolicy(context, {snapshot, expectedProviderVersion, operationId})`
uses exact scope, compare-and-swap and an idempotent operation ID. Declaring live
support requires both operations. Only a matching, loaded active version confirms
application. Drivers that cannot preserve static/default/generated policy reject
the change explicitly.

`readPolicyRecommendations(context, limit)` is independently optional. Return
bounded, untrusted candidate grants with stable identity, provider lifecycle and
optional aggregate observations. Suggestions never substitute for denial events
or OCC admission. `SandboxLogLine.decision` optionally describes an observed
allow/deny decision and enforcement evidence; provider parsing belongs in the
Driver. OCC validates and redacts it through the regular log path.

See [per-Agent policies](../sandbox-policies.md) for ownership, authority, ceiling,
versioning and failure semantics.

## IAM

OCC authorizes the deployment and the applicable credential sources. The Driver
receives the approved Namespace, Agent revision, and workload identity; it cannot
choose another one or grant access. Compute retains tenant isolation,
NetworkPolicies, workspace ownership, identity, and routing. Sandbox policies
cannot relax those controls. If the Driver cannot use the exact identity or
credential references, it must fail. Never expose Secret values in
configuration, Agent revision metadata, logs, or provider configuration. Workspace
initialization may deliver its exact approved payload through an authenticated
backend initialization call; it must not put document bytes in arguments or
environment values. See
[authorization](../authorization.md) and [Harness execution](../harness-execution.md).

## Lifecycle

### Admission and lifecycle

Startup validates the selected Sandbox and its declared facets. The shared
interface has no initializer or destructor; workload and Namespace removal use
the same cleanup operation with or without an Agent revision.

Dedicated native OpenClaw requires a selected Sandbox that implements
`provisionHarness` and declares networking, filesystem, and process containment.
Other dedicated Harnesses may use a subset of facets or no Sandbox according to
their Compute contract.

1. Before deployment, OCC resolves the Harness, calls optional `configureAgent`
   with that descriptor, then validates and freezes the resulting Configuration.
   The Agent revision records the selected
   `sandboxDriverId`, not the implementation or facet list.
2. Compute prepares Namespace isolation and calls optional `ensureNamespace`.
   It prepares the Agent gateway, identity, workspace, Services, and routing.
3. The Sandbox provisions the dedicated Harness if it implements
   `provisionHarness`; otherwise Compute creates it. Compute waits for the workload
   with the requested Agent revision ID, and for every credential attachment to be `ready`, before
   activating traffic.
4. Stop and retirement call `cleanup` with the Agent revision. If Compute owns the
   workload, it stops that workload first; its absence does not skip Sandbox
   cleanup. If Sandbox owns it, the method removes it.
5. Namespace deletion calls `cleanup` without an Agent revision after Agent revision cleanup
   and before Compute releases the Namespace. A failure prevents Compute from
   deleting the Namespace so provider cleanup can be retried safely, unless it
   is a refusal of the controller's identity (below).

Namespace setup, provisioning, and cleanup must be safe to repeat. Failed
Agent revision cleanup remains retryable. Unsupported topology, missing prerequisites,
ambiguous resources, failed identity checks, or unavailable containment must
prevent progress rather than weakening isolation.

The worker retries driver errors as `DEPENDENCY_UNAVAILABLE`. When a driver
cannot run the requested Agent revision and a retry cannot change that, it throws
`SandboxRevisionUnsupportedError` from `@openclaw-enterprise/occ` with a closed
code. The worker then fails the deployment with that code and a fixed message
at once. The driver's own message stays in the controller:
`SANDBOX_SECRET_ENVIRONMENT_UNSUPPORTED` (Secret-backed environment) and
`SANDBOX_HARNESS_UNSUPPORTED` (unsupported Harness). `SandboxGatewayUnauthorizedError`
(`SANDBOX_GATEWAY_UNAUTHORIZED`) fails it the same way when the provider refuses
the controller's identity while it confirms a Harness exposure withdrawn or a
Sandbox removed; an Agent stop, deletion or credential withdrawal fails with it
too, so a Sandbox the identity may no longer see (the provider hides it as
missing) is never recorded gone. A missing role fails at once; an identity the
provider could not authenticate (`transient`: a token file or signing key between
refreshes) retries within the attempt budget first. The worker logs the failed
stop, deletion or withdrawal with `hintCode: sandbox-gateway-identity`, which names
the guidance the deployment status shows: check the controller gateway identity's
token file and the gateway's signing-key refresh, or restore its Workspace role (or
recreate the Workspace with a deploy; a Workspace removed outside the controller
presents the same way), then deploy, stop, delete or withdraw again.
A delete that finds nothing where the read just did is `SANDBOX_DELETION_UNCONFIRMED`:
the sweep logs it `worker.harness-exposure-withdrawal-unconfirmed` and retries.

When the provider refuses the controller's own identity during `ensureNamespace`
or Namespace `cleanup`, a retry cannot help until an operator fixes that identity.
The driver throws `SandboxNamespaceRefusedError` from `@openclaw-enterprise/occ`,
whose message names only the provider's refusal code. Compute fails the Namespace
step as `permanent` at once; for `ensureNamespace` the worker logs that message
as the `reason`. OpenShell throws it for gRPC `PERMISSION_DENIED` and
`UNAUTHENTICATED`.

## Limits

- Supported facets are `networking`, `filesystem`, and `process`; there is no
  `exec` facet, per-tool Sandbox creation, or Sandbox-owned command authorization.
- The shared interface does not offer a separate readiness or activation method;
  Compute owns both and retains its baseline isolation rules.

## Troubleshooting

| Symptom                                              | What to check                                                                                                                           |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Startup rejects the Sandbox                          | Check the Compute selection and that `facets` is nonempty, unique, and uses supported values.                                           |
| Deployment rejects the Harness                       | Confirm dedicated execution and that the provider can preserve the approved identity, token, mounts, login mode, and Secret references. |
| Cleanup keeps retrying after the Pod disappears      | Check the stable Sandbox resource reference and provider bootstrap resources. Pod absence alone does not prove cleanup completed.       |
| Containment is unavailable or ownership is ambiguous | Restore the provider or correct ownership. Never activate a workload without the required containment.                                  |
| A gateway request fails                              | Worker diagnostics carry only the method, gRPC status and a fixed validation category, never supplier text or request values.           |

## Implementations

- [OpenShell SandboxDriver](openshell-sandbox.md): bundled implementation, paired
  with the OpenShell Credential Gateway through an `openshell` Backend. Trusted
  YAML can also select an operator-installed Sandbox package, which cannot pair
  with a Credential Gateway.

## Related

- [Kubernetes ComputeDriver](kubernetes-compute.md) and [Compute Sandbox coordination](compute.md#sandboxdriver-coordination)
- [OCC deployment admission](../../../packages/occ/src/index.ts) and [Kubernetes Compute caller](../../../apps/controller/src/drivers/compute/kubernetes/index.ts)
- [OpenShell verification guide](../../testing/openshell.md)
