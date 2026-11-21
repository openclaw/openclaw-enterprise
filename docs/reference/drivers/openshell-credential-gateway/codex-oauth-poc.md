# Experimental Codex OAuth PoC

This page is part of the [OpenShell Credential Gateway](../openshell-credential-gateway.md)
reference.

The experimental `codex-oauth` type uses upstream `GetProviderCredentials` and
matching supervisor/static launcher binaries. Select paired `credential_refresh`
and configure [operator TLS and issuer trust](../../../testing/openshell-oauth.md).
The pinned upstream binaries implement the required contracts.

Ordinary Backend authentication handles other operations. Access-token retrieval
alone uses `operatorTls`: a trusted gateway-CA certificate with `OU=operator`
and `openshell.gateway.mtls_auth.operator_enabled`. It rejects bearer headers and
forwarded identity. Protect its gateway-wide key. OCC checks exact source rights
before retrieval and discovery; Namespace-scoped OpenShell identities remain deferred.

Refresh exchanges the device grant into OpenShell custody; OCC stores an opaque
session. `withSourceToken` requests five-minute validity; OpenShell may refresh
and persists successors. Tokens enter only the trusted callback, never the Console.
Cancellation cannot undo refresh. Agent revisions reuse metadata and placeholders.

The Sandbox wraps the stable placeholder in the documented JWT alias for Codex's
local account metadata. OpenShell replaces the whole alias, enforcing identity,
revocation, endpoints and expiry. Selected runtime plugins remain unsupported;
directory discovery does not prove execution. See
[OAuth storage](../kubernetes-compute/codex-oauth-storage.md).

## WIP boundaries

- **Connection recovery and metadata.** Grant configuration and account metadata
  are separate writes; interrupted handoff may require reconnecting. An initial
  device-poll timeout closes the session and requires a fresh login. Metadata
  is a login-time snapshot, so account changes require a new login and Agent revision.
