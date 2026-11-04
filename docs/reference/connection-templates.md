# OAuth connection templates

An Installation administrator can save the OAuth settings that people will use
to connect their accounts. A template applies throughout the Installation or to
one Namespace. It defines the provider, client ID, scopes and destination that
an administrator has approved. People who can create credentials in a Namespace can use templates available there.

## Configure a template

Select the OpenShell Credential Gateway and Credential Refresh Drivers. Configure
the Refresh Driver's `clientWorkspace` to name an operator-controlled OpenShell
Workspace for client registrations. Keep it separate from Agent workspaces.

Use `POST /connection-templates` with Installation `administer` permission.
Include `namespaceId` for a Namespace template. Omit it for an Installation-wide
template. Scope is fixed at creation. The request includes the HTTPS issuer,
authorization URL, token URL, client ID, approved scopes, environment variable,
and allowed destination. The gateway must support the destination and access
settings. Supply the client secret when registering a new confidential client.

Use valid HTTPS URLs without userinfo or fragments. Only the authorization URL
may include a query. In `authorizationParameters`, use provider options such as
`prompt`. OCC refuses `response_type`, `client_id`, `redirect_uri`, `scope`,
`state`, `code_challenge`, and `code_challenge_method` because the OAuth flow sets them.

The response contains the template ID, its current version and the client
registration ID. The Refresh Driver holds the client secret. Two templates
share a registration only when their scope, issuer, and client ID match.

## Manage versions and registrations

- List templates with `GET /connection-templates` or read one with
  `GET /connection-templates/{connectionTemplateId}`.
- Use `PATCH /connection-templates/{connectionTemplateId}` to rename the
  template or edit its approved settings. Edits to approved settings create a
  version. A rename keeps the current version.
- Use `POST /connection-templates/{connectionTemplateId}/rotate-client-secret`
  to replace the secret for its current registration. Rotation affects each
  template sharing that registration.
- Use `DELETE /connection-templates/{connectionTemplateId}` to remove the
  template. When its last reference goes away, OCC asks the Refresh Driver to
  remove the registration.

For request and response examples, see the [API reference](api.md#connections).

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
   refer to the account. The Token Service keeps the tokens.

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

## Give an Agent access

With permission to update the Agent and operate the saved source, use
`POST /namespaces/{namespaceId}/agents/{agentId}/connections/{credentialSourceId}`.
The account stays in its Namespace and its owner can grant other Agents access.

To withdraw access, clear any plugin or Harness binding that uses the source,
then use `DELETE /namespaces/{namespaceId}/agents/{agentId}/connections/{credentialSourceId}`.
The worker removes access from deployed revisions. Other Agents retain their grants.
For an empty Google Workspace slot, the Console can also [connect and attach
an account](../guides/topics/plugins-configure.md#use-the-console) in one visit.
