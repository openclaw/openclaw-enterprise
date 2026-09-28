# Drivers overview

Drivers connect OpenClaw Enterprise to infrastructure. An Installation operator
selects one implementation for each required capability. Individual Agents
cannot choose their own Drivers.

Start with [Kubernetes Compute](../../reference/drivers/kubernetes-compute.md)
and the [Kubernetes Secret Driver](../../reference/drivers/kubernetes-secret.md)
for a new Installation. They support the Agent model-credential paths
documented in [Deploy your first Agent](../first-agent.md). Use the
[Drivers quickstart](../../reference/drivers/selection.md#choose-a-bundled-driver)
to find the required settings.

## Available implementations

| Implementation                                                                          | Use it for                                                                                                   | Current limits                                                                                                                                          |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Kubernetes Compute](../../reference/drivers/kubernetes-compute.md)                     | Run embedded OpenClaw or dedicated Codex Agents on Kubernetes.                                               | Managed ChatGPT credentials require dedicated Codex.                                                                                                    |
| [Kubernetes Secret](../../reference/drivers/kubernetes-secret.md)                       | Store and deliver OCC Secrets on Kubernetes.                                                                 | The bundled Secret Driver is required in trusted Installation YAML, including when selecting SSH Compute; it cannot deliver credentials to an SSH host. |
| [SSH Compute](../../reference/drivers/ssh-compute.md)                                   | Run embedded OpenClaw on operator-managed Linux/systemd hosts, using model credentials supplied on the host. | No dedicated Codex or OCC-managed model credentials.                                                                                                    |
| [Docker/Podman Compute](../../reference/drivers/docker-compute.md)                      | Run the local Compose control plane for development.                                                         | Current Agent authentication cannot deploy new Agents with this Driver. Use Kubernetes for local Agent deployment.                                      |
| [OpenShell Sandbox](../../reference/drivers/openshell-sandbox.md)                       | Review the dedicated Codex integration and its required upstream capabilities.                               | Stock OpenShell cannot provide the required credentials or workload identity; production Agent deployment is unsupported.                               |
| [OpenShell Credential Gateway](../../reference/drivers/openshell-credential-gateway.md) | Keep the dedicated Codex OpenAI API key outside the OpenShell Harness.                                       | Required with the OpenShell Sandbox; supports only the `openai` source type, with no update or rotation.                                                |

The [Compute comparison](../../reference/drivers/compute-matrix.md) distinguishes
individual implementation capabilities from an Agent deployment that can
actually run. See [Sandbox](../topics/sandbox.md) for how containment works,
or the [Driver contracts](../../design/drivers.md) if you are developing an
implementation.
