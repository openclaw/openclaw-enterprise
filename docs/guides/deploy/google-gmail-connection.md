# Connect Google Gmail to a personal Agent

Set up a Google Gmail read-only connection template so a person can connect
their own Gmail account to their Agent, whose `gog` tool then reads mail. The
refresh token stays in OpenShell; the Agent receives only a placeholder in
`GOG_ACCESS_TOKEN`. The [connection template reference](../../reference/connection-templates.md)
defines the behavior and limits.

These steps use the console; the
[HTTP API](../../reference/connection-templates.md#connect-an-account) and the
`occ connection-template` commands offer the same template actions.

## Before you start

- An OpenShell Installation with the Credential Gateway, a Credential Refresh
  Driver whose `clientWorkspace` names an OpenShell Workspace you provisioned, and
  `operatorTls` on the Backend; see
  [browser connections](../../reference/drivers/openshell-credential-gateway.md#configure-the-driver).
- A runtime image with `gog` installed, for example at `/usr/local/bin/gog`, and
  that exact path in the Credential Gateway's `toolBinaries`. Every listed tool
  binary receives the credential, so list only what you need.
- The OCC public origin set. The callback URI is `<public origin>/oauth/callback`.
- The OCC API and the OpenShell gateway Pod can reach `oauth2.googleapis.com`.
  With the production chart, enable
  [token endpoint egress](../../reference/connection-templates.md#token-endpoint-egress)
  for the API.
- An Installation administrator account for the console.

## Create the Google OAuth client

1. In a Google Cloud project your organization controls, enable the Gmail API.
2. Configure the OAuth consent screen. Use the **Internal** audience if your
   Workspace allows it. An **External** app in **Testing** mode issues refresh
   tokens that expire after seven days, and `gmail.readonly` is a restricted
   scope that a public app must pass Google verification for.
3. Create an OAuth client of type **Web application**. Add the callback URI
   `<public origin>/oauth/callback` exactly as an authorized redirect URI.
4. Keep the client ID and client secret available for the next step. Do not
   paste the secret into chat, tickets, or shell history.

## Create the connection template

1. Sign in to the console as an Installation administrator and open
   **Settings**.
2. Under **Connection templates**, choose **New connection template**, then
   **Fill in the Gmail example**.
3. Enter the Google **Client ID** and **Client secret**, and choose
   **Create template**.
4. Confirm that the template's **Redirect URI** matches the URI you registered
   with Google.

The example sets `access_type=offline` and `prompt=consent`. Without them, Google
returns no refresh token and the callback fails with `no_refresh_token`.

## Let people connect it

Under the template, choose **Namespace** and the Namespace whose Agents may
connect, then **Grant use**. To grant one person, choose
**Person (principal ID)** and enter their principal ID.

The person also needs exact `read` and `update` on their Agent, plus `deploy`
and `administer` to deploy and chat with it; see
[Share an Agent](../console/agent-sharing.md). Grant these only to the Agent's
owner: a connected Agent cannot have other people's grants.

## Connect an account

The person follows [Connect an account](../console/agent-connections.md#connect-an-account)
in their own console session: **Connect Gmail** on the Agent, approve read-only
Gmail access for the chosen Google account, then **Deploy new version**.

## Check the result

Ask the Agent to run `test -n "$GOG_ACCESS_TOKEN" && echo set`, then a bounded
read such as `gog gmail search 'in:inbox' --max 1 --json`. Never ask it to print
the variable: OpenShell refuses model requests that carry the placeholder.

## Troubleshoot

- **The provider refused this Installation's OAuth client:** the client ID or
  secret is wrong, or the redirect URI does not match. Check the Google client, or
  choose **Rotate client secret** on the template.
- **The consent response did not match a connection you started:** the consent
  page opened in a browser without the session that started the connection.
  Start again from the signed-in tab.
- **The Agent shows Reconnect required:** Google revoked or expired the grant,
  such as a seven-day Testing-mode token. Choose **Reconnect**, then deploy.
- **Other reasons:** see
  [callback failures](../../reference/connection-templates.md#callback-failures).

To remove access, [disconnect](../console/agent-connections.md#reconnect-or-disconnect)
the account. Revoking the app in the Google account also stops refresh.
