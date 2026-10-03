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
    network,
    async startCollector({ receiverPath, publish, env = [], volumes = [], configs = [] }) {
      const args = ["run", "--detach", "--name", collector, "--network", network, "--user", user];
      for (const port of publish) {
        args.push("--publish", port);
      }
      for (const entry of env) {
        args.push("--env", entry);
      }
      for (const volume of volumes) {
        args.push("--volume", volume);
      }
      configs.forEach((path, index) =>
        args.push("--volume", `${path}:/etc/otel/extra-${index}.yaml:ro`),
      );
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
        ...configs.map((_, index) => `--config=/etc/otel/extra-${index}.yaml`),
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

// A test that checks what the Collector drops ends its OTLP request with this
// sentinel, a record the Collector exports. The logs pipeline is a single chain,
// and its batch processor takes a request whole and sends it in one export (these
// requests are far below send_batch_max_size), so once the sentinel reaches the
// backend, so has every earlier record of the request that survived filtering.
const sentinelPhase = "collector-sentinel";

function sentinelLogs(resource) {
  const record = {
    event: "runtime.startup_phase",
    container: "sentinel",
    phase: sentinelPhase,
    outcome: "ok",
    ms: 0,
    sinceStartMs: 0,
  };
  return {
    resource,
    scopeLogs: [
      {
        logRecords: [
          {
            timeUnixNano: String(BigInt(Date.now()) * 1000000n),
            body: { stringValue: JSON.stringify(record) },
            attributes: [{ key: "log.iostream", value: { stringValue: "stderr" } }],
          },
        ],
      },
    ],
  };
}

// Waits for the sentinel and returns the other exported records.
async function exportedThroughSentinel(out, mapRecord) {
  const isSentinel = (record) =>
    attributes(record.attributes)["occ.startup.phase"] === sentinelPhase;
  let exported = [];
  let unreadable;
  try {
    await waitFor(async () => {
      try {
        exported = await exportedRecords(out, (resource, record) => ({ resource, record }));
        unreadable = undefined;
      } catch (error) {
        // The backend may still be writing the export line.
        if (error instanceof SyntaxError) {
          unreadable = error;
          return false;
        }
        throw error;
      }
      return exported.some(({ record }) => isSentinel(record));
    });
  } catch (error) {
    if (unreadable !== undefined) {
      throw new Error(`The Collector export never became readable: ${unreadable.message}`, {
        cause: error,
      });
    }
    throw error;
  }
  return exported
    .filter(({ record }) => !isSentinel(record))
    .map(({ resource, record }) => mapRecord(resource, record));
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
    await waitFor(async () => (await records()).length >= 7);
    const initial = await records();
    assert.equal(initial.length, 7, "only reviewed JSON classes and Codex stderr pass");
    const warningEvents = [
      "compute.preflight-warning",
      "authentication.sign-in-limited",
      "authentication.provider-unavailable-warning",
    ];
    for (const { resource, record } of initial) {
      assert.ok(record.timeUnixNano, "OTLP record has an Engine timestamp");
      assert.equal(
        record.severityNumber,
        warningEvents.includes(record.body.stringValue) ? 13 : 9,
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
      "occ-api",
      "occ-api",
      "occ-api",
      "occ-worker",
      "openclaw-gateway",
    ]);
    const http = initial.find(({ record }) => record.body.stringValue === "http.completed");
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
    // A limited sign-in lane is promoted with its lane; the hashed key stays in local logs.
    const limited = initial.find(
      ({ record }) => record.body.stringValue === "authentication.sign-in-limited",
    );
    assert.equal(limited.record.severityText, "WARN");
    assert.deepEqual(attributes(limited.record.attributes), {
      "event.name": "authentication.sign-in-limited",
      "log.iostream": "stdout",
      "occ.sign_in.lane": "email",
    });
    // A provider outage keeps the provider, step, bounded cause, and transport code or
    // HTTP status; the provider instance ID stays in local logs.
    const outages = initial
      .filter(
        ({ record }) => record.body.stringValue === "authentication.provider-unavailable-warning",
      )
      .map(({ record }) => {
        assert.equal(record.severityText, "WARN");
        return attributes(record.attributes);
      })
      .sort((left, right) =>
        left["occ.sign_in.provider"].localeCompare(right["occ.sign_in.provider"]),
      );
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
        "occ.code": "ECONNREFUSED",
        "occ.sign_in.provider": "oidc",
        "occ.sign_in.step": "token",
        "occ.sign_in.cause": "connect_refused",
      },
    ]);
    const serialized = JSON.stringify(initial);
    assert.equal(serialized.includes("compute.preflight-warning-unreviewed"), false);
    assert.equal(serialized.includes(`limitkey${fixture.suffix}`), false);
    assert.equal(serialized.includes(`providerkey${fixture.suffix}`), false);
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

