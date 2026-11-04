# How OCC saves an OAuth connection template

The administrator selects manual configuration or supplies an MCP server URL. OCC checks Installation administration before discovery. For MCP, the controller reads protected resource metadata over TLS, resolves each metadata host to public addresses and pins those addresses for the request. It contacts only the selected advertised authorization server. OCC stores the metadata it observed with the approved version.

OCC checks scope and the client's allowed destinations before it references an OAuth client. PostgreSQL commits the template version and its audit together. A template can exist without a client. The Agent plugin release determines the local credential placeholder when the account is used.

When an administrator creates or rotates a confidential client, OCC reserves a new private handle in its cleanup queue before the Refresh Driver stages the secret. The writer locks that reservation while it stores the secret. OCC commits the active handle and its audit, removes the reservation, and queues the previous handle in one transaction. If a writer stops before commit, the worker can remove the abandoned secret once its reservation is due. The worker retries removal through the Driver. The public OAuth client ID stays stable across rotation.

See [OAuth connection templates and clients](../reference/connection-templates.md) for the supported operations.

## Consent and token custody

OCC checks the caller's right to create a credential in the destination
Namespace and pins the selected template version. It creates a pending source
and saves the PKCE verifier in a private database row bound to that browser
session and principal. The callback consumes the attempt once, rechecks
authorization, and reads the client registration and exchange URL from the
pinned version.

The Credential Refresh Driver exchanges the code using the pinned client and
its registered authentication method. For an MCP connection it sends the
approved resource at authorization, exchange, and refresh. The Token Service
keeps the access token and refresh grant in a private Secret. OCC records the
credential source ID, account owner, approved recipient, requested scopes, and
granted scopes. A shared callback verifies the issuer when multiple issuers are
configured. A provider timeout consumes the attempt.

The worker renews the saved account through the Token Service. A conditional
write fences concurrent renewals and disconnects. OCC records the next renewal
and any narrower scopes. Creating and renewing a saved account require no
Agent or sender profile.
