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
   console origin.
2. Create the account from a private file with a generated password, and keep
   the returned `principalId`:

   ```bash
   umask 077
   printf '{"email":"%s","password":"%s"}' 'person@example.com' \
     "$(openssl rand -base64 24)" > account.json
   PRINCIPAL_ID="$(curl --fail-with-body --silent --show-error \
     --cookie "$OCC_SESSION_COOKIE_JAR" -H "Origin: $OCC_ORIGIN" \
     -H 'Content-Type: application/json' --data-binary @account.json \
     "$OCC_URL/api/auth/accounts" | jq -r .data.principalId)"
   ```

3. Grant access in each Namespace the person needs. With `OCC_NAMESPACE` set,
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

4. Give the person the password from `account.json` through your own secure
   channel, then delete the file. With GitHub, Google or OIDC sign-in, also
   [attach their identity](../../reference/authentication/external-sign-in.md).

Add actions such as `update` or `deploy` to the Role for more access; see
[Authorization](../../reference/authorization.md) for actions and scope. A
binding refuses a Role with `create` Permissions or none for its target's kind,
because those grants could never apply. The
Installation administrator `roleId` at creation grants account and service key
administration only. It gives no Namespace or Agent access; grant that with
Namespace bindings as above.
