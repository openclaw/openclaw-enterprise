# SandboxDriver contract

`SandboxDriver` is an optional Installation-selected Driver that confines Agent
Harnesses across one or more containment facets: networking, filesystem, or
process. OCC owns driver selection, authorization, and immutable revision
admission; the selected
[ComputeDriver](compute.md) owns workload orchestration. A SandboxDriver
can provision a dedicated Harness without becoming a ComputeDriver.

Current startup supports Sandbox selection only with the bundled Kubernetes
Compute Driver. A selected Sandbox package does not make Docker or
an installed Compute package a supported Sandbox composition. See
[Driver selection](selection.md) for the package boundary.

## Driver interface

The exported interface is in
[shared contracts](../../../packages/contracts/src/index.ts).

```ts
type SandboxFacet = "networking" | "filesystem" | "process";

interface SandboxDriver extends Driver {
  readonly capability: "sandbox";
  readonly facets: readonly SandboxFacet[];

  configureAgent?(
    configuration: Readonly<OpenClawConfigurationDocument>,
  ): OpenClawConfigurationDocument;

  ensureNamespace?(context: SandboxNamespaceContext): Promise<void>;

  provisionHarness?(context: SandboxHarnessContext): Promise<SandboxResourceRef>;

  cleanup(
    context: SandboxNamespaceContext & {
      readonly revision?: Readonly<AgentRevision>;
    },
  ): Promise<void>;
}
```

The selected provider must implement and declare at least one containment facet.
Each facet is optional; any nonempty subset is supported. Empty, unknown, or
duplicate facet declarations fail closed. There is no `exec` facet; command
authorization and per-tool Sandbox creation remain deferred.

## Containment facets

| Facet        | Provider responsibility                                                              |
| ------------ | ------------------------------------------------------------------------------------ |
| `networking` | Restrict Harness connections to explicitly approved destinations and peers.          |
| `filesystem` | Preserve approved image paths and Agent-owned read-only or writable workspace paths. |
| `process`    | Enforce the approved process identity, capabilities, and operating-system limits.    |

Compute retains tenant isolation, NetworkPolicies, workload identity, approved
workspace ownership, and routing. Provider policies cannot relax those existing
boundaries.

## Admission and lifecycle

1. OCC invokes optional `configureAgent` before validating and freezing the
   effective Agent configuration.
2. The immutable revision stores only the selected `sandboxDriverId`; it does
   not duplicate the driver's implementation or declared facets.
3. Compute prepares the exact Namespace and baseline isolation before invoking
   optional `ensureNamespace`.
4. Compute prepares the Agent gateway, ServiceAccount, workspace, Services,
   routing resources, and exact Harness requirements.
5. If `provisionHarness` exists, the provider creates the dedicated Harness
   workload and returns its stable Sandbox identity. Otherwise, Compute creates
   the ordinary Harness workload.
6. Compute waits for normal exact-revision readiness before activating routing.
7. Revision retirement in the owned Namespace always invokes `cleanup` for the
   selected provider. If Compute owns the ordinary Harness workload, it stops
   that workload first; an already-absent workload does not skip provider
   cleanup. If the provider owns the Harness, `cleanup` removes that Sandbox.
   Namespace deletion invokes `cleanup` without a revision to remove provider
   bootstrap resources.

Namespace setup, provisioning, and cleanup must be idempotent. Unsupported
topologies, missing prerequisites, ambiguous resources, failed identity checks,
and unavailable containment fail closed. A revision cleanup failure blocks the
remaining retirement steps and is retried; it cannot be treated as completed
merely because the Compute-owned workload is already absent.

## Provisioning inputs

`SandboxNamespaceContext` contains the exact admitted Namespace, the
Compute-provided Kubernetes client, and an operation cancellation signal.
`SandboxHarnessContext` also includes the immutable `AgentRevision` and its
approved `HarnessWorkloadRequirements`:

- Harness image and explicit startup command.
- Exact Agent ServiceAccount name.
- Projected ServiceAccount token audience, bounded expiration, mount path,
  token filename, and read-only mount requirement.
- Approved Agent-owned PVC subpaths and read-only or writable mount modes.
- Literal environment values or exact Kubernetes `secretKeyRef` references.
- Immutable Agent and revision workload labels.

Providers must preserve these requirements without exposing Secret values in
configuration, revision metadata, logs, or provider requests. A provider that
cannot realize the exact workload identity or credential references must fail
closed.

## Sandbox resource identity

`SandboxResourceRef` identifies the exact provider-owned resource:

```ts
interface SandboxResourceRef {
  readonly namespaceName: string;
  readonly resourceName: string;
  readonly agentId: string;
  readonly revisionId: string;
}
```

The reference remains stable when a controller replaces the underlying Pod.
Retirement must locate and remove the exact provider resource even when its
Pod is absent.

## Implementations

- [OpenShell SandboxDriver](openshell-sandbox.md)
- [Kubernetes ComputeDriver](kubernetes-compute.md)
