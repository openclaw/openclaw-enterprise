import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { asRecord } from "../../packages/utils/src/index.ts";
import { composeConfiguration } from "../helpers/compose.ts";

function composeRecord(value: unknown, field: string): Record<string, unknown> {
  const record = asRecord(value);
  assert.ok(record, `Expected Compose to render ${field}`);
  return record;
}

function composeLoggingConfiguration(environment: NodeJS.ProcessEnv = {}) {
  const { services, volumes } = composeConfiguration(["compose.yaml", "compose.logging.yaml"], {
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://127.0.0.1:4318/v1/logs",
    ...environment,
  });
  assert.ok(services, "Expected Compose to render services");
  assert.ok(volumes, "Expected Compose to render volumes");
  return {
    service: (name: string) => composeRecord(services[name], `service ${name}`),
    volumes,
  };
}

function hasLoopbackPort(ports: unknown, target: number, published: number) {
  assert.ok(Array.isArray(ports), "Expected Compose to render Collector ports");
  const bindings: readonly unknown[] = ports;
  // Compare the same TCP binding in either provider's resolved representation.
  return bindings.some((port) => {
    if (typeof port === "string") {
      return (
        port === `127.0.0.1:${published}:${target}` ||
        port === `127.0.0.1:${published}:${target}/tcp`
      );
    }
    const binding = composeRecord(port, "Collector port binding");
    return (
      (binding.mode ?? "ingress") === "ingress" &&
      (binding.protocol ?? "tcp") === "tcp" &&
      binding.target === target &&
      (binding.published === published || binding.published === String(published)) &&
      binding.host_ip === "127.0.0.1"
    );
  });
}

export async function developmentLoggingOverride() {
  assert.equal(
    await readFile(new URL("../../deploy/logging/occ.yaml", import.meta.url), "utf8"),
    "logging:\n  level: info\n",
  );

  const { service, volumes } = composeLoggingConfiguration();
  const collector = service("collector");

  assert.equal(
    collector.image,
    "docker.io/otel/opentelemetry-collector-contrib:0.159.0@sha256:1f2c54a30e713fac6b3ae77a1ec84010c2007e29ced8ec666214fc2f6739c1cc",
  );
  assert.ok(hasLoopbackPort(collector.ports, 24224, 24224));
  assert.ok(hasLoopbackPort(collector.ports, 8888, 8888));
  assert.equal(composeRecord(collector.logging, "collector.logging").driver, "local");
  assert.ok(["402653184", "384m"].includes(String(collector.mem_limit)));
  assert.equal(collector.user, "0:0");
  assert.equal(collector.read_only, true);
  assert.deepEqual(collector.cap_drop, ["ALL"]);
  assert.deepEqual(collector.security_opt, ["no-new-privileges:true"]);
  assert.ok(Object.hasOwn(volumes, "occ_otelcol_data"));

  for (const name of ["bootstrap", "controller", "migrate", "worker"]) {
    const logging = composeRecord(service(name).logging, `${name}.logging`);
    assert.equal(logging.driver, "fluentd");
    const options = composeRecord(logging.options, `${name}.logging.options`);
    assert.equal(options["fluentd-address"], "127.0.0.1:24224");
    assert.equal(options["fluentd-async"], "true");
    assert.equal(options["fluentd-buffer-limit"], "1024");
    assert.equal(options.mode, "non-blocking");
    assert.equal(options["max-buffer-size"], "1m");
    assert.equal(options["cache-disabled"], "false");
    assert.equal(options["cache-max-size"], "10m");
    assert.equal(options["cache-max-file"], "2");
    assert.equal(options["cache-compress"], "true");
    assert.ok(typeof options.labels === "string");
    const { labels } = options;
    assert.match(labels, /org\.openclaw\.enterprise\.managed/);
    assert.match(labels, /org\.openclaw\.enterprise\.version/);
    assert.match(labels, /com\.docker\.compose\.service/);
  }
  for (const name of ["controller", "worker"]) {
    const environment = composeRecord(service(name).environment, `${name}.environment`);
    assert.equal(environment.OCC_DOCKER_LOGGING_ADDRESS, "127.0.0.1:24224");
  }
  assert.equal(service("postgres").logging, undefined);

  const overridden = composeLoggingConfiguration({
    OCC_DOCKER_LOGGING_ADDRESS: "127.0.0.1:25224",
    OTEL_COLLECTOR_PORT: "25224",
    OTEL_COLLECTOR_METRICS_PORT: "18888",
  });
  const overriddenPorts = overridden.service("collector").ports;
  assert.ok(hasLoopbackPort(overriddenPorts, 24224, 25224));
  assert.ok(hasLoopbackPort(overriddenPorts, 8888, 18888));
  const workerLogging = composeRecord(overridden.service("worker").logging, "worker.logging");
  const workerOptions = composeRecord(workerLogging.options, "worker.logging.options");
  assert.equal(workerOptions["fluentd-address"], "127.0.0.1:25224");
}
