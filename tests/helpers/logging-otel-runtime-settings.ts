import assert from "node:assert/strict";
import { asRecord, isNonEmptyString } from "../../packages/utils/src/index.ts";

type ObservationSelection = { enabled: boolean };

export function requireOtelIdentity(value: unknown, description: string): string {
  assert.ok(isNonEmptyString(value), `${description} must be a nonempty string`);
  return value;
}

function assertNativeExporterDisabled(
  name: string,
  role: unknown,
  env: ReadonlyMap<string, unknown>,
) {
  assert.deepEqual(
    [...env.keys()].filter((key) => key.startsWith("OTEL_")),
    [],
    `${name} must not enable a native OTel exporter`,
  );
  if (role === "gateway") {
    assert.equal(
      env.get("OPENCLAW_LOG_LEVEL"),
      undefined,
      `${name} must not carry tenant log-level env`,
    );
  }
  if (role === "agent") {
    assert.equal(env.get("LOG_FORMAT"), "json", `${name} must emit Codex stderr as JSON`);
    const rustLog = env.get("RUST_LOG") ?? "";
    assert.ok(typeof rustLog === "string", `${name} RUST_LOG must be a string`);
    assert.match(rustLog, /codex_otel=off/, `${name} must disable Codex OTel logs`);
  }
}

function readRuntimeArray(value: unknown, description: string): readonly unknown[] {
  const entries: readonly unknown[] | undefined = Array.isArray(value) ? value : undefined;
  assert.ok(entries, `${description} must be an array`);
  return entries;
}

export function assertDockerRuntimeOtelSettings(
  observation: ObservationSelection,
  containers: readonly unknown[],
) {
  if (!observation.enabled) {
    return;
  }
  for (const value of containers) {
    const container = asRecord(value);
    const name = requireOtelIdentity(container?.Name, "Docker inspect container name");
    const config = asRecord(container?.Config);
    const env = new Map(
      readRuntimeArray(config?.Env ?? [], "Docker inspect environment").map((entry) => {
        assert.ok(typeof entry === "string", "Docker inspect environment entry must be a string");
        const separator = entry.indexOf("=");
        return [entry.slice(0, separator), entry.slice(separator + 1)] as const;
      }),
    );
    const labels = asRecord(config?.Labels);
    const logConfig = asRecord(asRecord(container?.HostConfig)?.LogConfig);
    const options = asRecord(logConfig?.Config);
    assert.equal(logConfig?.Type, "fluentd", `${name} must use the Collector log route`);
    assert.ok(options?.["fluentd-address"], `${name} must select a Fluent receiver`);
    assert.equal(options?.["fluentd-async"], "true", `${name} must not block on export`);
    assertNativeExporterDisabled(name, labels?.["org.openclaw.enterprise.role"], env);
  }
}

export function assertKubernetesRuntimeOtelSettings(
  observation: ObservationSelection,
  pods: readonly unknown[],
) {
  if (!observation.enabled) {
    return;
  }
  for (const pod of pods.filter(Boolean)) {
    const fields = asRecord(pod);
    const metadata = asRecord(fields?.metadata);
    const name = requireOtelIdentity(metadata?.name, "Kubernetes workload Pod name");
    const containers = readRuntimeArray(
      asRecord(fields?.spec)?.containers,
      `${name} Pod containers`,
    );
    const container = asRecord(containers[0]);
    assert.ok(container, `${name} Pod must have a first container`);
    // Secret references contribute an environment name even without a literal value.
    const env = new Map(
      readRuntimeArray(container.env ?? [], `${name} Pod environment`).map((entry) => {
        const variable = asRecord(entry);
        const key = requireOtelIdentity(variable?.name, `${name} Pod environment entry name`);
        return [key, variable?.value] as const;
      }),
    );
    const role = asRecord(metadata?.labels)?.["openclaw.dev/workload-role"];
    assertNativeExporterDisabled(name, role, env);
  }
}
