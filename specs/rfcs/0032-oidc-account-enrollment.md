---
status: Proposed
implementation_status: Not implemented
author: kevinlin-openai
---

# Proposal: OIDC account enrollment and initial Roles

- **ID:** RFC-0032
- **Created:** 2026-11-09
- **Implementation plan:** [Delivery](../plans/0032-oidc-account-enrollment.md)
- **Related:** [OIDC sign-in](0001-oidc-sign-in.md), [federated sign-in](0007-human-federated-sign-in/index.md), [OIDC Agent chat](0031-oidc-agent-chat.md)

## Summary

Add opt-in OpenID Connect (OIDC) enrollment to OpenClaw Enterprise (OCE).
An operator specifies which authenticated identities may enter, whether an
unknown identity may create an account, and the existing Role and scope assigned
to that new account. Optional Group enrollment applies to new and existing
accounts. The normal OIDC callback performs these actions before issuing the
OpenClaw Control Plane (OCC) session.

Keep administrator-managed identity attachment separate from IdP profile mapping
and just-in-time (JIT) creation.
Any identity provider (IdP) that meets OCE's existing OIDC profile and this RFC's
claim requirements can supply identities. Keep immutable provider identity as
the account key. Replace direct GitHub browser sign-in and automatic team
enrollment with this OIDC path and publish upgrade instructions before removal.
This RFC is proposed, not implemented or accepted.

## Motivation and current behavior

[Generic OIDC sign-in](../../docs/guides/deploy/oidc-sign-in.md) currently returns
the verified `sub` and requires an attached OCE account. It does not consume
profile or Group claims and cannot create accounts.

[GitHub team enrollment](../../docs/reference/authentication/team-enrollment.md)
can create an account and add new or existing accounts to one pre-existing IAM
Group. It checks GitHub membership and fetches a verified primary email through
GitHub APIs. Its account transaction and session checks already provide useful
enrollment boundaries, but the admission policy is specific to GitHub and cannot
select an initial Role directly.

An operator should be able to assign a person to an approved IdP group,
have that person sign in, and obtain an OCE account with precisely configured
access. Enabling OIDC alone must continue to require existing account enrollment.
Session sharing and Agent chat remain owned by RFC-0031; this proposal does not
depend on changing cookie scope or Agent permissions.

## Goals and non-goals

- Create an account on its first eligible OIDC sign-in, with an explicit initial
  Role binding or an explicit choice of no direct grant.
- Preserve existing users, Principals, and resources when attaching an identity.
- Retire GitHub-specific browser authentication, configuration, and setup
  instructions after qualifying OIDC access for new and existing accounts.
- Exercise the resulting account through ordinary authorized Agent operations.

SCIM, background directory synchronization, multiple issuers per Installation,
arbitrary claim expressions, per-group Role selection, public signup, automatic
resource creation, automatic account linking, and profile updates on subsequent
sign-in are outside scope.
GitHub repository credentials and Google-specific sign-in remain outside scope.

## Proposal

### Operator-owned enrollment policy

Add the same enrollment object under Helm `auth.oidc.enrollment` and installation
profile `controlPlane.oidc.enrollment`. Render it as the API's single JSON setting
`OCC_AUTH_OIDC_ENROLLMENT`; there is no independently maintained second policy.
Absence disables enrollment. The policy belongs to the configured OIDC provider
instance, which remains derived from issuer and client ID.

The following is proposed configuration, not a working setting today:

```yaml
auth:
  oidc:
    enrollment:
      admission:
        groupsClaim: groups
        anyOf: [oce-members]
      additionalScopes: [groups]
      createAccount:
        enabled: true
        role:
          id: role_config_agent_creator
          scope:
            namespaceId: "<existing default Namespace ID>"
      groupIds: [group_config_default-user]
```

`admission` is required and permits sign-in only when the verified ID token's
named top-level claim is an array of strings containing at least one exact
`anyOf` value. The allowlist must be nonempty. Missing or malformed claims deny
sign-in, including for already attached accounts. Claim names and values are
case-sensitive; regular expressions and nested expressions are unsupported.
Group membership is a configured custom claim, not a standard OIDC claim;
the IdP must emit it in the required shape.

