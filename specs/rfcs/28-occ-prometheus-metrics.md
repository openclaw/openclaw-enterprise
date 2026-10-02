---
status: Accepted
status_note: "The linked implementation plan identifies this as the accepted metrics proposal; runtime and cluster acceptance remain separate."
---

# Feature Spec: Initial OCC Prometheus metrics

**Date:** 2026-09-15

**Status:** Implementing — code and local proof; runtime/cluster acceptance outstanding
**Owner:** OCC API, worker, persistence, and deployment packaging

<!-- Length review: retained as one coherent initial-milestone contract so metric
semantics, collection failures, aggregation, and acceptance remain reviewable together. -->

## Purpose and scope

Implementation addition approved 2026-09-15: include a development-only
Prometheus/Grafana walkthrough and provisioned dashboard. Production dashboards
and managed monitoring backends remain outside scope.

Give operators an aggregate view of OpenClaw Control Plane (OCC) traffic,
reconciliation, Agent inventory, and Node.js process health. Support independent
scraping of every API and worker replica so horizontal scaling does not obscure
failures or multiply shared inventory counts.

This proposal follows the authoritative [platform design](../../docs/design.md).
It extends OCC's operational capability and regular API/worker lifecycles. It
introduces no resource primitive, Driver capability, or competing architecture.
Acceptance authorizes this bounded metrics surface and its packaging; it does
not establish that metrics or general horizontal-scaling support have shipped.

Today, the [observability guide](../../docs/guides/observability.md) documents logs,
audit persistence, and Collector self-metrics. The logging proposal
[explicitly excluded application instrumentation](../plans/20-common-otel-logging/index.md).
This later proposal adds direct Prometheus instrumentation; the logging
Collector remains independent, including its existing port `8888`.

Include six application metric families plus a bounded set of standard process
metrics. Agent inventory is the only persisted-resource inventory. Exclude
Agent-owned gateway/Codex instrumentation, other resource counts, tenant
breakdowns, model usage/cost, Driver-call and database-pool instrumentation,
tracing, dedicated security metrics, dashboards, alert rules, and SLOs.
Metrics are operational observations, not audit or billing evidence.

## Ownership and integration

The [API executable](../../apps/controller/src/server.mjs) serves HTTP and commits
resource changes and asynchronous work to PostgreSQL. The independent
[worker executable](../../apps/controller/src/worker.mjs) claims that work,
reauthorizes it, calls Compute, and persists outcomes. Compose and Helm
currently run one of each; their memory and database pools are separate.

Each process composes an internal OCC metrics component with a private registry,
fixed instruments, and a dedicated HTTP listener. Connect request observations
to the actual Fastify lifecycle and work observations to the existing worker
processing/finalization paths, independently of log level. Worker-owned database
collection extends the persistence contract through curated public exports;
HTTP handlers must not contain SQL or enumerate tenant resources through IAM.
No ad hoc package subpath exports or publicly programmable instrumentation API.

