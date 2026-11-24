# Sandbox

A Sandbox adds network, filesystem, or process restrictions to an Agent’s
Harness, the process that runs its work. The Compute Driver still owns the
baseline isolation, Agent identity, gateway, and routing. These responsibilities
remain with Compute even when a Sandbox creates the Harness workload.

## When to select a Sandbox

The Installation operator selects the Sandbox Driver. A Sandbox requires bundled
Kubernetes Compute and dedicated execution. Docker, SSH, installed Compute
Drivers and embedded execution cannot use it.

Dedicated Codex can run without a Sandbox. Dedicated native OpenClaw requires
a compatible Driver that provisions the Harness and enforces networking,
filesystem and process restrictions.

[OpenShell](../../reference/drivers/openshell-sandbox.md) can provision either Harness.
OpenShell cannot preserve the Agent’s ServiceAccount and projected identity
token. Kubernetes Compute rejects dedicated OpenShell execution with
`servicePrincipalCredentials.mode: projectedServiceAccountToken`. If the Agent
needs projected identity, choose a Driver that supports it.

For Codex app-server authentication, Compute sends OpenShell a SHA-256 hash
of the token. The Agent Gateway retains the token. The paired
[Credential Gateway](../../reference/drivers/openshell-credential-gateway.md)
keeps the model API key out of the Harness. The [local verification setup](../deploy/local-kubernetes-development.md#start-the-openshell-fail-closed-profile)
is for development only. Deployment stops if the selected Sandbox cannot enforce
required containment or preserve workload identity.

Upstream OpenClaw has a separate
[OpenShell sandbox backend](https://docs.openclaw.ai/gateway/openshell), the
`@openclaw/openshell-sandbox` plugin. There, the OpenClaw Gateway and its
plugins stay on the host, and only tool execution runs in OpenShell. OCE does
not install or configure that plugin. The OCE SandboxDriver runs the whole
dedicated Harness inside the Sandbox, and Kubernetes Compute manages its
lifecycle. Do not combine the two: each sandbox needs a single lifecycle
owner.

## What a Sandbox does not provide

Selecting a Sandbox does not add per-tool authorization or guarantee that every
command is approved before it runs. It also does not replace Namespace network
controls, workload IAM, or credential isolation. Consult
[Agent runtime security](../../reference/security/runtime-isolation.md#selected-sandboxdriver-boundary)
for the current boundaries and
[OpenShell troubleshooting](../../reference/drivers/openshell-sandbox.md#troubleshooting)
for compatibility and admission failures.

## Per-Agent network additions

With a supporting Driver, operators can delegate bounded network additions for
one Agent and enable user editing separately. Use the [Policy denials workflow](agent-sandbox-policy.md)
to inspect observations, review a grant, and confirm application. See the
[policy contract](../../reference/sandbox-policies.md) for authority and limits.
