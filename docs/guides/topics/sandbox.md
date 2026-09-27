# Sandbox

A Sandbox adds network, filesystem, or process restrictions to an Agent’s
Harness, the process that runs its work. The Compute Driver still owns the
baseline isolation, Agent identity, gateway, and routing. These responsibilities
remain with Compute even when a Sandbox creates the Harness workload.

## When to select a Sandbox

Sandbox selection is optional and currently requires the bundled Kubernetes
Compute Driver and dedicated Agent execution. It cannot be combined with Docker,
SSH, installed Compute Drivers, or embedded execution. The Installation operator
selects it; an Agent cannot choose its own Sandbox.

[OpenShell](../../reference/drivers/openshell-sandbox.md) is the bundled
integration for dedicated Codex. The stock OpenShell gateway version documented
there cannot honor the projected identity and app-server token Secret reference
that OCC requires. Its paired [Credential Gateway](../../reference/drivers/openshell-credential-gateway.md)
keeps the model API key out of the Harness. Local verification uses development-only workarounds; it is not a
supported production deployment path. If the selected Sandbox cannot enforce
required containment or preserve workload identity, deployment stops.

## What a Sandbox does not provide

Selecting a Sandbox does not add per-tool authorization or guarantee that every
command is approved before it runs. It also does not replace Namespace network
controls, workload IAM, or credential isolation. Consult
[Agent runtime security](../../reference/security/runtime-isolation.md#selected-sandboxdriver-boundary)
for the current boundaries and
[OpenShell troubleshooting](../../reference/drivers/openshell-sandbox.md#troubleshooting)
for compatibility and admission failures.
