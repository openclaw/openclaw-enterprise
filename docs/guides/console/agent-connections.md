# Connect your account to a personal Agent

Connect your own account, such as Gmail, so the Agent's tools can call that
provider as you. An Installation administrator first creates a connection
template and lets you use it. See
[Agent OAuth connections](../../reference/connection-templates.md) for the exact
permissions, personal-Agent rules, and callback failures.

Connecting makes the Agent **personal**: only you can deploy and use it. OCC
refuses sharing, Slack and other channels, and plugin approvers until the
connected account is removed from every version that holds it.

## Create a connection template

You need Installation administration.

1. Open **Settings**. The **Connection templates** card lists each template, its
   version, its OAuth client, and its **Redirect URI**.
2. Choose **New connection template**. For Google, choose
   **Fill in the Gmail example**, then enter the **Client ID** and
   **Client secret** of your Google client. The secret is write-only.
3. Choose **Create template**. Register the card's **Redirect URI** with the
   provider's OAuth client exactly as shown.
4. Under the template, choose **Namespace** or **Person (principal ID)**, select
   who may connect, and choose **Grant use**.

**Edit** creates a new version when anything except the name changes; existing
connections keep the version their owner approved. **Rotate client secret**
affects new and refreshed connections only. **Delete** is refused while any
connection uses the template.

## Connect an account

You need `read` and `update` on the Agent and `use` on the template. Nobody else
can have grants on the Agent, and its Configuration cannot enable channels.

1. On **Create Agent**, select the account under **Connections**, or open an
   existing Agent. After Create Agent, the Agent page opens the consent warning
   for the selected account.
2. On the Agent page, under **Connections**, choose **Connect** with the account
   name. Read the consent warning: the provider, the access you approve, and the
   one endpoint the Agent's tools can call.
3. Choose **Continue** with the provider name. Approve access in the provider
   window. When the browser blocks popups, the provider page opens in this tab
   and returns to the Agent.
4. When **Connected** appears, choose **Deploy new version**. The running
   version receives the account only after this deployment.

The consent session expires after ten minutes. If it fails, the section shows
**Not connected** with the reason; choose **Connect** again.

## Reconnect or disconnect

A connected account stays signed in: the Credential Refresh Driver uses its
refresh token to replace expired access tokens. **Reconnect** appears only when
you must consent again.

- **Reconnect to apply changes** appears after an administrator edits the
  template. **Reconnect required** appears when the provider no longer accepts
  the grant. Reconnecting asks for consent again, replaces the old connection,
  and needs a new deployment.
- **Disconnect** removes the account from the Agent. A running version keeps it
  until OCC confirms withdrawal, and the row shows **Disconnecting**. When
  withdrawal finishes, choose **Finish disconnecting** to delete the stored
  account and end the personal restriction.

## Limits

- The console does not show which provider account you connected.
- A connection made in another browser tab or device appears after you refresh.
- Reconnecting disconnects the old account only after the new one connects. If
  that disconnect fails, both appear; disconnect the older one.
