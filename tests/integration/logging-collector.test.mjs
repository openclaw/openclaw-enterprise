import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { createRequire } from "node:module";

const { loadYaml } = createRequire(new URL("../../apps/controller/package.json", import.meta.url))(
  "@kubernetes/client-node",
);

const exec = promisify(execFile);
const selected = process.env.OCC_TEST_LOGGING_COLLECTOR === "1";
const nodeImage = process.env.OCC_TEST_LOGGING_NODE_IMAGE ?? "docker.io/library/node:24-bookworm";
const root = new URL("../../", import.meta.url).pathname;

async function docker(args) {
  return (await exec("docker", args, { timeout: 120_000, maxBuffer: 1024 * 1024 })).stdout.trim();
}

async function waitFor(check) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await delay(100);
  }
  assert.fail("Timed out waiting for the real Collector outcome.");
}

function attributes(entries = []) {
  return Object.fromEntries(
    entries.map(({ key, value }) => [key, value.stringValue ?? value.intValue]),
  );
}

async function collectorFixture(t, prefix) {
  const suffix = randomUUID().slice(0, 8);
  const network = `oce-otel-${prefix}-${suffix}`;
  const backend = `oce-otel-${prefix}-backend-${suffix}`;
  const collector = `oce-otel-${prefix}-collector-${suffix}`;
  const directory = await mkdtemp(join(tmpdir(), `occ-collector-${prefix}-`));
  const out = join(directory, "out");
  const state = join(directory, "state");
  await mkdir(out);
  await mkdir(state);
  const overlay = loadYaml(await readFile(join(root, "compose.logging.yaml"), "utf8"));
  const image = overlay.services.collector.image;
  assert.match(image, /@sha256:[a-f0-9]{64}$/);
  const user = `${process.getuid()}:${process.getgid()}`;
  await writeFile(
    join(directory, "backend.yaml"),
    `receivers:\n  otlp:\n    protocols:\n      http:\n        endpoint: 0.0.0.0:4318\nexporters:\n  file:\n    path: /out/logs.jsonl\nservice:\n  telemetry:\n    logs:\n      level: error\n  pipelines:\n    logs:\n      receivers: [otlp]\n      exporters: [file]\n`,
  );
  t.after(async () => {
    await docker(["rm", "--force", collector, backend]).catch(() => {});
    await docker(["network", "rm", network]).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  });
  await docker(["network", "create", network]);
  await docker([
    "run",
    "--detach",
    "--name",
    backend,
    "--network",
    network,
    "--user",
    user,
    "--volume",
    `${join(directory, "backend.yaml")}:/etc/otel/backend.yaml:ro`,
    "--volume",
    `${out}:/out`,
    image,
    "--config=/etc/otel/backend.yaml",
  ]);
  return {
    suffix,
    directory,
    out,
    backend,
    collector,
    async startCollector({ receiverPath, publish }) {
      const args = ["run", "--detach", "--name", collector, "--network", network, "--user", user];
      for (const port of publish) {
        args.push("--publish", port);
      }
      args.push(
        "--env",
        `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://${backend}:4318/v1/logs`,
        "--volume",
        `${join(root, "deploy/logging/collector.yaml")}:/etc/otel/collector.yaml:ro`,
        "--volume",
        `${join(root, "deploy/logging/exporter.yaml")}:/etc/otel/exporter.yaml:ro`,
        "--volume",
        `${receiverPath}:/etc/otel/receiver.yaml:ro`,
        "--volume",
        `${state}:/var/lib/otelcol`,
        image,
        "--config=/etc/otel/collector.yaml",
        "--config=/etc/otel/receiver.yaml",
        "--config=/etc/otel/exporter.yaml",
      );
      await docker(args);
    },
    port(containerPort) {
      return docker(["port", collector, `${containerPort}/tcp`]);
    },
  };
}

