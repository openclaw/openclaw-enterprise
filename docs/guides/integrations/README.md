# Integrations overview

Use an integration to choose where Agents run, issue ChatGPT service-account
credentials, or connect an Agent to Slack. Installation operators select Drivers
and experimental Backends; people configuring an Agent select its channel and model
authentication.

| If you want to…                                              | Start here                                                                         |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Run Agents on Kubernetes or an existing Linux host           | [Drivers overview](drivers.md)                                                     |
| Choose which Drivers an Installation loads                   | [Drivers quickstart](../../reference/drivers/selection.md#choose-a-bundled-driver) |
| Issue managed ChatGPT credentials for dedicated Codex Agents | [ChatGPT Backend (experimental)](chatgpt.md)                                       |
| Let people send messages to an Agent in Slack                | [Slack](slack.md)                                                                  |

[Backends (experimental)](../../reference/backends.md) lists what an Installation can
configure. A ChatGPT Backend manages service accounts; it does not route
inference. To give an Agent an existing OpenAI API key, use the
[Agent's model authentication](../../reference/agents.md#harness-authentication)
instead.

Kubernetes Compute is the recommended starting point for new Agents. The
Docker Compute Driver used by Docker/Podman Compose is limited to
control-plane development; it cannot deploy new Agents under the current
authentication contract. This limit does not apply to Kubernetes running in
local Docker through [Local Setup](../quickstart.md). OpenShell is documented
under Drivers with its upstream blockers; it is not supported for production.
