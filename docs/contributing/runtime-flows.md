# Runtime flows

Use these traces to follow an OpenClaw Enterprise request or background operation
through the current source. They describe implementation order, state changes,
and failures. For supported product behavior, use the feature reference linked
from each trace; for commands to run locally, see [Testing](../testing/README.md).

## Startup and infrastructure

- [Platform startup](../flows/platform-startup.md) and [production startup](../flows/production-startup.md)
- [Controller worker and durable reconciliation](../flows/controller-worker.md)
- [Logging](../flows/common-logging.md)
- [Audit ledger](../flows/audit-ledger.md)
- [Docker Compose development](../flows/docker-compose-development.md): [stack startup](../flows/docker-compose-development/startup.md) and [Agent execution limits](../flows/docker-compose-development/agent-execution.md)

## Console, configuration, and Agents

- [Platform console](../flows/platform-console.md) and [Agent editing](../flows/platform-console/agent-editing.md)
- [Agent Presets](../flows/agent-presets.md): template admission, variable rendering, and independent draft creation
- [Agent provisioning](../flows/agent-provisioning.md): separate Secret saving, queued setup, resource creation, safe retries, and first deployment handoff
- [Agent native admin UI](../flows/agent-native-admin.md): console access, shared-session admission, and private gateway proxying
- [Agent runtime logs](../flows/agent-runtime-logs.md): tiered authorization, view audit, Kubernetes Pod and log reads, and the sanitizer
- [Configuration Driver](../flows/configuration-driver.md) and [configuration persistence and revision admission](../flows/configuration-driver/persistence-and-revisions.md)
- [Harness execution topology](../flows/harness-execution-topology.md)
- [Workspace files](../flows/workspace-files.md) and [Agent plugins](../flows/agent-plugins.md)
- [Production terminal interface](../flows/production-tui.md) and [native client behavior](../flows/production-tui/native-client.md)

## Identity and credentials

- [Agent repository access](../flows/agent-repository-credentials.md),
  [credential service](../flows/repository-credentials.md), and
  [repository configuration](../flows/repository-credential-configuration.md)
- [Repository credential tests](../testing/repository-credentials.md); the
  [original RFC](../../specs/rfcs/0008-repository-credentials/index.md) and
  [qualification record](../../specs/rfcs/0008-repository-credentials/qualification.md)
  preserve proposal and historical evidence separately from current support

- [Namespace IAM policy](../flows/namespace-iam-policy.md): authorized Role and AccessBinding changes and audit commit

- [Local password authentication](../flows/local-password-authentication.md) and [service API keys](../flows/service-api-keys.md)
- [Secret storage and delivery](../flows/secret-storage-and-delivery.md)
- [Credential source lifecycle](../flows/credential-source-lifecycle.md): gateway registration, Agent binding, admission, and retried deletion
- [Harness authentication binding](../flows/native-service-account-credential-delivery.md) and [ServiceAccount Driver credential delivery](../flows/service-account-driver-credential-delivery.md)

## Drivers and placement

- [Installation Driver package loading](../flows/driver-plugin-loading.md)
- [Compute Driver lifecycle hooks](../flows/compute-driver-lifecycle-hooks.md)
- [Existing Kubernetes namespace placement](../flows/kubernetes-existing-namespace-placement.md)
- [SSH Compute lifecycle](../flows/pr-24-ssh-compute.md)

## Continuous integration

- [GitHub Actions testing](../flows/github-actions-testing.md) and [test preparation](../flows/github-actions-testing/preparation.md)
- [ClawSweeper dispatch](../flows/clawsweeper-dispatch.md): hosted admission and review handoff
- [Run and diagnose CI checks](../testing/ci.md)
