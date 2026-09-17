# Access and authorization

This page owns the access and authorization portion of the authoritative
[platform target design](../design.md). Read it with the other design chapters;
the [current architecture](../ARCHITECTURE.md) describes implementation status.

## Access gateway

The external identity provider authenticates each human or automation caller.
OAG verifies the resulting identity evidence and admits the caller to exactly
one server-selected Installation. Namespace-scoped requests additionally
require admission to the exact existing Namespace. Installation-scoped
administrative requests do not require a Namespace. OAG does not perform
authentication, issue or exchange credentials, create a session, or grant an
OpenClaw permission.

Installation configuration establishes the trusted identity issuer, intended
audience, and verification authority. OCC owns the association between an
external tenant and an existing Namespace. OAG verifies the issuer, immutable
subject, audience, expiration, and required claims against that configuration.
For a Namespace-scoped request, it additionally verifies the exact existing
tenant association. Caller-supplied claims cannot select the Installation or
Namespace. An email address, unverified caller claim, or successful admission
is not proof of identity or platform permission.

The Ingress Gateway forwards only an OAG-admitted request and its verified
identity and scope. The evidence remains bound to the original request,
Installation, and applicable Namespace. OCC accepts this evidence only through
the Installation's trusted ingress boundary; direct or caller-supplied
admission is denied. Forwarding does not mint a credential or authorize a
resource. OCC independently resolves an existing platform identity, selects
the authoritative `IAMDriver`, and authorizes the exact operation and each
protected reference.

Missing, invalid, expired, conflicting, or unverifiable identity evidence;
unavailable OAG or configured trust; a missing, ambiguous, or mismatched
required tenant; or denied gateway access fails closed. The Ingress Gateway
does not forward a denied request or a request whose OAG decision cannot be
verified. OCC independently denies an unknown platform identity.

## IAM and authority

An external identity provider authenticates the caller. OAG verifies that
identity and admits the exact Installation and applicable Namespace; OCC
authorizes the exact action, resource, and scope. Neither external
authentication nor gateway admission grants an OpenClaw permission.

| Boundary                            | Owner                         | Responsibility                                                                                            |
| ----------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------- |
| Authentication                      | External identity provider    | Authenticate human and automation identities and own the resulting identity evidence.                     |
| Identity verification and admission | OAG                           | Verify external identity evidence and admit the exact Installation and, when required, Namespace.         |
| OpenClaw resources                  | OCC                           | Own Agents, revisions, native ServiceAccounts, Channels, IAM resources, and Namespace containment.        |
| Platform Restrictions               | OCC                           | Own Installation and Namespace guardrails and require each relevant selected Driver to enforce them.      |
| Agent runtime routing               | OCC-managed Agent gateway     | Route only its owning Agent's traffic within the exact Namespace; multiple Agents have separate gateways. |
| Native authorization                | `OCCIAMDriver`                | Evaluate OpenClaw roles, bindings, permissions, and applicable Restrictions.                              |
| External authorization              | Selected external `IAMDriver` | Evaluate its external authority's policy and enforce applicable platform Restrictions.                    |
| External resources                  | External system               | Own external resources, provider credentials, and provider authorization.                                 |
| Workload infrastructure             | Kubernetes                    | Authenticate and authorize its own workload and infrastructure identities.                                |

Native OpenClaw authorization assigns permissions to a specific principal or
Group through an explicit binding.

| Entity             | Meaning                                                                                                                                        |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `Principal`        | Stable OCC identity for an authenticated human.                                                                                                |
| `ServicePrincipal` | Explicit OCC automation identity scoped to one Installation or one Namespace.                                                                  |
| `WorkloadIdentity` | Stable OCC identity belonging to exactly one Agent.                                                                                            |
| `Group`            | OCC-managed collection of Principals.                                                                                                          |
| `Permission`       | One action on a resource kind, such as `openclaw.agents.read` or `openclaw.agents.deploy`.                                                     |
| `Role`             | A named set of Permissions.                                                                                                                    |
| `AccessBinding`    | Assignment of a Role to a `Principal`, `ServicePrincipal`, `WorkloadIdentity`, or `Group` at Installation, Namespace, or exact-resource scope. |
| `Restriction`      | A platform-wide guardrail that narrows otherwise allowed permissions.                                                                          |

OCC resolves a human to an existing `Principal` using immutable external
identity, such as provider, issuer, and subject. Automation resolves to an
existing `ServicePrincipal`. An unknown identity is denied; admission cannot
create a platform identity. Email, display name, authentication, and tenant
admission do not grant a permission.

