# Drivers, Backends, and repository boundaries

This chapter defines requirements within the authoritative
[platform architecture](../design.md). The implementation status below separates
current behavior from remaining design work.

## Implementation status

Compute, IAM, Configuration, Secret, ServiceAccount, Plugin, Repo, Channel,
optional Sandbox, and Credential Gateway integrations have current contracts. The
`InferenceDriver` and general `SandboxPolicy` enforcement described below remain
planned. Current Channel operations validate credentials and look up provider
directories; runtime messaging is not a general OCC dispatch contract. Current
Sandbox is optional, can provision the dedicated Harness, and
exposes containment facets rather than the full policy interface in this design.
OpenShell implements an experimental plugin-free dedicated Codex path in the
local development profile; real activation and production deployment remain
subject to its upstream preconditions. See
[Driver development](../contributing/driver-development.md),
[Sandbox](../reference/drivers/sandbox.md), and
[OpenShell limits](../reference/drivers/openshell-sandbox.md) for current contracts.

## ComputeDriver

`ComputeDriver` realizes two independently scoped infrastructure lifecycles:

1. Namespace-scoped `ensureNamespace` creates or reconciles only the backing
   tenant infrastructure in the selected runtime targets; `deleteNamespace`
   removes that Namespace's owned infrastructure across those targets after
   OCC authorizes deletion of an empty Namespace. The bundled Kubernetes Driver
   provisions and removes a driver-owned Kubernetes namespace, or reconciles
   and removes only OCC-owned infrastructure inside a discovered,
   operator-owned existing namespace in the tenant data plane. Cleanup preserves
   shared control-plane infrastructure and resources outside the exact owner.
