# Automatic enrollment from a GitHub team

An operator can let verified members of configured GitHub teams create their
OCE account on first sign-in and join an existing native IAM Group. Set
`OCC_AUTH_GITHUB_AUTO_ENROLL_GROUP_ID` (Helm `auth.github.autoEnrollGroupId`) to
that Group's exact ID, including punctuation. Leaving it empty preserves
administrator-managed enrollment.
This requires the existing [GitHub sign-in profile](external-sign-in.md#github-sign-in-for-existing-accounts).

## Configuration and permissions

```yaml
auth:
  github:
    enabled: true
    allowedOrgs: []
    allowedTeams:
      - example/platform
    autoEnrollGroupId: group_platform_members
```

The Group must already exist at Installation scope. All configured `allowedTeams`
qualify for the same Group; `allowedTeams` must be nonempty and `allowedOrgs`
must be empty. Invalid combinations fail configuration validation. The
[installation profile](../../guides/deploy/installation-profiles.md#external-sign-in-and-trusted-proxies)
uses the same fields under `controlPlane.github`.

The Group's existing [AccessBindings](../authorization.md#access-bindings-and-groups)
determine access. Enrollment creates no Role or binding. A Role bound only to the
Installation resource does not grant access to Namespace or Agent resources;
full administration requires the existing administrator Role with an unscoped
Group binding. Group and broad binding management have no public API; this
setting selects an operator-provisioned Group, rather than creating one.

The GitHub App needs organization **Members: read**, as the existing team
allowlist requires. For first-time enrollment it also needs user **Email
addresses: read**. Users must accept that permission. OCE reads the authenticated
user's [email addresses](https://docs.github.com/en/rest/users/emails#list-email-addresses-for-the-authenticated-user)
and accepts exactly one verified primary address from the first 100 entries.
A public profile address or GitHub login is never a substitute. No OAuth scope
is requested, and no GitHub token is persisted.

## Sign-in behavior

The callback verifies active organization and team membership before looking up
an OCE account. It identifies the person by GitHub's immutable numeric user ID
and the configured provider instance, not by email or login name. After the team
check, OCE rereads the authenticated profile with the same token and requires the
same numeric ID and login, rejecting a login change during membership lookup.

For a new identity, OCE reads the verified primary email and atomically writes
the account, Principal, external sign-in method, enrollment and Group membership,
with audit records. The account has no direct grants. To preserve the existing
account contract, OCE hashes a random local password and discards it without
displaying or delivering it. The same callback can issue a session after the
normal account and method-version checks.

An attached identity with an ineligible or stale sign-in proof is refused without
requesting email addresses. An already attached, enabled account joins the Group without changing its name,
email or sign-in methods. It does not request email addresses, so adding the
setting does not make existing sign-ins depend on the new GitHub permission.
Disabled or unenrolled accounts are not repaired. A matching email on a different
OCE account never links or transfers the GitHub identity; an administrator must
resolve that conflict using the existing account controls.

Concurrent first sign-ins create at most one account and membership. An attempt
that started before another callback created or attached its method can be
refused by the existing currentness check; begin a fresh sign-in. A failure
before transaction commit leaves no partial enrollment. A later session failure
can leave a fully enrolled account without releasing a session cookie.

## Offboarding and failures

This setting enrolls accounts; it does not continuously synchronize membership.
Every GitHub sign-in checks the current team membership. Existing sessions keep
their normal maximum eight-hour lifetime. Removing someone from GitHub does not
remove their OCE Group membership or invalidate access through another configured
provider or an existing password. Use the supported [account disable operation](external-sign-in.md#session-and-recovery-controls)
for immediate offboarding; revoking sessions alone does not prevent another
sign-in. Separately issued [ServicePrincipal API keys](service-api-keys.md) retain
their own authority and require separate revocation. Recovery-only password
sign-in can restrict ordinary accounts to their external providers.

Disabling automatic enrollment stops future additions and leaves existing
accounts and grants intact. OCE has no API to remove an individual Group member.
Removing a [configured Group](../authorization/default-users.md) also removes
its memberships.

Missing email permission, provider errors and timeouts refuse new enrollment;
provider warnings identify the `email` step without logging addresses or tokens.
Missing or ambiguous verified primary email refuses sign-in. A missing or
Namespace-scoped Group fails before account creation. Check the configured Group
ID and its bindings, the GitHub App permissions, and the existing sign-in audit.
