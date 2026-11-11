import { setTimeout as delay } from "node:timers/promises";

function isConnectionError(error) {
  return ["ECONNREFUSED", "ECONNRESET", "UND_ERR_SOCKET"].includes(error.cause?.code);
}

function monitoringFailure(stage, reason, details = {}) {
  const error = new Error(`Monitoring ${stage} failed: ${reason}`);
  error.openclawCiDiagnostic = { kind: "metrics-monitoring", stage, reason, ...details };
  return error;
}

export async function waitForMonitoring(stage, read, containers, inspectContainer) {
  const end = Date.now() + 60_000;
  let lastHttpStatus;
  // The deadline is checked after each read, so the last read happens at or past it.
  for (;;) {
    // A detached container can exit before its listener binds; surface that
    // setup failure instead of waiting for a scrape that cannot succeed.
    for (const [role, name] of containers) {
      let state;
      try {
        state = await inspectContainer(name);
      } catch {
        throw monitoringFailure(stage, "query-error", { container: role, lastHttpStatus });
      }
      if (!state.Running) {
        throw monitoringFailure(stage, "container-exited", {
          container: role,
          exitCode: state.ExitCode,
          lastHttpStatus,
        });
      }
    }
    try {
      if (await read()) {
        return;
      }
    } catch (error) {
      if (error.openclawCiDiagnostic?.reason === "query-error") {
        throw error;
      }
      const connectionError = isConnectionError(error);
      const serverError = error.httpStatus >= 500 && error.httpStatus <= 599;
      const datasourceProvisioning =
        stage === "grafana-datasource" && [400, 404].includes(error.httpStatus);
      if (
        !connectionError &&
        !["TimeoutError", "AbortError"].includes(error.name) &&
        !serverError &&
        !datasourceProvisioning
      ) {
        throw monitoringFailure(stage, "query-error", {
          lastHttpStatus: error.httpStatus ?? lastHttpStatus,
        });
      }
      lastHttpStatus = error.httpStatus ?? lastHttpStatus;
    }
    if (Date.now() >= end) {
      break;
    }
    await delay(500);
  }
  throw monitoringFailure(stage, "timeout", { lastHttpStatus });
}

export async function queryPrometheus(origin, stage, expression) {
  const response = await fetch(`${origin}/api/v1/query?query=${encodeURIComponent(expression)}`, {
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) {
    if (response.status < 500) {
      throw monitoringFailure(stage, "query-error", { lastHttpStatus: response.status });
    }
    const error = new Error(`Prometheus query returned HTTP ${response.status}`);
    error.httpStatus = response.status;
    throw error;
  }
  let body;
  try {
    body = await response.json();
  } catch (error) {
    if (isConnectionError(error) || ["TimeoutError", "AbortError"].includes(error.name)) {
      error.httpStatus = response.status;
      throw error;
    }
    throw monitoringFailure(stage, "query-error", { lastHttpStatus: response.status });
  }
  if (body?.status !== "success" || !Array.isArray(body.data?.result)) {
    throw monitoringFailure(stage, "query-error", { lastHttpStatus: response.status });
  }
  return body.data.result;
}

export async function checkGrafanaDatasource(origin) {
  const response = await fetch(`${origin}/api/datasources/uid/occ-prometheus/health`, {
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) {
    const error = new Error(`Grafana datasource returned HTTP ${response.status}`);
    error.httpStatus = response.status;
    throw error;
  }
  let datasource;
  try {
    datasource = await response.json();
  } catch (error) {
    if (isConnectionError(error) || ["TimeoutError", "AbortError"].includes(error.name)) {
      error.httpStatus = response.status;
      throw error;
    }
    throw monitoringFailure("grafana-datasource", "query-error", {
      lastHttpStatus: response.status,
    });
  }
  if (
    datasource === null ||
    typeof datasource !== "object" ||
    Array.isArray(datasource) ||
    typeof datasource.status !== "string"
  ) {
    throw monitoringFailure("grafana-datasource", "query-error", {
      lastHttpStatus: response.status,
    });
  }
  return datasource.status === "OK";
}

// Picks `count` distinct free ports before any container starts. A port picked
// after a host-network container was started could be one that container has not
// bound yet (finding 1667).
export async function distinctPorts(count, pick, attempts = 10 * count) {
  const ports = new Set();
  for (let attempt = 0; ports.size < count; attempt += 1) {
    if (attempt >= attempts) {
      throw new Error(`Unable to pick ${count} distinct free ports in ${attempts} attempts.`);
    }
    ports.add(await pick());
  }
  return [...ports];
}

// Prometheus exits with status 1 when its listener cannot bind. Only this cause is
// worth a retry with new ports; any other exit is a real failure.
export function portClash(log) {
  return /\baddress already in use\b/i.test(log);
}

// The last lines of a container log, one entry per line. The CI reporter bounds
// each diagnostic from its start, so a whole log in one diagnostic loses the tail,
// which is where an exit reason is.
export function containerLogTail(log, count = 15) {
  return log
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .slice(-count);
}
