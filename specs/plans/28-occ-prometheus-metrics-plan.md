---
rfc: ../rfcs/28-occ-prometheus-metrics.md
---

# OCC metrics implementation plan

**Goal:** Implement [the accepted metrics proposal](../rfcs/28-occ-prometheus-metrics.md)
and the requested Prometheus/Grafana development walkthrough.

**Architecture:** Each OCC process owns its registry and private listener.
Fastify observes completed requests, the worker observes processing passes,
and a bounded read-only persistence collector supplies shared gauges.

**Constraints:** Aggregate labels only; six application families; explicit
loopback development and Pod-IP production listeners; real integration proof;
no dependency installation as a verification side effect. The development
walkthrough additionally provisions a local Prometheus/Grafana stack.

## Execution

- [x] Add HTTP integration coverage in `tests/integration/occ-metrics.test.mjs`
      using the real Fastify app and a real metrics listener. Verify response
      accounting, route normalization, registry isolation, and listener lifecycle.
- [x] Implement `apps/controller/src/metrics/` registry, configuration, and
      listener; compose them in `server.mjs`, Fastify, and both composition modules.
- [x] Extend the OCC persistence contract for one aggregate snapshot and wire a
      separate bounded pool into worker metrics. Extend the regular Agent workflow
      proof to check draft/active counts, redeployment, and collection failures.
- [x] Instrument claimed worker passes at committed outcome boundaries, with
      independent process timing and no log-level dependency. Verify retries and
      lost claims using existing database scenarios.
- [ ] Add opt-in Helm ports, Pod-IP configuration, and narrowly selected ingress
      policy. Verify rendered manifests and real cluster allow/deny behavior.
      Implementation and rendering passed; live cluster proof remains outstanding.
- [ ] Add development Prometheus configuration, Grafana provisioning/dashboard,
      and a walkthrough with traffic generation, query results, failure checks,
      and scoped cleanup. Preserve container-loopback listener semantics.
      Assets and real Prometheus/Grafana smoke proof are delivered; the complete
      Compose overlay still requires a real-runtime environment.
- [ ] Update current references, guides, flows, navigation, and delivery status.
      Run focused integrations, type checking, workspace isolation, formatting,
      documentation checks, and inspect the final diff. Record infrastructure gaps
      explicitly; do not mark the proposal completed without required proof.
      Documentation updates are delivered. Focused integrations, type checking,
      workspace isolation, formatting, and diff checks passed. The length checker is
      blocked by the absent docs-site dependency graph. See the proposal's
      delivery record for remaining runtime acceptance checks.

## Review notes

The user authorized implementation and the development dashboard addition.
Execute in the current checkout to retain the uncommitted approved proposal;
do not publish or merge as part of this request. Process defaults use a pinned
client; the implementation records its actual exported family contract.
