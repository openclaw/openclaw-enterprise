---
status: Proposed
implementation_status: Not implemented
author: mrunalp
---

# Proposal: Default users sign in through identity provider mappings and own what they create

- **ID:** RFC-0026 (provisional; renumber before merge)
- **Created:** 2026-10-29
- **Last updated:** 2026-11-04
- **RFC PR:** [#4207](https://github.com/openclaw/openclaw-enterprise/pull/4207)
- **Implementation plan:** [TASK-0050](../plans/0050-default-users.md)
- **Related:** [Agent Author role (#4045)](https://github.com/openclaw/openclaw-enterprise/pull/4045),
  [Additional Installation administrators (#889)](https://github.com/openclaw/openclaw-enterprise/pull/889),
  [Agent OAuth connections (#3068)](https://github.com/openclaw/openclaw-enterprise/pull/3068),
  [RFC-0006](0006-basic-rbac/index.md), [Authorization](../../docs/reference/authorization.md)

<a id="problem-and-decision"></a>

## Summary

The Installation configuration declares ordinary Roles, Groups, and Group
bindings, and the default Groups that new accounts join. With the example
configuration, members of the **Default users** Group create Agents in the
shared `default` Namespace, and can also create their own Namespaces. Every
creator owns the resource it creates, through a configured Owner Role. An
Installation administrator maps identity provider groups to OCC Groups; at each
sign-in, OCC creates the person's account if a mapping matches and updates their
mapped memberships. An AccessBinding without a resource applies to every
resource in its Namespace, for any Role. Existing flows keep their behavior.

## Motivation

Today every capability starts with an Installation administrator:

- **Accounts.** External sign-in admits only identities that an administrator
  attached to an account created first. Unknown identities fail, and no default
  Role exists ([external sign-in](../../docs/reference/authentication/external-sign-in.md)).
- **Creation.** Only the bootstrap administrator's binding grants `create`,
  because each IAM API binding names one existing resource and one identity.
  A create grants its creator nothing.
- **Agent credentials.** Every IAM write and guided provisioning require
  Installation `administer`. Other users cannot give an Agent access to its
  Secrets and see `MEMBER_GRANT_REFUSED`.

IAM already evaluates Group bindings stored in `iam_groups` and
`iam_group_memberships`, but nothing writes them.

A Namespace for each person isolates well, but 100,000 personal Agents would
need 100,000 Kubernetes namespaces and their objects, and so several clusters.
OCE supports that topology but does not make it the default. In the shared
`default` Namespace, IAM isolates people at the resource level. The existing
NetworkPolicies already stop one Agent from reaching another Agent in the same
Kubernetes namespace ([security](../../docs/reference/security.md)).

<a id="scope"></a>

## Goals

- An administrator maps provider groups to OCC Groups once, instead of creating
  each account.
- A matched person gets an account at first sign-in, and their mapped
  memberships follow the provider at each sign-in.
- A Default users member completes the regular Agent workflow in `default`
  without administrator action. Other members cannot read or change their
  resources.
- An operator can let Default users create and own Namespaces.
- A mapped team shares Agents in a Namespace that an administrator created.
- Existing flows do not change.

## Non-goals

- Quotas and limits, including a count of Namespaces or Agents for each person.
  A separate RFC owns them. Until then the Kubernetes ResourceQuota is the only
  bound.
- Connection templates and personal or shared connections. The Agent OAuth
  connections work owns them.
- SCIM provisioning, which is the [follow-up](#revocation) for faster removal.
- Session lifetime changes, Roles that owners define, and owners sharing their
  resources.
- Mapping provider groups to the Installation administrator Role (#889).
- Namespace sandbox ceilings; the Guardrails work owns them.

<a id="design"></a>

## Proposal

### Owners and state

| Concern                            | Owner                                                                                     |
| ---------------------------------- | ----------------------------------------------------------------------------------------- |
| Roles, Groups, and Group bindings  | Installation configuration `iam`; OCC writes them as ordinary rows at startup             |
| Group bindings in a new Namespace  | OCC, when it creates a Namespace that a configured binding names                          |
| Default Group membership           | `POST /api/auth/accounts`, for each Group in `iam.defaultUserGroups`                      |
| Owner bindings                     | Each create operation, in its transaction, to `iam.ownerRole`                             |
| Mapping rules                      | New Installation IAM API and console Settings card; Installation `administer`; PostgreSQL |
| Account creation and membership    | Controller sign-in path, through the IAM Driver, in one transaction with its audit event  |
| Agent credential grants            | `deployAgent`, through the existing Agent operate Roles                                   |

### Configured Roles, Groups, and bindings

There are no built-in Roles or Groups and no Default users API. The `iam` block
of the Installation configuration declares ordinary ones:

```yaml
iam:
  roles:
    - id: agent_creator
      permissions: [agent:create, configuration:create, secret:create,
        credential_source:create, namespace:read, preset:read]
    - id: namespace_creator
      permissions: [namespace:create]
    - id: owner
      permissions: [...] # every action on every Namespace resource kind, plus namespace:delete
  defaultUserGroups: [default-user]
  ownerRole: owner
  roleBindings:
    - { group: default-user, role: agent_creator, scope: { namespace: default } }
    - { group: default-user, role: namespace_creator, scope: installation }
```

At startup OCC writes each Role, Group, and binding as an ordinary row in one
audited transaction, updates changed Roles, and deletes unlisted ones. A new
Namespace that a binding names gets it in its creating transaction. Configured
Roles hold no `installation` permission. Leaving out the `namespace_creator`
binding replaces a Namespace create switch.

Each account created through `POST /api/auth/accounts` joins every
`defaultUserGroups` Group. Mapping rules and SCIM later map provider groups to
these same Groups. A binding applies only the Role permissions whose kind
matches its target, so one Owner Role serves every kind.

### Creators own what they create

When a principal creates a Namespace, Agent, Configuration, Secret, credential
source, Preset, or ServiceAccount, OCC binds that principal to the configured
Owner Role in the same transaction and audits it with the reason `creator`. The
rule applies to every creator, including administrators and ServiceAccounts. No
Group binding grants Owner, so members of `default` do not own each other's
resources:

- A new Namespace gets a Namespace-wide Owner binding. The creator's own grant
  then creates the default Presets; today that step fails for a caller without
  `preset:create`.
- Any other resource gets an exact Owner binding, so its creator can read,
  change, delete, deploy, and use it. Lists already return only resources the
  caller can read, so members of `default` see only their own.
- An Agent's revisions and sandbox policy belong to the Agent. OCC passes the
  parent Agent with each `agent_revision` and `sandbox_policy` check, and IAM
  applies the Agent's bindings to them. Without this, an owner could not read
  the revisions that their deploys create.

Deleting a resource deletes its exact bindings, as today. An administrator
changes an owner by deleting the Owner binding and creating another.

### Bindings without a resource

In the Namespace IAM API, `resourceKind` and `resourceId` become optional, and
`subjectKind` accepts a Group that belongs to the Namespace. A binding without a
resource applies to every resource in the Namespace whose kind the Role names.
This works for any Role, so administrators can grant a custom Role across a
Namespace. The IAM API still writes only bindings inside one Namespace. OCC
writes the only bindings without a Namespace: the bootstrap administrator's and
the Namespace Creator binding, which hold only Installation-level permissions.

### Mapping rules

A mapping rule names one sign-in provider, one provider group, and one OCC
Group:

| Provider | Provider group                                                           |
| -------- | ------------------------------------------------------------------------ |
| GitHub   | An organization or `org/team`, read with the existing membership lookups |
| Google   | A Workspace hosted domain (`hd`), with a verified email                  |
| OIDC     | A configured claim (for example `groups`) that contains a given value    |

Google exposes groups only through its Admin API, so Google rules match a
hosted domain. Rules match exact, case-normalized values. A rule targets a
configured Group, such as `default-user`, or a Group that belongs to a
Namespace.

### Existing flows keep working

Mapping rules add account creation at sign-in and change nothing else. Without
rules and Default users members, an Installation behaves as today:

- Accounts that administrators create sign in without a rule and keep their
  bindings. Without an `iam` configuration they join no Group.
- The GitHub and Google allowlists (`OCC_AUTH_GITHUB_ALLOWED_ORGS`,
  `OCC_AUTH_GITHUB_ALLOWED_TEAMS`, `OCC_AUTH_GOOGLE_ALLOWED_DOMAINS`) stay and
  run first for every sign-in. Rules apply only to identities they admit.
- Password sign-in, service keys, and sessions are unchanged.
- Administrators also get Owner bindings on what they create; these stay if
  the administrator binding is removed.

### Membership at each sign-in

After the provider authenticates a person and its allowlist admits them, OCC
reads their provider groups and evaluates the provider's rules:

- **No account, a rule matches.** OCC creates the account, Principal, provider
  attachment, and matched memberships, audited with the matched rules and the
  reason `sign_in_mapping`.
- **No account, no match.** Sign-in fails and nothing is created.
- **Mapped account.** OCC replaces the mapped memberships with the matched set.
  With no match, sign-in fails and the mapped memberships are removed.
- **Account an administrator created.** Sign-in succeeds, and OCC updates its
  mapped memberships.

Each membership records its source (`administrator` or `sign_in_mapping`).
Sign-in changes only `sign_in_mapping` memberships. OCC records each person's
last mapped sign-in, and the Default users list shows it. Every change is
audited.

<a id="revocation"></a>

### Revocation keeps what people created

Removing a binding from the configuration, removing a person from a mapped
Group or the provider group, or disabling the account stops new creates. Everything they created stays: Owner bindings,
Namespaces, Agents, and grants remain until an administrator deletes them or
moves the Owner binding. A person who loses the Agent creation binding loses
`read` on `default` and cannot reach their Agents there, but those Agents keep
running.

OCC learns of a change as follows:

| Change                                                       | Takes effect                                          |
| ------------------------------------------------------------ | ----------------------------------------------------- |
| An administrator disables an account                         | The next request; policy and session lookups are live |
| An administrator changes the `iam` configuration             | The next API and worker startup                       |
| The provider removes a group or disables the person          | The next sign-in; sessions last at most eight hours   |

Session lifetime stays at eight hours. A person whom the provider disabled
cannot sign in again, so their last mapped sign-in in the Default users list
grows old. SCIM, through Better Auth's `@better-auth/scim` plugin, is the
follow-up for enterprise providers that push changes. It writes memberships with
the source `scim`, maps a deactivated user to a disabled account, and ends their
sessions.

```mermaid
sequenceDiagram
  participant User
  participant Auth as Controller sign-in
  participant OCC as OCC controller
  participant IAM as IAM Driver and State
  User->>Auth: Sign in (GitHub, Google, or OIDC)
  Auth->>Auth: Apply the allowlist, read provider groups, evaluate rules
  alt Allowlist refuses, or no rule matches a new or mapped account
    Auth-->>User: Sign-in refused
  else A rule matches
    Auth->>IAM: Create the account if needed, replace mapped memberships, audit
  end
  User->>OCC: Create a Secret and an Agent in the default Namespace
  OCC->>IAM: Check create (Agent Creator), write each resource and its Owner binding
  User->>OCC: POST /namespaces/{namespaceId}/agents/{agentId}/deploy
  OCC->>IAM: Check deploy, and operate on each source the Agent uses
  alt The caller cannot operate a source
    OCC-->>User: No grant written; refused as today
  else The caller can operate each source
    OCC->>IAM: Write the Agent's operate grants, audit
    OCC-->>User: 202, revision queued
  end
```

_Proposed flow; none of these steps is implemented._

### Agent credentials and Slack

An Agent's ServicePrincipal needs `operate` on each Secret and credential source
it uses. Today only an Installation administrator grants it, through the console
or guided provisioning (`ensureAgentOperateGrants` in
`packages/occ/src/index.ts`); this RFC adds no Agent Role.

OCC also writes these exact grants in the deploy transaction when the caller
can deploy the Agent and `operate` the source, through any Role. In `default`, a
member's grant reaches only Secrets they own. OCC
audits each write and writes nothing when the deploy fails. OCC removes a grant
it wrote when no Agent setting, Configuration, or live revision references the
source, so a running Agent keeps its access. Guided provisioning accepts these
grants instead of Installation `administer`.

Slack needs no new contract: Slack tokens are Secrets referenced from the
Agent's Configuration. The operator still provides the channel runtime and the
Slack egress proxy.

### Agent sandbox policies

Agent owners and Namespace members can change their Agents' network additions
within the Installation's `sandboxNetworkPolicyCeiling`, the only ceiling for
now. They can also turn on an Agent's `sandboxPolicyEditing` switch, which today
requires Installation `administer`. The switch, and this rule, last until the
Guardrails work replaces them. An empty ceiling allows no additions.

### Failure and recovery

- **Provider unavailable.** Sign-in fails and memberships do not change. A
  failed group lookup never counts as "no groups".
- **Deleted rule.** Its memberships are removed at each member's next sign-in.
- **Invalid `iam` configuration.** Startup fails and names the field. A removed
  Role that an Owner binding still uses also stops startup, so a configuration
  change never deletes what people own.
- **Deleted `default` Namespace.** Namespace names stay reserved after
  deletion, so Default users then create Agents only in Namespaces they own.
- **Partial writes.** Each transaction writes all of its rows or none, so a
  resource never exists without its Owner binding.

## Delivery and verification

Owner bindings, bindings without a resource for any Role, Group subjects, Group
membership writes, parent checks for revisions and sandbox policies, and account
creation at sign-in change the IAM Driver contract. The proposal does not depend
on #4045. [TASK-0050](../plans/0050-default-users.md) orders the work.

Required outcomes, proved with PostgreSQL integration tests and the regular
Kubernetes Agent workflow, with OIDC on the Keycloak lane and a real `groups`
claim:

- With no rules, administrator-created accounts sign in, allowlists refuse
  non-members, and an unknown identity is refused, as today.
- A Default users member creates a Secret and an Agent in `default` and deploys
  it with a Secret-based model credential and a Slack app, without administrator
  action. A second member is refused every read and write on those resources.
- With the `namespace_creator` binding configured, a member creates a Namespace
  and owns it; after a restart without it, the create is refused and the
  Namespace stays.
- A custom Role bound without a resource applies across its Namespace and not in
  another Namespace.
- A matched identity gets one account and its mapped memberships; an unmatched
  identity gets nothing; both are audited.
- Removal from the provider group removes the membership at the next sign-in and
  refuses sign-in without a match; an administrator membership survives. The
  removed person's Agents keep running.
- A failed group lookup refuses sign-in and changes no membership.
- A deploy by a caller who can operate the Agent's Secrets writes the Agent's
  grants, through any Role; a caller who cannot operate one writes none and is
  refused as today.
- Replacing a Secret removes the old grant only after no live revision
  references it.
- An owner adds a sandbox network rule inside the Installation ceiling and is
  refused outside it.

<a id="alternatives-and-open-decisions"></a>

## Rationale and alternatives

- **A Namespace for each person by default.** Strong isolation, but 100,000
  people need 100,000 Kubernetes namespaces. It stays available through a
  `namespace_creator` binding.
- **Owner bindings only for Namespaces.** A one-off rule; the general rule gives
  every creator the same result.
- **Namespace-wide bindings only for configured Roles.** Safe, but administrators
  could not grant custom Roles across a Namespace.
- **Built-in immutable Roles and Group with a Default users API.** The first
  draft. Review preferred ordinary Groups and Roles from the configuration:
  fewer special cases, and the same Groups map to external groups for SCIM.
- **Grant at deploy only when a built-in Role allows the caller.** Custom Roles
  would gain nothing, but it needs built-in Roles, and a caller who can operate
  a source can already bind it to an Agent.
- **SCIM in the first release.** It covers only providers that push, needs its
  own tables and tokens, and still needs the same Group mapping. Sign-in sync
  comes first; SCIM follows.
- **Build on the proposed Agent Author Role (#4045).** It is not accepted, it
  omits `agent:administer`, and an administrator assigns it per person.

## Unresolved questions

- **OIDC group claims.** Some providers omit large group lists from the ID token.
  Is the ID token or UserInfo claim enough for the first release?
- **Administrator access to owned resources.** Should administrators keep deploy
  and native-admin access to members' Agents? Secret values stay undisclosed
  either way.

## References

- [Authorization](../../docs/reference/authorization.md), including
  [access bindings and Groups](../../docs/reference/authorization.md#access-bindings-and-groups),
  and the [permissions cheat sheet](../../docs/reference/cheatsheets/permissions.md)
- [Account provisioning](../../docs/reference/authentication.md#account-provisioning)
- [External sign-in allowlists](../../docs/reference/authentication/external-sign-in.md#organization-and-team-allowlist)
- [Namespace IAM policy flow](../../docs/flows/namespace-iam-policy.md)
- [Agent provisioning flow](../../docs/flows/agent-provisioning.md)
- [Security](../../docs/reference/security.md)
- [Slack integration](../../docs/guides/integrations/slack.md)