// Runs the shipped Kubernetes processors behind an OTLP receiver, standing in
// for filelog and k8sattributes with post-parser records carrying Pod metadata.
async function startKubernetesProcessors(fixture) {
  const kubernetes = loadYaml(await readFile(join(root, "deploy/logging/kubernetes.yaml"), "utf8"));
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
  return receiverAddress;
}

async function postLogs(receiverAddress, resourceLogs) {
  const response = await fetch(`http://${receiverAddress}/v1/logs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ resourceLogs }),
  });
  assert.equal(response.status, 200, await response.text());
}

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
    const receiverAddress = await startKubernetesProcessors(fixture);

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
    assert.equal(exported.resource["container.image.tag"], "fixture-tag");
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
        // A digest-only Pod image: k8sattributes reports the tag as "latest".
        attributes: payload.resourceLogs[0].resource.attributes.map((entry) =>
          entry.key === "occ.component"
            ? { ...entry, value: { stringValue: "worker" } }
            : entry.key === "container.image.tag"
              ? { ...entry, value: { stringValue: "latest" } }
              : entry,
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
    for (const { resource } of workerRecords) {
      assert.equal(resource["container.image.tag"], undefined, "no invented image tag");
      assert.equal(resource["service.version"], imageDigest);
    }
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

test(
  "native Collector keeps bounded runtime wrapper diagnostics from Gateway and Codex Pods",
  {
    skip: selected
      ? false
      : "Set OCC_TEST_LOGGING_COLLECTOR=1 for pinned Collector runtime diagnostic proof.",
    timeout: 180_000,
  },
  async (t) => {
    const fixture = await collectorFixture(t, "wrapper");
    const receiverAddress = await startKubernetesProcessors(fixture);
    const namespaceId = `ns_${randomUUID()}`;
    const agentId = `agt_${randomUUID()}`;
    const revisionId = `rev_${randomUUID()}`;
    const canary = `CANARY_${fixture.suffix}`;
    const resource = (role) => ({
      attributes: Object.entries({
        "occ.managed_by": "openclaw-enterprise",
        "occ.role": role,
        "openclaw.namespace.id": namespaceId,
        "openclaw.agent.id": agentId,
        "openclaw.revision.id": revisionId,
        "k8s.pod.uid": `pod-${randomUUID()}`,
        "container.id": `containerd://${randomUUID()}`,
      }).map(([key, value]) => ({ key, value: { stringValue: value } })),
    });
    const line = (record, stream = "stderr") => ({
      timeUnixNano: String(BigInt(Date.now()) * 1000000n),
      body: { stringValue: JSON.stringify({ ...record, note: canary, message: canary }) },
      attributes: [{ key: "log.iostream", value: { stringValue: stream } }],
    });
    const phase = (container, name, outcome) => ({
      event: "runtime.startup_phase",
      container,
      phase: name,
      outcome,
      ms: 12,
      sinceStartMs: 40,
    });
    const openclawProbe = (code) => ({
      event: "openclaw.model_probe",
      elapsedMs: 53049,
      capMs: 65000,
      cpuWaitMs: 7,
      code,
    });
    await postLogs(receiverAddress, [
      {
        resource: resource("gateway"),
        scopeLogs: [
          {
            logRecords: [
              line(phase("gateway", "model-probe", "failed")),
              line(openclawProbe("AUTHENTICATION_FAILED")),
              line(phase("gateway", "runtime-assets", "ok")),
              line(openclawProbe("READY")),
              line({
                event: "runtime.workspace_node",
                container: "gateway",
                outcome: "failed",
                code: "WORKSPACE_NODE_FAILED",
              }),
              // Setting names stay out of the remote record (D322).
              line({
                event: "runtime.gateway_settings_overridden",
                container: "gateway",
                settings: ["cron.triggers.enabled", `models.providers.${canary}.headers`],
              }),
              // Unbounded values lose the field, never the event.
              line(openclawProbe(`${canary} key`)),
              line(phase("gateway", `${canary}/../path`, "failed")),
              // Only reviewed wrapper events, and only from the wrapper's stderr.
              line(openclawProbe("AUTHENTICATION_FAILED"), "stdout"),
              line({ event: "runtime.environment", code: "READY" }),
            ],
          },
        ],
      },
      {
        resource: resource("agent"),
        scopeLogs: [
          {
            logRecords: [
              line({
                event: "codex.model_probe",
                attempt: 1,
                elapsedMs: 900,
                exitCode: 1,
                signal: null,
                code: "AUTHENTICATION_FAILED",
              }),
              line(phase("agent", "codex-login", "ok")),
              line(phase("agent", "codex-login", "ok"), "stdout"),
              // A failed phase keeps a bounded cause code; an unbounded one is dropped.
              line({
                ...phase("agent", "plugin-install", "failed"),
                code: "PLUGIN_NOT_IN_CATALOG",
              }),
              line({ ...phase("agent", "plugin-install", "failed"), code: `${canary} key` }),
              line({ ...phase("agent", "native-spawn", "ok"), code: "PLUGIN_NOT_IN_CATALOG" }),
            ],
          },
        ],
      },
      sentinelLogs(resource("gateway")),
    ]);
    const exported = await exportedThroughSentinel(fixture.out, (resource, record) => ({
      resource: attributes(resource.resource?.attributes),
      attributes: attributes(record.attributes),
      record,
    }));
    for (const { resource } of exported) {
      assert.equal(resource["openclaw.namespace.id"], namespaceId);
      assert.equal(resource["openclaw.agent.id"], agentId);
      assert.equal(resource["openclaw.revision.id"], revisionId);
    }
    const summary = (service, severity, attributes) =>
      JSON.stringify([
        service,
        severity,
        Object.entries({ "log.iostream": "stderr", ...attributes }).sort(([a], [b]) =>
          a.localeCompare(b),
        ),
      ]);
    const gateway = (severity, attributes) => summary("openclaw-gateway", severity, attributes);
    const codex = (severity, attributes) => summary("codex-app-server", severity, attributes);
    const phaseEvent = { "event.name": "runtime.startup_phase" };
    const probeEvent = { "event.name": "openclaw.model_probe" };
    const sort = (entries) => [...entries].sort();
    assert.deepEqual(
      sort(
        exported.map(({ resource, attributes, record }) => {
          assert.equal(record.body.stringValue, attributes["event.name"]);
          return summary(resource["service.name"], record.severityText, attributes);
        }),
      ),
      sort([
        gateway("WARN", { ...phaseEvent, "occ.startup.phase": "model-probe" }),
        gateway("WARN", { ...probeEvent, "occ.code": "AUTHENTICATION_FAILED" }),
        gateway("INFO", { ...phaseEvent, "occ.startup.phase": "runtime-assets" }),
        gateway("INFO", { ...probeEvent, "occ.code": "READY" }),
        gateway("WARN", {
          "event.name": "runtime.workspace_node",
          "occ.code": "WORKSPACE_NODE_FAILED",
        }),
        gateway("WARN", { "event.name": "runtime.gateway_settings_overridden" }),
        gateway("WARN", probeEvent),
        gateway("WARN", phaseEvent),
        codex("WARN", { "event.name": "codex.model_probe", "occ.code": "AUTHENTICATION_FAILED" }),
        codex("INFO", { ...phaseEvent, "occ.startup.phase": "codex-login" }),
        codex("WARN", {
          ...phaseEvent,
          "occ.startup.phase": "plugin-install",
          "occ.code": "PLUGIN_NOT_IN_CATALOG",
        }),
        codex("WARN", { ...phaseEvent, "occ.startup.phase": "plugin-install" }),
        codex("INFO", { ...phaseEvent, "occ.startup.phase": "native-spawn" }),
      ]),
    );
    assert.doesNotMatch(JSON.stringify(exported), /CANARY_/);
  },
);

