# Connect Gmail and grant an Agent access

Use Google's `gmail.readonly` OAuth scope to connect a Gmail account once and
grant selected Agents permission to read mail. Google enforces that scope.
The template permits requests to `gmail.googleapis.com` through OpenShell. The
Token Service keeps the refresh grant. OpenShell presents the prepared access
token for an authorized request carrying the placeholder in `GOG_ACCESS_TOKEN`.
See the [connection template reference](../../reference/connection-templates.md).

The console has no connection controls yet, so these steps use the HTTP API.

## Before you start

- An OpenShell Installation with the Credential Gateway, a Credential Refresh
  Driver whose `clientWorkspace` names an OpenShell Workspace you provisioned, and
  `operatorTls` on the Backend; see
  [browser connections](../../reference/drivers/openshell-credential-gateway.md#configure-the-driver).
- A runtime image with `gog` installed, for example at `/usr/local/bin/gog`, and
  that exact path in the Credential Gateway's Installation-wide `toolBinaries`.
  OpenShell uses this list to admit tools to the protected route. The user's consent applies to the granted Agent and the approved requests.
- The OCC public origin set. The callback URI is `<public origin>/oauth/callback`.
- The OCC API and worker can reach `oauth2.googleapis.com` for exchange and refresh.
- An Installation administrator session cookie in `OCC_SESSION_COOKIE_JAR`, with
  `OCC_URL` and `OCC_ORIGIN` set; see
  [sign in as an administrator](../../reference/authentication/service-api-keys.md#sign-in-as-a-human-administrator).
- `jq`, and a private directory for the client secret. Do not print secrets.

## Create the Google OAuth client

1. In a Google Cloud project your organization controls, enable the Gmail API.
2. Configure the OAuth consent screen. Use the **Internal** audience if your
   Workspace allows it. An **External** app in **Testing** mode issues refresh
   tokens that expire after seven days, and `gmail.readonly` is a restricted
   scope that a public app must pass Google verification for.
3. Create an OAuth client of type **Web application**. Add the callback URI
   `<public origin>/oauth/callback` exactly as an authorized redirect URI.
4. Save the client ID, and save the client secret in a private file, such as
   `$PRIVATE_DIR/google-client-secret`.

## Create the connection template

Build the request from the private file so the secret never appears on the
command line:

```bash
(umask 077; tr -d '\n' < "$PRIVATE_DIR/google-client-secret" | jq -Rs \
  --arg clientId "$GOOGLE_CLIENT_ID" '{
    displayName: "Google Gmail (read-only)",
    issuer: "https://accounts.google.com",
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    clientId: $clientId,
    clientSecret: .,
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    authorizationParameters: { access_type: "offline", prompt: "consent" },
    endpoint: { host: "gmail.googleapis.com", port: 443, path: "/**" },
    envVar: "GOG_ACCESS_TOKEN"
  }' > "$PRIVATE_DIR/template.json")
curl --fail-with-body --silent --show-error --cookie "$OCC_SESSION_COOKIE_JAR" \
  -H "Origin: $OCC_ORIGIN" -H 'Content-Type: application/json' \
  --data-binary @"$PRIVATE_DIR/template.json" "$OCC_URL/connection-templates" | jq .data
rm "$PRIVATE_DIR/template.json"
```

Expected result: `201` with the template `id` and `redirectUri`. Confirm that
`redirectUri` matches the URI you registered with Google. Without
`access_type=offline` and `prompt=consent`, Google returns no refresh token and
the callback fails with `no_refresh_token`.

## Let people connect it

Grant `use` to everyone connecting Agents in one Namespace:

```bash
jq -n --arg ns "$OCC_NAMESPACE" --arg template "$TEMPLATE_ID" '{
  subjectKind: "namespace", subjectId: $ns, roleId: "role_connection_template_user",
  resourceKind: "connection_template", resourceId: $template
}' | curl --fail-with-body --silent --show-error --cookie "$OCC_SESSION_COOKIE_JAR" \
  -H "Origin: $OCC_ORIGIN" -H 'Content-Type: application/json' \
  --data-binary @- "$OCC_URL/iam/access-bindings"
```

Use `subjectKind: "identity"` with a person's `principalId` to grant one person
instead. Connecting an account requires read access to that Namespace. Anyone
who can invoke an attached Agent can ask it to use the mailbox within the
Agent's policy. Check [who has access to the Agent](../console/agent-sharing.md)
before attaching a personal account.

## Connect an account

From a signed-in Console tab on the OCC origin, start consent for the Namespace.

```javascript
const namespaceId = "<namespaceId>";
const response = await fetch(`/namespaces/${namespaceId}/connections`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ connectionTemplateId: "<templateId>" }),
});
if (!response.ok) throw new Error(`OCC refused the connection (${response.status})`);
const { data } = await response.json();
location.assign(data.authorizationUrl);
```

After Google redirects back, list `GET /namespaces/:namespaceId/connections` to
find the completed source ID. A caller with `credential_source:operate` on the
source and `agent:update` on the target sends `POST /namespaces/:namespaceId/agents/:agentId/connections/:credentialSourceId`
for each Agent that should use the account. Deploy each Agent to pick up the source.

## Check the result

Ask the Agent to run `test -n "$GOG_ACCESS_TOKEN" && echo set`, then a bounded
read such as `gog gmail search 'in:inbox' --max 1 --json`. Never ask it to print
the variable: OpenShell refuses model requests that carry the placeholder.

## Troubleshoot

- **`connection=failed&reason=client_refused`:** the client ID or secret is wrong,
  or the redirect URI does not match. Check the Google client, or
  [rotate the secret](../../reference/connection-templates.md#client-registrations).
- **`reason=issuer_required` or `issuer_mismatch`:** Check whether the provider returns the exact template issuer in the authorization response. OCC requires it when more than one issuer uses the [shared callback](../../reference/connection-templates.md#connect-an-account).
- **`reason=unknown_session`:** the link opened in a browser without the session
  that started the connection. Start again from the signed-in tab.
- **The source later reports `reauthorize`:** Google revoked or expired the grant,
  such as a seven-day Testing-mode token. Disconnect and connect again.
- **Other reasons:** see
  [callback failures](../../reference/connection-templates.md#callback-failures).

To remove access from one Agent, detach its connection and check that its running revisions have withdrawn the source. To revoke it from every Agent, [disconnect the saved account](../../reference/connection-templates.md#detach-or-disconnect). Revoking the app in the Google account also stops refresh.
