# Drivers, Providers, and repository boundaries

This page owns the drivers, providers, and repository boundaries portion of the authoritative
[platform target design](../design.md). Read it with the other design chapters;
the [current architecture](../ARCHITECTURE.md) describes implementation status.

## ComputeDriver

`ComputeDriver` realizes two independently scoped infrastructure lifecycles:

1. Namespace-scoped `ensureNamespace` creates or reconciles only the backing
   tenant infrastructure; `deleteNamespace` removes that infrastructure after
   OCC authorizes deletion of an empty Namespace. The bundled Kubernetes Driver
   provisions and removes a driver-owned Kubernetes namespace, or reconciles
   and removes only OCC-owned infrastructure inside a discovered,
   operator-owned existing namespace.
2. Revision-scoped `prepareRevision` creates or reuses the exact Agent's
   configured gateway and realizes the topology pinned in its immutable
   revision: one embedded OpenClaw process or a separate, nonserving dedicated
   Codex workload. Both are supported production topologies. `retireRevision`
   stops only that
   revision's owned runtime while preserving its Agent's gateway when a
   replacement requires it. Agent deletion removes its own gateway.

One selected Compute Driver owns both lifecycles in the same data plane. There
is no separately selectable `GatewayDriver`. Namespace lifecycle observations
identify the exact Namespace and report backing-infrastructure readiness or
deletion without repeating the singleton Installation identifier. Gateway and
workload observations identify both the Namespace and owning Agent.

Both operations use the same selected data plane and exact tenant boundary
chosen for the platform Namespace. The bundled Kubernetes Driver uses the
Installation-selected cluster and exact backing Kubernetes namespace. OCC owns
the Namespace, gateway lifecycle, Agent, immutable revision, workload identity,
route bindings, authorization decisions, and desired state. The driver consumes
that admitted intent and reports readiness or failure without changing platform
ownership.

The bundled `KubernetesComputeDriver` and reviewed installed implementations can
be selected in development and production. Gateway reconciliation occurs
during its owner's deployment and revision replacement; gateway removal occurs
when that Agent or its Namespace is deleted. Agent workload preparation cannot
mutate another Agent's gateway or workload or expose the previously active
revision's credentials. Kubernetes independently owns scheduling and the
infrastructure lifecycle when the bundled Driver is selected.

The driver cannot target another cluster or Namespace, adopt another tenant's
resources, change an Agent's configuration, rewrite its revision, select another
identity, authorize a platform operation, or grant permissions. Gateway
provisioning failure keeps the exact Agent deployment unready without changing
Namespace readiness. Agent workload provisioning failure leaves sibling Agents
and their gateways untouched and restores or fails closed for the previous
active Agent workload. OCC does not select a fallback cluster or compute
implementation.

## SandboxDriver

`SandboxDriver` enforces the exact `SandboxPolicy` admitted for one
`AgentRevision`. Installation configuration selects one implementation.
Before creating a candidate revision, OCC verifies that the selected Driver
supports the complete policy; unsupported, unavailable, or ambiguous
enforcement rejects deployment.

After candidate Agent workload provisioning, the Driver establishes and verifies
containment before the Harness executes Agent turns. The enforcement matches the exact
revision, Namespace, `WorkloadIdentity`, admitted policy, and applicable
Restrictions. OCC activates the revision only after that containment is
ready. `SandboxDriver` does not provision workloads, own resources, select
another identity, grant permissions, or replace an Agent's gateway.

## Drivers and Providers

A **Driver** is the common integration boundary for a selected platform
capability. OCC selects each Driver implementation through Installation
configuration and passes the exact operation, scope, identity, and applicable
Restrictions relevant to that capability. After OAG admits the request, the
selected authorization Driver evaluates the exact requested operation; an
execution Driver receives admitted intent only after OCC verifies that
authorization. A Driver reports its decision, readiness, or operational result
without acquiring platform-resource ownership or permission to select itself.