test(
  "native Collector exports Codex turns, tool calls and plain app-server messages, not span noise",
  {
    skip: selected
      ? false
      : "Set OCC_TEST_LOGGING_COLLECTOR=1 for pinned Collector Codex record proof.",
    timeout: 180_000,
  },
  async (t) => {
    const fixture = await collectorFixture(t, "codex");
    const receiverAddress = await startKubernetesProcessors(fixture);
    const canary = `CANARY_${fixture.suffix}`;
    const resource = {
      attributes: Object.entries({
        "occ.managed_by": "openclaw-enterprise",
        "occ.role": "agent",
        "openclaw.namespace.id": `ns_${randomUUID()}`,
        "openclaw.agent.id": `agt_${randomUUID()}`,
        "openclaw.revision.id": `rev_${randomUUID()}`,
        "k8s.pod.uid": `pod-${randomUUID()}`,
        "container.id": `containerd://${randomUUID()}`,
      }).map(([key, value]) => ({ key, value: { stringValue: value } })),
    };
    // Codex 0.158 tracing JSON, as `LOG_FORMAT=json` prints it.
    const tracing = (level, target, fields, span) => ({
      timeUnixNano: String(BigInt(Date.now()) * 1000000n),
      body: {
        stringValue: JSON.stringify({
          timestamp: new Date().toISOString(),
          level,
          fields,
          target,
          ...(span === undefined ? {} : { span, spans: [] }),
        }),
      },
      attributes: [{ key: "log.iostream", value: { stringValue: "stderr" } }],
    });
    const turn = { name: "turn", model: canary, "turn.id": canary, "thread.id": canary };
    await postLogs(receiverAddress, [
      {
        resource,
        scopeLogs: [
          {
            logRecords: [
              tracing("INFO", "codex_core::tasks", { message: "new" }, turn),
              tracing("INFO", "codex_core::tasks", { message: "enter" }, turn),
              tracing("INFO", "codex_core::tasks", { message: "exit" }, turn),
              tracing("INFO", "codex_core::tasks", { message: "close", "time.busy": canary }, turn),
              tracing(
                "INFO",
                "codex_app_server::app_server_tracing",
                { message: "enter" },
                {
                  name: "app_server.request",
                },
              ),
              tracing(
                "INFO",
                "codex_app_server::app_server_tracing",
                { message: "new" },
                {
                  name: "app_server.request",
                },
              ),
              tracing("INFO", "codex_core::tools::parallel", {
                message: "tool call completed",
                tool_name: "shell",
                call_id: canary,
                turn_id: canary,
              }),
              tracing("INFO", "codex_core::tools::parallel", {
                message: "tool call completed",
                tool_name: `${canary} "x"`,
              }),
              tracing("INFO", "codex_app_server", {
                message:
                  "received shutdown signal; entering graceful restart drain (connections=0, runningAssistantTurns=0, new client turns rejected)",
              }),
              // Transport records below warn are not reviewed operational output.
              tracing("INFO", "codex_app_server_transport::transport::websocket", {
                message: "websocket client connected",
                peer_addr: "127.0.0.1:41000",
              }),
              tracing("INFO", "codex_app_server", {
                message: "outbound router task exited (channel closed)",
              }),
              // Unreviewed message text keeps the event name as its body (errors) or is
              // dropped (warnings).
              tracing("ERROR", "codex_app_server", {
                message: `Failed to deserialize JSONRPCMessage: invalid type: string "${canary}"`,
              }),
              tracing("WARN", "codex_app_server", { message: `failed to refresh token ${canary}` }),
              tracing("WARN", "codex_app_server", { message: `${"x".repeat(30)}${canary}` }),
              // Model failures from any Codex target, never the codex_otel content targets.
              // Only app-server and the fixed codex_core retry messages keep their text.
              tracing("WARN", "codex_core::responses_retry", {
                message: "stream connection failed; waiting to retry",
                error: canary,
                prompt: canary,
              }),
              tracing("WARN", "codex_otel::log_only", {
                message: "stream connection failed; waiting to retry",
              }),
              // codex_core can interpolate chat text into a warning; plain prose
              // that passes the plain-text pattern is never exported as text.
              tracing("WARN", "codex_core::event_mapping", {
                message: "Output text in user message: deploy the payroll service now",
              }),
              tracing("ERROR", "codex_core::session::handlers", {
                message: "Failed to apply execpolicy amendment: rm allowed",
              }),
              tracing("INFO", "codex_core::client", { message: "using model" }),
              // A repeating plugin warning without a reviewed message is dropped.
              tracing("WARN", "codex_core_plugins::manager", {
                message: "remote installed plugin bundle sync failed",
              }),
            ],
          },
        ],
      },
      sentinelLogs(resource),
    ]);
    const exported = await exportedThroughSentinel(fixture.out, (_resource, record) => ({
      attributes: attributes(record.attributes),
      record,
    }));
    const summary = exported
      .map(({ attributes: kept, record }) =>
        JSON.stringify([
          record.severityText,
          kept["event.name"],
          record.body.stringValue,
          kept["occ.codex.tool_name"] ?? null,
        ]),
      )
      .sort();
    assert.deepEqual(
      summary,
      [
        ["INFO", "codex.turn", "turn started", null],
        ["INFO", "codex.turn", "turn completed", null],
        ["INFO", "codex.tool_call", "tool call completed", "shell"],
        ["INFO", "codex.tool_call", "tool call completed", null],
        [
          "INFO",
          "codex.operational",
          "received shutdown signal; entering graceful restart drain (connections=0, runningAssistantTurns=0, new client turns rejected)",
          null,
        ],
        ["INFO", "codex.operational", "outbound router task exited (channel closed)", null],
        ["ERROR", "codex.operational", "codex.operational", null],
        ["WARN", "codex.operational", "stream connection failed; waiting to retry", null],
        ["ERROR", "codex.operational", "codex.operational", null],
      ]
        .map((entry) => JSON.stringify(entry))
        .sort(),
    );
    assert.doesNotMatch(JSON.stringify(exported), /CANARY_/);
  },
);

