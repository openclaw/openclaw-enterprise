# OAuth connection templates and clients

Installation administrators can publish a connection template for the Installation or one Namespace. They can also register an OAuth client in either scope. A registration inherits the selected template’s availability, issuer, token URL and optional revocation URL. A Namespace template can use an Installation client or a client in the same Namespace.

In Console, open **Credentials → Connection templates**. Choose **Create connection template** and set **Template availability** to the whole Installation or a particular Namespace. Select a compatible OAuth client or choose **Create template and register OAuth client**.

## Register a client

Use `POST /oauth-clients` with the selected `connectionTemplateId` and `connectionTemplateVersion`, a name, the provider-issued client ID and its authentication method. For an MCP template, choose a method advertised by the authorization server. When it omits this metadata, use `client_secret_basic`. A public client uses `none`. Confidential clients use `client_secret_basic` or `client_secret_post` and require a write-only client secret. The selected Refresh Driver stores each confidential secret. OCC records the owning Driver ID and its private handle so that rotation uses the same store. The API rejects `private_key_jwt`; this integration supports client secrets and public clients. Register the callback URI returned in the response metadata with the provider.

Open **Credentials → OAuth clients → Register OAuth client**. Under **Connection template**, select a saved template or create one. Saving a new template returns you to the registration. Register the displayed redirect URI with the provider, then enter the client details it issued. The first registration becomes the default for a template without a client. When a template already has a default, edit it to select a different registration.

List clients with `GET /oauth-clients`. Use `POST /oauth-clients/{oauthClientId}/rotate-secret` to replace the current secret. OCC replaces the secret at the same private reference. New code exchanges and later refreshes for existing accounts use the current secret. If the response is lost, retry with the same secret. Use `DELETE /oauth-clients/{oauthClientId}` after deleting the templates whose versions reference the client.

## Create a template

In **Credentials → Connection templates → Create connection template**, **Template availability** starts with the current readable Namespace. If there is none, choose availability before registering a client or saving the template. Choose **Installation-wide** to share the template across Namespaces. Availability is fixed after creation.

Choose **Set up Google OAuth** to start with Google’s published issuer and OAuth endpoints. The starter selects **Google APIs**, so one account can be used across Google APIs. Choose the scope limit and your registered Google client. Select **Specific endpoint** if you want to limit the template to one API host and path. Saving creates a template with the availability you selected. Google connections request offline access so the Token Service can refresh the account after consent.

A new template starts with **Limit to approved scopes**. Enter the scopes callers may request, or select **No template limit**. In the API, `scopes: []` selects the latter. There is no scope-count limit. Required MCP scopes still apply at consent.

Use `POST /connection-templates` with one of these setup methods.

- With `mode: manual`, supply the issuer, OAuth URLs, approved scopes, and a recipient. Supply its exact host, port and path, or use `{"kind":"google_apis"}` with Google’s published issuer and OAuth endpoints. The plugin and deployed request policy control operations at that destination. For example, an authorization server at `accounts.example.test` may issue credentials for `mail.example.test`.
- With `mode: mcp_discovery`, preview metadata with `POST /connection-templates/discover`. Send the MCP server URL. When the resource advertises several issuers, select one and repeat discovery. The response includes the protected resource, advertised capabilities and scopes. Choose the scopes allowed for this template. OCC repeats discovery when saving and pins the approved issuer, resource and exact MCP server URL. Discovery can report a registration endpoint. Register the client separately.

A template may be saved before a client exists. Associate a compatible `oauthClientId` before using it for consent. Use `PATCH /connection-templates/{connectionTemplateId}` with the full configuration to change its approved values. This creates an immutable version. Changing only `displayName` renames the template. Deleting a template leaves its independently managed client available.

See the [API reference](api.md#connections) for request and response fields.
