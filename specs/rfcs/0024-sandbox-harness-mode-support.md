---
status: Proposed
implementation_status: Not implemented
author: kevinlin-openai
---

# Proposal: declare Sandbox Harness mode support

- **ID:** RFC-0024
- **Created:** 2026-10-28
- **Issue:** [#3891](https://github.com/openclaw/openclaw-enterprise/issues/3891)

## Decision and outcome

Add a required, read-only `SandboxDriver.supportsHarnessExecutionMode` property.
The Driver constructs and freezes its value from its implementation and
Installation settings. OCC reads this declaration to report OpenClaw execution
modes and to reject unsupported modes during real Agent operations.

Installation reads must not call `configureAgent`. That method continues to
validate and transform real Configuration values for a resolved Harness.

## Problem

Installation capability discovery currently calls `configureAgent` with an empty
Configuration and a synthetic Harness descriptor. This couples a read to a
transformation hook and cannot distinguish a refusal caused by Installation
settings from invalid Configuration content.

[PR #3514](https://github.com/openclaw/openclaw-enterprise/pull/3514) introduced
this probe so capability reporting would agree with OpenShell admission. This
proposal preserves that agreement without running the transformation.

## Contract and ownership

The public contract defines a closed support result and an explicit OpenClaw
scope:

```ts
export type HarnessExecutionModeSupport =
  | { readonly supported: true }
  | { readonly supported: false; readonly reason?: string };

// Required on SandboxDriver.
readonly supportsHarnessExecutionMode: {
  readonly openclaw: Readonly<Record<HarnessExecutionMode, HarnessExecutionModeSupport>>;
};
```

Both `embedded` and `dedicated` entries are required. This declaration does not
describe Codex, select a Harness, advertise an approved runtime image, or prove
provider health. An absent Sandbox Driver keeps the existing platform behavior.
There is no compatibility default for a Driver that omits the new property.

A refusal may contain a `reason` only when Installation settings cause it. The
reason must be safe to show to an authorized reader: name the setting and the
corrective action, without credentials, private endpoints, or setting values.
OCC uses `ConfigurationHarnessError` for the refusal and includes the same reason
in `InstallationCapabilities.openclaw.settingRefusals`. Without a reason, OCC
uses a fixed mode-specific refusal. A supported result cannot contain a reason.

The selected Sandbox Driver owns the declaration and freezes every nested
value at construction. It must not derive support from an Agent, Configuration,
network request, or mutable provider state. Changing Installation settings
requires constructing a new Driver instance.

## Shared enforcement and real Configuration

OCC uses one support check for Installation capability discovery and actual
OpenClaw admission. It retains the existing rule that a selected Sandbox needs
Dedicated execution, as well as the native-worker and provisioning requirements.
The declaration cannot override those requirements.

Agent create, update, deployment, and provisioning writes check support before
calling `configureAgent` with the real Configuration and Harness. Provisioning
status reads continue to report stored work without rerunning admission.
Configuration-specific errors remain transformation errors; they must not remove
a mode from Installation capabilities.

OCC preserves the stored Configuration resource. It validates and freezes the
transformed values in the immutable Agent revision and rejects any transformation
that changes the selected Harness runtime. No new persistence model is needed.

OpenShell declares Embedded unsupported. Dedicated OpenClaw is supported only
when `kubernetes.userNamespaces` is `false` and
`gateway.operatorWorkspaceResources` contains at most one ServiceAccount. The
existing actionable messages and their precedence remain unchanged. OpenShell
uses its declaration for direct OpenClaw transformation calls too. Workspace
pinning and Codex app-server policy transformations remain unchanged.

## Delivery and verification

Submit this RFC for human review before changing source. Then update the contract,
OpenShell, OCC callers, current Sandbox reference, and affected runtime flow in
one implementation PR. Recheck the RFC number before merge.

Required outcomes:

- Installation reads return mode support and setting refusals without invoking
  `configureAgent`, including a Driver whose real transform rejects missing data.
- Capability output and Agent create, update, deployment, and provisioning
  admission agree for accepted and refused Installation settings.
- An accepted real Configuration reaches the transform; the saved resource stays
  unchanged and the Agent revision preserves the validated, frozen result.
- A transformation cannot change the selected Harness runtime. Existing
  OpenShell workspace and Codex policy behavior remains covered.
- Provisioning status reads remain available after support settings change.

Extend existing conformance and API/provisioning integration coverage through
their supported callers. Report fixture proof separately from live provider or
model execution. This RFC adds no live provider behavior or model execution path.

## Rationale and limits

A frozen declaration expresses an Installation property without a method that
could perform Configuration work. Retaining the synthetic probe preserves the
current ambiguity. A separate support-query method could still depend on
request data or have effects. A list of supported modes alone loses the existing
operator-actionable setting refusals.

This change does not redesign Drivers, enable Embedded Sandbox execution, add
Harness runtimes, alter authentication or authorization, or add deployment
resources. Maintainers review the proposed type and semantics; submission does
not mark this RFC accepted.

## References

- [Sandbox Driver contract](../../docs/reference/drivers/sandbox.md)
- [OpenShell Sandbox Driver](../../docs/reference/drivers/openshell-sandbox.md)
- [OpenShell provisioning flow](../../docs/flows/openshell-sandbox-provisioning.md)

## Manual Notes

## Changelog

- 2026-10-28: Propose static OpenClaw mode support and shared admission checks.