2. Revision-scoped `prepareRevision` creates or reuses the exact Agent's
   configured gateway and realizes the topology pinned in its immutable
   revision: one embedded OpenClaw process or a separate, nonserving dedicated
   Harness, following [topology placement](workloads.md#openclaw-gateways).
   `retireRevision` stops only that revision's owned runtime while preserving its
   Agent's gateway and any resources required by the replacement. Agent deletion
   removes its own gateway and Harness resources across the selected targets.

One selected Compute Driver orchestrates both lifecycles across both runtime
targets. There is no separately selectable `GatewayDriver`. Namespace lifecycle
observations identify the exact Namespace and report backing-infrastructure
readiness or deletion without repeating the singleton Installation identifier.
Gateway and workload observations identify both the Namespace and owning Agent.

Installation configuration selects the allowed control-plane and tenant
data-plane runtime targets. The Driver resolves exact physical placement for
each operation while preserving the platform Namespace and Agent boundary.
Physical target coordinates, runtime endpoints, and transport credentials are
Driver-owned observations or materializations, not platform resources or
persisted `AgentRevision` fields. OCC owns the Namespace, gateway lifecycle,
Agent, immutable revision, workload identity, route bindings, authorization
decisions, and desired state. The driver consumes that admitted intent and
reports readiness or failure without changing platform ownership.

The bundled `KubernetesComputeDriver` and reviewed installed implementations can
be selected in development and production. Gateway reconciliation occurs
during its owner's deployment and revision replacement; gateway removal occurs
when that Agent or its Namespace is deleted. Agent workload preparation cannot
mutate another Agent's gateway or workload or expose the previously active
revision's credentials. Kubernetes independently owns scheduling and the
infrastructure lifecycle when the bundled Driver is selected.

The driver cannot target an unselected location or another platform Namespace,
adopt another tenant's resources, change an Agent's configuration, rewrite its
revision, select another identity, authorize a platform operation, or grant
permissions. Gateway provisioning failure keeps the exact Agent deployment
unready without changing Namespace readiness. Agent workload provisioning failure leaves sibling Agents
and their gateways untouched and restores or fails closed for the previous
active Agent workload. Readiness, activation, rollback, and cleanup account for
both targets; partial failure cannot authorize traffic to an inactive revision
or orphan resources by treating success in one target as overall success.
OCC does not select a fallback target or compute implementation.

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

<a id="drivers-and-providers"></a>

## Drivers and Backends

A **Driver** is the common integration boundary for a selected platform
capability. OCC selects each Driver implementation through Installation
configuration and passes the exact operation, scope, identity, and applicable
Restrictions relevant to that capability. After OAG admits the request, the
selected authorization Driver evaluates the exact requested operation; an
execution Driver receives admitted intent only after OCC verifies that
authorization. A Driver reports its decision, readiness, or operational result
without acquiring platform-resource ownership or permission to select itself.

| Driver contract           | Responsibility                                                                                                                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IAMDriver`               | Evaluate the exact platform action and resource using its selected native or external authority. `OCCIAMDriver` evaluates OCC-owned roles and bindings.                                                                   |
| `ServiceAccountDriver`    | Create upstream service accounts and separately issue their credentials after exact OCC authorization; privately own Backend bindings and credential lifecycle while the provider retains its independent authority.      |
| `InferenceDriver`         | Perform authorized inference against an admitted external-provider model or local model source without exposing provider credentials, secret values, or reusable model credentials to Agent workloads.                    |
| `ComputeDriver`           | Ensure Namespace infrastructure, store authorized account credentials, and reconcile each Agent's gateway and Harness in their selected runtime targets with exact Namespace, Agent, and revision ownership.              |
| `SandboxDriver`           | Enforce and verify the complete admitted containment policy before an Agent workload can execute Agent turns.                                                                                                             |
| `SecretDriver`            | Store Namespace-owned secret material and validate safe delivery references. KubernetesSecretDriver is the default.                                                                                                       |
| `CredentialGatewayDriver` | Hold registered credential sources outside Agent workloads and issue per-revision attachments that only its paired `SandboxDriver` can apply. The OpenShell implementation shares one Backend with the OpenShell Sandbox. |
| `CredentialRefreshDriver` | Mint and re-mint the tokens of refresh-type credential sources from their issuers before expiry, holding the refresh material with the paired `CredentialGatewayDriver` on one Backend.                                   |
| `ChannelDriver`           | Realize authorized Namespace-local messaging operations while the messaging provider retains independent authorization and credentials.                                                                                   |

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
`ServiceAccountDriver` capability. It receives `Backend<ChatGPTClient>`; the
client owns the configured workspace, trusted transport, and mounted admin
credential. `backend[].drivers` declares the exact related Driver selections,
and composition injects the Backend into its concrete member. The generic Driver
contract has no Backend identity field. All related Drivers are required. The current ChatGPT Backend requires the selected ServiceAccount
Driver; installed-package Backend injection is deferred. Only the API
entrypoint initializes the client and concrete Driver. The worker shares
nonsecret Backend metadata but receives neither the admin credential nor a
runtime Backend object. The [Backend reference](../reference/backends.md) owns
the experimental configuration and lifecycle contract.

OCC authorizes account creation and credential issuance separately before any
provider or Kubernetes side effect. The concrete Driver creates the provider
account, then privately binds its Backend, Driver, account, and workspace
identifiers to the exact OCC account and Namespace. Credential issuance persists the provider credential
identifier privately for exact deletion and future rotation or reconciliation;
the public account contains only a generic credential kind and opaque
same-Namespace Secret reference. API-side Compute creates the account-owned
canonical Secret. Worker-side Compute materializes the admitted token and
workspace into a revision-owned runtime Secret for the exact dedicated Codex
workload; see [Secret delivery](safeguards.md#secret-access). Operations through a Backend fail closed when provider
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

[Repository layout](../layout.md) owns the current source tree. The controller
application contains API and worker entrypoints, console assets, composition,
Drivers, and Backend clients. Packages own shared contracts, platform state,
IAM, and audit. Separate access-gateway, broker, and inference applications or
packages are not implemented boundaries; the API and console already exist.

Capability ownership does not require a separate top-level directory. Shared
Backend clients are Installation-scoped dependencies rather than Driver
capabilities. External providers, accounts, and resources retain their own
owners; an OCC ServiceAccount remains a platform representation of an upstream
account.
