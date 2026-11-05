# How OCC saves an OAuth connection template

The administrator selects manual configuration or supplies an MCP server URL. OCC checks Installation administration before discovery. For MCP, the controller reads protected resource metadata over TLS, resolves each metadata host to public addresses and pins those addresses for the request. It contacts only the selected advertised authorization server. OCC stores the metadata it observed with the approved version.

For a Google APIs recipient, OCC verifies Google’s issuer, authorization and token URLs and any supplied revocation URL before it saves the version. The consuming Driver selects the supported Google API destinations when the account is used.

OCC checks scope and the client's allowed destinations before it references an OAuth client. PostgreSQL commits the template version and its audit together. A template can exist without a client. The Agent plugin release determines the local credential placeholder when the account is used.

OCC reserves a hidden OAuth client row before the Refresh Driver writes a confidential client’s secret. The Driver uses the client ID as its private storage reference. OCC publishes the client and records its creation in one transaction. If creation stops before publication, the worker removes the private material and the hidden row.

For rotation, OCC records the administrator’s request, locks the client, rechecks the session, and asks the Driver to replace the value at that same reference. Code exchange and token refresh use the current value. OCC records successful completion after the write. If the caller loses the response, repeating the operation with the same value is safe.

When an administrator deletes a confidential client, OCC checks for dependent template versions, hides the client, and records the deletion. The worker retries private cleanup before removing the client row.

See [OAuth connection templates and clients](../reference/connection-templates.md) for the supported operations.

## Consent and token custody

The callback consumes the attempt once. OCC verifies the signed-in account and session after any database wait and before code exchange. It checks the session again before storing the grant or granting its owner access.

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
granted scopes. A Google APIs template keeps its provider-wide recipient on the account. An exact Google API template keeps its approved host, port, and path. When the person requests provider defaults, the Driver omits the scope parameter. It records the scopes the provider reports, or an empty list if the provider omits them. Renewal can narrow the recorded grant. It cannot add scopes to an unreported grant. A shared callback verifies the issuer when multiple issuers are
configured. A provider timeout consumes the attempt.

The worker renews the saved account through the Token Service. For each refresh, it checks the saved grant against the approved registration
and resolves the current client secret from its Driver. A conditional write
fences concurrent renewals and disconnects. OCC records the next renewal
and any narrower scopes. Creating and renewing a saved account require no
Agent or sender profile.

## Bind a saved account to a plugin

The Plugin Driver identifies the named accounts in the selected release. OCC lists ready accounts the caller can operate in the Namespace whose issuer the slot accepts. It marks an account for new authorization when the approved protected resource or destination differs. A grant's scopes are available to the provider and the request policy.

Saving a selection checks the exact slot, account and Agent permissions together. Starting OAuth from a saved slot also records the release and current binding. When the browser returns, OCC checks both before replacing that slot. The account stays with its owner if the binding changed during consent.

Admission records the source grant and the Driver's approved delivery profile for the revision. The worker prepares an expiring access token through the Token Service and sends it to that profile. Detaching queues withdrawal for the affected Agent. Other Agents can keep their grants.

For a saved Google account, the Credential Gateway passes the Installation’s tool executables and granted scopes to the Sandbox Driver. For a Google APIs recipient, the Gateway configures one provider with the exact service hosts and paths that have a reviewed operation for the granted scopes. The Sandbox Driver checks that the provider serves exactly those destinations and that its guarded routes allow the same executables. The request guard applies the same operation checks to each executable.