| Driver contract        | Responsibility                                                                                                                                                                                                        |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IAMDriver`            | Evaluate the exact platform action and resource using its selected native or external authority. `OCCIAMDriver` evaluates OCC-owned roles and bindings.                                                               |
| `ServiceAccountDriver` | Create upstream service accounts and separately issue their credentials after exact OCC authorization; privately own provider bindings and credential lifecycle while the provider retains its independent authority. |
| `InferenceDriver`      | Perform authorized inference against an admitted external-provider model or local model source without exposing provider credentials, secret values, or reusable model credentials to Agent workloads.                |
| `ComputeDriver`        | Ensure Namespace infrastructure, store authorized account credentials, and provision one Agent-owned gateway with each Agent workload in the same exact tenant boundary.                                              |
| `SandboxDriver`        | Enforce and verify the complete admitted containment policy before an Agent workload can execute Agent turns.                                                                                                         |
| `SecretDriver`         | Store Namespace-owned secret material and validate safe delivery references. KubernetesSecretDriver is the default; broker/substitution delivery is deferred.                                                         |
| `ChannelDriver`        | Realize authorized Namespace-local messaging operations while the messaging provider retains independent authorization and credentials.                                                                               |

One implementation may satisfy multiple Driver contracts, but OCC selects each
role explicitly. Authority for one role does not grant another role, resource
ownership, or permission. The selected `IAMDriver` evaluates authorization
before side effects; an effectful Driver handling a caller request runs only
after OAG admits that caller and OCC authorizes the exact operation.
`ComputeDriver` ensures backing Namespace infrastructure through an
independently authorized Namespace lifecycle operation, then creates each
Agent-owned gateway through that Agent's admitted revision operation. Each
relevant Driver enforces applicable platform Restrictions, and unsupported or
unverifiable enforcement fails closed.

`ChatGPTServiceAccountDriver` is one concrete implementation of the
`ServiceAccountDriver` capability. It receives `Provider<ChatGPTClient>`; the
client owns the configured workspace, trusted transport, and mounted admin
credential. `provider[].drivers` declares the exact related Driver selections,
and composition injects the Provider into its concrete member. The generic Driver
contract has no Provider identity field. All related Drivers are required. The current ChatGPT Provider requires the selected ServiceAccount
Driver; installed-package Provider injection is deferred. Only the API
entrypoint initializes the client and concrete Driver. The worker shares
nonsecret Provider metadata but receives neither the admin credential nor a
runtime Provider object. The [Provider reference](../reference/providers.md) owns
the current configuration and lifecycle contract.

OCC authorizes account creation and credential issuance separately before any
provider or Kubernetes side effect. The concrete Driver creates the provider
account, then privately binds its Provider, Driver, account, and workspace
identifiers to the exact OCC account and Namespace. Credential issuance persists the provider credential
identifier privately for exact deletion and future rotation or reconciliation;
the public account contains only a generic credential kind and opaque
same-Namespace Secret reference. API-side Compute creates the account-owned
Secret, and Kubernetes projects its token and workspace directly into the exact
dedicated Codex workload. Provider-backed operations fail closed when provider
authority, the exact private binding, tenant-local Secret authority, or
compatible dedicated execution is unavailable. OAuth refresh and automated
rotation remain deferred.

One Installation-selected `InferenceDriver` may support server-approved OpenAI
or other provider models and local model sources. The immutable admitted Agent
Configuration and AgentRevision select the exact authorized model target;
local inference does not require a provider account. A denied, unavailable, or
unapproved target cannot fall back to another provider, local model, or
credential. Agent workloads cannot bypass OCC, their selected
`InferenceDriver`, or applicable model and network Restrictions.

Each `AgentRevision` pins the selected compute and sandbox implementations.
Installing or upgrading a Driver cannot replace either implementation for an
existing revision. OCC rejects removal while an active or candidate revision
depends on it. A changed runtime selection applies only to a later authorized
deployment. Current authorization, provider authority, and secret access remain
subject to immediate revocation.

## Repository layout

Capability directories contain Driver implementations; shared provider clients
are Installation-scoped integration dependencies rather than Driver
capabilities. Packages own platform contracts and state; applications provide
control-plane product entry points.

```text
apps/
  controller/
  access-gateway/
  console/
packages/
  contracts/
  occ/
  iam/
  broker/
  audit/
drivers/
  iam/
  service-accounts/
  inference/
    openai/
    local/
  compute/
  sandbox/
  secrets/
  channels/
tests/
  conformance/
  integration/
```

The application directories name controller, access-gateway, and console
components; they do not define OCC API or OCC Console contracts, which remain
deferred. External providers, provider-side accounts and service accounts,
and provider resources remain owned by their respective external systems
rather than becoming platform resources. An OCC-owned native `ServiceAccount`
remains only a platform representation; it never acquires ownership of a
provider account.
