---
status: Proposed
implementation_status: Not implemented
author: RaymondMcCreesh
---

# Proposal: Standard Harness startup checks

- **ID:** RFC-0021
- **Created:** 2026-10-17
- **Last updated:** 2026-10-17
- **RFC PR:** [#2764](https://github.com/openclaw/openclaw-enterprise/pull/2764)
- **Implementation plan:** none; delivery is tracked [below](#delivery-and-verification)
- **Related:** [#96](https://github.com/openclaw/openclaw-enterprise/issues/96), [#1070](https://github.com/openclaw/openclaw-enterprise/pull/1070), [#2058](https://github.com/openclaw/openclaw-enterprise/pull/2058), [#2416](https://github.com/openclaw/openclaw-enterprise/issues/2416)

<a id="problem-and-decision"></a>

## Summary

Standardize three safe Harness checks in exact-revision Agent diagnostics: `harness/runtime-readiness`, `harness/model-authentication`, and `harness/model-connectivity`. Kubernetes Compute will publish latched startup-probe evidence through the existing generic checks array; diagnostics will read cached evidence and never start model or provider work. Missing, replaced, or unreachable runtime evidence is `unknown`, never `failed`.

## Motivation

Upstream `main` already latches a runtime startup failure with a timestamp and safe code, and clears that failure when the runtime becomes ready (`apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts:354-398`). The runtime status report exposes the held failure (`apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts:414-422`). Kubernetes exact-revision diagnostics currently return generic runtime checks and, separately, a held startup-failure row; they do not publish Harness checks or deduplicate equivalent rows (`apps/controller/src/drivers/compute/kubernetes/index.ts:4063-4092,9175-9224`).

PR #1070 already persists classified model-probe failures in deployment status immediately: the worker maps probe codes to deployment codes (`apps/controller/src/worker.ts:880-894`) and finalizes a held runtime failure without waiting for convergence timeout, retaining classified model-probe evidence where applicable (`apps/controller/src/worker.ts:4653-4676`). The remaining gap is a stable per-Harness diagnostics contract that also represents successful and unknown startup evidence without claiming current serving health.

The existing contract already supplies generic checks with `component`, `check`, `state`, nullable `checkedAt`, and safe `code`, while the optional Compute diagnostics method may be omitted when a Driver cannot collect safe evidence (`packages/contracts/src/index.ts:1814-1828,1972-1974`). Diagnostics are explicitly read-only and do not rerun startup work (`docs/reference/drivers/compute.md:152-164`).

<a id="scope"></a>

## Goals

- Return the three checks in the existing generic `checks` array with `component: "harness"`.
- Use `succeeded`, `failed`, or `unknown`; every entry has a nullable `checkedAt` and a fixed safe code.
- Keep the latched probe time distinct from collection time, current readiness, and serving health.
- Represent unavailable OpenShell runtime status honestly as unknown with `UNAVAILABLE`.
- Suppress only a genuinely duplicated held startup-failure row.

## Non-goals

This RFC does not persist Agent health or serving observations, change `Agent.status`, add gateway/xDS or Pod-restart checks, run live probes on diagnostics requests, expose provider output, add automatic repair, or define DNS-specific classification. DNS failures use `MODEL_PROBE_FAILED` until a later decision adds a distinct safe code.

<a id="design"></a>

## Proposal

### Contract

The exact-revision response uses the existing `RuntimeDiagnosticCheck` entries (`packages/contracts/src/index.ts:1816-1828`):

| Check                          | Successful result    | Failure result                                          | Unknown result                        |
| ------------------------------ | -------------------- | ------------------------------------------------------- | ------------------------------------- |
| `harness/runtime-readiness`    | `succeeded`, `READY` | `failed`, the safe startup code                         | `unknown`, `NOT_RUN` or `UNAVAILABLE` |
| `harness/model-authentication` | `succeeded`, `READY` | `failed`, `AUTHENTICATION_FAILED`                       | `unknown`, `NOT_RUN` or `UNAVAILABLE` |
| `harness/model-connectivity`   | `succeeded`, `READY` | `failed`, `MODEL_PROBE_TIMEOUT` or `MODEL_PROBE_FAILED` | `unknown`, `NOT_RUN` or `UNAVAILABLE` |

`checkedAt` is the time the runtime latched the startup-probe result. It is not `observedAt`, the controller's collection time, and it is not a claim about current readiness or live serving health. A missing or replaced revision has no matching observation and is unknown with `checkedAt: null`. An unreachable runtime, including an OpenShell-provisioned runtime whose private status port cannot be reached, is also unknown with `UNAVAILABLE`; transport loss must never become a failed model check.

A credential rejection makes authentication failed and connectivity succeeded because the provider was reached. A timeout or provider failure makes connectivity failed and authentication unknown. A successful probe makes all three checks succeeded with `READY`. Native runtime errors and provider response text never cross this contract.

### Ownership and publication

The runtime startup path owns the latch. The proposed Kubernetes runtime change will publish the cached result through `runtimeStatusReport()`, and Kubernetes Compute will map it in `runtimeDiagnosticChecks()` into the exact-revision generic checks response. The diagnostics request reads that cached state only; it never runs a model call, process, WebSocket, or provider probe.

The held gateway/model-probe row remains a fallback for runtimes with no non-unknown Harness result. When a non-unknown Harness result represents the same failure, suppress only that duplicate held row; retain unrelated gateway failures. This keeps distinct evidence while preventing the same startup failure from appearing twice. The existing aggregation currently returns held failures before runtime checks (`apps/controller/src/drivers/compute/kubernetes/index.ts:4063-4092`); the implementation will change only that aggregation boundary.

The OCC Sandbox Driver's lifecycle observation remains separate. It currently produces the leading `agent`/`sandbox` check from the provider's observation (`packages/occ/src/index.ts:858-885,3092-3127`). That check describes Sandbox lifecycle, not model access, and must not be merged with the three Harness checks.

### Driver boundary

Kubernetes Compute must publish the contract for embedded OpenClaw and dedicated runtimes because it owns their runtime status channel and exact-revision diagnostics. Docker does not support Harness authentication bindings (`apps/controller/src/drivers/compute/docker/index.ts:531-544`), and SSH supports only embedded OpenClaw with operator-managed runtime credentials (`apps/controller/src/drivers/compute/ssh/index.ts:71-77,466-477`). Those Drivers omit these optional Harness checks or return only their existing safe diagnostics; they must not synthesize failure or expose provider text. OpenShell-provisioned runtimes follow the same unknown-on-unreachable rule.

## Delivery and verification

Native API integration tests will assert exact-revision authorization, all result states and fixed codes, latched-versus-collected timestamps, redaction, no-work-on-read, missing/replaced revisions, and unreachable OpenShell status. Runtime integration tests will exercise healthy, rejected credentials, timeout, provider failure, not-run, and the held-row deduplication path through real startup and diagnostics callers. Kubernetes conformance tests will cover embedded and dedicated aggregation; console coverage will show Harness checks beside existing checks without implying live serving health.

Live k3d proof will include redacted healthy and rejected-credential API responses, matching image digests, Pod status, and console captures. Other failure classifications may remain test-only when their live prerequisites are unavailable.

<a id="alternatives-and-open-decisions"></a>

## Rationale and alternatives

The generic checks array is preferred over a new field because it reuses the existing API, authorization, size, and console paths. A separate field would duplicate the contract and require parallel rendering. Keeping the held row as a fallback preserves evidence for older or incomplete runtime observations, while the narrow deduplication rule avoids duplicate failures without hiding unrelated gateway failures.

<a id="unresolved-questions"></a>

## Unresolved questions

Maintainers must confirm the generic-array shape, the `READY` code, and whether DNS failures should receive a future `DNS_RESOLUTION_FAILED` code. Until then DNS failures use `MODEL_PROBE_FAILED`, and no Driver is required to distinguish them.

## References

- [Compute Driver diagnostics](../../docs/reference/drivers/compute.md) (lines 152-164)
- [Runtime diagnostic contracts](../../packages/contracts/src/index.ts) (lines 1814-1828)
- [Kubernetes runtime status](../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts) (lines 354-422)
- [Kubernetes exact-revision diagnostics](../../apps/controller/src/drivers/compute/kubernetes/index.ts) (lines 4034-4092 and 9175-9235)
- [Runtime failure persistence](../../apps/controller/src/worker.ts) (lines 880-894 and 4653-4676)
- [Sandbox lifecycle diagnostics](../../packages/occ/src/index.ts) (lines 858-885 and 3092-3127)
