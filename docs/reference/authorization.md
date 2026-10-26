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

## Supported policy surface

Fresh native-IAM bootstrap provisions the human administrator and one
Installation-scoped, non-Agent ServicePrincipal. Each receives its own binding
to the same administrator Role, with no Namespace or resource filter:

| Resource kind                                | Actions                                                                 |
| -------------------------------------------- | ----------------------------------------------------------------------- |
| `installation`                               | `administer`, `read`                                                    |
| `namespace`                                  | `create`, `read`, `delete`                                              |
| `configuration`, `preset`, `service_account` | `create`, `read`, `update`, `delete`                                    |
| `secret`                                     | `create`, `read`, `update`, `delete`, `operate`                         |
| `credential_source`                          | `create`, `read`, `update`, `delete`, `operate`                         |
| `agent`                                      | `create`, `read`, `update`, `delete`, `deploy`, `operate`, `administer` |
| `agent_revision`                             | `read`                                                                  |

These grants cover existing and future Namespaces in this Installation, subject
to exact authorization and matching Restrictions. They confer no Kubernetes or
provider authority. Rerunning bootstrap does not rewrite stored grants, so an
Installation bootstrapped before an action was added to this seed lacks it until
an administrator grants it; `credential_source:update` is one such action.
Custom Roles never gain permissions automatically. The
Preset upgrade extends only the unchanged built-in administrator Role; see
[Preset upgrade eligibility](presets.md#crud-and-permissions). Removing the original human account does not
remove the service identity. See
[bootstrap authentication](authentication.md#installation-and-account-ownership)
for credential delivery and lifecycle.

Administrators can provision additional local authentication accounts with a
binding to an existing Role, as defined in
[account provisioning](authentication.md#account-provisioning). Public signup
is disabled. Creating an account does not create a Role or implicitly grant
administrator rights.

Administrators manage immutable Namespace Roles and exact-resource identity
AccessBindings through the [Namespace policy APIs](#manage-namespace-policy).
Group, membership, Restriction, and broad grant management remain unavailable
through the Namespace policy API. Its creation requests are narrower than the
internal policy models below.

## Principals

A principal names the actor requesting access. The platform has exactly two
principal types:

- **Principal:** An explicitly provisioned human identity identified by its
  trusted issuer and immutable subject.
- **ServicePrincipal:** An automation identity scoped to the Installation or
  one Namespace. Each [Agent](agents.md) owns exactly one immutable,
  Namespace-scoped ServicePrincipal; ordinary service principals can represent
  non-Agent automation.

The controller authenticates a user session for the human Principal or a
[service API key](authentication/service-api-keys.md#service-api-keys) for an explicitly provisioned,
non-Agent ServicePrincipal. Service-key lookup supplies the verified
`servicePrincipalId` and its stored Namespace to the selected IAM Driver; it does
not reinterpret a human issuer/subject as an automation identity.
An Agent created or deployed by that Principal retains its own ServicePrincipal,
with the same role-granted platform capabilities as a human Principal, subject
to its Namespace scope, exact resource grants, and matching Restrictions.
Ordinary service keys are deliberately unavailable to Agent-owned principals.
When explicitly selected, the
[Kubernetes Compute Driver](drivers/kubernetes-compute.md) provisions an Agent-specific
ServiceAccount and can project a short-lived, audience-scoped ServiceAccount
token into that Agent's version Pods. The token is credential evidence for the
Agent's existing ServicePrincipal, not another platform principal.

That evidence comes from its issuing cluster and ServiceAccount; it is not a
portable OCE Agent identity, so a Gateway and dedicated Harness in different
cluster trust domains cannot share one cluster's ServiceAccount identity. OCC
token verification, identity exchange, and ServicePrincipal workload
authentication through the controller API remain deferred: a future path must
verify each environment's local evidence, exchange it for a short-lived
credential scoped to the existing Agent ServicePrincipal and version, and authenticate the Gateway and Harness
independently. Until OCC has that verifier, exchange, authorization, and a
runtime client, the projected token does not authenticate an Agent request.

An unknown identity is denied. Email addresses, display names, caller-supplied
identity headers, or membership in another Namespace do not grant access.

## Permissions and Roles

A Permission pairs an `action` with a `resourceKind`; a Role groups these
Permissions. The kind selects a category such as `agent`, not an individual
Agent ID. The [permissions cheat sheet](cheatsheets/permissions.md) lists the
supported action/kind pairs and operations requiring additional grants.
`read_logs` delegates Agent log access without `administer` and is not granted
by fresh bootstrap.

An OCC-owned [service account](service-accounts.md) is not an IAM principal,
and IAM never accesses its credentials. Creation requires `create` in its exact
Namespace and other operations their exact-account permission; its reference
defines the account `read` that associated Agent operations need.

The [generated API reference](api.md) documents session and service-key
authentication and each operation's exact permissions, taken from the
`x-openclaw-permissions` array (`action`, `resourceKind`, scope) beside each
operation description in the
[generated OpenAPI contract](../../packages/contracts/openapi/occ-api.openapi.json).
Collection scopes distinguish access to the requested parent from the
permission checked for each returned resource.

The following TypeScript interfaces summarize the
[internal models](../../packages/contracts/src/index.ts). Fields without `?`
are required; `?` marks optional model fields, not permission to omit them from
creation requests.

```ts
import type { PermissionAction, ResourceKind } from "@openclaw-enterprise/contracts";

interface Permission {
  action: PermissionAction;
  resourceKind: ResourceKind;
}

interface Role {
  id: string;
  namespaceId?: string;
  name?: string;
  permissions: readonly Permission[];
}
```

`id` identifies the stored Role; `name` is an optional display label, not an
authority. `namespaceId` limits its Permissions to one Namespace; omission means
Installation scope. The Role grants nothing until an AccessBinding assigns it.

## Access bindings and Groups

An AccessBinding attaches a Role to one identity or Group:

```ts
interface AccessBinding {
  id: string;
  namespaceId?: string;
  subjectKind: "identity" | "group";
  subjectId: string;
  roleId: string;
  resourceKind?: ResourceKind;
  resourceId?: string;
}
```

`id` identifies the binding. `subjectKind` selects whether `subjectId` names a
Principal/ServicePrincipal (`identity`) or a Group; `roleId` selects the Role.
`namespaceId` bounds the grant's Namespace. `resourceKind` and `resourceId`
select an exact target and must appear together or both be absent. Only Role
Permissions matching the target kind apply.

With neither target field, a Namespace-scoped binding grants the Role's actions
across matching resource kinds in that Namespace, including future resources.
Omitting both the Namespace and target filters permits Installation-wide grants.
An exact `namespace` target instead grants only Namespace actions; Namespace
`read` never grants access to children or permission to create them.

The [Namespace read schemas](../../packages/contracts/src/api/resources.ts)
require `id` and `namespaceId`, retain optional Role `name`, and can return Group
or untargeted bindings. Their broader shapes do not expand creation support.

Groups collect human Principals so one binding can grant the same Role to
multiple members; ServicePrincipals receive direct AccessBindings rather than
Group membership. Membership is direct and must remain inside the Group's scope;
a Namespace-scoped Group cannot grant access in another Namespace.

## Manage Namespace policy

Namespace policy writes require an IAM Driver that declares
`namespacePolicyTransaction: "platform-unit-of-work"`. Otherwise OCC rejects the
write before calling the Driver, so a later denial cannot leave an external grant.

Human-session policy mutations retain the assigning session through the transaction.
Completed revocation prevents a pending write. PostgreSQL validates session expiry
during COMMIT and rolls back policy and its success audit if the session expired.
A protected write may finish before logout completes.
See the [Namespace IAM flow](../flows/namespace-iam-policy.md) for the implementation.

Use `/namespaces/:namespaceId/iam/roles`,
`/namespaces/:namespaceId/iam/access-bindings`, and
`/namespaces/:namespaceId/iam/service-principals`. Collection `GET` lists policy in
that Namespace (`200`) and `POST` creates a server-identified resource (`201`).
Item `GET` reads one (`200`); item `DELETE` removes only that Role or AccessBinding
(`204`). Missing resources return `404`. A ServicePrincipal created here is a
non-Agent identity fixed to the Namespace with no grant; bind it like any
subject and issue its [service key](authentication/service-api-keys.md). The API
cannot delete one yet: revoke its keys and AccessBindings to remove its access.
Deleting the Namespace does not revoke them, so revoke its keys first.
Lists exclude Installation bootstrap policy but include existing broad and
Group bindings in the Namespace, which deletion can revoke by exact ID. The
narrower subject and target requirements below apply to creation.

Every operation requires Installation `administer` and exact Namespace `read`,
evaluated by the selected IAM Driver and applicable Restrictions. Creating a
binding also requires `read` on its exact target.

`create` is checked against the Namespace rather than an existing resource,
so this API cannot grant it. Binding creation returns `400 INVALID_REQUEST`
(detail path `/roleId`) naming the Permissions when the Role has none for the
target's kind, or holds `create` (a Role stored before Role creation refused
it). One Role may still name several kinds and be bound to a target of each.
Ordinary resource access does not authorize delegation. Drivers without policy
management return `503 DEPENDENCY_UNAVAILABLE`; OCC never substitutes native IAM.

These interfaces summarize the [HTTP creation bodies](../../packages/contracts/src/api/common.ts).
All binding fields are required, including `resourceId`; Role `name` is optional.
OCC generates `id` and supplies `namespaceId` from the URL. Neither belongs in
these request bodies; extra fields are rejected.

```ts
import type { ManagedIAMResourceKind, PermissionAction } from "@openclaw-enterprise/contracts";

interface CreateRoleRequest {
  name?: string;
  permissions: {
    action: PermissionAction;
    resourceKind: ManagedIAMResourceKind;
  }[];
}

interface CreateAccessBindingRequest {
  subjectKind: "identity";
  subjectId: string;
  roleId: string;
  resourceKind: ManagedIAMResourceKind;
  resourceId: string;
}
```

Role creation requires 1–64 duplicate-free Permissions with supported action/kind
pairs. Unsupported pairs such as `secret:read_logs` return `400 INVALID_REQUEST`
at `/permissions`. Although the HTTP enum includes `create`, OCC rejects it at
`/permissions/<i>/action`. Creation cannot produce Group or Namespace-wide bindings.

Hypothetically, allow an Agent to use one model Secret. POST this Role body to
`/namespaces/:namespaceId/iam/roles`:

```json
{
  "name": "Use a model Secret",
  "permissions": [{ "action": "operate", "resourceKind": "secret" }]
}
```

Then POST this AccessBinding body to
`/namespaces/:namespaceId/iam/access-bindings` in the same Namespace, replacing
placeholders with the returned Role's `id`, the Agent's immutable
`servicePrincipalId`, and an existing Secret's ID:

```json
{
  "subjectKind": "identity",
  "subjectId": "<agent-service-principal-id>",
  "roleId": "<role-id>",
  "resourceKind": "secret",
  "resourceId": "<secret-id>"
}
```

These are separate hypothetical creation requests, not a combined policy import.
The Role permits `operate` on the **Secret kind**; the binding limits that grant
to **one Secret ID**. Another Secret needs another binding. Neither JSON object
contains a Secret value.

The subject must be an existing human Principal or a ServicePrincipal in the
path Namespace. A human does not need a separate Namespace ServicePrincipal.
The Role and target must exist in the path Namespace. `namespace` Permissions
support only `read`; for a `namespace` target, `resourceId` must equal the
Namespace ID in the path.
Agent revision `read` needs an `agent_revision` target, not its parent Agent. A
ServiceAccount resource is not an IAM identity. Caller IDs, scope, wildcard
targets, Groups, and unknown permissions are rejected. An invalid Permission,
or a subject, Role or target that is not usable in the path Namespace (including an Agent being
deleted), returns `400 INVALID_REQUEST` with the offending field as the detail
path. Native IAM commits validated policy and its
attributable audit event together; later requests on other replicas see it
without a restart.

For human discovery, grant exact Namespace `read` and separately grant the
required actions on each exact Agent. Human enrollment and grants are separate.

Roles and bindings cannot be updated. Create replacements and explicitly
remove old bindings. A referenced Role cannot be deleted (`409`), and deleting
one binding preserves equivalent and unrelated bindings. Deleting a
Configuration, Preset, Secret, credential source, or ServiceAccount removes the
bindings that target it in the same transaction, and its delete audit event lists
them (`removedAccessBindings`). Agent deletion completes asynchronously and then
removes the bindings that target the Agent or its AgentRevisions or name its
ServicePrincipal as subject; its accepted delete event lists all of them in
`accessBindingsRemovedOnCompletion`. A deleting Agent admits no new binding of
those kinds. Completion also removes the deny Restrictions on the Agent or its
AgentRevisions, at Installation or Namespace scope; the same event lists them in
`restrictionsRemovedOnCompletion`. Each of these three audit lists appears only
when it is nonempty.
Namespace teardown removes the Namespace's bindings and Roles with the tombstone
and records them in the lifecycle event. After an unknown
creation outcome, list and inspect policy before retrying; equivalent bindings
may coexist. Names are labels: inspect permissions before reusing a Role.

Deleting a binding does not establish effective denial: other bindings and
Restrictions still apply. Revocation blocks later admission but cannot retract
already delivered bytes. Stop the Agent and revoke upstream credentials when
immediate containment is necessary; IAM changes do neither automatically.

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

1. Verifies the user session or service key and resolves its existing
   Principal or non-Agent ServicePrincipal through the selected IAM Driver.
2. Uses the server-configured IAM Driver for the requested resource.
3. Loads current policy, including principal bindings and direct Group memberships.
4. Requires a Role Permission matching the exact action and resource kind.
5. Verifies the exact Installation, Namespace, or resource scope.
6. Rejects matching Restrictions equally for human and service principals.
7. Records attributable authorization evidence without exposing credentials.

Lists are also authorized per resource. Permission to deploy an Agent does not
automatically grant permission to read it, and permission to read one Agent
does not expose every Agent in the Namespace. First deployment additionally
checks Agent `read` and `operate` if Compute must generate missing transport
credentials.

[Agent runtime reads](../guides/topics/agent-logs.md#who-can-see-what) use two
tiers on the exact Agent and version: Pod status and Events need Agent
`operate` and `read` plus Agent revision `read`; container log text needs Agent
`read_logs` or `administer` and Agent `read`, which cover every version of that
Agent, including later deployments. A matching
`read_logs` Restriction denies log text even to a holder of `administer`. Each
follow poll is authorized again, so revoking a grant stops the next poll.

The selected IAM Driver loads current authoritative policy for each identity
lookup and decision, so account and permission changes reach every controller
instance without restarting or replacing the Driver.

An unavailable IAM Driver, invalid policy, missing grant, mismatched scope, or
ambiguous identity fails closed.

## Denials and failures

- `401`: The session cookie or service key is missing, invalid, expired, or revoked.
- `403`: The principal lacks an exact grant, belongs to another Namespace, or
  matches a deny Restriction. The message names the grant; see
  [denial messages](cheatsheets/permissions.md#denial-messages).
- `404`: The requested resource does not exist under its exact parent.
- `503 DEPENDENCY_UNAVAILABLE`: The selected IAM or audit dependency is
  unavailable; no fallback authorization provider is used.
- A resource is absent from a list: your identity may lack `read` on that
  specific resource.
- `400` creating a Role or binding: the detail path names the invalid field.
- `409` deleting a Role: the Role is referenced by AccessBindings; remove them
  explicitly first.

## Evidence and related references

The current policy implementation is
[the IAM package](../../packages/iam/src/index.ts).

For a working authenticated request, see the
[quickstart](../guides/quickstart.md#read-the-installation-with-the-bootstrap-service-key).

- [IAM overview](../guides/topics/iam.md)
- [Authorization tests](../testing/local.md#authentication-and-authorization-coverage)
- [Controller configuration](settings.md)
- [Platform architecture](../design.md)

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-10-06 15:40: Agent-targeting bindings are removed on deletion completion; the audit lists appear only when nonempty. (dogfood-r37)

- 2026-10-03 16:45: The Agent delete event lists the Restrictions its completion removes. (deletion-audit-restrictions)

- 2026-09-19 20:53: Document Namespace Role and exact identity AccessBinding management. (codex/01a0bce5-9f29-7110-85fd-6b140674d362 - 06c23b9cf60915ba58baa38b23cf304562e674a1)

- 2026-08-31 17:43: Document fresh human/service administrator bootstrap, private key delivery, and operator recovery. (codex/01a05a69-3fbe-7441-9e6d-20394758cf94 - 0797098646028ac00cb26cd4afcbc9b2cf8bcb24)

- [2026-08-28 17:54]: Reorganize as a current feature reference; move procedural setup to the shared guides. (01a036f4-cf1d-7cc1-bbc1-000879038ac8 - 4270aa29b7015562049f46c6027962fd85b584a9)
