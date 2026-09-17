# Resources and tenant boundaries

This page owns the resources and tenant boundaries portion of the authoritative
[platform target design](../design.md). Read it with the other design chapters;
the [current architecture](../ARCHITECTURE.md) describes implementation status.

## Common concepts

An OpenClaw Enterprise deployment owns exactly one server-selected
`Installation`. It is the outer administrative boundary for configured
Providers, installation-scoped IAM resources, and Namespaces. Bootstrap
creates one persistent Installation with a stable identifier; subsequent starts
reload that same Installation, and a conflicting configured identifier fails
closed. Platform resource writes are rejected before bootstrap completes.
There is no multi-Installation collection or caller-selected Installation.
Installation configuration selects server-owned Drivers,
including the authoritative `IAMDriver` for each resource kind and the selected
service-account, inference, compute, sandbox, secret, and messaging capabilities.
An Installation-scoped `Provider` owns an authenticated client and related
capability-specific Drivers; neither the Provider nor its client is a Driver or
an OCC resource. Each Agent has a nullable `providerId`, copied into each
immutable AgentRevision. Provider membership does not change model configuration
or authorize operations. The configured provider workspace is
provider connection context, not an OCC Namespace mapping. A platform Namespace
retains its tenant ownership across physical runtime targets; it is not
synonymous with one Kubernetes namespace or cluster. The selected Compute Driver
preserves that boundary for gateways and Harnesses under the
[topology placement rules](workloads.md#openclaw-gateways).

The Installation identifier crosses only boundaries that require a deployment
identity: configuration, admission, trusted ingress, exported audit evidence,
and external deployment integrations. Ordinary Namespace and Agent resources,
internal IAM records and resource references, repository operations,
controller work, and Compute observations inherit their Installation from the
selected singleton platform. They do not repeat `installationId`.

Installation bootstrap establishes identity-provider trust and the first
administrator through a server-owned, single-use, installation-scoped setup
path. Normal requests are unavailable until setup completes, after which the
bootstrap path is disabled. Bootstrap decisions are audited. Only an
authorized human or installation-scoped service principal may create or
change Namespaces, Groups, Roles, AccessBindings, Restrictions, or
installation trust.

A `Namespace` is the tenant boundary inside the singleton Installation. Each
Namespace-scoped resource, identity, and access binding belongs to exactly one
Namespace. `namespaceId` is the explicit tenant-isolation key for scoped
resources, authorization, lookup, controller work, and Compute observations;
its absence on an IAM resource denotes singleton-wide scope.
Namespace-scoped references cannot cross the Namespace boundary.
Installation-scoped resources belong to the same server-owned Installation.

OCC owns persistent Namespace lifecycle and readiness. A Namespace starts
`provisioning` and becomes `ready` only after its backing tenant infrastructure
is ready in the selected runtime targets. In the selected tenant data-plane
target, the bundled Kubernetes Driver either provisions a driver-owned backing
namespace or uses the exact existing, operator-owned namespace requested through
`POST /namespaces` with `existingNamespace`. Existing-namespace selection additionally requires
Installation `administer` authorization at admission and immediately before
worker adoption. The requested name is persisted immutably and is unique across
active Namespace records. The operator-prepared namespace
must be `Active`, have an external-lifecycle annotation, enforce restricted Pod
Security, and contain no foreign tenant markers or NetworkPolicies. The worker
binds only its exact tenant label and annotation while preserving its manager;
the bundled Configuration Driver discovers the resulting exact tenant identity.
The shared worker keeps running, and Installation settings remain unchanged.
`ComputeDriver.ensureNamespace` reports infrastructure readiness as an
independently authorized Namespace lifecycle operation without starting a
gateway. Permanent provisioning failure marks the Namespace `failed`. Deletion
transitions an empty Namespace to `deleting`; `ComputeDriver.deleteNamespace`
removes OCC-owned tenant infrastructure before OCC tombstones the platform
resource. It removes a driver-owned backing namespace but preserves an
operator-owned existing namespace, tenant markers, and external resources. A failed,
incomplete, or deleting Namespace cannot admit deployments.

OCC owns platform resource records and lifecycles. Each Driver receives only
the exact scoped operation appropriate to its selected capability; it does not
own platform resources, select itself, grant itself permissions, or rewrite
revisions.

## Platform resources

| Resource         | Scope                     | Contract                                                                                                                                                                                                                                                                                                             |
| ---------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Namespace`      | Installation              | Tenant boundary for agents, configuration, messaging, secrets, policy, and runtime routing. OCC establishes its backing tenant infrastructure before contained Agents and their individually owned gateways can be deployed.                                                                                         |
| `Configuration`  | Namespace                 | Reusable nonsecret configuration for Agents. Deployment snapshots the admitted contents into an `AgentRevision`; later edits affect only later deployments.                                                                                                                                                          |
| `ServiceAccount` | Namespace                 | OCC-owned, provider-agnostic account with at most one opaque reference to a credential in its exact backing namespace. A selected ServiceAccountDriver privately links it to an upstream account. The account, Agent, and immutable revision never contain credential bytes or provider identity.                    |
| `Agent`          | Namespace                 | Stable author-facing agent resource. It can reference one same-Namespace ServiceAccount and one Installation Provider, and owns its revision history, at most one active revision, exactly one deployed OpenClaw gateway, and one stable OCC-created `WorkloadIdentity`.                                             |
| `AgentRevision`  | Namespace                 | Immutable snapshot of one Agent and the exact configuration, references, harness, sandbox policy, and selected runtime implementations admitted for one deployment. OCC activates it only after preparing the Agent-owned gateway and candidate workload, verifying containment, and configuring a nonserving route. |
| `Harness`        | Installation              | Versioned agent runtime published for the Installation. Deployment pins the admitted Harness version in the revision.                                                                                                                                                                                                |
| `Channel`        | Namespace                 | Messaging surface available to an Agent through its own Namespace-scoped OpenClaw gateway. OCC owns the Channel resource; the messaging provider independently authorizes provider operations and owns provider credentials.                                                                                         |
| `Secret`         | Namespace                 | Stable reference to Namespace-owned material stored by the selected SecretDriver. OCC metadata and revisions contain no value; default env delivery supplies only explicitly selected consuming Agent gateways.                                                                                                      |
| `SecretBroker`   | Namespace (deferred)      | Future broker-mediated secret access; not required for the default KubernetesSecretDriver storage and env delivery path.                                                                                                                                                                                             |
| `SandboxPolicy`  | Namespace                 | Workload containment requirements for an Agent deployment. The selected `SandboxDriver` must support and enforce the exact admitted policy.                                                                                                                                                                          |
| `Restriction`    | Installation or Namespace | Platform-wide guardrail enforced by every relevant authority and integration. It can narrow an otherwise allowed operation, but it cannot grant or expand permission.                                                                                                                                                |

Identities, groups, roles, permissions, and access bindings are IAM resources,
not additional deployment primitives. Workloads, Kubernetes objects, Drivers,
external provider objects, and local model sources are not platform resources.
Native `ServiceAccount` records are OCC-owned representations, not provider
accounts, IAM principals, or Kubernetes ServiceAccounts. An optionally selected
`ServiceAccountDriver` creates an externally owned account and, through a
separate authorized operation, its credential. The concrete Driver privately
persists the exact upstream account, credential, and workspace identifiers;
none belongs to the public OCC resource. The provider independently authorizes
every upstream operation. A separately selected `InferenceDriver` executes an
authorized model operation against an already selected external provider account
or local model source. Each source retains its own resources, credentials,
authorization, and applicable policy.
