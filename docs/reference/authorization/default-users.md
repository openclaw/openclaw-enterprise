# Default users and built-in Roles

An Installation administrator can let selected people create Agents without
other grants. Each such person is a member of the built-in **Default users**
Group. Members create Agents, Configurations, Secrets, and credential sources in
the shared `default` Namespace, and each creator owns what it creates. An
Installation setting can also let members create their own Namespaces. This page
defines the built-in Roles, the Group, the Owner bindings, the Namespace create
setting, and the grants that OCC writes at deployment. To add or remove a
member, follow
[Let people create Agents](../../guides/topics/iam.md#let-people-create-agents).
[Authorization](../authorization.md) defines the general policy model.

## Built-in Roles

The database stores four Installation-level Roles. Nobody can change or delete
them, only OCC binds them, and each Role admits one binding shape:

| Role ID                          | Name              | Permissions                                      | Permitted bindings                                                                                                   |
| -------------------------------- | ----------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `role_builtin_agent_creator`     | Agent Creator     | The Agent Creator set below                      | Only `binding_builtin_default_users_agent_create`: Default users, Namespace-wide in one Namespace.                   |
| `role_builtin_namespace_creator` | Namespace Creator | `namespace:create`                               | Only `binding_builtin_default_users_namespace_create`: Default users, Installation-wide.                             |
| `role_builtin_owner`             | Owner             | The Namespace set below, plus `namespace:delete` | One identity in one Namespace: an exact resource that is not a Namespace, or Namespace-wide for the whole Namespace. |
| `role_builtin_namespace_member`  | Namespace member  | The Namespace set below                          | Namespace-wide. No current operation binds it.                                                                       |

The Agent Creator set is `create` on `agent`, `configuration`, `secret`, and
`credential_source`, and `read` on `namespace` and `preset`.

The Namespace set holds every action that OCC checks inside a Namespace:

| Resource kind                                | Actions                                                                                               |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `agent`                                      | `create`, `read`, `update`, `delete`, `deploy`, `operate`, `administer`, `read_logs`, `manage_policy` |
| `configuration`, `preset`, `service_account` | `create`, `read`, `update`, `delete`                                                                  |
| `secret`, `credential_source`                | `create`, `read`, `update`, `delete`, `operate`                                                       |
| `sandbox_policy`                             | `read`, `update`                                                                                      |
| `agent_revision`, `namespace`                | `read`                                                                                                |

An exact binding applies only the permissions whose kind matches its resource,
so one Owner Role serves every resource kind. An exact Agent binding also
applies to the Agent's revisions and sandbox policy. No built-in Role changes IAM
policy or holds an `installation` permission. Per-Agent sandbox policy editing
still needs an administrator to enable it; see
[policy authority](../sandbox-policies.md#authority-and-admission).

Database triggers refuse updates and deletes of the four Roles, the Default
users Group, and the Agent Creator binding. The
`iam_access_bindings_built_in_role_shape` constraint enforces the binding
shapes in the table. The
[Namespace policy API](../authorization.md#manage-namespace-policy) cannot bind
these Roles because they are not Namespace Roles, and
[account provisioning](../authentication.md#account-provisioning) refuses them
as a `roleId`.

## Default users Group

The Group `group_builtin_default_users` ("Default users") holds Installation
Principals: human accounts without a Namespace. Signing in does not add a person
to the Group; an Installation administrator adds each member explicitly.

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
  `503 DEPENDENCY_UNAVAILABLE`; see the
  [IAM Driver contract](../drivers/iam.md#group-membership-and-built-in-binding-operations).

Each `PUT` and `DELETE` records `openclaw.iam.default_users.add` or
`openclaw.iam.default_users.remove` with the Installation as resource and
`groupId`, `principalId`, and `changed` in details. `changed` is `false` when
the membership already matched.

Removal stops new creates at once. Everything the person created stays: their
Owner bindings, Namespaces, Agents, and deploy-time grants remain until an
administrator deletes them or moves the Owner binding. Without Agent Creator, a
removed person loses `namespace:read` on `default` and cannot reach their Agents
there through the API, but those Agents keep running.

## The default Namespace

Default users create Agents in the Namespace named `default`, which
[Installation bootstrap](../namespaces.md) creates. When OCC creates a Namespace
with that name, it also writes the Agent Creator binding for Default users
there, audited as `openclaw.iam.access_bindings.create` with
`reason: "default_namespace"`. Migration `0066_default_users` writes the same
binding for an Installation that already has the Namespace.

Members of `default` share one Kubernetes namespace. Lists return only the
resources that the caller can read, so each member sees only their own Agents,
Configurations, Secrets, and credential sources. The
[Kubernetes NetworkPolicies](../security.md) stop one Agent from reaching
another in the same namespace. The Namespace's ResourceQuota is shared; OCC has
no per-person limit.

A Namespace name stays reserved after the Namespace is deleted. If an
administrator deletes `default`, Default users can no longer create Agents
except in Namespaces they own.

## Creators own what they create

When a principal creates a Namespace, Agent, Configuration, Secret, credential
source, Preset, or ServiceAccount, OCC binds that principal to the Owner Role in
the same transaction. Guided provisioning binds the person who requested it to
the Agent and Configuration it creates. The rule covers every creator, including
administrators and ServiceAccounts:

- A Namespace gets a Namespace-wide binding, so the creator holds every
  Namespace permission there. That grant lets the same transaction create the
  Namespace's default Presets.
- Any other resource gets an exact binding on that resource. An Agent's Owner
  binding also covers its revisions and sandbox policy, so the owner can read
  each revision and the deployment status of its deploys.
- The binding ID is `binding_owner_<resource-id>`. The audit event is
  `openclaw.iam.access_bindings.create` with `reason: "creator"`.

Deleting a resource deletes its exact bindings, including the Owner binding. To
change an owner, an administrator deletes the Owner binding by its ID through
the Namespace policy API and grants the new owner. An administrator's Owner
bindings add nothing to the administrator binding, but they stay if that binding
is removed.

Each create or deploy that writes an Owner binding or a deploy-time grant
holds the caller's session until COMMIT and authorizes only after that. A
sign-out, account disable, or removal from Default users commits either before
it, so the request is refused and writes nothing, or after its COMMIT.

OCC writes no Owner binding when the selected IAM Driver has no
`createOwnerBinding` member. A Driver that has it but does not join the platform
transaction makes every create return `503` and write nothing.

## Let Default users create Namespaces

The `defaultUser.namespaceCreate` field in
[Installation startup configuration](../configuration.md#installation-startup-configuration)
is `false` when absent. At startup, and right after Installation bootstrap, OCC
writes or deletes the Namespace Creator binding to match it. Each change records
`openclaw.iam.access_bindings.create` or `openclaw.iam.access_bindings.delete`
with the Installation as actor and resource and
`reason: "installation_configuration"`.

With the setting on, a member's `POST /namespaces` creates the Namespace and its
Namespace-wide Owner binding. `existingNamespace` still requires Installation
`administer`. Turning the setting off stops new Namespaces; the Namespaces that
members own stay. OCC has no Namespace limit for each person.

## Grant an Agent its credentials at deployment

The Agent's own ServicePrincipal needs `operate` on each Secret and credential
source the Agent uses. When the built-in Owner or Namespace member Role is among
the Roles that allow the caller `agent:deploy`, the deploy request writes the
missing grants. OCC checks each source that the Agent references:

- Secrets in the Configuration's `secretBindings`.
- The Secret or credential source in the Agent's `harnessAuth`.
- Each entry in the Agent's `credentialSources`.

For each source where a built-in Role also allows the caller `operate`, and the
Agent's ServicePrincipal does not have `operate`, OCC binds the ServicePrincipal
to that exact source. In `default`, that is only a source the caller owns. OCC
uses the Role `role_<namespace-id>_agent_secret_operate` or
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
- Namespace-wide and Group bindings through the Namespace policy API.
- Shared team Namespaces. Nothing binds the Namespace member Role.
- Removal of deploy-time grants when an Agent stops using a source.
- CLI and console support for Default users.

## Related

- [Namespace IAM policy flow](../../flows/namespace-iam-policy.md#6-default-users-owners-and-deploy-time-grants)
- [Namespaces](../namespaces.md)
- [Permissions cheat sheet](../cheatsheets/permissions.md)
