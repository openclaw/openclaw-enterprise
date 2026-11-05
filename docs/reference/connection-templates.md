# OAuth connection templates and clients

Installation administrators can publish a connection template for the Installation or one Namespace. They can also register an OAuth client in either scope. A registration inherits the selected template’s availability, issuer, token URL and optional revocation URL. A Namespace template can use an Installation client or a client in the same Namespace.

In Console, open **Credentials → Connection templates**. Choose **Create connection template** and set **Template availability** to the whole Installation or a particular Namespace. Select a compatible OAuth client or choose **Create template and register OAuth client**.

## Register a client

If you use the OpenShell Refresh Driver for confidential clients, first provision an operator-only OpenShell Workspace and set the Driver’s `clientWorkspace` to its name. The Driver stores client secrets there. Agent sandboxes must not attach providers from this Workspace. If registration reports that the service is unavailable, check that the configured Workspace exists and the Driver can reach it.

Use `POST /oauth-clients` with the selected `connectionTemplateId` and `connectionTemplateVersion`, a name, the provider-issued client ID and its authentication method. For an MCP template, choose a method advertised by the authorization server. When it omits this metadata, use `client_secret_basic`. A public client uses `none`. Confidential clients use `client_secret_basic` or `client_secret_post` and require a write-only client secret. The selected Refresh Driver stores each confidential secret. OCC records the owning Driver ID and its private handle so that rotation uses the same store. The API rejects `private_key_jwt`; this integration supports client secrets and public clients. Register the callback URI returned in the response metadata with the provider.

Open **Credentials → OAuth clients → Register OAuth client**. Select a saved template or choose **Create connection template**. The editor can use Google OAuth settings, discover an MCP server, or accept manual settings. Saving a new template returns you to the registration. Register the displayed redirect URI with the provider, then enter the client details it issued. The first registration becomes the default for a template without a client. When a template already has a default, edit it to select a different registration.

List clients with `GET /oauth-clients`. Use `POST /oauth-clients/{oauthClientId}/rotate-secret` to replace the current secret. OCC replaces the secret at the same private reference. New code exchanges and later refreshes for existing accounts use the current secret. If the response is lost, retry with the same secret. Use `DELETE /oauth-clients/{oauthClientId}` after deleting the templates whose versions reference the client.

When starting consent for an MCP template, send the nonempty `selectedScopes` the account owner chose. The choice must come from the approved version and include each scope in its resource challenge. Configured manual OAuth uses its fixed scopes. OCC keeps the selection with the private attempt and records it with the resulting grant.

## Create a template

In **Credentials → Connection templates → Create connection template**, **Template availability** starts with the current readable Namespace. If there is none, choose availability before registering a client or saving the template. Choose **Installation-wide** to share the template across Namespaces. Availability is fixed after creation.

Choose **Set up Google OAuth** to fill in Google’s OAuth URLs and the API destinations from the Google Workspace plugin’s reviewed operations. Expand **API destinations** to review each host, port and path. For example, Calendar and Drive both use `www.googleapis.com:443`, with paths `/calendar/**` and `/drive/**`. Add or remove rows before saving. Choose your scope limit and registered client. Google connections request offline access for refresh after consent.

A new template starts with **No template limit** (`scopes: []`). Select **Limit to approved scopes** to restrict which scopes callers may request. There is no scope-count limit. Required MCP scopes still apply at consent.

Use `POST /connection-templates` with one of these setup methods.

- With `mode: manual`, supply the issuer, OAuth URLs, scopes and a nonempty `destinations` array. Each object has a host, port and path, for example `{"host":"mail.example.test","port":443,"path":"/inbox/**"}`. A credentialed request must match all three in one row. The plugin and deployed request policy determine the allowed operations.
- With `mode: mcp_discovery`, preview metadata with `POST /connection-templates/discover`. Send the MCP server URL. When the resource advertises several issuers, select one and repeat discovery. The response includes the protected resource, advertised capabilities and scopes. Choose the scopes allowed for this template. OCC repeats discovery when saving and pins the approved issuer, resource and exact MCP server URL. Discovery can report a registration endpoint. Register the client separately.

