import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { OpenShellGateway } from "../../apps/controller/src/backends/openshell.ts";
import {
  GrpcOpenShellGatewayClient,
  openShellSandboxLogReader,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import { RuntimeLogsForbiddenByClusterError } from "../../packages/occ/src/index.ts";
import {
  createRuntimeLogComputeDriver,
  createRuntimeLogFixture,
  operateGrants,
} from "../helpers/runtime-logs.mjs";

const SANDBOX_NAMESPACE = "tenant-logs";
const SANDBOX_ID = "7c0e5d4a-1b2c-4d3e-8f90-a1b2c3d4e5f6";

function lineTime(second, nanos = 0) {
  return `2026-09-30T12:00:${String(second).padStart(2, "0")}.${String(nanos).padStart(9, "0")}Z`;
}

function sandboxLine(second, message, extra = {}) {
  return {
    sandboxId: SANDBOX_ID,
    time: lineTime(second),
    level: "OCSF",
    target: "ocsf",
    message,
    source: "sandbox",
    fields: {},
    ...extra,
  };
}

/**
 * A gateway client that only answers `GetSandboxLogs`. Every other member, and any
 * property the log path touches besides `getSandboxLogs`, is recorded and fails.
 */
function logOnlyGatewayClient() {
  const state = { lines: [], bufferTotal: undefined, error: undefined };
  const requests = [];
  const touched = [];
  const target = {
    async getSandboxLogs(request, signal) {
      assert.ok(signal instanceof AbortSignal);
      requests.push(structuredClone(request));
      if (state.error !== undefined) {
        throw state.error;
      }
      const matching =
        request.sinceTime === undefined
          ? state.lines
          : state.lines.filter((line) => line.time >= request.sinceTime);
      const tail = state.lines.slice(-request.lines);
      return {
        lines: matching.filter((line) => tail.includes(line)).slice(-request.lines),
        bufferTotal: state.bufferTotal ?? tail.length,
      };
    },
  };
  const client = new Proxy(target, {
    get(object, property) {
      if (typeof property === "string") {
        touched.push(property);
      }
      if (property === "getSandboxLogs") {
        return object.getSandboxLogs;
      }
      return () => {
        throw new Error(`The log path reached the OpenShell ${String(property)} RPC.`);
      };
    },
  });
  return { client, state, requests, touched };
}

function openShellSandboxDriver(gatewayClient) {
  return new OpenShellSandboxDriver(
    {
      gateway: { workspaceMode: "operator" },
      kubernetes: {
        runtimeClassName: "openshell-sandbox",
        serviceAccount: { mode: "gatewayConfigured" },
        sandboxDataMount: {
          subPath: "workspace",
          mountPath: "/sandbox/enterprise",
          readOnly: false,
        },
      },
      policy: {
        process: { runAsUser: "1000", runAsGroup: "1000" },
        networkPolicies: [
          {
            name: "model-egress",
            endpoints: [{ host: "api.openai.com", ports: [443] }],
            binaries: [{ path: "/app/bin/model-client" }],
          },
        ],
      },
    },
    {
      id: "openshell-sandbox",
      implementation: "openshell",
      backend: {
        id: "openshell",
        drivers: { sandbox: "openshell-sandbox" },
        client: new OpenShellGateway({ serviceName: "openshell-gateway" }, { gatewayClient }),
      },
    },
  );
}

async function sandboxFixture() {
  const gateway = logOnlyGatewayClient();
  const computeDriver = createRuntimeLogComputeDriver({ sandboxNamespace: SANDBOX_NAMESPACE });
  const fixture = await createRuntimeLogFixture({
    computeDriver,
    sandboxDriver: openShellSandboxDriver(gateway.client),
  });
  const target = await fixture.deployAgent("sandbox-logs");
  return { ...fixture, gateway, target };
}

function canaries() {
  const token = () => randomUUID().replaceAll("-", "").slice(0, 20);
  return {
    CLONE_TOKEN: `Zq9${token()}`,
    CURL_BEARER: `Br7${token()}`,
    QUERY_TOKEN: `Qt${token()}`,
    QUERY_SIG: `Sg${token()}`,
    FIELD_URL_KEY: `Fk${token()}`,
    PASSWORD: `Pw${token()}`,
    PROMPT: `prompt-canary-${token()}`,
    GITHUB_PAT: `ghp_${token()}${token()}`,
    CURL_USER_PASSWORD: `Cu${token()}`,
    SSHPASS_PASSWORD: `Sp${token()}`,
  };
}

test("sandbox log pages never contain planted credentials from command lines or URLs", async () => {
  const values = canaries();
  const { gateway, target, request, auditSink } = await sandboxFixture();
  const longArgument = "--verbose ".repeat(600);
  gateway.state.lines = [
    sandboxLine(
      1,
      `PROC:LAUNCH [INFO] git(4242) [cmd:git clone https://x-access-token:${values.CLONE_TOKEN}@github.com/acme/repo.git]`,
    ),
    sandboxLine(
      2,
      `PROC:LAUNCH [INFO] curl(51) [cmd:curl -sS -H 'Authorization: Bearer ${values.CURL_BEARER}' https://api.example.com/v1/models]`,
    ),
    sandboxLine(
      3,
      `HTTP:GET [INFO] ALLOWED curl(51) -> GET https://storage.example.com/obj$&?token=${values.QUERY_TOKEN}&sig=${values.QUERY_SIG} [policy:egress engine:opa]`,
    ),
    sandboxLine(
      4,
      "NET:OPEN [MED] DENIED python3(42) -> blocked.example.com:443 [policy:default engine:opa] [reason:endpoint blocked.example.com:443 not in policy default]",
    ),
    sandboxLine(5, `upstream refused the request password=${values.PASSWORD}`, {
      level: "WARN",
      target: "openshell_supervisor::proxy",
      fields: {
        dst_host: "api.example.com",
        action: "deny",
        url: `https://api.example.com/v1?api_key=${values.FIELD_URL_KEY}`,
        prompt: values.PROMPT,
        token: values.GITHUB_PAT,
      },
    }),
    sandboxLine(6, JSON.stringify({ prompt: values.PROMPT }), { level: "INFO", target: "t" }),
    sandboxLine(7, `PROC:LAUNCH [INFO] node(9) [cmd:node run.js --flag ${longArgument}]`),
    sandboxLine(
      8,
      `PROC:LAUNCH [INFO] curl(52) [cmd:curl -u alice:${values.CURL_USER_PASSWORD} https://a.example.com]`,
    ),
    sandboxLine(
      9,
      `PROC:LAUNCH [INFO] sshpass(53) [cmd:sshpass -p ${values.SSHPASS_PASSWORD} ssh build@host]`,
    ),
  ];

  const runtime = await request("GET", target.runtimePath);
  assert.equal(runtime.status, 200, runtime.text);
  const source = runtime.data.sources.find(({ id }) => id === "sandbox");
  assert.deepEqual(
    { ...source, retention: undefined },
    { id: "sandbox", kind: "sandbox", pods: [], available: true, retention: undefined },
  );
  assert.match(source.retention, /last 2000 lines per sandbox/);

  const auditBefore = auditSink.events.length;
  const logs = await request("GET", target.logsPath("source=sandbox&tailLines=1000"));
  assert.equal(logs.status, 200, logs.text);
  assert.equal(logs.headers.get("cache-control"), "no-store");
  for (const [name, value] of Object.entries(values)) {
    assert.equal(logs.text.includes(value), false, `canary ${name} leaked into the response`);
  }
  const download = await request("GET", target.logsPath("source=sandbox&download=true"));
  assert.equal(download.status, 200, download.text);
  for (const [name, value] of Object.entries(values)) {
    assert.equal(download.text.includes(value), false, `canary ${name} leaked into the download`);
  }
  assert.match(download.text, /^# agent=\S+ revision=\S+ source=sandbox sandbox=sb-[0-9a-f]+ /);

  // The route reached OpenShell only through the log RPC, for the revision's own Sandbox.
  assert.deepEqual([...new Set(gateway.touched)], ["getSandboxLogs"]);
  assert.equal(gateway.requests.length, 2);
  const [first] = gateway.requests;
  assert.equal(first.workspace, SANDBOX_NAMESPACE);
  assert.match(first.sandbox, /^sb-[0-9a-f]+$/);
  assert.equal(first.lines, 1000);
  assert.equal(logs.data.stream.sandbox, first.sandbox);
  assert.deepEqual(logs.data.stream, { source: "sandbox", sandbox: first.sandbox });

  // One view audit before the read, naming the source but no Sandbox text.
  const views = auditSink.events
    .slice(auditBefore)
    .filter((event) => event.details?.runtimeLogs?.source === "sandbox");
  assert.equal(views.length, 2, "the view and the download are audited");
  assert.equal(views[0].details.runtimeLogs.revisionId, target.revisionId);

  const lines = logs.data.records.filter((record) => record.type === "line");
  assert.equal(lines.length, 8);
  assert.ok(
    lines.every((record) => record.kind === "sandbox" && record.contentClass === "activity"),
  );
  const [clone, curl, http, denied, tracing, long, curlUser, sshpass] = lines;
  assert.equal(curlUser.fields.cmd_line, "curl -u [redacted:argv] https://a.example.com");
  assert.equal(sshpass.fields.cmd_line, "sshpass -p [redacted:argv] ssh build@host");
  assert.equal(
    clone.fields.cmd_line,
    "git clone https://[redacted:userinfo]@github.com/acme/repo.git",
  );
  assert.equal(clone.fields.binary, "git");
  assert.equal(clone.fields.pid, "4242");
  assert.equal(clone.fields.activity, "PROC:LAUNCH");
  assert.equal(clone.message, "PROC:LAUNCH [INFO] git(4242)");
  assert.match(curl.fields.cmd_line, /Authorization: \[redacted:header\]/);
  assert.deepEqual(
    {
      method: http.fields.method,
      url: http.fields.url,
      rule_name: http.fields.rule_name,
      rule_type: http.fields.rule_type,
      action: http.fields.action,
    },
    {
      method: "GET",
      url: "https://storage.example.com/obj$&?token=[redacted:query]&sig=[redacted:query]",
      rule_name: "egress",
      rule_type: "opa",
      action: "ALLOWED",
    },
  );
  assert.equal(
    http.message,
    "HTTP:GET [INFO] ALLOWED curl(51) -> GET https://storage.example.com/obj$&?token=[redacted:query]&sig=[redacted:query] [policy:egress engine:opa]",
  );
  assert.equal(denied.level, "warn");
  assert.equal(denied.fields.dst_host, "blocked.example.com");
  assert.equal(denied.fields.dst_port, "443");
  assert.match(denied.fields.reason, /not in policy default/);
  assert.equal(tracing.level, "warn");
  assert.equal(tracing.subsystem, "openshell_supervisor::proxy");
  assert.deepEqual(Object.keys(tracing.fields).sort(), ["action", "dst_host", "source", "url"]);
  assert.ok(Buffer.byteLength(long.fields.cmd_line) <= 1024);
  assert.match(long.fields.cmd_line, /…\[truncated\]$/);
  assert.deepEqual(
    logs.data.records
      .filter((record) => record.type === "withheld")
      .map(({ reason, count }) => ({ reason, count })),
    [{ reason: "unrecognised_structured", count: 1 }],
  );
});

test("sandbox follow resumes after the anchor and labels buffer loss and a full window", async () => {
  const { gateway, target, request, auditSink } = await sandboxFixture();
  gateway.state.lines = [
    sandboxLine(1, "NET:OPEN [INFO] ALLOWED curl(1) -> a.example.com:443"),
    sandboxLine(2, "NET:OPEN [INFO] ALLOWED curl(1) -> b.example.com:443"),
  ];
  const first = await request("GET", target.logsPath("source=sandbox"));
  assert.equal(first.status, 200, first.text);
  assert.equal(first.data.records.length, 2);
  const auditAfterFirst = auditSink.events.length;

  // New lines after the anchor: only they are delivered, with no gap.
  gateway.state.lines.push(sandboxLine(3, "NET:OPEN [INFO] ALLOWED curl(1) -> c.example.com:443"));
  const second = await request(
    "GET",
    target.logsPath(`source=sandbox&cursor=${encodeURIComponent(first.data.cursor)}`),
  );
  assert.equal(second.status, 200, second.text);
  assert.deepEqual(
    second.data.records.map((record) => record.fields?.dst_host ?? record.reason),
    ["c.example.com"],
  );
  // The resume re-reads a 5 s overlap behind the newest delivered line.
  assert.equal(gateway.requests.at(-1).sinceTime, "2026-09-30T11:59:57.000000000Z");
  assert.equal(auditSink.events.length, auditAfterFirst, "cursor polls are not re-audited");

  // The gateway restarted and lost its ring: the anchor and everything older are gone.
  gateway.state.lines = [sandboxLine(9, "NET:OPEN [INFO] ALLOWED curl(1) -> d.example.com:443")];
  const lost = await request(
    "GET",
    target.logsPath(`source=sandbox&cursor=${encodeURIComponent(second.data.cursor)}`),
  );
  assert.equal(lost.status, 200, lost.text);
  assert.equal(lost.data.records[0].type, "gap");
  assert.equal(lost.data.records[0].reason, "buffer_lost");
  assert.equal(lost.data.records[1].fields.dst_host, "d.example.com");

  // More new lines than the window: the anchor fell out of the requested tail.
  gateway.state.lines = [
    ...gateway.state.lines,
    sandboxLine(10, "NET:OPEN [INFO] ALLOWED curl(1) -> e.example.com:443"),
    sandboxLine(11, "NET:OPEN [INFO] ALLOWED curl(1) -> f.example.com:443"),
    sandboxLine(12, "NET:OPEN [INFO] ALLOWED curl(1) -> g.example.com:443"),
  ];
  const full = await request(
    "GET",
    target.logsPath(`source=sandbox&tailLines=2&cursor=${encodeURIComponent(lost.data.cursor)}`),
  );
  assert.equal(full.status, 200, full.text);
  assert.equal(full.data.records[0].reason, "window_exceeded");
  assert.deepEqual(
    full.data.records.slice(1).map((record) => record.fields.dst_host),
    ["f.example.com", "g.example.com"],
  );

  // Older lines came back (dropped by time), so nothing between pages is missing.
  gateway.state.lines.push(sandboxLine(13, "NET:OPEN [INFO] ALLOWED curl(1) -> h.example.com:443"));
  gateway.state.bufferTotal = 5;
  const continuous = await request(
    "GET",
    target.logsPath(`source=sandbox&cursor=${encodeURIComponent(full.data.cursor)}`),
  );
  gateway.state.bufferTotal = undefined;
  assert.equal(continuous.status, 200, continuous.text);
  assert.deepEqual(
    continuous.data.records.map((record) => record.type),
    ["line"],
  );

  // A new Sandbox object for the same revision is a new stream.
  gateway.state.lines = [
    sandboxLine(14, "NET:OPEN [INFO] ALLOWED curl(1) -> i.example.com:443", {
      sandboxId: "11111111-2222-4333-8444-555555555555",
    }),
  ];
  const replaced = await request(
    "GET",
    target.logsPath(`source=sandbox&cursor=${encodeURIComponent(continuous.data.cursor)}`),
  );
  assert.equal(replaced.status, 200, replaced.text);
  assert.equal(replaced.data.records[0].reason, "stream_replaced");
});

test("sandbox follow delivers late-stamped lines and counts repeats in one millisecond", async () => {
  const { gateway, target, request } = await sandboxFixture();
  const page = async (cursor) => {
    const response = await request(
      "GET",
      target.logsPath(`source=sandbox&cursor=${encodeURIComponent(cursor)}`),
    );
    assert.equal(response.status, 200, response.text);
    return response.data;
  };
  const hosts = (data) => data.records.map((record) => record.fields?.dst_host ?? record.reason);
  // A gateway line at 12:00:05 is shown before a supervisor line stamped 12:00:04.6
  // that was still batched; the late line arrives after it and must still be delivered.
  gateway.state.lines = [sandboxLine(5, "NET:OPEN [INFO] ALLOWED curl(1) -> gw.example.com:443")];
  const first = (await request("GET", target.logsPath("source=sandbox"))).data;
  assert.deepEqual(hosts(first), ["gw.example.com"]);
  gateway.state.lines.push({
    ...sandboxLine(4, "NET:OPEN [INFO] DENIED curl(1) -> late.example.com:443"),
    time: lineTime(4, 600_000_000),
  });
  const late = await page(first.cursor);
  assert.deepEqual(hosts(late), ["late.example.com"]);
  // Nothing new: nothing is shown again.
  const idle = await page(late.cursor);
  assert.deepEqual(hosts(idle), []);

  // A second identical line in the same millisecond is a new occurrence.
  const repeat = sandboxLine(6, "NET:OPEN [INFO] DENIED curl(1) -> same.example.com:443");
  gateway.state.lines.push({ ...repeat });
  const once = await page(idle.cursor);
  assert.deepEqual(hosts(once), ["same.example.com"]);
  gateway.state.lines.push({ ...repeat });
  const twice = await page(once.cursor);
  assert.deepEqual(hosts(twice), ["same.example.com"]);
  assert.deepEqual(hosts(await page(twice.cursor)), []);

  // Twenty distinct lines in one millisecond are delivered once and not replayed.
  for (let index = 0; index < 20; index += 1) {
    gateway.state.lines.push(
      sandboxLine(7, `NET:OPEN [INFO] ALLOWED curl(1) -> b${index}.example.com:443`),
    );
  }
  const burst = await page(twice.cursor);
  assert.equal(burst.records.length, 20);
  const settled = await page(burst.cursor);
  assert.deepEqual(hosts(settled), []);
});

test("sandbox follow drops a whole timestamp group at the cursor capacity boundary", async () => {
  const { gateway, target, request } = await sandboxFixture();
  // Fifty lines fit the response, but retaining only part of the older timestamp
  // would replay its forgotten occurrences when the next poll reads that timestamp.
  gateway.state.lines = Array.from({ length: 50 }, (_, index) =>
    sandboxLine(index < 30 ? 7 : 8, `NET:OPEN [INFO] ALLOWED curl(1) -> b${index}.example.com:443`),
  );
  const first = await request("GET", target.logsPath("source=sandbox"));
  assert.equal(first.status, 200, first.text);
  assert.equal(first.data.records.length, 50);
  assert.ok(first.data.records.every((record) => record.type === "line"));

  gateway.state.lines.push(
    sandboxLine(8, "NET:OPEN [INFO] ALLOWED curl(1) -> new.example.com:443"),
  );
  const next = await request(
    "GET",
    target.logsPath(`source=sandbox&cursor=${encodeURIComponent(first.data.cursor)}`),
  );
  assert.equal(next.status, 200, next.text);
  assert.equal(gateway.requests.at(-1).sinceTime, lineTime(8));
  assert.deepEqual(
    next.data.records.map((record) => record.fields?.dst_host ?? record.reason),
    ["new.example.com"],
  );
});

test("sandbox follow reports a gap when one millisecond holds more lines than the cursor", async () => {
  const { gateway, target, request } = await sandboxFixture();
  gateway.state.lines = Array.from({ length: 60 }, (_, index) =>
    sandboxLine(8, `NET:OPEN [INFO] ALLOWED curl(1) -> o${index}.example.com:443`),
  );
  const first = await request("GET", target.logsPath("source=sandbox"));
  assert.equal(first.status, 200, first.text);
  const lines = first.data.records.filter((record) => record.type === "line");
  assert.equal(lines.length, 60);
  const gap = first.data.records.at(-1);
  assert.equal(gap.type, "gap");
  assert.equal(gap.reason, "window_exceeded");
  assert.equal(gap.time, lineTime(8));
  // The next read resumes strictly after that millisecond, so nothing is shown twice.
  const next = await request(
    "GET",
    target.logsPath(`source=sandbox&cursor=${encodeURIComponent(first.data.cursor)}`),
  );
  assert.equal(next.status, 200, next.text);
  assert.equal(gateway.requests.at(-1).sinceTime, lineTime(8, 1));
  assert.deepEqual(next.data.records, []);
  assert.ok(first.data.cursor.length <= 2048);
});

test("sandbox reads reject mixed Sandbox IDs, Pods and previous instances, and map denials", async () => {
  const { gateway, target, request, createPrincipal } = await sandboxFixture();
  gateway.state.lines = [
    sandboxLine(1, "NET:OPEN [INFO] ALLOWED curl(1) -> a.example.com:443"),
    sandboxLine(2, "NET:OPEN [INFO] ALLOWED curl(1) -> b.example.com:443", {
      sandboxId: "11111111-2222-4333-8444-555555555555",
    }),
  ];
  const mixed = await request("GET", target.logsPath("source=sandbox"));
  assert.equal(mixed.status, 503, mixed.text);
  assert.equal(mixed.body.error.code, "RUNTIME_LOGS_UNAVAILABLE");
  assert.equal(mixed.body.data, undefined, "a refused chunk returns no records");

  const pod = await request("GET", target.logsPath("source=sandbox&pod=gateway-x-0"));
  assert.equal(pod.status, 400, pod.text);
  assert.equal(pod.body.error.code, "RUNTIME_LOGS_POD_INVALID");
  const previous = await request("GET", target.logsPath("source=sandbox&previous=true"));
  assert.equal(previous.status, 400, previous.text);
  assert.equal(previous.body.error.code, "RUNTIME_LOGS_POD_INVALID");

  gateway.state.error = Object.assign(new Error("permission denied: missing sandbox:read"), {
    code: 7,
  });
  const denied = await request("GET", target.logsPath("source=sandbox"));
  assert.equal(denied.status, 503, denied.text);
  assert.equal(denied.body.error.code, "RUNTIME_LOGS_CLUSTER_RBAC");
  assert.equal(denied.text.includes("sandbox:read"), false, "gateway error text never leaks");

  // OpenShell answers NOT_FOUND both for an absent Sandbox and, to conceal it, for an
  // identity outside its Workspace. Neither is reported as an empty log.
  for (const message of ["sandbox not found", "sandbox not found (caller is not a member)"]) {
    gateway.state.error = Object.assign(new Error(message), { code: 5 });
    const missing = await request("GET", target.logsPath("source=sandbox"));
    assert.equal(missing.status, 503, missing.text);
    assert.equal(missing.body.error.code, "RUNTIME_LOGS_SANDBOX_NOT_FOUND");
    assert.equal(missing.body.data, undefined);
    assert.equal(missing.text.includes("member)"), false, "gateway error text never leaks");
  }
  gateway.state.error = undefined;

  // Sandbox text is tier 2 like container text: operate alone is not enough.
  const operator = await createPrincipal("sandbox-operator", target, operateGrants);
  const requestsBefore = gateway.requests.length;
  const forbidden = await request("GET", target.logsPath("source=sandbox"), {
    session: operator.session,
  });
  assert.equal(forbidden.status, 403, forbidden.text);
  assert.equal(gateway.requests.length, requestsBefore, "no read after a denial");
});

test("without a log-reading Sandbox Driver the sandbox source is absent", async () => {
  const fixture = await createRuntimeLogFixture();
  const target = await fixture.deployAgent("no-sandbox");
  const runtime = await fixture.request("GET", target.runtimePath);
  assert.equal(runtime.status, 200, runtime.text);
  assert.equal(
    runtime.data.sources.some(({ id }) => id === "sandbox"),
    false,
  );
  const logs = await fixture.request("GET", target.logsPath("source=sandbox"));
  assert.equal(logs.status, 400, logs.text);
  assert.equal(logs.body.error.code, "RUNTIME_LOGS_SOURCE_UNAVAILABLE");
});

test("the OpenShell log reader exposes GetSandboxLogs and nothing else", async () => {
  const client = new GrpcOpenShellGatewayClient({ endpoint: "127.0.0.1:1" });
  const reader = openShellSandboxLogReader(client);
  assert.deepEqual(Object.keys(reader), ["getSandboxLogs"]);
  assert.equal(Object.isFrozen(reader), true);
  for (const write of ["createSandbox", "deleteSandbox", "exec", "execSandbox", "createProvider"]) {
    assert.equal(write in reader, false, `${write} is not reachable through the reader`);
  }
  client.close();
});

test("the OpenShell Sandbox Driver reads logs only for its own revisions", async () => {
  const gateway = logOnlyGatewayClient();
  const driver = openShellSandboxDriver(gateway.client);
  const namespace = { id: "ns_1", name: SANDBOX_NAMESPACE, status: "ready", createdAt: "x" };
  const revision = {
    id: "rev_00000000-0000-4000-8000-000000000001",
    namespaceId: namespace.id,
    agentId: "agt_1",
    sandboxDriverId: driver.id,
  };
  const signal = AbortSignal.timeout(2_000);
  gateway.state.lines = [sandboxLine(1, "hello", { level: "INFO" })];
  const chunk = await driver.readSandboxLogs({ namespace, revision, signal }, { lines: 5 });
  assert.equal(chunk.sandbox, gateway.requests[0].sandbox);
  assert.equal(chunk.bufferTotal, 1);
  assert.equal(chunk.lines[0].message, "hello");

  await assert.rejects(
    driver.readSandboxLogs(
      { namespace, revision: { ...revision, sandboxDriverId: "another-sandbox" }, signal },
      { lines: 5 },
    ),
    /outside its selected AgentRevision/,
  );
  await assert.rejects(
    driver.readSandboxLogs(
      { namespace: { ...namespace, id: "ns_2" }, revision, signal },
      { lines: 5 },
    ),
    /outside its selected AgentRevision/,
  );
  gateway.state.error = Object.assign(new Error("unauthenticated"), { code: 16 });
  await assert.rejects(
    driver.readSandboxLogs({ namespace, revision, signal }, { lines: 5 }),
    RuntimeLogsForbiddenByClusterError,
  );
  assert.deepEqual([...new Set(gateway.touched)], ["getSandboxLogs"]);
});

test("sandbox sanitization masks credentials passed as command-line arguments", async () => {
  const { sanitizeSandboxLogLines } = await import("../../packages/occ/src/runtime-logs/index.ts");
  const secret = `Zx9${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const cases = [
    [`curl -u alice:${secret} https://a`, "curl -u [redacted:argv] https://a"],
    [`curl --user alice:${secret} https://a`, "curl --user [redacted:argv] https://a"],
    [`curl --user=alice:${secret} https://a`, "curl --user=[redacted:argv] https://a"],
    [`curl -ualice:${secret} https://a`, "curl -u[redacted:argv] https://a"],
    [`mysql -u root -p${secret}`, "mysql -u root -p[redacted:argv]"],
    [`mysql -u root -pab=${secret}`, "mysql -u root -p[redacted:argv]"],
    [`docker login -u bob -p ${secret}`, "docker login -u bob -p [redacted:argv]"],
    [`docker login -p '${secret} two' reg`, "docker login -p [redacted:argv] reg"],
    [`sshpass -p ${secret} ssh h`, "sshpass -p [redacted:argv] ssh h"],
    [`openssl enc -pass pass:${secret}`, "openssl enc -pass [redacted:argv]"],
    [`vault login -method=token ${secret}`, "vault login -method=token [redacted:argv]"],
    [`gh auth login --with-token ${secret}`, "gh auth login --with-token [redacted:argv]"],
    [
      `tool --username bob --pass ${secret}`,
      "tool --username [redacted:argv] --pass [redacted:argv]",
    ],
    [`curl --proxy-user alice:${secret} https://a`, "curl --proxy-user [redacted:argv] https://a"],
    [`curl -U alice:${secret} https://a`, "curl -U [redacted:argv] https://a"],
    [`smbclient //h/s -U alice%${secret}`, "smbclient //h/s -U [redacted:argv]"],
    [`smbclient //h/s -Ualice%${secret}`, "smbclient //h/s -U[redacted:argv]"],
    [`smbclient //h/s --user=alice%${secret}`, "smbclient //h/s --user=[redacted:argv]"],
    [`lftp -u alice,${secret} ftp.example.com`, "lftp -u [redacted:argv] ftp.example.com"],
    [`redis-cli -h r -a ${secret} ping`, "redis-cli -h r -a [redacted:argv] ping"],
    [`/usr/bin/redis-cli -a${secret}`, "/usr/bin/redis-cli -a[redacted:argv]"],
    [`sqlcmd -S db -U sa -P ${secret}`, "sqlcmd -S db -U sa -P [redacted:argv]"],
    // Ordinary flags that share a letter stay readable.
    ["ls -a /tmp", "ls -a /tmp"],
    ["cp -P a b", "cp -P a b"],
    ["psql -U postgres app", "psql -U postgres app"],
    ["date -u +%s", "date -u +%s"],
    ["lftp -u alice ftp.example.com", "lftp -u alice ftp.example.com"],
    ["mkdir -p /workspace/out", "mkdir -p /workspace/out"],
    ["find . -path ./x -print", "find . -path ./x -print"],
    ["pip install --user requests", "pip install --user requests"],
    ["sort -u names.txt", "sort -u names.txt"],
    ["gcc -pthread main.c", "gcc -pthread main.c"],
  ];
  for (const [command, expected] of cases) {
    // Extracted `[cmd:` field, and the fallback where the command stays in the message.
    const { records } = sanitizeSandboxLogLines({ source: "sandbox", sandbox: "sb-1" }, [
      sandboxLine(1, `PROC:LAUNCH [INFO] x(1) [cmd:${command}]`),
      sandboxLine(2, `PROC:LAUNCH [INFO] x(1) ${command}`),
      sandboxLine(3, "exec", { level: "INFO", target: "t", fields: { cmd_line: command } }),
    ]);
    assert.equal(records[0].fields.cmd_line, expected, command);
    assert.equal(records[1].message, `PROC:LAUNCH [INFO] x(1) ${expected}`, command);
    assert.equal(records[2].fields.cmd_line, expected, command);
    assert.equal(JSON.stringify(records).includes(secret), false, command);
  }
});

test("sandbox sanitization stays linear on hostile 32 KiB OCSF lines", async () => {
  const { sanitizeSandboxLogLines } = await import("../../packages/occ/src/runtime-logs/index.ts");
  const size = 32 * 1024 - 64;
  const hostile = [
    `PROC:LAUNCH [INFO] a(1)${" [cmd:".repeat(size / 6)}`,
    `PROC:LAUNCH [INFO] a(1)${" [cmd:".repeat(size / 6)}]`,
    `HTTP:GET [INFO] ALLOWED ${"-> A ".repeat(size / 5)}`,
    `NET:OPEN [INFO] ALLOWED ${"a(".repeat(size / 2)}`,
    `NET:OPEN [INFO] DENIED ${" [reason:".repeat(size / 9)}`,
    `HTTP:POST [HIGH] DENIED ${"[policy:x ".repeat(size / 10)}`,
    `PROC:LAUNCH [INFO] a(1) [cmd:${"-p '".repeat(size / 5)}]`,
    `PROC:LAUNCH [INFO] a(1) [cmd:vault login ${"a ".repeat(size / 2)}]`,
    `PROC:LAUNCH [INFO] a(1) ${"-u -p ".repeat(size / 6)}`,
  ];
  for (const message of hostile) {
    const started = performance.now();
    const { records } = sanitizeSandboxLogLines({ source: "sandbox", sandbox: "sb-1" }, [
      sandboxLine(1, message),
    ]);
    const elapsed = performance.now() - started;
    assert.equal(records.length, 1);
    assert.ok(elapsed < 250, `${message.slice(0, 24)} took ${elapsed.toFixed(0)} ms`);
  }
});
