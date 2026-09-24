# Production observability implementation qualification

Status: Default local acceptance passed; model-turn qualification blocked by provider authentication, 2026-09-23.

Implementation is in the isolated `feat/production-observability` worktree based
on `faf0b0ae467a3bebfd5b5ed0a92f259248e5da74`. The original checkout, existing
workloads, default container connection, and default kubeconfig were preserved.

## Implemented behavior

The production chart enables private API/worker metric listeners by default.
Paired namespace and Pod selectors grant scraping; empty selectors grant no
access. Logs remain local until collection is configured. The optional Collector
supports private metrics discovery and either an exact external exporter address
or paired in-cluster destination selectors.

A separate disposable Helm release provides Prometheus, Grafana, and Loki with
pinned images, private Services, scoped discovery, bounded storage, and the
shipped filtering pipeline. Compose and Helm share one metrics dashboard asset.
The [operator guide](../../docs/guides/observability/demo.md) describes setup,
actual data checks, limitations, and scoped removal.

`pnpm test:observability` prepares an owned k3d installation, runs source and demo
acceptance, and cleans up. The same strict two-case `k3d-observability` lane is
included in ordinary and full CI. Real model log checks remain separate under
`pnpm test:observability:models` and the protected `k3d-otel` dispatch.

## Evidence

- The earlier unchanged Helm baseline is recorded in the
  [baseline report](36-production-observability-baseline.md). After the base moved
  to `faf0b0ae`, the unchanged real-cluster fixture baseline passed all four current
  cases, with no failures or skips and successful cleanup, before chart changes.
- The final `k3d-fixture-configuration` regression rerun passed all four cases,
  with no failures or skips and successful cleanup, after the shared preparation changes.
- Production/logging packaging checks: 17 passed, no failures or skips.
- CI preparation, runner, and observability launcher checks: 42 passed, no failures
  or skips. Missing model credentials fail before provisioning.
- Lint, TypeScript, formatting, workspace isolation, docs/link checks, flow
  validation, suite ownership audit, and actionlint passed during implementation.
- `pnpm test:observability`: 2 passed, 0 failed, 0 skipped, with successful
  cleanup of its fresh cluster. Source acceptance includes outage recovery,
  Collector handoff, metrics opt-out, and demo removal. Demo smoke requires real
  Grafana queries and finite dashboard values after two Agent lifecycle cycles.
- Browser inspection showed actual lifecycle/request metrics and filtered API and
  worker events in the Helm-installed Grafana dashboards. This is real backend
  data, with a deterministic Agent runtime fixture and no model calls.

Initial live runs exposed two setup errors in the new helper: a JSON content-type
on a bodyless request, and an omitted runtime-credential provisioning API call.
Both were corrected through the supported HTTP workflow. The outage check uses
signals exposed by the pinned Collector: queue growth and
local export errors, followed by fresh receipt after recovery.

## Proof boundaries

Default acceptance uses a real Helm-installed OCC API/worker, in-cluster
PostgreSQL with separate administrator/migrator/application roles, enforcing
NetworkPolicies, actual Collector file receivers, and real Prometheus/Loki/Grafana.
The Agent runtime fixture proves orchestration and OCC telemetry; it does not
prove gateway, Codex, or provider model execution.

The default command excludes the existing model credential. The separate
`gpt-6-astra` qualification selected both required real-runtime cases: 0 passed,
2 failed, 0 skipped, with successful cleanup. Both failed while waiting for a
revision to become active. A subsequent diagnostic Helm install reached the real
gateway's authentication probe, which held the Pod unready. A provider model
access request from that Agent Pod, using its projected credential, returned
HTTP 401. No credential value was printed. The diagnostic used temporary
stack-location logging and is not acceptance evidence; it did not bypass
readiness or replace the runtime.

Real model turns and gateway/Codex log attribution therefore remain unverified.
Rerun `pnpm test:observability:models` with a valid authorized credential to qualify
that path. Protected hosted execution remains unverified. Hosted CI is configured
but has not run for these unpublished worktree changes. No merge or deployment
outside disposable local clusters was performed. All owned clusters, receiver/database
containers, temporary infrastructure files, and the task socket tunnel were removed;
the worktree and sanitized qualification evidence remain.

The shared dashboard lives inside the demo chart so Helm includes it in the
package; its content is unchanged and Compose mounts the same asset. CI uploads retain sanitized case outcomes (including the acceptance cases that
require backend queries), source identity, cleanup status, and immutable image
digests by role. Registry names, credentials, and raw model output are excluded.
The runner regression check proved missing image evidence fails before the
change and that the updated artifact retains only the allowed digests.

Affected existing pages above 1,500 words remain together because each owns one
complete installation, logging, CI-accounting, or Kubernetes testing workflow.
The implementation plan describes one acceptance workflow. All remain below
2,500 words; the demo procedure has its own child page.

The user selected local review without exporting the diff. A local self-review
checked chart defaults, paired NetworkPolicies, demo resources, CI selection,
cleanup, source/demo/model assertions, and operator commands against the plan
and recorded evidence. It corrected the demo guide to explicitly enable metrics
when saved values opted out, generate a password file without a trailing newline,
and describe asynchronous Loki retention accurately. Documentation checks passed.
No additional actionable findings remain from this review. This is not an
independent model review; external autoreview was not run. The model credential
and hosted-CI qualification gaps above remain.

## Rebase validation, 2026-09-24

The branch was rebased onto `origin/main` at
`6b5c9093b75044f181db74bc14dffaa3410e617a`. The live evidence above belongs to
the earlier base. Conflict resolution preserved the upstream split CI lane
files and added the observability lane in that structure. The acceptance helper
now grants scoped access in both managed Kubernetes namespaces, and the dedicated
model case discovers Gateway resources in the separate Gateway namespace.

Focused CI preparation, runner, launcher, and Helm packaging checks passed all
61 cases without failures or skips. Lint, TypeScript, formatting, docs/link checks,
workspace isolation, suite ownership audit, and actionlint passed. The adjusted
namespace helper passed lint but has not been exercised on a live cluster after
the rebase. Both live k3d acceptance and model-turn qualification need rerunning
on this base; the earlier results do not qualify the rebased runtime.
