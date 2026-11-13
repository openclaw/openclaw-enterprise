import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  attributeEntries,
  attributes,
  collectorFixture,
  docker,
  exportedRecords,
  nodeImage,
  otlpObject,
  root,
  selected,
  waitFor,
} from "../helpers/logging-collector-fixture.ts";

function eventName(record: Record<string, unknown>): string {
  const { stringValue } = otlpObject(record.body);
  assert.ok(typeof stringValue === "string", "the exported event has a string body");
  return stringValue;
}

test(
  "native Collector filters actual Docker forwarding, binds transport identity, and survives exporter outage",
  {
    skip: selected
      ? false
      : "Set OCC_TEST_LOGGING_COLLECTOR=1 for pinned Collector/Docker transport proof.",
    timeout: 240_000,
  },
  async (t) => {
    const fixture = await collectorFixture(t, "docker");
    await fixture.startCollector({
      receiverPath: join(root, "deploy/logging/docker.yaml"),
      publish: ["127.0.0.1::24224", "127.0.0.1::8888"],
    });
    const forwardAddress = await fixture.port(24224);
    let metricsAddress = await fixture.port(8888);
    await waitFor(
      "the Collector metrics endpoint",
      async () =>
        fetch(`http://${metricsAddress}/metrics`)
          .then((r) => r.ok)
          .catch(() => false),
      fixture,
    );
    const records = async () => {
      return exportedRecords(fixture.out, (resource, record) => ({
        resource: attributes(
          resource.resource === undefined ? undefined : otlpObject(resource.resource).attributes,
        ),
        record,
      }));
    };
    const namespaceId = `ns_${randomUUID()}`;
    const agentId = `agt_${randomUUID()}`;
    const revisionId = `rev_${randomUUID()}`;
    const presetNamespaceId = `ns_${randomUUID()}`;
    const presetId = `pre_${randomUUID()}`;
    const restrictionUuid = randomUUID();
    const canaries = ["password", "token", "prompt", "tool-output", "email", "session"].map(
      (kind) => `CANARY_${kind}_${fixture.suffix}`,
    );
    const payload = Object.fromEntries(canaries.map((value) => [value, value]));
    let senderStdoutMatches: boolean | null = null;

    // The sender is deliberately synthetic: this exercises the real Engine ->
    // Fluent Forward -> Collector -> OTLP boundary, not gateway/Codex emission.
    async function send(
      role: string,
      stdout: string[],
      stderr: string[] = [],
      extraLabels: string[] = [],
    ) {
      const name = `oce-otel-sender-${randomUUID().slice(0, 8)}`;
      const labels = [
        "org.openclaw.enterprise.managed=true",
        `org.openclaw.enterprise.role=${role}`,
        `org.openclaw.enterprise.namespace-id=${namespaceId}`,
        `org.openclaw.enterprise.agent-id=${agentId}`,
        `org.openclaw.enterprise.revision-id=${revisionId}`,
        ...extraLabels,
      ];
      const script = `for(const line of ${JSON.stringify(stdout)})process.stdout.write(line+'\\n');for(const line of ${JSON.stringify(stderr)})process.stderr.write(line+'\\n');`;
      try {
        const output = await docker([
          "run",
          "--name",
          name,
          "--network",
          "none",
          "--log-driver",
          "fluentd",
          "--log-opt",
          `fluentd-address=${forwardAddress}`,
          "--log-opt",
          "fluentd-write-timeout=1s",
          "--log-opt",
          `labels=${labels.map((label) => label.split("=", 1)[0]).join(",")}`,
          ...labels.flatMap((label) => ["--label", label]),
          nodeImage,
          "node",
          "-e",
          script,
        ]);
        senderStdoutMatches = output === stdout.join("\n").trim();
      } finally {
        await docker(["rm", "--force", name]).catch(() => {});
      }
    }
    const warningLine = (event: string) =>
      JSON.stringify({
        event,
        severity: "WARN",
        code: "KUBERNETES_VERSION_BELOW_MINIMUM",
        computeDriverId: "kubernetes",
        message: canaries.join(" "),
        sessionId: canaries.at(-1),
        ...payload,
        "service.name": "forged-service",
        "openclaw.agent.id": "forged-agent",
      });
    let lastMetrics: Record<string, number | null> | undefined;
    const filtered = async (signal?: AbortSignal) => {
      const response = await fetch(`http://${metricsAddress}/metrics`, { signal: signal ?? null });
      lastMetrics = { httpStatus: response.status };
      const metrics = await response.text();
      // Keep counts only: labels and response bodies are not failure diagnostics.
      for (const [field, name] of [
        ["connectionsOpened", "otelcol_fluent_opened_connections"],
        ["connectionsClosed", "otelcol_fluent_closed_connections"],
        ["eventsParsed", "otelcol_fluent_events_parsed"],
        ["parseFailures", "otelcol_fluent_parse_failures"],
        ["recordsGenerated", "otelcol_fluent_records_generated"],
        ["accepted", "otelcol_receiver_accepted_log_records"],
        ["refused", "otelcol_receiver_refused_log_records"],
        ["filtered", "otelcol_processor_filter_logs_filtered"],
      ] as const) {
        const values = [
          ...metrics.matchAll(new RegExp(`^${name}(?:_total)?(?:\\{[^\\n]*\\})? ([^\\s]+)$`, "gm")),
        ]
          .map(([, value]) => Number(value))
          .filter(Number.isFinite);
        lastMetrics[field] = values.length ? values.reduce((sum, value) => sum + value, 0) : null;
      }
      return /otelcol_processor_filter_logs_filtered[^\n]* [1-9]/.test(metrics);
    };

    // Docker's proxy can accept TCP before Fluent starts. Require the receiver
    // to observe an empty connection opening and closing before sending records.
    const forwardUrl = new URL(`tcp://${forwardAddress}`);
    const readinessMs = 30_000;
    const readinessDeadline = performance.now() + readinessMs;
    const signal = AbortSignal.timeout(readinessMs);
    const checkReadinessDeadline = () => {
      // Timer dispatch can lag behind I/O completion.
      if (performance.now() >= readinessDeadline) {
        throw new Error("Fluent receiver readiness deadline expired");
      }
    };
    let initiallyFiltered;
    try {
      for (;;) {
        checkReadinessDeadline();
        await new Promise<void>((resolve) => {
          const socket = createConnection({
            host: forwardUrl.hostname,
            port: Number(forwardUrl.port),
            signal: AbortSignal.any([signal, AbortSignal.timeout(1_000)]),
          });
          socket.once("connect", () => socket.end());
          socket.once("error", () => socket.destroy());
          socket.once("close", () => resolve());
        });
        checkReadinessDeadline();
        initiallyFiltered = await filtered(signal);
        checkReadinessDeadline();
        if (
          (lastMetrics?.connectionsOpened ?? 0) > 0 &&
          (lastMetrics?.connectionsClosed ?? 0) > 0
        ) {
          break;
        }
        await delay(100, undefined, { signal });
      }
    } catch (error) {
      const outcome = "the Fluent receiver to observe an empty connection";
      const failure =
        signal.aborted || performance.now() >= readinessDeadline
          ? `Timed out waiting for ${outcome}.`
          : `Waiting for ${outcome} failed: ${error instanceof Error ? error.message : String(error)}.`;
      throw new Error(`${failure} ${await fixture.describe()}`, { cause: error });
    }

    // No other records have entered this fresh Collector, so a filter count
    // proves the near-match was processed and rejected before capture assertions.
    assert.equal(initiallyFiltered, false);
    await send(
      "worker",
      [warningLine("compute.preflight-warning-unreviewed")],
      [],
      ["com.docker.compose.service=worker"],
    );
    try {
      await waitFor("the Collector to count the filtered near-match", filtered, fixture);
    } catch (error) {
      t.diagnostic(
        `Last Collector forwarding state (null means absent): ${JSON.stringify({
          senderStdoutMatches,
          metrics: lastMetrics,
        })}`,
      );
      throw error;
    }

    await send("gateway", [
      JSON.stringify({
        level: "info",
        subsystem: "gateway",
        message: canaries.join(" "),
        ...payload,
        "service.name": "forged-service",
        "openclaw.agent.id": "forged-agent",
      }),
    ]);
    await send(
      "agent",
      [JSON.stringify({ level: "INFO", target: "codex_app_server", fields: payload })],
      [
        JSON.stringify({ level: "INFO", target: "codex_app_server::server", fields: payload }),
        JSON.stringify({ level: "INFO", target: "codex_otel::log_only", fields: payload }),
      ],
    );
    await send(
      "controller",
      [
        JSON.stringify({
          event: "http.completed",
          severity: "INFO",
          method: "GET",
          status: 200,
          requestId: `req_${randomUUID()}`,
          ...payload,
        }),
        JSON.stringify({
          event: "authentication.sign-in-limited",
          severity: "WARN",
          lane: "email",
          keyHash: `limitkey${fixture.suffix}`,
          ...payload,
        }),
        JSON.stringify({
          event: "authentication.provider-unavailable-warning",
          severity: "WARN",
          provider: "oidc",
          providerId: `oidc:providerkey${fixture.suffix}`,
          step: "token",
          cause: "connect_refused",
          code: "ECONNREFUSED",
          ...payload,
        }),
        JSON.stringify({
          event: "authentication.provider-unavailable-warning",
          severity: "WARN",
          provider: "github",
          providerId: `github:providerkey${fixture.suffix}`,
          step: "profile",
          cause: "http_status",
          status: 503,
          ...payload,
        }),
        JSON.stringify({
          event: "authentication.provider-unavailable-warning",
          severity: "WARN",
          provider: "github",
          providerId: `github:providerkey${fixture.suffix}`,
          step: "membership",
          cause: "http_status",
          status: 403,
          ...payload,
        }),
        // Verified-email lookup failures must keep their stage after the body is
        // replaced. An unreviewed stage must still be discarded by the Collector.
        ...["email", canaries[4]].map((step) =>
          JSON.stringify({
            event: "authentication.provider-unavailable-warning",
            severity: "WARN",
            provider: "github",
            providerId: `github:providerkey${fixture.suffix}`,
            step,
            cause: "http_status",
            status: 503,
            ...payload,
          }),
        ),
        JSON.stringify({
          event: "presets.default-refresh-skipped",
          severity: "WARN",
          namespaceId: presetNamespaceId,
          presetId,
          presetName: `presetname${fixture.suffix}`,
          reason: `refusalreason${fixture.suffix}`,
          restrictionIds: [`res_${restrictionUuid}`],
          ...payload,
        }),
        JSON.stringify({
          event: "presets.default-create-skipped",
          severity: "WARN",
          namespaceId: presetNamespaceId,
          presetName: `presetname${fixture.suffix}`,
          reason: `refusalreason${fixture.suffix}`,
          restrictionIds: [`res_${restrictionUuid}`],
          ...payload,
        }),
        JSON.stringify({
          event: "presets.bundled-default-shadowed",
          severity: "WARN",
          presetName: `presetname${fixture.suffix}`,
          presetFile: `/etc/occ/presets/presetfile${fixture.suffix}.json`,
          ...payload,
        }),
        JSON.stringify({
          event: "authentication.provider-unavailable-warning",
          severity: "WARN",
          provider: "google",
          providerId: `google:providerkey${fixture.suffix}`,
          step: "token",
          cause: "client_rejected",
          ...payload,
        }),
      ],
      [],
      ["com.docker.compose.service=controller"],
    );
    await send(
      "worker",
      [
        warningLine("compute.preflight-warning"),
        JSON.stringify({
          event: "worker.compute-prepare-failed",
          severity: "ERROR",
          workId: `agent_revision:${revisionId}:reconcile`,
          operation: "agent_revision.reconcile",
          namespaceId,
          agentId,
          revisionId,
          computeDriverId: "kubernetes",
          code: "KUBERNETES_API_REJECTED",
          step: "gateway",
          errorClass: "HttpError",
          status: 403,
          message: canaries.join(" "),
          ...payload,
        }),
      ],
      [],
      ["com.docker.compose.service=worker"],
    );
    await send("gateway", [
      canaries.join(" "),
      "{invalid json",
      JSON.stringify({ level: "info", subsystem: "gateway", message: "x".repeat(33_000) }),
    ]);
    await waitFor(
      "at least 15 exported records",
      async () => (await records()).length >= 15,
      fixture,
    );
    const initial = await records();
    assert.equal(initial.length, 15, "only reviewed JSON classes and Codex stderr pass");
    const warningEvents = [
      "compute.preflight-warning",
      "authentication.sign-in-limited",
      "authentication.provider-unavailable-warning",
      "presets.bundled-default-shadowed",
      "presets.default-create-skipped",
      "presets.default-refresh-skipped",
    ];
    for (const { resource, record } of initial) {
      assert.ok(record.timeUnixNano, "OTLP record has an Engine timestamp");
      const event = eventName(record);
      const severity = warningEvents.includes(event) ? 13 : 9;
      assert.equal(
        record.severityNumber,
        event === "worker.compute-prepare-failed" ? 17 : severity,
        "severity maps to OTel ERROR, WARN or INFO, not Pino's numeric level",
      );
      assert.equal(resource["openclaw.agent.id"], agentId);
      assert.equal(resource["openclaw.namespace.id"], namespaceId);
      assert.equal(resource["openclaw.revision.id"], revisionId);
      assert.ok(resource["container.id"]);
    }
    assert.deepEqual(initial.map(({ resource }) => resource["service.name"]).sort(), [
      "codex-app-server",
      "occ-api",
      "occ-api",
      "occ-api",
      "occ-api",
      "occ-api",
      "occ-api",
      "occ-api",
      "occ-api",
      "occ-api",
      "occ-api",
      "occ-api",
      "occ-worker",
      "occ-worker",
      "openclaw-gateway",
    ]);
    const http = initial.find(({ record }) => eventName(record) === "http.completed");
    assert.ok(http, "the reviewed HTTP completion was exported");
    const httpAttributes = Object.fromEntries(attributeEntries(http.record.attributes));
    assert.equal(httpAttributes["http.request.method"]?.stringValue, "GET");
    const statusCode = httpAttributes["http.response.status_code"];
    assert.ok(statusCode, "the HTTP status code was exported");
    const { stringValue, intValue } = statusCode;
    assert.equal(stringValue, undefined, "OTLP exports the HTTP status as an integer");
    assert.ok(typeof intValue === "string" || typeof intValue === "number");
    assert.equal(Number(intValue), 200);
    const warning = initial.find(({ record }) => eventName(record) === "compute.preflight-warning");
    assert.ok(warning, "the reviewed event was exported");
    assert.equal(warning.resource["service.name"], "occ-worker");
    assert.equal(warning.record.severityText, "WARN");
    assert.deepEqual(attributes(warning.record.attributes), {
      "event.name": "compute.preflight-warning",
      "log.iostream": "stdout",
      "occ.code": "KUBERNETES_VERSION_BELOW_MINIMUM",
    });
    // A failed Compute prepare is exported at ERROR with its bounded code and the IDs and
    // work identity other worker events keep; the stage, error class, status and message
    // stay in local logs.
    const prepareFailed = initial.find(
      ({ record }) => eventName(record) === "worker.compute-prepare-failed",
    );
    assert.ok(prepareFailed, "the reviewed event was exported");
    assert.equal(prepareFailed.resource["service.name"], "occ-worker");
    assert.equal(prepareFailed.record.severityText, "ERROR");
    assert.deepEqual(attributes(prepareFailed.record.attributes), {
      "event.name": "worker.compute-prepare-failed",
      "log.iostream": "stdout",
      "occ.agent.id": agentId,
      "occ.code": "KUBERNETES_API_REJECTED",
      "occ.namespace.id": namespaceId,
      "occ.revision.id": revisionId,
      "work.id": `agent_revision:${revisionId}:reconcile`,
      "work.operation": "agent_revision.reconcile",
    });
    // A limited sign-in lane is promoted with its lane; the hashed key stays in local logs.
    const limited = initial.find(
      ({ record }) => eventName(record) === "authentication.sign-in-limited",
    );
    assert.ok(limited, "the reviewed event was exported");
    assert.equal(limited.record.severityText, "WARN");
    assert.deepEqual(attributes(limited.record.attributes), {
      "event.name": "authentication.sign-in-limited",
      "log.iostream": "stdout",
      "occ.sign_in.lane": "email",
    });
    // A provider outage keeps the provider, step, bounded cause, and transport code or
    // HTTP status; the provider instance ID stays in local logs.
    const outages = initial
      .filter(({ record }) => eventName(record) === "authentication.provider-unavailable-warning")
      .map(({ record }) => {
        assert.equal(record.severityText, "WARN");
        return attributes(record.attributes);
      })
      .sort((left, right) => {
        const leftProvider = left["occ.sign_in.provider"];
        const rightProvider = right["occ.sign_in.provider"];
        assert.ok(typeof leftProvider === "string" && typeof rightProvider === "string");
        return leftProvider.localeCompare(rightProvider);
      });
    assert.deepEqual(outages, [
      {
        "event.name": "authentication.provider-unavailable-warning",
        "log.iostream": "stdout",
        "occ.sign_in.provider": "github",
        "occ.sign_in.step": "profile",
        "occ.sign_in.cause": "http_status",
        "occ.sign_in.status": "503",
      },
      {
        "event.name": "authentication.provider-unavailable-warning",
        "log.iostream": "stdout",
        "occ.sign_in.provider": "github",
        "occ.sign_in.step": "membership",
        "occ.sign_in.cause": "http_status",
        "occ.sign_in.status": "403",
      },
      {
        "event.name": "authentication.provider-unavailable-warning",
        "log.iostream": "stdout",
        "occ.sign_in.provider": "github",
        "occ.sign_in.step": "email",
        "occ.sign_in.cause": "http_status",
        "occ.sign_in.status": "503",
      },
      {
        "event.name": "authentication.provider-unavailable-warning",
        "log.iostream": "stdout",
        "occ.sign_in.provider": "github",
        "occ.sign_in.cause": "http_status",
        "occ.sign_in.status": "503",
      },
      {
        "event.name": "authentication.provider-unavailable-warning",
        "log.iostream": "stdout",
        "occ.sign_in.provider": "google",
        "occ.sign_in.step": "token",
        "occ.sign_in.cause": "client_rejected",
      },
      {
        "event.name": "authentication.provider-unavailable-warning",
        "log.iostream": "stdout",
        "occ.code": "ECONNREFUSED",
        "occ.sign_in.provider": "oidc",
        "occ.sign_in.step": "token",
        "occ.sign_in.cause": "connect_refused",
      },
    ]);
    // A refused default-Preset refresh keeps the Namespace and Preset IDs; the Preset name,
    // the refusal text and the Restriction IDs stay in local logs.
    const skipped = initial.find(
      ({ record }) => eventName(record) === "presets.default-refresh-skipped",
    );
    assert.ok(skipped, "the reviewed event was exported");
    assert.equal(skipped.record.severityText, "WARN");
    assert.deepEqual(attributes(skipped.record.attributes), {
      "event.name": "presets.default-refresh-skipped",
      "log.iostream": "stdout",
      "occ.namespace.id": presetNamespaceId,
      "occ.preset.id": presetId,
    });
    // A default creation a Restriction refused keeps only its Namespace ID.
    const uncreated = initial.find(
      ({ record }) => eventName(record) === "presets.default-create-skipped",
    );
    assert.ok(uncreated, "the reviewed event was exported");
    assert.equal(uncreated.record.severityText, "WARN");
    assert.deepEqual(attributes(uncreated.record.attributes), {
      "event.name": "presets.default-create-skipped",
      "log.iostream": "stdout",
      "occ.namespace.id": presetNamespaceId,
    });
    // A bundled default an operator file shadowed carries no IDs: its name and file stay local.
    const shadowed = initial.find(
      ({ record }) => eventName(record) === "presets.bundled-default-shadowed",
    );
    assert.ok(shadowed, "the reviewed event was exported");
    assert.equal(shadowed.record.severityText, "WARN");
    assert.deepEqual(attributes(shadowed.record.attributes), {
      "event.name": "presets.bundled-default-shadowed",
      "log.iostream": "stdout",
    });
    const serialized = JSON.stringify(initial);
    assert.equal(serialized.includes("compute.preflight-warning-unreviewed"), false);
    for (const local of [
      `presetname${fixture.suffix}`,
      `presetfile${fixture.suffix}`,
      `refusalreason${fixture.suffix}`,
      restrictionUuid,
    ]) {
      assert.equal(serialized.includes(local), false, local);
    }
    assert.equal(serialized.includes(`limitkey${fixture.suffix}`), false);
    assert.equal(serialized.includes(`providerkey${fixture.suffix}`), false);
    for (const value of [...canaries, "forged-service", "forged-agent", "HttpError"]) {
      assert.equal(serialized.includes(value), false);
    }
    const metrics = await fetch(`http://${metricsAddress}/metrics`).then((r) => r.text());
    assert.match(
      metrics,
      /otelcol_processor_filter_logs_filtered[^\n]* [1-9]/,
      "dropped records have observable counts",
    );

    assert.match(
      metrics,
      /otelcol_exporter_queue_capacity[^\n]* 1024/,
      "export queue has finite capacity",
    );

    // A stopped destination leaves the Collector responsive and queues a bounded
    // operational record. Restart the Collector too, proving its configured
    // file-backed queue survives a process restart before the destination returns.
    await docker(["stop", "--time", "5", fixture.backend]);
    await send("gateway", [JSON.stringify({ level: "warn", subsystem: "gateway" })]);
    await waitFor(
      "a queued export while the destination is stopped",
      async () => {
        const current = await fetch(`http://${metricsAddress}/metrics`).then((response) =>
          response.text(),
        );
        return /otelcol_exporter_queue_size[^\n]* [1-9]/.test(current);
      },
      fixture,
    );
    await docker(["stop", "--time", "10", fixture.collector]);
    await docker(["start", fixture.collector]);
    metricsAddress = (await fixture.port(8888)).trim();
    await waitFor(
      "the restarted Collector metrics endpoint",
      async () => {
        try {
          return (await fetch(`http://${metricsAddress}/metrics`)).status === 200;
        } catch {
          return false;
        }
      },
      fixture,
    );
    await docker(["start", fixture.backend]);
    await waitFor(
      "the queued record at the restored destination",
      async () =>
        (await records()).some(
          ({ resource, record }) =>
            resource["service.name"] === "openclaw-gateway" &&
            record.severityNumber === 13 &&
            eventName(record) === "gateway.operational",
        ),
      fixture,
    );
    await docker(["stop", "--time", "10", fixture.collector]);
    // The file-export test destination starts a new capture segment on restart.
    assert.equal((await records()).length, 1, "the restored destination receives the queued event");
  },
);
