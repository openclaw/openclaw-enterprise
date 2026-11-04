---
rfc: ../rfcs/0026-default-users.md
---

# Implementation plan: Default users

- **ID:** TASK-0050 (provisional; renumber before merge)
- **Delivery status:** In progress
- **Owner:** IAM, OCC, and controller maintainers
- **Authority:** [RFC-0026](../rfcs/0026-default-users.md)

## Outcome and ordered work

Deliver the [RFC-0026](../rfcs/0026-default-users.md) design in slices. Each
slice has a caller in the regular Agent workflow and PostgreSQL integration
proof through the real Fastify app. The RFC owns contracts and failure
semantics; this plan owns order and proof.

The RFC changed on 2026-11-02: Default users create Agents in the shared
`default` Namespace, Namespace create is an opt-in setting, every creator gets
an Owner binding, bindings without a resource work for any Role, and the
Namespace limit moved to a separate quota RFC. The first branches,
`feat/default-users-agent-grants` (draft PR
[#4231](https://github.com/openclaw/openclaw-enterprise/pull/4231)) and
`feat/default-users-grant-removal`, implement the earlier design and are
reworked into slices 1 to 3.

The RFC changed again on 2026-11-04 after review of #4231: ordinary Roles,
Groups, and Group bindings from the Installation `iam` configuration replace the
built-in Roles, the Default users Group, `/iam/default-users`, and
`defaultUser.namespaceCreate`. Accounts join `iam.defaultUserGroups` when they
are created, and deploy writes grants for any Role.

1. **Default users and Owner bindings.** Reworked on
   `feat/default-users-agent-grants` (PR #4231); review pending.
   - Installation configuration `iam`: `roles`, `defaultUserGroups`,
     `ownerRole`, and `roleBindings`. OCC writes them at startup as
     `role_config_`, `group_config_`, and `binding_config_` rows, updates changed
     Roles, deletes unlisted ones, and refuses to delete a Role that an Owner
     binding uses. A Namespace that a binding names gets it when OCC creates it.
   - Migration `0066_default_users` lets an Installation Group be bound inside a
     Namespace, keeps configured Roles at Installation scope without
     `installation` permissions, and lets OCC update configured Roles and delete
     configured Groups and their memberships.
   - `POST /api/auth/accounts` adds each new account to the configured default
     Groups in its transaction.
   - Every create writes the creator's binding to `iam.ownerRole` in its
     transaction: Namespace-wide for a Namespace, exact for other resources.
   - Parent checks, moved here from slice 2: OCC passes the parent Agent with
     `agent_revision` and `sandbox_policy` checks, and IAM applies the Agent's
     exact bindings to them, so an owner can follow its own deploys.
   - Deploy-time grants, moved here from slice 3 because a Default user's deploy
     needs them: deploy writes the Agent's exact `operate` grant on each source
     the caller can operate, through `ensureAgentOperateGrants` and its
     `binding_<agent>_<source>_operate` ID.
   - Authority fence: each create and deploy holds the caller's session through
     COMMIT and takes the IAM configuration lock shared, which applying the
     configuration takes exclusively. Creates in a Namespace and deploy
     authorize again under the Namespace lock, which AccessBinding deletes take.
   - Removed from the first branch: the Namespace limit, its lock, its `409`,
     and `namespaces.created_by`, which the Owner binding replaces.
2. **Bindings without a resource.** Optional `resourceKind` and `resourceId`
   and Group subjects in the Namespace IAM API for any Role.
3. **Agent grant removal.** Deploy grants move to the binding ID
   `binding_deploy_<agent>_<source>_operate`, so OCC can tell them from an
   administrator's grant. `releaseDeployedAgentGrants` removes them when no
   Agent setting, Configuration, or live revision references the source. OCC
   runs it after Agent and Configuration updates, and the worker runs it after
   an activation and after a stop. Sandbox policy editing and guided
   provisioning accept the Agent's Owner binding. Rebases
   `feat/default-users-grant-removal`.
4. **Mapping rules.** Rule storage, the Installation API, the console Settings
   card, the membership `source` column, and the last mapped sign-in. Rules
   target the configured Groups.
5. **Sign-in sync.** Account creation and membership replacement at sign-in for
   GitHub, Google, and OIDC, refusing on a failed group lookup.
6. **Team Namespaces and console.** Namespace-wide bindings of a configured
   member Role for mapped Groups, Create Namespace in the console, and an
   empty-state landing.

SCIM through `@better-auth/scim` is a later plan.

## Verification

- Slice 1: `tests/integration/postgres-default-users.test.ts` in the
  `postgres-platform` lane. Applying the configuration writes the configured
  rows, and new accounts join the default Group. A member creates a Secret and an
  Agent in `default`; a second member is refused every read and write on them.
  With the `namespace_creator` binding, a member creates and owns a Namespace; a
  restart without it refuses the create and keeps the Namespace, and a restart
  that drops the Owner Role while Owner bindings use it fails. The owner reads
  the revision and deployment status of its deploy and its Agent's sandbox
  policy; another member is refused. On k3d, a Default user deploys in `default`
  and gets a real model turn.
- Slice 2: a custom Role bound without a resource applies across its Namespace
  and not in another one.
- Slice 1 also: an owner's deploy writes and audits the Secret grant; a custom
  Role deploy writes a grant only once the caller can operate the Secret. A
  session revoked, a configuration change, or a delete of the Agent's Owner
  binding while a create or deploy waits leaves no Owner binding or grant.
- Slice 3: the real worker activates a second revision. The first deploy grant
  goes only after the first revision retires, and an administrator grant on the
  same Secret stays.
- Later slices extend the same file or add one per slice at the workflow
  boundary. Sign-in sync uses the Keycloak lane with a real `groups` claim.
- The regular Kubernetes Agent workflow proof runs once slices 1 to 3 are
  complete.
