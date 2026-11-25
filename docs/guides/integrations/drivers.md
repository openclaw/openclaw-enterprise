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

<a id="credential-delivery-during-cutover"></a>

## Configure managed credential delivery

Use bundled Kubernetes Compute and add OCC TokenService under `drivers` in the
trusted Installation configuration.

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
Source or [set up GitHub App access](../repository-credentials.md#set-github-app-access-for-an-openshell-agent)
for a dedicated Codex Agent.

Remove the retired `credential_gateway` and `credential_refresh` selectors when
[upgrading an older installation](../deploy/production-upgrade.md). The separate
`credential_proxy` selection belongs to `LegacyEgressProxyDriver`, which is
deprecated and pending removal. Existing qualified protected repository exchanges and
credential-free metadata still require it; do not use it for new credentialed
workflows. See [legacy protected egress](../../reference/drivers/credential-proxy.md#legacy-protected-egress).

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
