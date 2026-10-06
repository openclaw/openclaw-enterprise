# RFCs and implementation plans

Find a decision or delivery record below. Follow the
[specification process](../docs/contributing/specifications.md) for document
choice, numbering, lifecycle, and the repository-local spec skill. Current
supported behavior belongs in [feature references](../docs/reference/README.md),
and the [platform design](../docs/design.md) owns current architecture.

<a id="implementation-specifications"></a>
<a id="lifecycle"></a>

RFCs live in `rfcs/`. All implementation plans live directly in `plans/`, with
an `rfc` frontmatter link when relevant. RFC-linked plans reuse the RFC number;
independent plans keep their own numbering sequence.
New documents use single files by default. Documents with companions use
`<number>-<topic>/index.md` inside their folder. Store status and verification limits
in their owning document, rather than repeating them in this index.
RFC entry points record their decision in `status` frontmatter; companion notes
link to that entry point through `rfc` frontmatter.

Start a new proposal from the [RFC template](../docs/contributing/rfc-template.md)
or use `$spec rfc <description>`.

Existing filenames and recorded statuses are preserved, including duplicate
numeric prefixes and date-based names. Use full filenames for those historical
IDs. Mixed design-and-delivery documents remain intact. Historical audit and
verification evidence now lives beside its owning plan or as an existing delivery
record under `plans/`; there is no separate reports workflow.

Historical records keep the terminology they were written with. Current names
are **OCE** (OpenClaw Enterprise) and **OCC** (OpenClaw Control Plane).

## Active specifications

This is the non-archived inventory, including completed records. A document's
recorded status is not proof of current implementation or release availability.

| Workstream                                                  | RFC                                                               | Implementation plan or delivery record                                    |
| ----------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Agent access                                                | [Decision](rfcs/36-agent-access.md)                               | —                                                                         |
| Agent creation, channels, and revision inspection           | —                                                                 | [Plan / record](plans/19-console-agent-management.md)                     |
| Agent deletion and revision teardown                        | —                                                                 | [Plan / record](plans/28-agent-deletion.md)                               |
| Agent egress for 0.x                                        | [Decision](rfcs/40-agent-egress-0x/index.md)                      | —                                                                         |
| Agent native admin UI pilot                                 | —                                                                 | [Plan / record](plans/31-agent-native-admin-ui.md)                        |
| Agent plugin drivers                                        | —                                                                 | [Plan / record](plans/16-plugin-driver.md)                                |
| Agent presets                                               | —                                                                 | [Plan / record](plans/33-agent-presets.md)                                |
| Agent stop without revision mutation                        | —                                                                 | [Plan / record](plans/29-agent-stop.md)                                   |
| Agent workload tags                                         | [Decision](rfcs/21-agent-workload-tags.md)                        | —                                                                         |
| Architecture and security audit                             | —                                                                 | [Plan / record](plans/2026-09-01-architecture-security-audit/index.md)    |
| Asynchronous Agent provisioning                             | —                                                                 | [Plan / record](plans/35-agent-provisioning.md)                           |
| Basic RBAC for personal and team Agents                     | [Decision](rfcs/31-basic-rbac/index.md)                           | —                                                                         |
| Bootstrap administrator service account                     | —                                                                 | [Plan / record](plans/16-bootstrap-admin-service-account/index.md)        |
| Common OpenTelemetry logging                                | —                                                                 | [Plan / record](plans/20-common-otel-logging/index.md)                    |
| ComputeDriver matrix refresh                                | —                                                                 | [Plan / record](plans/2026-09-16-compute-driver-matrix.md)                |
| Console Agent plugin selection                              | —                                                                 | [Plan / record](plans/27-console-agent-plugins.md)                        |
| Contributor recognition                                     | —                                                                 | [Plan](plans/0042-contributor-recognition.md)                             |
| Shared tenant namespace                                     | —                                                                 | [Plan / record](plans/0043-shared-tenant-namespace.md)                    |
| Control-plane Gateway placement execution plan              | —                                                                 | [Plan / record](plans/36-control-plane-gateways-plan.md)                  |
| Credential Gateway Driver for Sandbox-injected credentials  | [Decision](rfcs/39-sandbox-credential-injection.md)               | —                                                                         |
| Dedicated Harness RWO workspace execution plan              | —                                                                 | [Plan / record](plans/38-harness-rwo-workspace-plan.md)                   |
| Default production observability                            | [Decision](rfcs/36-production-observability.md)                   | [Plan](plans/36-production-observability/index.md)                        |
| Deployment Simplification                                   | —                                                                 | [Plan / record](plans/18-deployment-simplification/index.md)              |
| Development end-to-end guide                                | —                                                                 | [Plan / record](plans/15-development-end-to-end-guide.md)                 |
| First Enterprise container release                          | —                                                                 | [Plan / record](plans/32-first-container-release.md)                      |
| Gateway–Harness storage split                               | [Decision](rfcs/28-gateway-harness-storage-split.md)              | —                                                                         |
| GitHub Actions integration and test coverage for Enterprise | —                                                                 | [Plan / record](plans/19-github-actions-test-coverage/index.md)           |
| Generic OIDC sign-in for existing accounts                  | [Decision](rfcs/0042-oidc-sign-in.md)                             | —                                                                         |
| GitHub sign-in for existing accounts                        | [Decision](rfcs/31-human-federated-sign-in/index.md)              | —                                                                         |
| Harness authentication bindings                             | [Decision](rfcs/30-harness-auth-binding.md)                       | —                                                                         |
| Independent image and chart publication                     | —                                                                 | [Plan / record](plans/41-independent-image-chart-publication.md)          |
| Independent production image upgrades                       | [Decision](rfcs/36-coordinated-image-upgrade.md)                  | —                                                                         |
| Initial Agent workspace files                               | —                                                                 | [Plan / record](plans/34-agent-workspace-files-setup.md)                  |
| Initial OCC Prometheus metrics                              | [Decision](rfcs/28-occ-prometheus-metrics.md)                     | [Plan](plans/28-occ-prometheus-metrics-plan.md)                           |
| Installation profiles: openclaw and codex                   | [Decision](rfcs/2026-09-28-installation-profiles-design/index.md) | —                                                                         |
| Native OpenClaw plugin tool policies                        | [Decision](rfcs/35-native-plugin-tool-policy.md)                  | —                                                                         |
| OCC Gateway Administration and Command Proxy                | —                                                                 | [Plan / record](plans/15-occ-gateway-access/index.md)                     |
| OpenShell first-Agent dedicated Codex                       | —                                                                 | [Plan](plans/0044-openshell-first-agent-codex.md)                         |
| Platform audit                                              | [Decision](rfcs/37-platform-audit/index.md)                       | —                                                                         |
| Plugin policy enforcement                                   | [Decision](rfcs/37-plugin-policy-enforcement.md)                  | —                                                                         |
| Production interactive TUI                                  | —                                                                 | [Plan / record](plans/16-production-tui-end-to-end.md)                    |
| Provider and related Drivers                                | —                                                                 | [Plan / record](plans/17-provider-driver-abstraction/index.md)            |
| Recover repository credential cleanup after broker loss     | [Decision](rfcs/39-repository-credential-recovery.md)             | —                                                                         |
| Repository credentials for ordinary Agents                  | [Decision](rfcs/31-repository-credentials/index.md)               | —                                                                         |
| Repository selection and inherited access                   | —                                                                 | [Plan / record](plans/37-repository-picker-and-access.md)                 |
| SSH Compute Driver for raw hosts                            | —                                                                 | [Plan / record](plans/21-ssh-compute-driver/index.md)                     |
| Storage split: shared interface and integration             | —                                                                 | [Plan / record](plans/30-storage-split-integration.md)                    |
| Two-cluster dedicated Gateway execution plan                | —                                                                 | [Plan / record](plans/37-two-cluster-gateway-execution-plan.md)           |
| Workspace enrollment without a Harness restart              | —                                                                 | [Plan / record](plans/40-workspace-enrollment-without-harness-restart.md) |

