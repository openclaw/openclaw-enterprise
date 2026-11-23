# Connection templates and OAuth clients

Installation administrators can create a Connection Template for the Installation or one Namespace. A template defines allowed destinations for static Bearer authentication or settings for OAuth authentication. Open **Credentials → Connection templates** to create, view, edit, or delete either kind.

For OAuth, open **Credentials → Connection templates** in Console. Choose **Create connection template** and set **Template availability** to the whole Installation or a particular Namespace. Select a compatible OAuth client or choose **Create template and register OAuth client**. An OAuth registration inherits the selected template’s availability, issuer, token URL and optional revocation URL. A Namespace template can use an Installation client or a client in the same Namespace.

Saving a template does not associate it with a Credential Source or deliver a Model or Plugin credential. See [credential implementation status](credential-sources.md#implementation-status) for the remaining work.

## Register a client

OCC owns OAuth client registrations. It stores confidential client secrets through the Installation’s selected Secret Driver. The Helm chart gives OCC a private Kubernetes namespace for these secrets. A public client needs only its provider-issued client ID. OAuth client registration is independent of credential delivery.

Use `POST /oauth-clients` with the selected `connectionTemplateId` and `connectionTemplateVersion`, a name, the provider-issued client ID and the authentication method registered for that client ID. For an MCP template, OCE offers the methods it implements that the authorization server advertises. If the server omits the list, use `client_secret_basic`. A public client uses `none`. Confidential clients use `client_secret_basic` or `client_secret_post` and require a write-only client secret. The API rejects `private_key_jwt`; this integration supports client secrets and public clients. Register the callback URI returned in the response metadata with the provider.

Open **Credentials → OAuth clients → Register OAuth client**. Select a saved template or choose **Create connection template**. The editor can discover an MCP server or accept manual settings. Saving a new template returns you to the registration. Register the displayed redirect URI with the provider, then enter the client details it issued. Choose the **Client type** registered at the provider. For **Public**, OCE sets **Token endpoint authentication method** to `none`. For **Confidential**, select the registered method and enter the secret. The first registration becomes the default for a template without a client. When a template already has a default, edit it to select a different registration.

List clients with `GET /oauth-clients`. Use `POST /oauth-clients/{oauthClientId}/rotate-secret` to replace the current secret. OCC replaces the secret at the same private reference. New code exchanges and later refreshes for existing accounts use the current secret. If the response is lost, retry with the same secret. To remove a registration, select the trash icon beside it in **Credentials → OAuth clients** or use `DELETE /oauth-clients/{oauthClientId}`. A template version that still references the client blocks deletion, including an older version of a template.

When starting consent for an MCP template, send the nonempty `selectedScopes` the account owner chose. The choice must come from the saved version and include each scope in its resource challenge. Configured manual OAuth uses its fixed scopes. OCC keeps the selection with the private attempt and records it with the resulting grant.

## Create a template

In **Credentials → Connection templates → Create connection template**, **Template availability** starts with the current readable Namespace. If there is none, choose availability before registering a client or saving the template. Choose **Installation-wide** to share the template across Namespaces. The authentication method (**Static Bearer** or **OAuth**) and availability are fixed after creation. Create a new template to change either.

For a static Bearer template, set **Authentication method** to **Static Bearer**. Enter the **Template name**, choose availability, and add each allowed HTTP **Method**, **Host**, **Port**, and **Path** under **API destinations**. A terminal `/**` includes the path subtree. Choose **Create template**. The catalog shows the authentication method and current version. Choose **Edit** to rename the template or change destinations, then choose **Save changes**. A rename keeps the current version; changing destinations creates a new version. Static templates do not use OAuth clients.

Each Installation starts with a **Google OAuth** template and no registered client. Choose **Edit Google OAuth** and expand **API destinations** to review the Google Workspace plugin’s default hosts, ports and paths. For example, Calendar and Drive both use `www.googleapis.com:443`, with paths `/calendar/**` and `/drive/**`. Save edits to change these destinations or set a scope limit. Google connections request offline access for refresh after consent.

A new OAuth template starts with **No template limit** (`scopes: []`). Select **Limit to approved scopes** to restrict which scopes callers may request. There is no scope-count limit. Required MCP scopes still apply at consent.

Use `POST /connection-templates` with one of these setup methods.

- With `mode: static_bearer`, supply 1 to 128 allowed HTTP destinations. Each row must contain an exact DNS host or private IPv4 address, port, path and uppercase HTTP method, for example `{"host":"service.example.test","port":443,"path":"/reports/**","method":"GET"}`. Use an absolute exact path or a terminal `/**` subtree. Dot segments and other wildcard forms are rejected. The mode specifies Bearer authentication. The template stores no credential material and needs no OAuth client.
- With `mode: manual`, supply the issuer, OAuth URLs, scopes and a nonempty `destinations` array. Each object has a host, port and path, for example `{"host":"mail.example.test","port":443,"path":"/inbox/**"}`. Each row describes an allowed destination. Agent delivery of saved OAuth credentials is not yet supported.
- With `mode: mcp_discovery`, preview metadata with `POST /connection-templates/discover`. Send the MCP server URL. When the resource advertises several issuers, select one and repeat discovery. The response includes the protected resource, advertised capabilities and scopes. Choose the scopes allowed for this template. OCC repeats discovery when saving and pins the selected issuer, resource and exact MCP server URL. Discovery can report a registration endpoint. Register the client separately.

Use `GET /connection-templates` to list templates and `GET /connection-templates/{connectionTemplateId}` to read one. Use `PATCH /connection-templates/{connectionTemplateId}` with the full configuration to change settings. A change creates an immutable version; changing only `displayName` renames the template without creating a version. Use `DELETE /connection-templates/{connectionTemplateId}` to remove it. These operations require Installation administration.

To remove a template in Console, select its trash icon, check the name and availability, then choose **Delete connection template**. An OAuth template may be saved before a client exists. Associate a compatible `oauthClientId` before using it for consent. Deleting an OAuth template leaves its OAuth client registered.

An OAuth Source keeps the Template version and client selected at consent. Updating a Template does not change that grant or deliver it to an Agent. To use a different issuer or switch between manual and MCP setup, connect again. An MCP grant remains tied to its consented server and protected resource.

Changing the template’s default OAuth client applies to future connections. Existing grants continue to refresh with their original registration and its current secret.

See the [API reference](api.md#connections) for request and response fields.

## Connect an account

OCC handles browser consent and the callback. After the code exchange, the selected TokenService creates an OAuth CredentialSource and takes custody of the grant. It renews the grant with the original client registration. Agent attachment and delivery of OAuth Sources remain pending.

1. Use a signed-in browser session. List available templates at
   `GET /namespaces/{namespaceId}/connection-templates`. OCC requires
   `credential_source:create` for that Namespace. The list can include static
   Bearer templates. For OAuth consent, select a template whose `current.mode`
   is `manual` or `mcp_discovery`. OAuth templates appear only when their current
   version has an OAuth client.
2. Send the chosen `connectionTemplateId` to
   `POST /namespaces/{namespaceId}/connections`. For a template with no configured scope list, supply optional `selectedScopes` or omit them to use provider defaults. A manual template with configured scopes uses the full list. For MCP, include every scope required by the resource and stay within any configured list. Open the returned
   `authorizationUrl` in the same browser and approve the request. The response does not contain a Source ID: no Source exists until the callback completes.
   Register the public OCC callback URL ending in `/oauth/callback` with the provider.
3. After the redirect, find the OAuth Source with
   `GET /namespaces/{namespaceId}/credential-sources`. The list requires Namespace read and includes only Sources the caller can read. Use its ID with `GET /namespaces/{namespaceId}/credential-sources/{credentialSourceId}` to inspect all nonsecret OAuth metadata with exact Source read. The Source records the original consent version, client, principal, and requested and granted scopes. TokenService keeps the tokens private and uses the original consent settings for renewal.

The native Namespace role API currently rejects `create` permissions. Installation
administrators can connect with the built-in administrator role. See
[Namespace role limits](../guides/topics/iam.md#let-a-person-run-an-existing-agent).

A pending request expires after ten minutes. Restart consent if it expires,
the provider denies it, or the browser session changes. The server handles each
code once. If the provider rejects the client secret, an administrator can correct it and
the Token Service retries the same grant. If the provider rejects the user’s
refresh grant, the user reconnects.

Use `DELETE /namespaces/{namespaceId}/credential-sources/{credentialSourceId}` to disconnect the OAuth Source. Its owner needs exact Source read and operate permission; another caller needs Source delete permission. OCC records the request before TokenService retires the grant, and the worker can finish a pending revocation.
