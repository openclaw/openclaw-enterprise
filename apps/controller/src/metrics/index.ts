import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "@prometheus-io/client";
import type { PlatformMetricsSnapshot } from "@openclaw-enterprise/occ";

export type WorkKind =
  | "namespace_ensure"
  | "namespace_delete"
  | "agent_provisioning"
  | "agent_revision"
  | "agent_stop"
  | "agent_delete"
  | "agent_credential_withdrawal"
  | "agent_sandbox_policy";
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
  const api =
    service === "api"
      ? {
          requests: new Counter({
            name: "occ_http_requests_total",
            help: "Completed OCC HTTP responses.",
            labelNames: ["route", "method", "status_class"],
            registers: [registry],
          }),
          httpDuration: new Histogram({
            name: "occ_http_request_duration_seconds",
            help: "Seconds to complete an OCC HTTP response.",
            labelNames: ["route", "method"],
            registers: [registry],
            buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
          }),
          // A callback whose state and browser cookie match no pending attempt is unauthenticated
          // and writes no audit event; this counter is its only aggregate record.
          unmatchedCallbacks: new Counter({
            name: "occ_sign_in_unmatched_callbacks_total",
            help: "External sign-in callbacks refused before matching a pending attempt.",
            labelNames: ["provider"],
            registers: [registry],
          }),
        }
      : undefined;
  const worker =
    service === "worker"
      ? {
          attempts: new Counter({
            name: "occ_reconciliation_attempts_total",
            help: "Finished OCC claimed-work processing passes, not deployments.",
            labelNames: ["work_kind", "outcome"],
            registers: [registry],
          }),
          workDuration: new Histogram({
            name: "occ_reconciliation_attempt_duration_seconds",
            help: "Seconds processing one OCC claim, excluding queue wait.",
            labelNames: ["work_kind"],
            registers: [registry],
            buckets: [0.01, 0.1, 0.5, 1, 5, 15, 30, 60, 120, 300, 900],
          }),
          agents: new Gauge({
            name: "occ_agents",
            help: "Persisted Agents by reconciliation lifecycle, not live workload health.",
            labelNames: ["lifecycle_state"],
            registers: [registry],
          }),
          pending: new Gauge({
            name: "occ_work_pending",
            help: "Shared database count of queued and claimed OCC work, including delayed retries.",
            registers: [registry],
          }),
          oldestPendingAge: new Gauge({
            name: "occ_work_oldest_pending_age_seconds",
            help: "Seconds since the oldest queued or claimed work was admitted, including delayed work.",
            registers: [registry],
          }),
          operationDuration: new Histogram({
            name: "occ_agent_operation_duration_seconds",
            help: "Seconds from work admission to successful Agent deployment or stop completion.",
            labelNames: ["operation"],
            registers: [registry],
            // Deployments span seconds to the 900-second convergence deadline.
            buckets: [
              0.1, 0.5, 1, 2, 5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240, 300, 450, 600, 900,
              1800,
            ],
          }),
        }
      : undefined;
  // These bounded label sets provide a baseline before the first observation.
  worker?.operationDuration.zero({ operation: "deploy" });
  worker?.operationDuration.zero({ operation: "stop" });
  for (const provider of ["github", "google", "oidc"]) {
    api?.unmatchedCallbacks.inc({ provider }, 0);
  }
  let inFlight: Promise<string> | undefined;
  return {
    contentType: registry.contentType,
    observeHttp(route: string, method: string, status: number, seconds: number) {
      if (route === "/healthz" || route === "/readyz") {
        return;
      }
      const labels = { route, method: methods.has(method) ? method : "OTHER" };
      api?.requests.inc({
        ...labels,
        status_class: status >= 100 && status < 600 ? `${Math.floor(status / 100)}xx` : "other",
      });
      api?.httpDuration.observe(labels, seconds);
    },
    observeWork(work_kind: WorkKind, outcome: WorkOutcome, seconds: number) {
      worker?.attempts.inc({ work_kind, outcome });
      worker?.workDuration.observe({ work_kind }, seconds);
    },
    observeAgentOperation(operation: "deploy" | "stop", seconds: number) {
      worker?.operationDuration.observe({ operation }, seconds);
    },
    observeUnmatchedSignInCallback(provider: "github" | "google" | "oidc") {
      api?.unmatchedCallbacks.inc({ provider });
    },
    exposition(): Promise<string> {
      if (inFlight !== undefined) {
        return inFlight;
      }
      inFlight = (async () => {
        if (worker !== undefined) {
          if (snapshot === undefined) {
            throw new Error("Worker metrics require a database snapshot.");
          }
          const values = await snapshot();
          for (const [lifecycle_state, count] of Object.entries(values.agents)) {
            worker.agents.set({ lifecycle_state }, count);
          }
          worker.pending.set(values.pending);
          worker.oldestPendingAge.set(values.oldestPendingAgeSeconds);
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
