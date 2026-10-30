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

1. **Default users and owned Namespaces.** In progress, branch
   `feat/default-users-agent-grants`.
   - Migration `0065_default_users` creates the immutable built-in Roles, the
     Default users Group and its binding, the binding-shape constraint, one
     owner binding per Namespace, deletable Group memberships, and
     `namespaces.created_by`.
   - New optional IAM Driver members: `listGroupMembers`, `addGroupMember`,
     `removeGroupMember`, and `createNamespaceOwnerBinding`, with matching
     policy repository methods.
   - `GET`, `PUT`, and `DELETE /iam/default-users/{principalId}` for Installation
     administrators, audited.
   - `createNamespace` applies the limit (`defaultUser.namespaceLimit`, 1 when
     absent) under a per-creator lock, records `createdBy`, and binds the owner
     before the default Presets.
   - Deploy writes the Agent's exact `operate` grants only when a built-in
     Namespace Role allows the caller, audited with reason `agent_deploy`.
2. **Grant removal.** Remove a grant that deploy wrote when no Configuration and
   no pending or running revision references the source. Mark deploy-written
   bindings so removal never touches administrator or provisioning grants.
3. **Mapping rules.** Rule storage, the Installation API, and the console
   Settings card. Add the membership `source` column here.
4. **Sign-in sync.** Account creation and membership replacement at sign-in for
   GitHub, Google, and OIDC, refusing on a failed group lookup.
5. **Team Namespaces and member tools.** Namespace member bindings for mapped
   Groups, sandbox policy editing within the Installation ceiling, guided
   provisioning without Installation `administer`, Create Namespace in the
   console, and an empty-state landing.
6. **Connection templates.** Personal or shared templates, replacing the #3068
   per-Agent ownership checks.

## Verification

- Slice 1: `tests/integration/postgres-default-users.test.ts` in the
  `postgres-platform` lane. It covers the refusal before membership,
  administrator-only membership routes, concurrent creation at the limit,
  `createdBy` and the owner binding, an owner's deploy that writes and audits
  the Secret grant, a second user's refused reads, a custom-Role deploy that
  writes no grant and is refused, and removal that stops new Namespaces but
  keeps owned ones.
- Later slices extend the same file or add one per slice at the workflow
  boundary. Sign-in sync uses the Keycloak lane with a real `groups` claim.
- The regular Kubernetes Agent workflow proof runs once slices 1 and 2 are
  complete.
