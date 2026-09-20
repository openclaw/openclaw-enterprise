# Driver documentation inventory

Use this inventory to locate each base Driver contract and plan consistent
coverage with the [base Driver documentation template](base-driver-docs-template.md).
It inventories the Enterprise tree at `06c23b9c`, before adding these contributor
pages. Coverage notes identify documentation work, not proposed runtime changes.

## Base contracts

The [shared interfaces](../../packages/contracts/src/index.ts) export seven
capability interfaces extending `Driver`. Six have dedicated base pages; Secret
currently points to an implementation page. The common `Driver` identity and
optional compute lifecycle hooks span these capabilities.

| Contract             | Current reference and coverage                                                                                                                                        | Template follow-up                                                                                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ComputeDriver        | [compute.md](../reference/drivers/compute.md): core lifecycle, preflight, Sandbox coordination, revision stages, logging, endpoints, maintenance, hooks, credentials. | Make required versus optional operations easy to scan together; retain the detailed lifecycle sections and link backend behavior out.                            |
| SandboxDriver        | [sandbox.md](../reference/drivers/sandbox.md): interface, facets, admission, lifecycle, provisioning inputs, resource identity.                                       | Use its ownership and cleanup explanations as a model; make failure and optional-hook behavior discoverable together.                                            |
| ConfigurationDriver  | [configuration.md](../reference/drivers/configuration.md): five operations, resource ownership, immutable snapshots, bundled storage behavior.                        | Separate Kubernetes/filesystem details from the shared storage contract when applying the template.                                                              |
| IAMDriver            | [iam.md](../reference/drivers/iam.md): lookup, authorization evidence, native policy behavior, installed-package boundary.                                            | Distinguish universal obligations from native implementation behavior while preserving installed-Driver policy requirements.                                     |
| ServiceAccountDriver | [service-account.md](../reference/drivers/service-account.md): creation, credential issuance, deletion, unsupported operations, bundled ChatGPT behavior.             | Separate shared credential/account boundaries from provider-specific behavior.                                                                                   |
| PluginDriver         | [plugin.md](../reference/drivers/plugin.md): catalogs, selection, native mappings, preparation, security, source evidence.                                            | Separate the exported catalog contract from bundled OpenClaw/Codex mappings and preparation behavior; do not imply those helpers are exported interface methods. |
| SecretDriver         | [kubernetes-secret.md](../reference/drivers/kubernetes-secret.md): backend setup, secret CRUD, env delivery, redeploy, troubleshooting.                               | Add a dedicated base contract in a later pass covering exported create/update/delete/resolve operations; keep Kubernetes procedures in their current owner.      |

The [target Driver design](../design/drivers.md) also names `InferenceDriver` and
`ChannelDriver`. Neither has an exported capability interface or base reference
in this snapshot. Keep them identified as target design rather than creating
current-contract pages from the design prose. See the
[implementation-status boundary](../design.md#implementation-status).

## Complete Driver reference directory

The directory contains 16 Markdown pages: six base pages listed above, seven
implementation pages (including two Kubernetes child pages), and three shared
selection/comparison pages.

| Class                   | Pages                                                                                                                                                                                          | Role in this work                                                                                                                                                                    |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Compute implementations | [Docker](../reference/drivers/docker-compute.md), [Kubernetes](../reference/drivers/kubernetes-compute.md), [SSH](../reference/drivers/ssh-compute.md)                                         | Link from the base contract; retain backend setup, limits, and troubleshooting here.                                                                                                 |
| Kubernetes detail       | [Networking and isolation](../reference/drivers/kubernetes-compute/networking-and-isolation.md), [Storage and credentials](../reference/drivers/kubernetes-compute/storage-and-credentials.md) | Implementation-specific contract detail.                                                                                                                                             |
| Sandbox implementation  | [OpenShell](../reference/drivers/openshell-sandbox.md)                                                                                                                                         | Backend ownership, configuration, prerequisites, and troubleshooting.                                                                                                                |
| Secret implementation   | [Kubernetes Secret](../reference/drivers/kubernetes-secret.md)                                                                                                                                 | Currently serves both base and implementation readers. Counted once as an implementation page.                                                                                       |
| Shared selection        | [Selection and package contracts](../reference/drivers/selection.md)                                                                                                                           | Canonical selection, factories, package trust, loading, and startup failures; link instead of copying.                                                                               |
| Comparisons             | [Compute matrix](../reference/drivers/compute-matrix.md), [Plugin matrix](../reference/drivers/plugin-matrix.md)                                                                               | Compare implementation support, not define the base contract. Backed by [Compute data](../assets/compute-driver-matrix.json) and [Plugin data](../assets/plugin-driver-matrix.json). |

## Related documentation owners

| Owner                  | Existing pages                                                                                                                                                                                                                                                                                                                                                                                                                            | Relationship to a base contract                                                        |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Architecture           | [Driver design](../design/drivers.md), [current architecture](../ARCHITECTURE.md)                                                                                                                                                                                                                                                                                                                                                         | Target responsibilities versus implemented composition.                                |
| Runtime flows          | [Compute lifecycle hooks](../flows/compute-driver-lifecycle-hooks.md), [Driver package loading](../flows/driver-plugin-loading.md), [Configuration](../flows/configuration-driver.md), [Configuration persistence and revisions](../flows/configuration-driver/persistence-and-revisions.md), [service-account credential delivery](../flows/service-account-driver-credential-delivery.md), [SSH Compute](../flows/pr-24-ssh-compute.md) | Current source execution order; link for caller and handoff evidence.                  |
| Feature semantics      | [Configuration](../reference/configuration.md), [authorization](../reference/authorization.md), [service accounts](../reference/service-accounts.md), [plugins](../reference/agent-plugins.md), [Providers](../reference/providers.md), [Harness execution](../reference/harness-execution.md), [controller](../reference/controller.md)                                                                                                  | Own resource/API semantics and orchestration beyond a single Driver.                   |
| Verification           | [Testing index](README.md), [Docker](docker.md), [SSH](ssh.md), [Kubernetes](kubernetes.md), [OpenShell](openshell.md), [service accounts](service-accounts.md), [plugins](plugins.md)                                                                                                                                                                                                                                                    | Own test prerequisites, fixtures, proof, and coverage limitations.                     |
| Implementation records | [Plugin spec](../../specs/16-plugin-driver.md), [Provider/Driver abstraction](../../specs/17-provider-driver-abstraction.md) and its [contract](../../specs/17-provider-driver-abstraction/contract.md), [SSH spec](../../specs/21-ssh-compute-driver.md) and its [contract](../../specs/21-ssh-compute-driver/contract.md), [Compute matrix report](../../specs/reports/compute-driver-matrix.md)                                        | Preserve proposal and delivery history; do not treat these as current base references. |

## Suggested application order

1. Apply the template to Compute and Sandbox as representative lifecycle and
   coordination contracts, verifying optional hooks and their callers.
2. Give SecretDriver a base page and correct the feature index and selection
   table to distinguish it from Kubernetes Secret setup.
3. Apply the same coverage to Configuration, IAM, ServiceAccount, and Plugin;
   move backend details only where an implementation owner has been established.

The [ComputeDriver contract](../reference/drivers/compute.md) now applies the
eight-section template, including a dedicated IAM section. The table above
records the baseline inventory; the other contract and implementation pages
remain unchanged.
