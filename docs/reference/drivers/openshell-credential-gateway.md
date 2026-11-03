# OpenShell Credential Gateway

The [Credential Gateway](credential-gateway.md) stores OCC [credential sources](../credential-sources.md)
as OpenShell providers. The Harness uses placeholders; the trusted supervisor
adds credentials to matching upstream requests.
Select it with the [OpenShell SandboxDriver](openshell-sandbox.md) on one `openshell`
[Backend](../backends.md#openshell-gateway).

**OpenShell remains unsupported for production.** Workload identity, writable state,
authentication, admission, and provider-file proof follow the
[OpenShell qualification contract](openshell-sandbox.md#qualification-contract).

[Follow a Codex request from placeholder to upstream header](#follow-a-codex-request-through-openshell).

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

Binary-list changes apply on update, deployment or repair; until success,
removed binaries retain access and deployment stays pending. To stop use in a
running Sandbox, withdraw the attachment and check its status. Mixed-version replicas can overwrite lists.
Removing `toolBinaries` returns `409 RESOURCE_CONFLICT` for tool-source
registration, update, deployment and repair: OpenShell treats empty lists as any
binary. Existing sources remain readable and deletable.

Startup rejects the selection when:

- the Installation does not select the bundled Kubernetes Compute Driver;
- no `openshell` Backend exists, or its `drivers.credential_gateway`,
  `drivers.sandbox`, or `drivers.credential_refresh` differs from the selected
  IDs;
- `drivers.credential_refresh` is selected without `drivers.credential_gateway`; or
- the configuration has any key other than `binaries` and `toolBinaries`.

Both API and worker require Backend credentials. The API registers/deletes
providers; the worker creates Sandboxes, updates profiles and reads attachment
status. The Refresh Driver owns device exchange and refresh configuration.

## Source-type catalog

| Type                         | Secret fields                               | Config fields                                                                   | Rotation  | Harness authentication         |
| ---------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------- | --------- | ------------------------------ |
| `openai`                     | `api_key` (required)                        | `base_url` (optional)                                                           | `none`    | `openai` / `api_key`           |
| `codex-pat`                  | `access_token` (required)                   | None                                                                            | `none`    | `openai` / `codex_pat`         |
| `codex-oauth` (Experimental) | None; device login                          | None                                                                            | `refresh` | `openai` / `chatgptAuthTokens` |
| `bearer-token`               | `token` (required)                          | `host`, `env_var` (required); `port`, `path`                                    | `none`    | None (tool credential)         |
| `oauth2-client-credentials`  | `client_secret` (required)                  | `host`, `env_var`, `token_url`, `client_id` (required); `port`, `path`, `scope` | `refresh` | None (tool credential)         |
| `oauth2-refresh-token`       | `refresh_token` (required); `client_secret` | `host`, `env_var`, `token_url`, `client_id` (required); `port`, `path`, `scope` | `refresh` | None (tool credential)         |

Personal and service-account Codex PATs use `CODEX_ACCESS_TOKEN` over HTTPS:

- `auth.openai.com/api/accounts/v1/user-auth-credential/whoami`.
- `chatgpt.com/backend-api/codex/**`.
- `chatgpt.com/backend-api/wham/config/bundle`.
- `chatgpt.com/backend-api/wham/accounts/check`.
- `chatgpt.com/backend-api/wham/settings/user`.
- `chatgpt.com/backend-api/wham/usage`.
- `GET /backend-api/ps/plugins/*` and `POST /backend-api/ps/plugins/*/install`
  on `chatgpt.com` for catalog/search, installed-state, detail, and installation requests.
- `POST /backend-api/ps/apps/batch` on `chatgpt.com` for app metadata lookup.
- `POST /backend-api/ps/mcp` on `chatgpt.com` for native hosted-app MCP transport.

`*` matches one path segment; GET includes HEAD. These source-wide routes apply
to all Agents using the source. The MCP rule does not filter apps or tools or
enforce read-only access; native managed policy enforces Agent selections and
approvals. Direct Plugin Service sharing, suggestions and uninstall routes remain
denied. Package downloads use separate credential-free egress. Other routes remain denied.

The Harness stores only an opaque `personal_access_token`. Readiness requires
native login and model execution
([bootstrap flow](../../flows/openshell-sandbox-provisioning.md#2-derive-the-provider-owned-harness-request)).

`openai` defaults to `https://api.openai.com/v1`. Custom HTTPS endpoints must end in `/v1`, optionally after a prefix such as `/api`. Codex requires Responses; dedicated native OpenClaw uses the API selected in its explicit model catalog. Every selected native model endpoint must match the bound source endpoint, including its path. Before Secret reads or persistence, `400 INVALID_REQUEST` rejects wildcards, port `0`, an `@` or credentials, spaces, controls, a missing `//`, queries, fragments, and a host that is not an exact DNS name, as for `bearer-token`. OCC stores the normalized, immutable endpoint; register a new source to change it.

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

The experimental `codex-oauth` type, its operator TLS, token custody and WIP boundaries
are described in [Experimental Codex OAuth PoC](openshell-credential-gateway/codex-oauth-poc.md).

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

<a id="how-sources-map-to-openshell"></a>

## Follow a Codex request through OpenShell

For a dedicated Codex Agent with an `openai` source at the default endpoint:

1. **Inside the Sandbox.** `OPENAI_API_KEY` contains an opaque placeholder.
   Codex uses that value for native login. Its request to
   `POST https://api.openai.com/v1/responses` carries
   `Authorization: Bearer openshell:resolve:env:…` (placeholder abbreviated).
2. **At the supervisor.** OpenShell inspects TLS and matches the calling binary
   or an ancestor, host, port and path against the source profile.
3. **At the provider.** The same request arrives with
   `Authorization: Bearer <source API key>`. The Harness never needs the substituted value.

Ordinary delivery grants use of the key on the profile's route. A child process
of the configured binary can use it too. The profile neither authorizes a
specific inference body nor filters the response for that caller.

**Online GitHub preview.** On OpenShell 0.1.5/0.1.6, the opt-in `github-installation`
profile verifies a one-use denial in the selected workspace at startup. Later
enforcement remains unverified. [Protected Git profiles](../repository-credentials/protected-openshell-git.md)

**Protected delivery** binds the request and response recipient to the execution.
OCC checks authority before releasing material and before authorizing the send.
The qualified sender enforces the [response policy](../credential-sources/protected-inference.md#static-source-and-response-policy).
For Git, the bundled Proxy verifies the mandatory pre-credentials binding and launcher
denial for selected repository sets or a single ref-limited `git-write` grant.
[Delivery profiles](credential-proxy.md#delivery-profiles)

### Provider and Sandbox state

Compute placement selects the operator-mode Workspace named for the Kubernetes
namespace. Registration and Sandbox creation use that same Workspace.

- **One provider profile per source.** Its ID equals the provider name; a content
  digest drives registration/update/deployment reconciliation. The
  [source catalog](#source-type-catalog) defines credentials and endpoints;
  `binaries` restricts inference sources and `toolBinaries` restricts tool sources.
  The Refresh Driver owns issuer exchange and refresh configuration.
- **One provider per source.** Its name is `oce-cs-` plus 24 hexadecimal characters
  of the source ID's SHA-256. Labels identify OCC ownership, source and Namespace;
  `profile_workspace` names its workspace. Registration checks ownership/type
  before profile mutation and again on creation collision. These calls are not
  atomic: a provider or orphan profile can change between them.

`sourceStatus` reports `ready` for an owned provider, `absent` for a missing one,
and `failed` for a same-name provider the source does not own.
Refresh reports `pending` during `refresh_in_progress`/`refresh_committing`.
A persistent uncertain marker requires inspection; OCC neither replays the
exchange nor reseeds credentials.

`updateSource` verifies exact source ownership, reconciles changed binary lists,
then calls `UpdateProvider`. That operation merges non-empty values, so the
Driver rejects empty values. Only processes started after the update receive
the new value; restart a running Harness to apply it.

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

Compute selects a named HTTPS Responses provider for API-key Codex. For a
source-backed PAT, startup writes the placeholder to the native auth file and
runs `codex login status`. Native OpenClaw reads its API-key placeholder through
node-local model configuration. Every catalog model uses the source endpoint and configured API selector.

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

The Harness, child processes and administrators have different access:

- **Covered.** Provider reads and writes return `REDACTED` values. Only the
  Sandbox's own supervisor can fetch provider environments or exchange tokens.
  The separate operator-mTLS export RPC can return runtime credentials to
  OCC; it cannot return refresh material.
  OpenShell withholds a static key that has no credential binding. A Sandbox
  policy cannot add a `credential_binding` for a profile that defines endpoints,
  so changing a Sandbox policy cannot move `OPENAI_API_KEY` off
  the endpoint selected by the source.
- **Commands the Harness runs.** OpenShell matches `binaries` against the
  calling process and its ancestors. A command Codex starts can use an inherited
  placeholder at the source endpoint. Other hosts return `403 credential_endpoint_mismatch`.
  A separate tool Sandbox would remove this inherited access.
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

| Symptom or message                                                                                | Cause and fix                                                                                                                             |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `drivers.credential_gateway requires an owning backend entry with type openshell.`                | Add the `openshell` Backend.                                                                                                              |
| `backend[…].drivers.credential_gateway must match …`                                              | Make the Backend member IDs match the selected Driver IDs.                                                                                |
| `OpenShell Credential Gateway binaries must be a nonempty list of absolute paths.`                | Correct `binaries`.                                                                                                                       |
| Registering, updating, or deploying `bearer-token` returns `409`: the gateway does not offer it   | Configure `toolBinaries`.                                                                                                                 |
| Registering, updating, or deploying an OAuth2 type returns `409`: the gateway does not offer it   | Configure `toolBinaries` and select `drivers.credential_refresh` on the same Backend.                                                     |
| OAuth2 registration returns `503` with `oauth_token_endpoint_unavailable`                         | Let the gateway Pod reach `token_url`, and mount a bundle with the issuer's CA over its `SSL_CERT_FILE`.                                  |
| A tool request reaches the endpoint with the placeholder, or OpenShell denies it                  | Call it from a `toolBinaries` executable, at the source's exact host, port, and path.                                                     |
| Deployment fails with `CREDENTIAL_SOURCE_ENVIRONMENT_CONFLICT`                                    | Two sources share a variable. Bind one `openai` source; give each `bearer-token` a distinct `env_var`.                                    |
| Model requests fail with `403` "A credential placeholder in the request body cannot be forwarded" | A tool printed a placeholder into the conversation. Start a new thread, and avoid printing credential variables.                          |
| Registration returns `503`                                                                        | Check that the API reaches the gateway, the token file is mounted, and the Workspace exists.                                              |
| Registration returns `404` for a name conflict                                                    | A provider named for this source exists without OCC's labels. Remove it in OpenShell, then retry.                                         |
| The Agent revision stays inactive with a `failed` or `withheld` attachment                        | Check the provider in OpenShell and the Sandbox's `GetSandboxProviderStatus` reason.                                                      |
| Deployment fails with `RUNTIME_MODEL_PROBE_FAILED` or `RUNTIME_AUTHENTICATION_FAILED`             | Confirm `binaries` names the selected Harness executable (Codex or Node), the Harness trusts the Sandbox CA, and the credential is valid. |

## Related

- [CredentialGatewayDriver contract](credential-gateway.md) and [CredentialRefreshDriver contract](credential-refresh.md)
- [OpenShell SandboxDriver](openshell-sandbox.md)
- [Credential source lifecycle flow](../../flows/credential-source-lifecycle.md)
- [OpenShell Sandbox provisioning flow](../../flows/openshell-sandbox-provisioning.md)
- [Driver source](../../../apps/controller/src/drivers/credential-gateway/openshell.ts), [refresh source](../../../apps/controller/src/drivers/credential-refresh/openshell.ts), and [Backend source](../../../apps/controller/src/backends/openshell.ts)
