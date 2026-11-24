# Experimental Codex OAuth credential storage

Codex account sign-in creates a built-in OAuth [CredentialSource](../../credential-sources.md)
through the selected TokenService only after the user authorizes the issuer grant.
TokenService retains the access and refresh tokens. The selected native Credential
Proxy delivers the access token to an OpenShell Provider; dedicated Codex receives
only its placeholder and nonsecret account metadata. See the [fixed native
request policy](../../credential-sources.md#codex-account-model-requests).

## Enable device login

Select a TokenService with the built-in Codex device-login capability and native
OpenShell Credential Proxy and Sandbox delivery. Follow the [personal login
procedure](../../../guides/deploy/credential-lifecycle.md#use-a-personal-codex-login).
The Console keeps the **Experimental** label and reports unavailable sign-in when
that capability is absent.

## Private credential directory

The launcher writes ephemeral `auth.json` with `auth_mode: "chatgptAuthTokens"`,
the Proxy placeholder, account metadata, and an empty refresh token. Native Codex
does not own OAuth refresh. The locally constructed JWT metadata is unsigned; it
does not prove issuer identity, and native checks that require signed claims remain
unqualified. Restarts reconstruct this state from the admitted Source binding. Session and workspace persistence remain independent of auth.

OCC derives its device-login encryption key from `OCC_AUTH_SECRET`. In PostgreSQL,
it encrypts the issuer's private handle separately from the user code and
verification URL. Completion clears the handle; cancellation or expiry clears
both encrypted values. Closing a session does not revoke a completed Source.
Authorized hosted Apps discovery resolves access through TokenService and does not
send a token to the Harness.

## OAuth launch limits

OAuth requires a dedicated Codex Harness. Unsupported installations fail
explicitly. The native OpenShell [policy limits](../../credential-sources.md#implementation-status)
apply to placeholder substitution. New or reauthorized Codex account Sources
cannot deploy with Repository credentials on the same Agent; deployment returns
`409`. Active Source references also block deletion.

TokenService commits renewed material before notifying the selected Proxy. A
failed delivery retains custody for retry. A new deployment version is needed to
change account metadata. Genuine signed-in model execution and native token
injection still require the [TokenService runtime qualification](../../../testing/openshell-oauth.md#tokenservice-codex-account-verification).
