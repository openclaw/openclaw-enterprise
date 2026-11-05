# How OCC saves an OAuth connection template

The administrator selects manual configuration or supplies an MCP server URL. OCC checks Installation administration before discovery. For MCP, the controller reads protected resource metadata over TLS, resolves each metadata host to public addresses and pins those addresses for the request. It contacts only the selected advertised authorization server. OCC stores the metadata it observed with the approved version.

The Console reads the Google starter destinations from the reviewed Google Workspace release and displays them as editable rows. OCC normalizes the destinations and records them on a new template version. The template ID stays the same across versions. It identifies the current manual delivery policy for accounts connected with that issuer. MCP discovery supplies one transport destination and its OAuth resource.

OCC checks scope and the client's allowed destinations before it references an OAuth client. PostgreSQL commits the template version and its audit together. A template can exist without a client. The Agent plugin release determines the local credential placeholder when the account is used.

When the administrator registers a client, OCC reads its availability and approved endpoints from the selected template version. It checks the version again before publication. OCC reserves a hidden OAuth client row before the Refresh Driver writes a confidential client’s secret. The Driver uses the client ID as its private storage reference. OCC publishes the client and records its creation in one transaction. If the template had no client, that transaction also publishes a version that selects the new registration. If creation stops before publication, the worker removes the private material and the hidden row.

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
granted scopes. When the person requests provider defaults, the Driver omits the scope parameter. It records the scopes the provider reports, or an empty list if the provider omits them. Renewal can narrow the recorded grant. It cannot add scopes to an unreported grant. A shared callback verifies the issuer when multiple issuers are
configured. A provider timeout consumes the attempt.

OCC saves the consent receipt under its original immutable template version. When listing an account, `PlatformController.effectiveConnectionDestinations` reads the current version of that same template. For manual accounts, it returns the current destinations when the issuer and manual mode still match. For MCP accounts, it returns the original destinations only when issuer, discovery mode, exact server URL and protected resource still match. A missing or incompatible template returns an empty list. This projection does not rewrite the saved registration, grant, token endpoint or consent audit. For MCP, the Driver sends the original resource identifier to the provider.

The worker renews the saved account through the Token Service. For each refresh, it checks the saved grant against the approved registration
and resolves the current client secret from its Driver. A conditional write
fences concurrent renewals and disconnects. OCC records the next renewal
and any narrower scopes. Creating and renewing a saved account require no
Agent or sender profile.

## Bind a saved account to a plugin

OCC reads the Agent’s Configuration and selects the Plugin Driver for its Harness. That Driver identifies the named accounts in the selected release. OCC lists ready accounts the caller can operate in the Namespace whose issuer the slot accepts. It marks an account for new authorization when the approved protected resource or destination differs. A grant's scopes are available to the provider and the request policy.

Saving a selection checks the exact slot, account and Agent permissions together. Starting OAuth from a saved slot also records the release and current binding. When the browser returns, OCC checks both before replacing that slot. The account stays with its owner if the binding changed during consent.

Admission records the Plugin Driver, saved account and sender on the AgentRevision. During deployment and maintenance, the worker uses that revision’s driver and reads the account’s current template. For manual OAuth it reads the latest destinations from the same issuer. For MCP it checks the original server and resource. Console tool discovery makes the same check before it sends a credential.

When a sender’s host, port or path changes, the Credential Gateway clears the bearer and waits for OpenShell to acknowledge withdrawal on the receiving Sandbox. The Sandbox Driver applies the updated network policy and checks its effective request guard. Compute then asks OCC to release the access token. OCC rechecks the Agent grant and the expected policy before publishing. An update that fails retries without releasing credentials to the new destination. Detaching queues withdrawal for the affected Agent. Other Agents retain their own sender.

If a template changes to an incompatible recipient or allows no operation the account can perform, OCC withdraws that account’s token. The running Sandbox keeps the empty provider in its launch configuration. The worker can deliver tokens for the Agent’s other slots. If a later edit restores a usable destination, delivery can resume with the same saved account.

For a saved Google account, the Credential Gateway configures one OpenShell provider. It includes a host, port and path only when the current template and a reviewed Google Workspace operation both allow it, and the account has the scope for that operation. The Sandbox Driver checks those routes and the Installation’s approved executables. Each executable uses the same request guard.

An Agent network grant and a template edit can both change the running Sandbox policy. The Sandbox Driver reads the current policy before applying either change. A template edit preserves the Agent’s network grants. Applying a grant preserves the account’s current request guard. If the changes overlap in a way that would bypass the guard, the Driver refuses the update.
