# Driver documentation inventory

Use this inventory to locate each base Driver contract and plan consistent
coverage with the [base Driver documentation template](base-driver-docs-template.md).
The original inventory used Enterprise commit `06c23b9c`; this page reflects the
base-contract rewrite and links to the current owners. It does not propose runtime
changes.

## Base contracts

The [shared interfaces](../packages/contracts/src/index.ts) export seven
capability interfaces extending `Driver`. Each now has a dedicated base page.
The common `Driver` identity and optional compute lifecycle hooks span these
capabilities.

| Contract             | Current base reference                                                                                                           | Implementation or adjacent owner                                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| ComputeDriver        | [Compute](reference/drivers/compute.md): Namespace and revision operations, IAM, startup, activation, logging, and maintenance.  | [Compute feature matrix](reference/drivers/compute-matrix.md)                                                          |
| SandboxDriver        | [Sandbox](reference/drivers/sandbox.md): facets, optional provisioning, identity, cleanup, and Compute coordination.             | [OpenShell](reference/drivers/openshell-sandbox.md)                                                                    |
| ConfigurationDriver  | [Configuration](reference/drivers/configuration.md): five storage methods, IAM, generations, and immutable revision snapshots.   | [Kubernetes Configuration storage](reference/configuration/kubernetes.md)                                              |
| IAMDriver            | [IAM](reference/drivers/iam.md): identity lookup, decisions, policy freshness, revocation, and installed-Driver requirements.    | [Authorization](reference/authorization.md)                                                                            |
| ServiceAccountDriver | [ServiceAccount](reference/drivers/service-account.md): provider accounts, separate credential issuance, deletion, and recovery. | [Service accounts](reference/service-accounts.md) and [Backends](reference/backends.md)                                |
| PluginDriver         | [Plugin](reference/drivers/plugin.md): catalog interface, IAM, revision selection, and Compute ownership.                        | [Bundled Plugin Drivers](reference/drivers/plugin-bundled.md) and [feature matrix](reference/drivers/plugin-matrix.md) |
| SecretDriver         | [Secret](reference/drivers/secret.md): create, update, delete, resolve, safe delivery references, and permissions.               | [Kubernetes Secret](reference/drivers/kubernetes-secret.md)                                                            |

The [target Driver design](design/drivers.md) also names `InferenceDriver` and
`ChannelDriver`. Neither has an exported capability interface or base reference
in this snapshot. Keep them identified as target design rather than creating
current-contract pages from the design prose. See the
[implementation-status boundary](design.md#implementation-status).

## Complete Driver reference directory

The directory contains 18 Markdown pages: seven base pages listed above, eight
implementation pages (including two Kubernetes child pages), and three shared
selection/comparison pages.

| Class                   | Pages                                                                                                                                                                                    | Role in this work                                                                                                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Compute implementations | [Docker](reference/drivers/docker-compute.md), [Kubernetes](reference/drivers/kubernetes-compute.md), [SSH](reference/drivers/ssh-compute.md)                                            | Link from the base contract; retain backend setup, limits, and troubleshooting here.                                                                                           |
| Kubernetes detail       | [Networking and isolation](reference/drivers/kubernetes-compute/networking-and-isolation.md), [Storage and credentials](reference/drivers/kubernetes-compute/storage-and-credentials.md) | Implementation-specific contract detail.                                                                                                                                       |
| Sandbox implementation  | [OpenShell](reference/drivers/openshell-sandbox.md)                                                                                                                                      | Backend ownership, configuration, prerequisites, and troubleshooting.                                                                                                          |
| Secret implementation   | [Kubernetes Secret](reference/drivers/kubernetes-secret.md)                                                                                                                              | Owns Kubernetes setup and operator procedures; the base Secret contract has its own page.                                                                                      |
| Plugin implementations  | [Bundled OpenClaw and Codex](reference/drivers/plugin-bundled.md)                                                                                                                        | Owns native selection, mappings, preparation, and implementation proof.                                                                                                        |
| Shared selection        | [Selection and package contracts](reference/drivers/selection.md)                                                                                                                        | Canonical selection, factories, package trust, loading, and startup failures; link instead of copying.                                                                         |
| Comparisons             | [Compute matrix](reference/drivers/compute-matrix.md), [Plugin matrix](reference/drivers/plugin-matrix.md)                                                                               | Compare implementation support, not define the base contract. Backed by [Compute data](assets/compute-driver-matrix.json) and [Plugin data](assets/plugin-driver-matrix.json). |

## Related documentation owners

| Owner                  | Existing pages                                                                                                                                                                                                                                                                                                                                                                                                          | Relationship to a base contract                                                        |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Architecture           | [Driver design](design/drivers.md), [platform architecture](design.md)                                                                                                                                                                                                                                                                                                                                                  | Target responsibilities versus implemented composition.                                |
| Runtime flows          | [Compute lifecycle hooks](flows/compute-driver-lifecycle-hooks.md), [Driver package loading](flows/driver-plugin-loading.md), [Configuration](flows/configuration-driver.md), [Configuration persistence and revisions](flows/configuration-driver/persistence-and-revisions.md), [service-account credential delivery](flows/service-account-driver-credential-delivery.md), [SSH Compute](flows/pr-24-ssh-compute.md) | Current source execution order; link for caller and handoff evidence.                  |
| Feature semantics      | [Configuration](reference/configuration.md), [authorization](reference/authorization.md), [service accounts](reference/service-accounts.md), [plugins](reference/agent-plugins.md), [Backends](reference/backends.md), [Harness execution](reference/harness-execution.md), [controller](reference/controller.md)                                                                                                       | Own resource/API semantics and orchestration beyond a single Driver.                   |
| Verification           | [Testing index](testing/README.md), [Docker](testing/docker.md), [SSH](testing/ssh.md), [Kubernetes](testing/kubernetes.md), [OpenShell](testing/openshell.md), [service accounts](testing/service-accounts.md), [plugins](testing/plugins.md)                                                                                                                                                                          | Own test prerequisites, fixtures, proof, and coverage limitations.                     |
| Implementation records | [Plugin spec](../specs/16-plugin-driver.md), [Provider/Driver abstraction](../specs/17-provider-driver-abstraction.md) and its [contract](../specs/17-provider-driver-abstraction/contract.md), [SSH spec](../specs/21-ssh-compute-driver.md) and its [contract](../specs/21-ssh-compute-driver/contract.md), [Compute matrix report](../specs/reports/compute-driver-matrix.md)                                        | Preserve proposal and delivery history; do not treat these as current base references. |

## Maintaining the contracts

All seven exported capabilities now use the [eight-section template](base-driver-docs-template.md),
including dedicated IAM and Troubleshooting sections. Keep shared guarantees in
the base pages. Put backend setup and native policy details with their linked
implementation owners; add new current contracts only when their interfaces
and callers exist.

### Suggested application order

For a future Driver change, update its base contract first, then the affected
implementation pages, selection references, and feature navigation.
