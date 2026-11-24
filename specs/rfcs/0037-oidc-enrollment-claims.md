---
status: Proposed
implementation_status: Implemented
author: kevinlin-openai
---

# Proposal: OIDC enrollment claim policy

- **ID:** RFC-0037
- **Created:** 2026-11-11
- **RFC and implementation PR:** [#5523](https://github.com/openclaw/openclaw-enterprise/pull/5523)
- **Related:** [RFC-0032](0032-oidc-account-enrollment.md), [current enrollment reference](../../docs/reference/authentication/team-enrollment.md)

## Summary

Accept a signed OIDC groups claim as a string or an array of strings, and let
operators choose whether first-login account creation requires verified email.
The configuration proposal is approved by the requesting maintainer. This RFC
submits the contract changes for review before implementation and leaves the
historical RFC-0032 unchanged.

## Motivation

Some identity providers emit one group as a scalar or omit email verification.
OCE currently rejects those enrollments. Operators need an explicit email policy
without changing identity binding or treating an unverified address as verified.

## Proposal

The OIDC provider exchange continues to validate the signed ID token before
reading claims. A string groups claim represents exactly one group. Arrays must
contain only strings. Match case-sensitively against the configured allowlist;
do not trim values or split commas. Missing or malformed claims deny sign-in.

Add `auth.oidc.enrollment.createAccount.requireVerifiedEmail`, default `true`,
with the same field under installation-profile `controlPlane.oidc.enrollment`
and in `OCC_AUTH_OIDC_ENROLLMENT` JSON. Reject non-boolean configuration values.
Include the resolved boolean in the effective policy fingerprint so changing it
invalidates attempts started under another policy.

For a new identity, `true` requires `email_verified === true`. With `false`,
accept boolean `true`, boolean `false`, or an absent claim. Reject other claim
types when present. In both modes require a valid, unused standard `email` claim.
Project an explicit `emailVerified` boolean into the existing account enrollment
input, and persist `true` only when the validated token said `true`.

The policy applies only when creating an account. Returning identities retain
their stored profile and verification status, even if profile claims are missing
or malformed. Existing-account attachment remains explicit. Keep the exact
provider-instance/subject identity, admission, freshness, initial Role and Group
settings, transaction locks, rollback, and audit behavior.

The provider exchange and account enrollment owners implement these changes;
no new Driver, endpoint, database schema, or identity lookup is introduced.

## Acceptance Criteria

- **AC-1:** Real OIDC login with a controlled IdP and PostgreSQL accepts string
  and array groups. Missing, malformed, case-changed, comma-joined, and padded
  nonmatching values deny admission without creating accounts.
- **AC-2:** Through that login, both email policy settings enforce the full
  true/false/absent/non-boolean matrix, valid standard email, and email collision
  refusal. The IdP itself emits false and absent verification claims. Stored
  verification is true only for a true signed claim.
- **AC-3:** First login creates one account with configured access; returning
  login reuses it. The user opens an Agent and receives a real browser-chat
  response. Record a native GitHub video attachment of the workflow.
- **AC-4:** Invalid tokens, stale attempts and changed policy fingerprints fail
  closed. Existing concurrency, rollback, identity attachment and access tests
  remain valid.

## Delivery and verification

Implement the OIDC exchange, enrollment input and account persistence together.
Update Helm and installation-profile schemas, the owning reference, setup guide,
and source-backed flow. Extend existing PostgreSQL and real OIDC workflow tests.
Report exact results and any missing real IdP, database, runtime, or video proof
in the implementation PR; implementation is not evidence of qualification.

### Verification record

At revision `a9f946bbc`, the implementation passed 17 PostgreSQL enrollment checks, 11 PostgreSQL OIDC
sign-in checks, and two Helm/profile configuration checks. The controlled real
Keycloak 26.7.5 matrix passed 23 checks against PostgreSQL 18.6, including
IdP-emitted false and absent verification. These results cover AC-1, AC-2 and
AC-4. The hosted [Keycloak OIDC](https://github.com/openclaw/openclaw-enterprise/actions/runs/43087783484/job/130756778780)
and [PostgreSQL authentication](https://github.com/openclaw/openclaw-enterprise/actions/runs/43087783484/job/130756779023)
lanes also pass at implementation revision `a9f946bbc`.

AC-3 passes in the [real OIDC Agent-chat qualification](https://github.com/openclaw/openclaw-enterprise/actions/runs/43087783341/job/130756991811):
one test passed, none failed or skipped, and cleanup passed. The job tested PR
revision `a9f946bbc` as merge revision
`ac56da7a0bbfe4cee989ec2a37fb43186287bb31`. Real Keycloak and PostgreSQL create
accounts with configured access and reuse them on returning login. The regular
Agent workflow creates and deploys an Agent, then an exact-Agent operator gets
real browser model responses. The test also verifies streaming, Stop, persisted
history after reconnect, a second response, and administration and sibling-Agent
access denials over HTTP and WebSocket.

The [33-second native GitHub video and screenshot](https://github.com/openclaw/openclaw-enterprise/pull/5523#issuecomment-6805569496)
show the real chat exchange after sign-in. A separate
[22-second enrollment recording](https://github.com/openclaw/openclaw-enterprise/pull/5523#issuecomment-6804107540)
shows first-login creation and returning SSO with absent verification and an
explicit no-grant policy. The uploaded chat video was opened and visually
verified. This qualification uses real Kubernetes runtime workloads and the
production application entrypoints with test ingress; it does not establish a
Helm-installed production deployment.

## Rationale and alternatives

Requiring verified email by default preserves current enrollment policy.
An explicit opt-out accommodates controlled IdPs while recording the actual
verification claim. Always marking email verified would misrepresent the IdP.
Automatic attachment by email would change the identity trust boundary and is
excluded. Scalar group support preserves exact matching without introducing a
second parsing language.
