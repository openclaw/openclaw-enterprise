# IAM overview

Identity and access management (IAM) controls who can read, create, change, or
operate OpenClaw Enterprise resources. Signing in identifies a caller; it does
not grant access. OpenClaw Control Plane (OCC) checks each action against the
caller’s current permissions and the exact Installation, Namespace, or resource.
Without a matching grant, OCC denies the request. A matching Restriction also
overrides a grant.

## Choose an identity

- **People** sign in with an administrator-provisioned email and password. See
  [Authentication](../../reference/authentication.md) for sign-in and account
  provisioning, and [external sign-in](../../reference/authentication/external-sign-in.md)
  for GitHub, Google or OIDC sign-in of enrolled accounts. Public signup and OIDC
  provisioning are not supported.
- **Non-Agent automation** authenticates as an existing ServicePrincipal with a
  [service API key](../../reference/authentication/service-api-keys.md). Issuing
  a key does not give that identity new permissions.
- **Agents** have their own Namespace-scoped ServicePrincipal. That identity is
  separate from the user who creates or deploys the Agent. Agent-owned
  principals cannot use service API keys. See
  [Agent permissions](../../reference/authorization.md#principals).

[Service accounts](../../reference/service-accounts.md) are a separate feature:
Agents can use them for upstream credentials, such as a Backend-issued model
credential. A service account is not an IAM ServicePrincipal.

## Grant and check access

Permissions are assigned through Roles and AccessBindings. Installation
administrators create human accounts through the
[HTTP API](../../reference/authentication.md#account-provisioning) only, and
manage Namespace Roles and AccessBindings through the
[HTTP API or CLI](../../reference/authorization.md#manage-namespace-policy).
Groups and Restrictions remain managed by the selected IAM authority. See
[Authorization](../../reference/authorization.md) for available actions, scope,
and how denials work.

If a request returns `401`, check the session or service key. A `403` means the
current identity, scope, grant, or a Restriction did not permit the operation.
Have an administrator check the exact resource and action; access to a Namespace
does not give access to every resource in it.

## Add a person

A new account starts with no access. As a human Installation administrator:

1. [Sign in](../../reference/authentication/service-api-keys.md#sign-in-as-a-human-administrator)
   so `OCC_SESSION_COOKIE_JAR` holds your session, and set `OCC_ORIGIN` to the
   console origin. Under `recovery-only` password sign-in, only the recovery
   account signs in this way.
2. Create the account from a private file with a generated password, and keep
   the returned `id` and `principalId`. For a person who will sign in with
   GitHub, add `"github":{"subject":"<numeric user ID>"}` to the body to attach
   that identity in the same transaction:

   ```bash
   umask 077
   printf '{"email":"%s","password":"%s"}' 'person@example.com' \
     "$(openssl rand -base64 24)" > account.json
   curl --fail-with-body --silent --show-error \
     --cookie "$OCC_SESSION_COOKIE_JAR" -H "Origin: $OCC_ORIGIN" \
     -H 'Content-Type: application/json' --data-binary @account.json \
     "$OCC_URL/api/auth/accounts" > created.json
   USER_ID="$(jq -r .data.id created.json)"
   PRINCIPAL_ID="$(jq -r .data.principalId created.json)"
   ```

3. If the person signs in only through GitHub, Google or OIDC (always, under
   `recovery-only`), attach their identity to `USER_ID` now unless step 2
   did: see [GitHub](../../reference/authentication/external-sign-in.md#github-sign-in-for-existing-accounts),
   [Google](../deploy/google-sign-in.md#attach-and-detach) or
   [OIDC](../deploy/oidc-sign-in.md#attach-and-detach). Then delete
   `account.json`; never hand the password over.
4. Grant access in each Namespace the person needs. With `OCC_NAMESPACE` set,
   create a Role, then bind it to the Namespace for discovery and to each
   exact resource, such as an Agent:

   ```bash
   echo '{"name":"Read Namespace and Agent","permissions":[{"action":"read","resourceKind":"namespace"},{"action":"read","resourceKind":"agent"}]}' > role.json
   ROLE_ID="$(occ iam role create --file role.json -o json | jq -r .id)"
   for target in "namespace:$OCC_NAMESPACE" "agent:<agent-id>"; do
     jq -n --arg p "$PRINCIPAL_ID" --arg r "$ROLE_ID" \
       --arg k "${target%%:*}" --arg i "${target#*:}" \
       '{subjectKind:"identity",subjectId:$p,roleId:$r,resourceKind:$k,resourceId:$i}' > binding.json
     occ iam access-binding create --file binding.json
   done
   ```

5. For a person who signs in with a password, give them the password from
   `account.json` through your own secure channel, then delete the file.

Creation always requires a password, so an SSO-only account keeps one that
nobody uses. It is still a credential:

- Under `auth.passwordSignIn: all`, the default even with a provider enabled, it
  signs in. Switch to
  [`recovery-only`](../../reference/authentication/external-sign-in.md#recovery-only-password-sign-in)
  once everyone has an identity.
- Under `recovery-only` it is refused, but it works again if the setting returns
  to `all` or [deactivation](../deploy/auth-maintenance.md#deactivate-external-sign-in)
  restores password-only sign-in.
- No API resets or removes it, and detach refuses password methods with `409`.
  Of the account controls, only disabling stops it, and that also stops the
  person's SSO sign-in.
- Accounts cannot be deleted. If an attach fails, for example with `409`
  because another account already holds the subject, correct the subject and
  attach again. (A refused `github.subject` in step 2 creates nothing; retry
  the creation.) An account you abandon keeps its email, which creation will
  not reuse, so disable it.

Add actions such as `update` or `deploy` to the Role for more access; see
[Authorization](../../reference/authorization.md) for actions and scope. A
binding refuses a Role with `create` Permissions or none for its target's kind,
because those grants could never apply. Pass the
Installation administrator `roleId` at creation only for someone who
administers the whole Installation.