async function exportedRecords(out, mapRecord) {
  let text;
  try {
    text = await readFile(join(out, "logs.jsonl"), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const payload = JSON.parse(line);
      return payload.resourceLogs.flatMap((resource) =>
        resource.scopeLogs.flatMap((scope) =>
          scope.logRecords.map((record) => mapRecord(resource, record)),
        ),
      );
    });
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
    await waitFor(async () =>
      fetch(`http://${metricsAddress}/metrics`)
        .then((r) => r.ok)
        .catch(() => false),
    );
    const records = async () => {
      return exportedRecords(fixture.out, (resource, record) => ({
        resource: attributes(resource.resource?.attributes),
        record,
      }));
    };
    const namespaceId = `ns_${randomUUID()}`;
    const agentId = `agt_${randomUUID()}`;
    const revisionId = `rev_${randomUUID()}`;
    const canaries = ["password", "token", "prompt", "tool-output", "email", "session"].map(
      (kind) => `CANARY_${kind}_${fixture.suffix}`,
    );
    const payload = Object.fromEntries(canaries.map((value) => [value, value]));

    // The sender is deliberately synthetic: this exercises the real Engine ->
    // Fluent Forward -> Collector -> OTLP boundary, not gateway/Codex emission.
    async function send(role, stdout, stderr = [], extraLabels = []) {
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
        await docker([
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
      } finally {
        await docker(["rm", "--force", name]).catch(() => {});
      }
    }
    const warningLine = (event) =>
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
    const filtered = async () =>
      /otelcol_processor_filter_logs_filtered[^\n]* [1-9]/.test(
        await fetch(`http://${metricsAddress}/metrics`).then((response) => response.text()),
      );

    // No other records have entered this fresh Collector, so a filter count
    // proves the near-match was processed and rejected before capture assertions.
    assert.equal(await filtered(), false);
    await send(
      "worker",
      [warningLine("compute.preflight-warning-unreviewed")],
      [],
      ["com.docker.compose.service=worker"],
    );
    await waitFor(filtered);

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
      ],
      [],
      ["com.docker.compose.service=controller"],
    );
    await send(
      "worker",
      [warningLine("compute.preflight-warning")],
      [],
      ["com.docker.compose.service=worker"],
    );
    await send("gateway", [
      canaries.join(" "),
      "{invalid json",
      JSON.stringify({ level: "info", subsystem: "gateway", message: "x".repeat(33_000) }),
    ]);
    await waitFor(async () => (await records()).length >= 4);
    const initial = await records();
    assert.equal(initial.length, 4, "only reviewed JSON classes and Codex stderr pass");
    for (const { resource, record } of initial) {
      assert.ok(record.timeUnixNano, "OTLP record has an Engine timestamp");
      assert.equal(
        record.severityNumber,
        resource["service.name"] === "occ-worker" ? 13 : 9,
        "severity maps to OTel WARN or INFO, not Pino's numeric level",
      );
      assert.equal(resource["openclaw.agent.id"], agentId);
      assert.equal(resource["openclaw.namespace.id"], namespaceId);
      assert.equal(resource["openclaw.revision.id"], revisionId);
      assert.ok(resource["container.id"]);
    }
    assert.deepEqual(initial.map(({ resource }) => resource["service.name"]).sort(), [
      "codex-app-server",
      "occ-api",
      "occ-worker",
      "openclaw-gateway",
    ]);
    const http = initial.find(({ resource }) => resource["service.name"] === "occ-api");
    const httpAttributes = Object.fromEntries(
      http.record.attributes.map(({ key, value }) => [
        key,
        value.stringValue ?? Number(value.intValue),
      ]),
    );
    assert.equal(httpAttributes["http.request.method"], "GET");
    assert.equal(httpAttributes["http.response.status_code"], 200);
    const warning = initial.find(({ resource }) => resource["service.name"] === "occ-worker");
    assert.equal(warning.record.body.stringValue, "compute.preflight-warning");
    assert.equal(warning.record.severityText, "WARN");
    assert.deepEqual(attributes(warning.record.attributes), {
      "event.name": "compute.preflight-warning",
      "log.iostream": "stdout",
      "occ.code": "KUBERNETES_VERSION_BELOW_MINIMUM",
    });
    const serialized = JSON.stringify(initial);
    assert.equal(serialized.includes("compute.preflight-warning-unreviewed"), false);
    for (const value of [...canaries, "forged-service", "forged-agent"]) {
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
    await waitFor(async () => {
      const current = await fetch(`http://${metricsAddress}/metrics`).then((response) =>
        response.text(),
      );
      return /otelcol_exporter_queue_size[^\n]* [1-9]/.test(current);
    });
    await docker(["stop", "--time", "10", fixture.collector]);
    await docker(["start", fixture.collector]);
    metricsAddress = (await fixture.port(8888)).trim();
    await waitFor(async () => {
      try {
        return (await fetch(`http://${metricsAddress}/metrics`)).status === 200;
      } catch {
        return false;
      }
    });
    await docker(["start", fixture.backend]);
    await waitFor(async () =>
      (await records()).some(
        ({ resource, record }) =>
          resource["service.name"] === "openclaw-gateway" &&
          record.severityNumber === 13 &&
          record.body.stringValue === "gateway.operational",
      ),
    );
    await docker(["stop", "--time", "10", fixture.collector]);
    // The file-export test destination starts a new capture segment on restart.
    assert.equal((await records()).length, 1, "the restored destination receives the queued event");
  },
);

