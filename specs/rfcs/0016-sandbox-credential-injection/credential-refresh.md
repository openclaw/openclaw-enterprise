---
rfc: index.md
---

# Credential refresh: separate refresh from the Credential Gateway

Companion to the [Credential Gateway RFC](index.md).

**Source baseline:** OCE `main` at `ccb76e6a`, which pins OpenShell
`v0.1.3-pre.2` (`021400be`). Upstream paths are relative to that tag.

## Decision

Move refresh configuration, forced rotation, and refresh status off
`CredentialGatewayDriver` into a new `credential_refresh` Driver capability.
The Credential Gateway keeps source registration, update, removal, attachment,
withdrawal, and source status. `rotateSource` leaves the gateway contract.

This is the token-service role requested in the
[#851 review](https://github.com/openclaw/openclaw-enterprise/pull/851#issuecomment-6003603058).
It is named Credential Refresh because
[#924](https://github.com/openclaw/openclaw-enterprise/pull/924) and
[#1530](https://github.com/openclaw/openclaw-enterprise/pull/1530) use "Token
Service" for an OCC-hosted service; see
[Relation to the Token Service proposals](#relation-to-the-token-service-proposals).

Static types (`openai`, `bearer-token`) have no issuer and never use this
capability; rotating them means pushing new values with `updateSource`. Refresh
types have an issuer and long-lived refresh material, such as an OAuth2 client
secret or refresh token. The refresh implementation holds that material, mints
access tokens, and re-mints them before expiry. The Harness keeps the same
placeholder throughout, so running processes need no restart. OCC therefore
drives setup, incident rotation, and status, not routine rotation.

## Interface

```ts
interface CredentialRefreshDriver extends Driver {
  readonly capability: "credential_refresh";
  configureRefresh(
    context: CredentialSourceContext,
    input: CredentialRefreshInput,
  ): Promise<CredentialRefreshStatus>;
  rotate(context: CredentialSourceContext, requestId: string): Promise<CredentialRefreshStatus>;
  refreshStatus(context: CredentialSourceContext): Promise<CredentialRefreshStatus>;
  removeRefresh(context: CredentialSourceContext): Promise<void>;
}

interface CredentialRefreshInput {
  readonly config: Readonly<Record<string, string>>;
  readonly secrets: Readonly<Record<string, string>>; // resolved values, never persisted by OCC
  readonly requestId: string; // UUID; see Source lifecycle for when OCC reuses one
}

interface CredentialRefreshStatus {
  readonly state: "pending" | "ready" | "failed";
  readonly expiresAt?: string;
  readonly nextRefreshAt?: string;
  readonly lastRefreshAt?: string;
  readonly failureCode?: string; // implementation-owned identifier, never provider text
  readonly recoveryAction?: "retry" | "reauthorize" | "fix_configuration" | "investigate";
}
```

Contract rules:

- `configureRefresh` replaces the source's refresh material. Replaying a
  successful call with the same `requestId` returns its original outcome
  instead of applying it again.
- `rotate` forces one refresh. It is for incidents, such as a suspected token
  leak. It does not revoke the previous token at the issuer. Its `requestId`
  follows the same replay rule as `configureRefresh`.
- `removeRefresh` is idempotent and deletes the stored refresh material. On
  OpenShell, `DeleteProvider` also removes it; the separate call keeps the
  contract complete for implementations that store material elsewhere.
- No method returns, logs, or persists a token or refresh material. Status
  carries only the fields above.
- A refresh type's catalog entry declares `rotation: "refresh"`. The Credential Gateway lists such a type only when its Backend also
  supplies a selected `credential_refresh` Driver.

## Composition

The OpenShell Backend declares a third member:

```yaml
backend:
  - id: openshell
    type: openshell
    drivers:
      sandbox: openshell-sandbox
      credential_gateway: openshell-credentials
      credential_refresh: openshell-refresh
```

Startup rejects a selected `credential_refresh` Driver unless the same Backend
also supplies the selected `credential_gateway`. OpenShell stores refresh state
on the provider record that the Credential Gateway registered
(`crates/openshell-server/src/provider_refresh.rs`), so a refresh Driver on
another Backend cannot reach it. The same rule already pairs the Sandbox and
Credential Gateway Drivers.

## Source lifecycle

| Step                      | OCC calls                                                                                                                               | OpenShell RPCs                                                           |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Register a refresh source | Gateway `registerSource`, then `configureRefresh`, then `rotate` to mint the first token. The source is `ready` once status is `ready`. | `CreateProvider`, `ConfigureProviderRefresh`, `RotateProviderCredential` |
| Read a source             | Gateway `sourceStatus` and `refreshStatus`, returned together as the source's `status`                                                  | `GetProvider`, `GetProviderRefreshStatus`                                |
| Update refresh material   | `configureRefresh` with current or replacement Secret values, then `rotate`. References commit only once `ready`.                       | `ConfigureProviderRefresh`, `RotateProviderCredential`                   |
| Force a rotation          | `rotate`                                                                                                                                | `RotateProviderCredential`                                               |
| Delete a source           | `removeRefresh`, then gateway `removeSource`                                                                                            | `DeleteProviderRefresh` with `allow_missing`, then `DeleteProvider`      |
| Attach, withdraw, retire  | Unchanged gateway calls. The placeholder does not change when a token is re-minted.                                                     | Unchanged                                                                |

For a refresh type, OCC calls `registerSource` with empty `secrets`. The
resolved Secret values are issuer material, and only `configureRefresh`
receives them, so the Credential Gateway Driver never holds a client secret or
refresh token. `updateSource` is never called for a refresh type.

Registration keeps the current recovery model. OCC commits the source as
`registering` before the first gateway call. If any later step fails, OCC
removes the refresh material and the provider. After an uncertain outcome the
record stays `deleting`, and `DELETE` repeats the removal. Each source ID
registers once, so registration derives its `configureRefresh` and `rotate`
request IDs as name-based UUIDs from the source ID and step. OpenShell replays
a successful result for the same request ID for 24 hours.

An update and a forced rotation are new caller requests, so each call takes a
new random request ID. OCC does not replay an uncertain update or rotation: it
returns `503`, and the caller retries. A retried rotation mints one more token.
A retried update reconfigures the same material, which starts one more
authorization epoch.

An update is not atomic. Once `configureRefresh` succeeds, OpenShell holds the
new material and has started a new authorization epoch, even if `rotate` then
fails. In that case:

- OCC returns `503` and keeps the previous Secret references, which name the
  last material that minted.
- The source stays `ready`. Its `status.refresh` reports the failed mint with
  its failure code and recovery action.
- OCC changes no attachment, but running Agents lost their handle with the
  epoch and need a redeploy, as after a successful update.
- OCC does not restore the previous material. Reconfiguring it would start
  another epoch and still not restore the revoked handles.

To recover, the owner sends `PATCH` with no `secrets`, which re-applies the
recorded references, or supplies corrected material. While minting keeps
failing, the source stays readable with its failed status until one of those
updates succeeds or the owner deletes the source.

Reconfiguring refresh material starts a new OpenShell authorization epoch and
revokes handles derived from the previous one (`provider_refresh.rs`,
`effective_authorization_epoch`). Running Agents therefore need a redeploy after
an update, as they do after a static update. The real OpenShell suite confirms
it: within one Sandbox provider poll after an update, the same running Harness
presents no valid token.

### API

- `PATCH /namespaces/:namespaceId/credential-sources/:credentialSourceId` keeps
  its current rules. For a refresh type it calls `configureRefresh`, then
  `rotate`, and returns `503` unless the mint is `ready`.
- `POST /namespaces/:namespaceId/credential-sources/:credentialSourceId/rotate`
  needs exact `credential_source:update`. It reads no Secret, so it needs no
  `secret:operate`. It returns `200` with the source and its status, `409` for a
  type without refresh, and `503` when the gateway is unavailable.
- The CLI adds `occ credential-source rotate ID`.

## Authority

Every refresh RPC is a provider operation, so the API principal from the
proposed [principal split](index.md#lifecycle-and-authority) calls them. The
worker principal needs none.

| Operation                   | OpenShell RPCs (scope; role)                                                  |
| --------------------------- | ----------------------------------------------------------------------------- |
| Configure or remove refresh | `ConfigureProviderRefresh`, `DeleteProviderRefresh` (`provider:write`; admin) |
| Force a rotation            | `RotateProviderCredential` (`provider:write`; admin)                          |
| Read refresh status         | `GetProviderRefreshStatus` (`provider:read`; user)                            |

## Failure behavior

- **Background refresh failure.** OpenShell reports `failed` with a
  `recovery_action`. OCC shows it in the source status and does not retry.
  OpenShell schedules its own retry when `next_refresh_time` is set. For
  `reauthorize`, the owner supplies new material with `PATCH`.
- **Expired token.** If refresh keeps failing, the Harness's requests carry an
  expired token and fail at the protected API.
- **Uncertain configure or rotate.** OCC does not replay the call. During
  registration the record stays `deleting` for `DELETE`. An update or rotation
  returns `503`, and an update commits no new Secret references; the caller
  retries with a new request ID.
- **Failed mint after an update.** The update returns `503`, keeps the
  previous Secret references, and leaves the new material in place; see
  [Source lifecycle](#source-lifecycle) for recovery.
- **Gateway unavailable.** `rotate`, `PATCH`, and registration return `503`.
  Running Sandboxes can keep using their last minted token until it expires.

## Relation to the Token Service proposals

- **[#1530](https://github.com/openclaw/openclaw-enterprise/pull/1530)** proposes a
  Token Service that receives configuration from the control plane, refreshes
  in the background, and serves the Gateway only already-warm tokens. OpenShell
  meets that model inside one Backend: the gateway re-mints before expiry, and
  the proxy injects the current token without minting on lookup.
  `configureRefresh` corresponds to its `configure`. Its per-operation
  authorization and Secret-reference reads are out of scope here. If adopted,
  `configureRefresh` would take Secret references instead of values.
- **[#924](https://github.com/openclaw/openclaw-enterprise/pull/924)** proposes an
  OCC Token Service for platform-minted credentials, starting with GitHub, with
  issuer plugins under the `token` capability. Its FAQ assigns refresh of
  user-supplied OAuth credentials held by OpenShell to OpenShell, which is this
  capability's scope. An OCC Token Service could feed a gateway only by pushing
  current values through the `external` rotation path. That is the handoff #924
  leaves to a follow-up contract, not this pairing.

## Verification

Extend `tests/integration/sandbox-driver-openshell-k3d-real.test.mjs` through
the API and worker workflow, with an in-cluster Keycloak behind HTTPS and a
private CA:

- Register `oauth2-client-credentials` and `oauth2-refresh-token` sources. The
  Harness calls a protected endpoint and holds only a placeholder.
- With a short token lifetime, the running Harness keeps succeeding across at
  least one re-mint with no redeploy.
- `rotate` mints a new token; the source status shows the new
  `lastRefreshAt`.
- Revoking the Keycloak session behind the `oauth2-refresh-token` source makes
  refresh fail with `reauthorize`, shown in the source status.
- An update starts a new epoch; the test records whether running Sandboxes need
  a redeploy.
- An update whose mint fails returns `503`, keeps the recorded Secret
  references, and the source reports the failure. A later update with new
  material restores minting.
- Registration passes the Credential Gateway Driver no Secret values for a
  refresh type. OCC conformance checks this boundary, because OpenShell returns
  no provider credential values for the real test to observe.
- Deleting the source removes refresh state and the provider.
- Startup rejects `credential_refresh` without a paired `credential_gateway` on
  the same Backend.

## Delivery

The OAuth2 refresh PR implements this proposal: the `credential_refresh`
capability and its OpenShell Driver, the `oauth2-client-credentials` and
`oauth2-refresh-token` types, `POST …/rotate`, and
`occ credential-source rotate`. The current contract is owned by the
[CredentialRefreshDriver reference](../../../docs/reference/drivers/credential-refresh.md).
The real OpenShell suite proves registration, background re-minting in a
running Harness, forced rotation, reauthorization, a failed update, and
deletion against an in-cluster Keycloak. OCC conformance proves that
registration sends the Credential Gateway Driver no refresh secrets.

## Open questions

- Should OCC poll refresh status and record failures in audit, or read it only
  when a caller reads the source?
- Should `rotate` need its own IAM action rather than `credential_source:update`?