With enrollment enabled, request `openid email profile` plus the explicitly
configured `additionalScopes`. Read only signed, validated ID-token claims;
this proposal does not add a UserInfo request. The operator must configure the
IdP to include the required claims in that token. Required profile data is
validated only when creating an account, so a known identity
does not need profile claims merely to sign in.

`createAccount.enabled` defaults to false. When true, `role` is required: either
an existing Role ID with an explicit scope, or `null` for no direct grant.
When omitted, `groupIds` inherits `iam.defaultUserGroups`, resolving configured
Group names to their existing Installation Group IDs. An explicit `groupIds`
list replaces that default; `[]` disables Group enrollment. Unknown fields,
invalid combinations, and missing or incompatible Role, Namespace, or Group
references fail configuration activation. References
are checked again in the enrollment transaction before any write.

### Identity linking and profile mapping

Resolve the exact `(provider instance, sub)` first. An attached identity keeps
its OCE user ID, Principal, profile, methods, and grants. Disabled, unenrolled,
or stale account proofs remain refused; enrollment must not repair them.

An unknown subject can create a new account only if creation is enabled and its
normalized email is unused, using OCE's existing email normalization.
A matching email on another account is a conflict, not permission to attach.
Administrators can use the existing explicit identity-attachment operation.
There is no `accountLinking` setting or automatic email-based attachment.
Subsequent sign-ins use the immutable subject link, even if the IdP later changes
the email.

The IdP owns profile mapping and must emit the standard `email`,
`email_verified`, and optional `name` claims. OCE supports no alternate email
or name claim settings. Account creation requires the boolean `email_verified: true`
for the same standard `email` value; missing or false verification is refused.

For a genuinely new account, require a valid, verified email and use the standard
nonempty `name`, or that email when the name is absent. Enforce existing account
field limits. Never use an unverified email, login name, or Group claim as the
identity key. The initial password remains a randomly generated secret whose
hash satisfies the existing account contract; discard the secret immediately.
No IdP tokens are persisted or passed to Agents.

### Initial Roles and Group enrollment

The initial Role is an ordinary native IAM AccessBinding to the new Principal,
created in the account transaction. It takes effect only when an account is
created. A repeat sign-in or attachment to an existing account neither adds nor
restores this binding. Changing the configured Role affects future accounts;
it does not change prior users' grants.

Scopes use existing IAM semantics:

| Policy scope              | Result                                                                        |
| ------------------------- | ----------------------------------------------------------------------------- |
| `installation`            | Exact singleton Installation resource; no implicit Namespace or Agent access. |
| `{ namespaceId: "<id>" }` | Namespace-wide access within that existing Namespace.                         |
| `all`                     | Unscoped Installation-wide binding, including descendant resources.           |

The Role must be Installation-scoped, including a configured `role_config_`
Role or the existing administrator Role. This enrollment path extends the
accounts API's narrower Role selection; it does not silently change that API.
The explicit `all` choice can confer full administration and must never be a
default. Permissions come from the referenced Role, never from token-supplied
Role IDs. Enrollment does not create Roles or change their permissions.

For every admitted sign-in, add missing resolved Group memberships for both new and
existing eligible accounts. Membership insertion is idempotent and retains the
Groups' current bindings. This preserves GitHub enrollment's additive behavior.
Direct grants and Group grants combine through normal IAM evaluation; a narrow
initial Role does not cap wider Group authority. The operator must review both.

### Callback, ownership, and atomicity

The existing authentication owner in `apps/controller/src/auth/` validates the
OIDC response, applies the enrollment policy, and supplies verified identity and
profile values. Extend the existing human-account enrollment owner in
`packages/occ/src/state/human-authentication.ts`; do not create an alternate user
store or a second callback. Native IAM owns Principal and binding semantics.

The proposed callback order is:

1. Consume the browser-bound attempt and validate signature, issuer, audience,
   expiry, nonce, and subject through the existing OIDC verifier.
2. Evaluate admission claims. Resolve the exact identity or the new-account
   action. An unknown identity with creation disabled denies sign-in; an email
   conflict never links an existing account.
