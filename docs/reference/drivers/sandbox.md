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
required `facets` and `cleanup` members, plus three optional methods.

| Member                          | Contract                                                                                                                                                                         |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `facets`                        | Declare at least one distinct facet. Unknown, duplicate, or empty declarations are rejected.                                                                                     |
| `configureAgent(configuration)` | Optional synchronous transform. OCC passes a read-only native configuration and validates and freezes the returned configuration. If absent, the original configuration is used. |
| `ensureNamespace(context)`      | Optional backend preparation after Compute has prepared baseline Namespace isolation. If absent, Compute continues without a Sandbox setup call.                                 |
| `provisionHarness(context)`     | Optional creation of the dedicated Harness; returns a stable Sandbox resource reference. If absent, Compute creates the ordinary Harness workload.                               |
| `cleanup(context)`              | Required for revision stop, retirement, and Namespace cleanup. Revision cleanup receives the immutable revision; Namespace cleanup omits it.                                     |

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
explicit Harness login mode, and Agent/revision labels. Sandbox must use these
prepared values rather than guessing login mode or resolving another credential.

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

1. Before deployment, OCC calls optional `configureAgent`, then validates and
   freezes the resulting Configuration. The revision records the selected
   `sandboxDriverId`, not the implementation or facet list.
2. Compute prepares Namespace isolation and calls optional `ensureNamespace`.
   It prepares the Agent gateway, identity, workspace, Services, and routing.
3. The Sandbox provisions the dedicated Harness if it implements
   `provisionHarness`; otherwise Compute creates it. Compute waits for the exact
   revision workload before activating traffic.
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

- [OpenShell SandboxDriver](openshell-sandbox.md): bundled implementation. Trusted
  YAML can also select an operator-installed Sandbox package.

## Related

- [Kubernetes ComputeDriver](kubernetes-compute.md) and [Compute Sandbox coordination](compute.md#sandboxdriver-coordination)
- [OCC deployment admission](../../../packages/occ/src/index.ts) and [Kubernetes Compute caller](../../../apps/controller/src/drivers/compute/kubernetes/index.ts)
- [OpenShell verification guide](../../testing/openshell.md)
