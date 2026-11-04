# OAuth connection templates and clients

Installation administrators can publish a connection template for the Installation or one Namespace. They can also register an OAuth client in either scope. The administrator who configures the client must approve its exact issuer, token URL and optional revocation URL. A Namespace template can use an Installation client or a client in the same Namespace.

## Register a client

Use `POST /oauth-clients` to register a provider client ID and its token endpoint authentication method. A public client uses `none`. Confidential clients use `client_secret_basic` or `client_secret_post` and require a write-only client secret. The selected Refresh Driver stores each confidential secret. OCC records the owning Driver ID and its private handle so that rotation uses the same store. The API rejects `private_key_jwt`; this integration supports client secrets and public clients. Register the callback URI returned in the response metadata with the provider.

List clients with `GET /oauth-clients`. Use `POST /oauth-clients/{oauthClientId}/rotate-secret` to stage a new secret. OCC switches to the new secret when the database commits the change and its audit. The worker retries retirement of the old secret. Use `DELETE /oauth-clients/{oauthClientId}` after deleting the templates whose versions reference the client.

When starting consent for an MCP template, send the nonempty `selectedScopes` the account owner chose. The choice must come from the approved version and include each scope in its resource challenge. Configured manual OAuth uses its fixed scopes. OCC keeps the selection with the private attempt and records it with the resulting grant.

## Create a template

Use `POST /connection-templates` with one of these setup methods.

- With `mode: manual`, supply the issuer, OAuth URLs, approved scopes, and the permitted API recipient's host, port, path and access. For example, an authorization server at `accounts.example.test` may issue credentials for `mail.example.test`.
- With `mode: mcp_discovery`, preview metadata with `POST /connection-templates/discover`. Send the MCP server URL. When the resource advertises several issuers, select one and repeat discovery. The response includes the protected resource, advertised capabilities and scopes. Choose the scopes allowed for this template. OCC repeats discovery when saving and pins the approved issuer, resource and exact MCP server URL. Discovery can report a registration endpoint. Register the client separately.

A template may be saved before a client exists. Associate a compatible `oauthClientId` before using it for consent. Use `PATCH /connection-templates/{connectionTemplateId}` with the full configuration to change its approved values. This creates an immutable version. Changing only `displayName` renames the template. Deleting a template leaves its independently managed client available.

See the [API reference](api.md#connections) for request and response fields.

## Connect an account

1. Use a signed-in browser session. List available templates at
   `GET /namespaces/{namespaceId}/connection-templates`. OCC requires
   `credential_source:create` for that Namespace.
2. Send the chosen `connectionTemplateId` to
   `POST /namespaces/{namespaceId}/connections`. Open the returned
   `authorizationUrl` in the same browser and approve the requested scopes.
   Register the public OCC callback URL ending in `/oauth/callback` with the provider.
3. After the redirect, look up the saved account with
   `GET /namespaces/{namespaceId}/connections`. Other users see it only if
   they have permission to read the source. Keep the credential source ID to
   refer to the account. The response names the selected OAuth client, issuer,
   recipient, and requested and granted scopes. MCP accounts also record the
   approved server URL and protected resource. The Token Service keeps the tokens
   and uses the pinned client method and protected resource when it renews them.

The native Namespace role API currently rejects `create` permissions. Installation
administrators can connect with the built-in administrator role. See
[Namespace role limits](../guides/topics/iam.md#let-a-person-run-an-existing-agent).

A pending request expires after ten minutes. Restart consent if it expires,
the provider denies it, or the browser session changes. The server handles each
code once. A connection requires renewed consent if the provider rejects its
refresh grant.

Use `DELETE /namespaces/{namespaceId}/connections/{credentialSourceId}` to
disconnect the account. OCC records the request before retiring the credential
and the worker can finish an interrupted disconnect.
