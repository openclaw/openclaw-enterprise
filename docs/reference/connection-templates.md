# OAuth connection templates and clients

Installation administrators can publish a connection template for the Installation or one Namespace. They can also register an OAuth client in either scope. A registration inherits the selected template’s availability, issuer, token URL and optional revocation URL. A Namespace template can use an Installation client or a client in the same Namespace.

In Console, open **Credentials → Connection templates**. Choose **Create connection template** and set **Template availability** to the whole Installation or a particular Namespace. Select a compatible OAuth client or choose **Create template and register OAuth client**.

## Register a client

OCC owns OAuth client registrations. It stores confidential client secrets through the Installation’s selected Secret Driver. The Helm chart gives OCC a private Kubernetes namespace for these secrets. A public client needs only its provider-issued client ID. You can register either kind before configuring a Credential Gateway or Token Service.

Use `POST /oauth-clients` with the selected `connectionTemplateId` and `connectionTemplateVersion`, a name, the provider-issued client ID and the authentication method registered for that client ID. For an MCP template, OCE offers the methods it implements that the authorization server advertises. If the server omits the list, use `client_secret_basic`. A public client uses `none`. Confidential clients use `client_secret_basic` or `client_secret_post` and require a write-only client secret. The API rejects `private_key_jwt`; this integration supports client secrets and public clients. Register the callback URI returned in the response metadata with the provider.

Open **Credentials → OAuth clients → Register OAuth client**. Select a saved template or choose **Create connection template**. The editor can discover an MCP server or accept manual settings. Saving a new template returns you to the registration. Register the displayed redirect URI with the provider, then enter the client details it issued. Choose the **Client type** registered at the provider. For **Public**, OCE sets **Token endpoint authentication method** to `none`. For **Confidential**, select the registered method and enter the secret. The first registration becomes the default for a template without a client. When a template already has a default, edit it to select a different registration.

List clients with `GET /oauth-clients`. Use `POST /oauth-clients/{oauthClientId}/rotate-secret` to replace the current secret. OCC replaces the secret at the same private reference. New code exchanges and later refreshes for existing accounts use the current secret. If the response is lost, retry with the same secret. To remove a registration, select the trash icon beside it in **Credentials → OAuth clients** or use `DELETE /oauth-clients/{oauthClientId}`. A template version that still references the client blocks deletion, including an older version of a template.

MCP consent uses the scopes the account owner selects. Include all scopes required by the resource challenge. If the template limits scopes, choose at least one from its approved list. Without a limit or required scopes, the request can use provider defaults. Configured manual OAuth uses its fixed scopes. OCC keeps the selection with the private attempt. OCC saves the account with separate requested and granted lists even when the provider approves fewer, more or different scopes. If the provider omits `scope`, OCC uses the requested list. An explicit empty `scope` records zero grants. Token Service uses the last granted set when renewing. OCC accepts Slack’s comma-separated scope format at its MCP user-token endpoint.

