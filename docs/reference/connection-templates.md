# OAuth connection templates and clients

Installation administrators can publish a connection template for the Installation or one Namespace. They can also register an OAuth client in either scope. The administrator who configures the client must approve its exact issuer, token URL and optional revocation URL. A Namespace template can use an Installation client or a client in the same Namespace.

## Register a client

Use `POST /oauth-clients` to register a provider client ID and its token endpoint authentication method. A public client uses `none`. Confidential clients use `client_secret_basic` or `client_secret_post` and require a write-only client secret. The selected Refresh Driver stores each confidential secret. Register the callback URI returned in the response metadata with the provider.

List clients with `GET /oauth-clients`. Use `POST /oauth-clients/{oauthClientId}/rotate-secret` to stage a new secret. OCC switches to the new secret when the database commits the change and its audit. The worker retries retirement of the old secret. Use `DELETE /oauth-clients/{oauthClientId}` after deleting the templates whose versions reference the client.

## Create a template

Use `POST /connection-templates` with one of these setup methods.

- With `mode: manual`, supply the issuer, OAuth URLs, approved scopes, and the permitted API recipient's host, port, path and access. For example, an authorization server at `accounts.example.test` may issue credentials for `mail.example.test`.
- With `mode: mcp_discovery`, preview metadata with `POST /connection-templates/discover`. Send the MCP server URL. When the resource advertises several issuers, select one and repeat discovery. The response includes the protected resource, advertised capabilities and scopes. Choose the scopes allowed for this template. OCC repeats discovery when saving and pins the approved issuer, resource and exact MCP server URL. Discovery can report a registration endpoint. Register the client separately.

A template may be saved before a client exists. Associate a compatible `oauthClientId` before using it for consent. Use `PATCH /connection-templates/{connectionTemplateId}` with the full configuration to change its approved values. This creates an immutable version. Changing only `displayName` renames the template. Deleting a template leaves its independently managed client available.

See the [API reference](api.md#connections) for request and response fields.
