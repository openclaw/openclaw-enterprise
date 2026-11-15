import { setTimeout as delay } from "node:timers/promises";

function property(value: unknown, key: string): unknown {
  if (value === null || value === undefined) {
    throw new TypeError(`Cannot read properties of ${value} (reading '${key}')`);
  }
  const receiver: unknown = Object(value);
  return (typeof receiver === "object" && receiver !== null) || typeof receiver === "function"
    ? Reflect.get(receiver, key, value)
    : undefined;
}

function setProperty(value: unknown, key: string, data: unknown): void {
  if (value === null || value === undefined) {
    throw new TypeError(`Cannot set properties of ${value} (setting '${key}')`);
  }
  const receiver: unknown = Object(value);
  if (
    ((typeof receiver === "object" && receiver !== null) || typeof receiver === "function") &&
    !Reflect.set(receiver, key, data, value)
  ) {
    throw new TypeError(`Cannot assign to property '${key}'`);
  }
}

function includes(values: readonly unknown[], value: unknown): boolean {
  return values.includes(value);
}

function isConnectionError(error: unknown) {
  const cause = property(error, "cause");
  const code = cause == null ? undefined : property(cause, "code");
  return ["ECONNREFUSED", "ECONNRESET", "UND_ERR_SOCKET"].some((item) => item === code);
}

function monitoringFailure(stage: string, reason: string, details: object = {}) {
  return Object.assign(new Error(`Monitoring ${stage} failed: ${reason}`), {
    openclawCiDiagnostic: { kind: "metrics-monitoring", stage, reason, ...details },
  });
}

export async function waitForMonitoring(
  stage: string,
  read: () => unknown,
  containers: readonly (readonly [string, string])[],
  inspectContainer: (name: string) => Promise<{ Running: unknown; ExitCode: unknown }>,
) {
  const end = Date.now() + 60_000;
  let lastHttpStatus: unknown;
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
      const diagnostic = property(error, "openclawCiDiagnostic");
      if ((diagnostic == null ? undefined : property(diagnostic, "reason")) === "query-error") {
        throw error;
      }
      const connectionError = isConnectionError(error);
      const serverError =
        Number(property(error, "httpStatus")) >= 500 &&
        Number(property(error, "httpStatus")) <= 599;
      const datasourceProvisioning =
        stage === "grafana-datasource" && includes([400, 404], property(error, "httpStatus"));
      if (
        !connectionError &&
        !includes(["TimeoutError", "AbortError"], property(error, "name")) &&
        !serverError &&
        !datasourceProvisioning
      ) {
        throw monitoringFailure(stage, "query-error", {
          lastHttpStatus: property(error, "httpStatus") ?? lastHttpStatus,
        });
      }
      lastHttpStatus = property(error, "httpStatus") ?? lastHttpStatus;
    }
    if (Date.now() >= end) {
      break;
    }
    await delay(500);
  }
  throw monitoringFailure(stage, "timeout", { lastHttpStatus });
}

export async function queryPrometheus(origin: string, stage: string, expression: string) {
  const response = await fetch(`${origin}/api/v1/query?query=${encodeURIComponent(expression)}`, {
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) {
    if (response.status < 500) {
      throw monitoringFailure(stage, "query-error", { lastHttpStatus: response.status });
    }
    const error = Object.assign(new Error(`Prometheus query returned HTTP ${response.status}`), {
      httpStatus: response.status,
    });
    throw error;
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    if (
      isConnectionError(error) ||
      includes(["TimeoutError", "AbortError"], property(error, "name"))
    ) {
      setProperty(error, "httpStatus", response.status);
      throw error;
    }
    throw monitoringFailure(stage, "query-error", { lastHttpStatus: response.status });
  }
  const status = body == null ? undefined : property(body, "status");
  const data = status === "success" ? property(body, "data") : undefined;
  if (status !== "success" || !Array.isArray(data == null ? undefined : property(data, "result"))) {
    throw monitoringFailure(stage, "query-error", { lastHttpStatus: response.status });
  }
  return property(property(body, "data"), "result");
}

export async function checkGrafanaDatasource(origin: string) {
  const response = await fetch(`${origin}/api/datasources/uid/occ-prometheus/health`, {
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) {
    const error = Object.assign(new Error(`Grafana datasource returned HTTP ${response.status}`), {
      httpStatus: response.status,
    });
    throw error;
  }
  let datasource: unknown;
  try {
    datasource = await response.json();
  } catch (error) {
    if (
      isConnectionError(error) ||
      includes(["TimeoutError", "AbortError"], property(error, "name"))
    ) {
      setProperty(error, "httpStatus", response.status);
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
    typeof property(datasource, "status") !== "string"
  ) {
    throw monitoringFailure("grafana-datasource", "query-error", {
      lastHttpStatus: response.status,
    });
  }
  return property(datasource, "status") === "OK";
}

// Picks `count` distinct free ports before any container starts. A port picked
// after a host-network container was started could be one that container has not
// bound yet (finding 1667).
export async function distinctPorts(
  count: number,
  pick: () => number | Promise<number>,
  attempts = 10 * count,
) {
  const ports = new Set<number>();
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
export function portClash(log: string) {
  return /\baddress already in use\b/i.test(log);
}

// The last lines of a container log, one entry per line. The CI reporter bounds
// each diagnostic from its start, so a whole log in one diagnostic loses the tail,
// which is where an exit reason is.
export function containerLogTail(log: string, count = 15) {
  return log
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .slice(-count);
}