## Archived specifications

The existing `.archive/` keeps its content and placement; console-image links
point to a preserved Git revision after removal of `specs/assets/`. The entries below preserve
its earlier index, including recorded statuses and current-reference links.
Archive placement does not establish completion. New completed or superseded
RFCs and plans stay in their own folders. Historical commands and source links
may describe an older revision; use the [testing guide](../docs/testing/README.md)
for current verification procedures.

| Implementation record                                                                                                                                    | Recorded status                                                                                           | Current reference                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Platform console bootstrap](.archive/18-platform-console.md)                                                                                            | Completed; locally verified in [PR #12](https://github.com/openclaw/openclaw-enterprise/pull/12)          | [Platform console](../docs/reference/console.md), [Providers](../docs/reference/backends.md), [Authentication](../docs/reference/authentication.md) |
| [Bootstrap default Namespace](.archive/19-bootstrap-default-namespace.md)                                                                                | Completed; locally verified in PR #11                                                                     | [Namespaces](../docs/reference/namespaces.md#initial-namespace)                                                                                     |
| [Milestone 1.2: Initial OCC API](.archive/01-initial-platform/milestones/1.2-initial-occ-api.md)                                                         | draft                                                                                                     | [API reference](../docs/reference/api.md)                                                                                                           |
| [Milestone 1.3: PostgreSQL Persistence](.archive/01-initial-platform/milestones/1.3-postgresql-persistence.md)                                           | implemented                                                                                               | [Controller reconciliation](../docs/reference/controller.md)                                                                                        |
| [Feature Spec: Milestone 1.4 — Bootstrap, Namespaces, and IAM](.archive/01-initial-platform/milestones/1.4-bootstrap-namespaces-iam.md)                  | implemented                                                                                               | [Namespaces](../docs/reference/namespaces.md), [authorization](../docs/reference/authorization.md)                                                  |
| [Feature Spec: Milestone 1.5 — OCC Controller](.archive/01-initial-platform/milestones/1.5-occ-controller.md)                                            | implemented                                                                                               | [Controller reconciliation](../docs/reference/controller.md)                                                                                        |
| [Feature Spec: Milestone 1.6 — Agents and Immutable AgentRevisions](.archive/01-initial-platform/milestones/1.6-agents-and-immutable-agent-revisions.md) | implemented                                                                                               | [Agents](../docs/reference/agents.md)                                                                                                               |
| [Feature Spec: Milestone 1.7 — Local Test Drivers](.archive/01-initial-platform/milestones/1.7-local-test-drivers.md)                                    | implemented                                                                                               | Removed; historical implementation only                                                                                                             |
| [Feature Spec: Configuration Driver and Driver-Owned Schemas](.archive/03-configuration-driver.md)                                                       | Completed                                                                                                 | [ConfigurationDriver](../docs/reference/drivers/configuration.md)                                                                                   |
| [Feature Spec: Compute Driver Lifecycle Hooks](.archive/04-compute-driver-lifecycle-hooks.md)                                                            | Completed                                                                                                 | [ComputeDriver](../docs/reference/drivers/compute.md)                                                                                               |
| [Feature Spec: Production Kubernetes Packaging and Agent Wireup](.archive/04-production-kubernetes-wireup.md)                                            | Implemented; pending review                                                                               | [Kubernetes Compute](../docs/reference/drivers/kubernetes-compute.md)                                                                               |
| [Feature Spec: OpenClaw-Native Namespace Configuration](.archive/05-openclaw-native-configuration.md)                                                    | Completed                                                                                                 | [Configuration](../docs/reference/configuration.md)                                                                                                 |
| [Feature Spec: Configuration Kind and Agent-Owned Gateways](.archive/06-configuration-kind.md)                                                           | Completed                                                                                                 | [Configuration](../docs/reference/configuration.md)                                                                                                 |
| [Feature Spec: Harness Execution Topology](.archive/07-harness-execution-topology.md)                                                                    | Implementation                                                                                            | [Harness execution](../docs/reference/harness-execution.md)                                                                                         |
| [Feature Spec: Configuration-Native Agent Channels](.archive/08-configuration-native-agent-channels.md)                                                  | Planning                                                                                                  | [Configuration](../docs/reference/configuration.md)                                                                                                 |
| [Feature Spec: Installation-scoped Driver package extensions](.archive/09-driver-plugin-installation.md)                                                 | Complete                                                                                                  | [Driver selection and packages](../docs/reference/drivers/selection.md)                                                                             |
| [Feature Spec: Local Email and Password Authentication](.archive/10-local-password-authentication.md)                                                    | Completed                                                                                                 | [Authentication](../docs/reference/authentication.md)                                                                                               |
| [Feature Spec: Native Service Accounts](.archive/10-native-service-accounts.md)                                                                          | Planning                                                                                                  | [Service accounts](../docs/reference/service-accounts.md)                                                                                           |
| [Feature Spec: Docker Compose development and Docker Compute Driver](.archive/11-docker-compute-driver.md)                                               | Completed                                                                                                 | [Docker Compute](../docs/reference/drivers/docker-compute.md)                                                                                       |
| [Feature Spec: ChatGPT Service Account Driver](.archive/11-service-account-driver.md)                                                                    | Planning                                                                                                  | [Service accounts](../docs/reference/service-accounts.md)                                                                                           |
| [Feature Spec: Dedicated Harness Shared Workspace Drive](.archive/12-dedicated-harness-shared-workspace-drive.md)                                        | Planning                                                                                                  | [Harness execution](../docs/reference/harness-execution.md)                                                                                         |
| [Feature Spec: Existing Kubernetes Tenant Namespaces](.archive/12-kubernetes-existing-namespaces.md)                                                     | Implemented; live Kubernetes verification requires a disposable cluster                                   | [Kubernetes Compute](../docs/reference/drivers/kubernetes-compute.md)                                                                               |
| [Integration Plan: SandboxDriver OpenShell Kubernetes](.archive/13-sandbox-driver-provisioning.integ.md)                                                 | draft                                                                                                     | [SandboxDriver](../docs/reference/drivers/sandbox.md)                                                                                               |
| [Proposal: SandboxDriver Provisioning and Lifecycle](.archive/13-sandbox-driver-provisioning.md)                                                         | draft                                                                                                     | [SandboxDriver](../docs/reference/drivers/sandbox.md)                                                                                               |
| [Feature Spec: Service API keys](.archive/13-service-api-keys.md)                                                                                        | Implementation complete                                                                                   | [Authentication](../docs/reference/authentication/service-api-keys.md#service-api-keys)                                                             |
| [Feature Spec: SecretDriver storage and delivery](.archive/14-secret-driver.md)                                                                          | Implemented and verified for Namespace-owned Secret storage and delivery; broader runtime limits recorded | [Kubernetes Secret Driver](../docs/reference/drivers/kubernetes-secret.md)                                                                          |
| [Basic egress proxy (C0-C3)](.archive/31-basic-egress-proxy/architecture.md)                                                                             | Superseded; deferred for 0.x, no installed behavior                                                       | [Credential Gateway](../docs/reference/drivers/credential-gateway.md)                                                                               |