An `AccessBinding` grants a Role at Installation, Namespace, or exact-resource
scope. Installation-scoped bindings administer the Installation and its
Namespaces. Namespace-scoped bindings apply only within one tenant.
Exact-resource bindings apply only to one named resource within its Namespace.

A `Group` belongs to its Installation or to one Namespace. A
Namespace-scoped Group can receive bindings only within that Namespace. A
`ServicePrincipal` belongs to exactly one Installation or one Namespace. An
installation-scoped `ServicePrincipal` can receive administrative bindings
only in its Installation. A Namespace-scoped `ServicePrincipal` can receive
bindings only in its Namespace or on exact resources within that Namespace.
An Agent's `WorkloadIdentity` can receive bindings only for its own Namespace
or exact resources within that Namespace.

OCC creates and owns each Agent's `WorkloadIdentity`. Every admitted revision
and Agent workload for that Agent uses the same identity, but only the Agent
workload bound to its single active revision can act. An Agent workload cannot
assume a human session, inherit a creator's Role, use the deploying user's
credentials or provider sessions, or select another Agent's identity.

Each Agent has one `WorkloadIdentity` backed by a dedicated Kubernetes
`ServiceAccount`. Its workload authenticates to OCC using a short-lived,
pod-bound `ServiceAccount` token. OCC verifies the selected data-plane target's
trusted issuer, that the token is valid for OCC, and that it belongs to the
exact backing Kubernetes namespace, `ServiceAccount`, and active workload
associated with the Agent's `WorkloadIdentity` and active `AgentRevision`.
For each runtime operation, OCC checks the workload's current roles,
permissions, and applicable Restrictions. A candidate, retired revision,
revoked permission, or incorrectly scoped workload cannot authorize a runtime
or secret-broker operation.

## Runtime trust across targets

The dedicated gateway and Harness cross an explicit trust and connectivity
boundary even when their selected runtime targets share a cluster. Each peer
must verify its exact Agent-owned counterpart and the admitted route binding;
runtime traffic is permitted only for the exact Namespace, Agent, and active
revision. A reachable endpoint, shared cluster, or matching namespace name is
not identity evidence. Missing or mismatched peer identity, ownership, route
binding, or permitted connectivity leaves routing disabled.

The dedicated gateway is a trusted control-plane workload scoped to its owning
Agent. Trusted placement gives it no OCC authorization authority, broad
controller credentials, or access to other tenants. It retains its
separate runtime identity and never receives the Harness's `WorkloadIdentity`
or model credential. Network access is limited to each component's admitted
operations; moving across targets cannot broaden those permissions. The Driver
must realize mutually authenticated, protected connectivity. Direct routing
versus reverse tunnel/relay and concrete credential protocols remain deferred;
this design selects no service mesh or public endpoint.

## Authorization model

Each resource kind has exactly one authoritative `IAMDriver`. Installation
configuration selects the Driver; a request, Agent, external system, or Driver
cannot choose or replace it.

`OCCIAMDriver` is the native implementation. It authorizes an exact action
from the requesting identity's applicable `AccessBinding`, `Role`,
`Permission`, and `Restriction`. A native operation without an applicable
binding and permission is denied.

An external `IAMDriver` authorizes the resource kinds explicitly assigned to
it by using its external system's policy and enforcing applicable platform
Restrictions. An OCC-owned `Agent` or
`AgentRevision` may use an external authorization Driver without becoming an
externally owned resource. A `Channel` may continue to use `OCCIAMDriver`
when that external system does not authorize Channels.

For `create`, OCC authorizes the containing Installation or Namespace through
the selected `IAMDriver` for the resource kind being created. For `list`, OCC
uses that resource kind's authoritative `IAMDriver` to authorize the
resource-level `read` action for each candidate within the exact requested
Namespace. A listing returns only resources the caller is individually
authorized to read. An exact-resource binding makes a resource visible only
when it grants `read`; a deploy or update permission does not grant discovery.
OCC filters authorized resources before pagination and fails the list when
its selected authority is unavailable. Installation-scoped listings apply the
same rule within the exact Installation. Scope constrains the request but
never substitutes for resource-level permission. For another operation on an
existing resource, OCC selects the `IAMDriver` for that resource's kind and
authorizes the exact resource.

An operation that references multiple resources requires one successful
decision from each resource's authoritative `IAMDriver`. An allow for the
parent resource does not authorize its references. Platform Restrictions
independently narrow native and external authorization. Each selected Driver
enforces the Restrictions applicable to its role; unsupported,
unavailable, or unverifiable enforcement denies the operation. A Restriction
cannot grant permission, replace an authoritative policy, or select an
integration. OCC does not retry a denied or unavailable decision against
another authorization Driver.
