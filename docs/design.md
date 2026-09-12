---
title: OpenClaw as the Open Enterprise Agent Platform
authors:
  - Kevin Lin
created: 2026-07-08
last_updated: 2026-08-24
---

# OpenClaw as the Open Enterprise Agent Platform

## Summary

OpenClaw Enterprise provides a multi-tenant control plane for configuring,
deploying, and operating agents. Each deployment owns exactly one Installation
containing multiple isolated Namespaces.

Enterprise functionality is mediated by the OpenClaw Controller (OCC). This is a new component that is responsible for provisioning and orchestrating agents.

The platform introduces a small set of resource primitives for managing agents.
OCC owns these platform resources and their lifecycles; external systems own
the underlying infrastructure, external provider resources, and local model
sources accessed through one common Driver abstraction.

The bundled platform deployment uses Kubernetes. An Installation can select its
bundled or an installed Driver implementation in development and production.

## Motivation

The existing OpenClaw gateway serves a single tenant. Operating agents for an
organization currently requires separate deployments, manually maintained
configuration, and application-specific integration work. Organizations lack a
shared way to manage tenant isolation, access, policy, deployment, and audit.

The platform needs one resource model for an agent, its configuration, the
version being deployed, and the infrastructure that runs it. Compute, model
inference, external identity, policy, messaging, and secret integrations need
explicit ownership boundaries without introducing a separate resource for each
runtime detail.

## Goals

- Provide a multi-tenant OpenClaw control plane with exactly one server-owned
  Installation and explicit Namespace and authorization boundaries.
- Validate externally authenticated identity and admit requests to the exact
  Installation and, when applicable, Namespace.
- Manage one isolated OpenClaw gateway per Agent, allowing multiple gateways
  in the same Namespace.
- Define the v1 resources used to configure, deploy, constrain, and operate an
  Agent.
- Preserve exact-resource authorization, immutable deployment snapshots, stable
  workload identity, fail-closed behavior, and audit evidence.
- Provision each Agent-owned gateway and its Agent workload through the same
  operator-selected `ComputeDriver`, whether bundled or installed.
- Support model inference from an external provider or local model source
  without introducing either as a platform resource.