3. Serialize enrollment for the provider/subject. Lock and recheck any existing
   account and IAM references. Commit account, Principal, external method,
   authentication enrollment, initial binding, Group additions, and their audits
   in one State transaction, as applicable.
4. Issue a session through the existing proof/version checks in a separate
   transaction. A successful enrollment can survive failed session issuance;
   the next fresh sign-in resolves the same account.

Database uniqueness remains authoritative for emails, external identities, and
memberships. Concurrent attachment and first sign-ins cannot transfer an identity,
create duplicate accounts, or leave partial grants.

For an existing identity, lock the account and recheck enrollment, enabled state,
and the existing account/method freshness checks against the login attempt's
creation time. Refuse account or method changes after the attempt began.
Only a new account and method created by this enrollment transaction may use a
proof at their newly created versions, following the existing
[`enrollExternal`](../../packages/occ/src/state/human-authentication.ts) pattern.
This exception does not apply to pre-existing methods or competing callbacks.
The separate session transaction revalidates the proof, so a later account or
method change still prevents session issuance. Explicit administrator attachment
retains its existing version checks and session invalidation.

An attempt begun under a different enrollment policy is refused; include policy
identity, including resolved default Groups, in the existing attempt binding
rather than executing changed policy against an old login. A fresh sign-in is
the recovery action.

Record the policy identity, provider, subject, user/Principal, selected Role and
scope, and actual Group additions in enrollment audit evidence. Use existing
account/method/Group events where applicable and native IAM binding events for
the grant. Every matched-attempt refusal is audited without logging tokens or
raw claim sets. Account conflicts remain generic to the browser; provider
unavailability remains distinguishable from an admission refusal. Audit failure
rolls back the affected enrollment or session transaction.

### Lifecycle and GitHub replacement

Admission runs at each OIDC sign-in against that token's claims. Removing a user
from an IdP group can block the next sign-in once the IdP reflects the change;
it does not remove OCE memberships, initial grants, or existing sessions.
Immediate offboarding still requires OCE account disable and separate service-key
revocation. Disabling enrollment leaves existing accounts and grants intact and
returns OIDC to its existing attached-account behavior.