A template may be saved before a client exists. Associate a compatible `oauthClientId` before using it for consent. Use `PATCH /connection-templates/{connectionTemplateId}` with the full configuration to change its approved values. This creates an immutable version. Changing only `displayName` renames the template. Deleting a template leaves its independently managed client available.

Existing accounts use the current manual destinations for their template and issuer. Adding a host can send existing accounts’ access tokens there for requests their plugin and Agent policy permit. Running Agents apply changes when their senders reconcile. To use a different issuer or switch between manual and MCP setup, connect the account again. An MCP account also retains its exact server and protected resource.

Changing the template’s default OAuth client applies to future connections. Existing grants continue to refresh with their original registration and its current secret.

See the [API reference](api.md#connections) for request and response fields.

## Connect an account

1. Use a signed-in browser session. List available templates at
   `GET /namespaces/{namespaceId}/connection-templates`. OCC requires
   `credential_source:create` for that Namespace.
2. Send the chosen `connectionTemplateId` to
   `POST /namespaces/{namespaceId}/connections`. For a template with no configured scope list, supply optional `selectedScopes` or omit them to use provider defaults. A manual template with configured scopes uses the full list. For MCP, include every scope required by the resource and stay within any configured list. Open the returned
   `authorizationUrl` in the same browser and approve the request.
   Register the public OCC callback URL ending in `/oauth/callback` with the provider.
3. After the redirect, look up the saved account with
   `GET /namespaces/{namespaceId}/connections`. Other users see it only if
   they have permission to read the source. Keep the credential source ID to
   refer to the account. The response names the selected OAuth client, issuer,
   effective destinations, and requested and granted scopes. An empty destination list means the current template is unavailable or incompatible. MCP accounts also record the
   approved server URL and protected resource. The Token Service keeps the tokens
   and uses the pinned client method and protected resource when it renews them.

The native Namespace role API currently rejects `create` permissions. Installation
administrators can connect with the built-in administrator role. See
[Namespace role limits](../guides/topics/iam.md#let-a-person-run-an-existing-agent).

A pending request expires after ten minutes. Restart consent if it expires,
the provider denies it, or the browser session changes. The server handles each
code once. If the provider rejects the client secret, an administrator can correct it and
the Token Service retries the same grant. If the provider rejects the user’s
refresh grant, the user reconnects.

Use `DELETE /namespaces/{namespaceId}/connections/{credentialSourceId}` to
disconnect the account. OCC records the request before retiring the credential
and the worker can finish an interrupted disconnect.

## Use a saved account in an Agent plugin

In the Agent's plugin settings, select an account for each named slot. The picker shows accounts you can use from an issuer that the slot accepts. **Authorize for this server** starts consent for the required protected resource and destination. For an MCP template you select the scopes for this consent. The provider and the plugin's request policy enforce operations.

Saving the selection requires permission to update the Agent and operate the saved credential. A completed connection from a plugin can replace that slot when its release and previous selection still match. The account remains available to its owner when the slot changes during consent. See [configure plugins](../guides/topics/plugins-configure.md#use-the-console).

To withdraw a saved account, clear the bindings that use it and call `DELETE /namespaces/{namespaceId}/agents/{agentId}/connections/{credentialSourceId}`. OCC queues access removal from deployed revisions. Other Agents keep their own grants.

OpenShell gives a worker a reference for each credential when the process starts.
Changing the sender’s host, port or path invalidates that reference. After the
updated policy loads, a newly started worker can use the same account at its
current destinations. A process that kept the old reference needs to restart.
The account owner can keep the original OAuth grant.

For example, if an admin changes a Gmail template to allow only Calendar, a Gmail-only account stays attached but receives no token for Calendar. Other accounts on the Agent remain usable. Restoring a permitted Gmail destination lets OCE deliver the credential again.

For Google Workspace, include the packaged Google CLI in the Installation’s OpenShell `toolBinaries`. One saved account can serve multiple Google APIs. For example, to read Gmail and Calendar, the current template must allow both destinations, the account must have the necessary provider scopes, and the Agent policy must allow each operation. Public API discovery stays separate from credentialed requests. Every approved executable uses the same guarded Google routes. A metadata-only Gmail grant can read message metadata from the CLI or an approved script. Reading a full message requires the corresponding grant.