test(
  "native Collector keeps argv credentials out of Codex bodies and exports Gateway startup failures",
  {
    skip: selected
      ? false
      : "Set OCC_TEST_LOGGING_COLLECTOR=1 for pinned Collector Gateway startup proof.",
    timeout: 180_000,
  },
  async (t) => {
    const fixture = await collectorFixture(t, "gateway-startup");
    const receiverAddress = await startKubernetesProcessors(fixture);
    const canary = `CANARY_${fixture.suffix}`;
    const resource = {
      attributes: Object.entries({
        "occ.managed_by": "openclaw-enterprise",
        "occ.role": "gateway",
        "openclaw.namespace.id": `ns_${randomUUID()}`,
        "openclaw.agent.id": `agt_${randomUUID()}`,
        "openclaw.revision.id": `rev_${randomUUID()}`,
        "k8s.pod.uid": `pod-${randomUUID()}`,
        "container.id": `containerd://${randomUUID()}`,
      }).map(([key, value]) => ({ key, value: { stringValue: value } })),
    };
    // OpenClaw's JSON console prints the startup failure with no subsystem.
    const consoleLine = (record) => ({
      timeUnixNano: String(BigInt(Date.now()) * 1000000n),
      body: { stringValue: JSON.stringify({ time: new Date().toISOString(), ...record }) },
      attributes: [{ key: "log.iostream", value: { stringValue: "stdout" } }],
    });
    const cause =
      "Gateway failed to start: gateway.bind=custom requires gateway.customBindHost. Run openclaw gateway status --deep for diagnostics.";
    const codexResource = {
      attributes: resource.attributes.map((entry) =>
        entry.key === "occ.role" ? { key: "occ.role", value: { stringValue: "agent" } } : entry,
      ),
    };
    const codexError = (message) => ({
      timeUnixNano: String(BigInt(Date.now()) * 1000000n),
      body: {
        stringValue: JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "ERROR",
          fields: { message },
          target: "codex_app_server",
        }),
      },
      attributes: [{ key: "log.iostream", value: { stringValue: "stderr" } }],
    });
    await postLogs(receiverAddress, [
      {
        // argv credentials have no credential word: a codex.operational body with a
        // credential flag or a user:password pair keeps the event name.
        resource: codexResource,
        scopeLogs: [
          {
            logRecords: [
              codexError(`exec_command failed: curl -u admin:${canary} https://x.example`),
              codexError(`exec_command failed: git --password ${canary}`),
            ],
          },
        ],
      },
      {
        resource,
        scopeLogs: [
          {
            logRecords: [
              consoleLine({ level: "error", message: cause }),
              // A cause that names a credential, or quotes a value, keeps the event name.
              consoleLine({
                level: "error",
                message: `Gateway failed to start: gateway.auth.token ${canary} is invalid`,
              }),
              consoleLine({
                level: "error",
                message: `Gateway failed to start: "${canary}"`,
              }),
              // Other subsystem-less output (a chat reply printed by runtime.log) and
              // a non-error startup line are not exported.
              consoleLine({ level: "info", message: `Gateway failed to start: ${canary}` }),
              consoleLine({ level: "error", message: canary }),
            ],
          },
        ],
      },
      sentinelLogs(resource),
    ]);
    const exported = await exportedThroughSentinel(fixture.out, (_resource, record) => ({
      attributes: attributes(record.attributes),
      record,
    }));
    assert.deepEqual(
      exported
        .map(({ attributes: kept, record }) =>
          JSON.stringify([record.severityText, kept["event.name"], record.body.stringValue]),
        )
        .sort(),
      [
        ["ERROR", "codex.operational", "codex.operational"],
        ["ERROR", "codex.operational", "codex.operational"],
        ["ERROR", "gateway.startup_failed", cause],
        ["ERROR", "gateway.startup_failed", "gateway.startup_failed"],
        ["ERROR", "gateway.startup_failed", "gateway.startup_failed"],
      ]
        .map((entry) => JSON.stringify(entry))
        .sort(),
    );
    assert.doesNotMatch(JSON.stringify(exported), /CANARY_/);
  },
);

