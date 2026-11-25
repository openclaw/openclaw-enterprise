# Agent compute

Compute is the infrastructure that runs an Agent. The installation operator
selects a Compute Driver; an Agent owner chooses an execution mode supported by
that Driver. You cannot select a different Compute Driver for an individual
Agent. If you are setting up your own first installation, use the
[Kubernetes quickstart](../quickstart.md).

## Choose an execution mode

| Mode and Harness                             | Deployment and use                                                                                                                                                                       |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Embedded OpenClaw**                        | One gateway runs the OpenClaw Harness. Use it on Kubernetes or an operator-managed SSH host.                                                                                             |
| **Dedicated Codex**                          | A gateway connects to a separate Codex Harness on Kubernetes. Use it for Codex, a ChatGPT service account, or a supported external channel.                                              |
| **Dedicated native OpenClaw (experimental)** | A gateway connects to a native worker. Requires a provisioning SandboxDriver with all three isolation facets. The bundled OpenShell path has upstream blockers and is verification-only. |

The mode belongs to the Agent. Its [Configuration](../../reference/configuration.md)
selects the model and Harness, and the two must agree. The HTTP API defaults a
new Agent to embedded when the mode is omitted. The
[OpenShell quickstart](../deploy/local-setup.md) selects dedicated Codex explicitly.
See [Harness](../../reference/harness-execution.md#supported-topology) for the
supported model and credential combinations.

## What the bundled Drivers support

| Driver                                                      | Current use                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Kubernetes](../../reference/drivers/kubernetes-compute.md) | Embedded OpenClaw and dedicated Codex. The OpenShell development profile implements plugin-free dedicated Codex through experimental provider APIs, subject to its upstream preconditions; dedicated native OpenClaw remains verification-only. Embedded OpenClaw uses a Secret-backed key for OpenAI, Anthropic or a configured custom provider. Dedicated native OpenClaw uses `openai/` models with a compatible Credential Source or, where Secret projection is supported, a key for OpenAI’s default endpoint. For dedicated Codex, see [Harness authentication](../../reference/harness-execution.md#harness-authentication). |
| [SSH](../../reference/drivers/ssh-compute.md)               | Embedded OpenClaw on operator-managed Linux hosts. The operator supplies the model credential on the host; the control plane does not check model access. Dedicated Codex and platform-managed model credentials are unavailable.                                                                                                                                                                                                                                                                                                                                                                                                    |
| [Docker](../../reference/drivers/docker-compute.md)         | Local control-plane development only with the current Agent authentication contract. Its default Docker/Podman profile cannot admit a new Agent deployment.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

A [Sandbox](../../reference/security/runtime-isolation.md) changes how a
supported workload is contained. Dedicated Codex can use a Sandbox.
Dedicated native OpenClaw requires one. Embedded OpenClaw cannot use one.

## Deployment and availability

A deployment creates a new [Agent Revision](agent-revisions.md). The control
plane queues work and can select the new version while activation is still in
progress. Neither the accepted request nor the console's selected version
shows live health. Use [Troubleshoot](agent-troubleshoot.md) for status checks.
For a real model response on Kubernetes, follow the
[model verification guide](../operate/model-verification.md).
For SSH deployments, use the [SSH Driver's credential and verification guidance](../../reference/drivers/ssh-compute.md#credentials-and-supported-boundaries).

On Kubernetes, replacing an embedded Agent can interrupt service before the new
model credential is accepted. If the replacement cannot start, there is no
automatic rollback. See [Harness isolation and activation](../../reference/harness-execution.md#isolation-and-activation)
before using that mode for an availability-sensitive Agent.
