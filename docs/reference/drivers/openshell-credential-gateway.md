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
trusted Installation YAML. All three IDs must match:

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
      credential_refresh: openshell-refresh # optional; enables OAuth2 types
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
The development profile lists the pinned runtime's x64 and ARM64 executables;
it does not infer the container architecture from the launcher host.
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

Changing either list rewrites existing profiles lazily, not at startup. A
source's profile changes on its next update or on the next deployment or repair
of a revision that binds it; until that write succeeds, the deployment stays
pending. OpenShell builds Sandbox policy from the stored profile, so a narrower
list then applies to running Sandboxes within seconds. Until then a removed
binary keeps access; to cut it at once, withdraw the source or delete it. During
a controller rollout, replicas with different lists may rewrite a profile in
turn; the last write wins. Removing `toolBinaries` entirely blocks
registrations, updates, deployments, and repairs of `bearer-token` sources,
because OpenShell treats an empty binary list as any binary. Registration,
update, and deployment requests then answer `409 RESOURCE_CONFLICT` naming the
fix. Existing providers
and profiles stay until you withdraw or delete them; status and deletion keep
working.

Startup rejects the selection when:

- the Installation does not select the bundled Kubernetes Compute Driver;
- no `openshell` Backend exists, or its `drivers.credential_gateway`,
  `drivers.sandbox`, or `drivers.credential_refresh` differs from the selected
  IDs;
- `drivers.credential_refresh` is selected without `drivers.credential_gateway`; or
- the configuration has any key other than `binaries` and `toolBinaries`.

Both the API and the worker connect to the gateway with the Backend's
credentials. The API registers and deletes providers; the worker creates
Sandboxes, updates provider profiles, and reads attachment status. Allow both to
reach the gateway.

## Source-type catalog

| Type                        | Secret fields                               | Config fields                                                                   | Rotation  | Harness authentication |
| --------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------- | --------- | ---------------------- |
| `openai`                    | `api_key` (required)                        | `base_url` (optional)                                                           | `none`    | `openai` / `api_key`   |
| `bearer-token`              | `token` (required)                          | `host`, `env_var` (required); `port`, `path`                                    | `none`    | None (tool credential) |
| `oauth2-client-credentials` | `client_secret` (required)                  | `host`, `env_var`, `token_url`, `client_id` (required); `port`, `path`, `scope` | `refresh` | None (tool credential) |
| `oauth2-refresh-token`      | `refresh_token` (required); `client_secret` | `host`, `env_var`, `token_url`, `client_id` (required); `port`, `path`, `scope` | `refresh` | None (tool credential) |

`openai` defaults to `https://api.openai.com/v1`. Custom HTTPS endpoints may have a prefix such as `/api/v1` and must support Responses. Hostname and path wildcards, port `0`, URL credentials, queries, and fragments are rejected before Secret reads or persistence with `400 INVALID_REQUEST`. The Driver also rejects bracketed IPv6 hosts, which OpenShell treats as patterns. The endpoint is immutable; register a new source to change it.

Invalid `bearer-token` and OAuth2 values return field-specific `400` before Secret
reads or persistence:

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

Registration rejects provider types outside this catalog.

## OAuth2 refresh sources

OpenShell's gateway mints the OAuth2 types' access tokens itself and replaces
each one before it expires. The Sandbox's placeholder never changes, so a
running Harness presents the new token without a restart. The bundled
Credential Refresh Driver sets up that refresh on the provider this gateway
registers:

- **Profile.** The source's profile declares the refresh strategy,
  `token_url`, and refresh-material names on its `access_token` credential.
  OpenShell accepts a token endpoint only from a profile.
- **Provider.** Registration creates the provider with no credential value.
  The Credential Refresh Driver then calls `ConfigureProviderRefresh` with
  `client_id`, `scope`, and the source's secrets, and `RotateProviderCredential`
  to mint the first token. `GetProviderRefreshStatus` supplies the source's
  `status.refresh`, and `DeleteProviderRefresh` removes the material.
- **Issuer trust.** The gateway, not the Sandbox, calls `token_url`. It must
  trust the issuer's TLS certificate and reach it through the gateway Pod's
  NetworkPolicy. The gateway image sets `SSL_CERT_FILE` to
  `/etc/ssl/certs/ca-certificates.crt` and trusts only that file. For a private
  CA, put the public roots and that CA in one ConfigMap bundle and mount it over
  that path with the OpenShell chart's `server.extraVolumes` and
  `server.extraVolumeMounts`. A file added elsewhere in `/etc/ssl/certs` is
  ignored.
