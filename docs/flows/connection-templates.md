# How OCC saves an OAuth connection template

The controller checks the caller's Installation `administer` permission. For a
Namespace-scoped template it also checks the Namespace. The selected Credential
Gateway validates the proposed destination before OCC accepts the settings.

OCC looks up the client registration by scope, issuer, and client ID. When it
needs a new registration, the selected Refresh Driver stores the client secret
in its operator Workspace. OCC saves the registration reference, template
version, and success audit in PostgreSQL. After a confirmed rollback OCC asks
the Driver to remove the staged client. If the commit acknowledgment is lost,
OCC keeps the client because a saved version may reference it.

See [OAuth connection templates](../reference/connection-templates.md) for the
administrative operations.
