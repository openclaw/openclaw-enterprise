# OpenClaw Enterprise concepts

<span id="concepts"></span>

Use these concepts to understand what you configure and deploy in **OpenClaw Enterprise (OCE)**.

## Control and data planes

### Control plane

**OpenClaw Control Plane (OCC)** configures and manages Agent deployments.
Its API authorizes resource changes, and its worker uses Drivers to provision
and update workloads asynchronously.

OCC is a service, not a Kubernetes Operator. It keeps platform state, IAM policy,
queued work, and audit records in PostgreSQL, and the Helm chart adds no
CustomResourceDefinitions. A Compute Driver starts the workloads. Kubernetes is
one Compute Driver; the [SSH Compute Driver](../reference/drivers/ssh-compute.md)
runs embedded OpenClaw on Linux hosts instead.

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

<span id="agents-and-revisions" class="anchor-alias"></span>

## Agents and versions

An [Agent](../reference/agents.md) is a persistent workload definition with its
own identity. Creating it does not start a process.

Deploying creates an **Agent revision** (`AgentRevision`) that stores the
configuration and execution settings for the requested version. Its saved values
cannot change. A worker prepares the workload and enables its route. OCC can
select the version before that route is ready. Editing an Agent or Configuration
does not change the running version; deploy again to apply those changes.

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

A [Secret](topics/secrets.md) stores a sensitive value
separately from Configuration. OCC returns Secret metadata, not the value.
Configuration bindings deliver selected Secrets to the Agent gateway;
OpenClaw resolves its native `SecretRef` references there.

## Identity and access

[IAM](topics/iam.md) controls access. [Authentication](../reference/authentication.md)
identifies the caller; [authorization](../reference/authorization.md) checks
its permissions for the exact action and resource. A **Principal** represents a person; a
**ServicePrincipal** represents automation. Each Agent has its own stable
ServicePrincipal and does not inherit its creator's permissions.

A **Role** defines permissions, an **AccessBinding** grants a Role within a
scope, and a matching **Restriction** denies access.

An OCC [ServiceAccount](../reference/service-accounts.md) links Agents to a
credential reference. It is separate from the Agent's ServicePrincipal and
from the Kubernetes ServiceAccount used by a workload.

## Drivers and Backends

[Drivers](integrations/drivers.md) implement platform operations
against infrastructure. For example, the Kubernetes Compute Driver provisions
workloads, while the Kubernetes Configuration Driver stores ConfigMaps.

An experimental [Backend](../reference/backends.md) supplies an authenticated client to
related Drivers through Installation configuration. The bundled ChatGPT
Backend manages upstream service accounts. This work-in-progress abstraction is
separate from an Agent's **Provider → Model** selection: that choice identifies
the model service and model, not an Installation Backend.

## Next steps

[Set up the platform locally](quickstart.md), then [deploy your first Agent](first-agent.md).
For production, start with the [deployment guide](deploy.md).
