# Implementation specifications

[First Enterprise container release](32-first-container-release.md) — Implementing;
protected marker bootstrap and first private SHA-addressed controller/runtime publication.

This directory records individual proposals, implementation plans, milestones,
and delivery decisions. The documents describe work at a point in time. Their
existing filenames and historical content remain intact in [`.archive/`](.archive/).
A title containing “Feature Spec” does not make the document the current feature
specification.

For supported behavior at this repository version, use the
[living feature reference](../docs/reference/README.md). The
[platform design](../docs/design.md) remains the architectural authority. Source
execution belongs in [flow docs](../docs/README.md#understand-the-code), and startup
procedures belong in [quickstart](../docs/guides/quickstart.md) and
[deployment](../docs/guides/deploy.md).

## Lifecycle

New implementation specifications identify the current reference pages they will
change. Use `Proposed`, `Accepted`, `Implementing`, `Completed`, `Superseded`, or
`Rejected` to distinguish discussion, approval, delivery, and historical outcome.
Acceptance is permission to implement, not evidence of current availability.

Before marking work complete, record the actual outcome and implementation PR or
commit, verification limitations, and links to updated current reference. Update
affected guides and flows in the implementation PR. A later substantial change
gets a new implementation specification; do not rewrite the original decision to
match it. Small fixes need not create a new specification.

Earlier implementation records are archived, including unfinished proposals
and records awaiting review. Archive placement preserves filenames, milestone
directory structure, recorded statuses, and verification limits; it does not mark
work complete or establish release availability.

Existing status labels are preserved below as recorded. They have not been
automatically reconciled with implementation or release history and are not
availability claims. Links in historical documents may be maintained after file
moves without changing their substantive contract or Manual Notes. Historical
commands and test paths can describe an older revision; run current verification
from [AGENTS.md](../AGENTS.md#running-integration-tests) instead.

## Active specifications

[Dedicated Harness RWO workspace](38-harness-rwo-workspace-plan.md) — Implementing;
exclusive revision preparation, durable RWO workspaces, and retained existing claims.

[Plugin policy enforcement](37-plugin-policy-enforcement.md) — Proposed for alignment;
revises the earlier plugin policy proposals with nested defaults and tool overrides,
Driver extensions, and admission-to-runtime enforcement. Draft implementation
exists; enforcement delivery awaits alignment. Catalog discovery proceeds in the
separate Create Agent workstream.

[Native OpenClaw plugin tool policies](35-native-plugin-tool-policy.md) — Proposed;
enforce Agent plugin policies through a managed native policy plugin and existing
approval transport.

[Initial Agent workspace files](34-agent-workspace-files-setup.md) — Proposed;
create-only Console and API input, applied once before first runtime execution.

[Agent presets](33-agent-presets.md) — Implementing; reusable, partial Agent launch
templates with variables, CRUD APIs, and console selection.

[Harness authentication bindings](30-harness-auth-binding.md) — Accepted for implementation;
one Agent auth binding for supplied OpenAI keys and issued ChatGPT account credentials.

[Gateway–Harness storage split](28-gateway-harness-storage-split.md) — Proposed;
#76/#89 draft covering storage ownership, live edits and first-start files.

[Storage split integration](30-storage-split-integration.md) — Draft follow-up;
revises Memory placement, defines the shared candidate interface, and lists the
remaining Enterprise integration work.

- [Initial OCC Prometheus metrics](28-occ-prometheus-metrics.md) — Implementing;
  API/worker instrumentation, Agent inventory, private scraping, and replica
  aggregation. Local proof recorded; runtime/cluster acceptance outstanding.

See the [OpenClaw testing infrastructure report](reports/openclaw-testing-infrastructure.md) for the source audit behind the proposed CI coverage.

| Implementation record                                                            | Recorded status                                                                                                                                                                            | Current reference                                                                                                                                        |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Agent stop without revision mutation](29-agent-stop.md)                         | Implementing                                                                                                                                                                               | [Agents](../docs/reference/agents.md) and [Agent deployment](../docs/reference/agents/deployment.md)                                                     |
| [Agent deletion and revision teardown](28-agent-deletion.md)                     | Implementing; stages 1-3 landed; sequenced behind Agent stop                                                                                                                               | [Agents](../docs/reference/agents.md) and [API](../docs/reference/api.md); teardown pending                                                              |
| [SSH Compute Driver](21-ssh-compute-driver.md)                                   | Completed; conformance, startup, and real-host container proof passed 2026-09-05                                                                                                           | [SSH Compute Driver](../docs/reference/drivers/ssh-compute.md)                                                                                           |
| [Agent workload tags](21-agent-workload-tags.md)                                 | Planning; draft awaiting review and user direction                                                                                                                                         | Proposed; [Agent](../docs/reference/agents.md) and [Sandbox](../docs/reference/drivers/sandbox.md) contracts remain unchanged                            |
| [Common OpenTelemetry logging](20-common-otel-logging.md)                        | Implemented; Docker, Kubernetes and Helm logging proof passed; OpenShell live proof unavailable                                                                                            | [Settings](../docs/reference/settings.md), [Harness execution](../docs/reference/harness-execution.md)                                                   |
| [GitHub Actions test coverage](19-github-actions-test-coverage.md)               | Proposed; workflow-edit authorization and external test resources required                                                                                                                 | [Testing](../docs/testing/README.md), [test settings](../docs/reference/settings.md)                                                                     |
| [Provider and related Drivers](17-provider-driver-abstraction.md)                | Implemented and locally verified in PR #8; live Provider proof pending                                                                                                                     | [Providers](../docs/reference/backends.md), [Agents](../docs/reference/agents.md), [ServiceAccount Driver](../docs/reference/drivers/service-account.md) |
| [Development end-to-end guide](15-development-end-to-end-guide.md)               | Completed                                                                                                                                                                                  | [Development TUI guide](../docs/guides/deploy/local-operations.md#development-end-to-end-tui); verified in `c208e48`                                     |
| [Feature Spec: Production interactive TUI](16-production-tui-end-to-end.md)      | Completed                                                                                                                                                                                  | [Deployment guide](../docs/guides/deploy/production-agents.md#attach-with-the-openclaw-tui), [production TUI flow](../docs/flows/production-tui.md)      |
| [Bootstrap administrator service account](16-bootstrap-admin-service-account.md) | Prior implementation locally verified; [recovery contract superseded](../docs/reference/authentication.md#installation-and-account-ownership); removal locally verified; PR review pending | [Authentication](../docs/reference/authentication.md), [bootstrap flow](../docs/flows/local-password-authentication.md)                                  |

## Archived specifications

Use the linked current references for supported behavior.

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

[Agent native admin UI pilot](31-agent-native-admin-ui.md) — Implementing; trusted pilot operators open the stock full-admin UI through exact-Agent OCC admission.
