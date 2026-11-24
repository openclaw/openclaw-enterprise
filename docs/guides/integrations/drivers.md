# Drivers overview

Drivers connect OpenClaw Enterprise to infrastructure. An Installation operator
selects one implementation for each required capability. Individual Agents
cannot choose their own Drivers.

Start with [Kubernetes Compute](../../reference/drivers/kubernetes-compute.md)
and the [Kubernetes Secret Driver](../../reference/drivers/kubernetes-secret.md)
for a new Installation. They support the Agent model-credential paths
documented in [Deploy and verify Agents](../deploy/production-agents.md). Use the
[Drivers quickstart](../../reference/drivers/selection.md#choose-a-bundled-driver)
to find the required settings.

## Credential delivery during cutover

For a build of the [unmerged 1.0 cutover candidate](https://github.com/openclaw/openclaw-enterprise/pull/7224),
use bundled Kubernetes Compute and select OCC TokenService in the trusted
Installation configuration. Add this entry under `drivers`.

```yaml
token_service:
  id: occ
  configuration: {}
```

Set `drivers.sandbox` to the bundled OpenShell Sandbox and bind it to the
[OpenShell Backend](../../reference/backends.md#openshell-gateway). The Sandbox
registration supplies native Credential Proxy delivery. Leave the separate
legacy `credential_proxy` selection unset for this workflow.

Use [Deploy your first Agent](../deploy/deploy-first-agent.md) to enroll a model
Source and [OpenShell Git access](../repository-credentials/openshell-git-push.md)
to grant a dedicated Codex Agent access to a repository. The live run at
`a009380c` exercised a Codex turn and allowed and denied Git reads. Native Git
push and a genuine Codex PAT turn still need live qualification.

Main still supports the [legacy Driver selections](https://github.com/openclaw/openclaw-enterprise/blob/a0d583bb7bdb4c2dd5ae43897926c037acfbf0be/docs/reference/drivers/selection.md#supported-selections)
`credential_gateway` and `credential_refresh`. The cutover retires both and
drops Gateway-owned Sources. The separate `credential_proxy` selector remains
available for [legacy protected egress](../../reference/drivers/credential-proxy.md#legacy-protected-egress).

## Available implementations

| Implementation                                                           | Use it for                                                                                                   | Current limits                                                                                                                                          |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Kubernetes Compute](../../reference/drivers/kubernetes-compute.md)      | Run embedded OpenClaw or dedicated Codex Agents on Kubernetes.                                               | Managed ChatGPT credentials require dedicated Codex.                                                                                                    |
| [Kubernetes Secret](../../reference/drivers/kubernetes-secret.md)        | Store and deliver OCC Secrets on Kubernetes.                                                                 | The bundled Secret Driver is required in trusted Installation YAML, including when selecting SSH Compute; it cannot deliver credentials to an SSH host. |
| [SSH Compute](../../reference/drivers/ssh-compute.md)                    | Run embedded OpenClaw on operator-managed Linux/systemd hosts, using model credentials supplied on the host. | No dedicated Codex or OCC-managed model credentials.                                                                                                    |
| [Docker/Podman Compute](../../reference/drivers/docker-compute.md)       | Run the local Compose control plane for development.                                                         | Current Agent authentication cannot deploy new Agents with this Driver. Use Kubernetes for local Agent deployment.                                      |
| [OpenShell Sandbox](../../reference/drivers/openshell-sandbox.md)        | Run a dedicated Harness in a Sandbox.                                                                        | Development integration; verify the required gateway and supervisor capabilities for the selected delivery path.                                        |
| [OCC TokenService](../../reference/credential-sources/managed-static.md) | Hold managed Sources and their credentials.                                                                  | Check [current Source support](../../reference/credential-sources.md#implementation-status) before selecting this Driver.                               |

The [Compute comparison](../../reference/drivers/compute-matrix.md) distinguishes
individual implementation capabilities from an Agent deployment that can
actually run. See [Sandbox](../topics/sandbox.md) for how containment works,
or the [Driver contracts](../../design/drivers.md) if you are developing an
implementation.
