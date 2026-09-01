# Authorization

Identity and access management (IAM) determines who can read, create, change,
or operate OpenClaw Enterprise resources. Every operation is checked against
its exact action, resource, and [Namespace](namespaces.md). Requests without an
explicit matching grant are denied. This page defines the current authorization
contract; [authentication](authentication.md) defines how API clients establish
a session or verify a service key.

```text
Principal, ServicePrincipal, or Group
        │
        ▼
AccessBinding ──► Role ──► Permission
        │                     │
        └── exact scope ──────┘
                 │
                 ▼
       Matching Restriction?
           yes ──► deny
            no ──► allow
```

An authenticated principal is not automatically authorized. A Better Auth
session or service API key establishes the caller identity; the selected IAM Driver separately
checks whether that principal can perform the requested operation.

## Supported policy surface

Fresh native-IAM bootstrap provisions the human administrator and one
Installation-scoped, non-Agent ServicePrincipal. Each receives its own binding
to the same administrator Role, with no Namespace or resource filter:

| Resource kind                      | Actions                                         |
| ---------------------------------- | ----------------------------------------------- |
| `installation`                     | `administer`, `read`                            |
| `namespace`                        | `create`, `read`, `delete`                      |
| `configuration`, `service_account` | `create`, `read`, `update`, `delete`            |
| `secret`                           | `create`, `read`, `update`, `delete`, `operate` |
| `agent`                            | `create`, `read`, `update`, `deploy`, `operate` |
| `agent_revision`                   | `read`                                          |

