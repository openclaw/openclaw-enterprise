---
rfc: ../rfcs/0044-scim-provisioning.md
---

# Implementation plan: Deliver SCIM users and groups

- **Delivery status:** Planned. Release gates remain open.
- **Owner:** caseysilver-oai.
- **Authority:** [RFC-0044 acceptance criteria](../rfcs/0044-scim-provisioning.md#acceptance-criteria).
- **Source baseline:** OCE architecture and enrollment at `5fe51f64`.

## Outcome and scope

A directory operator can provision and withdraw human Users from one Installation in v0, then synchronize Groups and direct User memberships in v1. A recovery administrator retains access. Native IAM administrators retain control of grants. Roles, bindings, group-based authorization and existing-account adoption stay outside this delivery.

## Contract and source touchpoints

Controller authentication owns SCIM wire behavior, signed OIDC claims, provider configuration and authorized token management endpoints. The Console owns the administrator setup, token creation, rotation and revocation experience. PostgreSQL State owns account, method, Principal, session, source-owned Group, membership, recovery designation and audit consistency. Deployment configuration owns startup prerequisites; the Console exposes the separate Group setting, disabled by default. Withdrawal uses the existing State transaction and serializes with changes to the target's recovery designation; unrelated user withdrawal does not require the IAM policy read fence. Group data must not enter the IAM evaluator. Submit a separate RFC first if implementation requires a Driver contract change.

## Milestone v0: Users

- [ ] **Storage.** Review source uniqueness, digest privileges, immutable live anchor and method, metadata uniqueness and permanent non-reuse of SCIM IDs. Release deleted usernames and eligible subjects for new provisioning without reusing old account or principal identities. Migrate a populated database and restore a backup across the migration boundary. Verify the restricted application role cannot replace a live anchor or manage token hashes directly.
- [ ] **SCIM setup and token management.** Add Console settings and controller endpoints restricted to authorized installation administrators. Display generated tokens only once for copying to the IdP, persist only their hashes and versions, and omit expiration in v0. Rotation immediately invalidates the old token; document the interruption until the IdP switches. Test unauthorized access, session and request protections, stale versions, uncertain outcomes, absence of plaintext from later reads and logs, and rejection on every route after rotation or revocation. Record Console browser test results and the required UI review evidence.
- [ ] **Users API.** Wire source-scoped CRUD, list and discovery. Bound filters, payloads and PATCH operations. Document optional attributes, read-only ID, mutable externalId, inactive PUT semantics, uniqueness, SCIM media types and error statuses.
- [ ] **Human authentication.** Match the signed configured anchor at enrollment and session admission. Fence pre-cutover sessions, alternate methods and unprovisioned subjects. Verify recovery access before and after enabling every replica.
- [ ] **Offboarding.** Implement `active:false` and `active:true` updates separately from DELETE. Serialize withdrawal with recovery designation changes and reject only a target currently designated for recovery. Do not gate ordinary user withdrawal on recovery availability or an unrelated policy writer. Withdraw sessions and append audit before commit; DELETE removes the resource and membership edges, and a new POST creates a fresh identity. Reconcile uncertain writes before replay.
- [ ] **Evidence and rollout.** Agree on redacted, bounded denial telemetry before enabling it. Update the authentication reference, operator guide, source-backed flow and API discovery together. Document separate cleanup of independent resources and the risks of re-enabling enrollment during rollback.

## Milestone v1: Groups and direct memberships

- [ ] **Storage and isolation.** Add source-scoped Group records, externalId uniqueness and direct User membership edges with referential integrity. Serialize User deletion and membership writes, keep deactivated membership inert, remove edges on deletion, and commit mutation audit atomically.
- [ ] **Capability and discovery.** Require an authorized administrator to enable Groups explicitly in the Console after migration; default to disabled even on upgrade. Expose Group schema, ResourceType and routes consistently across replicas only when enabled. Verify token revocation covers every Group route.
- [ ] **Groups API.** Implement bounded Group CRUD, filtering and pagination; atomic member add/remove/replace and filtered PATCH; read-only derived User groups; duplicate handling and validation of IDs, types and references. Reject foreign-source, nested, manual/recovery and unknown members.
- [ ] **Authorization boundary.** Verify that Group lifecycle, membership and labels do not create IAM Principals, grants, Roles or bindings, affect native access decisions, or alter sessions and User activation.
- [ ] **Interoperability and rollout.** Set connector-informed limits, run a real IdP Group sync and reconciliation cycle, test failure/retry and concurrent deletion, and document capability disablement, retained data and re-enablement.

## Verification

| Criteria   | Required check and prerequisites                                                                                                                                                                             | Release gate                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| AC-1       | Use administrator and unauthorized Console sessions with PostgreSQL. Exercise creation, one-time display, no expiration, immediate rotation, revocation, stale versions, uncertain outcomes and later reads. | Old tokens fail immediately, the replacement works after IdP update, and audit remains consistent.     |
| AC-2       | Call the live Fastify API with a synthetic source. Exercise User CRUD, atomic PATCH rollback, filtered pagination, password omission, source isolation and Group 404s.                                       | Exact results with zero unexpected skips.                                                              |
| AC-3       | Use PostgreSQL and signed test tokens with different sub and oid. Try metadata relinking, recovery adoption, never-provisioned sign-in, and provisioning again after DELETE.                                 | No takeover, inherited grant, reused identity or session resurrection.                                 |
| AC-4       | Exercise disable, reactivate, DELETE, 404 readback and fresh creation. Withdraw distinct users concurrently and inject audit failure and uncertain commits.                                                  | No partial mutation; reactivation preserves identity, and creation after deletion uses a new identity. |
| AC-2, AC-4 | Provision 1,000 synthetic users. Race duplicate creation, enumerate IDs, and update, deactivate, reactivate and delete at bounded concurrency.                                                               | Record first-attempt counts and p50/p95 separately from retries; account for every user.               |
| AC-5       | Test designation transfer racing withdrawal, rejection of the designated target, and unrelated offboarding with unavailable recovery. Exercise migration, restore, cutover and rollback across replicas.     | Recovery protection affects only its target; ordinary withdrawal succeeds and revoked sessions fail.   |
| AC-6       | Run a real IdP User provisioning cycle in a dedicated tenant through verified HTTPS. Test claim mapping, retries, rotation and departure during a session.                                                   | Provider and OpenClaw receipts establish the outcome.                                                  |
| AC-7       | Enable groups in the Console after migration. Test discovery, disabled routes, replica consistency and revoked tokens.                                                                                       | Only explicit enablement exposes groups, consistently across replicas.                                 |
| AC-8, AC-9 | Test Group CRUD, filters, membership PATCH/PUT, duplicate delivery, foreign references, audit failure and user deletion races against PostgreSQL; compare actual IAM and session state.                      | No dangling or foreign edge, implicit authorization, partial mutation or audit gap.                    |
| AC-10      | Sync synthetic groups and users from a real IdP; reconcile removals, retry, disable and re-enable, and exercise agreed membership limits over verified HTTPS.                                                | Provider and persisted results establish synchronization and recovery.                                 |

Every criterion remains open until its corresponding evidence is recorded.

Register the deterministic database scenarios in the PostgreSQL authentication lane. Register the staging workflow in the QA matrix with explicit inputs and a disposable Installation. A local protocol check cannot close the external IdP or ingress gate.

## Open decisions

The [RFC's unresolved questions](../rfcs/0044-scim-provisioning.md#unresolved-questions) identify the proposed primary decision owner for each open item. Existing identity migration and any use of groups for authorization require separate design and authorization.

## Delivery record

Delivery evidence remains open for both milestones. This plan records neither approval nor release qualification.

## Manual Notes

## Changelog

- 2026-11-17: Prepared the unnumbered working plan for review.
- 2026-11-18: Expanded the RFC and primary plan to include a separate Groups and direct-membership milestone; deferred Role and binding integration.
- 2026-11-18: Replaced credential file delivery with administrator setup and token management in the Console.
- 2026-11-18: Narrowed recovery protection, separated activation updates from deletion, allowed fresh provisioning after deletion, and specified tokens without expiration and immediate rotation.
