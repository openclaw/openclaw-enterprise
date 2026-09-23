import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "@prometheus-io/client";
import type { PlatformMetricsSnapshot } from "@openclaw-enterprise/occ";

export type WorkKind =
  | "namespace_ensure"
  | "namespace_delete"
  | "agent_provisioning"
  | "agent_revision"
  | "agent_stop"
  | "agent_delete";
export type WorkOutcome = "success" | "pending" | "retry" | "permanent" | "claim_lost" | "error";

const processFamilies = new Set([
  "process_cpu_user_seconds_total",
  "process_cpu_system_seconds_total",
  "process_cpu_seconds_total",
  "process_start_time_seconds",
  "process_resident_memory_bytes",
  "nodejs_heap_size_total_bytes",
  "nodejs_heap_size_used_bytes",
  "nodejs_external_memory_bytes",
  "nodejs_eventloop_lag_seconds",
  "nodejs_eventloop_lag_min_seconds",
  "nodejs_eventloop_lag_max_seconds",
  "nodejs_eventloop_lag_mean_seconds",
  "nodejs_eventloop_lag_stddev_seconds",
  "nodejs_eventloop_lag_p50_seconds",
  "nodejs_eventloop_lag_p90_seconds",
  "nodejs_eventloop_lag_p99_seconds",
  "nodejs_version_info",
  "nodejs_gc_duration_seconds",
]);
const methods = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

export function createOccMetrics(
  service: "api" | "worker",
  snapshot?: () => Promise<PlatformMetricsSnapshot>,
) {
  const registry = new Registry();
  registry.setDefaultLabels({ service });
  collectDefaultMetrics({ register: registry, prefix: "occ_" });
  for (const metric of registry.getMetricsAsArray()) {
    if (!processFamilies.has(metric.name.slice(4))) {
      registry.removeSingleMetric(metric.name);
    }
  }
  const requests =
    service === "api"
      ? new Counter({
          name: "occ_http_requests_total",
          help: "Completed OCC HTTP responses.",
          labelNames: ["route", "method", "status_class"],
          registers: [registry],
        })
      : undefined;
  const httpDuration =
    service === "api"
      ? new Histogram({
          name: "occ_http_request_duration_seconds",
          help: "Seconds to complete an OCC HTTP response.",
          labelNames: ["route", "method"],
          registers: [registry],
          buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
        })
      : undefined;
  const attempts =
    service === "worker"
      ? new Counter({
          name: "occ_reconciliation_attempts_total",
          help: "Finished OCC claimed-work processing passes, not deployments.",
          labelNames: ["work_kind", "outcome"],
          registers: [registry],
        })
      : undefined;
  const workDuration =
    service === "worker"
      ? new Histogram({
          name: "occ_reconciliation_attempt_duration_seconds",
          help: "Seconds processing one OCC claim, excluding queue wait.",
          labelNames: ["work_kind"],
          registers: [registry],
          buckets: [0.01, 0.1, 0.5, 1, 5, 15, 30, 60, 120, 300, 900],
        })
      : undefined;
  const agents =
    service === "worker"
      ? new Gauge({
          name: "occ_agents",
          help: "Persisted Agents by reconciliation lifecycle, not live workload health.",
          labelNames: ["lifecycle_state"],
          registers: [registry],
        })
      : undefined;
  const pending =
    service === "worker"
      ? new Gauge({
          name: "occ_work_pending",
          help: "Shared database count of queued and claimed OCC work, including delayed retries.",
          registers: [registry],
        })
      : undefined;
  const oldestPendingAge =
    service === "worker"
      ? new Gauge({
          name: "occ_work_oldest_pending_age_seconds",
          help: "Seconds since the oldest queued or claimed work was admitted, including delayed work.",
          registers: [registry],
        })
      : undefined;
  const operationDuration =
    service === "worker"
      ? new Histogram({
          name: "occ_agent_operation_duration_seconds",
          help: "Seconds from work admission to successful Agent deployment or stop completion.",
          labelNames: ["operation"],
          registers: [registry],
          buckets: [0.1, 0.5, 1, 5, 15, 30, 60, 120, 300, 900, 1800],
        })
      : undefined;
  // These two bounded label sets provide a baseline before the first operation.
  operationDuration?.zero({ operation: "deploy" });
  operationDuration?.zero({ operation: "stop" });
  let inFlight: Promise<string> | undefined;
  return {
    contentType: registry.contentType,
    observeHttp(route: string, method: string, status: number, seconds: number) {
      if (route === "/healthz" || route === "/readyz") {
        return;
      }
      const labels = { route, method: methods.has(method) ? method : "OTHER" };
      requests?.inc({
        ...labels,
        status_class: status >= 100 && status < 600 ? `${Math.floor(status / 100)}xx` : "other",
      });
      httpDuration?.observe(labels, seconds);
    },
    observeWork(work_kind: WorkKind, outcome: WorkOutcome, seconds: number) {
      attempts?.inc({ work_kind, outcome });
      workDuration?.observe({ work_kind }, seconds);
    },
    observeAgentOperation(operation: "deploy" | "stop", seconds: number) {
      operationDuration?.observe({ operation }, seconds);
    },
    exposition(): Promise<string> {
      if (inFlight !== undefined) {
        return inFlight;
      }
      inFlight = (async () => {
        if (service === "worker") {
          if (snapshot === undefined) {
            throw new Error("Worker metrics require a database snapshot.");
          }
          const values = await snapshot();
          for (const [lifecycle_state, count] of Object.entries(values.agents)) {
            agents!.set({ lifecycle_state }, count);
          }
          pending!.set(values.pending);
          oldestPendingAge!.set(values.oldestPendingAgeSeconds);
        }
        return registry.metrics();
      })().finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },
  };
}

export type OccMetrics = ReturnType<typeof createOccMetrics>;
