---
rfc: ../rfcs/0023-agent-oauth-connections/index.md
---

# Implementation plan: Connect a user's OAuth account to a personal Agent

- **ID:** RFC-0023
- **Delivery status:** Planned
- **Owner:** mrunalp
- **Authority:** [RFC-0023](../rfcs/0023-agent-oauth-connections/index.md) and its
  [contracts companion](../rfcs/0023-agent-oauth-connections/contracts.md)
- **Source baseline:** `bca5b199b`

## Outcome and scope

An Installation administrator creates a connection template and grants `use` on it.
The Agent owner connects their account through the provider's consent page, then
deploys. The Agent's tool sends the injected credential to the approved endpoint,
and only the owner can deploy or use the Agent while it holds the credential.

Delivery uses three stacked PRs, each with a real caller:

1. **Backend connections.** IAM Installation bindings, connection templates and
   client registrations, browser authorization, the connection API and callback,
   personal-Agent enforcement, and the regular Agent workflow through the HTTP API
   and CLI.
2. **Console.** Connection template administration, **Connect**, **Reconnect**, and
   **Disconnect**, with Storybook coverage and PR media.
3. **Preset and provider options.** Preset `agent.connections`, `accountIdentity:
oidc`, the endpoint `access` field, and the per-template binary.

The [required outcomes](../rfcs/0023-agent-oauth-connections/contracts.md#required-outcomes)
are the acceptance criteria. Non-goals follow the RFC.

## Contract and source touchpoints

- **Driver contracts:** `packages/contracts/src/index.ts` (`IAMDriver`,
  `AuthorizationRequest`, `AccessBindingSubjectKind`, `CredentialRefreshDriver`,
  `CredentialSourceType`). Route contracts in `packages/contracts/src/api/routes.ts`,
  with schemas in `api/common.ts` and `api/resources.ts`.
- **IAM:** `packages/iam/src/index.ts` (`evaluateValidatedAuthorization`,
  `bindingScopeMatches`, administrator seed); permission and kind lists in
  `packages/contracts/src/api/common.ts`, `packages/occ/src/index.ts`, and
  `apps/controller/src/index.ts`.
- **Controller:** `packages/occ/src/index.ts` (`OpenClawController`). Model the
  connection session on device login (`startAgentDeviceAuthorization`,
  `pollAgentDeviceAuthorization`, `packages/occ/src/device-authorization.ts`): a
  pending source, a Namespace Secret session updated by compare-and-swap, actor and
  Agent binding, and no replay after an uncertain Driver call.
- **Storage:** `packages/occ/src/state/{platform-state,postgres-state,postgres-schema}.ts`,
  `packages/occ/src/ports/*`, and new migrations from `0060` (renumber at merge if
  another branch lands first).
- **HTTP:** a new `apps/controller/src/http/connection-templates.ts`, connection
  routes beside `http/credential-sources.ts`, and Installation-scoped dispatch in
  `apps/controller/src/index.ts` before the Namespace handler requirement.
- **OpenShell Drivers:** `apps/controller/src/drivers/credential-refresh/openshell.ts`
  and `drivers/credential-gateway/openshell.ts`; the gateway client in
  `drivers/sandbox/openshell-gateway-client.ts`.
- **CLI:** `internal/occcli` (new `connection-template` group, `agent connection`
  commands, `refusals.go` permissions) and `internal/occclient/client.go`.
- **Docs:** a new connection template reference, updates to
  `docs/reference/credential-sources.md`, `drivers/credential-refresh.md`,
  `drivers/iam.md`, `drivers/openshell-credential-gateway.md`, the permissions and
  database-entity cheat sheets, generated API references, and a flow doc under
  `docs/flows/` for the connection lifecycle.

## Implementation

### PR 1: backend connections

1. **IAM Installation bindings.** Add the optional `IAMDriver` methods,
   `AccessBindingSubjectKind` `namespace`, `AuthorizationRequest.namespaceContext`,
   the `use` action, and the `connection_template` kind. Implement them in native
   IAM. Migrate the database checks and seed the "Connection template user" role,
   including existing Installations. Add `GET`/`POST`/`DELETE /iam/access-bindings`
   and `GET /iam/roles` at Installation scope, authorized by Installation
   `administer` within the policy-and-audit transaction.
2. **Connection templates.** Add the Installation-scoped resource with immutable
   versions enforced by database triggers. Editing any field except `displayName`
   inserts a version. Deletion is refused while a source references a version and
   removes the template's bindings.
3. **Client registrations.** Add `registerClient`, `rotateClientSecret`, and
   `removeClient` to the Refresh Driver contract and the OpenShell implementation,
   keyed by `issuer` and `clientId`. Storage depends on the
   [open decision](#open-decisions).
4. **Browser authorization.** Add `startBrowserAuthorization` and
   `completeBrowserAuthorization`. The OpenShell Driver creates the PKCE verifier
   and `state`, exchanges the code without following redirects, and calls
   `configureProviderRefresh` with the client ID, client secret, and refresh token,
   then `rotate`. It never returns tokens.
5. **Connection API and callback.** Add
   `POST /namespaces/:namespaceId/agents/:agentId/connections`, connection reads,
   and `GET /oauth/callback`. Check `agent:update` and template `use` with the
   Agent's Namespace as context. Store the session in a Namespace Secret with
   compare-and-swap. Bind the callback to the starting session, reject reuse and
   sessions older than ten minutes, and keep codes out of logs and audit. Bind the
   source to the Agent and grant the Agent's service principal source `operate`.
6. **Personal-Agent enforcement.** Add a per-Agent retention predicate: a saved
   binding, a pending deployment, or an active or companion revision holding the
   source without a `revoked` withdrawal. While it holds, guard
   `createIAMAccessBinding`, Configuration and channel saves,
   `validateDeploymentChannels`, plugin approvers, `deployAgentWithAuthorization`,
   the worker's `authorizeRevision`, native admin access, and the image-upgrade
   redeploy path. Require the owner principal for deploy and use; keep stop,
   delete, withdraw, and source deletion available to administrators.
7. **CLI.** Add `occ connection-template` (create, get, list, update, delete,
   rotate-client-secret, bind, bindings, unbind) and `occ agent connection` (list,
   disconnect). Connecting needs the person's signed-in console session, which the
   CLI's service keys never provide, so it is a console action (PR 2) or the HTTP API
   with a session.
8. **Documentation.** Write the connection template reference and the connection
   lifecycle flow doc. Update the Driver references, cheat sheets, generated API
   reference, and the local OpenShell guide with a Keycloak example.

### PR 2: console

1. Add connection template administration under Installation settings and a
   **Connections** section on Agent creation and details: consent warning, popup
   with redirect fallback, connected and failed states, **Reconnect to apply
   changes**, and **Disconnect** with withdrawal progress.
2. Add Storybook scenarios for empty, loading, connected, failed, denied,
   withdrawal-pending, and reconnect-required states, and attach screenshots and a
   video to the PR.

### PR 3: Preset and provider options

1. Add the Agent `connections` field and Preset `agent.connections`, copied into
   the Agent at creation, and return `409` from deploy until each listed connection
   is `ready`.
2. Add `accountIdentity: oidc` with discovery or `jwksUri`, metadata agreement
   checks, and ID token validation.
3. Add the Gateway endpoint `access` field and the per-template binary in the
   OpenShell tool profile.

## Verification

| Required outcome                                                                                                             | Real check and prerequisites                                                                                                                                | Result or remaining proof |
| ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| Owner connects through a real authorization-code + PKCE flow and the source becomes ready                                    | New PostgreSQL + Keycloak integration test: a realm client with standard flow, S256 PKCE, and the OCC callback URI; headless Playwright completes the login | Not run                   |
| Callback refuses state reuse, another session, and expiry                                                                    | Same test, through the real Fastify app                                                                                                                     | Not run                   |
| IAM `use` by identity and by Namespace context; refusals for other Namespaces and service keys                               | PostgreSQL integration test through the Installation IAM routes                                                                                             | Not run                   |
| Second user cannot connect, deploy, chat, or receive grants; channels refused, including during delayed or failed withdrawal | PostgreSQL integration test with two human sessions                                                                                                         | Not run                   |
| Template edits leave existing sources unchanged; rotation affects only one issuer and client pair                            | PostgreSQL + Keycloak test with two realms sharing a client ID                                                                                              | Not run                   |
| Tool reaches its endpoint with no added network policy, and refresh, revoke, and reconnect work                              | Extend `sandbox-driver-openshell-k3d-real.test.mjs` through the regular Agent create path                                                                   | Not run                   |
| Codes and tokens never appear in responses, logs, or audit                                                                   | Assertions in the integration tests above                                                                                                                   | Not run                   |
| Live Google, `gog`, and Gmail                                                                                                | Manual run with an authorized account and the local OpenShell profile; outside CI                                                                           | Not run                   |

Register new tests in `scripts/ci/test-suites/*.json` with exact expected test
names. The Keycloak realm changes extend the existing fixtures; no fake issuer
replaces Keycloak.

## Open decisions

- None. Client secret storage was resolved on 2026-10-21: OpenShell has no
  Installation-level Workspace, so the OpenShell Credential Refresh Driver gains a
  `clientWorkspace` setting naming an operator-provisioned Workspace. It stores one
  Driver-owned provider per client registration there and reads secrets back over
  operator TLS ([RFC companion](../rfcs/0023-agent-oauth-connections/contracts.md#client-registrations)).

## Delivery record

Not started.

## Manual Notes

## Changelog

- 2026-10-21: Planned three stacked PRs from RFC-0023 at `c1f7244d4` (session
  `session_01HzmRt1DGB79VEnEWHt7PRy`).
