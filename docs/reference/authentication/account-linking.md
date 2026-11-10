# Link an existing account to OIDC

An existing OCE user can attach a new OIDC identity after proving both account
ownership and control of that identity. This is an explicit, opt-in Console
flow. An email match, an existing session, or a failed ordinary login cannot
start or authorize attachment.

## Enablement and proof methods

Set `auth.oidc.linking.enabled: true` in Helm, or
`controlPlane.oidc.linking.enabled: true` in an installation profile. The API
setting is `OCC_AUTH_OIDC_LINKING_ENABLED=true`; only `true` and `false` are
accepted. The default is `false`. OIDC must be configured. This setting is
independent of [automatic enrollment](team-enrollment.md).

The existing account's password or an already attached identity for the
configured OIDC provider proves ownership. The password path uses the ordinary
password rate limits and recovery-only policy. A current session does not
replace either proof. Native Google sign-in is not a linking proof method.
An administrator must attach the identity if no eligible method remains.

Each external proof sends `max_age=0`. The issuer must require fresh
authentication and return signed `auth_time` and `iat` claims. Both times must
be at least the challenge start time minus 60 seconds; neither may exceed the
current time plus 60 seconds. Signature, issuer, audience, nonce, expiry, PKCE,
and configured admission checks still apply. Missing or stale `auth_time`
fails closed. Email is not required or compared.

Before enabling linking, qualify the issuer and each upstream broker connector
with an existing provider session. Verify that the new challenge requires
reauthentication and that signed `auth_time` reflects that authentication.
A broker that issues a new token from an old login without reauthentication
is not qualified. Sending `prompt=login` alone does not establish freshness.

## Browser flow and effects

Select **Link OIDC to an existing account** on the Console sign-in page. Prove
the existing account, authenticate the candidate identity, review the account
and exact provider/subject, then select **Confirm link**. Complete the flow
within five minutes. Cancel or sign out to discard it.

The parent attempt and its one-use provider challenges are bound to a host-only
HttpOnly cookie and stored in PostgreSQL. Every POST requires the exact Console
Origin. The parent expires after five minutes; token expiry can shorten proof
validity. The combined pending-login/link capacity is 1,000 per Installation;
new attempts evict the oldest entries. Expired entries are removed on new starts.

Confirmation rechecks the enabled account, proof method and versions, configured
provider and linking policy, and the recovery designation when required. One
transaction attaches the method, increments the account version, revokes all
account sessions, and appends `authentication.method.attach` with the owner's
Principal and `source: self-service`. Existing native Agent handles lose their
parent sessions. The browser then starts an ordinary sign-in.

Attachment preserves the user, Principal, name, email, Roles, Groups and resource
ownership. It does not enroll Groups. A later ordinary OIDC login still applies
any configured Group enrollment policy. A fresh flow for an identity already
attached to this account completes without a new method, version or audit.
An identity held by another account, including a disabled account, cannot move.

## HTTP operations and recovery

All operations use `POST /api/auth/oidc/link/<action>`:

| Action      | Request and result                                                      |
| ----------- | ----------------------------------------------------------------------- |
| `start`     | Creates a browser-bound parent and returns its stage and expiry.        |
| `status`    | Returns the stage and, after proof, the account and candidate identity. |
| `password`  | Accepts `email` and `password` to prove existing ownership.             |
| `owner`     | Starts fresh OIDC proof for an already attached identity.               |
| `candidate` | Starts fresh OIDC proof for the identity to attach.                     |
| `confirm`   | Returns `methodId` and `created` after the attachment transaction.      |
| `cancel`    | Discards the parent and its provider challenges.                        |

Provider proofs use the existing OIDC callback. They create no session or user.
Provider discovery includes `oidcLinking: true` only when linking is enabled.
Disabled linking returns `403`. Invalid proof returns `401`; expired or changed
state and attachment conflicts return `409`; request limits return `429`.
Known proof refusals invalidate the attempt.

A dependency failure or uncertain COMMIT returns `503`. Do not retry confirmation
automatically or delete an identity to compensate. Restart the explicit linking
flow with the original account method. A committed attachment then resolves as
already linked. Do not test an uncertain result with ordinary candidate login:
if enrollment is enabled and attachment did not commit, that could create a
separate account. Ask an administrator for help if the original method is no
longer usable.
