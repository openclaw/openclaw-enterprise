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
[upstream gateway and supervisor support](../openshell-credential-gateway.md#experimental-codex-oauth-poc).

Follow the [personal login procedure](../../../guides/deploy/credential-lifecycle.md#use-a-personal-codex-login).
The Console keeps the **Experimental** label and reports unavailable sign-in when
the selected Gateway lacks the required capability. There is no installation
opt-in flag.

## Private credential directory

The launcher writes ephemeral `auth.json` with `auth_mode: "chatgptAuthTokens"`,
the exact placeholder, account metadata, and an empty refresh token. Native Codex
does not own OAuth refresh. Restarts reconstruct this state from the admitted
source attachment. Session and workspace persistence remain independent of auth.

OCC derives its device-login encryption key from `OCC_AUTH_SECRET`. In PostgreSQL,
it encrypts the Refresh Driver's private handle separately from the user code
and verification URL. When login completes, OCC clears the private handle.
It retains the encrypted code and URL so the user can poll the completed login.
Cancellation or expiry clears both encrypted values.

OCC keeps the closed session row until Namespace deletion. The session has no
IAM grant, and closing a login does not revoke its credential source.
Plugin configuration requests a usable access
token from the source. The token service may refresh it before returning it. This does not consume the deployed
credential or require another login.

## OAuth launch limits

New unprotected OpenShell revisions can pass the startup check after Codex switches
from a recognized REST-endpoint WebSocket refusal to HTTPS. The same thread must
produce a nonempty assistant answer and one completed, tool-free turn with exit 0.
A fallback advisory, exit 0 alone, or a failed HTTPS request is not sufficient.
Earlier revisions retain their original startup command; a new deployment selects
the new verifier. This check does not establish live-provider qualification.

OAuth remains **Experimental**. It requires a dedicated Codex Harness, Credential
Gateway and paired Sandbox supporting the external-auth contract. Unsupported
installations fail explicitly; there is no runtime-owned OAuth fallback.

The old `oauth` binding and persistent refresh bundle are unsupported. Existing
development Agents using that shape need recreation with a new source. The
platform does not read old runtime credential files back into the service.
Account metadata changes require a new deployment version. Native checks that depend on
real access-token claims remain unqualified with an opaque placeholder.

Connection recovery and refresh are the external token service's responsibility.
To revoke an unused source, remove it through credential-source management. Active references block deletion.

## Controller rollback

Once the controller admits a new unprotected OpenShell OAuth revision, keep
a controller and Worker that understand its launcher marker available for
as long as that revision is in the Agent's history. Earlier revisions keep
their original launcher.

In controlled Compute Driver tests, the previous version refused to prepare
or activate a marked revision. Without scratch storage, its stop and retire
operations removed the Sandbox. With scratch storage, both refused before
deletion. Retirement still failed after a compatible controller had stopped
the Sandbox. The Worker retires every saved revision during Agent deletion.

If rollback is required, qualify a separate return build before deploying
this change, which issues the new marker on admission. Stage a version that
reads the new marker and reproduces its launcher while issuing the original
marker for new revisions. Verify stop and Agent deletion through the normal
Worker flow on that build, including stopped revisions with scratch storage.

## Device-login verification

See [external ChatGPT verification](../../../testing/openshell.md#external-chatgpt-authentication-boundary)
for integration coverage and the remaining live-provider and injection proof.