GitHub identities must reach OCE through an OIDC IdP; GitHub's OAuth login is
not an OIDC issuer. Brokering login alone does not prove team membership.
Before replacing live GitHub checks, qualify the IdP's group source, preserve
active organization and team eligibility, and prove membership-removal handling
within an operator-documented maximum delay, including reused broker sessions.
A fresh token or account proof does not establish membership-source freshness.
The [upgrade guide's mapping example](../../docs/guides/deploy/oidc-upgrade.md#qualify-membership-mapping-and-freshness)
defines the claim mapping and qualification procedure; OCE adds no GitHub-specific
policy fields.
Preserve the existing target Group through `groupIds`, with initial `role: null`
when no direct grant is required. Never reinterpret GitHub subjects as OIDC subjects.

Remove direct GitHub exchange and membership lookups, provider routes and
discovery, the Console button, `github.subject` account-creation input, and
GitHub identity attachment. Remove `auth.github`, `controlPlane.github`, and
`OCC_AUTH_GITHUB_*` sign-in settings. Rename the shared recovery variable to
`OCC_AUTH_RECOVERY_USER_ID`; retain `auth.recoveryUserId`. Reject retired inputs
with a link to upgrade guidance, without compatibility aliases. Repository
Drivers, Apps, tokens, and their configuration remain unchanged.

The [draft upgrade guide](../../docs/guides/deploy/oidc-upgrade.md) owns the
procedure: verify recovery, enable OIDC on a release supporting both paths,
attach and verify existing accounts, then install the replacement release. Keep
general ingress restricted until target admission-denial checks pass.
Old-provider sessions end; users sign in again. Accounts, Principals, resources,
Groups, and grants survive. Qualify this sequence before removing GitHub support.
Preserve old documentation routes and anchors as pointers to the guide; remove
their direct-GitHub setup instructions when implementation ships. Historical
specifications remain unchanged. New-install instructions use generic OIDC.

## Delivery and verification

The implementation plan covers policy/configuration,
verified claim projection, transactional enrollment and native IAM binding
composition, then deployment inputs and documentation. Any Driver contract change
must be submitted for human review before coding under repository policy.

Required integration evidence uses the real callback, PostgreSQL, native IAM,
and ordinary Agent APIs. Extend existing OIDC and enrollment suites to prove:

- Eligible first sign-in creates exactly one account with the selected Role and
  scope; permitted Agent actions succeed and actions outside that scope fail.
- Known and explicitly attached accounts preserve their profile and grants; Group
  additions are idempotent and initial Roles apply only to newly created accounts.
- Omitted `groupIds` inherits default user Groups; an explicit list replaces
  those defaults, and `[]` adds no Group memberships.
- Creation disabled, rejected claims, invalid profile, email conflicts,
  disabled/stale proofs, and invalid IAM references fail closed. Matching email
  never attaches an unknown subject to an existing account.
- Creation rejects missing or false `email_verified`; an alternate email
  attribute never replaces the standard `email`.
- A newly created account signs in during the same callback at the new versions.
  Prior account changes, competing stale callbacks, and changes between enrollment
  and session issuance are refused without weakening normal freshness checks.
- Concurrent callbacks, policy changes, audit failures, and session failures
  preserve uniqueness, atomicity, and recovery behavior.
- Offboarding, provider removal, Role changes, and enrollment disable follow the
  stated session and grant lifetimes.
- The documented upgrade preserves existing accounts and grants, ends old
  provider sessions, rejects retired settings, and preserves repository access.

### Required browser acceptance scenarios

1. **Generic OIDC:** Create an Installation and deploy an Agent with
   [browser chat enabled](../../docs/reference/agent-native-admin.md).
   Manually create an OCE account with default-user permissions and provide
   the required exact-Agent `read` and `operate` access without Installation
   administration. Create its identity at the IdP and explicitly attach that
   provider instance and subject to the OCE account. Configure the IdP to issue
   a valid signed enrollment claim matching the admission policy. From a clean
   browser session, sign in through OIDC. Verify the session uses the original
   OCE user ID, Principal, and attached method, with no duplicate account or
   new initial Role binding. Open the Agent's chat, send a message, and receive
   a real model reply using that OIDC session, without an OCE password login.
2. **GitHub through OIDC:** Repeat scenario 1 in a fresh setup, using a real
   GitHub identity through the selected OIDC broker. Attach the broker-issued
   subject, not the GitHub subject. Use actual organization/team membership to
   produce the admission claim. Verify the same account preservation and chat
   outcomes through OCE's generic OIDC callback, with direct GitHub sign-in disabled.

Use the [OIDC test environment](../../docs/guides/deploy/oidc-keycloak.md).
Its provider is not a product requirement. Retain the JIT checks above.
Record the tested revision, account/Agent IDs, and observed chat outcomes without
tokens. Fixtures do not prove deployed claims, membership freshness, or model
execution. Missing live prerequisites leave acceptance incomplete.
These scenarios remain unrun.

Update authentication and enrollment references, OIDC and upgrade guides, the
owning flow, API and configuration cheat sheets, and default-user membership
claims with implementation. Remove GitHub sign-in setup from installation and
profile guides. Coordinate Agent chat proof with RFC-0031; account creation
alone does not confer chat access.

## Rationale and alternatives

The immutable identity link, explicit administrator attachment, IdP-owned profile
mapping, and JIT creation decision have separate responsibilities. OCE consumes
validated claims and applies its local enrollment policy. This keeps the policy
independent of provider-specific APIs, expression engines, and directories.

Keeping GitHub-specific enrollment leaves every provider needing its own account
creation path. Making email the durable identity risks account reassignment when
addresses change. Group-only grants preserve today's workaround but do not let
an operator select an initial account Role directly. SCIM is the better separate
design for continuous lifecycle synchronization; it requires provisioning APIs
and does not replace OIDC authentication.

## References

- [OIDC standard claims](https://openid.net/specs/openid-connect-core-1_0.html#StandardClaims)
- [OIDC claim stability and uniqueness](https://openid.net/specs/openid-connect-core-1_0.html#ClaimStability)
- [OCE account provisioning](../../docs/reference/authentication.md#account-provisioning)
- [OCE IAM configuration and Groups](../../docs/reference/authorization/default-users.md)
