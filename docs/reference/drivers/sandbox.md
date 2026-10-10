# SandboxDriver contract

## Overview

`SandboxDriver` confines an Agent Harness's network, filesystem, or processes.
OpenClaw Control Plane (OCC) selects the Driver, authorizes deployment, and
freezes the revision. [ComputeDriver](compute.md) owns the gateway, workload
identity, baseline isolation, routing, and activation. Sandbox can create a
dedicated Harness while Compute keeps those responsibilities.

Selection is optional and currently works only with bundled Kubernetes Compute
and dedicated execution. Choosing an installed Sandbox does not enable Docker,
SSH, or installed Compute combinations. See [Driver selection](selection.md).

## Interface

### Driver interface

The [shared interface](../../../packages/contracts/src/index.ts) exposes the
required `facets` and `cleanup` members, an optional `harnessHome`, plus eight optional methods.

| Member                                   | Contract                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `facets`                                 | Declare at least one distinct facet. Unknown, duplicate, or empty declarations are rejected.                                                                                                                                                                                                                                    |
| `harnessHome`                            | Optional normalized absolute HOME of the Harness user inside the Sandbox. Compute renders Harness-local paths, such as the native hook credential directory, under it. Defaults to `/home/node`.                                                                                                                                |
| `configureAgent(configuration, harness)` | Optional synchronous transform. OCC passes the read-only native configuration and resolved Harness descriptor, then validates and freezes the returned configuration. The transform cannot change the selected Harness runtime. If absent, the original configuration is used.                                                  |
| `ensureNamespace(context)`               | Optional backend preparation after Compute has prepared baseline Namespace isolation. If absent, Compute continues without a Sandbox setup call.                                                                                                                                                                                |
| `provisionHarness(context)`              | Optional creation of the dedicated Harness; returns a stable Sandbox resource reference. If absent, Compute creates the ordinary Harness workload.                                                                                                                                                                              |
| `cleanup(context)`                       | Required for revision stop, retirement, and Namespace cleanup. Revision cleanup receives the immutable revision; Namespace cleanup omits it.                                                                                                                                                                                    |
| `harnessResource(context)`               | Optional. Returns the exact Sandbox reference `provisionHarness` creates for a revision, without side effects. Compute needs it to [withdraw a credential source](credential-gateway.md#optional-additions) from a running revision.                                                                                            |
| `readSandboxLogs(context, request)`      | Optional read of the revision's Sandbox log: at most `lines` raw lines at or after `sinceTime`, plus how many lines the source examined. It must use a read-only interface and derive the Sandbox from the revision. OCC classifies and redacts every line. See [Agent logs](../../guides/topics/agent-logs.md#sandbox-source). |

Two optional methods serve a provider-owned Harness transport.
`harnessEndpoint(context)` returns the transport for the provisioned Harness, and
Compute routes the Agent Gateway through it instead of its own Harness Service.
`harnessStatus(context)`, offered only with `harnessEndpoint`, observes that
transport with the Agent transport token. It answers `serving` only after an
authenticated handshake, or `failed` with the Harness's held startup failure,
which Compute validates and fails the revision with; anything else is `starting`.
Compute activates only a `serving` Harness.

`observeHarness(context)` reads the provider's own lifecycle record of a dedicated
revision's Harness Sandbox, without contacting the Harness. It answers `running`,
`starting`, `unknown`, or `lost` with a code: `SANDBOX_MISSING`, `SANDBOX_DELETING`,
`SANDBOX_STOPPED`, `SANDBOX_FAILED` (for example a deleted Pod) or `HARNESS_EXITED`.
OCC adds it to the runtime description and diagnostics, and reports a missing or
deleting Sandbox as lost only for the running Agent's active revision. Nothing
recovers a lost Sandbox until the Agent is deployed again. The OpenShell Driver
asks the gateway to restart an exited Harness (`restart_policy: ALWAYS`); while
the gateway restarts it, the observation is `starting` with code
`HARNESS_RESTARTING`, the last `exitCode` and the gateway's `restarts` number
(GetSandbox `exit_code` and `restart_count`, set together only during a policy
restart). A first start is plain `starting`. Diagnostics report a restarting
Harness as a failed `sandbox` check. Only Sandboxes created before that policy
existed report `HARNESS_EXITED`.

### Containment facets

| Facet        | What the Driver enforces                                                           |
| ------------ | ---------------------------------------------------------------------------------- |
| `networking` | Connections only to approved destinations and peers.                               |
| `filesystem` | Approved image paths and Agent-owned workspace paths, with their read/write modes. |
| `process`    | Approved process identity, capabilities, and operating-system limits.              |

### Provisioning inputs

`SandboxNamespaceContext` carries the Namespace, Compute's Kubernetes client,
and a cancellation signal. `SandboxHarnessContext` adds the immutable revision
and `HarnessWorkloadRequirements`: image and startup command, Agent ServiceAccount,
projected token audience/expiration/mount/path/read-only setting, approved PVC
subpaths and mount modes, literal environment or Kubernetes `secretKeyRef`,
explicit Harness login mode, `credentialAttachments`, and Agent/revision labels.
Sandbox must use these prepared values rather than guessing login mode or
resolving another credential.

`credentialAttachments` holds one opaque `{ sourceId, ref }` entry per
credential source the revision binds; it is empty otherwise. The selected
[CredentialGatewayDriver](credential-gateway.md) issues them, and only its
paired Sandbox can consume them. The Sandbox must apply every attachment and
reject any it did not issue. After the Harness is ready, Compute asks the
gateway whether each attachment is applied before activating the revision.

### Sandbox resource identity

`SandboxResourceRef` contains `namespaceName`, `resourceName`, `agentId`, and
`revisionId`. It stays stable when a controller replaces the underlying Pod;
retirement must find the provider resource even if that Pod is already gone.

## IAM

OCC authorizes the deployment and the applicable credential sources. The Driver
receives the approved Namespace, Agent revision, and workload identity; it cannot
choose another one or grant access. Compute retains tenant isolation,
NetworkPolicies, workspace ownership, identity, and routing. Sandbox policies
cannot relax those controls. If the Driver cannot use the exact identity or
credential references, it must fail. Never expose Secret values in
configuration, revision metadata, logs, or provider requests. See
[authorization](../authorization.md) and [Harness execution](../harness-execution.md).

## Lifecycle

### Admission and lifecycle

Startup validates the selected Sandbox and its declared facets. The shared
interface has no initializer or destructor; workload and Namespace removal use
the same cleanup operation with or without a revision.

Dedicated native OpenClaw requires a selected Sandbox that implements
`provisionHarness` and declares networking, filesystem, and process containment.
Other dedicated Harnesses may use a subset of facets or no Sandbox according to
their Compute contract.

1. Before deployment, OCC resolves the Harness, calls optional `configureAgent`
   with that descriptor, then validates and freezes the resulting Configuration.
   The revision records the selected
   `sandboxDriverId`, not the implementation or facet list.
2. Compute prepares Namespace isolation and calls optional `ensureNamespace`.
   It prepares the Agent gateway, identity, workspace, Services, and routing.
3. The Sandbox provisions the dedicated Harness if it implements
   `provisionHarness`; otherwise Compute creates it. Compute waits for the exact
   revision workload, and for every credential attachment to be `ready`, before
   activating traffic.
4. Stop and retirement call `cleanup` with the revision. If Compute owns the
   workload, it stops that workload first; its absence does not skip Sandbox
   cleanup. If Sandbox owns it, the method removes it.
5. Namespace deletion calls `cleanup` without a revision after revision cleanup
   and before Compute releases the Namespace. A failure prevents Compute from
   deleting the Namespace so provider cleanup can be retried safely.

Namespace setup, provisioning, and cleanup must be safe to repeat. Failed
revision cleanup remains retryable. Unsupported topology, missing prerequisites,
ambiguous resources, failed identity checks, or unavailable containment must
prevent progress rather than weakening isolation.

The worker retries driver errors as `DEPENDENCY_UNAVAILABLE`. When a driver
cannot run an exact revision and a retry cannot change that, it throws
`SandboxRevisionUnsupportedError` from `@openclaw-enterprise/occ` with a closed
code. The worker then fails the deployment with that code and a fixed message
at once. The driver's own message stays in the controller:
`SANDBOX_SECRET_ENVIRONMENT_UNSUPPORTED` (Secret-backed environment) and
`SANDBOX_HARNESS_UNSUPPORTED` (unsupported Harness).

## Limits

- Supported facets are `networking`, `filesystem`, and `process`; there is no
  `exec` facet, per-tool Sandbox creation, or Sandbox-owned command authorization.
- Sandbox selection currently requires bundled Kubernetes Compute and dedicated
  Harness execution. An installed Sandbox package does not broaden that support.
- The shared interface does not offer a separate readiness or activation method;
  Compute owns both and retains its baseline isolation rules.

## Troubleshooting

| Symptom                                              | What to check                                                                                                                           |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Startup rejects the Sandbox                          | Check the Compute selection and that `facets` is nonempty, unique, and uses supported values.                                           |
| Deployment rejects the Harness                       | Confirm dedicated execution and that the provider can preserve the approved identity, token, mounts, login mode, and Secret references. |
| Cleanup keeps retrying after the Pod disappears      | Check the stable Sandbox resource reference and provider bootstrap resources. Pod absence alone does not prove cleanup completed.       |
| Containment is unavailable or ownership is ambiguous | Restore the provider or correct ownership. Never activate a workload without the required containment.                                  |

## Implementations

- [OpenShell SandboxDriver](openshell-sandbox.md): bundled implementation, paired
  with the OpenShell Credential Gateway through an `openshell` Backend. Trusted
  YAML can also select an operator-installed Sandbox package, which cannot pair
  with a Credential Gateway.

## Related

- [Kubernetes ComputeDriver](kubernetes-compute.md) and [Compute Sandbox coordination](compute.md#sandboxdriver-coordination)
- [OCC deployment admission](../../../packages/occ/src/index.ts) and [Kubernetes Compute caller](../../../apps/controller/src/drivers/compute/kubernetes/index.ts)
- [OpenShell verification guide](../../testing/openshell.md)
