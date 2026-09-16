# Feature reference

These living specifications describe supported OpenClaw Enterprise behavior at
this repository version: ownership, lifecycle, permissions, interface guarantees,
failure behavior, and current limitations. They contain the complete current
contract for each feature, including changes delivered by multiple implementation
specifications. They are not proposals or promises of future capabilities.

The [platform design](../design.md) remains the architectural authority. Its
target scope can exceed the current implementation; the
[architecture overview](../ARCHITECTURE.md) identifies implemented components.
Use the [quickstart](../guides/quickstart.md) or [deployment guide](../guides/deploy.md)
for deployment procedures, the [observability guide](../guides/observability.md)
for logging and Collector setup, and [flow docs](../README.md#understand-the-code)
for source execution. Contributor test setup, fixtures, hooks, and coverage
belong in the [testing guides](../testing/README.md).
Use [`deploy/runtime`](../../deploy/runtime/README.md) to build an OpenClaw/Codex
runtime image for local deployment.

## Features

| Reference                                         | Owns                                                                                 |
| ------------------------------------------------- | ------------------------------------------------------------------------------------ |
| [Platform console](console.md)                    | Login, Agent creation, draft channels, revision inspection, and Namespace selection. |
| [Namespaces](namespaces.md)                       | Tenant identity, placement, readiness, and deletion.                                 |
| [Agents](agents.md)                               | Agent identity, mutable selection, immutable revisions, and workspace file routes.   |
| [Gateway routing with Envoy](gateway-routing.md)  | Private Agent endpoints, service keys, TLS, and network enforcement.                 |
| [Configuration](configuration.md)                 | Native documents, generations, references, and snapshots.                            |
| [Secrets](drivers/kubernetes-secret.md)           | Namespace-owned Secret storage, metadata-only responses, env bindings, and redeploy. |
| [Authentication](authentication.md)               | Supported caller credentials, sessions, bootstrap, and account provisioning.         |
| [Authorization](authorization.md)                 | Principals, Groups, Roles, Bindings, Restrictions, and exact-resource decisions.     |
| [Providers](providers.md)                         | Provider configuration, related Drivers, client ownership, and Agent references.     |
| [Service accounts](service-accounts.md)           | Account associations, credential references, issuance, and revocation boundaries.    |
| [Agent plugins](agent-plugins.md)                 | Agent-owned curated selections, startup validation, and native runtime policy.       |
| [Harness execution](harness-execution.md)         | Runtime selection, topology, and admitted execution constraints.                     |
| [Controller reconciliation](controller.md)        | Durable lifecycle work, authorization refresh, claims, retries, and recovery.        |
| [Platform repositories](platform-repositories.md) | Callback transaction lifetimes, read-only views, and storage ownership.              |
| [Security](security.md)                           | Kubernetes workload and credential boundaries and enforcement limitations.           |
| [Settings](settings.md)                           | Supported environment variables and programmatic configuration.                      |
| [HTTP API](api.md)                                | Generated routes, wire schemas, and declared permissions.                            |

Generated schemas describe wire shape. The feature pages additionally own
behavioral rules such as cross-resource ownership, lifecycle ordering, and failure
effects. Contributors updating routes or schemas should follow the
[API generation checks](../testing/local.md#repository-and-tooling-configuration).

## Drivers

The term **contract** names obligations that callers and Driver implementations
must satisfy. It is part of the reference, not another document lifecycle.

- [ComputeDriver feature matrix](drivers/compute-matrix.md): compare bundled
  implementations with pinned source evidence.
- [Driver selection](drivers/selection.md): trusted configuration, package loading,
  capability selection, and compatibility boundaries.
- [ComputeDriver](drivers/compute.md), [SandboxDriver](drivers/sandbox.md),
  [ConfigurationDriver](drivers/configuration.md), [IAMDriver](drivers/iam.md),
  [SecretDriver](drivers/kubernetes-secret.md), and
  [ServiceAccountDriver](drivers/service-account.md), and
  [PluginDriver](drivers/plugin.md): capability contracts.
- [Docker Compute](drivers/docker-compute.md),
  [Kubernetes Compute](drivers/kubernetes-compute.md),
  [SSH Compute](drivers/ssh-compute.md), and
  [OpenShell Sandbox](drivers/openshell-sandbox.md): implementation settings,
  supported behavior, and limitations.

Change a reference in the same PR that changes its supported behavior. Keep
proposal rationale, implementation tasks, and historical alternatives in
[top-level implementation specs](../../specs/README.md); keep runtime traces in
`docs/flows/`. Reference pages use stable feature names rather than milestone numbers.