- **Request IDs.** Configure and rotate calls carry a UUID that OpenShell
  replays for 24 hours, so a retried call is not applied twice.

The supervisor picks up re-minted tokens on its provider poll (every 10 seconds
by default); running processes then present them. Reconfiguring refresh material
starts a new OpenShell authorization epoch, revoking running Sandboxes’ placeholders.

## How sources map to OpenShell

Each OCC Namespace maps to one operator-mode OpenShell Workspace with the same
name as its Kubernetes namespace. The Driver manages two objects in that
Workspace:

- **Endpoint-specific `openai` profile.** Registration imports `oce-openai` for the default endpoint or a profile ID derived from a custom normalized URL. It inserts the key as a bearer `authorization` header only for the configured binaries and endpoint host, port, and base path followed by `/**`. A digest annotation records profile content; configuration changes update it on registration, update, or deployment.
- **Profile per `bearer-token` source.** Its ID equals the provider name. It exposes the token through its `env_var` and binds it to the configured host, port, and path for `toolBinaries`. Removal deletes the profile with its provider.
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

`updateSource` requires the existing provider to be OCC-owned for the exact
source, rewrites the source's profile when the configured binaries changed,
then calls `UpdateProvider` with the new credential values.
`UpdateProvider` merges non-empty values into the provider, so the driver
rejects an empty value rather than silently keep the old one. OpenShell gives
the new value only to processes started after the update, so a running Harness
keeps the previous value until it restarts.

`removeSource` deletes the owned provider and confirms that it is gone. When no
provider using that endpoint profile remains, it also deletes the profile, because
OpenShell cannot delete a Workspace that still holds profiles.

An invalid persisted OpenAI endpoint cannot identify an owned profile. If the gateway confirms that the source's provider is absent, deletion leaves profiles alone and removes the OCC record. If a provider exists, status is `failed` and deletion refuses to guess ownership. Unknown types and gateway errors also remain failures.

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

For Codex, Compute selects a named compatible provider with the source endpoint
and HTTPS Responses transport. Other existing Harness consumers retain their
default OpenAI endpoint limit. In the running
Sandbox, the Harness environment holds only an
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
- **TLS inspection.** The proxy terminates TLS for the selected profile endpoint,
  so Codex must trust the Sandbox CA that OpenShell provides through `SSL_CERT_FILE`. The
  Codex startup probe keeps `SSL_CERT_FILE` and `SSL_CERT_DIR` in its otherwise
  minimal environment for this reason. Do not add an uninspected `tls: skip` policy
  for the selected model endpoint in the Sandbox's `policy.networkPolicies`; it conflicts
  with the profile.
- **Namespaces.** Sources never cross OCC Namespaces.

### What the boundary covers

The boundary keeps the key away from the Harness and from ordinary OpenShell
reads, not from OpenShell administrators or OCC itself. On the pinned OpenShell
revision:

- **Covered.** Provider reads and writes return `REDACTED` values. Only the
  Sandbox's own supervisor can fetch provider environments or exchange tokens.
  OpenShell withholds a static key that has no credential binding. A Sandbox
  policy cannot add a `credential_binding` for a profile that defines endpoints,
  so changing a Sandbox policy cannot move `OPENAI_API_KEY` off
  the endpoint selected by the source.
- **Not covered.** A Platform Admin can create, attach, and exec in Sandboxes in
  any Workspace. A Workspace admin, which includes OCC's gateway principal, can
  update a profile's endpoints or binaries while Sandboxes use it, so anyone
  holding the Backend credential can redirect the key. With
  `allow_unauthenticated_users` enabled, every caller that reaches the gateway
  is a Platform Admin; never enable it outside disposable development. The OCC
  worker can read the source's Kubernetes Secret directly.

## Limits

- A running Agent uses an updated static value only after its next deployment.
- The OAuth2 types support the client-credentials and refresh-token grants
  only. ChatGPT-account sign-in, Google service accounts, AWS STS, token
  exchange, and other OpenShell source types remain unavailable.
- After an update of an OAuth2 source's material, running Agents lose its
  token within one Sandbox provider poll (10 seconds by default) and receive
  none until they are redeployed. Rotation and background refresh need
  no redeploy.
- OCC does not perform the initial OAuth2 sign-in for a refresh-token source;
  supply the refresh token from a completed sign-in in a Secret.
- A `bearer-token` or OAuth2 source binds one endpoint, and the workload must
  place the placeholder in the request itself.
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
