# Experimental Codex OAuth credential storage

Codex OAuth uses a [credential source](../../credential-sources.md) owned by the
selected Credential Gateway. The external token service owns the provider
connection and refresh tokens. The dedicated Codex Harness receives a placeholder
and authenticated account metadata through
[`chatgptAuthTokens`](../credential-gateway.md#external-chatgpt-authentication).

## Enable device login

Select paired Credential Gateway and Refresh Drivers. The Refresh Driver owns
Codex device authorization; the Gateway supplies usable access tokens for
configuration and external-auth attachments.
Its paired Sandbox must inject live credentials for inference and hosted-app
requests. The experimental OpenShell `codex-oauth` source requires the
[gateway API and custom supervisor](../openshell-credential-gateway.md#experimental-codex-oauth-poc).
It is not supported by the stock pinned OpenShell images.

Follow the [personal login procedure](../../../guides/deploy/credential-lifecycle.md#use-a-personal-codex-login).
The Console keeps the **Experimental** label and reports unavailable sign-in when
the selected Gateway lacks the required capability. There is no installation
opt-in flag.

## Private credential directory

The launcher writes ephemeral `auth.json` with `auth_mode: "chatgptAuthTokens"`,
the exact placeholder, account metadata, and an empty refresh token. Native Codex
does not own OAuth refresh. Restarts reconstruct this state from the admitted
source attachment. Session and workspace persistence remain independent of auth.

OCC's login-session Secret contains an opaque Gateway handle and source identity,
never the access/refresh-token pair. The credential source survives closing or
expiry of that session. Plugin configuration requests a usable access token from the source; the token
service may refresh before returning it. This does not consume the deployed
credential or require another login.

## OAuth launch limits

OAuth remains **Experimental**. It requires a dedicated Codex Harness, Credential
Gateway and paired Sandbox supporting the external-auth contract. Unsupported
installations fail explicitly; there is no runtime-owned OAuth fallback.

The old `oauth` binding and persistent refresh bundle are unsupported. Existing
development Agents using that shape need recreation with a new source. The
platform does not read old runtime credential files back into the service.
Account metadata changes require a new revision. Native checks that depend on
real access-token claims remain unqualified with an opaque placeholder.

Connection recovery and refresh are the external token service's responsibility.
Deleting a login-session Secret does not revoke its credential source; remove an
unused source through credential-source management. Active references block deletion.

## Device-login verification

See [external ChatGPT verification](../../../testing/openshell.md#external-chatgpt-authentication-boundary)
for integration coverage and the remaining live-provider and injection proof.
