# Default users and configured Roles

An Installation administrator can let people create Agents without other
grants. The Installation configuration declares ordinary Roles, Groups, and
Group bindings. Each account created through the accounts API joins the
configured default Groups. A Group binding can let members create Agents,
Configurations, Secrets, and credential sources in the shared `default`
Namespace, or create Namespaces. Each creator owns what it creates. This page
defines the `iam` configuration, how OCC applies it, the Owner bindings, and the
grants that OCC writes at deployment. To set it up, follow
[Let people create Agents](../../guides/topics/iam.md#let-people-create-agents).
[Authorization](../authorization.md) defines the general policy model.

## Installation iam configuration

The optional `iam` block of the
[Installation startup configuration](../configuration.md#installation-startup-configuration)
has the following fields:

| Field                | Value                                                                                                                                           |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `roles`              | Roles, each an `id` and a nonempty `permissions` list of `resourceKind:action` strings, such as `agent:create`.                                 |
| `defaultUserGroups`  | Group names. Each account created through `POST /api/auth/accounts` joins each of these Groups.                                                 |
| `githubTeamMappings` | Optional rules for attached GitHub accounts. Each entry names an `id`, numeric `organizationId` and `teamId` strings, and a configured `group`. |
| `ownerRole`          | The ID of a configured Role. OCC binds each creator to it on what it creates.                                                                   |
| `roleBindings`       | Entries of `group`, `role`, and `scope`. The scope is `installation`, or `{ namespace: <name> }` for each Namespace that has that name.         |

Role IDs and Group names are 1–63 lowercase letters, digits, `_`, or `-`. A
permission must be one that some operation checks, as the
[permissions cheat sheet](../cheatsheets/permissions.md) lists, and cannot be an
`installation` permission. A binding names a configured Role. A Group can receive members from a default Group assignment or a configured GitHub team. Startup refuses a
configuration that breaks these rules. This example lets Default users create
Agents in `default` and Namespaces of their own, and own what they create:

```yaml
iam:
  roles:
    - id: agent_creator
      permissions:
        - agent:create
        - configuration:create
        - secret:create
        - credential_source:create
        - namespace:read
        - preset:read
    - id: namespace_creator
      permissions: [namespace:create]
    - id: owner
      permissions:
        [
          agent:create,
          agent:read,
          agent:update,
          agent:delete,
          agent:deploy,
          agent:operate,
          agent:administer,
          agent:read_logs,
          agent:manage_policy,
          agent_revision:read,
          sandbox_policy:read,
          sandbox_policy:update,
          configuration:create,
          configuration:read,
          configuration:update,
          configuration:delete,
          preset:create,
          preset:read,
          preset:update,
          preset:delete,
          service_account:create,
          service_account:read,
          service_account:update,
          service_account:delete,
          secret:create,
          secret:read,
          secret:update,
          secret:delete,
          secret:operate,
          credential_source:create,
          credential_source:read,
          credential_source:update,
          credential_source:delete,
          credential_source:operate,
          namespace:read,
          namespace:delete,
        ]
  defaultUserGroups: [default-user]
  ownerRole: owner
  roleBindings:
    - group: default-user
      role: agent_creator
      scope: { namespace: default }
    - group: default-user
      role: namespace_creator
      scope: installation
```

Do not bind the Owner Role to a Group: a Namespace-wide Owner binding gives
every member every permission on every resource in that Namespace.

## How OCC applies the configuration

At startup, and right after Installation bootstrap, OCC writes the configuration
to IAM policy in one transaction:

| Configuration item | IAM policy row                                            |
| ------------------ | --------------------------------------------------------- |
| Role `<id>`        | Installation Role `role_config_<id>`, named `<id>`.       |
| Group `<name>`     | Installation Group `group_config_<name>`, named `<name>`. |
| Binding in a scope | Group binding `binding_config_<digest>` with no resource. |

OCC adds the rows that are missing and updates a Role's permissions when they
changed. It deletes each `binding_config_` binding that the configuration no
longer lists, then each configured Role or Group that the configuration no
longer lists. If a binding that OCC did not configure, such as an Owner
binding, still uses a removed Role or Group, startup fails and names the
binding. Delete that binding, or list the Role or Group again. API and worker
must use the same `iam` value.

When OCC creates a Namespace, it writes the configured bindings whose scope names
that Namespace in the same transaction. Bootstrap creates `default`, so a binding
scoped to `default` exists once the configuration is applied. Deleting a
Namespace deletes its configured bindings with the rest of its policy.

Each change records an audit event with the Installation as actor and
`reason: "installation_configuration"`, or the creator as actor and
`reason: "namespace_create"`: `openclaw.iam.roles.create`, `.update`, or
`.delete`; `openclaw.iam.groups.create` or `.delete`; and
`openclaw.iam.access_bindings.create` or `.delete`.

Database constraints keep a `role_config_` Role at Installation scope without
`installation` permissions. Only configured Roles can change, and only
configured Groups and their memberships can be deleted. The
[Namespace policy API](../authorization.md#manage-namespace-policy) cannot bind
configured Roles because they are not Namespace Roles. It can delete a
configured binding in a Namespace; the next startup writes it again.
[Account provisioning](../authentication.md#account-provisioning) refuses a
configured Role as `roleId`.

## Group membership

Each account that `POST /api/auth/accounts` creates joins every
`defaultUserGroups` Group in the transaction that creates it. Its
`openclaw.auth.accounts.create` audit event lists them in `groupIds`. GitHub team rules can independently contribute
membership in the same Group.

Administrators can withdraw a GitHub rule’s contribution as described below. An account created before a Group was
listed does not join it. To end a person's access, remove the binding from the
configuration or disable the account.

A configuration change or a disabled account stops new creates at once.
Everything the person created stays: their Owner bindings, Namespaces, Agents,
and deploy-time grants remain until an administrator deletes them or moves the
Owner binding. Without Namespace read on `default`, the person cannot reach
their Agents there through the API, but those Agents keep running.

### Map a GitHub team to a Group

Add a rule for a configured Group, for example:

```yaml
iam:
  githubTeamMappings:
    - { id: support, organizationId: "123", teamId: "456", group: support }
```

Configure up to ten rules, all in one GitHub organization. Organization and team IDs must be positive decimal
strings no greater than `9007199254740991`. The Group must appear in `roleBindings` or `defaultUserGroups`. Use its ordinary
Role binding to choose what members may do. Enable GitHub sign-in and attach the
person’s numeric GitHub subject to their OCE account. On GitHub sign-in, after
any allowlist checks, the API verifies each mapping with the person’s GitHub
token. Every mapped team must be visible to all users who sign in through this
provider. Only organization-visible teams (GitHub API `privacy: closed`) are supported.
A hidden team, even an unrelated one, makes the check unavailable and refuses
fresh GitHub sign-in. A user outside the organization may also lack visibility. Membership includes child teams. A failed check refuses that sign-in and
retains prior access. A verified sign-in and its mapping decisions commit together.

Supply a dedicated, externally rotated GitHub App installation token for the
organization with **Members: read** to the worker. For Helm, set
`auth.github.teamRosterTokenSecretName` to the existing Secret, optionally
set `teamRosterTokenKey` (default `token`), and set `auth.github.egressCidrs`
to the permitted GitHub HTTPS destinations. The worker mounts the Secret
read-only and reads the token on each attempt. Outside Helm, supply
`OCC_AUTH_GITHUB_CLIENT_ID` and an absolute `OCC_GITHUB_TEAM_TOKEN_FILE` on
the worker. The operator owns the token’s installation, permissions and rotation. Before relying
on withdrawal to stop writes, run the same supported release and mapping configuration
on every API and worker replica.

A new or replaced rule must complete its first background read before a GitHub
sign-in can use it. If the worker cannot verify the roster, GitHub sign-in is
refused and the rule grants nothing. After this first success, every six hours
the worker reads all team roster pages, independently verifies
candidate departures and withdraws only the matching rule’s contribution. A
partial read, lost visibility or outage retains the last decisions across
restarts. A roster can contain up to 10,000 members. To confirm a departure,
the reader must also verify the person’s organization-team list within 100 teams. A member on the roster gains access only after a verified sign-in.
A person can keep access through another team or an independent Group grant.
Webhook-driven refresh is proposed future work.

An Installation administrator can inspect `githubTeamRefresh` in
`GET /api/auth/accounts/:userId`. If a rule stays unavailable, check the organization,
team visibility and the worker credential’s installation, expiry and Members permission.
The recovery administrator can use password sign-in during a GitHub outage. To withdraw a person locally, use their
GitHub method ID from that read. GET the override URL below to read its opaque
`version` and the target’s `accountVersion`, then POST both versions:

```http
POST /api/auth/accounts/:userId/methods/:methodId/github-team-mappings/:mappingId/override
Content-Type: application/json

{"withdrawn":true,"expectedVersion":3,"expectedOverrideVersion":"<version from GET>"}
```

Use the same endpoint with `withdrawn: false` and both current versions to clear
the override. A fresh verified GitHub sign-in must follow before that mapping
can grant access again. Existing sessions use the updated Group permissions on
their next protected request. See [RFC-0030](https://github.com/openclaw/openclaw-enterprise/pull/4526).

## The default Namespace

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

When `ownerRole` is set and a principal creates a Namespace, Agent,
Configuration, Secret, credential source, Preset, or ServiceAccount, OCC binds
that principal to the Owner Role in the same transaction. Guided provisioning
binds the person who requested it to the Agent and Configuration it creates. The
rule covers every creator, including administrators and ServiceAccounts:

- A Namespace gets a Namespace-wide binding, so the creator holds every Owner
  permission there. That grant lets the same transaction create the Namespace's
  default Presets.
- Any other resource gets an exact binding on that resource. An Agent's Owner
  binding also covers its revisions and sandbox policy, so the owner can read
  each revision and the deployment status of its deploys.
- The binding ID is `binding_owner_<resource-id>`. The audit event is
  `openclaw.iam.access_bindings.create` with `reason: "creator"`.

Without `ownerRole`, OCC writes no Owner binding. Deleting a resource deletes its
exact bindings, including the Owner binding. To change an owner, an
administrator deletes the Owner binding by its ID through the Namespace policy
API and grants the new owner. An administrator's Owner bindings add nothing to
the administrator binding, but they stay if that binding is removed.

Each create or deploy that writes an Owner binding or a deploy-time grant holds
the caller's session and the IAM configuration lock until COMMIT, and authorizes
only after that. A sign-out, account disable, configuration change, or delete of
an AccessBinding that allowed the request commits either before it, so the
request is refused and writes nothing, or after its COMMIT.

OCC writes no Owner binding when the selected IAM Driver has no
`createOwnerBinding` member. A Driver that has it but does not join the platform
transaction makes every create return `503` and write nothing.

## Grant an Agent its credentials at deployment

The Agent's own ServicePrincipal needs `operate` on each Secret and credential
source the Agent uses. A caller allowed to deploy the Agent writes the missing
grants in the deploy request. OCC checks each source that the Agent references:

- Secrets in the Configuration's `secretBindings`.
- The Secret or credential source in the Agent's `harnessAuth`.
- Each entry in the Agent's `credentialSources`.

For each source that the caller can `operate`, through any Role, and on which
the Agent's ServicePrincipal does not have `operate`, OCC binds the
ServicePrincipal to that exact source. In `default`, a Default user can operate
only the sources they own. OCC uses the Role
`role_<namespace-id>_agent_secret_operate` or
`role_<namespace-id>_agent_credential_source_operate`, created on first use,
and the binding ID `binding_<agent-id>_<source-id>_operate`. Each binding
records `openclaw.iam.access_bindings.create` with the source as resource and
`reason: "agent_deploy"` and `agentId` in details. The grants commit with the
deployment; a refused deployment writes none.

A source that the caller cannot operate gets no grant. The Agent principal check
then refuses the deploy until someone who can operate the source deploys, or an
administrator grants access as in
[Let an Agent use a Secret](../../guides/topics/iam.md#let-an-agent-use-a-secret).
OCC does not remove these grants when the Agent stops using a source. Deleting
the Agent or the source removes them, as
[Manage Namespace policy](../authorization.md#manage-namespace-policy) describes.

## Current limits

These parts of the Default users design are not implemented:

- First-sign-in account creation, Google and OIDC group mappings, and an API
  to add arbitrary Group members.
- Namespace-wide and Group bindings through the Namespace policy API.
- Shared team Namespaces.
- Removal of deploy-time grants when an Agent stops using a source.
- CLI and console support for Default users.

## Related

- [Namespace IAM policy flow](../../flows/namespace-iam-policy.md#6-default-users-owners-and-deploy-time-grants)
- [Namespaces](../namespaces.md)
- [Permissions cheat sheet](../cheatsheets/permissions.md)
