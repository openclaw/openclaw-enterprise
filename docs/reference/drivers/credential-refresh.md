# CredentialRefreshDriver contract

## Overview

`CredentialRefreshDriver` mints and re-mints the tokens of `refresh`-type
[credential sources](../credential-sources.md). A refresh type, such as an
OAuth2 client-credentials source, has an issuer and long-lived refresh
material, such as a client secret or refresh token. The Driver holds that
material, obtains an access token from the issuer, and obtains a new one before
it expires. The Agent keeps the same placeholder throughout, so running
processes need no restart.

OpenClaw Control Plane (OCC) owns the source record and authorization. It keeps
initial Secret references until the first token is minted, then clears them.
The paired [Credential Gateway](credential-gateway.md) owns the
source's stored record and applies the current token to the Agent's requests.
This Driver owns the refresh material and the minted tokens. OCC calls it only to
set up refresh, to force a rotation, and to read refresh status; it never calls
the Driver on a request path.

Selection is optional. The only implementation is the bundled
[OpenShell Credential Refresh](openshell-credential-gateway.md#oauth2-refresh-sources),
which must belong to the same `openshell` [Backend](../backends.md) as the
selected Credential Gateway. See [Driver selection](selection.md#backend-membership).
Without it, the gateway's catalog offers no `refresh` types.

## Interface

The [shared interface](../../../packages/contracts/src/index.ts) requires every
method below. Startup rejects a Driver that omits one.

| Operation          | Inputs and preconditions                                                                       | Result or side effects                                                                          | Failure or absence                                                              |
| ------------------ | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `configureRefresh` | A source the gateway registered, its config, resolved refresh material, and a UUID request ID. | Replaces the source's refresh material. Replaying a successful request ID applies nothing new.  | A throw leaves the outcome unknown; OCC never retries it with a new request ID. |
| `rotate`           | A configured source and a UUID request ID.                                                     | Forces one mint and returns the refresh status. It does not revoke the old token at the issuer. | A status other than `ready` means no token was minted.                          |
| `refreshStatus`    | A configured source.                                                                           | Current refresh status.                                                                         | Missing refresh state reports `failed`, never `ready`.                          |
| `removeRefresh`    | Source record.                                                                                 | Deletes the stored refresh material. Already-absent material counts as removed.                 | A throw keeps the OCC record `deleting` for retry.                              |

`CredentialRefreshStatus` carries only `state` (`pending`, `ready`, or
`failed`), the token's `expiresAt`, `nextRefreshAt`, and `lastRefreshAt` times,
an implementation-owned `failureCode`, and a `recoveryAction` of `retry`,
`reauthorize`, `fix_configuration`, or `investigate`. It never carries a token,
refresh material, or text from the issuer.

A `CredentialSourceType` whose `rotation` is `refresh` needs this Driver. The
contract has no optional methods.

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

The API and worker construct the Driver at startup from trusted Installation
configuration; only the API calls it. The interface has no initializer or
destructor.

1. **Registration.** OCC calls the gateway's `registerSource` with config only;
   resolved Secret values go only to this Driver. After it succeeds, OCC calls
   `configureRefresh` and then `rotate` to mint the first token. Both request IDs
   derive from the source ID, so a replay of the same step is not applied twice.
   The source becomes `ready` only once `rotate` reports `ready`; the same
   transaction clears its Secret references and appends the audit event. Secret
   objects remain intact. On any failure, OCC calls `removeRefresh` and the gateway's `removeSource`, as for a failed
   static registration.
2. **Background refresh.** The Driver re-mints before expiry without OCC. A
   failure appears in the source's status with its recovery action.
3. **Update.** `PATCH` requires explicit Secret references containing all
   required catalog fields. It rejects omitted material before Secret reads or
   refresh effects, then reads the supplied values and calls `configureRefresh`
   and `rotate`. After a `ready` mint, OCC clears the source's references without
   deleting Secret objects. A failed mint returns `503` and leaves the existing
   references unchanged, but the Driver keeps the new material; OCC restores
   nothing. After an uncertain outcome, inspect status and use `rotate` with the
   Driver's current material. Another reconfiguration requires newly authorized
   material because an issuer may have consumed the submitted refresh token. On
   OpenShell, running Agents need a redeploy after any update that reaches
   `configureRefresh`; see its [limits](openshell-credential-gateway.md#limits).
4. **Rotation.** `POST …/rotate` calls `rotate` for incidents such as a
   suspected token leak. Running Agents keep their placeholder and need no
   redeploy.
5. **Status.** Reading a source adds the Driver's `refreshStatus` to the
   gateway's status. A source whose type the catalog no longer offers keeps its
   gateway status without refresh status. Listing sources reads no status.
6. **Deletion.** OCC calls `removeRefresh`, then the gateway's `removeSource`.

## Limits

- One Credential Refresh Driver can be selected per Installation, and only on
  the selected Credential Gateway's Backend.
- OCC does not poll refresh status or audit background refresh failures; read
  the source to see them.
- Model sources do not use refresh types.
- Installed Credential Refresh packages are unsupported.

## Troubleshooting

| Symptom                                                      | What to check                                                                                                                                                        |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A refresh type is missing from the catalog                   | Select `drivers.credential_refresh` and declare it on the gateway's Backend.                                                                                         |
| Registration or rotation returns `503` naming a failure code | The issuer refused the material or was unreachable. Read the source's `status.refresh` and follow its `recoveryAction`.                                              |
| `status.refresh.recoveryAction` is `reauthorize`             | The issuer revoked the refresh token. Complete a new sign-in, store the new refresh token in a Secret, and `PATCH` with explicit references to all required Secrets. |
| `status.refresh.recoveryAction` is `fix_configuration`       | Check the source's `token_url`, `client_id`, `scope`, and client secret against the issuer.                                                                          |
| A refresh update omits `secrets`                             | Supply complete explicit Secret references for reauthorization, or use `rotate` to mint from current material.                                                       |
| Rotation returns `409`                                       | The source is static. Update its Secret values instead.                                                                                                              |

## Implementations

- [OpenShell Credential Refresh](openshell-credential-gateway.md#oauth2-refresh-sources):
  bundled; configures OpenShell's gateway-owned refresh on the provider the
  OpenShell Credential Gateway registered.

## Related

- [CredentialGatewayDriver contract](credential-gateway.md)
- [Credential sources](../credential-sources.md#rotate-a-refresh-source)
- [Credential source refresh flow](../../flows/credential-source-refresh.md)
- [Credential refresh proposal](../../../specs/rfcs/0016-sandbox-credential-injection/credential-refresh.md)
- [OCC credential source operations](../../../packages/occ/src/index.ts)
