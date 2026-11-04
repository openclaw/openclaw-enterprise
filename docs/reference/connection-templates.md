# OAuth connection templates

An Installation administrator can save the OAuth settings that people will use
to connect their accounts. A template applies throughout the Installation or to
one Namespace. It defines the provider, client ID, scopes and destination that
an administrator has approved. Saving a template does not start provider consent.

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
