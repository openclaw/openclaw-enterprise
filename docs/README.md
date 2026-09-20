# OpenClaw Enterprise

Deploy and manage Agents through OpenClaw Control Plane (OCC).
Start locally, install a production control plane, or look up supported behavior.

## Start and deploy

- [Quickstart](guides/quickstart.md): start locally on Docker or Podman, sign in,
  and verify API access.
- [Deploy](guides/deploy.md): choose a deployment and follow its installation steps.
- [Standard Kubernetes](guides/deploy/kubernetes.md): prepare your cluster for OCE.
- [Amazon EKS](guides/deploy/eks.md): prepare AWS managed Kubernetes for OCE.
- [Production handoff](guides/deploy/production-handoff.md): assign owners and verify a business workflow, alert response, and recovery readiness.
- [Credential lifecycle](guides/deploy/credential-lifecycle.md): select the supported renewal or revocation path and verify its consumers.
- [OCC CLI](guides/cli.md): manage OCC resources through domain commands.
- [Concepts](guides/concepts.md): understand Namespaces, Agents, revisions, and credentials.
- [Observability](guides/observability.md): export logs and check Collector health.

## Reference

Use the [feature and Driver index](reference/README.md) for supported behavior,
configuration, and limits. The [HTTP API](reference/api.md) describes request and
response schemas. The [console guide](reference/console.md) covers browser tasks.
The [Agent native admin UI](reference/agent-native-admin.md) reference covers
the trusted-operator pilot for opening the stock native UI through OCC.
Compare bundled implementations in the [ComputeDriver feature matrix](reference/drivers/compute-matrix.md).
Use the [PluginDriver feature matrix](reference/drivers/plugin-matrix.md) to
compare plugin discovery and approval-policy support.
[Agent plugins](reference/agent-plugins.md) and
[PluginDriver](reference/drivers/plugin.md) cover curated plugin selection and startup;
[bundled Plugin Drivers](reference/drivers/plugin-bundled.md) cover native policy.
Use the [SecretDriver contract](reference/drivers/secret.md) for storage and delivery
boundaries and [Kubernetes Secret](reference/drivers/kubernetes-secret.md) for setup.

## Architecture

Read [current architecture](ARCHITECTURE.md) for implemented components and
ownership. The [platform design](design.md) describes the authoritative target,
including capabilities that have not shipped.

## Understand the code

Start with [Docker or Podman Compose development](flows/docker-compose-development.md),
[platform startup](flows/platform-startup.md), or the
[controller worker](flows/controller-worker.md). The **Understand the code** tab
lists runtime traces for authentication, configuration, Drivers, and Agent execution.
The [Agent plugin flow](flows/agent-plugins.md) traces desired state through
revision startup and runtime configuration.
The [Agent native admin UI flow](flows/agent-native-admin.md) traces console
availability, shared-session Agent-host admission, and private gateway proxying.

## Contribute

- [Driver documentation inventory](driver-docs-inventory.md): find base contracts and their documentation owners.
- [Base Driver template](base-driver-docs-template.md): write driver contracts using the local technical-writing skill.

- [Repository layout and conventions](layout.md): find code owners and choose where changes belong.
- [Testing](testing/README.md): select a suite and prepare its environment.
- [Local preview](local-preview.md): render and validate documentation.

## Implementation history

The [spec archive](../specs/README.md) preserves proposals and delivery records.
Recorded statuses do not replace current feature reference.