Use a pinned Prometheus Node client with standard process collectors, following
its [registry and default-metrics API](https://github.com/prometheus/client_js).
Document the selected package/version and enabled families in the implementation
PR. Use direct pull exposition; an OTLP SDK, Collector metrics pipeline,
Pushgateway, metrics sidecar, and leader election are outside this milestone.

## Metric contract

Every family has a fixed `service="api|worker"` label. Labels below are additional.
Durations use monotonic time and seconds. Counters reset on process restart.

| Metric                                        | Type / process     | Labels                            | Meaning                                                                        |
| --------------------------------------------- | ------------------ | --------------------------------- | ------------------------------------------------------------------------------ |
| `occ_http_requests_total`                     | Counter / API      | `route`, `method`, `status_class` | Completed HTTP responses.                                                      |
| `occ_http_request_duration_seconds`           | Histogram / API    | `route`, `method`                 | Time from request hook to response completion.                                 |
| `occ_reconciliation_attempts_total`           | Counter / worker   | `work_kind`, `outcome`            | Finished processing passes for claimed work, including deferrals and failures. |
| `occ_reconciliation_attempt_duration_seconds` | Histogram / worker | `work_kind`                       | Time processing one claim, including Driver calls and finalization.            |
| `occ_work_pending`                            | Gauge / worker     | None                              | Database count of queued and claimed work, including delayed retries.          |
| `occ_agents`                                  | Gauge / worker     | `deployment_state`                | Database count of Agents with or without a selected active revision.           |

### HTTP

Observe exactly once per completed response, including authentication failures,
authorization denials, invalid requests, and server errors. Cover API, auth, and
console traffic handled by the app; exclude `/healthz`, `/readyz`, and the
separate metrics listener. A disconnected request without a completed response
is excluded from both count and histogram in this milestone. HTTP measurements
are not model-turn latency or WebSocket-session measurements.

`route` is a registered Fastify route template, with `unmatched` for no match;
wildcards remain literal templates. Never derive it from raw URLs or query
strings. `method` is `GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|OTHER`;
`status_class` is `1xx|2xx|3xx|4xx|5xx|other`. Thus 401/403 responses contribute
to 4xx counts but do not distinguish authorization from other client failures.

Histogram boundaries: `0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10`
seconds, plus the implicit positive-infinity bucket. Omit status labels from
latency to constrain series count. Histograms expose count and sum as well.

### Reconciliation

`work_kind` is `namespace_ensure|namespace_delete|agent_revision`.
`outcome` is `success|pending|retry|permanent|claim_lost|error`.
Record one observation when processing a successfully acquired claim ends.
Use the committed result for normal outcomes; lost claims and unexpected
failures have their own outcomes. Do not report success before its transaction
commits. Idle polls and stale-claim recovery without processing a claim are
excluded. Terminated processes can lose in-memory observations.

These count passes, not unique deployments or durable queue completions. A
pending pass can recur without spending the failure budget; maintenance and
superseded work can also finish successfully. Preserve the existing queue
semantics and expose no result-code or Driver labels initially.

Duration starts after claiming and ends at processing completion or failure;
it excludes queue wait and time between retries. Boundaries: `0.01, 0.1, 0.5,
1, 5, 15, 30, 60, 120, 300, 900` seconds, plus positive infinity.

### Shared database gauges

`deployment_state="draft"` means `activeRevisionId` is absent; `active` means
present. This is persisted selection, not live workload readiness. An Agent
awaiting first activation remains draft; redeploying an active Agent counts
once as active. Always return both categories, including zero. No Compute
polling or new Agent lifecycle state is introduced.

Collect inventory and pending work in one bounded, read-only database snapshot
on each worker scrape, using aggregate queries and the existing limited
application role. Scope queries to the server-owned Installation and the work
supported by the worker. Reuse the queue's pending predicate. Do not increment
inventory from local events: restarts and other replicas would cause drift.

Use a dedicated metrics pool with maximum one connection per worker and a
two-second total collection deadline covering acquisition and queries. Enforce
database-side query timeout and clean up canceled operations. Concurrent scrapes
share the in-flight snapshot; they do not accumulate database work. No periodic
cache or last-good-value fallback initially. Failed collection returns `503`
without a partial exposition, making that target's Prometheus `up` zero while
leaving reconciliation running. Recovery produces fresh values on the next
scrape. API scrapes have no database dependency.

### Process defaults and cardinality

Include client-provided CPU time, resident memory, heap usage, event-loop lag,
GC duration, process start time, and Node version information in both processes.
Retain standard names with an `occ_` prefix. Freeze the exact family list,
buckets, and finite collector labels in the implementation's current reference;
dependency upgrades must explicitly review changes. Exclude active
handle/resource-type breakdowns and optional native add-ons initially.

No application labels may contain Installation, Namespace, Agent, revision,
actor, request, Driver-instance IDs, secrets, payloads, raw URLs, arbitrary error
text, or user-defined tags. Allow only the table's labels, the fixed service
label, histogram `le`, and reviewed finite process metadata. Library defaults
must satisfy the same boundary. Document the maximum series count using the
registered route/method pairs and histogram buckets; do not preallocate their
full Cartesian product. No configurable labels or buckets in this milestone.

## Listener and packaging

Each executable accepts `OCC_METRICS_ENABLED` (default `false`),
`OCC_METRICS_HOST`, and `OCC_METRICS_PORT`. Enabling requires both host and port;
reject malformed booleans, invalid ports, conflicting ports, and settings supplied
while disabled. Development accepts explicit loopback addresses only; production
uses the explicit Pod IP. Configuration is process-local startup input, not a
tenant setting. Bind before normal processing starts; configuration/bind failure
fails startup and releases opened resources. Close the listener and metrics
resources during graceful shutdown. Later collection failures affect scrapes,
not API mutations or work outcomes.

Expose only `GET /metrics`, returning Prometheus text with the client's correct
content type and no caching. Other paths return 404 and unsupported methods on
that path return 405. Set a five-second request deadline and bound connections.
Serve no resource API, session, or IAM operation on this listener. Aggregate
operational data remains private: network access is its authorization boundary.

Helm adds opt-in metrics configuration, a named `metrics` port (default `9464`)
on each API/worker Pod, Pod-IP environment wiring, and one ingress policy per
component. Require explicit scraper namespace and Pod selectors, combined in
the same peer to require both. Reject empty selectors. Review all chart policies
because NetworkPolicy allowances are additive. No public Ingress or host port.

Provide an operator-owned Prometheus Kubernetes `role: pod` discovery example
selecting this release's API/worker Pods and named metrics port. Prometheus
discovers and scrapes each Pod directly, including rollout overlaps. Pod
annotations alone are not discovery. No ServiceMonitor/PodMonitor CRD dependency,
metrics Service, Prometheus installation, or replica-count changes are required.

Document native development loopback scraping. With Compose's isolated network
namespaces, a container-loopback listener cannot be reached through a published
port. Initially verify Compose metrics from inside each container's network
namespace; host-published Compose metrics are deferred. Do not weaken the
approved development binding rule to make port forwarding work.

## Aggregation and availability

Scrape every process separately, never a load-balanced metrics endpoint.
Operators attach `cluster`, `installation`, `job`, and `instance` target labels;
`installation` identifies the deployment without exposing its persisted UUID.
These labels are infrastructure configuration, not OCC-emitted tenant labels.
Keep deployment identity in every cross-replica query.

For a deployment selected by those target labels:

```promql
# Requests/second across API replicas; rate before sum handles resets.
sum by (cluster, installation) (rate(occ_http_requests_total[5m]))

# Per-route p95 across API replicas; retain the histogram boundary.
histogram_quantile(0.95,
  sum by (cluster, installation, route, method, le)
    (rate(occ_http_request_duration_seconds_bucket[5m])))

# Deduplicate shared inventory and exclude currently failed scrape targets.
max by (cluster, installation, deployment_state)
  (occ_agents and on (job, instance, cluster, installation) (up == 1))
```

Apply the same `max` and healthy-target filtering to `occ_work_pending`.
Summing shared gauges multiplies their value by worker count. `max` is an
approximation across independently timed snapshots: during changes it can
temporarily retain a higher count, and category maxima need not describe one
consistent fleet snapshot. All failed/missing targets mean unknown, never zero.
Observe `up` alongside these queries. HA Prometheus backend deduplication is
operator-owned; avoid combining duplicated scraper series without deduplication.

Sum rates of process CPU counters and reconciliation counters; aggregate
reconciliation histogram buckets before calculating quantiles. Memory can be
summed for total use or maximized for the largest replica. Inspect event-loop
lag per process or use its maximum; do not average replica quantiles. See
[Prometheus query semantics](https://prometheus.io/docs/prometheus/latest/querying/functions/).

## Acceptance and delivery

Extend existing integration workflows through real API callers and persistence:

1. Exercise successful, denied, invalid, and failing HTTP operations; scrape the
   actual listener and verify counts, duration buckets, exclusions, and absence
   of identifiers after requests containing distinct paths and input values.
2. Create and deploy an Agent through the supported workflow with real
   PostgreSQL and selected Compute dependencies. Observe draft-to-active counts,
   redeployment counting once, pending work, and reconciliation passes. Exercise
   consequential retry, denial, and lost-claim paths through existing scenarios.
3. Scrape two API instances handling separate traffic and two workers sharing
   state. Verify additive local measurements, identical stable inventory,
   overlapping snapshots, restart behavior, and the documented query results
   using a disposable Prometheus fixture. Test real database collection failure,
   bounded concurrent scrapes, and recovery without stale or fabricated zeros.
4. Verify process collectors on live processes; listener configuration, disabled
   behavior, port conflicts, and graceful cleanup; prove metrics work with logs
   disabled. Use real enforcing Kubernetes NetworkPolicies to prove selected
   scrapers can reach both processes and an unselected Pod cannot. Chart rendering
   alone is insufficient network proof.

Follow [Enterprise testing](../../docs/testing/README.md) and test-audit when
implementing. Missing infrastructure is a recorded verification gap, not
permission to replace the supported path with mocks or omit integration proof.

In the implementation PR, update the [controller reference](../../docs/reference/controller.md),
[settings](../../docs/reference/settings.md), [observability guide](../../docs/guides/observability.md),
and [worker flow](../../docs/flows/controller-worker.md) together. Put collector
contracts in reference, scrape configuration/recovery in the guide, and fixtures
and proof limits under testing; repair navigation. Record the exact enabled
process metrics and cardinality budget before shipping. Mark this proposal
Completed only with its implementation identity, actual proof, limitations,
and owning current references.

## Delivery record

Implementation is in the working-tree change based on `bbb9def2`, with
`@prometheus-io/client@0.16.1`. Current owners are the
[metrics reference](../../docs/reference/metrics.md),
[production scraping guide](../../docs/guides/observability/metrics.md), and
[development dashboard/testing guide](../../docs/testing/metrics.md).

Local proof passed: HTTP and PostgreSQL metrics, simultaneous scrape timeouts
under a real database lock and subsequent recovery, 19 existing worker
regressions including retry/lost-claim metrics, Helm metrics rendering, and real
Prometheus remote-write/Grafana dashboard provisioning with all panel queries.
CI suite ownership is registered and audited.

Outstanding acceptance: the extended genuine Agent-runtime/Helm Kubernetes
NetworkPolicy journeys and the complete development Compose overlay have not
run here. Local Prometheus/Grafana proof uses actual containers with a native
test API; it does not establish Compose namespace sharing. Documentation checks
require the absent docs-site dependency graph. Do not infer completed milestone
acceptance from these partial proof results.

Upstream integration on 2026-09-16 fast-forwarded main to `23d490b9` while
preserving this work. The current metrics contract additionally classifies
upstream Agent-stop work as `agent_stop`; the metrics pool uses the shared
PostgreSQL authentication factory with its read-only limits. The combined
PostgreSQL/worker/metrics/authentication tests passed 33 cases, and packaging,
startup, and CI tests passed 54 cases. Local runtime acceptance remains blocked
by an immediate package-specific installer kill; no running Agent is claimed.
