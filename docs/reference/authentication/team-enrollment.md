# OIDC account enrollment

Configure `auth.oidc.enrollment` to admit selected identities and optionally create
OCE accounts at first sign-in. The same object is available as installation
profile `controlPlane.oidc.enrollment` or JSON in `OCC_AUTH_OIDC_ENROLLMENT`.
Without it, OIDC sign-in requires an explicitly attached account.
See [OIDC setup](../../guides/deploy/oidc-sign-in.md) and the
[upgrade from direct GitHub sign-in](../../guides/deploy/oidc-upgrade.md).

## Select admission and initial access

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
            namespaceId: "<existing Namespace ID>"
      groupIds: [group_config_default-user]
```

The referenced Role, Namespace and Groups must exist. Startup validates these
references after applying the Installation's IAM configuration. Every enrollment
transaction checks them again. Unknown fields and invalid policy combinations
fail activation.

`admission` is required. The verified ID token must contain the named top-level
claim as an array of strings, with at least one exact `anyOf` value. Values and
claim names are case-sensitive; the allowlist cannot be empty. Missing or malformed
claims refuse sign-in for both new and attached identities. This is an admission
rule, not a mapping from IdP groups to Roles. Configure the IdP to emit the claim
in its signed ID token.

With enrollment configured, OCE requests `openid email profile` and any explicit
`additionalScopes`. It does not call UserInfo. Without enrollment it requests only
`openid`. Scope names must be OAuth scope tokens, without spaces.

`createAccount.enabled` defaults to `false`. When `true`, `role` is required:

| Role selection                         | Initial direct grant                              |
| -------------------------------------- | ------------------------------------------------- |
| `null`                                 | None. Group grants can still provide access.      |
| `{id: ..., scope: installation}`       | The exact singleton Installation resource.        |
| `{id: ..., scope: {namespaceId: ...}}` | The existing Namespace and its resources.         |
| `{id: ..., scope: all}`                | Unscoped binding, including descendant resources. |

The Role must be Installation-scoped. Configured `role_config_` Roles are supported.
An exact Installation binding does not grant Agent or Namespace access. Initial
Role bindings apply only to newly created accounts; later logins do not add,
restore or change them. Review the Role's permissions and scope together.

`groupIds` selects existing Installation Groups by exact ID. Omission inherits
[configured default Groups](../authorization/default-users.md); an explicit list
replaces those defaults, and `[]` disables Group enrollment. Every admitted login
adds missing memberships, including for an existing account. It does not remove
memberships or change the Groups' bindings. Effective access combines direct
and Group grants.

## Identity, profile and transactions

OCE resolves the exact provider instance and `sub`. An existing identity keeps its
OCE user ID, Principal, name, email, resource ownership and grants. It needs no
profile claims to sign in. To use a manually created account, an administrator must
[attach its OIDC identity explicitly](../../guides/deploy/oidc-sign-in.md#attach-and-detach).
Email matching never attaches or transfers an identity.

An unknown identity can create an account only when creation is enabled. Its
standard `email` must be valid, `email_verified` must be boolean `true`, and the
trimmed, lowercased email must be unused in OCE. The optional `name` supplies the
display name; otherwise OCE uses the email. Alternative email claims are not read.
Perform profile mapping at the IdP. Configure verified email only when the IdP can
vouch for that address. A collision requires administrator resolution.

Creation commits the account, Principal, external method, initial Role binding,
Group memberships and their audit records together. OCE hashes a random local
password and discards it; it does not deliver a password or retain provider tokens.
The normal session transaction then checks the account and method before issuing
a cookie. A later session failure can leave a fully enrolled account without a
session. Retry sign-in; do not create another account.

Concurrent first logins create at most one identity. An attempt that predates
another callback's creation or an administrator's account change can be refused;
start a new login. Only the transaction that creates an identity may issue its
initial proof without an older account snapshot. Disabled or stale accounts are
never repaired by enrollment. Changing the effective policy invalidates pending
attempts, including changes to inherited default Groups.

## Offboarding and troubleshooting

Admission is checked on each OIDC login. It does not continuously synchronize
IdP membership, end existing sessions, or remove OCE grants. Qualify the IdP's
membership refresh behavior, including reused broker sessions, against the
required revocation delay. A fresh token alone does not prove fresh membership.
Use [account disablement](external-sign-in.md#session-and-recovery-controls) for
immediate offboarding and revoke separately issued service keys independently.

A refused admission or profile returns the generic sign-in error. Check the
signed claim mapping, creation policy and email ownership. Missing Role, Namespace
or Group references fail startup or enrollment; restore the intended policy
reference before retrying. Never resolve an identity conflict by rewriting the
subject or creating a replacement for an existing person's account.
