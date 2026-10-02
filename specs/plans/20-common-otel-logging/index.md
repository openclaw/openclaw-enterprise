# Feature Spec: Common OpenTelemetry logging

**Date:** 2026-09-01
**Status:** Implemented; local validation recorded below
**Owner:** OCC control plane and runtime packaging
**Implementation baseline:** `1242406b6863c8953abe4827c601c2173129ee50`.

## Problem and Decision

Enterprise configures one logging level and structured output for OCC API/worker, Agent-owned OpenClaw gateways and dedicated Codex app-servers. A standard OpenTelemetry Collector collects container logs and exports OTLP Logs. Enterprise owns emission; the Collector owns destination, credentials, TLS and delivery.

Before this change, [Fastify](../../../apps/controller/src/index.ts) had no logger, [workers](../../../apps/controller/src/worker.ts) emitted ad hoc JSON, and runtime launches lacked a common policy. Use a small OCC Pino factory, native gateway JSON console logging and Codex JSON stderr. Keep native runtime log exporters disabled because their events can include agent content.

## Scope

- Configure OCC API, worker and noninteractive bootstrap/migration diagnostics, plus embedded/dedicated gateways and Codex through Docker, Kubernetes and the existing OpenShell-derived launch path.
- Supply collection for development Compose and production Helm, including Driver-created containers and short-lived initialization containers.
- Preserve PostgreSQL audit, IAM and immutable revisions. Audit export, content analytics, tracing/metrics instrumentation, browser telemetry, dynamic/per-Agent levels and arbitrary infrastructure collection are outside this feature.

## Contract

See [Contract](contract.md#contract).

## Implementation

1. Extend [installation-config.ts](../../../apps/controller/src/composition/installation-config.ts) with the level/default and a reader usable before Driver initialization. Add the small Pino factory/dependency and wire production/development composition, API, worker and scripts.
2. Stamp admission fields, update both Compute renderers and [runtime-entrypoints.ts](../../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts), and reserve environment controls in [SecretBindings](../../../packages/contracts/src/secret-bindings.ts) and lifecycle validation. Verify options against the exact runtime images.
3. Add standard Collector configuration under `deploy/logging/` and wire its mounts/secrets through existing Compose/Helm setup. Validate the pinned Collector configuration; configure Docker forwarding on every managed container creation path. Operators edit native Collector configuration directly.
4. Update [settings](../../../docs/reference/settings.md), [controller](../../../docs/reference/controller.md), [harness execution](../../../docs/reference/harness-execution.md), [security](../../../docs/reference/security.md), the deployment guide and affected flows when implementing. Describe separate level/export configuration, redeployment, content limits and troubleshooting.

## Verification

| Required outcome | Proof |
| --- | --- |
| One policy, immutable runtime settings | Startup fixtures cover defaults/invalid keys. Real Fastify and worker tests prove level filtering, safe attributable records and unchanged audit behavior. Admission overrides tenant logging fields, both renderers retain a saved level after startup policy changes, redeployment changes it, and SecretBinding/hook collisions fail. Check the pre-feature revision error and OpenShell environment propagation. |
| Actual OTLP delivery for all components | Disposable Compose and k3d with a local receiver and pinned real gateway/Codex images receive unique operational markers from OCC API/worker/bootstrap, embedded and dedicated gateways, and Codex. Assert identity, timestamp/severity, startup collection and a single route with native exporters off. Actual sandbox delivery requires its authorized real integration. |
| Safe, bounded collection during failure | Password/token/prompt/tool-output/email canaries, forged identity, malformed/oversized records and stdout protocol data cannot pass remote filtering. Stop/restore the receiver and exercise graceful termination: verify bounded resources, checkpoint recovery, responsive OCC and buffer drain within the termination budget. |

Implementation validation on 2026-09-02 passed the actual Docker Compose model/OTLP/outage proof, both embedded and dedicated k3d model/OTLP cases, and the complete production Helm/TUI test with migration, bootstrap, API, worker and gateway export. Native Collector checks cover filtering, forged identity, malformed/oversized records and queue recovery; real image startup and PostgreSQL bootstrap recovery also passed. Current behavior is owned by [settings](../../../docs/reference/settings.md), [controller reference](../../../docs/reference/controller.md), [harness execution](../../../docs/reference/harness-execution.md) and the [implementation flow](../../../docs/flows/common-logging.md).

Actual OpenShell deployment was unavailable; only its generated launch contract was verified. Broader preexisting Kubernetes durability tests expect SQLite conversation tables absent from the unchanged OpenClaw 2026.7.1 JSON/JSONL runtime; a separate existing AGENTS literal-line assertion also failed with an unresolved cause. Those assertions remain intact and those broader suites are not reported green. The repository has no configured CI checks and prohibits adding workflows; local results are not a CI-green claim.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- [2026-09-01 18:18]: Drafted common OCC, gateway and Codex logging policy and Collector export contract for independent review. (01a05fa0-6720-7f42-891b-c2c0495c8d12 - 264d6d2f58cd97504c2b8b58d607d002cd62cc5e)
- [2026-09-01 20:00]: Applied approved simplification: Enterprise owns one level and structured output; standard Collector configuration owns export. Removed custom transport schema/renderer, retained runtime and privacy guarantees, and reserved tenant logging overrides. (01a05fa0-6720-7f42-891b-c2c0495c8d12 - 264d6d2f58cd97504c2b8b58d607d002cd62cc5e)

- [2026-09-02 11:15]: Implemented startup policy, immutable native admission, shared OCC diagnostics, runtime launch controls, native Collector packaging, privacy filters and live proof hooks. Updated operator docs and the [implementation flow](../../../docs/flows/common-logging.md); final review and logging-specific live verification are in progress. (01a05fa0-6720-7f42-891b-c2c0495c8d12 - 1242406b6863c8953abe4827c601c2173129ee50)

- [2026-09-02 11:39]: Completed the available-runtime logging proof and independent implementation review. Live Helm verification found and fixed initialization Job matching and shared Pod-label cleanup across a record batch; retained the explicit OpenShell and broader-runtime verification boundaries above. (01a05fa0-6720-7f42-891b-c2c0495c8d12 - 1242406b6863c8953abe4827c601c2173129ee50)

- [2026-09-03]: Applied the approved scope-preserving cleanup: reuse one startup YAML snapshot for API/worker logging and Driver configuration, fix Collector internal paths and metrics port, consolidate collection test setup and redundant packaging assertions, and give configuration, execution flow, and run commands one documentation owner each. Bundled collection, source sanitization, export filtering, immutable admission, and existing verification boundaries remain part of the contract. (01a05fa0-6720-7f42-891b-c2c0495c8d12 - 61ef68bc61129c90130bb65b0fc48373f0c70866)