test(
  "native Collector preserves Kubernetes identity after a dropped record sharing Pod metadata",
  {
    skip: selected
      ? false
      : "Set OCC_TEST_LOGGING_COLLECTOR=1 for pinned Collector Kubernetes processor proof.",
    timeout: 180_000,
  },
  async (t) => {
    const fixture = await collectorFixture(t, "k8s");
    const kubernetes = loadYaml(
      await readFile(join(root, "deploy/logging/kubernetes.yaml"), "utf8"),
    );
    const fixtureProcessors = { ...kubernetes.processors };
    delete fixtureProcessors.k8sattributes;
    await writeFile(
      join(fixture.directory, "receiver.yaml"),
      `${JSON.stringify(
        {
          receivers: { otlp: { protocols: { http: { endpoint: "0.0.0.0:4318" } } } },
          processors: fixtureProcessors,
          service: {
            pipelines: {
              logs: {
                receivers: ["otlp"],
                processors: kubernetes.service.pipelines.logs.processors.filter(
                  (processor) => processor !== "k8sattributes",
                ),
                exporters: ["otlp_http"],
              },
            },
          },
        },
        undefined,
        2,
      )}\n`,
    );
    await fixture.startCollector({
      receiverPath: join(fixture.directory, "receiver.yaml"),
      publish: ["127.0.0.1::4318"],
    });
    const receiverAddress = await fixture.port(4318);
    await waitFor(async () =>
      fetch(`http://${receiverAddress}/v1/logs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resourceLogs: [] }),
      })
        .then((response) => response.status < 500)
        .catch(() => false),
    );

    // This injects post-parser OTLP records with fixture Pod metadata. Full Helm
    // live proof covers actual CRI parsing and Kubernetes metadata extraction.
    const podUid = `pod-${randomUUID()}`;
    const containerId = `containerd://${randomUUID()}`;
    const imageDigest = `registry.example.test/openclaw-enterprise@sha256:${"a".repeat(64)}`;
    const bodylessInstallationId = `ins_${randomUUID()}`;
    const bodylessJson = JSON.stringify({
      event: "installation.bootstrapped",
      installationId: bodylessInstallationId,
    });
    const payload = {
      resourceLogs: [
        {
          resource: {
            attributes: [
              { key: "occ.application", value: { stringValue: "openclaw-enterprise" } },
              { key: "occ.component", value: { stringValue: "initialization" } },
              { key: "occ.managed_by", value: { stringValue: "openclaw-enterprise" } },
              {
                key: "k8s.pod.name",
                value: { stringValue: `openclaw-enterprise-initialization-${fixture.suffix}` },
              },
              { key: "k8s.pod.uid", value: { stringValue: podUid } },
              { key: "k8s.namespace.name", value: { stringValue: `system-${fixture.suffix}` } },
              { key: "k8s.node.name", value: { stringValue: "fixture-node" } },
              { key: "container.id", value: { stringValue: containerId } },
              { key: "container.image.name", value: { stringValue: "openclaw-enterprise" } },
              { key: "container.image.tag", value: { stringValue: "fixture-tag" } },
              {
                key: "container.image.repo_digests",
                value: { arrayValue: { values: [{ stringValue: imageDigest }] } },
              },
            ],
          },
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: String(BigInt(Date.now()) * 1000000n),
                  body: { stringValue: bodylessJson },
                  attributes: [{ key: "log.iostream", value: { stringValue: "stdout" } }],
                },
                {
                  timeUnixNano: String(BigInt(Date.now()) * 1000000n),
                  body: {
                    stringValue: JSON.stringify({
                      event: "installation.bootstrapped",
                      severity: "INFO",
                    }),
                  },
                  attributes: [{ key: "log.iostream", value: { stringValue: "stderr" } }],
                },
              ],
            },
          ],
        },
      ],
    };
    const response = await fetch(`http://${receiverAddress}/v1/logs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    assert.equal(response.status, 200, await response.text());

    const records = async () => {
      return exportedRecords(fixture.out, (resource, record) => ({
        resource: attributes(resource.resource?.attributes),
        attributes: attributes(record.attributes),
        record,
      }));
    };
    await waitFor(async () => (await records()).length === 1);
    const [exported] = await records();
    assert.equal(exported.resource["service.name"], "occ-api");
    assert.equal(exported.resource["service.instance.id"], podUid);
    assert.equal(exported.resource["service.version"], imageDigest);
    assert.equal(exported.resource["container.id"], containerId);
    assert.equal(exported.record.body?.stringValue, "installation.bootstrapped");
    assert.equal(exported.record.severityText, "INFO");
    assert.equal(exported.record.severityNumber, 9);
    assert.equal(exported.attributes["event.name"], "installation.bootstrapped");
    const serialized = JSON.stringify(exported);
    for (const internal of [
      "occ.application",
      "occ.component",
      "occ.managed_by",
      bodylessInstallationId,
    ]) {
      assert.equal(serialized.includes(internal), false, `${internal} must not leak downstream`);
    }

    // Stop work includes a per-operation UUID; deletion work has no suffix.
    // Unsupported shapes must lose correlation fields without losing the event.
    const agentId = `agt_${randomUUID()}`;
    const stopWorkId = `agent:${agentId}:reconcile:stopped:${randomUUID()}`;
    const deleteWorkId = `agent:${agentId}:reconcile:deleted`;
    const cases = [
      { operation: "agent.stop", workId: stopWorkId },
      { operation: "agent.delete", workId: deleteWorkId },
      {
        operation: "agent.stop",
        workId: `agent:${agentId}:reconcile:stopped`,
        discardWorkId: true,
      },
      {
        operation: "agent.delete",
        workId: `${deleteWorkId}:${randomUUID()}`,
        discardWorkId: true,
      },
      {
        operation: "agent.stop",
        workId: `agent:${agentId}:reconcile:stopped:CANARY_SESSION`,
        discardWorkId: true,
      },
      {
        operation: "agent.stop",
        workId: `agent:agt_${"a".repeat(36)}:reconcile:stopped:${randomUUID()}`,
        discardWorkId: true,
      },
      { operation: "agent.restart", workId: stopWorkId, discardOperation: true },
    ].map((entry) => ({ ...entry, requestId: `req_${randomUUID()}` }));
    const workerResource = {
      resource: {
        attributes: payload.resourceLogs[0].resource.attributes.map((entry) =>
          entry.key === "occ.component" ? { ...entry, value: { stringValue: "worker" } } : entry,
        ),
      },
      scopeLogs: [
        {
          logRecords: cases.map(({ operation, workId, requestId }) => ({
            timeUnixNano: String(BigInt(Date.now()) * 1000000n),
            body: {
              stringValue: JSON.stringify({
                event: "worker.completed",
                severity: "INFO",
                operation,
                workId,
                requestId,
                message: "CANARY_RAW_MESSAGE",
                sessionId: "CANARY_SESSION",
                "service.name": "CANARY_FORGED_SERVICE",
              }),
            },
            attributes: [{ key: "log.iostream", value: { stringValue: "stdout" } }],
          })),
        },
      ],
    };
    const workerResponse = await fetch(`http://${receiverAddress}/v1/logs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resourceLogs: [workerResource] }),
    });
    assert.equal(workerResponse.status, 200, await workerResponse.text());
    await waitFor(async () => (await records()).length === 1 + cases.length);
    const workerRecords = (await records()).filter(
      ({ resource }) => resource["service.name"] === "occ-worker",
    );
    assert.equal(workerRecords.length, cases.length);
    for (const entry of cases) {
      const actual = workerRecords.find(
        ({ attributes }) => attributes["request.id"] === entry.requestId,
      );
      assert.equal(actual.record.body.stringValue, "worker.completed");
      assert.equal(actual.record.severityNumber, 9);
      assert.deepEqual(actual.attributes, {
        "event.name": "worker.completed",
        "log.iostream": "stdout",
        "request.id": entry.requestId,
        ...(entry.discardOperation ? {} : { "work.operation": entry.operation }),
        ...(entry.discardWorkId ? {} : { "work.id": entry.workId }),
      });
    }
    assert.doesNotMatch(JSON.stringify(workerRecords), /CANARY_/);
  },
);
