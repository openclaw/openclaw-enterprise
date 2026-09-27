# OpenShell Credential Gateway

The bundled OpenShell Credential Gateway stores OCC
[credential sources](../credential-sources.md) as OpenShell providers. The
OpenShell supervisor applies them at its egress proxy, so the dedicated Codex
Harness never receives the real model key. It implements the
[CredentialGatewayDriver contract](credential-gateway.md) and works only with the
[OpenShell SandboxDriver](openshell-sandbox.md), through one shared `openshell`
[Backend](../backends.md#openshell-gateway).

**This Driver does not make OpenShell a supported production path.** It removes
the model API key from the list of [upstream blockers](openshell-sandbox.md#current-upstream-preconditions);
the app-server token, workload identity, workspace mounts, plugin-runtime files,
and exposed-route authorization still fail closed on stock OpenShell `v0.1.0`.

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

| Type     | Secret fields        | Config fields | Rotation | Harness authentication |
| -------- | -------------------- | ------------- | -------- | ---------------------- |
| `openai` | `api_key` (required) | None          | `none`   | `openai` / `api_key`   |

Other OpenShell provider types are not in the catalog, so registration rejects
them.

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

`removeSource` deletes the owned provider and confirms that it is gone. When no
provider of the profile's type remains, it also deletes the profile, because
OpenShell cannot delete a Workspace that still holds profiles.

For a revision, `attachForRevision` returns each source's provider name. The
OpenShell SandboxDriver appends those names to `SandboxSpec.providers`.
`attachmentStatus` calls `GetSandboxProviderStatus` for each provider and maps
OpenShell readiness states to `ready`, `withheld`, `revoked`, `failed`, or
`pending`.

In the running Sandbox, the Harness environment holds only an
`openshell:resolve:env:` placeholder for `OPENAI_API_KEY`. `codex login
--with-api-key` stores that placeholder, and the supervisor proxy substitutes the
real key on matching requests.

## Trust requirements

- **Workspace membership.** Any OpenShell user in a Workspace can attach any
  provider in it. Keep OCC's gateway principal as the only member of OCC
  Workspaces. OpenShell Platform Admins bypass membership, so limit that role
  as well. OCC does not check either.
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

## Limits

- `updateSource`, `rotateSource`, and `withdraw` fail with "not supported yet".
  Changing a key requires a new source and a new deployment.
- Only the `openai` API-key type exists. ChatGPT-account sign-in and other
  OpenShell source types remain unavailable.
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
