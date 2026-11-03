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

1. **Default users and Owner bindings.** Reworked on
   `feat/default-users-agent-grants` (draft PR #4231); review pending.
   - Migration `0066_default_users` creates the immutable Agent Creator,
     Namespace Creator, Owner, and Namespace member Roles, the Default users
     Group, the binding-shape constraint, and deletable Group memberships. It
     lets an Installation Group be bound inside a Namespace.
   - OCC binds Default users to Agent Creator in the Namespace named `default`
     when it creates that Namespace; the migration binds an existing one.
   - Installation configuration `defaultUser.namespaceCreate` writes or deletes
     the Namespace Creator binding at startup.
   - Every create writes the creator's Owner binding in its transaction:
     Namespace-wide for a Namespace, exact for other resources.
   - Parent checks, moved here from slice 2: OCC passes the parent Agent with
     `agent_revision` and `sandbox_policy` checks, and IAM applies the Agent's
     exact bindings to them, so an owner can follow its own deploys.
   - `GET`, `PUT`, and `DELETE /iam/default-users/{principalId}` for Installation
     administrators, audited.
   - Deploy-time grants, moved here from slice 3 because a Default user's deploy
     needs them: deploy writes the Agent's exact `operate` grants when the Owner
     or Namespace member Role allows the caller, through
     `ensureAgentOperateGrants` and its `binding_<agent>_<source>_operate` ID.
   - Authority fence: each create and deploy holds the caller's session through
     COMMIT and takes the caller's authority lock, which removal from Default
     users takes exclusively. Creates in a Namespace and deploy authorize again
     under the Namespace lock, which AccessBinding deletes take, and deploy grants
     use that decision.
   - Namespace deletion removes the immutable Agent Creator binding of `default`
     with the rest of its policy.
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
   provisioning accept the built-in Roles. Rebases
   `feat/default-users-grant-removal`.
4. **Mapping rules.** Rule storage, the Installation API, the console Settings
   card, the membership `source` column, and the last mapped sign-in.
5. **Sign-in sync.** Account creation and membership replacement at sign-in for
   GitHub, Google, and OIDC, refusing on a failed group lookup.
6. **Team Namespaces and console.** Namespace member bindings for mapped Groups,
   Create Namespace in the console, and an empty-state landing.

SCIM through `@better-auth/scim` is a later plan.

## Verification

- Slice 1: `tests/integration/postgres-default-users.test.ts` in the
  `postgres-platform` lane. A Default users member creates a Secret and an Agent
  in `default`; a second member is refused every read and write on them. With
  `defaultUser.namespaceCreate` on, a member creates and owns a Namespace; with
  it off, the create is refused. Removal from Default users stops new creates
  and keeps owned resources. The owner reads the revision and deployment status
  of its deploy and its Agent's sandbox policy; another member is refused. On
  k3d, a Default user deploys in `default` and gets a real model turn.
- Slice 2: a custom Role bound without a resource applies across its Namespace
  and not in another one.
- Slice 1 also: an owner's deploy writes and audits the Secret grant; a deploy
  allowed only by a custom Role writes none. A session revoked, a removal from
  Default users, or a delete of the Agent's Owner binding while a create or
  deploy waits leaves no Owner binding or grant. The `default` Namespace can be
  deleted.
- Slice 3: the real worker activates a second revision. The first deploy grant
  goes only after the first revision retires, and an administrator grant on the
  same Secret stays.
- Later slices extend the same file or add one per slice at the workflow
  boundary. Sign-in sync uses the Keycloak lane with a real `groups` claim.
- The regular Kubernetes Agent workflow proof runs once slices 1 to 3 are
  complete.
