# CredentialRefreshDriver contract

## Overview

The Installation selects one Token Service through `drivers.credential_refresh`.
The API and worker resolve that selection from the same Installation YAML.
The Driver exposes the operations its issuers support.

- **OpenShell OAuth.** The `sources` interface enrolls a source, obtains and
  renews its access token, reports status, and removes refresh material. OCC
  authorizes the source and stores its Secret references. The paired Credential
  Gateway registers the provider. OpenShell holds the refresh grant and supplies
  each running Agent with its current token through a stable placeholder.
- **Prepared GitHub tokens.** The `preparedTokens` interface resolves the issuer
  for the admitted provider. The worker prepares scoped GitHub App installation
  tokens. A protected request can use an already prepared token. Issuance uses
  the worker-mounted App key for repository Git or the authorized Namespace
  Secret for a metadata source. [Prepared repository Git](../repository-credentials/prepared-native-git.md)

The bundled implementations are `native` and `openshell`. Select one with
`drivers.credential_refresh.implementation`. Existing OpenShell selections
that specify only `id` and `configuration` still select OpenShell. Its OAuth
interface requires membership in the Credential Gateway’s OpenShell Backend.
Existing GitHub preparation settings select the native service when the
Installation omits `credential_refresh`. An OpenShell selection can also serve
configured GitHub preparation. Static credentials alone require no Token Service.
[Driver selection](selection.md#backend-membership)

## Interface

The [Driver contract](../../../packages/contracts/src/index.ts) requires at
least one of `sources` or `preparedTokens`. A Driver that supplies `sources`
implements these four operations.

| Operation          | Inputs and preconditions                                                                       | Result or side effects                                                                          | Failure or absence                                                              |
| ------------------ | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `configureRefresh` | A source the gateway registered, its config, resolved refresh material, and a UUID request ID. | Replaces the source's refresh material. Replaying a successful request ID applies nothing new.  | A throw leaves the outcome unknown; OCC never retries it with a new request ID. |
| `rotate`           | A configured source and a UUID request ID.                                                     | Forces one mint and returns the refresh status. It does not revoke the old token at the issuer. | Only `ready` confirms a usable minted token.                                    |
| `refreshStatus`    | An existing source.                                                                            | Current refresh status.                                                                         | Missing state is `pending` before device authorization, otherwise `failed`.     |
| `removeRefresh`    | Source record.                                                                                 | Deletes the stored refresh material. Already-absent material counts as removed.                 | A throw keeps the OCC record `deleting` for retry.                              |

`CredentialRefreshStatus` carries only `state` (`pending`, `ready`, or
`failed`), the token's `expiresAt`, `nextRefreshAt`, and `lastRefreshAt` times,
an implementation-owned `failureCode`, and a `recoveryAction` of `retry`,
`reauthorize`, `fix_configuration`, or `investigate`. It never carries a token,
refresh material, or text from the issuer.

A source whose `rotation` is `refresh` requires the `sources` interface.
Device authorization uses its optional login hooks. Trusted catalog discovery uses the separate `sourceTokens` reader.

## Plugin catalog discovery

For a managed OAuth source, OCC calls the selected Token Service's
`sourceTokens.withSourceToken(context, use)`. If that reader is absent, a
Gateway that owns the source may supply its `sourceTokens` view. The bundled
OpenShell Gateway supplies the same OpenShell reader so an enrolled source
remains usable after new device logins are disabled.

OCC authorizes the exact source before asking for a token. The callback
rechecks the caller’s grants and, for a saved Agent binding, the Agent’s grants
and binding before contacting the catalog.
It receives the access token and optional trusted account ID and FedRAMP
classification. The Console receives the catalog result.

OpenShell retrieves the access token over its operator mTLS connection. It can
renew the token to meet the five-minute minimum remaining lifetime. The refresh
grant and its successors stay with OpenShell.

## Device authorization

A type declaring `deviceAuthorization.harnessId` requires this Driver's
`startDeviceAuthorization(context)` and `pollDeviceAuthorization(context, privateState)`.
OCC first registers an empty source with the Gateway; it defers refresh setup
until authorization supplies a grant. Start returns device instructions and an
opaque handle. Poll returns `pending` or `ready` only, never issuer credentials.
The Refresh Driver performs the exchange, configures gateway-owned refresh, and
confirms a usable token before reporting `ready`.

OCC fences polling with Secret compare-and-swap and binds the session to its actor,
source, and both Gateway and Refresh Driver IDs. It rechecks those bindings and
authority after external completion. A changed selection or uncertain exchange
requires reconnecting; it never replays the exchange. Closing the session removes
only its handle. Existing sources remain usable by their authorized Agents.
Device-source `PATCH` is refused: create a new login source rather than reseeding
a rotating refresh grant.

## IAM

The selected IAM Driver authorizes each OCC operation before the Driver is
called:

- Registration and update need the same grants as for any source:
  `credential_source:create` or `update`, and `secret:operate` on every Secret
  OCC reads for the refresh material.
- A forced rotation needs `credential_source:update` on the exact source. It
  reads no Secret, so it needs no `secret:operate`.

The Driver receives only authorized, exact-Namespace sources. It must never log,
return, or persist refresh material or tokens outside its own store. Issuer
credentials belong to the source, not to OCC.

## Lifecycle

For a registered OpenShell OAuth source, OCC performs the following operations.

1. **Registration.** OCC calls the gateway's `registerSource` with config only;
   resolved Secret values go only to this Driver. After it succeeds, OCC calls
   `configureRefresh` and then `rotate` to mint the first token. Both request IDs
   derive from the source ID, so a replay of the same step is not applied twice.
   The source becomes `ready` only once `rotate` reports `ready`. On any failure,
   OCC calls `removeRefresh` and the gateway's `removeSource`, as for a failed
   static registration. Device-authorized types register without configuring or
   minting; their first mint occurs during the device completion above.
2. **Background refresh.** The Driver re-mints before expiry without OCC. A
   failure appears in the source's status with its recovery action.
3. **Update.** `PATCH` reads the current or replacement Secret values and calls
   `configureRefresh`, then `rotate`. OCC commits replacement Secret references
   only after a `ready` mint. The update is not atomic: after `configureRefresh`
   succeeds, a failed mint returns `503` but the Driver keeps the new material,
   and the source stays `ready` with the failure in its status. OCC restores
   nothing; supply corrected Secrets. An update must name a different Secret
   for a catalog field marked `issuerRotated`, such as `refresh_token`,
   because the Driver may hold a newer value. On OpenShell, running Agents need a
   redeploy after any update that reaches `configureRefresh`; see its
   [limits](openshell-credential-gateway.md#limits).
4. **Rotation.** `POST …/rotate` calls `rotate` for incidents such as a
   suspected token leak. Running Agents keep their placeholder and need no
   redeploy.
5. **Status.** Reading a source adds the Driver's `refreshStatus` to the
   gateway's status. A source whose type the catalog no longer offers keeps its
   gateway status without refresh status. Listing sources reads no status.
6. **Deletion.** OCC calls `removeRefresh`, then the gateway's `removeSource`.

## Limits

- One Token Service is selected per Installation. An OpenShell OAuth selection
  must match the Credential Gateway’s Backend.
- OCC does not poll refresh status or audit background refresh failures; read
  the source to see them.
- The experimental `codex-oauth` model source uses device authorization; OAuth2
  tool sources receive their initial material through Secret references.
- Installed Credential Refresh packages are unsupported.

## Troubleshooting

| Symptom                                                      | What to check                                                                                                                                                               |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A refresh type is missing from the catalog                   | Select `drivers.credential_refresh` and declare it on the gateway's Backend.                                                                                                |
| Registration or rotation returns `503` naming a failure code | The issuer refused the material or was unreachable. Read the source's `status.refresh` and follow its `recoveryAction`.                                                     |
| `status.refresh.recoveryAction` is `reauthorize`             | The issuer revoked the refresh token. For a device source, reconnect with a new source. For a Secret-backed type, store new material in a Secret and `PATCH` its reference. |
| `status.refresh.recoveryAction` is `fix_configuration`       | Check the source's `token_url`, `client_id`, `scope`, and client secret against the issuer.                                                                                 |
| Rotation returns `409`                                       | The source is static. Update its Secret values instead.                                                                                                                     |

## Implementations

- `native` serves configured GitHub App issuers.
- `openshell` enrolls OAuth sources on the paired OpenShell Backend and serves
  any configured GitHub App issuers. [OpenShell OAuth sources](openshell-credential-gateway.md#oauth2-refresh-sources)

## Related

- [CredentialGatewayDriver contract](credential-gateway.md)
- [Credential sources](../credential-sources.md#rotate-a-refresh-source)
- [Credential source refresh flow](../../flows/credential-source-refresh.md)
- [Credential refresh proposal](../../../specs/rfcs/0016-sandbox-credential-injection/credential-refresh.md)
- [OCC credential source operations](../../../packages/occ/src/index.ts)