An Agent’s plugin policy still applies to its requests. Slack MCP checks selected tool names. The Google request guard considers the provider’s actual scopes on allowed routes. For example, a grant that includes Gmail send can make sending eligible on an approved Gmail route even if this consent request listed only read scopes. [Google request guard](../guides/credential-proxy.md#enable-google-workspace-requests-from-a-dedicated-worker).

## Create a template

In **Credentials → Connection templates → Create connection template**, **Template availability** starts with the current readable Namespace. If there is none, choose availability before registering a client or saving the template. Choose **Installation-wide** to share the template across Namespaces. Availability is fixed after creation.

Each Installation starts with a **Google OAuth** template and no registered client. Choose **Edit Google OAuth** and expand **API destinations** to review the Google Workspace plugin’s default hosts, ports and paths. For example, Calendar and Drive both use `www.googleapis.com:443`, with paths `/calendar/**` and `/drive/**`. Save edits to change these destinations or set a scope limit. Google connections request offline access for refresh after consent.

A new template starts with **No template limit** (`scopes: []`). Select **Limit to approved scopes** to restrict which scopes callers may request. There is no scope-count limit. Required MCP scopes still apply at consent.

Use `POST /connection-templates` with one of these setup methods.

- With `mode: manual`, supply the issuer, OAuth URLs, scopes and a nonempty `destinations` array. Each object has a host, port and path, for example `{"host":"mail.example.test","port":443,"path":"/inbox/**"}`. A credentialed request must match all three in one row. The plugin and deployed request policy determine the allowed operations.
- With `mode: mcp_discovery`, preview metadata with `POST /connection-templates/discover`. Send the MCP server URL. When the resource advertises several issuers, select one and repeat discovery. The response includes the protected resource, advertised capabilities and scopes. Choose the scopes allowed for this template. OCC repeats discovery when saving and pins the approved issuer, resource and exact MCP server URL. Discovery can report a registration endpoint. Register the client separately.

A template may be saved before a client exists. Associate a compatible `oauthClientId` before using it for consent. Use `PATCH /connection-templates/{connectionTemplateId}` with the full configuration to change its approved values. This creates an immutable version. Changing only `displayName` renames the template. To remove a template, select the trash icon beside it in **Credentials → Connection templates**. Check its name and availability, then choose **Delete connection template**. Its OAuth client stays registered.

Existing accounts use the current manual destinations for their template and issuer. Adding a host can send existing accounts’ access tokens there for requests their plugin and Agent policy permit. Running Agents apply changes when their senders reconcile. To use a different issuer or switch between manual and MCP setup, connect the account again. An MCP account also retains its exact server and protected resource.

Changing the template’s default OAuth client applies to future connections. Existing grants continue to refresh with their original registration and its current secret.

See the [API reference](api.md#connections) for request and response fields.

## Connect an account

OCC handles browser consent and the callback. After exchange, OCC registers the grant with the Token Service. It returns a stable account reference and renews the access token using the original client registration. Users can connect an account before an administrator configures a Credential Gateway for Agent delivery.

1. Use a signed-in browser session. List available templates at
   `GET /namespaces/{namespaceId}/connection-templates`. OCC requires
   `credential_source:create` for that Namespace. A template appears here once
   its current version has an OAuth client.
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

In the Agent's plugin settings, select an account for each named slot. The picker shows accounts you can use from an issuer that the slot accepts. **Authorize for this server** starts consent for the required protected resource and destination. For an MCP template, the dialog initially selects its configured scopes. If the template has no scope limit, it selects the advertised scopes and accepts additional scope names. The user can clear optional scopes before consent. The provider and the plugin's request policy enforce operations.

A slot offers consent through templates that match its issuer and destination and have a registered OAuth client. When no template is ready, the plugin picker lets an Installation administrator finish a matching template or create one for that slot. The template editor controls availability and client registration.

On the Create Agent form, consent saves the account for the user. The form holds its credential source ID for the selected release and slot. OCC checks the caller, account and slot again when it creates the Agent, then commits the Agent, slot binding and use grant together. Provisioning applies that grant when its worker creates the Agent. Leaving the form keeps the account available to its owner.

Updating a saved Agent requires permission to update that Agent and operate the saved credential. A completed connection from a plugin can replace that slot when its release and previous selection still match. The account remains available to its owner when the slot changes during consent. See [configure plugins](../guides/topics/plugins-configure.md#use-the-console).

To detach a saved account, clear the plugin slots that use it on that Agent. Then call `DELETE /namespaces/{namespaceId}/agents/{agentId}/connections/{credentialSourceId}`. OCC removes that Agent’s grant. Other Agents can still use their own grants.

A person with permission to use a saved MCP account can **Load tools** before creating an Agent. On a saved Agent, its editor can also use the Agent’s existing grant to discover tools. To use a saved account from a dedicated OpenClaw worker, select an OpenShell Credential Proxy and a supervisor that supports the [saved-account request contract](drivers/credential-proxy.md#saved-oauth-accounts). OCC checks the deployed slot and the Agent’s current grant on each request. The Token Service supplies the current access token, and the supervisor injects it for that send. Stock OpenShell v0.1.7 supports saved-account delivery with the pre-credentials middleware and runtime token grant configured. A fresh protected OpenAI model source requires a separate sender capability. Current admission also refuses a protected inference plan on the same revision as a saved plugin account. See [protected static inference](credential-sources/protected-inference.md).
