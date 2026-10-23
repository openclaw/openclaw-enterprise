# Implementation plan: external OpenShell gateway with OIDC client-credentials authentication

- **ID:** TASK-0045
- **Delivery status:** Implementing
- **Owner:** Enterprise platform
- **Authority:** current architecture — [`openshell` Backend contract](../../docs/reference/backends.md#openshell-gateway) and [OpenShell SandboxDriver](../../docs/reference/drivers/openshell-sandbox.md); no new RFC (existing-contract extension)
- **Source baseline:** `bb7d2a110` (branch `openshell-external-gateway-oidc`)

## Outcome and scope

A trusted Installation can point its `openshell` Backend at a gateway deployed
outside the OCC-owned cluster and authenticate to it with an OIDC
client-credentials grant instead of a static bearer-token file. The development
launcher (`occ dev up` with the OpenShell profile) can select that topology
with environment variables instead of installing the pinned in-cluster
gateway.

Non-goals: mTLS client certificates, authorization-code or device flows,
IdP-driven role mapping (the gateway owns authorization after validating the
token), discovery (the token URL is configuration, matching console OIDC
sign-in), and managed-workspace mode.

## Contract and source touchpoints

The [`openshell` Backend](../../docs/reference/backends.md#openshell-gateway)
owns the gateway connection shared by the OpenShell Sandbox and Credential
Gateway Drivers. Today its closed `auth` accepts `unauthenticated` or
`bearerTokenFile`; `apps/controller/src/backends/openshell.ts` passes the
configuration to `GrpcOpenShellGatewayClient`, whose per-call `metadata()`
reads the token file and sets gRPC `authorization` metadata
(`apps/controller/src/drivers/sandbox/openshell-gateway-client.ts`). The
pinned OpenShell v0.1.3-pre.2 gateway validates bearer tokens on gRPC when
`server.oidc.issuer` is set and expects the server's configured audience
(`openshell-cli` by default), not the client ID.

Selected behavior:

- New `auth` mode `oidcClientCredentials` with `tokenUrl` (absolute `https`
  URL; `http` only to a numeric loopback address, matching the gateway
  chart's own development allowance), `clientId` (inline; not secret
  material), `clientSecretPath` (absolute file path, like
  `bearerTokenFile`), optional `tokenAuth`
  (`client_secret_post` default, or `client_secret_basic`; the console OIDC
  precedent), optional `audience` and `scope` request parameters, and
  optional `requestTimeoutMs` shared with the existing per-call deadline.
- The client exchanges client credentials for an access token at `tokenUrl`
  using the selected client-authentication style, caches the token until a
  refresh margin before its reported expiry, single-flights concurrent
  refreshes, and presents it as gRPC `authorization: Bearer` metadata.
- Transport fencing is unchanged: TLS plus an authenticated mode is
  protected transport; any other combination requires
  `insecureTransport: network-policy` because credential registration sends
  resolved values over the connection.
- Validation lives in `packages/occ/src/backends.ts` beside the existing
  mode checks; the contract type lives in
  `packages/contracts/src/index.ts`.
- The development launcher (`internal/occdev`) gains
  `OCC_DEVELOPMENT_OPENSHELL_GATEWAY_ENDPOINT` plus
  `OCC_DEVELOPMENT_OPENSHELL_OIDC_TOKEN_URL`, `_CLIENT_ID`, and
  `_CLIENT_SECRET_FILE`. Selecting an endpoint skips the chart install,
  image import, and in-cluster JWT/gateway assets, renders the Backend with
  `oidcClientCredentials` auth, creates the in-cluster Secret carrying the
  client secret, and admits the external address in the profile's
  NetworkPolicies (API/worker egress and supervisor callbacks).
- The production chart (`deploy/helm/openclaw-enterprise`) mounts that
  Secret into the API and worker Deployments at the Backend's configured
  `clientSecretPath`, mirroring `auth.oidc` secret mounting.

Consequential failure handling: token-endpoint failures surface as gateway
client errors (existing `OpenShellGatewayFailure` path), a token that expires
between calls triggers one re-fetch before failing the call, and invalid
Backend configuration fails Installation startup exactly like the existing
auth modes.

## Implementation

1. Extend `OpenShellBackendConfiguration.auth` in
   `packages/contracts/src/index.ts` with the `oidcClientCredentials` mode.
2. Validate the mode in `packages/occ/src/backends.ts`: required keys,
   absolute `clientSecretPath`, `https` (or numeric-loopback `http`)
   `tokenUrl`, `tokenAuth` membership, and the unchanged
   TLS/`insecureTransport` fencing.
3. Implement token acquisition and caching in
   `apps/controller/src/drivers/sandbox/openshell-gateway-client.ts` and
   thread it through `metadata()`; no changes to `OpenShellGateway` beyond
   pass-through.
4. Prove the wire behavior in
   `tests/conformance/openshell-gateway-wire.test.mjs`: a real local token
   endpoint plus the in-process gRPC wire server asserting the
   `authorization` metadata, token caching across calls, refresh after
   expiry, and both client-authentication styles. Backend admission and
   rejection extend the existing driver-selection tests
   (`tests/integration/sandbox-driver-startup.test.mjs`).
5. Add the launcher mode in `internal/occdev`: external endpoint selection,
   secret creation, Installation rendering, and NetworkPolicy egress for the
   external address; extend `internal/occdev` unit tests for configuration
   rendering.
6. Add the chart value mounting the OIDC client-secret Secret into API and
   worker Deployments.
7. Update current documentation:
   [Backends](../../docs/reference/backends.md#openshell-gateway),
   [OpenShell SandboxDriver](../../docs/reference/drivers/openshell-sandbox.md),
   [local Kubernetes development](../../docs/guides/deploy/local-kubernetes-development.md),
   the [OpenShell tests](../../docs/testing/openshell.md) page, and affected
   cheat sheets. Update the owning flow doc if the gateway-connection flow
   changes materially.

Prerequisites: none beyond the repository toolchain. Real-gateway proof
against an operator-supplied external gateway and IdP is manual verification
on top of the conformance proof and is not part of CI.

## Verification

| Required outcome                                   | Real check and prerequisites                                            | Result or remaining proof |
| -------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------- |
| OIDC mode admitted; token acquired and sent        | `openshell-gateway-wire` conformance test with local token endpoint      | Pass (3 tests)            |
| Token cached, refreshed on expiry, both auth styles | Same conformance test                                                   | Pass                      |
| Invalid configuration rejected at Installation startup | `sandbox-driver-startup` integration test                           | Pass                      |
| Launcher renders external-gateway Installation     | `internal/occdev` Go unit tests                                          | Pass (4 tests)            |
| External gateway reachable through profile policies | Manual `occ dev up` against an operator-supplied gateway; recorded here | Not run                   |

## Open decisions

None.

## Delivery record

- 2026-10-22 (branch `openshell-external-gateway-oidc`, from `bb7d2a110`):
  - Contract: `packages/contracts/src/index.ts` gained the `oidcClientCredentials`
    auth mode; `packages/occ/src/backends.ts` validates it with the unchanged
    TLS/`insecureTransport` fencing.
  - Client: `apps/controller/src/drivers/sandbox/openshell-oidc-token.ts` owns
    token acquisition, caching, and single-flight refresh;
    `openshell-gateway-client.ts` presents the token as gRPC `authorization`
    metadata.
  - Launcher: `internal/occdev/openshell_external.go` reads and validates the
    `OCC_DEVELOPMENT_OPENSHELL_*` selection; both control-plane flows skip the
    in-cluster gateway; `writeInstallation` renders the OIDC Backend; the
    supervisor-callback and control-plane policies admit the resolved exact
    external addresses; the client secret reaches the API and worker through a
    Compose bind mount or the `backend.openshell.*` Helm value.
  - Documentation: `docs/reference/backends.md` (auth mode), the new
    `docs/guides/deploy/external-openshell-gateway.md` procedure (registered in
    `docs/docs.json`; linked from the profile guide, testing page, and flow),
    the environment-variables cheat sheet, and the
    `openshell-sandbox-provisioning` flow (OIDC metadata path; older changelog
    entries moved to its history page to hold the length budget). The guide
    page stays at its previous size; the flow page is within one word of it by
    local approximation.
  - Verification run: `pnpm typecheck`, `pnpm lint`, `pnpm format:check`,
    `pnpm check:workspace`, `go test ./...`, and `node --test
    tests/conformance/openshell-gateway-wire.test.mjs
    tests/integration/sandbox-driver-startup.test.mjs
    tests/conformance/kubernetes-compute.test.mjs` (289 tests) pass. The chart
    render with `backend.openshell.oidcSecretName` was verified with
    `helm template` against `deploy/examples/production/values.yaml`, and the
    flow doc passes the bundled validator. `pnpm docs:check` and
    `docs:check-length` could not run: the `scripts/docs-site` toolchain has
    its own lockfile that is not installed in this checkout, and installing it
    as a side effect of verification is prohibited.
  - Remaining proof: a real `occ dev up` against an operator-supplied external
    gateway and IdP, including supervisor callbacks and a model turn; recorded
    in Verification above as not run.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-10-22: Initial plan drafted from the `openshell` Backend contract and
  pinned OpenShell v0.1.3-pre.2 gateway auth survey (`bb7d2a110`).
