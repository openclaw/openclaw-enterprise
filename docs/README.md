# OpenClaw Enterprise

OpenClaw Enterprise is the open platform for managing agents.

## Start and deploy

- [Quickstart](guides/quickstart.md): start locally, sign in, and make an authenticated request.
- [Deploy](guides/deploy.md): deploy with Docker Compose or Kubernetes, provision an Agent, and exchange messages in its gateway TUI.
- [Testing](testing.md): choose test suites, prepare credentials and infrastructure, and interpret results.

## Architecture

- [Platform design](design.md): platform architecture and resource model.
- [Current architecture](ARCHITECTURE.md): API, worker, storage, and Agent execution.

## Reference

- [Reference index](reference/README.md): browse all features and Drivers.
- [Namespaces](reference/namespaces.md), [Agents](reference/agents.md), and
  [Configuration](reference/configuration.md): create, organize, and configure Agents.
- [Kubernetes Secret Driver](reference/drivers/kubernetes-secret.md): store Secrets
  and bind them to selected Agent gateways.
- [Authentication](reference/authentication.md),
  [Authorization](reference/authorization.md), and
  [Service accounts](reference/service-accounts.md): sign-in, permissions, and credentials.
- [Harness execution](reference/harness-execution.md) and
  [Controller reconciliation](reference/controller.md): runtime topology, deployment,
  and revision activation.
- [Security controls](reference/security.md), [settings](reference/settings.md),
  and [HTTP API](reference/api.md): access controls, deployment configuration, and request schemas.
- [Drivers](reference/README.md#drivers): select and configure compute, configuration,
  identity, and Secret implementations.

## Understand the code

- [Development startup](flows/development-startup.md),
  [Docker Compose development](flows/docker-compose-development.md),
  [production startup](flows/production-startup.md),
  [production TUI attachment](flows/production-tui.md), and
  [shared platform startup](flows/platform-startup.md).
- [Controller worker](flows/controller-worker.md),
  [Harness execution topology](flows/harness-execution-topology.md), and
  [dedicated Harness shared workspace](flows/dedicated-harness-shared-workspace-drive.md).
- [Configuration and Agent revision](flows/configuration-driver.md),
  [Secret storage and gateway delivery](flows/secret-storage-and-delivery.md),
  [Driver loading](flows/driver-plugin-loading.md), and
  [Compute lifecycle hooks](flows/compute-driver-lifecycle-hooks.md).
- [Local password authentication](flows/local-password-authentication.md),
  [service API keys](flows/service-api-keys.md),
  [native credential delivery](flows/native-service-account-credential-delivery.md),
  and [Driver-issued credentials](flows/service-account-driver-credential-delivery.md).
- [Existing Kubernetes namespace placement](flows/kubernetes-existing-namespace-placement.md).

## Implementation history

[Spec archive](../specs/README.md): proposals, delivery records, and recorded statuses.