// Stands in for the API server behind k8sattributes: serves one Pod through
// list or watch-list, and withholds every Pod response until the test releases it.
const podMetadataServer = `
const http = require('node:http');
const pod = JSON.parse(process.env.POD);
const requests = [];
const held = [];
let released = false;
const answer = (url, res) => {
  res.setHeader('content-type', 'application/json');
  if (url.searchParams.get('watch') === 'true') {
    res.writeHead(200);
    if (url.searchParams.get('sendInitialEvents') === 'true') {
      res.write(JSON.stringify({ type: 'ADDED', object: pod }) + '\\n');
      res.write(JSON.stringify({ type: 'BOOKMARK', object: { kind: 'Pod', apiVersion: 'v1',
        metadata: { resourceVersion: '10', annotations: { 'k8s.io/initial-events-end': 'true' } } } }) + '\\n');
    }
    return;
  }
  res.end(JSON.stringify({ apiVersion: 'v1', kind: 'PodList', metadata: { resourceVersion: '10' }, items: [pod] }));
};
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://api');
  if (url.pathname === '/fixture/requests') return res.end(JSON.stringify(requests));
  if (url.pathname === '/fixture/release') {
    released = true;
    held.splice(0).forEach(([u, r]) => answer(u, r));
    return res.end('released');
  }
  if (url.pathname !== '/api/v1/pods') { res.writeHead(404); return res.end('{}'); }
  requests.push(req.url);
  if (released) return answer(url, res);
  held.push([url, res]);
}).listen(8001, '0.0.0.0');
`;

