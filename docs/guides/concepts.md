# Concepts

Use these concepts to understand what you configure and deploy in **OpenClaw Enterprise (OCE)**.

## Control and data planes

### Control plane

**OpenClaw Control Plane (OCC)** configures and manages Agent deployments.
Its API authorizes resource changes, and its worker uses Drivers to provision
and update workloads asynchronously.

### Data plane

The **data plane** handles Agent conversations and execution. Agent
[gateways and Harnesses](#gateways-and-harnesses) receive messages, call models,
and run tools. Deploying an Agent is a control-plane operation; processing a
message is data-plane work.

## Tenancy

An **Installation** is one deployment of the platform. A [Namespace](../reference/namespaces.md)
groups and isolates its Agents, configuration, and credentials. Fresh bootstrap
creates a platform Namespace named `default`, not an Agent or Kubernetes'
built-in `default` namespace. Wait for it to become `ready` before deploying.

## Agents and revisions

An [Agent](../reference/agents.md) is a persistent workload definition with its
own identity. Creating it does not start a process.

Deploying creates an immutable **AgentRevision**: a snapshot of the Agent's
configuration and execution settings. The worker provisions it, then activates
it to receive traffic. Editing an Agent or Configuration does not change the
running revision; deploy again to apply those changes.

## Gateways and Harnesses

Each deployed Agent has its own **gateway**, which handles client connections
and messages. The **Harness** executes Agent turns and tools.

The two supported [execution modes](../reference/harness-execution.md) are:

- **Embedded OpenClaw:** gateway and Harness run in one workload.
- **Dedicated Codex:** gateway connects to a separate Codex Harness workload.

## Configuration and Secrets

A [Configuration](../reference/configuration.md) stores reusable native
OpenClaw settings in a Namespace. An Agent references it. Installation startup
YAML is separate: it selects Drivers and configures the control plane.

A [Secret](../reference/drivers/kubernetes-secret.md) stores a sensitive value
separately from Configuration. OCC returns Secret metadata, not the value.
Configuration bindings deliver selected Secrets to the Agent gateway;
OpenClaw resolves its native `SecretRef` references there.

## Identity and access

[Authentication](../reference/authentication.md) identifies the caller.
[Authorization](../reference/authorization.md) checks its permissions for the
exact action and resource. A **Principal** represents a person; a
**ServicePrincipal** represents automation. Each Agent has its own stable
ServicePrincipal and does not inherit its creator's permissions.

A **Role** defines permissions, an **AccessBinding** grants a Role within a
scope, and a matching **Restriction** denies access.

An OCC [ServiceAccount](../reference/service-accounts.md) links Agents to a
credential reference. It is separate from the Agent's ServicePrincipal and
from the Kubernetes ServiceAccount used by a workload.

## Drivers and Providers

[Drivers](../reference/drivers/selection.md) implement platform operations
against infrastructure. For example, the Kubernetes Compute Driver provisions
workloads, while the Kubernetes Configuration Driver stores ConfigMaps.

A [Provider](../reference/providers.md) supplies an authenticated client to
related Drivers through Installation configuration. The bundled ChatGPT
Provider manages upstream service accounts; it does not select an Agent's
model or Harness.

## Next steps

Start with the [quickstart](quickstart.md), or use the
[deployment guide](deploy.md) to configure a full installation.
