---
status: Proposed
implementation_status: Not implemented
author: RaymondMcCreesh
---

# Proposal: Standard Harness startup checks

- **ID:** RFC-0024
- **Created:** 2026-10-17
- **Last updated:** 2026-10-23
- **RFC PR:** [#2764](https://github.com/openclaw/openclaw-enterprise/pull/2764)
- **Implementation plan:** none; delivery is tracked [below](#delivery-and-verification)
- **Related:** [#96](https://github.com/openclaw/openclaw-enterprise/issues/96), [#1070](https://github.com/openclaw/openclaw-enterprise/pull/1070), [#2058](https://github.com/openclaw/openclaw-enterprise/pull/2058), [#2416](https://github.com/openclaw/openclaw-enterprise/issues/2416), [#2718](https://github.com/openclaw/openclaw-enterprise/pull/2718), [#2746](https://github.com/openclaw/openclaw-enterprise/pull/2746), [#2756](https://github.com/openclaw/openclaw-enterprise/pull/2756), [#2763](https://github.com/openclaw/openclaw-enterprise/pull/2763), [#2737](https://github.com/openclaw/openclaw-enterprise/pull/2737)

## Summary

When an Agent fails to start, an operator can see a recorded deployment failure. When startup succeeds, the diagnostics for that Agent revision do not say whether its Harness authenticated to a model endpoint or reached the provider. Opening the diagnostics should answer what startup observed without sending another request with the Agent's credentials.

Kubernetes Compute would return three cached checks in the existing diagnostics array. Each row names the container that observed startup (`agent` or `gateway`) and the check it performed (`runtime-readiness`, `model-authentication`, or `model-connectivity`). Dedicated Agents can have evidence from both containers. The proposal extends the [shared runtime vocabulary](../../packages/contracts/src/runtime-failure.mjs) and the [Compute Driver diagnostics contract](../../docs/reference/drivers/compute.md).

## What the operator sees

| Check                  | Evidence of success                                       | Evidence of failure                                                                                                                                                                                                |
| ---------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `runtime-readiness`    | The container reached its startup readiness point.        | Startup stopped at a known step. Retain its safe failure code.                                                                                                                                                     |
| `model-authentication` | The startup probe authenticated successfully.             | The login or model probe recorded `AUTHENTICATION_FAILED` or `LOGIN_FAILED`. The latter leaves the cause unresolved.                                                                                               |
| `model-connectivity`   | The Driver has evidence that the model provider answered. | The startup probe failed to complete, with `MODEL_PROBE_TIMEOUT`, `MODEL_PROBE_CPU_STARVED`, or `MODEL_PROBE_FAILED`. The code describes the probe outcome. CPU starvation, for example, identifies a local limit. |

Each row carries a state, a safe code, and the startup observation's `checkedAt` timestamp when available. A successful check uses `succeeded / READY`. A check known to have been skipped uses `unknown / NOT_RUN`. If Compute cannot establish the outcome or verify the status source for this revision, it reports `unknown / UNAVAILABLE` with a null timestamp when no observation exists. A held `failed / UNAVAILABLE` records a specific startup failure. Consumers must read the state and code together.

A credential rejection establishes a failed authentication attempt. A relay can answer a 401 or forward provider headers. The status, body classification and `responseHeaderMarker` alone cannot establish provider origin. Without independent Driver evidence, connectivity stays `unknown / UNAVAILABLE`. DNS failures retain the existing generic probe code. Headers, response bodies and provider error text stay out of the checks.

A failed workspace setup, peer bridge, plugin approval, state migration, egress enrollment or prepared Git route can prevent readiness. Compute retains the original step and safe code in the held failure. It marks model checks as skipped only when it knows execution stopped before those checks. Runtime-auth Agents that start without a model probe report successful readiness and two skipped model checks.

## Who can publish startup evidence

The runtime would save startup observations separately from `runtimeFailure` in a new `runtimeStartupChecks` field on `/openclaw/runtime/status`. Compute reads the cached status for the requested revision and container. Producing these checks starts no process, model call, WebSocket or provider probe. The existing channel diagnostics can still probe Slack independently.

Compute must verify that each observation belongs to the selected runtime instance. Replaced instances cannot supply evidence for their successors. A provider-owned container can serve a forged success even when every field passes vocabulary validation. Until the Driver can authenticate and attest that source, all three checks remain unknown. Native OpenShell workers without an accessible status port also report unknown. In both cases the deployment record preserves the recorded outcome.

An older runtime that answers without the proposed field contributes no Harness rows. Its held failure remains visible. For unavailable status, keep the existing `runtime-status` row alongside any unknown Harness rows. Docker and SSH omit the new checks. The OCC Sandbox lifecycle row retains its separate meaning.

## Ordering and Console behavior

Keep held failures first in Compute's 32-row response. Replace a held row only when a failed Harness row has the same component, startup observation and safe code, and the held step maps to that check. Emit the representative at the held row's position so it survives OCC's Sandbox prepend and second cap. Keep both rows if equivalence is uncertain. Equal codes from different containers describe separate observations.

The Console labels these rows as cached startup evidence and shows the startup time separately from the time diagnostics were read. A successful startup does not establish current serving health or clear a recorded deployment failure. Keep that failure visible alongside later evidence and distinguish model checks from channel diagnostics. OCC continues to mask values outside the shared vocabulary.

## Delivery and verification

Exercise the authorized revision diagnostics route with healthy startup, rejected credentials, local CPU starvation, timeout, skipped probes and an unreachable or replaced runtime. Verify that the Harness read sends no provider request. Cover embedded and dedicated containers, forged provider-owned success, older images and masking. Verify that equal codes from different containers survive, and that a true duplicate beside 31 other rows survives once after OCC prepends Sandbox status. Render these cases alongside the recorded deployment outcome. Provide redacted Kubernetes evidence for successful and rejected authentication.

## Decisions for maintainers

The proposal retains container identity and adds `READY` and `NOT_RUN` to the shared vocabulary. Maintainers should decide whether consumers can reliably distinguish explicit startup failure from missing evidence by state, or need a separate unreachable code. The Compute Driver owners should identify what evidence, if any, their Driver can trust to establish provider connectivity after rejection or to publish success from a provider-owned runtime. Until such evidence exists the result remains unknown.
