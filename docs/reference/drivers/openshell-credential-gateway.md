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
```

`binaries` is required and closed: a nonempty list of absolute executable paths
inside the Harness image. OpenShell releases a credential only to requests made
by those binaries. Use the exact native Codex executable, not a wrapper script.
A stale path fails closed at the Codex startup model probe.

Startup rejects the selection when:

- the Installation does not select the bundled Kubernetes Compute Driver;
- no `openshell` Backend exists, or its `drivers.credential_gateway` or
  `drivers.sandbox` differs from the selected IDs; or
- the configuration has any key other than `binaries`.

Both the API and the worker connect to the gateway with the Backend's
credentials. The API registers and deletes providers; the worker creates
Sandboxes and reads attachment status. Allow both to reach the gateway.

## Source-type catalog

| Type                         | Secret fields        | Config fields | Rotation  | Harness authentication         |
| ---------------------------- | -------------------- | ------------- | --------- | ------------------------------ |
| `openai`                     | `api_key` (required) | None          | `none`    | `openai` / `api_key`           |
| `codex-oauth` (Experimental) | None; device login   | None          | `gateway` | `openai` / `chatgptAuthTokens` |

Other OpenShell provider types are not in the catalog, so registration rejects
them.

### Experimental Codex OAuth PoC

The `codex-oauth` type requires OpenShell's upstream `GetProviderCredentials`
RPC and matching gateway/supervisor support for identity-bound JWT placeholder aliases.
The stock pinned images do not provide this complete integration. See
[OAuth test setup](../../testing/openshell-oauth.md) for revision and image selection.

The Backend keeps its ordinary identity for Workspace, provider, refresh-control,
and Sandbox operations. Access-token retrieval uses a separate `operatorTls`
channel: a directly verified client certificate issued by the gateway's trusted
client CA with exact organizational unit `operator`. Enable OpenShell's
`openshell.gateway.mtls_auth.operator_enabled` setting. Operator requests cannot
carry a bearer header or forwarded identity. This certificate grants gateway-wide
operator authority; protect its key as an administrative credential. OCC still
authorizes each user's exact Namespace/source operation before retrieval and
rechecks authority before the callback uses the token. Namespace-scoped OpenShell
identities remain deferred.

The Driver transiently receives device-exchange credentials and hands refresh
material to OpenShell; OCC retains only an opaque login session. OpenShell owns
subsequent refresh and successor-token persistence. `withSourceToken` requests a
usable access token for plugin discovery, accepting the upstream default minimum
remaining lifetime of five minutes. OpenShell may refresh to satisfy that request.
Retrieval returns no refresh material, and the access token exists only inside
the authorized callback; it is never sent to the Console. Canceling retrieval does
not guarantee server-side refresh stops. Deployment and later revisions attach
the same source and receive account metadata plus a placeholder.

The Sandbox wraps its issued placeholder as a JWT without changing its provider
identity. Revocation, endpoint binding, and expiry remain enforced by OpenShell.
Selected runtime plugins remain unsupported by the current Sandbox Driver;
directory discovery does not establish hosted-plugin execution support.
See [OAuth storage](kubernetes-compute/codex-oauth-storage.md).

#### WIP boundaries

- **Refresh controls.** The PoC calls OpenShell configure/rotate/status RPCs from
  `OpenShellCredentialGatewayDriver`. Move that orchestration to the proposed
  `credential_refresh` capability when implemented. Scheduling, refresh material,
  and successor-token persistence already belong to OpenShell.
- **JWT placeholders.** The Sandbox's wrapper depends on the fork's alias
  resolver. Align that wrapper with upstream support without changing the
  Harness's `chatgptAuthTokens` contract or weakening provider identity checks.
- **Connection recovery and metadata.** Initial credentials, refresh configuration,
  and account metadata use separate writes. An interrupted handoff may require
  reconnecting. Account metadata is a login-time snapshot; token refresh does
  not update it. Reconnect and deploy a new revision to pick up account changes.

## How sources map to OpenShell

Each OCC Namespace maps to one operator-mode OpenShell Workspace with the same
name as its Kubernetes namespace. The Driver manages two objects in that
Workspace:

- **Provider profile `oce-openai`.** Registration imports this profile when
  missing. It exposes the credential as `OPENAI_API_KEY`, inserts it as a bearer
  `authorization` header, and binds it to `api.openai.com:443` with `rest`
  protocol and path `/v1/**`, for the configured binaries only. A digest
  annotation records the profile content; a configuration change updates the
  profile on the next registration.
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
For OAuth, source status and device polling remain `pending` during
`refresh_in_progress` or `refresh_committing`. If an uncertain refresh marker
persists, inspect OpenShell status for operator recovery; OCC does not replay
the exchange or reseed credentials.

`updateSource` requires the existing provider to be OCC-owned for the exact
source, then calls `UpdateProvider` with the new credential values.
`UpdateProvider` merges non-empty values into the provider, so the driver
rejects an empty value rather than silently keep the old one. OpenShell gives
the new value only to processes started after the update, so a running Harness
keeps the previous value until it restarts.

`removeSource` deletes the owned provider and confirms that it is gone. When no
provider of the profile's type remains, it also deletes the profile, because
OpenShell cannot delete a Workspace that still holds profiles.

For a revision, `attachForRevision` returns each source's provider name. The
OpenShell SandboxDriver appends those names to `SandboxSpec.providers`.
`attachmentStatus` calls `GetSandboxProviderStatus` for each provider and maps
OpenShell readiness states to `ready`, `withheld`, `revoked`, `failed`, or
`pending`. `withdraw` calls `DetachSandboxProvider` for the revision's Sandbox,
then reads the status of that detach receipt. Only `REVOKED` reports `revoked`:
the Sandbox's placeholders then stop resolving, even in running processes.
OpenShell reports `REVOKED` only after the Sandbox supervisor reports a running
process with the provider removed. A Sandbox with no running process, for
example one still provisioning or crash-looping, reports `WaitingForProcess`,
which stays `pending`. A missing Sandbox reports `absent`.

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

- The `openai` type is static, with nothing for the gateway to refresh. A running
  Agent uses an updated key only after its next deployment.
- Codex OAuth requires the upstream gateway API and alias-enabled runtimes described above;
  other source types remain unavailable.
- Only one OpenShell Backend can be configured.

## Verification

The [OpenShell real Sandbox suite](../../testing/openshell.md#openshell-sandbox)
registers a source through the API, deploys a dedicated Codex Agent that uses it,
and checks that every Harness process sees only the placeholder. The Sandbox
Driver startup integration covers Backend membership and selection rules.

## Troubleshooting

| Symptom or message                                                                 | Cause and fix                                                                                     |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `drivers.credential_gateway requires an owning backend entry with type openshell.` | Add the `openshell` Backend.                                                                      |
| `backend[…].drivers.credential_gateway must match …`                               | Make the Backend member IDs match the selected Driver IDs.                                        |
| `OpenShell Credential Gateway binaries must be a nonempty list of absolute paths.` | Correct `binaries`.                                                                               |
| Registration returns `503`                                                         | Check that the API reaches the gateway, the token file is mounted, and the Workspace exists.      |
| Registration returns `404` for a name conflict                                     | A provider named for this source exists without OCC's labels. Remove it in OpenShell, then retry. |
| The revision stays inactive with a `failed` or `withheld` attachment               | Check the provider in OpenShell and the Sandbox's `GetSandboxProviderStatus` reason.              |
| Codex startup fails its model probe                                                | Confirm `binaries` names the exact Codex executable and that Codex trusts the Sandbox CA.         |

## Related

- [CredentialGatewayDriver contract](credential-gateway.md)
- [OpenShell SandboxDriver](openshell-sandbox.md)
- [Credential source lifecycle flow](../../flows/credential-source-lifecycle.md)
- [OpenShell Sandbox provisioning flow](../../flows/openshell-sandbox-provisioning.md)
- [Driver source](../../../apps/controller/src/drivers/credential-gateway/openshell.ts) and [Backend source](../../../apps/controller/src/backends/openshell.ts)
