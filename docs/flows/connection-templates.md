# How OCC saves an OAuth connection template

The administrator selects manual configuration or supplies an MCP server URL. OCC checks Installation administration before discovery. For MCP, the controller reads protected resource metadata over TLS, resolves each metadata host to public addresses and pins those addresses for the request. It contacts only the selected advertised authorization server. OCC stores the metadata it observed with the approved version.

OCC checks scope and the client's allowed destinations before it references an OAuth client. PostgreSQL commits the template version and its audit together. A template can exist without a client. The Agent plugin release determines the local credential placeholder when the account is used.

OCC reserves a hidden OAuth client row before the Refresh Driver writes a confidential client’s secret. The Driver uses the client ID as its private storage reference. OCC publishes the client and records its creation in one transaction. If creation stops before publication, the worker removes the private material and the hidden row.

For rotation, OCC records the administrator’s request, locks the client, rechecks the session, and asks the Driver to replace the value at that same reference. Code exchange and token refresh use the current value. OCC records successful completion after the write. If the caller loses the response, repeating the operation with the same value is safe.

When an administrator deletes a confidential client, OCC checks for dependent template versions, hides the client, and records the deletion. The worker retries private cleanup before removing the client row.

See [OAuth connection templates and clients](../reference/connection-templates.md) for the supported operations.