- Enforce admitted sandbox policies and, in the future brokered design, keep
  secret values, backend credentials, and provider credentials outside agent
  workloads. The approved KubernetesSecretDriver path stores Namespace-owned
  material before Agent creation and may deliver it by env only to explicitly
  selected consuming gateways; embedded OpenClaw and dedicated Codex production retain the
  explicitly scoped, topology-specific model-credential boundaries described in [Secret access](design/safeguards.md#secret-access).
- Extend the platform through capability-specific contracts on one common
  Driver abstraction.
- Allow an Agent to own optional desired plugin selections while preserving
  immutable revision snapshots and selected Driver ownership.

## Non-Goals

- Making the existing OpenClaw gateway multi-tenant.
- Hosting multiple Installations in one OpenClaw Enterprise deployment.
- Introducing an execution resource between an Agent and its workload.
- Specifying the OCC API or OCC Console beyond naming their surfaces.
- Specifying integration wire protocols, database schemas, audit storage,
  directory synchronization, or external policy internals.
- Performing identity-provider authentication, login, token exchange, or
  credential issuance in the access gateway.
- Defining connector or plugin resources, tool actions, or approval workflows.
- Delegating human identity or authentication to an Agent.
- Supporting cross-Namespace references.

## Proposal

1. Introduce OCC as the owner of the multi-tenant control plane, platform
   resources, authorization, deployment, integration dispatch, and audit.
   `OCC API` and `OCC Console` name product surfaces; production API and console
   contracts remain outside this architecture specification.
2. Use an Ingress Gateway as the public control-plane boundary. It forwards
   protected requests only after the OpenClaw Access Gateway (OAG) verifies
   externally authenticated identity and admits the exact requested scope.
3. Have OCC independently authorize every requested OpenClaw operation against
   the exact action, resource, and Namespace.
4. Define the v1 platform resources: `Namespace`, `Configuration`,
   `ServiceAccount`, `Agent`, `AgentRevision`, `Harness`, `Channel`, `Secret`,
   `SecretBroker`, `SandboxPolicy`, and `Restriction`.
5. Have OCC manage one OpenClaw gateway for each deployed Agent. The selected
   `ComputeDriver` creates that gateway with its Agent in the same tenant
   boundary. The bundled `KubernetesComputeDriver` uses the same exact cluster
   and Kubernetes namespace. A Namespace may contain multiple independently
   owned gateways; gateway lifecycle follows its owning Agent.
6. Provision an Agent workload from an admitted immutable `AgentRevision`
   through the selected `ComputeDriver` and enforce its exact `SandboxPolicy`
   through the selected `SandboxDriver`.
7. Keep authorization, service accounts, model inference, compute,
   sandboxing, secrets, messaging, and plugin translation behind bounded Driver
   contracts.
   Installing a Driver does not grant it resource ownership or permission to
   select itself; only server-owned selection gives an `IAMDriver` authority
   for its assigned resource kinds.
8. Provide durable platform state, exact-resource authorization, and audit
   evidence without selecting internal storage or wire formats.

## Architecture

```mermaid
flowchart TB
    USERS["Users and automation"] --> INGRESS["Ingress Gateway"]
    INGRESS <-->|"identity verification and admission"| OAG["OpenClaw Access Gateway"]

    subgraph CONTROL["Control plane"]
        OCC["OpenClaw Controller"]
        IAM["IAMDriver"]
        BROKER["SecretBroker (deferred)"]
        API["OCC API"]
        CONSOLE["OCC Console"]
        CONFIG["Configuration"]
        SERVICE_ACCOUNT["ServiceAccount"]
        AGENT["Agent"]
        REVISION["AgentRevision"]

        CONSOLE -->|"resource operations"| API
        API -->|"admitted requests"| OCC
        OCC -->|"authorizes exact resources"| IAM
        OCC -->|"manages"| AGENT
        OCC -->|"future broker operations"| BROKER
        CONFIG -->|"configures"| AGENT
        SERVICE_ACCOUNT -->|"supplies credential reference"| AGENT
        AGENT -->|"deployment creates"| REVISION
    end

    INGRESS -->|"verified browser access"| CONSOLE
    INGRESS -->|"verified requests"| API

    subgraph DATA_PLANE["Selected data plane"]
        COMPUTE["Selected ComputeDriver"]
        SANDBOX["SandboxDriver"]

        subgraph NAMESPACE["Tenant workload boundary"]
            GATEWAY["Agent-owned OpenClaw gateway"]
            WORKLOAD["Agent workload"]
        end

        COMPUTE -->|"provisions Agent-owned gateway"| GATEWAY
        COMPUTE -->|"provisions and observes Agent workload"| WORKLOAD
        SANDBOX -->|"enforces admitted containment"| WORKLOAD
    end

    subgraph EXTERNAL["Selected external integrations"]
        SERVICE_ACCOUNT_DRIVER["ServiceAccountDriver"]
        PROVIDER_CLIENT["Installation-scoped provider client"]
        INFERENCE_DRIVER["InferenceDriver"]
        SECRET_DRIVER["SecretDriver"]
        PLUGIN_DRIVER["PluginDriver"]
        PROVIDER["External provider"]
        LOCAL_MODEL["Local model source"]
        SECRET_STORE["Secret backend"]

        SERVICE_ACCOUNT_DRIVER -->|"authorized account and credential lifecycle"| PROVIDER_CLIENT
        PROVIDER_CLIENT -->|"provider-authenticated requests"| PROVIDER
        INFERENCE_DRIVER -->|"authorized provider model inference"| PROVIDER
        INFERENCE_DRIVER -->|"authorized local model inference"| LOCAL_MODEL
        SECRET_DRIVER -->|"stores Namespace-owned material"| SECRET_STORE
        PLUGIN_DRIVER -->|"resolves curated plugin selections"| PROVIDER
    end

    GATEWAY <-->|"Agent-owned runtime traffic"| WORKLOAD
    OCC -->|"namespace-scoped ensureNamespace"| COMPUTE
    OCC -->|"revision-scoped prepareRevision"| COMPUTE
    OCC -->|"dispatches authorized service account operation"| SERVICE_ACCOUNT_DRIVER
    OCC -->|"dispatches authorized model inference"| INFERENCE_DRIVER
    BROKER -->|"dispatches exact namespace operation"| SECRET_DRIVER
    REVISION -->|"immutable deployment configuration"| COMPUTE
    REVISION -->|"requested plugin policy"| PLUGIN_DRIVER
```

The Ingress Gateway is the public control-plane boundary. An external identity
provider authenticates the caller, OAG verifies the resulting identity evidence
and tenant admission, and OCC authorizes the exact platform operation. The
control plane contains OCC. Each Agent's OpenClaw gateway runs alongside its
workload in the selected data plane. `IAMDriver` evaluates the selected
authorization policy. The selected `ComputeDriver` reconciles Agent-owned
gateways and workloads in the same tenant boundary; the bundled
`KubernetesComputeDriver` uses the same exact Kubernetes cluster and backing
namespace. OCC owns their lifecycle decisions.
`SandboxDriver` enforces the admitted policy for the exact Agent workload.
`InferenceDriver` invokes the selected external provider or local model source.
`PluginDriver` translates Agent-owned desired plugin selections into native runtime
policy during revision startup.
OCC API and OCC Console are named surfaces, not implementation or deployment
decisions.

## Design chapters

This page and the following chapters define the authoritative target design.
Each chapter owns its detailed sections; [current architecture](ARCHITECTURE.md)
and [feature references](README.md) describe implementation and supported behavior.

- [Resources and tenant boundaries](design/resources.md): Installation, Namespace lifecycle, and platform resource contracts.
- [Access and authorization](design/access.md): admission, identities, authority selection, and exact-resource decisions.
- [Agent gateways and deployment](design/workloads.md): runtime ownership, execution topologies, and immutable revision activation.
- [Drivers and Providers](design/drivers.md): capability contracts, external integration ownership, and target repository layout.
- [Platform safeguards](design/safeguards.md): secret delivery, failure behavior, audit, and platform invariants.

## Near Term Future work

- Production OCC API contracts and admission.
- OCC Console design and implementation.
- Agent and Plugin Directories.
- Plugin invocation, authorization, and approvals
- Production Installation-wide administration and access-gateway admission.
- Audit export, retention, and operational integrations.
- Additional primitives: Budges, Routers