test(
  "native Collector keeps CRI records written before Kubernetes Pod metadata syncs",
  {
    skip: selected
      ? false
      : "Set OCC_TEST_LOGGING_COLLECTOR=1 for pinned Collector Kubernetes metadata proof.",
    timeout: 180_000,
  },
  async (t) => {
    const fixture = await collectorFixture(t, "sync");
    const api = `oce-otel-sync-api-${fixture.suffix}`;
    t.after(() => docker(["rm", "--force", api]).catch(() => {}));
    const namespace = `system-${fixture.suffix}`;
    const podName = `openclaw-enterprise-worker-${fixture.suffix}`;
    const podUid = randomUUID();
    const pod = {
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        name: podName,
        namespace,
        uid: podUid,
        resourceVersion: "10",
        labels: {
          "app.kubernetes.io/name": "openclaw-enterprise",
          "app.kubernetes.io/component": "worker",
        },
      },
      spec: { nodeName: "fixture-node", containers: [{ name: "worker", image: "fixture" }] },
      status: {
        containerStatuses: [
          {
            name: "worker",
            image: "fixture",
            imageID: `registry.example.test/controller@sha256:${"b".repeat(64)}`,
            containerID: `containerd://${fixture.suffix}`,
            ready: true,
            restartCount: 0,
            state: { running: {} },
          },
        ],
      },
    };
    // The worker's only startup event is already on disk when the Collector
    // starts, exactly as for a DaemonSet added to (or restarted on) a live node.
    const pods = join(fixture.directory, "pods");
    const logDirectory = join(pods, `${namespace}_${podName}_${podUid}`, "worker");
    await mkdir(logDirectory, { recursive: true });
    await writeFile(
      join(logDirectory, "0.log"),
      `${new Date().toISOString()} stdout F ${JSON.stringify({ level: 30, event: "worker.started", computeDriverId: "kubernetes" })}\n`,
    );
    await docker([
      "run",
      "--detach",
      "--name",
      api,
      "--network",
      fixture.network,
      "--publish",
      "127.0.0.1::8001",
      "--env",
      `POD=${JSON.stringify(pod)}`,
      nodeImage,
      "node",
      "-e",
      podMetadataServer,
    ]);
    const control = `http://${(await docker(["port", api, "8001/tcp"])).split("\n")[0]}/fixture`;
    const podRequests = async () =>
      fetch(`${control}/requests`)
        .then((response) => response.json())
        .catch(() => []);
    await waitFor(async () =>
      fetch(`${control}/requests`)
        .then((response) => response.ok)
        .catch(() => false),
    );
    await writeFile(
      join(fixture.directory, "kubeconfig"),
      `${JSON.stringify({
        apiVersion: "v1",
        kind: "Config",
        clusters: [{ name: "fixture", cluster: { server: `http://${api}:8001` } }],
        users: [{ name: "fixture", user: {} }],
        contexts: [{ name: "fixture", context: { cluster: "fixture", user: "fixture" } }],
        "current-context": "fixture",
      })}\n`,
    );
    // Only the credential source differs from the shipped receiver file.
    await writeFile(
      join(fixture.directory, "metadata-auth.yaml"),
      "processors:\n  k8sattributes:\n    auth_type: kubeConfig\n",
    );
    await fixture.startCollector({
      receiverPath: join(root, "deploy/logging/kubernetes.yaml"),
      publish: [],
      env: ["K8S_NODE_NAME=fixture-node", "KUBECONFIG=/etc/otel-fixture/kubeconfig"],
      volumes: [
        `${pods}:/var/log/pods:ro`,
        `${join(fixture.directory, "kubeconfig")}:/etc/otel-fixture/kubeconfig:ro`,
      ],
      configs: [join(fixture.directory, "metadata-auth.yaml")],
    });
    const records = async () =>
      exportedRecords(fixture.out, (resource, record) => ({
        resource: attributes(resource.resource?.attributes),
        record,
      }));

    // Hold Pod metadata well past filelog's first 200 ms poll. A pipeline that
    // started without metadata has read, dropped and committed the record by now.
    await waitFor(async () => (await podRequests()).length > 0);
    await delay(3_000);
    assert.deepEqual(await records(), []);
    await fetch(`${control}/release`, { method: "POST" });

    await waitFor(async () => (await records()).length > 0);
    const exported = await records();
    assert.equal(exported.length, 1);
    assert.equal(exported[0].resource["service.name"], "occ-worker");
    assert.equal(exported[0].resource["service.instance.id"], podUid);
    assert.equal(exported[0].record.body?.stringValue, "worker.started");
    assert.equal(exported[0].record.severityText, "INFO");
  },
);
