# Default users and built-in Roles

An Installation administrator can let selected people create their own
Namespaces. Each such person is a member of the built-in **Default users**
Group. A member who creates a Namespace becomes its owner and can complete the
regular Agent workflow there without other grants. This page defines the
built-in Roles, the Group, the Namespace limit, the owner binding, and the
grants that OCC writes at deployment. To add or remove a member, follow
[Let people create their own Namespaces](../../guides/topics/iam.md#let-people-create-their-own-namespaces).
[Authorization](../authorization.md) defines the general policy model.

## Built-in Roles

The database stores three Installation-level Roles. Nobody can change or delete
them, and each Role admits only one binding shape:

| Role ID                         | Name             | Permissions                                   | Permitted bindings                                                                   |
| ------------------------------- | ---------------- | --------------------------------------------- | ------------------------------------------------------------------------------------ |
| `role_builtin_default_user`     | Default User     | `namespace:create`                            | Only `binding_builtin_default_users`, to the Default users Group, Installation-wide. |
| `role_builtin_namespace_member` | Namespace member | The member set below                          | Namespace-wide, to a Principal or a Group. Never an exact resource.                  |
| `role_builtin_namespace_owner`  | Namespace owner  | The member set below, plus `namespace:delete` | Namespace-wide, to one identity. Never an exact resource. At most one per Namespace. |

The member set is:

| Resource kind                 | Actions                                                                                               |
| ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| `agent`                       | `create`, `read`, `update`, `delete`, `deploy`, `operate`, `administer`, `read_logs`, `manage_policy` |
| `configuration`, `preset`     | `create`, `read`, `update`, `delete`                                                                  |
| `secret`, `credential_source` | `create`, `read`, `update`, `delete`, `operate`                                                       |
| `sandbox_policy`              | `read`, `update`                                                                                      |
| `agent_revision`, `namespace` | `read`                                                                                                |

The set has no `service_account` or `installation` permissions. A member cannot
create a service account or associate one with an Agent. Per-Agent sandbox
policy editing still needs an administrator to enable it; see
[policy authority](../sandbox-policies.md#authority-and-admission).

Database triggers refuse updates and deletes of the three Roles, the Default
users Group, and its binding. The `iam_access_bindings_built_in_role_shape`
constraint enforces the binding shapes in the table, and a unique index allows
one owner binding for each Namespace. The
[Namespace policy API](../authorization.md#manage-namespace-policy) cannot bind
these Roles because they are not Namespace Roles, and
[account provisioning](../authentication.md#account-provisioning) refuses them
as a `roleId`. OCC writes the owner binding when a member creates a Namespace.
No current operation binds the Namespace member Role.

## Default users Group

The Group `group_builtin_default_users` ("Default users") holds Installation
Principals: human accounts without a Namespace. Its binding gives each member
`namespace:create` through the Default User Role. Signing in does not add a
person to the Group; an Installation administrator adds each member explicitly.

| Operation                                 | Result                                                            |
| ----------------------------------------- | ----------------------------------------------------------------- |
| `GET /iam/default-users`                  | `200` with `data`, a list of `{ "principalId": "..." }` entries.  |
| `PUT /iam/default-users/{principalId}`    | `204`. Adding an existing member changes nothing.                 |
| `DELETE /iam/default-users/{principalId}` | `204`. Removing a Principal that is not a member changes nothing. |

Each operation requires Installation `administer`. The
[generated API reference](../api.md#get-iamdefaultusers) owns the schemas.
There is no CLI or console support.

- A `principalId` that is not an Installation Principal, such as a
  ServicePrincipal, returns `400 INVALID_REQUEST` at `/principalId`.
- A disabled acting account returns `403`.
- An IAM Driver without the Group membership methods, or one that does not
  declare `namespacePolicyTransaction: "platform-unit-of-work"`, returns
  `503 DEPENDENCY_UNAVAILABLE`; see the [IAM Driver contract](../drivers/iam.md#group-membership-and-namespace-owner-operations).

Each `PUT` and `DELETE` records `openclaw.iam.default_users.add` or
`openclaw.iam.default_users.remove` with the Installation as resource and
`groupId`, `principalId`, and `changed` in details. `changed` is `false` when
the membership already matched.

Removal stops new Namespace creation at once. The Namespaces that the person
owns, and their owner bindings, remain. To end that access, delete the owner
binding by its ID through the Namespace policy API, or delete the Namespace.

## Create a Namespace as a member

`POST /namespaces` takes the owner path only when every Role that grants the
caller `namespace:create` is the Default User Role. In one transaction, OCC:

1. Locks the caller as a creator and counts the Namespaces whose `createdBy` is
   the caller and whose status is not `deleting`.
2. Refuses with `409 RESOURCE_CONFLICT` when the count has reached the limit.
   The message states the count and the limit.
3. Stores the caller's Principal ID as `createdBy`. Namespace responses return
   this field.
4. Binds the caller to the Namespace owner Role, Namespace-wide, with binding
   ID `binding_owner_<namespace-id>`. The audit event is
   `openclaw.iam.access_bindings.create` with `reason: "namespace_owner"`.
5. Creates the Namespace's default Presets under the new owner grant.

A caller who has `namespace:create` through any other Role, such as the
bootstrap administrator, gets no `createdBy`, no owner binding, and no limit.
The owner path needs an IAM Driver with `createNamespaceOwnerBinding` that joins
the transaction; otherwise the request returns `503` and creates nothing.
`existingNamespace` still requires Installation `administer`.

The `defaultUser.namespaceLimit` field in
[Installation startup configuration](../configuration.md#installation-startup-configuration)
sets the limit for each member. It defaults to `1`; `0` lets members create no
Namespaces. A Namespace stops counting when its deletion starts. Lowering the
limit removes no Namespace; it refuses new ones until the count is below it.

## Grant an Agent its credentials at deployment

The Agent's own ServicePrincipal needs `operate` on each Secret and credential
source the Agent uses. When a built-in Namespace member or owner Role is among
the Roles that allow the caller `agent:deploy`, the deploy request writes the
missing grants. OCC checks each source that the Agent references:

- Secrets in the Configuration's `secretBindings`.
- The Secret or credential source in the Agent's `harnessAuth`.
- Each entry in the Agent's `credentialSources`.

For each source where a built-in Namespace Role also allows the caller
`operate`, and the Agent's ServicePrincipal does not have `operate`, OCC binds
the ServicePrincipal to that exact source. It uses the Role
`role_<namespace-id>_agent_secret_operate` or
`role_<namespace-id>_agent_credential_source_operate`, created on first use,
and the binding ID `binding_<agent-id>_<source-id>_operate`. Each binding
records `openclaw.iam.access_bindings.create` with the source as resource and
`reason: "agent_deploy"` and `agentId` in details. The grants commit with the
deployment; a refused deployment writes none.

A deploy that only custom Roles allow writes no grant. The Agent principal check
then refuses it until an administrator grants access, as in
[Let an Agent use a Secret](../../guides/topics/iam.md#let-an-agent-use-a-secret).
OCC does not remove these grants when the Agent stops using a source. Deleting
the Agent or the source removes them, as
[Manage Namespace policy](../authorization.md#manage-namespace-policy) describes.

## Current limits

These parts of the Default users design are not implemented:

- Identity provider group mappings and membership changes at sign-in.
  Administrators still create each account and add each member.
- Shared team Namespaces. Nothing binds the Namespace member Role.
- Removal of deploy-time grants when an Agent stops using a source.
- CLI and console support for Default users.

## Related

- [Namespace IAM policy flow](../../flows/namespace-iam-policy.md#6-default-users-namespace-owners-and-deploy-time-grants)
- [Namespaces](../namespaces.md)
- [Permissions cheat sheet](../cheatsheets/permissions.md)
