---
author: mrunalp
implementation_status: Partially implemented
status: Proposed
status_note: "The first slice shipped; the remaining proposal is explicitly not accepted."
---

# RFC: Credential Gateway Driver for Sandbox-injected credentials

**Date:** 2026-09-26
**Status:** Implementing; the first slice shipped in
[#461](https://github.com/openclaw/openclaw-enterprise/pull/461); remaining
proposal not Accepted. See the [delivery record](#delivery-record).
**Owner:** Driver contracts, Agent deployment, and the OpenShell integration.
**Source baseline:** OCE `main` at `ec103d94`, which pins OpenShell
[`v0.1.0`](https://github.com/NVIDIA/OpenShell/tree/v0.1.0) (`496ebba2`). Upstream
paths below are relative to that tag.

## Problem and decision

Agents need credentials for models, source control, cloud APIs and registries.
OCE has delivered model credentials as Kubernetes `secretKeyRef` environment
entries, putting the real value in the Harness process. The
[target design](../../docs/design/safeguards.md#secret-access) calls this a temporary
exception: the Harness should receive only scoped substitutes.

OpenShell keeps credentials out of the workload for every provider type it
supports. Its gateway stores a _provider_, and the Sandbox's supervisor Pod
applies it to outbound requests. The workload Pod has no direct egress and
never receives a real value.

Add a `credential_gateway` Driver capability to manage credential sources and
their attachment to Agent revisions. How a credential reaches a request belongs
to the implementation; OCE's contract never names the mechanism. OpenShell
implements the common interface with its paired Sandbox. The first target pairs
the GitHub broker with a static OpenShell model source in one dedicated
revision.

Blocked on main: an Installation cannot select `drivers.repo` with
`drivers.sandbox` (`installation-config.ts` startup check), and Compute's
`validateRepositoryCredentialSupport` refuses repository credentials with any
SandboxDriver at listing, deploy admission (409), dispatch and material build.
Credential-source model auth requires a SandboxDriver. Reaching the combined
revision requires lifting both guards, carrying repository material in
`HarnessWorkloadRequirements`, and an OpenShell policy route to the repository
gateway; until then the GitHub broker is supported only in installations without
a Sandbox Driver and the OpenShell model source only without repository
bindings. The adapter keeps the OCE HTTPS repository service as the only Git
and `gh` destination, routed with `tls: skip` so OpenShell does not substitute
credentials on that hop; clients still verify the service certificate. No
direct GitHub route may bypass it.

This builds on the deferred `CredentialGatewayDriver` in the
[archived Sandbox provisioning spec](../.archive/13-sandbox-driver-provisioning.md).

## Scope

In scope:

- The `credential_gateway` Driver contract, the `openshell` Backend, and their
  composition with the OpenShell SandboxDriver.
- A Namespace-scoped `CredentialSource` resource, Agent bindings to it, and
  Harness model authentication through a bound source.
- A contract for every OpenShell source type; first delivery requires real
  integration proof (see [OpenShell source types](#openshell-source-types)).
- Withdrawing one Agent's access without affecting other Agents.

Out of scope:

- The app-server transport token, projected workload token, workspace mounts,
  plugin-runtime files, and Authorization stripping on exposed OpenShell routes.
  These remain separate OpenShell blockers.
- Embedded OpenClaw, which OpenShell already rejects.
- Credential Gateway implementations without a Sandbox, such as a proxy for plain
  Kubernetes Compute: permitted, not delivered here.

## OpenShell source types

Sources: `docs/how-it-works/providers/overview.mdx:204-302` and
`docs/how-it-works/providers/profiles.mdx:500-600`.

| Source type                                                          | How OpenShell applies it                                                             | Inputs OCE supplies                                                | First delivery                                                     |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `static`                                                             | Placeholder in the workload environment; the proxy substitutes it at bound endpoints | Secret values                                                      | Yes: real OpenAI key                                               |
| `external`                                                           | Same as `static`; an external owner pushes new values                                | Secret values, updated later                                       | Future: real OpenAI key                                            |
| Gateway refresh: `oauth2_refresh_token`, `oauth2_client_credentials` | Gateway mints access tokens; the placeholder stays stable across rotations           | Secret and non-secret refresh material                             | Future: real in-cluster Keycloak                                   |
| Gateway refresh: `google_service_account_jwt`                        | Same as above                                                                        | Service account email and private key                              | Deferred: needs an authorized Google service account               |
| `aws_sts_assume_role`                                                | Gateway mints three credentials; the proxy re-signs requests with SigV4              | Role ARN, optional session settings and long-lived source keys     | Deferred: needs an authorized AWS role                             |
| Token grant: `client_credentials`, `token_exchange`                  | Supervisor obtains a token with its SPIFFE JWT-SVID; the proxy inserts the header    | Profile configuration; a stored subject token for `token_exchange` | Deferred: needs SPIRE and an issuer that accepts SPIFFE assertions |

OCE's catalog lists only `openai` (static); other types require real-path
integration tests.

Every type binds credentials to profile endpoints and returns 403
(`credential_endpoint_mismatch`) elsewhere
(`docs/how-it-works/providers/overview.mdx:411-433`). Providers belong to an
OpenShell workspace, and any workspace `user` can attach any provider in it
(`crates/openshell-server/src/grpc/sandbox.rs:1257-1278`).

## Contract

### Composition

Add `credential_gateway` to `DRIVER_CAPABILITIES`
(`packages/contracts/src/index.ts:42`) and an `openshell` Backend type. The
Backend owns the gateway client and declares both members
([Backend membership](../../docs/reference/backends.md)):

```yaml
backend:
  - id: openshell
    type: openshell
    configuration: { endpoint: https://…, auth: { mode: bearerTokenFile, path: … } }
    drivers: { sandbox: openshell-sandbox, credential_gateway: openshell-credentials }
```

Startup rejects a selected `credential_gateway` unless both Backend members and
Kubernetes Compute are selected.

### Driver interface

The method set matches main's [interface](../../docs/reference/drivers/credential-gateway.md).

```ts
interface CredentialGatewayDriver extends Driver {
  readonly capability: "credential_gateway";
  listSourceTypes(context: CredentialGatewayContext): Promise<readonly CredentialSourceType[]>;

  registerSource(
    context: CredentialSourceContext,
    input: CredentialSourceInput,
  ): Promise<CredentialSourceStatus>;
  updateSource(
    context: CredentialSourceContext,
    input: CredentialSourceInput,
  ): Promise<CredentialSourceStatus>;
  rotateSource(context: CredentialSourceContext): Promise<CredentialSourceStatus>;
  sourceStatus(context: CredentialSourceContext): Promise<CredentialSourceStatus>;
  removeSource(context: CredentialSourceContext): Promise<void>;

  attachForRevision(
    context: CredentialRevisionContext,
  ): Promise<readonly CredentialSourceAttachment[]>;
  attachmentStatus(
    context: CredentialRevisionContext,
  ): Promise<readonly CredentialAttachmentStatus[]>;
  withdraw(
    context: CredentialRevisionContext & { readonly sourceId: string },
  ): Promise<CredentialAttachmentStatus>;
}

interface CredentialSourceType {
  readonly type: string; // implementation-defined, for example "openai" or "aws"
  readonly config: readonly CredentialSourceFieldSpec[]; // non-secret inputs
  readonly secrets: readonly CredentialSourceFieldSpec[]; // OCC Secret references
  readonly rotation: "none" | "external" | "gateway";
  readonly harnessAuth?: { readonly modelProvider: string; readonly loginMode: "api_key" };
}

interface CredentialSourceInput {
  readonly type: string;
  readonly config: Readonly<Record<string, string>>;
  readonly secrets: Readonly<Record<string, string>>; // resolved values, never persisted by OCC
}

interface CredentialSourceAttachment {
  readonly sourceId: string;
  readonly ref: string; // opaque; consumed by the paired SandboxDriver
}
```

Contract rules:

- `listSourceTypes` is the implementation's catalog, like `PluginDriver.listCatalog`.
  OCC validates inputs against it; unknown types and fields fail before any effect.
- Register, update, and remove are idempotent for one source. The driver never
  logs, returns, or persists a secret value outside its credential store. Every
  effect of an aborted registration finishes within 30 seconds of the abort
  (`CREDENTIAL_GATEWAY_TIMEOUT_MS`).
- `attachForRevision` returns one attachment per bound source or throws. The
  paired SandboxDriver's `provisionHarness` must consume every attachment and
  reject any it did not issue.
- `withdraw` returns `revoked` only after the implementation observes
  revocation, otherwise `pending`. On OpenShell v0.1.0 a `revoked` detach
  receipt means the supervisor reloaded policy without the provider; the
  placeholder no longer resolves and every open proxied connection in that
  Sandbox was closed. Already-forwarded requests are not undone. Delay follows
  the supervisor poll interval (default 10s) and is not an upstream contract;
  while the supervisor cannot reach the gateway or after a failed refresh,
  credentials and open connections may persist and the receipt stays `pending`.
  Main's OpenShell `withdraw`, `updateSource` and `rotateSource` throw "not
  supported yet".
- `removeSource` is idempotent. OCC, not the Driver, refuses deletion with 409
  while an Agent draft, active revision, or pending deployment references the
  source. A retiring revision's Sandbox is caught only by OpenShell's
  attached-provider refusal: the source is already `deleting` and DELETE returns
  503 for retry.
- Static updates reach only newly started processes. Gateway refresh keeps stable
  references.

### Resource and bindings

`CredentialSource` is a Namespace-scoped OCC resource: name, type, non-secret
config, OCC Secret references for secret inputs, selected driver ID, and safe
status. It fills the deferred `SecretBroker` slot in the
[resource model](../../docs/design/resources.md). Values stay with the Secret Driver
and the credential store, and never enter OCC state, revisions, or audit.

An Agent binds at most one source through `harnessAuth: { method:
"credential_source", sourceId }`. Admission freezes `{ method, sourceId,
credentialGatewayId, sourceType, loginMode }` in the revision. The source type's
`harnessAuth.modelProvider` must match the configured model. With a credential
gateway selected, secret-backed `harnessAuth` methods return 409; there is no
fallback to environment delivery. Proposed: a list of non-model sources per Agent.

IAM follows existing Secret patterns. Source read and delete are exact-resource
actions; create is checked on the Namespace. Registration also requires
`operate` on each referenced OCC Secret. Binding a source to an Agent requires
`operate` on the source for the actor, and admission also requires it for
`Agent.servicePrincipalId`.

### Lifecycle and authority

OpenShell checks caller role on every RPC and token scope when the gateway
enforces OIDC scopes (`proto/openshell.proto` authorization options). Main uses
one principal; the proposal splits it:

- **Worker principal:** global `platform_admin`, which the Sandbox driver needs
  for workspaces, with `workspace:*` and `sandbox:*` scopes and no `provider:*`
  scope. It cannot create, update or delete provider records or profiles when
  the gateway enforces OIDC scopes (`scopes_claim` set). Residual risks: with
  `sandbox:write` it can attach any provider to any Sandbox and exec inside it,
  and the worker's Kubernetes RBAC reads the source Secret plaintext.
- **API principal:** workspace `admin` in each OCC workspace, with
  `provider:read` and `provider:write`, and no other role or `sandbox:*` scope.

| Operation                 | Principal | OpenShell RPCs (scope; role)                                                                                                                                                                                |
| ------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prepare a Namespace       | Worker    | `GetWorkspace` (`workspace:read`; user), `CreateWorkspace` (`workspace:write`; `platform_admin`), `AddWorkspaceMember` for the API principal as admin and `ListWorkspaceMembers` (`workspace:write`/`read`) |
| Create or update a source | API       | `GetProviderProfile`, `GetProvider` (`provider:read`), `ImportProviderProfiles`, `UpdateProviderProfiles`, `CreateProvider`, `UpdateProvider`, `ConfigureProviderRefresh` (`provider:write`; admin)         |
| Rotate a source           | API       | `RotateProviderCredential` (`provider:write`; admin)                                                                                                                                                        |
| Read source status        | API       | `GetProvider`, `GetProviderRefreshStatus` (`provider:read`; user)                                                                                                                                           |
| Provision a revision      | Worker    | `CreateSandbox` with `SandboxSpec.providers` (`sandbox:write`; user)                                                                                                                                        |
| Read attachment status    | Worker    | `GetSandboxProviderStatus` (`sandbox:read`; user)                                                                                                                                                           |
| Withdraw one Agent        | Worker    | `DetachSandboxProvider` (`sandbox:write`; user), then `GetSandboxProviderStatus`                                                                                                                            |
| Retire a revision         | Worker    | `DeleteSandbox` (`sandbox:write`; user); attachments go with the Sandbox                                                                                                                                    |
| Delete a source           | API       | `GetProvider`, `ListProviders` (`provider:read`), `DeleteProvider`, and `DeleteProviderProfile` for the last source (`provider:write`; admin)                                                               |
| Delete a Namespace        | Worker    | `DeleteWorkspace` (`workspace:write`; `platform_admin`)                                                                                                                                                     |

The API uses `SecretDriver.withValue` for authorized registration, passing
plaintext to the Gateway Driver and store. A narrower reference bridge and an
operation-mediated broker are later targets.

### Cleanup and retry

- **Sources.** Deleting a source marks it `deleting`, then the API calls
  `DeleteProvider` and confirms that `GetProvider` returns not found. If the
  gateway is unavailable or the outcome is uncertain, the record stays
  `deleting` for original-owner recovery. Confirmed absence after settlement
  counts as deleted. `DeleteProvider` also removes the provider's
  refresh state (`crates/openshell-server/src/grpc/provider.rs`,
  `delete_provider_record_with_credentials`).
- **Namespaces.** `CredentialSource` joins the resources that make a Namespace
  nonempty, so Namespace deletion returns `409 NAMESPACE_NOT_EMPTY` while any
  source record exists, including one in `deleting`. The worker therefore
  deletes the workspace only after every OCC provider and profile is gone.
  OpenShell rejects `DeleteWorkspace` with `FailedPrecondition` while providers,
  profiles, or refresh state remain (`docs/how-it-works/workspaces.mdx:221-234`).
  The worker keeps the Namespace `deleting` and retries.
- **Proposed: withdrawal.** The worker repeats `DetachSandboxProvider` until
  `revoked`, reading status first after `CONFIG_OPERATION_STORAGE_UNCERTAIN`. A
  later deployment omits or replaces the source.
- **Revisions.** Retirement retries until the Sandbox is gone; sources it
  referenced become deletable only then.

### Harness runtime

The entrypoint receives only the literal login mode from the source type's
`harnessAuth.loginMode`. For an `openai` static source, the supervisor sets the
`OPENAI_API_KEY` placeholder, and `codex login --with-api-key` stores it. The
upstream `codex` profile's ChatGPT-account placeholders have no gateway refresh,
so Codex CLI refresh would send placeholders in the request body. The Codex
startup model probe checks the path before readiness
([Harness execution](../../docs/reference/harness-execution.md)).

## Trust requirements

- OCC's principals must be the only members of its OpenShell workspaces,
  because workspace users can attach any provider. In the proposed split the
  worker fails Namespace preparation on any other member in
  `ListWorkspaceMembers`; the check is point-in-time because the worker can
  `AddWorkspaceMember`. Platform Admins bypass membership, so the worker must be
  the only Platform Admin, which OCC cannot verify. Main checks neither.
- Sources do not cross OCC Namespaces; each OCC Namespace maps to one workspace.
- Credentialed endpoints require L7 inspection. Codex and other clients must
  trust the per-generation Sandbox CA. OpenShell rejects a `tls: skip` rule that
  overlaps the model endpoint; skip rules for other hosts relay bytes
  unmodified, so the placeholder may be forwarded literally but the key never is.
- The guarantee depends on OpenShell's NetworkPolicy, which admits only
  supervisor ingress to the workload and denies workload-initiated connections.
  The cluster's network plugin must enforce it
  (`docs/kubernetes/setup.mdx:11-34`).
- `token_exchange` stores a subject token. The design's non-goals exclude
  "Delegating human identity or authentication to an Agent", so the subject must
  be a non-human principal until that is revisited.
- Registration requires TLS plus `bearerTokenFile`, or an explicit
  `insecureTransport: network-policy`, accepted in any profile and unverifiable
  by OCC (`packages/occ/src/backends.ts:248-270`).

## Failure behavior

- Unknown source types, missing inputs, and unauthorized Secrets fail before any
  gateway call.
- Known gap, tracked in #118: registration shipped with only the 70-second
  fence, without resolving uncertain creation, cleanup and COMMIT. Never replay
  or compensate uncertain effects; unknown COMMIT is not rollback.
- Missing attachment readiness keeps the candidate inactive.
- A proxy endpoint mismatch fails the request; the Harness startup probe keeps
  the Pod unready.
- Proposed: a pending withdrawal remains visible in attachment status and is
  retried; it never reports success early.

## Differences from PR #386

- **Adopted:** separate capability, shared sources with per-Agent attachments,
  the four provider operations mapped as above, and a contract for static,
  refreshed, and dynamic credentials.
- **Omitted:** `mediate`, `BoundExchange`, `Assurance` profiles, and branded
  evidence types. OpenShell does not call OCE per request.
- **Not yet a contract:** a 30-second closure bound, including loss of renewal
  (see `withdraw`). The protected bound is tracked in
  [#118](https://github.com/openclaw/openclaw-enterprise/issues/118).

## Verification gates

Confirm before `Accepted`:

1. The pinned Codex binary trusts the Sandbox CA and sends request shapes the
   proxy can rewrite, including any WebSocket upgrade.
2. Codex accepts placeholders from `codex login --with-api-key` and the
   `CODEX_AUTH_*` variables without parsing them locally. ChatGPT-account
   refresh works through the proxy, or the source type uses gateway refresh
   instead.
3. A `revoked` detach receipt stops a running Codex process's requests and
   closes its open streams.
4. The principal split works as specified: the worker principal is denied
   provider RPCs, and the API principal is denied workspace and Sandbox RPCs.

## Tests

Extend `tests/integration/sandbox-driver-openshell-k3d-real.test.mjs` through the
API and worker workflow:

- Register a static OpenAI source, deploy a dedicated Codex Agent, and complete a
  real model turn. Verify the key is absent from the Harness Pod spec, Agent- and
  revision-owned Kubernetes Secrets, Harness environment and workspace files.
  Exclude the source OCC Secret, stored by the Kubernetes Secret Driver in the
  tenant's control-plane namespace; verify no Pod references it.
- Update an `external` source and prove that a restarted Harness uses the new
  value.
- Withdraw the source from one Agent. That Agent's next model request fails,
  while a second Agent attached to the same source keeps working.
- Register `oauth2_client_credentials` and `oauth2_refresh_token` with real
  in-cluster Keycloak. Call its protected endpoint from the Harness and prove
  rotation without restart.
- Prove principal RPC denials, source deletion refusal while attached, and
  Namespace deletion refusal while a source exists.
- Prove fail-closed cases: an unbound host returns 403, and a direct connection
  from the Harness Pod fails.
- Test startup membership, catalog validation, deferred-type rejection, and
  admission refusal of secret-backed `harnessAuth` with a gateway selected.

## Documentation

#461 updated the [Drivers](../../docs/design/drivers.md),
[resources](../../docs/design/resources.md) and
[Secret access](../../docs/design/safeguards.md#secret-access) design; a new
Credential Gateway reference and the
[OpenShell SandboxDriver](../../docs/reference/drivers/openshell-sandbox.md),
[Backends](../../docs/reference/backends.md),
[Namespaces](../../docs/reference/namespaces.md),
[Harness execution](../../docs/reference/harness-execution.md) and
[Secret Driver](../../docs/reference/drivers/secret.md) references; API,
permissions and database-entity cheat sheets; the
[provisioning flow](../../docs/flows/openshell-sandbox-provisioning.md); and
[OpenShell testing](../../docs/testing/openshell.md).

## Delivery record

[#461](https://github.com/openclaw/openclaw-enterprise/pull/461) delivered
registration, removal, attachment, and status for the `openai` source type. A
local real OpenShell model turn used the injected key while the Harness held only the
placeholder. The current contract is owned by
[Credential Gateway](https://github.com/openclaw/openclaw-enterprise/blob/ec103d947abb40b21411e5b8bdede7774ae35df1/docs/reference/drivers/credential-gateway.md) and
[credential sources](https://github.com/openclaw/openclaw-enterprise/blob/ec103d947abb40b21411e5b8bdede7774ae35df1/docs/reference/credential-sources.md).

The gateway copy does not follow Secret changes or grant removal; refresh and
bounded withdrawal remain future work.

Hosted evidence: none as of 2026-09-28; the `openshell` full-integration lane
has not executed on main.

The implementation differs from this proposal:

- Registration commits a `registering` record before the gateway call; if the
  call throws, OCC attempts removal and marks uncertain attempts `deleting`. An
  unsettled update can leave either state. DELETE finalizes only 70 seconds
  after `createdAt`.
- Compute's `resolveSandboxNamespace` supplies the gateway Workspace, and
  providers set `profile_workspace`.

Remaining work is tracked in
[#118](https://github.com/openclaw/openclaw-enterprise/issues/118).

## Open questions

- Should ChatGPT account tokens issued by the ServiceAccount Driver become an
  `external` source that the Driver updates?
- Which principal may supply a `token_exchange` subject token?
