# OpenShell Credential Gateway

The [Credential Gateway](credential-gateway.md) stores OCC [credential sources](../credential-sources.md)
as OpenShell providers. The supervisor substitutes credentials outside the Harness.
Select it with the [OpenShell SandboxDriver](openshell-sandbox.md) on one `openshell`
[Backend](../backends.md#openshell-gateway).

**OpenShell remains unsupported for production.** Workload identity, writable state,
authentication, admission, and provider-file proof follow the
[OpenShell qualification contract](openshell-sandbox.md#qualification-contract).

[Protected static inference](../credential-sources/protected-inference.md)
requires a separate authenticated counterpart.

## Configure the Driver

Select `drivers.credential_gateway` with the OpenShell Backend and Sandbox in
trusted Installation YAML. The Backend member IDs must match the selected Drivers:

```yaml
backend:
  - id: openshell
    type: openshell
    configuration:
      endpoint: https://openshell-gateway.openshell-system.svc:8080
      auth:
        mode: mtls
        certificatePath: /etc/openclaw/openshell/tls.crt
        privateKeyPath: /etc/openclaw/openshell/tls.key
      rootCertificatePath: /etc/openclaw/openshell/ca.crt
    drivers:
      sandbox: openshell-sandbox
      credential_gateway: openshell-credentials
      credential_refresh: openshell-refresh # enables OAuth2; Codex also needs operatorTls
drivers:
  sandbox:
    id: openshell-sandbox
    configuration:
      gateway:
        workspaceMode: operator
      # See openshell-sandbox.md for the remaining Sandbox settings.
  credential_gateway:
    id: openshell-credentials
    configuration:
      binaries:
        - /path/to/codex
        - /usr/local/bin/node
      toolBinaries:
        - /usr/bin/curl
  credential_refresh:
    id: openshell-refresh
    configuration: {}
```

`binaries` requires a nonempty list of absolute executable paths inside the Harness
image. OpenShell releases credentials to those binaries and their child processes.
Use the exact native Codex executable or `/usr/local/bin/node` for OpenClaw.
The development profile lists Node and both
x64/ARM64 Codex paths independently of the launcher host.
A stale path fails the Harness startup model probe with
`RUNTIME_MODEL_PROBE_FAILED`, or `RUNTIME_AUTHENTICATION_FAILED` when the provider
rejects the missing credential, and the current Agent revision keeps serving.

`toolBinaries` is optional: nonempty absolute paths inside the Sandbox image that
may carry [tool sources](../credential-sources.md#bind-a-source-to-an-agent) to
their endpoints, such as `/usr/bin/curl`. Without it the catalog omits
`bearer-token` and the OAuth2 types.

`drivers.credential_refresh` is optional and takes an empty configuration. It
selects the bundled [Credential Refresh](credential-refresh.md) implementation,
which must be the same Backend's `credential_refresh` member. With it and
`toolBinaries`, the catalog adds the OAuth2 types.

Changing binary lists rewrites profiles on the next update, deployment, or
repair; until that succeeds, removed binaries retain access and deployment stays
pending. To cut access immediately, withdraw or delete the source. Mixed-version
controller replicas can overwrite each other's lists. Removing `toolBinaries`
blocks tool-source registrations, updates, deployments, and repairs with
`409 RESOURCE_CONFLICT`, because OpenShell treats an empty list as any binary.
Existing sources remain readable and deletable.

Startup rejects the selection when:

- the Installation does not select the bundled Kubernetes Compute Driver;
- no `openshell` Backend exists, or its `drivers.credential_gateway`,
  `drivers.sandbox`, or `drivers.credential_refresh` differs from the selected
  IDs;
- `drivers.credential_refresh` is selected without `drivers.credential_gateway`; or
- the configuration has any key other than `binaries` and `toolBinaries`.

Both API and worker need gateway access with Backend credentials: the API
registers/deletes providers; the worker creates Sandboxes, updates profiles and
reads attachment status. The selected Refresh Driver owns device exchange and
refresh configuration.

## Source-type catalog

| Type                         | Secret fields                               | Config fields                                                                   | Rotation  | Harness authentication         |
| ---------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------- | --------- | ------------------------------ |
| `openai`                     | `api_key` (required)                        | `base_url` (optional)                                                           | `none`    | `openai` / `api_key`           |
| `codex-pat`                  | `access_token` (required)                   | None                                                                            | `none`    | `openai` / `codex_pat`         |
| `codex-oauth` (Experimental) | None; device login                          | None                                                                            | `refresh` | `openai` / `chatgptAuthTokens` |
| `bearer-token`               | `token` (required)                          | `host`, `env_var` (required); `port`, `path`                                    | `none`    | None (tool credential)         |
| `oauth2-client-credentials`  | `client_secret` (required)                  | `host`, `env_var`, `token_url`, `client_id` (required); `port`, `path`, `scope` | `refresh` | None (tool credential)         |
| `oauth2-refresh-token`       | `refresh_token` (required); `client_secret` | `host`, `env_var`, `token_url`, `client_id` (required); `port`, `path`, `scope` | `refresh` | None (tool credential)         |

Codex PATs (personal or service-account) use `CODEX_ACCESS_TOKEN` at these HTTPS routes:

- `auth.openai.com/api/accounts/v1/user-auth-credential/whoami`.
- `chatgpt.com/backend-api/codex/**`.
- `chatgpt.com/backend-api/wham/config/bundle`.
- `chatgpt.com/backend-api/wham/accounts/check`.
- `chatgpt.com/backend-api/wham/settings/user`.
- `chatgpt.com/backend-api/wham/usage`.

Other routes remain denied.

The Harness stores only an opaque `personal_access_token`. Readiness requires
native login and model execution
([bootstrap flow](../../flows/openshell-sandbox-provisioning.md#2-derive-the-provider-owned-harness-request)).

`openai` defaults to `https://api.openai.com/v1`. Custom HTTPS Responses endpoints must end in `/v1`, optionally after a prefix such as `/api`. Before Secret reads or persistence, `400 INVALID_REQUEST` rejects wildcards, port `0`, an `@` or credentials, spaces, controls, a missing `//`, queries, fragments, and a host that is not an exact DNS name, as for `bearer-token`. OCC stores the normalized, immutable endpoint; register a new source to change it.

Invalid `bearer-token` and OAuth2 values return field-specific `400` before Secret
reads or persistence:

- `host` is an exact lowercase DNS name (re-checked at attachment), not an IP
  address or wildcard.
- `port` is 1 to 65535 and defaults to `443`.
- `path` is an absolute path pattern and defaults to `/**`.
- `env_var` is the upper-case Sandbox variable holding the placeholder, not
  `OPENAI_API_KEY`, `PATH`, `HOME`, `USER`, `SHELL`, `LANG`, or a name starting
  with `CODEX_`, `OCE_`, `OPENCLAW_`, or `OPENSHELL_`.
- `token_url` is an `https` URL without credentials, query, or fragment. Its
  host follows the `host` rule, has a dot, and is not a `localhost` or
  `localdomain` name. An explicit port must be 1 to 65535.
- `client_id` is 1 to 256 visible characters; `scope` is space-separated
  OAuth2 scopes.

The workload sends the placeholder itself:
`curl -H "Authorization: Bearer $API_TOKEN" https://api.example.com/v1/items`.
The proxy substitutes the token only on requests from `toolBinaries` to the
source's endpoint. Never put a placeholder, or its `openshell:resolve:env:` prefix, into the model conversation:
OpenShell refuses a model request whose body carries one, so the Agent's turns
fail until that history is gone.

Registration rejects provider types outside this catalog.

### Experimental Codex OAuth PoC

The experimental `codex-oauth` type uses upstream `GetProviderCredentials` and
matching supervisor/static launcher binaries. Select paired `credential_refresh`
and configure [operator TLS and issuer trust](../../testing/openshell-oauth.md).
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
[OAuth storage](kubernetes-compute/codex-oauth-storage.md).

#### WIP boundaries

- **Connection recovery and metadata.** Grant configuration and account metadata
  are separate writes; interrupted handoff may require reconnecting. An initial
  device-poll timeout closes the session and requires a fresh login. Metadata
  is a login-time snapshot, so account changes require a new login and Agent revision.

## OAuth2 refresh sources

The paired [Credential Refresh Driver](credential-refresh.md) configures the
profile-declared issuer and mints the empty provider's first token. OpenShell
holds refresh material and renews before expiry. Its supervisor picks up re-minted
tokens on its provider poll (every 10 seconds by default). Reconfiguration starts
a new authorization epoch, revoking running Sandboxes' placeholders and requiring
redeployment.

The gateway Pod must reach `token_url` through its NetworkPolicy and trust the
issuer. Preserve public roots when adding a private CA; see
[issuer trust setup](../../testing/openshell-oauth.md#prepare-images-and-trust).
The [Refresh Driver](credential-refresh.md) owns request IDs and recovery.

## How sources map to OpenShell

Each OCC Namespace maps to an operator-mode Workspace named after its Kubernetes
namespace. The Driver manages:

- **One provider profile per source.** Its ID equals the provider name; a content
  digest drives registration/update/deployment reconciliation. `openai` binds
  bearer `authorization` to its configured host/port/base path plus `/**`, for
  `binaries` only. `bearer-token` exposes `env_var` at its host/port/path for
  `toolBinaries`. `codex-pat` exposes `CODEX_ACCESS_TOKEN` at the catalog's fixed
  PAT routes; `codex-oauth` exposes it for ChatGPT. The Refresh Driver owns issuer
  exchange and refresh configuration.
- **One provider per source.** Its name is `oce-cs-` plus 24 hexadecimal characters
  of the source ID's SHA-256. Labels identify OCC ownership, source and Namespace;
  `profile_workspace` names its workspace. Registration checks ownership/type
  before profile mutation and again on creation collision. These calls are not
  atomic: a provider or orphan profile can change between them.
- **Workspace.** OCC resolves the Namespace's workspace from Compute's runtime
  placement, so registration uses the same workspace as the paired Sandbox.

`sourceStatus` reports `ready` for an owned provider, `absent` for a missing one,
and `failed` for a same-name provider the source does not own.
Refresh reports `pending` during `refresh_in_progress`/`refresh_committing`.
A persistent uncertain marker requires inspection; OCC neither replays the
exchange nor reseeds credentials.

`updateSource` requires the existing provider to be OCC-owned for the exact
source, rewrites the source's profile when the configured binaries changed,
then calls `UpdateProvider` with the new credential values. `UpdateProvider`
merges non-empty values, so the driver rejects an empty value rather than
silently keep the old one. OpenShell gives the new value only to processes
started after the update; a running Harness keeps the previous value until it
restarts.

`removeSource` deletes the owned provider, confirms it gone, then deletes the
source's profile; OpenShell cannot delete a Workspace still holding profiles.

The source ID identifies its profile even with an invalid persisted endpoint.
Deletion refuses an unowned provider; unknown source types and gateway errors
remain failures.

For an Agent revision, `attachForRevision` updates each source's profile and returns
its provider name. It fails when two of the Agent revision's sources would use
the same environment variable, and the worker then fails the deployment with
`CREDENTIAL_SOURCE_ENVIRONMENT_CONFLICT` without retrying. The
OpenShell SandboxDriver appends those names to `SandboxSpec.providers`.
`attachmentStatus` calls `GetSandboxProviderStatus` for each provider and maps
OpenShell readiness states to `ready`, `withheld`, `revoked`, `failed`, or
`pending`. `withdraw` calls `DetachSandboxProvider` for the Agent revision's Sandbox,
then reads that receipt's status. Only `REVOKED` reports `revoked`: the
Sandbox's placeholders then stop resolving, even in running processes. OpenShell
reports `REVOKED` once the supervisor sees a running process without the
provider. A Sandbox without a running process (provisioning,
crash-looping) reports `WaitingForProcess`, which stays `pending`. A `recheck`
first calls `GetSandbox`: a Sandbox no longer listing the provider is `revoked`
without a mutation; a listed one is detached again. A missing Sandbox is
`absent` only once `GetWorkspace` answers and a second `GetSandbox` still misses
it (OpenShell hides unauthorized Sandboxes as missing); a refusal fails with
`SANDBOX_GATEWAY_UNAUTHORIZED`.

For API-key Codex, Compute selects a named provider with the source endpoint and
HTTPS Responses transport. Native OpenClaw requires the default OpenAI endpoint.
The Harness receives an `openshell:resolve:env:` placeholder as `OPENAI_API_KEY`
for API keys or `CODEX_ACCESS_TOKEN` for Codex PATs. Codex stores it through native
login; OpenClaw reads it through node-local model configuration. The supervisor
substitutes the credential on matching requests.

## Trust requirements

- **Workspace membership.** Any OpenShell user in a Workspace can attach any
  provider in it. Keep OCC's gateway principal as the only member of OCC
  Workspaces. OpenShell Platform Admins bypass membership in every Workspace, so
  limit that role as well. OCC does not check either.
- **Gateway principal.** OCC's gateway principal must be allowed to manage
  Workspaces, Sandboxes, and providers. Use `bearerTokenFile` and an `https`
  endpoint outside disposable development.
- **Network enforcement.** The guarantee depends on OpenShell's NetworkPolicy,
  which denies workload-initiated connections. The cluster network plugin must
  enforce NetworkPolicy.
- **TLS inspection.** The proxy terminates TLS for the selected profile endpoint,
  so Codex must trust the Sandbox CA that OpenShell provides through `SSL_CERT_FILE`. Do not add an uninspected `tls: skip` policy
  for the selected model endpoint in the Sandbox's `policy.networkPolicies`; it conflicts
  with the profile.
- **Namespaces.** Sources never cross OCC Namespaces.

### What the boundary covers

The boundary keeps the key away from the Harness and ordinary OpenShell reads,
not from OpenShell administrators or OCC itself. With the selected gateway:

- **Covered.** Provider reads and writes return `REDACTED` values. Only the
  Sandbox's own supervisor can fetch provider environments or exchange tokens.
  The separate operator-mTLS export RPC can return runtime credentials to
  OCC; it cannot return refresh material.
  OpenShell withholds a static key that has no credential binding. A Sandbox
  policy cannot add a `credential_binding` for a profile that defines endpoints,
  so changing a Sandbox policy cannot move `OPENAI_API_KEY` off
  the endpoint selected by the source.
- **Commands the Harness runs.** OpenShell matches `binaries` against the
  calling process and its ancestors. A command Codex starts that reads the
  placeholder from an ancestor's environment gets the key inserted at the
  source's endpoint. It cannot read the key or use it elsewhere; other hosts
  answer `403 credential_endpoint_mismatch`. Running Agent tools in a separate
  Sandbox would remove this use.
- **Not covered.** A Platform Admin can create, attach, and exec in Sandboxes in
  any Workspace. A Workspace admin, which includes OCC's gateway principal, can
  update a source's profile to add hosts or binaries while Sandboxes use it,
  so anyone holding the Backend credential can redirect the key. With
  `allow_unauthenticated_users` enabled, every caller that reaches the gateway
  is a Platform Admin; never enable it outside disposable development. The OCC
  worker can read the source's Kubernetes Secret directly.

## Limits

- A running Agent uses an updated static value only after its next deployment.
- The OAuth2 types support the client-credentials and refresh-token grants
  only. Google service accounts, AWS STS, token
  exchange, and other OpenShell source types remain unavailable.
- After an update of an OAuth2 source's material, running Agents lose its
  token within one Sandbox provider poll (10 seconds by default) and receive
  none until they are redeployed.
- OCC does not perform the initial OAuth2 sign-in for a refresh-token source;
  supply the refresh token from a completed sign-in in a Secret.
- Only one OpenShell Backend can be configured.
- While the Namespace's OpenShell gateway is down, running Codex Agents cannot
  serve turns, because their route runs through it. Registration returns `503`
  and deployments wait until it is back.

## Verification

The [OpenShell real Sandbox suite](../../testing/openshell-coverage.md) checks
model and tool-source delivery, credential routing, untrusted upstreams, outages,
and withdrawal through the API and a dedicated Codex Agent. That page records
proof limits. The Sandbox Driver startup integration covers Backend membership
and selection rules.

## Troubleshooting

| Symptom or message                                                                                | Cause and fix                                                                                                                                 |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `drivers.credential_gateway requires an owning backend entry with type openshell.`                | Add the `openshell` Backend.                                                                                                                  |
| `backend[…].drivers.credential_gateway must match …`                                              | Make the Backend member IDs match the selected Driver IDs.                                                                                    |
| `OpenShell Credential Gateway binaries must be a nonempty list of absolute paths.`                | Correct `binaries`.                                                                                                                           |
| Registering, updating, or deploying `bearer-token` returns `409`: the gateway does not offer it   | Configure `toolBinaries`.                                                                                                                     |
| Registering, updating, or deploying an OAuth2 type returns `409`: the gateway does not offer it   | Configure `toolBinaries` and select `drivers.credential_refresh` on the same Backend.                                                         |
| OAuth2 registration returns `503` with `oauth_token_endpoint_unavailable`                         | Let the gateway Pod reach `token_url`, and mount a bundle with the issuer's CA over its `SSL_CERT_FILE`.                                      |
| After a gateway restart, an OAuth2 source reports `failed` with `refresh_configuration_invalid`   | OpenShell retries it an hour later ([NVIDIA/OpenShell#4526](https://github.com/NVIDIA/OpenShell/issues/4526)). Rotate the source to mint now. |
| A tool request reaches the endpoint with the placeholder, or OpenShell denies it                  | Call it from a `toolBinaries` executable, at the source's exact host, port, and path.                                                         |
| Deployment fails with `CREDENTIAL_SOURCE_ENVIRONMENT_CONFLICT`                                    | Two sources share a variable. Bind one `openai` source; give each `bearer-token` a distinct `env_var`.                                        |
| Model requests fail with `403` "A credential placeholder in the request body cannot be forwarded" | A tool printed a placeholder into the conversation. Start a new thread, and avoid printing credential variables.                              |
| Registration returns `503`                                                                        | Check that the API reaches the gateway, the token file is mounted, and the Workspace exists.                                                  |
| Registration returns `404` for a name conflict                                                    | A provider named for this source exists without OCC's labels. Remove it in OpenShell, then retry.                                             |
| The Agent revision stays inactive with a `failed` or `withheld` attachment                        | Check the provider in OpenShell and the Sandbox's `GetSandboxProviderStatus` reason.                                                          |
| Deployment fails with `RUNTIME_MODEL_PROBE_FAILED` or `RUNTIME_AUTHENTICATION_FAILED`             | Confirm `binaries` names the selected Harness executable (Codex or Node), the Harness trusts the Sandbox CA, and the credential is valid.     |

## Related

- [CredentialGatewayDriver contract](credential-gateway.md) and [CredentialRefreshDriver contract](credential-refresh.md)
- [OpenShell SandboxDriver](openshell-sandbox.md)
- [Credential source lifecycle flow](../../flows/credential-source-lifecycle.md)
- [OpenShell Sandbox provisioning flow](../../flows/openshell-sandbox-provisioning.md)
- [Driver source](../../../apps/controller/src/drivers/credential-gateway/openshell.ts), [refresh source](../../../apps/controller/src/drivers/credential-refresh/openshell.ts), and [Backend source](../../../apps/controller/src/backends/openshell.ts)
