# OpenShell Credential Gateway

The bundled OpenShell Credential Gateway stores OCC
[credential sources](../credential-sources.md) as OpenShell providers. The
OpenShell supervisor applies them at its egress proxy, so the dedicated Codex
Harness never receives the real model key. It implements the
[CredentialGatewayDriver contract](credential-gateway.md) and works only with the
[OpenShell SandboxDriver](openshell-sandbox.md), through one shared `openshell`
[Backend](../backends.md#openshell-gateway).

**This Driver does not make OpenShell a supported production path.** It removes
the model API key from the Harness. Workload identity, writable state, gateway
authentication, admission, and provider-file proof remain subject to the
[OpenShell qualification contract](openshell-sandbox.md#qualification-contract).

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
        mode: bearerTokenFile
        path: /etc/openclaw/openshell/token
      rootCertificatePath: /etc/openclaw/openshell/ca.crt
    drivers:
      sandbox: openshell-sandbox
      credential_gateway: openshell-credentials
      credential_refresh: openshell-refresh # enables OAuth2 and Codex device types
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
      toolBinaries:
        - /usr/bin/curl
  credential_refresh:
    id: openshell-refresh
    configuration: {}
```

`binaries` is required and closed: a nonempty list of absolute executable paths
inside the Harness image. OpenShell releases a credential only to requests made
by those binaries. Use the exact native Codex executable, not a wrapper script.
A stale path fails the Codex startup model probe: the deployment fails with
`RUNTIME_MODEL_PROBE_FAILED`, or `RUNTIME_AUTHENTICATION_FAILED` when the provider
rejects the missing credential, and the active revision keeps serving.

`toolBinaries` is optional: a nonempty list of absolute paths inside the Sandbox
image that may carry [tool sources](../credential-sources.md#bind-a-source-to-an-agent)
to their endpoints, such as `/usr/bin/curl`. Without it the catalog omits
`bearer-token` and the OAuth2 types.

`drivers.credential_refresh` is optional and takes an empty configuration. It
selects the bundled [Credential Refresh](credential-refresh.md) implementation,
which must be the same Backend's `credential_refresh` member. With it and
`toolBinaries`, the catalog adds the OAuth2 types.

Changing binary lists rewrites profiles on the next update, deployment, or
repair; until that succeeds, removed binaries retain access and deployment stays
pending. To cut access immediately, withdraw or delete the source. Mixed-version
controller replicas can overwrite each other's lists. Removing `toolBinaries`
blocks new use of tool sources (`409`) because OpenShell treats an empty list as
any binary; existing sources remain readable and deletable.

Startup rejects the selection when:

- the Installation does not select the bundled Kubernetes Compute Driver;
- no `openshell` Backend exists, or its `drivers.credential_gateway`,
  `drivers.sandbox`, or `drivers.credential_refresh` differs from the selected
  IDs;
- `drivers.credential_refresh` is selected without `drivers.credential_gateway`; or
- the configuration has any key other than `binaries` and `toolBinaries`.

The API and worker share the Backend connection; the selected Refresh Driver
owns device exchange and refresh configuration. The API registers and deletes providers; the worker creates
Sandboxes, updates provider profiles, and reads attachment status. Allow both to
reach the gateway.

## Source-type catalog

| Type                         | Secret fields                               | Config fields                                                                   | Rotation  | Harness authentication         |
| ---------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------- | --------- | ------------------------------ |
| `openai`                     | `api_key` (required)                        | None                                                                            | `none`    | `openai` / `api_key`           |
| `codex-oauth` (Experimental) | None; device login                          | None                                                                            | `refresh` | `openai` / `chatgptAuthTokens` |
| `bearer-token`               | `token` (required)                          | `host`, `env_var` (required); `port`, `path`                                    | `none`    | None (tool credential)         |
| `oauth2-client-credentials`  | `client_secret` (required)                  | `host`, `env_var`, `token_url`, `client_id` (required); `port`, `path`, `scope` | `refresh` | None (tool credential)         |
| `oauth2-refresh-token`       | `refresh_token` (required); `client_secret` | `host`, `env_var`, `token_url`, `client_id` (required); `port`, `path`, `scope` | `refresh` | None (tool credential)         |

Config for `bearer-token` and the OAuth2 types is checked before any gateway
call:

- `host` is an exact lowercase DNS name, not an IP address or wildcard.
- `port` is 1 to 65535 and defaults to `443`.
- `path` is an absolute path pattern and defaults to `/**`.
- `env_var` names the Sandbox variable that holds the placeholder. It is upper
  case and cannot be `OPENAI_API_KEY`, `PATH`, `HOME`, `USER`, `SHELL`, or
  `LANG`, or start with `CODEX_`, `OCE_`, `OPENCLAW_`, or `OPENSHELL_`.
- `token_url` is an absolute `https` URL without credentials, query, or
  fragment. OpenShell refuses a plain-HTTP token endpoint.
- `client_id` is 1 to 256 visible characters, and `scope` is space-separated
  OAuth2 scopes.

The workload sends the placeholder itself, for example
`curl -H "Authorization: Bearer $API_TOKEN" https://api.example.com/v1/items`.
The proxy substitutes the token only on requests from `toolBinaries` to the
source's endpoint. Never put a placeholder, or its `openshell:resolve:env:` prefix, into the model conversation:
OpenShell refuses a model request whose body carries one, so the Agent's turns
fail until that history is gone.

Other OpenShell provider types are not in the catalog, so registration rejects
them.

### Experimental Codex OAuth PoC

The `codex-oauth` type requires OpenShell's upstream `GetProviderCredentials`
RPC and matching gateway/supervisor support for identity-bound JWT placeholder aliases.
Select `credential_refresh` on this Backend to offer the source. The stock pinned
images do not provide this complete integration. See
[OAuth test setup](../../testing/openshell-oauth.md) for revision and image selection.

The Backend retains ordinary authentication for Workspace, provider, refresh,
and Sandbox operations. Access-token retrieval alone uses `operatorTls`: a direct
client certificate from the gateway's trusted CA with exact `OU=operator` and
`openshell.gateway.mtls_auth.operator_enabled` enabled. Neither bearer headers
nor forwarded identity are accepted on that channel. The certificate grants
gateway-wide authority; protect its key. OCC still authorizes exact source use
and rechecks before the callback. Namespace-scoped OpenShell identities remain
deferred.

The paired Refresh Driver performs device exchange and hands refresh material
to OpenShell; OCC retains only an opaque session. The Gateway's `withSourceToken`
requests five minutes of remaining access-token lifetime. OpenShell may refresh
to satisfy retrieval and durably retains successor tokens. Only access credentials
enter the callback, never the Console. Cancellation cannot guarantee server-side
refresh stops. Revisions reuse the source's account metadata and placeholder.

The Sandbox wraps its issued placeholder as a JWT while OpenShell enforces
provider identity, revocation, endpoint binding, and expiry. Selected runtime
plugins remain unsupported; directory discovery does not prove execution. See
[OAuth storage](kubernetes-compute/codex-oauth-storage.md).

#### WIP boundaries

- **JWT placeholders.** The Sandbox wrapper requires the fork's alias resolver.
  Align with upstream support while preserving provider identity and the
  Harness's `chatgptAuthTokens` contract.
- **Connection recovery and metadata.** Grant configuration and account metadata
  are separate writes; interrupted handoff may require reconnecting. Metadata
  is a login-time snapshot, so account changes require a new login and revision.

## OAuth2 refresh sources

The paired [Credential Refresh Driver](credential-refresh.md) configures the
profile-declared issuer, holds refresh material, and mints the provider's first
token. OpenShell refreshes it before expiry; the supervisor injects each new
token without restarting the Harness. Configuration, rotation, status, deletion,
and failure recovery belong to that Driver. Reconfiguration starts a new
authorization epoch and requires redeploying existing Agents.

The gateway must reach and trust the issuer. Preserve public roots when adding
a private issuer CA; see [issuer trust setup](../../testing/openshell-oauth.md#prepare-the-custom-images-and-trust).

## How sources map to OpenShell

Each OCC Namespace maps to one operator-mode OpenShell Workspace with the same
name as its Kubernetes namespace. The Driver manages two objects in that
Workspace:

- **Provider profile `oce-openai`.** Registration imports this profile when
  missing. It exposes the credential as `OPENAI_API_KEY`, inserts it as a bearer
  `authorization` header, and binds it to `api.openai.com:443` with `rest`
  protocol and path `/v1/**`, for the configured binaries only. A digest
  annotation records the profile content; a configuration change updates the
  profile on the next registration, update, or deployment.
- **Provider profile per `bearer-token` source.** Its ID equals the source's
  provider name. It exposes the token as the source's `env_var` and binds it to
  the source's `host`, `port`, and `path` with `rest` protocol, for
  `toolBinaries` only. `removeSource` deletes it with the provider.
- **One provider per source.** The name is `oce-cs-` followed by 24 hexadecimal
  characters of the SHA-256 digest of the source ID. Labels record OCC
  ownership, the source ID, and the Namespace ID. The provider's
  `profile_workspace` names its own workspace, where OCC imported the profile. A
  retried registration adopts an existing provider only when those labels match;
  otherwise it fails.
- **Workspace.** OCC resolves the Namespace's workspace from Compute's runtime
  placement, so registration uses the same workspace as the paired Sandbox.

`sourceStatus` reports `ready` for an owned provider, `absent` when it is
missing, and `failed` when a provider with that name is not owned by the source.
The paired Refresh Driver reports `pending` during `refresh_in_progress` or
`refresh_committing`, including device polling. If an uncertain refresh marker
persists, inspect OpenShell status for operator recovery; OCC does not replay
the exchange or reseed credentials.

`updateSource` requires the existing provider to be OCC-owned for the exact
source, rewrites the source's profile when the configured binaries changed,
then calls `UpdateProvider` with the new credential values.
`UpdateProvider` merges non-empty values into the provider, so the driver
rejects an empty value rather than silently keep the old one. OpenShell gives
the new value only to processes started after the update, so a running Harness
keeps the previous value until it restarts.

`removeSource` deletes the owned provider and confirms that it is gone. When no
provider of the profile's type remains, it also deletes the profile, because
OpenShell cannot delete a Workspace that still holds profiles.

For a revision, `attachForRevision` brings each source's profile up to date and
returns its provider name. It fails when two of the revision's sources would use
the same environment variable, and the worker then fails the deployment with
`CREDENTIAL_SOURCE_ENVIRONMENT_CONFLICT` without retrying. The
OpenShell SandboxDriver appends those names to `SandboxSpec.providers`.
`attachmentStatus` calls `GetSandboxProviderStatus` for each provider and maps
OpenShell readiness states to `ready`, `withheld`, `revoked`, `failed`, or
`pending`. `withdraw` calls `DetachSandboxProvider` for the revision's Sandbox,
then reads the status of that detach receipt. Only `REVOKED` reports `revoked`:
the Sandbox's placeholders then stop resolving, even in running processes.
OpenShell reports `REVOKED` only after the Sandbox supervisor reports a running
process with the provider removed. A Sandbox with no running process, for
example one still provisioning or crash-looping, reports `WaitingForProcess`,
which stays `pending`. A missing Sandbox reports `absent`. A `recheck` first
calls `GetSandbox`: a missing Sandbox reports `absent`, one that no longer lists
the provider in `SandboxSpec.providers` reports `revoked` without a mutation,
and only a listed provider is detached again.

In the running Sandbox, the Harness environment holds only an
`openshell:resolve:env:` placeholder for `OPENAI_API_KEY`. `codex login
--with-api-key` stores that placeholder, and the supervisor proxy substitutes the
real key on matching requests.

## Trust requirements

- **Workspace membership.** Any OpenShell user in a Workspace can attach any
  provider in it. Keep OCC's gateway principal as the only member of OCC
  Workspaces. OpenShell Platform Admins bypass membership in every Workspace, so
  limit that role as well. OCC does not check either.
- **Gateway principal.** The API and worker share the Backend credential. That
  principal must be allowed to manage Workspaces, Sandboxes, and providers.
  Use `bearerTokenFile` and an `https` endpoint outside disposable development.
- **Network enforcement.** The guarantee depends on OpenShell's NetworkPolicy,
  which denies workload-initiated connections. The cluster network plugin must
  enforce NetworkPolicy.
- **TLS inspection.** The proxy terminates TLS for the profile endpoint, so Codex
  must trust the Sandbox CA that OpenShell provides through `SSL_CERT_FILE`. The
  Codex startup probe keeps `SSL_CERT_FILE` and `SSL_CERT_DIR` in its otherwise
  minimal environment for this reason. Do not add an uninspected `tls: skip` policy
  for `api.openai.com` in the Sandbox's `policy.networkPolicies`; it conflicts
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
  `api.openai.com`.
- **Not covered.** A Platform Admin can create, attach, and exec in Sandboxes in
  any Workspace. A Workspace admin, which includes OCC's gateway principal, can
  update the `oce-openai` profile to add hosts or binaries while Sandboxes use
  it, so anyone holding the Backend credential can redirect the key. With
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
  none until they are redeployed. Rotation and background refresh need
  no redeploy.
- OCC does not perform the initial OAuth2 sign-in for a refresh-token source;
  supply the refresh token from a completed sign-in in a Secret.
- A `bearer-token` or OAuth2 source binds one endpoint, and the workload must
  place the placeholder in the request itself.
- Codex OAuth requires the upstream gateway API and alias-enabled runtimes described above.
- Only one OpenShell Backend can be configured.

## Verification

The [OpenShell real Sandbox suite](../../testing/openshell.md#openshell-sandbox)
registers a source through the API, deploys a dedicated Codex Agent that uses it,
and checks that every Harness process sees only the placeholder. It also binds a
`bearer-token` source to an in-cluster endpoint, proves the substituted token
arrives, and withdraws it from the running Agent while model turns continue. The Sandbox
Driver startup integration covers Backend membership and selection rules.

## Troubleshooting

| Symptom or message                                                                                | Cause and fix                                                                                                    |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `drivers.credential_gateway requires an owning backend entry with type openshell.`                | Add the `openshell` Backend.                                                                                     |
| `backend[…].drivers.credential_gateway must match …`                                              | Make the Backend member IDs match the selected Driver IDs.                                                       |
| `OpenShell Credential Gateway binaries must be a nonempty list of absolute paths.`                | Correct `binaries`.                                                                                              |
| Registering, updating, or deploying `bearer-token` returns `409`: the gateway does not offer it   | Configure `toolBinaries`.                                                                                        |
| Registering, updating, or deploying an OAuth2 type returns `409`: the gateway does not offer it   | Configure `toolBinaries` and select `drivers.credential_refresh` on the same Backend.                            |
| OAuth2 registration returns `503` with `oauth_token_endpoint_unavailable`                         | Let the gateway Pod reach `token_url`, and mount a bundle with the issuer's CA over its `SSL_CERT_FILE`.         |
| A tool request reaches the endpoint with the placeholder, or OpenShell denies it                  | Call it from a `toolBinaries` executable, at the source's exact host, port, and path.                            |
| Deployment fails with `CREDENTIAL_SOURCE_ENVIRONMENT_CONFLICT`                                    | Two sources share a variable. Bind one `openai` source; give each `bearer-token` a distinct `env_var`.           |
| Model requests fail with `403` "A credential placeholder in the request body cannot be forwarded" | A tool printed a placeholder into the conversation. Start a new thread, and avoid printing credential variables. |
| Registration returns `503`                                                                        | Check that the API reaches the gateway, the token file is mounted, and the Workspace exists.                     |
| Registration returns `404` for a name conflict                                                    | A provider named for this source exists without OCC's labels. Remove it in OpenShell, then retry.                |
| The revision stays inactive with a `failed` or `withheld` attachment                              | Check the provider in OpenShell and the Sandbox's `GetSandboxProviderStatus` reason.                             |
| Deployment fails with `RUNTIME_MODEL_PROBE_FAILED` or `RUNTIME_AUTHENTICATION_FAILED`             | Confirm `binaries` names the exact Codex executable, Codex trusts the Sandbox CA, and the key is valid.          |

## Related

- [CredentialGatewayDriver contract](credential-gateway.md) and [CredentialRefreshDriver contract](credential-refresh.md)
- [OpenShell SandboxDriver](openshell-sandbox.md)
- [Credential source lifecycle flow](../../flows/credential-source-lifecycle.md)
- [OpenShell Sandbox provisioning flow](../../flows/openshell-sandbox-provisioning.md)
- [Driver source](../../../apps/controller/src/drivers/credential-gateway/openshell.ts), [refresh source](../../../apps/controller/src/drivers/credential-refresh/openshell.ts), and [Backend source](../../../apps/controller/src/backends/openshell.ts)
