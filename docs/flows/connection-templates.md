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

## Consent and token custody

OCC checks the caller's right to create a credential in the destination
Namespace and pins the selected template version. It creates a pending source
and saves the PKCE verifier in a private database row bound to that browser
session and principal. The callback consumes the attempt once, rechecks
authorization, and reads the client registration and exchange URL from the
pinned version.

The Credential Refresh Driver exchanges the code and hands the first access
token and reusable grant to the Token Service. The Secret Driver stores the
private material. OCC records its internal reference, the account owner and the
approved version. A shared callback verifies the issuer when multiple issuers
are registered. A provider timeout cannot replay a consumed code.

The worker renews the account through the Token Service. A conditional write
fences concurrent rotations and disconnects. OpenShell receives an expiring
access token for the approved destination. The account owner receives permission
to use the saved credential source.

See [OAuth connection templates](../reference/connection-templates.md) for the
administrative operations.
