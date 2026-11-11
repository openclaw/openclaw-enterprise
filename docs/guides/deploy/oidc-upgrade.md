# Upgrade from direct GitHub sign-in to OIDC

Follow this procedure before installing a release that replaces direct GitHub
sign-in with [OIDC enrollment](../../reference/authentication/team-enrollment.md).
Qualify the selected broker before reopening access.

The outcome is one OCE account per existing person, with the same user ID,
Principal, resource ownership, and grants. OIDC sign-in must work before removing
the old sign-in path. New users then receive the configured initial Role and
Group memberships through OIDC enrollment.

## Prepare recovery and identity mapping

1. Follow the [upgrade checklist](upgrade-checklist.md) for backups, image
   selection, and a maintenance window. Verify the local recovery administrator's
   password sign-in before changing external authentication. Keep its credentials
   protected and available throughout the upgrade.
2. Configure the selected IdP using the [OIDC sign-in guide](oidc-sign-in.md).
   Verify its issuer, client ID, callback, TLS trust, and API egress. If an OIDC
   provider is already configured, use that instance; a different issuer or
   client ID changes identity links and needs a separate reviewed change.
3. Record the existing OCE user ID, Principal, external methods, and intended
   OIDC subject for each person. Obtain the subject from the trusted IdP. Never
   derive it from a GitHub numeric ID, login name, or email address. There is no
   public account-list API; use existing account records and the account detail
   operation for known user IDs.
4. [Qualify the IdP's membership mapping](#qualify-membership-mapping-and-freshness)
   and verify the standard `email` and `email_verified` claims needed for new
   accounts.

## Qualify membership mapping and freshness

Configure the IdP to emit custom admission values in the ID token's `groups`
array. For example, this enrollment rule admits members of one team:

```yaml
admission:
  groupsClaim: groups
  anyOf: ["github:team:example/platform"]
```

The IdP must emit `github:team:example/platform` only for an active member of
both the `example` organization and its `platform` team. This preserves the
current GitHub admission check. For organization-wide admission, it can emit
`github:org:example` for active organization members. Listing both values in
`anyOf` admits either match; it does not restrict organization members to that
team. These strings are operator-defined claim values, not GitHub-specific OCE
settings. `groupIds` separately selects local OCE Groups.

Before retiring live GitHub checks, document the maximum acceptable delay from
loss of eligibility to refusal of a new OCE sign-in. For the team rule above,
verify removal from the team and from the organization against that limit,
including sign-ins that reuse an existing IdP or broker session. Record the group
source, refresh behavior, chosen limit, and observed results. If the replacement
exceeds the limit, do not cut over. A newly issued ID token or fresh OCE account
proof does not establish that the IdP's membership data is current.

## Prove OIDC access for existing users

Close general ingress and use
[restricted access](auth-maintenance.md#close-ingress-and-use-restricted-access)
throughout attachment, target installation, and verification. Keep it restricted
until the reopening step below, even if a linked procedure says to reopen it.
The old release's OIDC path does not enforce admission claims.

On a release supporting both current sign-in methods, enable OIDC alongside the
existing provider through the documented stopped-maintenance procedure. Keep one
serving controller; this does not authorize mixed-version serving.

For each eligible account, use the administrator
[OIDC attachment procedure](oidc-sign-in.md#attach-and-detach). Read the current
account version immediately before attachment. Attachment invalidates the
account's sessions, so the person must sign in again. Disabled accounts stay
disabled; conflicting identities require administrator resolution.

Have the person sign in through OIDC. Verify that the session's user ID matches
the recorded account, and exercise an existing permitted resource operation and
an operation outside its grants. Confirm that resource ownership did not change.
Keep a list of verified accounts and unresolved conflicts. Do not proceed while
an active user depends only on the path being removed.

Existing accounts require explicit attachment; automatic email-based linking is
outside scope. Resolve identity conflicts before proceeding. The recovery
password remains available separately.

## Configure and verify target enrollment

In the target release, select the existing enrollment Group's exact ID in
`groupIds` to preserve its current authority. Use `createAccount.role: null` when
that Group supplies all required grants. Otherwise select an existing Role and
its explicit scope. Initial Roles apply only to newly created accounts; they do
not replace existing users' grants. Review direct and Group grants together.

Apply these target-release changes in the stopped upgrade window:

| Existing input or behavior                                                                                | Target release                                                                                                       |
| --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Helm `auth.github` and profile `controlPlane.github`                                                      | Remove these blocks; use the qualified `oidc` configuration.                                                         |
| `OCC_AUTH_GITHUB_CLIENT_ID`, `_CLIENT_SECRET`, `_ALLOWED_ORGS`, `_ALLOWED_TEAMS`, `_AUTO_ENROLL_GROUP_ID` | Remove direct-GitHub sign-in variables.                                                                              |
| `OCC_AUTH_GITHUB_RECOVERY_USER_ID`                                                                        | Rename to `OCC_AUTH_RECOVERY_USER_ID` for direct environment configuration. Helm `auth.recoveryUserId` is unchanged. |
| `github.subject` on account creation and GitHub attachment routes                                         | Use OIDC enrollment or explicit OIDC attachment.                                                                     |
| GitHub sign-in button and `/api/auth/providers/github/*`                                                  | Use the generic OIDC button and callback. Old-provider sessions cannot authenticate.                                 |

Retired inputs are rejected; the target release does not translate them. Keep
the old recovery variable until running the target image, which uses the new one.
Remove only credentials dedicated to retired sign-in consumers.
A GitHub App also used for repository access remains in service; do not uninstall
it or revoke its repository credentials as authentication cleanup.

Start the target release with general ingress still restricted. Verify:

- An admitted new identity creates one account with the selected Role and Groups.
- An existing linked identity returns to its original account without duplicate
  creation or an additional initial Role grant.
- A user outside the admission rule is refused. A duplicate email or external
  identity is refused without transferring account ownership.
- Loss of eligibility causes new sign-in refusal within the documented delay.
- Local recovery sign-in works when the IdP is unavailable.

After OIDC access is verified, detach old GitHub methods by `methodId` through
the existing account controls. Read a fresh account version for each mutation;
detachment ends the account's sessions again. Verify a fresh OIDC login afterward.
Disabled accounts must remain disabled throughout preparation and cutover.
Reopen general ingress only after these checks pass.

## Recover from a failed verification

Keep general ingress closed and use the verified recovery account to correct
provider configuration or identity attachment. Preserve the original OCE account
and grants; do not create a replacement account or rewrite subjects to make a
sign-in pass. Follow [upgrade recovery](production-upgrade-recovery.md) for release
or database failures. An older image is not assumed safe against a changed database.

After successful verification, retain the identity mapping and audit evidence.
IdP group removal does not end an existing OCE session or remove local grants.
Use [account disablement](../../reference/authentication/external-sign-in.md#session-and-recovery-controls)
for immediate offboarding, and revoke separately issued service keys independently.
