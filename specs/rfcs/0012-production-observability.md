---
author: russellb
implementation_status: Implemented
status: Unspecified
status_note: "The record reports local implementation and qualification, not an RFC acceptance decision."
---

# Default production observability

Status: Implemented locally on 2026-09-23; default k3d acceptance passed.
See the [qualification report](../plans/36-production-observability/qualification.md)
for separate model-turn, hosted CI, and review status.
The [unchanged local baseline](../plans/36-production-observability/baseline.md)
was verified before code changes. See the [implementation plan](../plans/36-production-observability/index.md).

## Outcome and ownership

The production Helm chart makes existing OCC metrics and structured operational
logs available by default. Operators connect their collection infrastructure
through documented private interfaces. A separate demonstration installation
provides Prometheus, Grafana, and a log backend for convenience and testing; it
is explicitly not recommended for production.

This extends deployment packaging and the existing OCC instrumentation and
logging pipeline. It introduces no platform resource or competing architecture.
The [platform design](../../docs/design.md) remains authoritative.

## Production contract

- Helm defaults `metrics.enabled` to `true` for API and worker, using their
  existing Pod-IP listeners on port 9464. Direct process and development defaults
  remain unchanged. Explicit Helm opt-out remains available.
- Empty scraper selectors mean no metrics ingress grant. Supplying selectors
  requires both namespace and Pod labels in the same NetworkPolicy peer;
  partial configuration fails rendering. Scraping discovers every Pod, including
  replacements, without a public endpoint or Prometheus Operator dependency.
- Operational logs default to `info`. Container output is the local source;
  OTLP delivery exists only after configuring collection and a destination.
  An unconfigured backend does not break OCC startup or claim successful export.
- Operators choose one collection route per stream: an existing Collector using
  the shipped receiver/filtering policy, or the optional bundled Collector.
  Neither choice installs a storage backend or viewer in the production chart.
- Preserve trusted attribution, approved events/fields, credential isolation,
  disabled native runtime OTLP export, bounded buffers and best-effort delivery.
  Audit evidence remains in PostgreSQL. Collector health metrics are separately
  discoverable and privately scrapeable when the Collector is enabled.
- Preserve external export to one approved IPv4 `/32` and port. Add an explicit
  alternative for an in-cluster receiver: paired namespace/Pod selectors and a
  port, mutually exclusive with the CIDR. This supports the demo without granting
  cluster-wide egress or relying on a receiver Pod's transient IP.

## Demonstration contract

Use a separate Helm release under `deploy/helm/openclaw-observability-demo/` with
Prometheus, Grafana, and single-process Loki. Reuse existing dashboard assets and
the production Collector rather than maintaining a second filtering pipeline.
Loki's [native OTLP ingestion](https://grafana.com/docs/loki/latest/send-data/otel/native_otlp_vs_loki_exporter/)
provides the log destination; configure structured metadata and the full logs
endpoint required by the shipped exporter.

Require explicit demo enablement, digest-pinned images, bounded resources,
disposable storage, generated private Grafana credentials, and loopback access
through port forwarding. Provide metric dashboards and a saved operational-log
view. Removing the demo must preserve OCC, its database, and Agents. Explain how
to replace or disable demo collection before removing its destinations.

## Required proof

The normal observability acceptance command uses a disposable local k3d cluster,
real Helm installation, enforcing NetworkPolicies, and real telemetry backends.
It runs both source validation and demo smoke checks. Rendering, Pod readiness,
or synthetic telemetry alone do not establish acceptance.

Credential-free PR CI verifies OCC API/worker metrics and logs, real collection,
network boundaries, and demo queries. A deterministic Compute fixture can exercise
the regular Agent lifecycle in that lane; it does not prove runtime log sources.

The default local command and ordinary PR CI require no model credentials and
make no model calls. The user selected this boundary on 2026-09-23. Embedded
OpenClaw and dedicated Codex model-turn log checks run separately through an
explicit local command or the existing protected `k3d-otel` CI dispatch, preserving
the `integration-otel` environment and reviewer protections. Missing credentials
fail an explicitly selected model-turn run, not default acceptance. Report the
two coverage scopes separately; no untrusted PR receives model credentials.

Record source revision, image identities, expected/executed cases, skips, backend
observations, and cleanup outcome. Selected cases must pass without skips; a
pending protected job is unverified coverage.

## Documentation and exclusions

Update [metrics](../../docs/reference/metrics.md), [production settings](../../docs/reference/settings/production.md),
[observability](../../docs/guides/observability.md), production installation/handoff,
and affected flows, testing guides, and cheat sheets with the implementation.
Do not rewrite earlier specifications or describe this proposal as delivered.

Tracing, audit export, new runtime metric families, production monitoring
operations, and guaranteed operational-log durability are outside this work.
