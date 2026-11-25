# Connection templates and OAuth clients

Installation administrators can create a Connection Template for the Installation or one Namespace. A template defines allowed destinations for static Bearer authentication or settings for OAuth authentication. Open **Credentials → Connection templates** to create, view, edit, or delete either kind.

For OAuth, create a Template and register a compatible OAuth client. The account
owner selects both when starting consent. A Namespace can use an Installation
client or a client registered for that Namespace.

## Register a client

In **Credentials → Credential clients → Register client**, select **OAuth 2.0**.
Enter its availability, issuer, provider-issued client ID, and registered
authentication method. Register the displayed redirect URI with the provider.
The Template owns the OAuth endpoints; use an authentication method advertised
by the issuer. If metadata omits that list, use `client_secret_basic`.

A public client uses `none`. For `client_secret_basic` or `client_secret_post`,
enter the write-only secret. The selected TokenService keeps the private value.
An Installation administrator can register either Client kind for the Installation
or one Namespace. In the Console, choose **Availability**. With
`POST /credential-clients`, supply `kind: "oauth2"` or `kind: "github-app"` and the
fields for that kind. Include `namespaceId` for a Namespace Client. Omit it for
Installation-wide use. The registration keeps that scope through rotation.
`GET /credential-clients` lists registered Clients.

Use **Rotate OAuth client secret** or
`POST /credential-clients/{credentialClientId}/rotate` to replace the secret for the
same client ID. Include `kind: "oauth2"` and the write-only `clientSecret` in the API
request. Later code exchanges and renewals use the new value. Before
retrying an operation with an unknown outcome, refresh the list. A pending
consent attempt or a Source that uses the client blocks its removal.

For GitHub App registration, see the [repository access guide](../guides/repository-credentials.md#select-a-github-source-for-an-openshell-agent).

## Create a template

In **Credentials → Connection templates → Create connection template**, **Template availability** starts with the current readable Namespace. If there is none, choose availability before registering a client or saving the template. Choose **Installation-wide** to share the template across Namespaces. The authentication method (**Static Bearer** or **OAuth**) and availability are fixed after creation. Create a new template to change either.

For a static Bearer template, set **Authentication method** to **Static Bearer**. Enter the **Template name**, choose availability, and add each allowed HTTP **Method**, **Host**, **Port**, and **Path** under **API destinations**. A terminal `/**` includes the path subtree. Choose **Create template**. The catalog shows the authentication method and current version. Choose **Edit** to rename the template or change destinations, then choose **Save changes**. A rename keeps the current version; changing destinations creates a new version. Static templates do not use OAuth clients.

Each Installation starts with an unverified **Google OAuth** starter and no registered client. Open **Edit** and save the full configuration to verify its issuer before consent; bootstrap does not contact Google. Choose **Edit Google OAuth** and expand **API destinations** to review the Google Workspace plugin’s default hosts, ports and paths. For example, Calendar and Drive both use `www.googleapis.com:443`, with paths `/calendar/**` and `/drive/**`. Save edits to change these destinations or set a scope limit. Google connections request offline access for refresh after consent.

A new OAuth template starts with **No template limit** (`scopes: []`). Select **Limit to approved scopes** to restrict which scopes callers may request. The issuer can grant additional scopes; the Source records the actual grant. Refresh cannot add scopes. There is no scope-count limit. Required MCP scopes still apply at consent.

Use `POST /connection-templates` with one of these setup methods.

- With `mode: static_bearer`, supply 1 to 128 allowed HTTP destinations. Each row must contain an exact DNS host or private IPv4 address, port, path and uppercase HTTP method, for example `{"host":"service.example.test","port":443,"path":"/reports/**","method":"GET"}`. Use an absolute exact path or a terminal `/**` subtree. Dot segments and other wildcard forms are rejected. The mode specifies Bearer authentication. The template stores no credential material and needs no OAuth client.
- With `mode: manual`, supply the issuer, OAuth URLs, scopes and a nonempty `destinations` array. OCC verifies the URLs against authoritative HTTPS issuer metadata before approving the version; manual issuers without metadata are refused. Each object has a host, port and path, for example `{"host":"mail.example.test","port":443,"path":"/inbox/**"}`. Each row describes an allowed destination. Agent delivery of saved OAuth credentials is not yet supported.
- With `mode: mcp_discovery`, preview metadata with `POST /connection-templates/discover`. Send the MCP server URL. When the resource advertises several issuers, select one and repeat discovery. The response includes the protected resource, advertised capabilities and scopes. Choose the scopes allowed for this template. OCC repeats discovery when saving, verifies the issuer's exact endpoints, and pins the selected issuer, resource and exact MCP server URL. Discovery can report a registration endpoint. Register the client separately.

Use `GET /connection-templates` to list templates and `GET /connection-templates/{connectionTemplateId}` to read one. Use `PATCH /connection-templates/{connectionTemplateId}` with the full configuration to change settings. A change creates an immutable version; changing only `displayName` renames the template without creating a version. Use `DELETE /connection-templates/{connectionTemplateId}` to remove it. These operations require Installation administration.

To remove a template in Console, select its trash icon, check the name and availability, then choose **Delete connection template**. An OAuth template may be saved before a client exists. Deleting an OAuth template leaves its clients registered.

An OAuth Source keeps the Template version and client selected at consent. Updating a Template does not change that grant or deliver it to an Agent. To use a different issuer or switch between manual and MCP setup, connect again. An MCP grant remains tied to its consented server and protected resource.

See the [API reference](api.md#connections) for request and response fields.

## Connect an account

OCC handles browser consent and the callback. After the code exchange, the selected TokenService creates an OAuth CredentialSource and takes custody of the grant. It renews the grant with the original client registration. Eligible Plugin selections can use the OAuth Source at Agent admission without a separate attachment. Delivery through a running Plugin Agent remains unqualified.

1. Use a signed-in browser session. List available templates at
   `GET /namespaces/{namespaceId}/connection-templates`. OCC requires
   `credential_source:create` for that Namespace. The list can include static
   Bearer templates. For OAuth consent, select a template whose `current.mode`
   is `manual` or `mcp_discovery`.
2. List compatible clients with `GET /namespaces/{namespaceId}/connections/oauth-clients`
   and the `connectionTemplateId` query parameter. Send the chosen template and
   `oauthClientId` to `POST /namespaces/{namespaceId}/connections`. For a template with no configured scope list, supply optional `selectedScopes` or omit them to use provider defaults. A manual template with configured scopes uses the full list. For MCP, include every scope required by the resource and stay within any configured list. Open the returned
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

Disconnect the OAuth Source with the [Source DELETE operation](credential-sources.md#delete-a-source). OCC records the request and retires Proxy delivery copies before TokenService removes the grant.
