---
rfc: ../rfcs/20261117-scim-provisioning.md
---

# Implementation plan: Deliver SCIM users and groups

- **Delivery status:** Planned. Release gates remain open.
- **Owner:** caseysilver-oai.
- **Authority:** [RFC-20261117-scim-provisioning acceptance criteria](../rfcs/20261117-scim-provisioning.md#acceptance-criteria).
- **Source baseline:** OCE architecture and enrollment at `5fe51f64`.

## Outcome and scope

In v0, one directory per installation can provision new users, take over provisioning for eligible existing accounts, and withdraw sign-in and sessions. In v1, directory membership determines who inherits a synced OpenClaw group’s existing permissions. SCIM does not create or change roles or role bindings. The designated recovery administrator stays outside SCIM.

## Contract and source touchpoints

The controller authenticates SCIM requests and verifies signed OIDC claims at sign-in. The Console manages provisioning tokens and the separate group setting. The SCIM and administrator APIs enforce account and recovery rules in PostgreSQL `State`, in the transaction that changes accounts, sign-in methods, sessions, or memberships and records the audit event. Native IAM evaluates existing bindings. Submit a separate RFC before changing a `Driver` contract.

## Milestone v0: Users

- [ ] **Storage.** Scope resources to the installation and directory. Keep the initial provider and stable user ID separate from mutable `externalId` metadata. Never reuse deleted SCIM IDs. Preserve the account, Principal, and ownership information needed for reprovisioning. Test migration and backup restoration on a populated database. Verify that the restricted application role cannot replace a live sign-in identity or manage token hashes directly.
- [ ] **SCIM setup and token management.** Add Console settings and controller endpoints restricted to authorized installation administrators. Display generated tokens only once for copying to the IdP, persist only their hashes and versions, and omit expiration in v0. Rotation immediately invalidates the old token; document the interruption until the IdP switches. Test unauthorized access, session and request protections, stale versions, uncertain outcomes, absence of plaintext from later reads and logs, and rejection on every route after rotation or revocation. Record Console browser test results and the required UI review evidence.
- [ ] **Users API.** Implement discovery, filtering, pagination, and atomic updates. Apply the [profile rules](../rfcs/20261117-scim-provisioning.md#user-accounts-v0) to creates and updates. Enforce case-insensitive username uniqueness, email selection and uniqueness, and display name fallbacks. Discard passwords. Preserve activation when `PUT` omits `active`.
- [ ] **Human authentication.** Match an existing account only by the configured OIDC provider and stable user ID. Preserve its permissions, including for administrators. Reject ambiguous, email-only, username-only, and recovery account matches. Block alternate sign-in methods, stale sessions, and sign-in by unprovisioned users. Disable sign-in enrollment and membership rules for this provider until an administrator explicitly re-enables them after SCIM is disabled. Apply OpenClaw-managed default groups to new accounts; the IdP alone sets membership in synced groups.
- [ ] **Offboarding.** Deactivation invalidates sessions but preserves memberships. Reactivation requires a new sign-in. `DELETE` also removes the SCIM record, sign-in methods, and memberships. Keep the Principal, owned resources, Owner bindings, and running agents. On reprovisioning with the same provider and stable user ID, return a new SCIM ID for the original account. Use current group memberships and require fresh approval for all other direct roles.
- [ ] **Recovery.** Check the designated account and SCIM enablement in the same transaction as a transfer or withdrawal. Reject administrator transfers only while SCIM is enabled. Never allow the IdP to manage the recovery account or reassign the designation. Recovery availability must not block offboarding other users.
- [ ] **Evidence and rollout.** Agree on redacted, bounded denial telemetry before enabling it. Update the authentication reference, operator guide, source-backed flow and API discovery together. Document separate cleanup of independent resources and the risks of re-enabling enrollment during rollback.

## Milestone v1: Groups and direct memberships

- [ ] **Storage and isolation.** Keep one stable SCIM group ID for the linked OpenClaw group across renames. Enforce `externalId` uniqueness per source and resource type. Serialize user deletion with membership changes and commit audit records atomically.
- [ ] **Capability and discovery.** Require an authorized administrator to enable Groups explicitly in the Console after migration; default to disabled even on upgrade. Expose Group schema, ResourceType and routes consistently across replicas only when enabled. Verify token revocation covers every Group route.
- [ ] **Group matching.** On first sync, trim leading and trailing whitespace and compare names without regard to case within the installation. Use the single match, create a group if none match, or return `409 Conflict` without changes if several match. Use the returned SCIM ID for subsequent changes. No manual mapping is required or available.
- [ ] **Groups API.** Implement discovery, filtering, pagination, read-only membership lists on users, and atomic membership changes. A replacement removes omitted members, including local additions; incremental changes affect only the listed members. Validate additions and replacements against the same installation and directory. Ignore nested groups. A filtered removal of an absent member succeeds, including after user deletion.
- [ ] **Authorization boundary.** Verify that synced members inherit permissions from existing OpenClaw role bindings. An empty replacement removes all members. An IdP group deletion ends synchronization but preserves the OpenClaw group, members, bindings, and access. Neither operation changes account activation or sessions.
- [ ] **Interoperability and rollout.** Set connector-informed limits, run a real IdP Group sync and reconciliation cycle, test failure/retry and concurrent deletion, and document capability disablement, retained data and re-enablement.

## Verification

### Acceptance criteria

- **AC-1 — Administrator setup (G5):** An administrator can generate, rotate and revoke a token in the Console. The token appears only at issuance and has no expiration; later reads do not expose it, unauthorized users cannot manage it, and rotation or revocation immediately invalidates the old token. Verify through Console browser tests, controller integration tests, database and audit checks, including stale versions, uncertain outcomes and provisioning interruption until the IdP uses the replacement.
- **AC-2 — Users API (G1, G5):** Given an enabled v0 installation and a valid directory token, the IdP can create, list, update and delete users through the real API. Discovery exposes users and groups in v1. Pagination and retries behave as documented, passwords are omitted, and source boundaries are enforced. Test `POST`, `PUT`, and `PATCH` against the API backed by PostgreSQL. Verify email selection and normalization, display name fallbacks, and case-insensitive username uniqueness. Invalid or ambiguous profiles return `400 Bad Request`; duplicate usernames or emails return `409 Conflict`. A rejected request creates no account and leaves existing accounts unchanged. Simulate a successful `POST /Users` whose response never reaches the IdP. Verify that looking up the user by `userName` returns the original SCIM ID and that retrying the same request returns `409 Conflict` without creating a duplicate or changing the account. Verify that a unique match on the OIDC provider and stable user ID preserves the existing account, resources, and permissions, including for administrators. Verify that ambiguous matches, matches based only on email or username, and matches to the designated recovery administrator return `409 Conflict` without changing any account.
- **AC-3 Identity and authorization (G1):** Given a provisioned user and signed OIDC tokens, the original subject can sign-in after a metadata rename; a replacement subject or unlinked user cannot take over the identity. Verify that neither a profile update nor an OpenClaw administrator can reassign a SCIM-managed account to a different person. Verify that reprovisioning a deleted user issues a new SCIM ID and restores the original account and Principal only when the OIDC provider and stable user ID match. Old sessions remain invalid. After signing in again, the user regains access through current group memberships and to resources they still own. All other direct roles, including administrator roles, require fresh approval from an OpenClaw administrator. Verify with actual session admission, principal and policy reads. Verify that OpenClaw automatically adds a newly provisioned user to the default groups it manages. When group sync is enabled, verify that the user joins a SCIM-managed group only if the IdP explicitly lists them as a member.
- **AC-4 — Invalidating Sessions (G2):** Given active sessions, setting `active:false` disables the user and invalidates sessions; setting `active:true` restores the same account but not its sessions. DELETE returns 204, removes the resource from discovery and makes its old ID return 404. Account changes and audit commit together, including under concurrent user deactivations or audit failure. Verify with database integration tests, fault injection and readback after uncertain writes. Verify that OpenClaw rejects administrator requests to disable or reactivate a SCIM-managed account, even during a concurrent IdP update. Verify that an administrator can revoke sessions without changing the account’s status and that the user can sign in again only if the IdP still marks the account active.
- **AC-5 — Recovery and rollout (G4):** Verify that OpenClaw rejects attempts to disable or delete the designated recovery account. Verify that an authorized administrator’s request to transfer the recovery designation to an eligible account fails when SCIM is enabled and succeeds when SCIM is disabled. The IdP can never transfer the designation or manage the designated recovery account. These protections must hold even when requests arrive concurrently. After migration, a provider change, rollback, or backup restoration, verify that the same recovery administrator can sign in locally without the IdP. Revoked sessions must remain invalid across all database replicas.
- **AC-6 — User interoperability (G1, G2, G4, G5):** Given a dedicated test IdP, verified HTTPS and an enabled staging installation, the directory completes onboarding, updates, token rotation and offboarding during an active session. Verify with provider receipts and OpenClaw account, session and audit results; the criterion remains open without those prerequisites.
- **AC-7 — Group capability (G3, G5):** Given a v1 installation, an authorized administrator can explicitly enable group provisioning. Discovery and group routes become available. Disabled groups return 404 and revoked tokens cannot access them. Verify with Console, controller and deployment integration checks.
- **AC-8 — Group synchronization (G3):** Given enabled groups and users from the same directory source, the IdP can perform group CRUD, filtering and atomic membership additions, removals and replacements. Verify that an unknown or out-of-scope user ID in an addition or replacement leaves the group unchanged. In one `PATCH`, remove a previously deleted user and add a valid user. The request must succeed and add the valid user exactly once, even if retried. Concurrent user deletion must leave no membership for the deleted user. Verify against the database, including audit failures and races.
- **AC-9 — Group permissions (G3):** Verify that the first sync matches an existing group by normalized name within the installation. Rename the group, then update its membership using the original SCIM ID. Verify that the update affects the same group and leaves its role bindings unchanged. Verify that on first sync, OpenClaw creates one group if no group matches and returns `409 Conflict` without changing any group if multiple groups match. Adding or removing members changes who gets access through the group, without changing roles, bindings, account status, or sessions. Syncing an empty membership list removes everyone. Deleting the IdP group stops synchronization but preserves the OpenClaw group, its members, and their access.
- **AC-10 — Group interoperability (G3):** Given a dedicated IdP, verified HTTPS and v1 staging, the directory synchronizes groups and direct memberships, retries failures and reconciles after disablement and re-enablement within agreed limits. Verify with provider receipts and persisted group and membership results.

### Additional integration checks

- **Administrator API (AC-3 and AC-4).** Verify that administrators can revoke sessions but cannot disable, reactivate, or reassign a SCIM-managed account. Test through the administrator API after provisioning, after deactivation, and while the IdP updates the account.
- **Identity and access (AC-2, AC-3, and AC-9).** Use signed test tokens with distinct subjects and Entra object IDs. Inspect the Principal, effective permissions, and sessions before and after reprovisioning and group updates. Confirm that an existing account retains its permissions when SCIM first takes over provisioning.
- **Concurrent writes (AC-2 and AC-4).** Provision 1,000 synthetic users. Race duplicate creates, enumerate IDs, and update, deactivate, reactivate, and delete users at bounded concurrency. Report first-attempt success counts and p50/p95 latency separately from retries. Account for every user and unexpected skip.
- **Recovery (AC-5).** Race administrator transfer with SCIM enablement. Confirm that unrelated offboarding succeeds even if the recovery administrator is unavailable.

Every criterion remains open until its corresponding evidence is recorded.

Register the deterministic database scenarios in the PostgreSQL authentication lane. Register the staging workflow in the QA matrix with explicit inputs and a disposable Installation. A local protocol check cannot close the external IdP or ingress gate.

## Open decisions

The [RFC’s unresolved questions](../rfcs/20261117-scim-provisioning.md#unresolved-questions) identify the proposed owners for denial telemetry and offboarding success and latency targets.

## Delivery record

Delivery evidence remains open for both milestones. This plan records neither approval nor release qualification.

## Manual Notes

## Changelog

- 2026-11-17: Prepared the unnumbered working plan for review.
- 2026-11-18: Expanded the RFC and primary plan to include a separate Groups and direct-membership milestone; deferred Role and binding integration.
- 2026-11-18: Replaced credential file delivery with administrator setup and token management in the Console.
- 2026-11-18: Narrowed recovery protection, separated activation updates from deletion, allowed fresh provisioning after deletion, and specified tokens without expiration and immediate rotation.
- 2026-11-25: Revised the plan from `ed92ed8` to cover existing accounts, recovery transfers, reprovisioning, and group matching and permissions.
