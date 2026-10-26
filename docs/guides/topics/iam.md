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

   No API lists accounts. With GitHub, Google or OIDC sign-in enabled,
   `GET /api/auth/accounts/$USER_ID` returns `principalId` again; a signed-in
   person finds their `USER_ID` as `user.id` in `GET /api/auth/session`.

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

   `occ` has no human sign-in: it uses the service key in `OCC_SERVICE_KEY_FILE`
   (see [service API keys](../../reference/authentication/service-api-keys.md#use-a-service-key)),
   so these grants run as, and are audited to, that key's ServicePrincipal. To
   record them under your own account, `POST` the same JSON to
   `$OCC_URL/namespaces/$OCC_NAMESPACE/iam/roles` and `.../iam/access-bindings`
   with your session cookie and `Origin: $OCC_ORIGIN`; read the Role ID from
   `.data.id`.

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
  not reuse, so disable it. Account controls need GitHub, Google or OIDC
  sign-in. On a password-only Installation they return `409`, so an abandoned
  account there cannot be disabled.

Add actions such as `update` or `deploy` to the Role for more access; see
[Authorization](../../reference/authorization.md) for actions and scope. Role
creation refuses `create` Permissions, and a binding refuses a Role with none
for its target's kind, because those grants could never apply. Pass the
Installation administrator `roleId` at creation only for someone who
administers the whole Installation.

## Remove a person

Accounts cannot be deleted; disable the account instead. As a human Installation
administrator with your session in `OCC_SESSION_COOKIE_JAR` (step 1 of
[Add a person](#add-a-person)), set `USER_ID` to the account's `id`, kept from its
creation. Without it, read it from the database with your approved access:
`SELECT id FROM occ."user" WHERE email = 'person@example.com'`. Read the account
version, then disable:

```bash
VERSION="$(curl --fail-with-body --silent --show-error \
  --cookie "$OCC_SESSION_COOKIE_JAR" -H "Origin: $OCC_ORIGIN" \
  "$OCC_URL/api/auth/accounts/$USER_ID" | jq -er .data.version)" &&
jq -n --argjson version "$VERSION" '{expectedVersion: $version}' |
  curl --fail-with-body --silent --show-error \
    --cookie "$OCC_SESSION_COOKIE_JAR" -H "Origin: $OCC_ORIGIN" \
    -H 'Content-Type: application/json' --data-binary @- \
    "$OCC_URL/api/auth/accounts/$USER_ID/disable"
```

The response shows `disabled: true`. Every session of the account ends at once, and
password and GitHub, Google or OIDC sign-in are refused; an external sign-in tells the
person the account is disabled. IAM grants stay, unused. The recovery account cannot be
disabled, and account controls need external sign-in (on a password-only Installation
they return `409`). `POST .../enable` with the same body reverses it.

Disabling does not end service keys. Keys belong to ServicePrincipals, and OCE does not
record whom a key was issued for, so find a person's keys by the name given at issuance
(name them after the person, as in [CLI access](../cli.md#give-a-member-or-automation-cli-access)).
Issuance and revocation are audited with the key's ID and name; this query lists keys
issued with a name prefix and not yet revoked:

```sql
SELECT issued.occurred_at, issued.details ->> 'serviceKeyId' AS key_id,
       issued.details ->> 'serviceKeyName' AS name,
       issued.details ->> 'servicePrincipalId' AS service_principal_id
FROM occ.audit_events issued
WHERE issued.action = 'openclaw.auth.service-keys.create'
  AND issued.outcome = 'success'
  AND issued.details ->> 'serviceKeyName' LIKE 'nora-%'
  AND NOT EXISTS (
    SELECT 1 FROM occ.audit_events revoked
    WHERE revoked.action = 'openclaw.auth.service-keys.revoke'
      AND revoked.outcome = 'success'
      AND revoked.details ->> 'serviceKeyId' = issued.details ->> 'serviceKeyId')
ORDER BY issued.occurred_at;
```

Revoke each with `occ service-key revoke <key-id>` or
[the HTTP request](../../reference/authentication/service-api-keys.md#revoke-or-rotate-a-service-key).
Keys past their expiry are already refused. If a ServicePrincipal served only this
person, also delete its AccessBindings in each Namespace: find them with
`occ iam access-binding list` and remove each with `occ iam access-binding delete <id>`.
Finally, disable the person at their identity provider as well.

## Let a person run an existing Agent

People cannot receive Namespace-wide `create`, so an Installation administrator
creates each Agent with its Configuration and Secrets. To let a team member
edit, deploy, stop and inspect it, keep the Namespace `read` binding from
[Add a person](#add-a-person), create one Role with all of these permissions,
and bind it to each target:

| Target                                    | Permissions                                                  |
| ----------------------------------------- | ------------------------------------------------------------ |
| The Agent                                 | `read`, `update`, `deploy`, `operate`, `read_logs`, `delete` |
| Its Configuration                         | `read`, `update`                                             |
| Each Secret or credential source it binds | `read`, `operate`                                            |
| Each Preset the Configuration uses        | `read`                                                       |
| Each AgentRevision                        | `read`                                                       |
| Its SandboxPolicy                         | `read`                                                       |

A binding applies only the Role's permissions for its target's kind. Deploying
needs `operate` on each Secret and credential source the Agent binds, also for a
person without `update`. Omit `delete` to keep the Agent's removal with administrators. Bind each new Agent revision
after it is deployed, or the person cannot see its status; see
[Agent revisions](agent-revisions.md). Secret reads return metadata, never values.
The SandboxPolicy ID is `sbp_` followed by the UUID part of the Agent ID.
`occ agent policy get` and `occ agent policy recommendations` need its `read`.

The console has no form for these grants. **Share Agent** on the Agent's
**Access** tab grants full [native administration](../console/agent-sharing.md)
of the Agent, not this set, so use the CLI or HTTP API as in
[Add a person](#add-a-person).

The person still cannot create Agents, Secrets or Configurations. Codex device
login on the Agent needs Agent `update` and `read`, plus Secret and
credential-source `create` in the Namespace, so only an Installation
administrator can start it; see
[Use a personal Codex login](../deploy/credential-lifecycle.md#use-a-personal-codex-login).
To message
the Agent, the person needs a channel its Configuration sets up or
[native admin](../../reference/agent-native-admin.md) with Agent `administer`,
which is unavailable on Installations with GitHub, Google or OIDC sign-in
enabled.

## Let an Agent use a Secret

Besides the person who deploys it, the Agent's own ServicePrincipal needs
`operate` on each Secret and credential source the Agent binds; without it, OCC
refuses the deployment. Only an Installation administrator can give the Agent
this grant: bind a Role that holds only Secret `operate` to the Agent's
ServicePrincipal, once for each exact Secret.

When the console creates an Agent, it binds the Role
`role_<namespace-id>_agent_secret_operate`, named `Agent Secret operate`, and
creates that Role on first use. Later console grants reuse any Namespace Role
that holds exactly Secret `operate`. Do the same with an administrator key file
and `OCC_NAMESPACE` set:

```bash
AGENT_SP="$(occ agent get '<agent-id>' -o json | jq -r .servicePrincipalId)"
ROLE_ID="$(occ iam role list -o json | jq -r 'map(select(.permissions == [{"action":"operate","resourceKind":"secret"}]))[0].id // empty')"
if [ -z "$ROLE_ID" ]; then
  echo '{"name":"Agent Secret operate","permissions":[{"action":"operate","resourceKind":"secret"}]}' > role.json
  ROLE_ID="$(occ iam role create --file role.json -o json | jq -r .id)"
fi
jq -n --arg p "$AGENT_SP" --arg r "$ROLE_ID" --arg s '<secret-id>' \
  '{subjectKind:"identity",subjectId:$p,roleId:$r,resourceKind:"secret",resourceId:$s}' > binding.json
occ iam access-binding create --file binding.json
```

Repeat the last two commands for each Secret. Creating the binding also needs
`read` on that exact Secret. For a credential source, use `credential_source` in
the Role and the binding. `occ iam access-binding list` shows the Agent's
grants: their `SUBJECT` is `$AGENT_SP`.