These grants cover existing and future Namespaces in this Installation, subject
to exact authorization and matching Restrictions. They confer no Kubernetes or
provider authority and no Agent-delete permission. Removing the original human
account does not remove the service identity. See
[bootstrap authentication](authentication.md#installation-and-account-ownership)
for credential delivery and lifecycle.

Administrators can provision additional local authentication accounts with a
binding to an existing Role, as defined in
[account provisioning](authentication.md#account-provisioning). Public signup
is disabled. Creating an account does not create a Role or implicitly grant
administrator rights.

The current API does not expose general CRUD endpoints for Groups, Roles,
AccessBindings, or Restrictions. The native IAM implementation and persisted
policy support these concepts internally. The policy records below illustrate
their semantics; they are not public API request bodies.

## Principals

A principal names the actor requesting access. The platform has exactly two
principal types:

- **Principal:** An explicitly provisioned human identity identified by its
  trusted issuer and immutable subject.
- **ServicePrincipal:** An automation identity scoped to the Installation or
  one Namespace. Each [Agent](agents.md) owns exactly one immutable,
  Namespace-scoped ServicePrincipal; ordinary service principals can represent
  non-Agent automation.

The controller authenticates a Better Auth session for the human Principal or a
[service API key](authentication.md#service-api-keys) for an explicitly provisioned,
non-Agent ServicePrincipal. Service-key lookup supplies the verified
`servicePrincipalId` and its stored Namespace to the selected IAM Driver; it does
not reinterpret a human issuer/subject as an automation identity.
An Agent created or deployed by that Principal retains its own separate service
principal. Agent-owned service principals have the same role-granted platform
capabilities as human Principals, subject to their Namespace scope, exact
resource grants, and matching Restrictions. When explicitly selected, the
[Kubernetes Compute Driver](drivers/kubernetes-compute.md) provisions an Agent-specific
ServiceAccount and can project a short-lived, audience-scoped ServiceAccount
token into that Agent's revision Pods. This projected token is credential
evidence for the Agent's existing ServicePrincipal, not another platform
principal. OCC token verification, identity exchange, and ServicePrincipal
workload authentication through the controller API remain deferred. Ordinary
service keys are deliberately unavailable to Agent-owned principals.

An unknown identity is denied. Email addresses, display names, caller-supplied
identity headers, or membership in another Namespace do not grant access.

## Permissions and Roles

A Permission allows one action on one resource kind. Supported permission
actions are `create`, `read`, `update`, `delete`, `deploy`, `operate`, and
`administer`; not every action has a corresponding public endpoint yet. Any of
these actions can be granted to either a human Principal or an Agent-owned
ServicePrincipal through an appropriately scoped Role and AccessBinding.

Resource kinds currently include `installation`, `namespace`, `configuration`,
`agent`, `agent_revision`, and `service_account`.

An OCC-owned [service account](service-accounts.md) is not an IAM principal.
Creation requires `create` in its exact Namespace; account operations require
their exact-account permission. Associated Agent operations require account
`read`; updating/detaching requires current-account `read`, and replacement
requires `read` on both old and new accounts. IAM never accesses credentials.

The [generated API reference](api.md) documents session and service-key authentication
and the exact permissions required by every operation. Its source is the
[generated OpenAPI contract](../../packages/contracts/openapi/occ-api.openapi.json),
where each human-readable operation description is accompanied by an
`x-openclaw-permissions` array containing each required `action`, `resourceKind`,
and scope. Collection scopes distinguish access to the requested parent from
the separate permission checked for each returned resource.

A Role groups Permissions:

```json
{
  "id": "role-support-agents",
  "namespaceId": "ns_45b6dbdb-2fc2-4c2c-9cc4-a94cf26cc6c2",
  "permissions": [
    { "action": "read", "resourceKind": "agent" },
    { "action": "create", "resourceKind": "agent" }
  ]
}
```

This example illustrates an internal policy record; there is currently no
public API for submitting it.

## Access bindings and Groups

An AccessBinding attaches a Role to one principal or Group at a specific scope.
For example, this internal record grants the preceding Role to a Principal in
the `support` Namespace:

```json
{
  "id": "binding-support-alex",
  "namespaceId": "ns_45b6dbdb-2fc2-4c2c-9cc4-a94cf26cc6c2",
  "subjectKind": "identity",
  "subjectId": "principal-alex",
  "roleId": "role-support-agents"
}
```

Groups collect human Principals so one binding can grant the same Role to
multiple members; ServicePrincipals receive direct AccessBindings rather than
Group membership. Membership is direct and must remain inside the Group's scope;
a Namespace-scoped Group cannot grant access in another Namespace.

Bindings can apply to the singleton Installation, one Namespace, or one exact
resource. A binding without `namespaceId` is Installation-wide; a
Namespace-scoped binding applies only to its exact Namespace. An exact-resource
binding additionally identifies the resource kind and ID.

## Restrictions

A Restriction narrows permissions that would otherwise be granted. It can deny
an exact action for a resource kind, a Namespace, or an exact resource:

```json
{
  "id": "restriction-support-deploy",
  "namespaceId": "ns_45b6dbdb-2fc2-4c2c-9cc4-a94cf26cc6c2",
  "action": "deploy",
  "resourceKind": "agent",
  "effect": "deny"
}
```

A matching Restriction overrides direct identity grants and Group grants. A
Restriction never grants access, expands scope, or selects a different
authorization provider.

## Authorization decisions

For each protected operation, the controller:

1. Verifies the Better Auth session or service key and resolves its existing
   Principal or non-Agent ServicePrincipal through the selected IAM Driver.
2. Uses the server-configured IAM Driver for the requested resource.
3. Loads current policy, including principal bindings and direct Group memberships.
4. Requires a Role Permission matching the exact action and resource kind.
5. Verifies the exact Installation, Namespace, or resource scope.
6. Rejects matching Restrictions equally for human and service principals.
7. Records attributable authorization evidence without exposing credentials.

Lists are also authorized per resource. Permission to deploy an Agent does not
automatically grant permission to read it, and permission to read one Agent
does not expose every Agent in the Namespace.

The selected IAM Driver loads current authoritative policy for each identity
lookup and authorization decision. Account and permission changes become
visible across controller instances without restarting or replacing the Driver.

An unavailable IAM Driver, invalid policy, missing grant, mismatched scope, or
ambiguous identity fails closed.

## Denials and failures

- `401`: The session cookie or service key is missing, invalid, expired, or revoked.
- `403`: The principal lacks an exact grant, belongs to another Namespace, or
  matches a deny Restriction.
- `404`: The requested resource does not exist under its exact parent.
- `503 DEPENDENCY_UNAVAILABLE`: The selected IAM or audit dependency is
  unavailable; no fallback authorization provider is used.
- A resource is absent from a list: Your identity may not have `read`
  permission for that specific resource.
- You cannot create Roles or Groups through HTTP: Public IAM-management
  endpoints have not been implemented.

## Evidence and related references

[Native IAM conformance tests](../../tests/conformance/iam.test.mjs) cover
explicit identities, exact scopes, Group membership, Restrictions, current
policy loading, and failures. [API integration tests](../../tests/integration/occ-api.test.mjs)
cover resource filtering, Namespace isolation, attributable audit events, and
failures without orphaned state. The current policy implementation is
[the IAM package](../../packages/iam/src/index.ts).

For a working authenticated request, see the
[quickstart](../guides/quickstart.md#read-the-installation-with-the-bootstrap-service-key).

- [API reference](api.md)
- [Namespaces](namespaces.md)
- [Agents](agents.md)
- [Service accounts](service-accounts.md)
- [Kubernetes Compute Driver](drivers/kubernetes-compute.md)
- [Controller configuration](settings.md)
- [Implementation architecture](../ARCHITECTURE.md)

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-08-31 17:43: Document fresh human/service administrator bootstrap, private key delivery, and operator recovery. (codex/01a05a69-3fbe-7441-9e6d-20394758cf94 - 0797098646028ac00cb26cd4afcbc9b2cf8bcb24)

- [2026-08-28 17:54]: Reorganize as a current feature reference; move procedural setup to the shared guides. (01a036f4-cf1d-7cc1-bbc1-000879038ac8 - 4270aa29b7015562049f46c6027962fd85b584a9)
