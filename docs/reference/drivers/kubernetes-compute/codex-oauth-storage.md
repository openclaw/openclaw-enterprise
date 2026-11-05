# Experimental Codex OAuth credential storage

The dedicated Codex Harness can use a saved ChatGPT account. The Token Service owns its refresh grant. Each Agent needs permission to use the exact account. The worker checks the current grant before installing an access token at the Agent's Credential Gateway. The Harness receives the placeholder and account metadata through [external ChatGPT authentication](../credential-gateway.md#external-chatgpt-authentication).

## Enable device login

Select the OpenShell Refresh and Credential Gateway Drivers, a Token Service with OAuth connection custody, and a Sandbox that supports bearer-token injection for inference and hosted apps. OCE provisions the Installation's **ChatGPT for Codex** template with the native public client. This client uses the provider's device callback and token endpoint authentication method `none`. It requires no client secret. OCE reserves the registration and its destinations for the native device flow.

Follow the [personal login procedure](../../../guides/deploy/credential-lifecycle.md#use-a-personal-codex-login). Existing Gateway-managed sources continue to use their original refresh owner.

## Private credential directory

The launcher writes ephemeral `auth.json` with `auth_mode: "chatgptAuthTokens"`,
the exact placeholder, account metadata, and an empty refresh token. Native Codex
does not own OAuth refresh. Restarts reconstruct this state from the admitted
source attachment. Session and workspace persistence remain independent of auth.

OCC binds each pending device authorization to the user, browser session and Namespace. A sign-in started from an existing Agent also records that Agent. The Refresh Driver gives the Token Service the initial tokens, and OCC saves the account and grants its owner access. Closing the login removes the temporary session. Disconnecting the saved account retires its grant.

## OAuth launch limits

OAuth remains **Experimental**. It requires a dedicated Codex Harness, Credential
Gateway and paired Sandbox supporting the external-auth contract. Unsupported
installations fail explicitly; there is no runtime-owned OAuth fallback.

The old `oauth` binding and persistent refresh bundle are unsupported. Existing
development Agents using that shape need recreation with a new source. The
platform does not read old runtime credential files back into the service.
Account metadata changes require a new deployment version. Native checks that depend on
real access-token claims remain unqualified with an opaque placeholder.

## Device-login verification

See [external ChatGPT verification](../../../testing/openshell.md#external-chatgpt-authentication-boundary)
for integration coverage and the remaining live-provider and injection proof.
