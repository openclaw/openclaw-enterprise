# OAuth connection templates and clients

Installation administrators can publish a connection template for the Installation or one Namespace. They can also register an OAuth client in either scope. A registration inherits the selected template’s availability, issuer, token URL and optional revocation URL. A Namespace template can use an Installation client or a client in the same Namespace.

In Console, open **Credentials → Connection templates**. Choose **Create connection template** and set **Template availability** to the whole Installation or a particular Namespace. Select a compatible OAuth client or choose **Create template and register OAuth client**.

## Register a client

If you use the OpenShell Refresh Driver for confidential clients, first provision an operator-only OpenShell Workspace and set the Driver’s `clientWorkspace` to its name. The Driver stores client secrets there. Agent sandboxes must not attach providers from this Workspace. If registration reports that the service is unavailable, check that the configured Workspace exists and the Driver can reach it.

Use `POST /oauth-clients` with the selected `connectionTemplateId` and `connectionTemplateVersion`, a name, the provider-issued client ID and its authentication method. For an MCP template, choose a method advertised by the authorization server. When it omits this metadata, use `client_secret_basic`. A public client uses `none`. Confidential clients use `client_secret_basic` or `client_secret_post` and require a write-only client secret. The selected Refresh Driver stores each confidential secret. OCC records the owning Driver ID and its private handle so that rotation uses the same store. The API rejects `private_key_jwt`; this integration supports client secrets and public clients. Register the callback URI returned in the response metadata with the provider.

Open **Credentials → OAuth clients → Register OAuth client**. Select a saved template or choose **Create connection template**. The editor can discover an MCP server or accept manual settings. Saving a new template returns you to the registration. Register the displayed redirect URI with the provider, then enter the client details it issued. The first registration becomes the default for a template without a client. When a template already has a default, edit it to select a different registration.

List clients with `GET /oauth-clients`. Use `POST /oauth-clients/{oauthClientId}/rotate-secret` to replace the current secret. OCC replaces the secret at the same private reference. New code exchanges and later refreshes for existing accounts use the current secret. If the response is lost, retry with the same secret. Use `DELETE /oauth-clients/{oauthClientId}` after deleting the templates whose versions reference the client.

## Create a template

In **Credentials → Connection templates → Create connection template**, **Template availability** starts with the current readable Namespace. If there is none, choose availability before registering a client or saving the template. Choose **Installation-wide** to share the template across Namespaces. Availability is fixed after creation.

Each Installation starts with a **Google OAuth** template and no registered client. Choose **Edit Google OAuth** and expand **API destinations** to review the Google Workspace plugin’s default hosts, ports and paths. For example, Calendar and Drive both use `www.googleapis.com:443`, with paths `/calendar/**` and `/drive/**`. Save edits to change these destinations or set a scope limit. Google connections request offline access for refresh after consent.

A new template starts with **No template limit** (`scopes: []`). Select **Limit to approved scopes** to restrict which scopes callers may request. There is no scope-count limit. Required MCP scopes still apply at consent.

Use `POST /connection-templates` with one of these setup methods.

- With `mode: manual`, supply the issuer, OAuth URLs, scopes and a nonempty `destinations` array. Each object has a host, port and path, for example `{"host":"mail.example.test","port":443,"path":"/inbox/**"}`. A credentialed request must match all three in one row. The plugin and deployed request policy determine the allowed operations.
- With `mode: mcp_discovery`, preview metadata with `POST /connection-templates/discover`. Send the MCP server URL. When the resource advertises several issuers, select one and repeat discovery. The response includes the protected resource, advertised capabilities and scopes. Choose the scopes allowed for this template. OCC repeats discovery when saving and pins the approved issuer, resource and exact MCP server URL. Discovery can report a registration endpoint. Register the client separately.

A template may be saved before a client exists. Associate a compatible `oauthClientId` before using it for consent. Use `PATCH /connection-templates/{connectionTemplateId}` with the full configuration to change its approved values. This creates an immutable version. Changing only `displayName` renames the template. Deleting a template leaves its independently managed client available.

Existing accounts use the current manual destinations for their template and issuer. Adding a host can send existing accounts’ access tokens there for requests their plugin and Agent policy permit. Running Agents apply changes when their senders reconcile. To use a different issuer or switch between manual and MCP setup, connect the account again. An MCP account also retains its exact server and protected resource.

Changing the template’s default OAuth client applies to future connections. Existing grants continue to refresh with their original registration and its current secret.

See the [API reference](api.md#connections) for request and response fields.
