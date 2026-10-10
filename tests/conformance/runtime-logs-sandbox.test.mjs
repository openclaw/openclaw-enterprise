import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import test from "node:test";

import { OpenShellGateway } from "../../apps/controller/src/backends/openshell.ts";
import {
  GrpcOpenShellGatewayClient,
  openShellSandboxLogReader,
  openShellSandboxObserver,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import {
  harnessObservation,
  OpenShellSandboxDriver,
} from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import { RuntimeLogsForbiddenByClusterError } from "../../packages/occ/src/index.ts";
import { cpuTimeMs } from "../helpers/cpu-time.mjs";
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
 * A gateway client that only answers the reads `GetSandboxLogs` and `GetSandbox` (from
 * `state.sandbox`, absent by default). Every other member is recorded and fails.
 */
function logOnlyGatewayClient() {
  const state = {
    lines: [],
    bufferTotal: undefined,
    error: undefined,
    sandbox: undefined,
    sandboxError: undefined,
  };
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
  target.getSandbox = async (request, signal) => {
    assert.ok(signal instanceof AbortSignal);
    requests.push({ getSandbox: structuredClone(request) });
    if (state.sandboxError !== undefined) {
      throw state.sandboxError;
    }
    return state.sandbox;
  };
  const client = new Proxy(target, {
    get(object, property) {
      if (typeof property === "string") {
        touched.push(property);
      }
      if (property === "getSandboxLogs" || property === "getSandbox") {
        return object[property];
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

async function sandboxFixture(options = {}) {
  const gateway = logOnlyGatewayClient();
  const computeDriver = createRuntimeLogComputeDriver({ sandboxNamespace: SANDBOX_NAMESPACE });
  const sandboxDriver = openShellSandboxDriver(gateway.client);
  if (options.sandboxName !== undefined) {
    const read = sandboxDriver.readSandboxLogs.bind(sandboxDriver);
    // Exercise the core's accepted Driver identity width without replacing paging.
    sandboxDriver.readSandboxLogs = async (...args) => ({
      ...(await read(...args)),
      sandbox: options.sandboxName,
    });
  }
  const fixture = await createRuntimeLogFixture({
    computeDriver,
    sandboxDriver,
    ...(options.cursorSecret === undefined
      ? {}
      : { agentRuntimeLogs: { enabled: true, cursorSecret: options.cursorSecret } }),
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
  // Describing the runtime reads only the Sandbox record, for its Harness lifecycle.
  assert.deepEqual([...new Set(gateway.touched)], ["getSandbox"]);
  gateway.touched.length = 0;
  gateway.requests.length = 0;

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

test("sandbox follow after an empty first window reads no older lines", async () => {
  const { gateway, target, request } = await sandboxFixture();
  // Policy decisions from long before the requested window.
  gateway.state.lines = [
    sandboxLine(1, "NET:OPEN [INFO] ALLOWED curl(1) -> a.example.com:443"),
    sandboxLine(2, "NET:OPEN [INFO] ALLOWED curl(1) -> b.example.com:443"),
  ];
  const first = await request("GET", target.logsPath("source=sandbox&sinceSeconds=60"));
  assert.equal(first.status, 200, first.text);
  assert.deepEqual(first.data.records, []);
  const windowStart = gateway.requests.at(-1).sinceTime;
  assert.ok(windowStart);
  // `occ agent logs --follow` polls send only the cursor.
  const next = await request(
    "GET",
    target.logsPath(`source=sandbox&cursor=${encodeURIComponent(first.data.cursor)}`),
  );
  assert.equal(next.status, 200, next.text);
  assert.deepEqual(next.data.records, []);
  assert.equal(gateway.requests.at(-1).sinceTime, windowStart);
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

test("a lost OpenShell Harness Sandbox is reported by the runtime description and diagnostics", async () => {
  const gateway = logOnlyGatewayClient();
  const computeDriver = createRuntimeLogComputeDriver({ sandboxNamespace: SANDBOX_NAMESPACE });
  const computeChecks = [
    {
      component: "agent",
      check: "runtime-status",
      state: "unknown",
      checkedAt: null,
      code: "UNAVAILABLE",
    },
  ];
  computeDriver.diagnoseAgentDeployment = async (binding) => ({
    revisionId: binding.revision.id,
    observedAt: new Date().toISOString(),
    checks: computeChecks,
  });
  const fixture = await createRuntimeLogFixture({
    computeDriver,
    sandboxDriver: openShellSandboxDriver(gateway.client),
  });
  const target = await fixture.deployAgent("harness-lost");
  const diagnosticsPath = target.runtimePath.replace(/\/runtime$/, "/diagnostics");
  const record = (phase, revisionId = target.revisionId) => ({
    name: "sb-x",
    labels: {},
    annotations: { "openclaw.dev/revision-id": revisionId },
    serviceUrls: {},
    phase,
  });
  // Before activation the revision is a candidate that may not have its Sandbox yet.
  gateway.state.sandbox = undefined;
  const candidate = await fixture.request("GET", target.runtimePath);
  assert.equal(candidate.status, 200, candidate.text);
  assert.deepEqual(candidate.data.harness, { state: "unknown" });
  // A terminal record is OpenShell's own state, reported for any revision (a failed candidate).
  gateway.state.sandbox = record("SANDBOX_PHASE_COMPLETED");
  const exited = await fixture.request("GET", target.runtimePath);
  assert.equal(exited.status, 200, exited.text);
  assert.deepEqual(exited.data.harness, { state: "lost", code: "HARNESS_EXITED" });
  await fixture.activate(target);

  // The full phase table is unit-tested below; the routes are checked on representative
  // records, under the per-Agent runtime route rate limit.
  for (const [sandbox, harness, check] of [
    [record("SANDBOX_PHASE_READY"), { state: "running" }, { state: "succeeded" }],
    // A deleted or evicted Pod (dogfood d2) and a Harness that exited 0 under a live supervisor (d3).
    [
      record("SANDBOX_PHASE_ERROR"),
      { state: "lost", code: "SANDBOX_FAILED" },
      { state: "failed", code: "SANDBOX_FAILED" },
    ],
    [
      record("SANDBOX_PHASE_COMPLETED"),
      { state: "lost", code: "HARNESS_EXITED" },
      { state: "failed", code: "HARNESS_EXITED" },
    ],
    [
      undefined,
      { state: "lost", code: "SANDBOX_MISSING" },
      { state: "failed", code: "SANDBOX_MISSING" },
    ],
    [
      record("SANDBOX_PHASE_STARTING"),
      { state: "starting" },
      { state: "unknown", code: "STARTING" },
    ],
    // A record another revision owns under this name is refused, not trusted.
    [
      record("SANDBOX_PHASE_READY", "rev_00000000-0000-4000-8000-0000000000ff"),
      { state: "unknown", code: "UNAVAILABLE" },
      { state: "unknown", code: "UNAVAILABLE" },
    ],
  ]) {
    gateway.state.sandbox = sandbox;
    const runtime = await fixture.request("GET", target.runtimePath);
    assert.equal(runtime.status, 200, runtime.text);
    assert.deepEqual(runtime.data.harness, harness, JSON.stringify(sandbox));
    const diagnostics = await fixture.request("POST", diagnosticsPath);
    assert.equal(diagnostics.status, 200, diagnostics.text);
    const [first, ...rest] = diagnostics.data.checks;
    assert.deepEqual(
      { ...first, checkedAt: undefined },
      { component: "agent", check: "sandbox", checkedAt: undefined, ...check },
      JSON.stringify(sandbox),
    );
    assert.match(first.checkedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.deepEqual(rest, computeChecks);
  }
  const read = gateway.requests.find((request) => request.getSandbox !== undefined).getSandbox;
  assert.equal(read.workspace, SANDBOX_NAMESPACE);
  assert.match(read.name, /^sb-[0-9a-f]+$/);

  // An unreadable record is unknown; the gateway's error text never reaches the caller.
  gateway.state.sandboxError = Object.assign(new Error("permission denied: sandbox:read secret"), {
    code: 7,
  });
  const runtime = await fixture.request("GET", target.runtimePath);
  assert.equal(runtime.status, 200, runtime.text);
  assert.deepEqual(runtime.data.harness, { state: "unknown", code: "UNAVAILABLE" });
  assert.equal(runtime.text.includes("sandbox:read"), false);
  const diagnostics = await fixture.request("POST", diagnosticsPath);
  assert.equal(diagnostics.status, 200, diagnostics.text);
  assert.equal(diagnostics.data.checks[0].code, "UNAVAILABLE");
  assert.equal(diagnostics.text.includes("sandbox:read"), false);

  // The lead check never pushes the description past the 32-check cap.
  gateway.state.sandboxError = undefined;
  gateway.state.sandbox = record("SANDBOX_PHASE_ERROR");
  computeChecks.splice(
    0,
    computeChecks.length,
    ...Array.from({ length: 32 }, (_, index) => ({
      component: "gateway",
      check: `check-${index}`,
      state: "succeeded",
      checkedAt: null,
    })),
  );
  const capped = await fixture.request("POST", diagnosticsPath);
  assert.equal(capped.status, 200, capped.text);
  assert.equal(capped.data.checks.length, 32);
  assert.equal(capped.data.checks[0].code, "SANDBOX_FAILED");
  // A stopped Agent's Sandbox is removed by design; its absence is not a lost Harness.
  gateway.state.sandbox = undefined;
  const stop = await fixture.request(
    "POST",
    `/namespaces/${target.namespace.id}/agents/${target.agent.id}/stop`,
  );
  assert.equal(stop.status, 202, stop.text);
  const stopped = await fixture.request("GET", target.runtimePath);
  assert.equal(stopped.status, 200, stopped.text);
  assert.deepEqual(stopped.data.harness, { state: "unknown" });
  const stoppedDiagnostics = await fixture.request("POST", diagnosticsPath);
  assert.equal(stoppedDiagnostics.status, 200, stoppedDiagnostics.text);
  assert.deepEqual(
    { ...stoppedDiagnostics.data.checks[0], checkedAt: undefined },
    { component: "agent", check: "sandbox", state: "unknown", checkedAt: undefined },
  );

  // Observation reads only; nothing else in OpenShell was touched.
  assert.deepEqual([...new Set(gateway.touched)], ["getSandbox"]);
});

test("a crash-looping OpenShell Harness is reported as restarting, not starting", async () => {
  const gateway = logOnlyGatewayClient();
  const computeDriver = createRuntimeLogComputeDriver({ sandboxNamespace: SANDBOX_NAMESPACE });
  computeDriver.diagnoseAgentDeployment = async (binding) => ({
    revisionId: binding.revision.id,
    observedAt: new Date().toISOString(),
    checks: [],
  });
  const sandboxDriver = openShellSandboxDriver(gateway.client);
  const fixture = await createRuntimeLogFixture({ computeDriver, sandboxDriver });
  const target = await fixture.deployAgent("harness-restarting");
  await fixture.activate(target);
  const diagnosticsPath = target.runtimePath.replace(/\/runtime$/, "/diagnostics");
  const starting = (restart) => ({
    name: "sb-x",
    labels: {},
    annotations: { "openclaw.dev/revision-id": target.revisionId },
    serviceUrls: {},
    phase: "SANDBOX_PHASE_STARTING",
    ...restart,
  });
  for (const [sandbox, harness, check] of [
    // Restart policy ALWAYS, in backoff after the Harness was killed (finding 1043).
    [
      starting({ exitCode: 137, restartCount: 4 }),
      { state: "starting", code: "HARNESS_RESTARTING", exitCode: 137, restarts: 4 },
      { state: "failed", code: "HARNESS_RESTARTING" },
    ],
    // A first start stays `starting`.
    [starting({}), { state: "starting" }, { state: "unknown", code: "STARTING" }],
    // OCC reports only a 32-bit exit code; anything else reads as a plain start.
    [
      starting({ exitCode: 2 ** 40, restartCount: 2 }),
      { state: "starting" },
      { state: "unknown", code: "STARTING" },
    ],
  ]) {
    gateway.state.sandbox = sandbox;
    const runtime = await fixture.request("GET", target.runtimePath);
    assert.equal(runtime.status, 200, runtime.text);
    assert.deepEqual(runtime.data.harness, harness, JSON.stringify(sandbox));
    const diagnostics = await fixture.request("POST", diagnosticsPath);
    assert.equal(diagnostics.status, 200, diagnostics.text);
    assert.deepEqual(
      { ...diagnostics.data.checks[0], checkedAt: undefined },
      { component: "agent", check: "sandbox", checkedAt: undefined, ...check },
      JSON.stringify(sandbox),
    );
  }

  // OCC bounds what any Sandbox Driver reports: a malformed restart reads as a plain start.
  // A second Agent keeps these reads under the per-Agent runtime route rate limit.
  const other = await fixture.deployAgent("harness-malformed");
  await fixture.activate(other);
  const restart = (exitCode, restarts) =>
    Object.freeze({ state: "starting", code: "HARNESS_RESTARTING", exitCode, restarts });
  for (const observed of [
    restart(1, 0),
    restart(1, 1.5),
    restart(1, "3"),
    restart(1, 2 ** 32),
    restart(-(2 ** 31) - 1, 1),
    { state: "starting", code: "HARNESS_RESTARTING" },
  ]) {
    sandboxDriver.observeHarness = async () => observed;
    const runtime = await fixture.request("GET", other.runtimePath);
    assert.equal(runtime.status, 200, runtime.text);
    assert.deepEqual(runtime.data.harness, { state: "starting" }, JSON.stringify(observed));
  }
  // A negative exit code within int32 is reported as is.
  sandboxDriver.observeHarness = async () => restart(-1, 2);
  const negative = await fixture.request("GET", other.runtimePath);
  assert.equal(negative.status, 200, negative.text);
  assert.deepEqual(negative.data.harness, restart(-1, 2));
});

test("OpenShell Sandbox phases map to a Harness observation by name and number", () => {
  for (const [phases, expected] of [
    [["SANDBOX_PHASE_READY", 2], { state: "running" }],
    [["SANDBOX_PHASE_PROVISIONING", 1, "SANDBOX_PHASE_STARTING", 8], { state: "starting" }],
    [["SANDBOX_PHASE_ERROR", 3], { state: "lost", code: "SANDBOX_FAILED" }],
    [["SANDBOX_PHASE_DELETING", 4], { state: "lost", code: "SANDBOX_DELETING" }],
    [
      ["SANDBOX_PHASE_STOPPING", 6, "SANDBOX_PHASE_STOPPED", 7],
      { state: "lost", code: "SANDBOX_STOPPED" },
    ],
    [["SANDBOX_PHASE_COMPLETED", 9], { state: "lost", code: "HARNESS_EXITED" }],
    [
      ["SANDBOX_PHASE_UNKNOWN", 5, "SANDBOX_PHASE_UNSPECIFIED", 0, undefined, "NEW"],
      { state: "unknown" },
    ],
  ]) {
    for (const phase of phases) {
      assert.deepEqual(
        harnessObservation(phase === undefined ? {} : { phase }),
        expected,
        String(phase),
      );
    }
  }
  assert.deepEqual(harnessObservation(undefined), { state: "lost", code: "SANDBOX_MISSING" });
});

test("a Harness the gateway restarts is told apart from a first start", () => {
  // OpenShell keeps the exited process's code and a restart number while STARTING a policy
  // restart, and clears both once the replacement is ready or an operator restarts it.
  for (const phase of ["SANDBOX_PHASE_STARTING", 8]) {
    assert.deepEqual(harnessObservation({ phase, exitCode: 1, restartCount: 1 }), {
      state: "starting",
      code: "HARNESS_RESTARTING",
      exitCode: 1,
      restarts: 1,
    });
    assert.deepEqual(harnessObservation({ phase, exitCode: 0, restartCount: 7 }), {
      state: "starting",
      code: "HARNESS_RESTARTING",
      exitCode: 0,
      restarts: 7,
    });
  }
  for (const record of [
    { phase: "SANDBOX_PHASE_STARTING" },
    { phase: "SANDBOX_PHASE_STARTING", exitCode: 1 },
    { phase: "SANDBOX_PHASE_STARTING", restartCount: 2 },
    { phase: "SANDBOX_PHASE_PROVISIONING", exitCode: 1, restartCount: 2 },
  ]) {
    assert.deepEqual(harnessObservation(record), { state: "starting" }, JSON.stringify(record));
  }
  // A replacement that became ready keeps its restart number but no exit code.
  assert.deepEqual(harnessObservation({ phase: "SANDBOX_PHASE_READY", restartCount: 3 }), {
    state: "running",
  });
  // A terminal record wins over restart state.
  assert.deepEqual(
    harnessObservation({ phase: "SANDBOX_PHASE_ERROR", exitCode: 1, restartCount: 3 }),
    { state: "lost", code: "SANDBOX_FAILED" },
  );
});

test("the OpenShell Sandbox Driver observes only its own dedicated revisions", async () => {
  const gateway = logOnlyGatewayClient();
  const driver = openShellSandboxDriver(gateway.client);
  const namespace = { id: "ns_1", name: SANDBOX_NAMESPACE, status: "ready", createdAt: "x" };
  const revision = {
    id: "rev_00000000-0000-4000-8000-000000000001",
    namespaceId: namespace.id,
    agentId: "agt_1",
    sandboxDriverId: driver.id,
    harness: { id: "codex", mode: "dedicated" },
  };
  const signal = AbortSignal.timeout(2_000);
  for (const context of [
    { namespace, revision: { ...revision, sandboxDriverId: "another-sandbox" }, signal },
    { namespace: { ...namespace, id: "ns_2" }, revision, signal },
    { namespace, revision: { ...revision, harness: { id: "openclaw", mode: "embedded" } }, signal },
  ]) {
    await assert.rejects(driver.observeHarness(context), /outside its selected dedicated/);
  }
  assert.deepEqual(gateway.requests, [], "a refused observation reads nothing");
  gateway.state.sandbox = {
    name: "sb-x",
    labels: {},
    annotations: { "openclaw.dev/revision-id": revision.id },
    serviceUrls: {},
    phase: "SANDBOX_PHASE_COMPLETED",
  };
  assert.deepEqual(await driver.observeHarness({ namespace, revision, signal }), {
    state: "lost",
    code: "HARNESS_EXITED",
  });
  assert.deepEqual([...new Set(gateway.touched)], ["getSandbox"]);
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
  assert.equal("harness" in runtime.data, false, "an embedded Agent has no Harness Sandbox");
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

test("the OpenShell Sandbox observer exposes GetSandbox and nothing else", async () => {
  const client = new GrpcOpenShellGatewayClient({ endpoint: "127.0.0.1:1" });
  const observer = openShellSandboxObserver(client);
  assert.deepEqual(Object.keys(observer), ["getSandbox"]);
  assert.equal(Object.isFrozen(observer), true);
  for (const write of ["createSandbox", "deleteSandbox", "execSandbox", "getSandboxLogs"]) {
    assert.equal(write in observer, false, `${write} is not reachable through the observer`);
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
  const budgetMs = 250;
  for (const message of hostile) {
    let records;
    const elapsed = cpuTimeMs(
      () => {
        ({ records } = sanitizeSandboxLogLines({ source: "sandbox", sandbox: "sb-1" }, [
          sandboxLine(1, message),
        ]));
      },
      { budgetMs },
    );
    assert.equal(records.length, 1);
    assert.ok(elapsed < budgetMs, `${message.slice(0, 24)} took ${elapsed.toFixed(0)} ms of CPU`);
  }
});

test("sandbox wire pages include escaped diagnostics and resume without losing records", async () => {
  const fixture = await sandboxFixture();
  const started = Date.now() - 1000;
  fixture.gateway.state.lines = Array.from({ length: 200 }, (_, index) => ({
    sandboxId: SANDBOX_ID,
    time: new Date(started + index).toISOString(),
    level: "INFO",
    target: "supervisor",
    source: "sandbox",
    message: `row=${index}; 网络🙂 process arguments: ${'--option="value" '.repeat(500)}`,
    fields: {},
  }));
  const seen = [];
  let cursor;
  let pages = 0;
  do {
    const response = await fixture.request(
      "GET",
      fixture.target.logsPath(
        `source=sandbox&tailLines=200${cursor === undefined ? "" : `&cursor=${cursor}`}`,
      ),
    );
    assert.equal(response.status, 200, response.text.slice(0, 200));
    assert.equal(response.body.meta.requestId.length, 40);
    assert.equal(
      Buffer.byteLength(response.text, "utf8"),
      Buffer.byteLength(JSON.stringify(response.body), "utf8"),
    );
    assert.ok(Buffer.byteLength(response.text, "utf8") <= 512 * 1024);
    const lines = response.data.records.filter(({ type }) => type === "line");
    if (pages === 0) {
      assert.equal(response.data.truncated, true);
    }
    seen.push(...lines.map(({ message }) => Number(/^row=(\d+);/.exec(message)[1])));
    cursor = response.data.cursor;
    pages += 1;
    if (!response.data.truncated) {
      break;
    }
    assert.ok(lines.length > 0, "a byte-cut page must advance");
  } while (pages < 10);
  assert.deepEqual(
    seen,
    Array.from({ length: 200 }, (_, index) => index),
  );
  const replay = await fixture.request(
    "GET",
    fixture.target.logsPath(`source=sandbox&cursor=${cursor}`),
  );
  assert.deepEqual(
    replay.data.records.filter(({ type }) => type === "line"),
    [],
  );
  assert.equal(
    fixture.gateway.requests.length,
    pages + 1,
    "prefix builds make no extra gateway reads",
  );
  assert.equal(
    fixture.auditSink.events.filter(({ action }) => action === "openclaw.agents.runtime_logs.view")
      .length,
    1,
  );
  const download = await fixture.request(
    "GET",
    fixture.target.logsPath("source=sandbox&download=true"),
  );
  assert.equal(download.status, 200);
  assert.ok(Buffer.byteLength(download.text, "utf8") <= 512 * 1024);
});

test("sandbox wire budgeting handles empty, single and grouped withheld pages", async () => {
  const fixture = await sandboxFixture();
  const started = Date.now() - 1000;
  const row = (message, index = 0) => ({
    sandboxId: SANDBOX_ID,
    time: new Date(started + index).toISOString(),
    level: "INFO",
    target: "supervisor",
    source: "sandbox",
    message,
    fields: {},
  });
  for (const lines of [[], [row(`single 网络🙂 ${'--option="value" '.repeat(500)}`)]]) {
    fixture.gateway.state.lines = lines;
    const response = await fixture.request(
      "GET",
      fixture.target.logsPath("source=sandbox&tailLines=200"),
    );
    assert.equal(response.status, 200);
    assert.equal(response.data.truncated, false);
    assert.equal(response.data.records.filter(({ type }) => type === "line").length, lines.length);
    assert.ok(Buffer.byteLength(response.text, "utf8") <= 512 * 1024);
  }
  fixture.gateway.state.lines = Array.from({ length: 80 }, (_, index) =>
    row(JSON.stringify({ ordinary_metadata: "diagnostic ".repeat(900) }), index),
  );
  const withheld = await fixture.request(
    "GET",
    fixture.target.logsPath("source=sandbox&tailLines=200"),
  );
  assert.equal(withheld.status, 200);
  assert.equal(withheld.data.truncated, false);
  assert.equal(withheld.data.withheld, 80);
  assert.equal(withheld.data.records.filter(({ type }) => type === "withheld")[0].count, 80);
  assert.ok(Buffer.byteLength(withheld.text, "utf8") <= 512 * 1024);
  const replay = await fixture.request(
    "GET",
    fixture.target.logsPath(`source=sandbox&cursor=${withheld.data.cursor}`),
  );
  assert.deepEqual(
    replay.data.records.filter(({ type }) => type === "line" || type === "withheld"),
    [],
  );
});

test("sandbox wire-cut timestamp groups drain before advancing beyond their time", async () => {
  const fixture = await sandboxFixture();
  const time = new Date(Date.now() - 1000).toISOString().replace("Z", "000000Z");
  fixture.gateway.state.lines = Array.from({ length: 150 }, (_, index) => ({
    sandboxId: SANDBOX_ID,
    time,
    level: "INFO",
    target: "supervisor",
    source: "sandbox",
    message: `row=${index}; quoted diagnostic ${'"a" '.repeat(1000)}`,
    fields: {},
  }));
  const seen = [];
  let cursor;
  for (let page = 0; page < 10; page += 1) {
    const response = await fixture.request(
      "GET",
      fixture.target.logsPath(
        `source=sandbox&tailLines=200${cursor === undefined ? "" : `&cursor=${cursor}`}`,
      ),
    );
    assert.equal(response.status, 200);
    assert.ok(Buffer.byteLength(response.text, "utf8") <= 512 * 1024);
    const lines = response.data.records.filter(({ type }) => type === "line");
    seen.push(...lines.map(({ message }) => Number(/^row=(\d+);/.exec(message)[1])));
    cursor = response.data.cursor;
    if (!response.data.truncated) {
      break;
    }
    assert.ok(lines.length > 0);
  }
  assert.deepEqual(
    seen,
    Array.from({ length: 150 }, (_, index) => index),
  );
  const replay = await fixture.request(
    "GET",
    fixture.target.logsPath(`source=sandbox&tailLines=200&cursor=${cursor}`),
  );
  assert.deepEqual(
    replay.data.records.filter(({ type }) => type === "line"),
    [],
  );
});

test("sandbox wire-cut prefixes without timestamps drain and suppress an unchanged snapshot", async () => {
  const fixture = await sandboxFixture();
  fixture.gateway.state.lines = Array.from({ length: 150 }, (_, index) => ({
    sandboxId: SANDBOX_ID,
    time: null,
    level: "INFO",
    target: "supervisor",
    source: "sandbox",
    message: `row=${index}; quoted diagnostic ${'"a" '.repeat(1000)}`,
    fields: {},
  }));
  const seen = [];
  let cursor;
  for (let page = 0; page < 10; page += 1) {
    const response = await fixture.request(
      "GET",
      fixture.target.logsPath(
        `source=sandbox&tailLines=200${cursor === undefined ? "" : `&cursor=${cursor}`}`,
      ),
    );
    assert.equal(response.status, 200);
    assert.ok(Buffer.byteLength(response.text, "utf8") <= 512 * 1024);
    const lines = response.data.records.filter(({ type }) => type === "line");
    seen.push(...lines.map(({ message }) => Number(/^row=(\d+);/.exec(message)[1])));
    cursor = response.data.cursor;
    if (!response.data.truncated) {
      break;
    }
    assert.ok(lines.length > 0);
  }
  assert.deepEqual(
    seen,
    Array.from({ length: 150 }, (_, index) => index),
  );
  const replay = await fixture.request(
    "GET",
    fixture.target.logsPath(`source=sandbox&tailLines=200&cursor=${cursor}`),
  );
  assert.deepEqual(
    replay.data.records.filter(({ type }) => type === "line"),
    [],
  );
});

test("sandbox byte-window checkpoints preserve the pre-cut overlap baseline", async () => {
  const fixture = await sandboxFixture();
  const time = new Date(Date.now() - 1000).toISOString().replace("Z", "000000Z");
  const anchor = {
    sandboxId: SANDBOX_ID,
    time,
    level: "INFO",
    target: "supervisor",
    source: "sandbox",
    message: "prior diagnostic",
    fields: {},
  };
  fixture.gateway.state.lines = [anchor];
  const initial = await fixture.request(
    "GET",
    fixture.target.logsPath("source=sandbox&tailLines=200"),
  );
  const later = new Date(Date.parse(time) + 1).toISOString().replace("Z", "000000Z");
  fixture.gateway.state.lines = [
    anchor,
    ...Array.from({ length: 150 }, (_, index) => ({
      ...anchor,
      time: later,
      message: `row=${index}; quoted diagnostic ${'"a" '.repeat(1000)}`,
    })),
  ];
  const seen = [];
  let cursor = initial.data.cursor;
  for (let page = 0; page < 10; page += 1) {
    const response = await fixture.request(
      "GET",
      fixture.target.logsPath(`source=sandbox&tailLines=200&cursor=${cursor}`),
    );
    assert.equal(response.status, 200);
    const lines = response.data.records.filter(({ type }) => type === "line");
    assert.ok(lines.every(({ message }) => message !== "prior diagnostic"));
    seen.push(...lines.map(({ message }) => Number(/^row=(\d+);/.exec(message)[1])));
    cursor = response.data.cursor;
    if (!response.data.truncated) {
      break;
    }
  }
  assert.deepEqual(
    seen,
    Array.from({ length: 150 }, (_, index) => index),
  );
});

test("sandbox byte-window changes report a gap before a fresh value snapshot", async () => {
  for (const changed of ["prefix", "clipped size", "query tail"]) {
    const fixture = await sandboxFixture();
    const row = (index) => ({
      sandboxId: SANDBOX_ID,
      time: null,
      level: "INFO",
      target: "supervisor",
      source: "sandbox",
      message: `row=${index}; quoted diagnostic ${'"a" '.repeat(1000)}`,
      fields: {},
    });
    fixture.gateway.state.lines = Array.from({ length: 150 }, (_, index) => row(index));
    const tail = changed === "clipped size" ? 100 : 200;
    const first = await fixture.request(
      "GET",
      fixture.target.logsPath(`source=sandbox&tailLines=${tail}`),
    );
    assert.equal(first.data.truncated, true);
    if (changed === "prefix") {
      fixture.gateway.state.lines[0] = {
        ...row(0),
        message: `changed row=0; ${'"a" '.repeat(1000)}`,
      };
    }
    if (changed === "clipped size") {
      fixture.gateway.state.lines.splice(99);
    }
    const next = await fixture.request(
      "GET",
      fixture.target.logsPath(
        `source=sandbox&tailLines=${changed === "query tail" ? 100 : tail}&cursor=${first.data.cursor}`,
      ),
    );
    assert.equal(next.status, 200);
    assert.ok(Buffer.byteLength(next.text, "utf8") <= 512 * 1024);
    assert.ok(
      next.data.records.some(
        ({ type, reason }) => type === "gap" && ["buffer_lost", "window_exceeded"].includes(reason),
      ),
      changed,
    );
    assert.ok(
      next.data.records.some(({ type }) => type === "line"),
      changed,
    );
  }
});

test("sandbox byte-window checkpoints notice changes to an undelivered suffix", async () => {
  const fixture = await sandboxFixture();
  const row = (index) => ({
    sandboxId: SANDBOX_ID,
    time: null,
    level: "INFO",
    target: "supervisor",
    source: "sandbox",
    message: `row=${index}; quoted diagnostic ${'"a" '.repeat(1000)}`,
    fields: {},
  });
  fixture.gateway.state.lines = Array.from({ length: 150 }, (_, index) => row(index));
  const first = await fixture.request(
    "GET",
    fixture.target.logsPath("source=sandbox&tailLines=200"),
  );
  fixture.gateway.state.lines[149] = {
    ...row(149),
    message: `changed suffix; ${'"a" '.repeat(1000)}`,
  };
  const next = await fixture.request(
    "GET",
    fixture.target.logsPath(`source=sandbox&tailLines=200&cursor=${first.data.cursor}`),
  );
  assert.equal(next.status, 200);
  assert.ok(
    next.data.records.some(({ type, reason }) => type === "gap" && reason === "buffer_lost"),
  );
});

test("sandbox fitting untimed replacement snapshots retain replay progress", async () => {
  for (const changed of ["tail", "buffer"]) {
    const fixture = await sandboxFixture();
    fixture.gateway.state.lines = Array.from({ length: 150 }, (_, index) => ({
      sandboxId: SANDBOX_ID,
      time: null,
      level: "INFO",
      target: "supervisor",
      source: "sandbox",
      message: `row=${index}; quoted diagnostic ${'"a" '.repeat(1000)}`,
      fields: {},
    }));
    const first = await fixture.request(
      "GET",
      fixture.target.logsPath("source=sandbox&tailLines=200"),
    );
    assert.equal(first.data.truncated, true);
    if (changed === "buffer") {
      fixture.gateway.state.lines.splice(25);
    }
    const tail = changed === "tail" ? 25 : 200;
    const replacement = await fixture.request(
      "GET",
      fixture.target.logsPath(`source=sandbox&tailLines=${tail}&cursor=${first.data.cursor}`),
    );
    assert.equal(replacement.status, 200);
    assert.equal(replacement.data.truncated, false);
    assert.ok(
      replacement.data.records.some(
        ({ type, reason }) => type === "gap" && ["buffer_lost", "window_exceeded"].includes(reason),
      ),
    );
    assert.equal(replacement.data.records.filter(({ type }) => type === "line").length, 25);
    const replay = await fixture.request(
      "GET",
      fixture.target.logsPath(`source=sandbox&tailLines=${tail}&cursor=${replacement.data.cursor}`),
    );
    assert.equal(replay.status, 200);
    assert.deepEqual(
      replay.data.records.filter(({ type }) => type === "line"),
      [],
      changed,
    );
  }
});

test("sandbox full untimed checkpoints disclose saturation when total equals the tail", async () => {
  const fixture = await sandboxFixture();
  fixture.gateway.state.lines = Array.from({ length: 150 }, (_, index) => ({
    sandboxId: SANDBOX_ID,
    time: null,
    level: "INFO",
    target: "supervisor",
    source: "sandbox",
    message: `row=${index}; diagnostic ${'"a" '.repeat(1000)}`,
    fields: {},
  }));
  const seen = [];
  let cursor;
  for (let page = 0; page < 10; page += 1) {
    const response = await fixture.request(
      "GET",
      fixture.target.logsPath(
        `source=sandbox&tailLines=100${cursor === undefined ? "" : `&cursor=${cursor}`}`,
      ),
    );
    assert.equal(response.status, 200);
    assert.ok(
      response.data.records.some(
        ({ type, reason }) => type === "gap" && reason === "window_exceeded",
      ),
    );
    seen.push(
      ...response.data.records
        .filter(({ type }) => type === "line")
        .map(({ message }) => Number(/^row=(\d+);/.exec(message)[1])),
    );
    cursor = response.data.cursor;
    if (!response.data.truncated) {
      break;
    }
  }
  assert.deepEqual(
    seen,
    Array.from({ length: 100 }, (_, i) => i + 50),
  );
  const replay = await fixture.request(
    "GET",
    fixture.target.logsPath(`source=sandbox&tailLines=100&cursor=${cursor}`),
  );
  assert.equal(replay.data.records.filter(({ type }) => type === "line").length, 0);
  assert.ok(
    replay.data.records.some(({ type, reason }) => type === "gap" && reason === "window_exceeded"),
  );
});

test("sandbox empty checkpoint recovery suppresses the next single untimed snapshot", async () => {
  const fixture = await sandboxFixture();
  fixture.gateway.state.lines = Array.from({ length: 150 }, (_, index) => ({
    sandboxId: SANDBOX_ID,
    time: null,
    level: "INFO",
    target: "supervisor",
    source: "sandbox",
    message: `row=${index}; ${'"a" '.repeat(1000)}`,
    fields: {},
  }));
  const first = await fixture.request(
    "GET",
    fixture.target.logsPath("source=sandbox&tailLines=200"),
  );
  assert.equal(first.data.truncated, true);
  fixture.gateway.state.lines = [];
  const empty = await fixture.request(
    "GET",
    fixture.target.logsPath(`source=sandbox&cursor=${first.data.cursor}`),
  );
  assert.equal(empty.status, 200);
  assert.ok(
    empty.data.records.some(({ type, reason }) => type === "gap" && reason === "buffer_lost"),
  );
  fixture.gateway.state.lines = [
    {
      sandboxId: SANDBOX_ID,
      time: null,
      level: "INFO",
      target: "supervisor",
      source: "sandbox",
      message: "worker ready",
      fields: {},
    },
  ];
  const single = await fixture.request(
    "GET",
    fixture.target.logsPath(`source=sandbox&cursor=${empty.data.cursor}`),
  );
  assert.equal(single.data.records.filter(({ type }) => type === "line").length, 1);
  const replay = await fixture.request(
    "GET",
    fixture.target.logsPath(`source=sandbox&cursor=${single.data.cursor}`),
  );
  assert.equal(replay.data.records.filter(({ type }) => type === "line").length, 0);
});

test("sandbox full timed checkpoints retain their gap through final drain below hash capacity", async () => {
  const fixture = await sandboxFixture();
  fixture.gateway.state.lines = Array.from({ length: 40 }, () =>
    sandboxLine(1, `same diagnostic ${'"'.repeat(8000)}`),
  );
  const first = await fixture.request(
    "GET",
    fixture.target.logsPath("source=sandbox&tailLines=40"),
  );
  assert.equal(first.status, 200);
  assert.equal(first.data.truncated, true);
  const last = await fixture.request(
    "GET",
    fixture.target.logsPath(`source=sandbox&tailLines=40&cursor=${first.data.cursor}`),
  );
  assert.equal(last.status, 200);
  assert.equal(last.data.truncated, false);
  assert.equal(
    [...first.data.records, ...last.data.records].filter(({ type }) => type === "line").length,
    40,
  );
  assert.ok(
    last.data.records.some(({ type, reason }) => type === "gap" && reason === "window_exceeded"),
    "identical rolling remains unobservable after the checkpoint closes",
  );
  assert.ok(Buffer.byteLength(last.text) <= 512 * 1024);
  const replay = await fixture.request(
    "GET",
    fixture.target.logsPath(`source=sandbox&tailLines=40&cursor=${last.data.cursor}`),
  );
  assert.equal(replay.data.records.filter(({ type }) => type === "line").length, 0);
});

for (const wideIdentity of [false, true]) {
  test(`sandbox full overlap cuts keep ${wideIdentity ? "maximum Driver identities" : "legacy cursors"} within admission limits`, async () => {
    const cursorSecret = "disposable-legacy-baseline-cursor-secret-32";
    const fixture = await sandboxFixture({
      cursorSecret,
      ...(wideIdentity ? { sandboxName: "s".repeat(253) } : {}),
    });
    const start = Date.now() - 1000;
    const row = (i, message) => ({
      sandboxId: wideIdentity ? "i".repeat(128) : SANDBOX_ID,
      time: new Date(start + i).toISOString().replace("Z", "000000Z"),
      level: "INFO",
      target: "supervisor",
      source: "sandbox",
      message,
      fields: {},
    });
    const anchors = Array.from({ length: 48 }, (_, i) => row(i, `anchor=${i}`));
    fixture.gateway.state.lines = anchors;
    const prime = await fixture.request(
      "GET",
      fixture.target.logsPath("source=sandbox&tailLines=200"),
    );
    assert.equal(prime.status, 200);
    fixture.gateway.state.lines = [
      ...anchors,
      ...Array.from({ length: 150 }, (_, i) =>
        row(i + 100, `row=${i}; diagnostic ${'--option="value" '.repeat(500)}`),
      ),
    ];
    let cursor = prime.data.cursor;
    if (!wideIdentity) {
      // Existing v1 cursors store overlap hashes as an array; retain route decoding.
      const decoded = JSON.parse(Buffer.from(cursor.split(".")[1], "base64url"));
      decoded.h = decoded.h.match(/.{16}/g);
      const payload = Buffer.from(JSON.stringify(decoded)).toString("base64url");
      const mac = createHmac("sha256", cursorSecret)
        .update(`occ-runtime-logs-cursor\0${payload}`)
        .digest("base64url");
      cursor = `v1.${payload}.${mac}`;
    }
    const seen = [];
    for (let page = 0; page < 10; page += 1) {
      const response = await fixture.request(
        "GET",
        fixture.target.logsPath(`source=sandbox&tailLines=200&cursor=${cursor}`),
      );
      assert.equal(response.status, 200);
      const lines = response.data.records.filter(({ type }) => type === "line");
      assert.ok(
        lines.every(({ message }) => message.startsWith("row=")),
        "partial checkpoints retain the anchor baseline",
      );
      seen.push(...lines.map(({ message }) => Number(/^row=(\d+);/.exec(message)[1])));
      cursor = response.data.cursor;
      assert.ok(cursor.length <= 2048);
      assert.match(cursor, /^v1\.[A-Za-z0-9_-]{1,1900}\.[A-Za-z0-9_-]{43}$/);
      if (!response.data.truncated) {
        break;
      }
    }
    assert.deepEqual(
      seen,
      Array.from({ length: 150 }, (_, i) => i),
    );
    const replay = await fixture.request(
      "GET",
      fixture.target.logsPath(`source=sandbox&tailLines=200&cursor=${cursor}`),
    );
    assert.equal(replay.status, 200);
    assert.equal(replay.data.records.filter(({ type }) => type === "line").length, 0);
  });
}

test("sandbox follows a growing full wire-cut tail without replaying its delivered prefix", async () => {
  const fixture = await sandboxFixture();
  const start = Date.now() - 120_000;
  const row = (index) => ({
    sandboxId: SANDBOX_ID,
    time: new Date(start + index * 1000).toISOString().replace("Z", "000000Z"),
    level: "INFO",
    target: "supervisor",
    source: "sandbox",
    message: `row=${index}; ${"ordinary diagnostic ".repeat(350)}`,
    fields: {},
  });
  fixture.gateway.state.lines = Array.from({ length: 100 }, (_, index) => row(index));
  let cursor;
  const seen = [];
  const counts = [];
  for (let poll = 0; poll < 6; poll += 1) {
    if (poll > 0) {
      const offset = fixture.gateway.state.lines.length;
      fixture.gateway.state.lines.push(
        ...Array.from({ length: 3 }, (_, index) => row(offset + index)),
      );
    }
    const response = await fixture.request(
      "GET",
      fixture.target.logsPath(
        `source=sandbox&tailLines=100${cursor === undefined ? "" : `&cursor=${cursor}`}`,
      ),
    );
    assert.equal(response.status, 200);
    assert.ok(Buffer.byteLength(response.text) <= 512 * 1024);
    const lines = response.data.records.filter(({ type }) => type === "line");
    seen.push(...lines.map(({ message }) => Number(/^row=(\d+);/.exec(message)[1])));
    counts.push(lines.length);
    if (poll === 0) {
      assert.equal(response.data.truncated, true);
    }
    cursor = response.data.cursor;
  }
  assert.deepEqual(
    seen,
    Array.from({ length: 115 }, (_, index) => index),
  );
  assert.deepEqual(counts.slice(2), [3, 3, 3, 3]);
  const replay = await fixture.request(
    "GET",
    fixture.target.logsPath(`source=sandbox&tailLines=100&cursor=${cursor}`),
  );
  assert.deepEqual(
    replay.data.records.filter(({ type }) => type === "line"),
    [],
  );
});

for (const { tailLines, identical } of [
  { tailLines: 200, identical: false },
  { tailLines: 1000, identical: false },
  { tailLines: 1000, identical: true },
]) {
  test(`sandbox follows full ${tailLines}-line wire cuts inside ${identical ? "identical" : "distinct"} millisecond timestamp groups`, async () => {
    const fixture = await sandboxFixture();
    const start = Date.now() - 120_000;
    const total = tailLines + 21;
    // Deterministic 2–3-line millisecond groups model the supported timestamp
    // precision. A full moving source must resume inside a partly delivered group.
    let seed = 1;
    const offsets = [];
    for (let offset = 0; offsets.length < total; offset += 1) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const count = 2 + (seed >>> 31);
      offsets.push(...Array.from({ length: count }, () => offset));
    }
    const row = (index) => ({
      sandboxId: SANDBOX_ID,
      time: new Date(start + offsets[index]).toISOString().replace("Z", "000000Z"),
      level: "INFO",
      target: "supervisor",
      source: "sandbox",
      message: `row=${identical ? offsets[index] : index}; ${"ordinary diagnostic ".repeat(tailLines === 200 ? 350 : 105)}`,
      fields: {},
    });
    fixture.gateway.state.lines = Array.from({ length: tailLines }, (_, index) => row(index));
    let cursor;
    let splitGroup = false;
    const seen = [];
    for (let poll = 0; poll < 8; poll += 1) {
      if (poll > 0) {
        const offset = fixture.gateway.state.lines.length;
        fixture.gateway.state.lines.push(
          ...Array.from({ length: 3 }, (_, index) => row(offset + index)),
        );
      }
      fixture.gateway.state.bufferTotal = fixture.gateway.state.lines.length;
      const response = await fixture.request(
        "GET",
        fixture.target.logsPath(
          `source=sandbox&tailLines=${tailLines}${cursor === undefined ? "" : `&cursor=${cursor}`}`,
        ),
      );
      assert.equal(response.status, 200);
      assert.ok(Buffer.byteLength(response.text) <= 512 * 1024);
      const lines = response.data.records.filter(({ type }) => type === "line");
      const indices = lines.map(({ message }) => Number(/^row=(\d+);/.exec(message)[1]));
      seen.push(...indices);
      if (response.data.truncated && indices.length > 0) {
        const last = indices.at(-1);
        splitGroup ||= identical
          ? lines.filter(({ message }) => message === lines.at(-1).message).length <
            fixture.gateway.state.lines
              .slice(-tailLines)
              .filter(({ message }) => message === lines.at(-1).message).length
          : offsets[last] === offsets[last + 1];
      }
      cursor = response.data.cursor;
    }
    assert.ok(splitGroup, "the response cut exercises a partly delivered timestamp group");
    assert.deepEqual(
      seen,
      Array.from({ length: total }, (_, index) => (identical ? offsets[index] : index)),
    );
    const replay = await fixture.request(
      "GET",
      fixture.target.logsPath(`source=sandbox&tailLines=${tailLines}&cursor=${cursor}`),
    );
    assert.equal(replay.status, 200);
    assert.deepEqual(
      replay.data.records.filter(({ type }) => type === "line"),
      [],
    );
  });
}

test("sandbox full wire-cut pages retain already-delivered untimed prefixes", async () => {
  const start = Date.now() - 120_000;
  const rows = Array.from({ length: 100 }, (_, index) => ({
    sandboxId: SANDBOX_ID,
    time: index === 0 ? null : new Date(start + index * 1000).toISOString().replace("Z", "000000Z"),
    level: "INFO",
    target: "supervisor",
    source: "sandbox",
    message: `row=${index}; ${"ordinary diagnostic ".repeat(350)}`,
    fields: {},
  }));
  // This supported raw-null-time response cannot be ordered by the request floor.
  // Keep the observed unknown row alongside the matching timed rows.
  const gatewayClient = {
    async getSandboxLogs(request) {
      const tail = rows.slice(-request.lines);
      return {
        lines: tail.filter(
          (line) =>
            line.time === null || request.sinceTime === undefined || line.time >= request.sinceTime,
        ),
        bufferTotal: tail.length,
      };
    },
  };
  const fixture = await createRuntimeLogFixture({
    computeDriver: createRuntimeLogComputeDriver({ sandboxNamespace: SANDBOX_NAMESPACE }),
    sandboxDriver: openShellSandboxDriver(gatewayClient),
  });
  const target = await fixture.deployAgent("full-mixed-wire-tail");
  const seen = [];
  let cursor;
  for (let poll = 0; poll < 3; poll += 1) {
    const response = await fixture.request(
      "GET",
      target.logsPath(
        `source=sandbox&tailLines=100${cursor === undefined ? "" : `&cursor=${cursor}`}`,
      ),
    );
    assert.equal(response.status, 200);
    assert.ok(Buffer.byteLength(response.text) <= 512 * 1024);
    const lines = response.data.records.filter(({ type }) => type === "line");
    seen.push(...lines.map(({ message }) => Number(/^row=(\d+);/.exec(message)[1])));
    if (poll === 0) {
      assert.equal(response.data.truncated, true);
    }
    if (poll === 2) {
      assert.equal(lines.length, 0, "the drained snapshot does not replay its untimed prefix");
    }
    cursor = response.data.cursor;
  }
  assert.deepEqual(
    seen,
    Array.from({ length: 100 }, (_, index) => index),
  );
});

test("sandbox partial identical groups preserve rollover uncertainty beside newer timestamps", async () => {
  const fixture = await sandboxFixture();
  const time = new Date(Date.now() - 1000).toISOString().replace("Z", "000000Z");
  const originalCount = 40;
  const original = Array.from({ length: originalCount }, () => ({
    sandboxId: SANDBOX_ID,
    time,
    level: "INFO",
    target: "supervisor",
    source: "sandbox",
    message: `same diagnostic ${'"'.repeat(8000)}`,
    fields: {},
  }));
  fixture.gateway.state.lines = original;
  const first = await fixture.request(
    "GET",
    fixture.target.logsPath("source=sandbox&tailLines=40"),
  );
  assert.equal(first.status, 200);
  assert.equal(first.data.truncated, true);
  const delivered = first.data.records.filter(({ type }) => type === "line").length;
  assert.ok(delivered > 0 && delivered < originalCount);
  // The delivered copies leave the requested tail; identical unread copies
  // cannot identify their occurrence by hash. Newer times hide that ambiguity
  // from a single-time check, so the changed snapshot must retain its gap.
  fixture.gateway.state.lines.push(
    ...Array.from({ length: delivered }, (_, index) => ({
      ...original[0],
      time: new Date(Date.parse(time) + index + 1).toISOString().replace("Z", "000000Z"),
      message: `new diagnostic ${index}`,
    })),
  );
  fixture.gateway.state.bufferTotal = fixture.gateway.state.lines.length;
  const second = await fixture.request(
    "GET",
    fixture.target.logsPath(`source=sandbox&tailLines=40&cursor=${first.data.cursor}`),
  );
  assert.equal(second.status, 200);
  assert.equal(
    second.data.records.filter(
      ({ type, message }) => type === "line" && message.startsWith("same diagnostic"),
    ).length,
    originalCount - delivered,
    "the unread identical copies remain in the surviving snapshot",
  );
  assert.ok(Buffer.byteLength(second.text) <= 512 * 1024);
  assert.ok(
    second.data.records.some(({ type, reason }) => type === "gap" && reason === "window_exceeded"),
  );
});

test("sandbox matching witnesses deliver new late rows below the advanced overlap floor", async () => {
  const fixture = await sandboxFixture();
  const start = Date.now() - 2000;
  const recent = Array.from({ length: 300 }, (_, index) => ({
    sandboxId: SANDBOX_ID,
    time: new Date(start + Math.floor(index / 3)).toISOString().replace("Z", "000000Z"),
    level: "INFO",
    target: "supervisor",
    source: "sandbox",
    message: `group=${Math.floor(index / 3)}; ${"ordinary diagnostic ".repeat(105)}`,
    fields: {},
  }));
  // An already full ring can grow the filtered window without changing its
  // total or prior value prefix: the evicted rows are before the query floor.
  const older = Array.from({ length: 1700 }, () => ({
    ...recent[0],
    time: new Date(start - 20_000).toISOString().replace("Z", "000000Z"),
    message: "older diagnostic",
  }));
  fixture.gateway.state.lines = [...older, ...recent];
  fixture.gateway.state.bufferTotal = 2000;
  const first = await fixture.request(
    "GET",
    fixture.target.logsPath("source=sandbox&tailLines=1000&sinceSeconds=10"),
  );
  assert.equal(first.status, 200);
  assert.equal(first.data.truncated, true);
  fixture.gateway.state.lines.shift();
  fixture.gateway.state.lines.push({
    ...recent[0],
    time: new Date(start - 2000).toISOString().replace("Z", "000000Z"),
    message: "new late diagnostic",
  });
  const seen = [...first.data.records.filter(({ type }) => type === "line")];
  let cursor = first.data.cursor;
  for (let page = 0; page < 5; page += 1) {
    const response = await fixture.request(
      "GET",
      fixture.target.logsPath(`source=sandbox&tailLines=1000&cursor=${cursor}`),
    );
    assert.equal(response.status, 200);
    seen.push(...response.data.records.filter(({ type }) => type === "line"));
    cursor = response.data.cursor;
    if (!response.data.truncated) {
      break;
    }
  }
  assert.equal(seen.filter(({ message }) => message.startsWith("group=")).length, 300);
  assert.equal(seen.filter(({ message }) => message === "new late diagnostic").length, 1);
});

test("sandbox retains witnesses for unread copies of incoming overlap hashes", async () => {
  const fixture = await sandboxFixture();
  const start = Date.now() - 1000;
  const x = {
    sandboxId: SANDBOX_ID,
    time: new Date(start).toISOString(),
    level: "INFO",
    target: "supervisor",
    source: "sandbox",
    message: "remembered diagnostic X",
    fields: {},
  };
  fixture.gateway.state.lines = [x];
  const first = await fixture.request(
    "GET",
    fixture.target.logsPath("source=sandbox&tailLines=42"),
  );
  assert.equal(first.status, 200);
  assert.equal(first.data.records.filter(({ type }) => type === "line").length, 1);
  const ys = Array.from({ length: 40 }, (_, index) => ({
    ...x,
    time: new Date(start + 1).toISOString(),
    message: `Y=${index}; ${'"'.repeat(8000)}`,
  }));
  fixture.gateway.state.lines = [x, ...ys, x];
  const second = await fixture.request(
    "GET",
    fixture.target.logsPath(`source=sandbox&tailLines=42&cursor=${first.data.cursor}`),
  );
  assert.equal(second.status, 200);
  assert.equal(second.data.truncated, true);
  assert.equal(
    second.data.records.filter(({ type, message }) => type === "line" && message === x.message)
      .length,
    0,
  );
  // The delivered X leaves the tail while its unread identical late copy survives.
  // Without a raw witness, the incoming overlap hash consumes that unread copy.
  fixture.gateway.state.lines.push({
    ...x,
    time: new Date(start + 2).toISOString(),
    message: "new diagnostic Z",
  });
  fixture.gateway.state.bufferTotal = fixture.gateway.state.lines.length;
  const seen = [];
  const gaps = [];
  let cursor = second.data.cursor;
  for (let page = 0; page < 5; page += 1) {
    const response = await fixture.request(
      "GET",
      fixture.target.logsPath(`source=sandbox&tailLines=42&cursor=${cursor}`),
    );
    assert.equal(response.status, 200);
    assert.ok(Buffer.byteLength(response.text) <= 512 * 1024);
    seen.push(...response.data.records.filter(({ type }) => type === "line"));
    gaps.push(...response.data.records.filter(({ type }) => type === "gap"));
    cursor = response.data.cursor;
    if (!response.data.truncated) {
      break;
    }
  }
  assert.equal(
    seen.filter(({ message }) => message === x.message).length,
    1,
    "the unread identical copy remains visible",
  );
  assert.ok(
    gaps.some(({ reason }) => reason === "window_exceeded"),
    "lost ordered context must disclose reset and possible replay",
  );
  const replay = await fixture.request(
    "GET",
    fixture.target.logsPath(`source=sandbox&tailLines=42&cursor=${cursor}`),
  );
  assert.equal(replay.data.records.filter(({ type }) => type === "line").length, 0);
});

test("sandbox cut witnesses retain copies arriving after a distinct partial group rolls", async () => {
  const fixture = await sandboxFixture();
  const start = Date.now() - 1000;
  const line = (index, offset, large = false) => ({
    sandboxId: SANDBOX_ID,
    time: new Date(start + offset).toISOString(),
    level: "INFO",
    target: "supervisor",
    source: "sandbox",
    message: `row=${index}; ${large ? '"'.repeat(8000) : "ordinary diagnostic"}`,
    fields: {},
  });
  const original = [
    ...Array.from({ length: 40 }, (_, index) => line(index, 0, true)),
    line(40, 1),
    line(41, 1),
  ];
  fixture.gateway.state.lines = [...original];
  const first = await fixture.request(
    "GET",
    fixture.target.logsPath("source=sandbox&tailLines=42"),
  );
  assert.equal(first.status, 200);
  assert.equal(first.data.truncated, true);
  const delivered = first.data.records.filter(({ type }) => type === "line").length;
  assert.ok(delivered > 0 && delivered < 40);
  // All delivered originals roll out, then one late identical copy arrives.
  // The original fetched suffix had no equal hash, so only retained window
  // evidence can disclose the changed snapshot and keep this new occurrence.
  fixture.gateway.state.lines.push(
    original[0],
    ...Array.from({ length: delivered - 1 }, (_, index) => line(42 + index, 2)),
  );
  fixture.gateway.state.bufferTotal = fixture.gateway.state.lines.length;
  const second = await fixture.request(
    "GET",
    fixture.target.logsPath(`source=sandbox&tailLines=42&cursor=${first.data.cursor}`),
  );
  assert.equal(second.status, 200);
  assert.ok(Buffer.byteLength(second.text) <= 512 * 1024);
  assert.deepEqual(
    second.data.records
      .filter(({ type }) => type === "line")
      .map(({ message }) => Number(/^row=(\d+);/.exec(message)[1])),
    [
      ...Array.from({ length: 42 - delivered }, (_, index) => delivered + index),
      0,
      ...Array.from({ length: delivered - 1 }, (_, index) => 42 + index),
    ],
  );
  assert.ok(
    second.data.records.some(({ type, reason }) => type === "gap" && reason === "window_exceeded"),
  );
  const replay = await fixture.request(
    "GET",
    fixture.target.logsPath(`source=sandbox&tailLines=42&cursor=${second.data.cursor}`),
  );
  assert.equal(replay.data.records.filter(({ type }) => type === "line").length, 0);
});

test("sandbox cut recovery does not infer history order from a surviving ordered tail", async () => {
  const fixture = await sandboxFixture();
  const start = Date.now() - 1000;
  const line = (index, offset = 0, large = true) => ({
    sandboxId: SANDBOX_ID,
    time: new Date(start + offset).toISOString(),
    level: "INFO",
    target: "supervisor",
    source: "sandbox",
    message: `row=${index}; ${large ? '"'.repeat(8000) : "ordinary diagnostic"}`,
    fields: {},
  });
  const original = Array.from({ length: 100 }, (_, index) =>
    line(index, index === 20 ? -10_000 : 0),
  );
  fixture.gateway.state.lines = [...original];
  const first = await fixture.request(
    "GET",
    fixture.target.logsPath("source=sandbox&tailLines=100"),
  );
  assert.equal(first.status, 200);
  assert.equal(first.data.truncated, true);
  const delivered = first.data.records.filter(({ type }) => type === "line").length;
  assert.ok(delivered > 21 && delivered < 48);
  // The out-of-order delivered prefix rolls into a currently ordered tail.
  // That surviving order does not identify the new copy of an evicted row.
  fixture.gateway.state.lines.push(
    original[0],
    ...Array.from({ length: 19 }, (_, index) => line(100 + index, 0, false)),
  );
  fixture.gateway.state.bufferTotal = fixture.gateway.state.lines.length;
  const seen = [];
  const gaps = [];
  let cursor = first.data.cursor;
  for (let page = 0; page < 5; page += 1) {
    const response = await fixture.request(
      "GET",
      fixture.target.logsPath(`source=sandbox&tailLines=100&cursor=${cursor}`),
    );
    assert.equal(response.status, 200);
    assert.ok(Buffer.byteLength(response.text) <= 512 * 1024);
    seen.push(
      ...response.data.records
        .filter(({ type }) => type === "line")
        .map(({ message }) => Number(/^row=(\d+);/.exec(message)[1])),
    );
    gaps.push(...response.data.records.filter(({ type }) => type === "gap"));
    cursor = response.data.cursor;
    if (!response.data.truncated) {
      break;
    }
  }
  assert.equal(
    seen.filter((index) => index === 0).length,
    1,
    "the late copy remains unread even if the current tail is ordered",
  );
  for (let index = delivered; index < 100; index += 1) {
    assert.equal(seen.filter((value) => value === index).length, 1);
  }
  assert.ok(gaps.some(({ reason }) => reason === "window_exceeded"));
  const replay = await fixture.request(
    "GET",
    fixture.target.logsPath(`source=sandbox&tailLines=100&cursor=${cursor}`),
  );
  assert.equal(replay.data.records.filter(({ type }) => type === "line").length, 0);
});
