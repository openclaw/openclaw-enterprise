# Agent gateways and deployment

This page owns the agent gateways and deployment portion of the authoritative
[platform target design](../design.md). Read it with the other design chapters;
the [current architecture](../ARCHITECTURE.md) describes implementation status.

## OpenClaw gateways

OCC manages exactly one OpenClaw gateway for each deployed Agent. A Namespace
may contain multiple gateways, each belonging to a different Agent. Every
gateway is an Agent-owned, Namespace-isolated data-plane component that routes
only its owner's Channel traffic and runtime requests. It is distinct from the
Ingress Gateway and OAG.

OCC establishes an Agent's gateway through the selected `ComputeDriver`'s
revision-scoped `prepareRevision` operation. The gateway and its Agent workload
use the same selected data plane and exact backing tenant boundary. The bundled
Kubernetes Driver uses the Installation-selected cluster and backing namespace.
The admitted Agent configuration configures both the gateway and workload and
exists before the gateway starts. Gateway ownership remains stable
across that Agent's revisions; deploying or deleting one Agent cannot recreate,
delete, reconfigure, or route through another Agent's gateway. Agent deletion
removes only its gateway; Namespace deletion removes every remaining owned
gateway through `deleteNamespace`.

OCC prepares a nonserving route for the candidate Agent workload and enables
it only after the candidate's revision is the sole active revision and its
Harness is ready. Gateway routing includes both Namespace and Agent identity.
A gateway, configuration, or route failure leaves the previously active
revision and its credentials inaccessible to any other revision; failed
replacement requires exact-owner rollback or fail-closed traffic denial.

The gateway is not a platform primitive, authorization authority, or additional
workload identity. OCC owns the Namespace, Agent, gateway lifecycle, route
bindings, active AgentRevision, and activation decisions; `ComputeDriver`
realizes the admitted gateway infrastructure. The gateway accepts only its
owner's authorized Channels and workload. It cannot admit a tenant, authorize a
platform operation, grant a Permission, or substitute one Agent's identity for
another.

Each Agent explicitly selects one Harness execution topology:

- `embedded`: one Agent-owned OpenClaw gateway process also runs the built-in
  Harness. The combined workload necessarily shares the exact Agent's
  ServiceAccount, projected `WorkloadIdentity`, and Agent-specific model
  credential; there is no separate Harness process. Development and production
  both support this topology.
- `dedicated`: the Agent-owned gateway connects to its own distinct Codex
  workload. They use separate Kubernetes ServiceAccounts and network access;
  only Codex receives the exact Agent's projected identity and either its
  operator-owned model API key or its associated account-owned access token.
  The gateway never assumes that identity or receives the model credential.

The selected Harness comes from the Agent's native provider/model configuration;
OCC snapshots its server-approved identity, version, and explicit execution
mode in each immutable revision. A native model catalog may offer multiple
models when every selectable entry explicitly resolves to the same approved
Harness and provider. The provider name alone does not determine the Harness:
an `openai/*` model explicitly routed through an enabled Codex websocket plugin
uses dedicated Codex execution. Sharing a Kubernetes namespace never grants
another Agent access to gateway credentials, Channel credentials, workload
identity, provider configuration, or runtime traffic.

## Agent deployment

An `Agent` is the stable, user-configured platform resource. Its explicit
`executionMode` is either `embedded` or `dedicated`. Its `Configuration`,
`ServiceAccount`, `Channel`, `Secret`, and `SandboxPolicy` references belong to
its Namespace; its native Configuration selects a Harness approved for the same
Installation. Its optional `providerId` references Installation-owned Provider
configuration; null preserves providerless Agents. It can also own desired
plugin selections independently of its reusable Configuration. One
Installation-selected PluginDriver validates and renders those selections during
revision startup.

Editing an Agent or one of its referenced resources changes only
the inputs available to a future deployment; it does not change an existing
`AgentRevision` or running Agent workload.

Deploying an Agent follows one path.

1. OAG verifies the caller's externally authenticated identity and admits the
   caller to the exact Installation and Namespace.
2. OCC authorizes deployment of the exact Agent and enforces applicable
   Restrictions through the authoritative `IAMDriver` for Agents.
3. OCC resolves the Agent's referenced `Configuration`, `ServiceAccount`,
   `Channel`, `Secret`, and `SandboxPolicy` resources, selects the approved
   Harness from native provider/model policy, and checks its explicit execution
   mode. Future `SecretBroker` references are outside the current deployment
   path.
4. Each separately protected reference receives its own allow decision from
   the authoritative `IAMDriver` for that exact resource.
5. OCC validates Namespace and Installation scope for every reference. It resolves
   the optional Provider and required related Drivers; a managed access token
   requires the exact private Provider, Driver, workspace, account, and issued
   credential binding.
6. OCC verifies that the exact backing tenant infrastructure is ready and that
   the selected `SandboxDriver` supports the entire `SandboxPolicy`. For the
   bundled Kubernetes Driver, that infrastructure is the backing namespace in
   the selected cluster.
7. OCC creates an immutable `AgentRevision` from the admitted Agent,
   configuration, references including nullable `providerId`, requested plugin
   selections, server-approved Harness identity/version and explicit mode,
   sandbox policy, and selected compute, sandbox, and plugin implementations.
8. OCC gives selected Drivers the same revision, exact Namespace, and
   stable Agent `WorkloadIdentity`. The worker rechecks Provider metadata and
   managed credential ownership after current IAM authorization and before effects.
9. The selected Compute Driver invokes revision-scoped `prepareRevision` to
   provision the exact Agent's configured gateway and requested topology.
   Embedded OpenClaw runs inside that gateway; dedicated Codex runs as a
   separate, nonserving candidate in the same namespace. Both topologies are
   supported in production. The
   gateway configuration exists before its process starts. A dedicated
   candidate app-server may start idle alongside the previous revision, but
   cannot receive traffic or execute Agent turns before activation.
10. `SandboxDriver` establishes and verifies the exact admitted policy before
    the candidate Agent workload can execute Agent turns.
11. OCC configures a nonserving route through the exact Agent-owned gateway for
    the candidate workload.
12. OCC records the ready candidate as the sole active revision and enables its
    exact Agent-owned route. Only that active revision can receive traffic or
    execute Agent turns.
13. Once the new route is active, OCC retires the previous revision. If
    activation or routing fails, it does not irreversibly delete the previous
    workload before recovery.

The active AgentRevision is the immutable record of the Agent's deployed
version. OCC serializes activation for each Agent and uses its single active
revision as the source of truth for Agent workload authorization and gateway
routing. A candidate app-server can start idle, but a candidate or retired
revision cannot receive traffic or execute Agent turns.
Failures before activation leave the previously active revision and Agent
workload unchanged. Failures after activation require fail-closed rollback.
