---
rfc: ../rfcs/0040-default-users.md
---

# Implementation plan: Default users

- **ID:** RFC-0040 (provisional; renumber before merge)
- **Delivery status:** In progress
- **Owner:** IAM, OCC, and controller maintainers
- **Authority:** [RFC-0040](../rfcs/0040-default-users.md)

## Outcome and ordered work

Deliver the [RFC-0040](../rfcs/0040-default-users.md) design in slices. Each
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

Other work changed the remaining slices by 2026-11-16, after slice 1 merged:

- [#5136](https://github.com/openclaw/openclaw-enterprise/pull/5136)
  ([RFC-0031](../rfcs/0031-oidc-agent-chat.md)) lets an Agent's owner turn on
  browser access through create and deploy. Exact-Agent `operate` opens chat
  only, and `administer` opens the full native admin UI. The Namespace Agent
  capabilities report `nativeAdmin` to members, which
  [#5695](https://github.com/openclaw/openclaw-enterprise/pull/5695) tests.
  This plan no longer delivers native admin setup.
- [OIDC enrollment](../rfcs/0032-oidc-account-enrollment.md) creates accounts
  at OIDC sign-in and adds fixed `groupIds`, or `defaultUserGroups`, at each
  admitted login. [RFC-0037](../rfcs/0037-oidc-enrollment-claims.md) reads the
  groups claim from the signed ID token. OIDC mapping rules and sign-in sync
  build on it.

1. **Default users and Owner bindings.** Merged in
   [#4231](https://github.com/openclaw/openclaw-enterprise/pull/4231) on
   2026-11-06 (`5b8901213`).
   - Installation configuration `iam`: `roles`, `defaultUserGroups`,
     `ownerRole`, and `roleBindings`. OCC writes them at startup as
     `role_config_`, `group_config_`, and `binding_config_` rows, updates changed
     Roles, deletes unlisted ones, and refuses to delete a Role that an Owner
     binding uses. A Namespace that a binding names gets it when OCC creates it.
   - Migration `0067_default_users` lets an Installation Group be bound inside a
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
   - Console Agent creation for members, added after a live OpenShell
     walkthrough on 2026-11-05: `GET /namespaces/:namespaceId/agent-capabilities`
     answers a caller with `agent:create` there with the Installation
     capabilities Agent creation uses, without `agentProvisioning` and
     `nativeAdmin`. A member's Create Agent reads it after the refused
     Installation read, registers the model Secret with a Credential Gateway, and
     opens the draft instead of asking an administrator for the grant.
2. **Guided provisioning for members.** Moved here from slice 3. Provisioning
   admission, its stored-record checks, and its status read require Agent and
   Configuration `create` in the Namespace instead of Installation
   `administer`. The worker still writes the Agent's grants only on sources the
   requester can `operate`, and audits them. Turning off `gatewayManagedMode`
   stays administrator-only. The Namespace Agent capabilities report
   `agentProvisioning` to members, and a member's console offers guided
   provisioning. In review in
   [#6364](https://github.com/openclaw/openclaw-enterprise/pull/6364), which
   also gives the worker the `iam` configuration so provisioning writes Owner
   bindings, and holds the requester's account before the worker writes.
3. **Member grant guidance.** The console Credentials tab stops telling a
   member to ask an administrator for a grant that the member's deploy writes.
   In review in
   [#6388](https://github.com/openclaw/openclaw-enterprise/pull/6388), which
   also changes the administrator path: grant warnings say that deploying
   grants the Agent access, and no grant outcome or grant read holds Deploy.
4. **Bindings without a resource.** Optional `resourceKind` and `resourceId`
   and Group subjects in the Namespace IAM API for any Role.
5. **Agent grant removal.** Deploy grants move to the binding ID
   `binding_deploy_<agent>_<source>_operate`, so OCC can tell them from an
   administrator's grant. `releaseDeployedAgentGrants` removes them when no
   Agent setting, Configuration, or live revision references the source. OCC
   runs it after Agent and Configuration updates, and the worker runs it after
   an activation and after a stop. Sandbox policy editing accepts the Agent's
   Owner binding. Rebases `feat/default-users-grant-removal`.
6. **Mapping rules.** Rule storage, the Installation API, the console Settings
   card, the membership `source` column, and the last mapped sign-in. Rules
   target the configured Groups. OIDC rules use the enrollment claim rules.
7. **Sign-in sync.** Account creation at Google sign-in, and replacement of
   mapped memberships at Google and OIDC sign-in, refusing on a failed group
   lookup. GitHub teams arrive through an OIDC broker since direct GitHub
   sign-in was retired in
   [#5144](https://github.com/openclaw/openclaw-enterprise/pull/5144).
8. **Team Namespaces and console.** Namespace-wide bindings of a configured
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
- Slice 2: in `tests/integration/postgres-agent-provisioning-member.test.ts`, a
  member provisions an Agent in a configured Namespace through the real worker,
  owns the Agent and Configuration, and the worker grants and audits the Agent's
  access to the member's own Secrets. A second member cannot read the request, a
  member who turns off `gatewayManagedMode` is refused, and the worker refuses
  queued work after the member's account is disabled.
- Slice 3: `tests/browser/console-agent-detail.test.ts` and
  `tests/browser/console-agent-channels.test.ts` show that a member's Slack and
  authentication source saves name no administrator step, send no grant, and
  say that the deploy grants access. The administrator's missing, refused and
  unconfirmed grant cases leave Deploy available. Matching Storybook states
  show both.
- Slice 4: a custom Role bound without a resource applies across its Namespace
  and not in another one.
- Slice 1 also: an owner's deploy writes and audits the Secret grant; a custom
  Role deploy writes a grant only once the caller can operate the Secret. A
  session revoked, a configuration change, or a delete of the Agent's Owner
  binding while a create or deploy waits leaves no Owner binding or grant.
- Slice 5: the real worker activates a second revision. The first deploy grant
  goes only after the first revision retires, and an administrator grant on the
  same Secret stays.
- Later slices extend the same file or add one per slice at the workflow
  boundary. Sign-in sync uses the Keycloak lane with a real `groups` claim.
- The regular Kubernetes Agent workflow proof runs once slices 1, 2, 4, and 5
  are complete.
