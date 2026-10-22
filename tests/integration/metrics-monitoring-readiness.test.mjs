import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import {
  checkGrafanaDatasource,
  containerLogTail,
  distinctPorts,
  portClash,
  queryPrometheus,
  waitForMonitoring,
} from "../helpers/metrics-monitoring-readiness.mjs";
import { listen } from "../helpers/listen.mjs";

async function loopbackServer(t, respond) {
  const server = createServer(respond);
  return `http://127.0.0.1:${await listen(t, server)}`;
}

// The diagnostic a non-retryable readiness query error carries.
const queryError = (stage, lastHttpStatus) => ({
  openclawCiDiagnostic: {
    kind: "metrics-monitoring",
    stage,
    reason: "query-error",
    lastHttpStatus,
  },
});

// Successful headers, then a truncated JSON body and a dropped connection.
function interruptBody(response) {
  response.flushHeaders();
  response.write('{"status":');
  setTimeout(() => response.destroy(), 50);
}

test("datasource readiness retries a transient HTTP 400", async (t) => {
  let attempts = 0;
  // A provisioned datasource may answer before its backend is healthy.
  const origin = await loopbackServer(t, (_request, response) => {
    attempts += 1;
    response.writeHead(attempts === 1 ? 400 : 200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: attempts === 1 ? "ERROR" : "OK" }));
  });

  await waitForMonitoring("grafana-datasource", () => checkGrafanaDatasource(origin), []);
  assert.equal(attempts, 2);
});

test("non-retryable Grafana health failures retain their stage and status", async () => {
  let attempts = 0;
  await assert.rejects(
    waitForMonitoring(
      "grafana-health",
      async () => {
        attempts += 1;
        const error = new Error("Grafana health returned HTTP 401");
        error.httpStatus = 401;
        throw error;
      },
      [],
    ),
    queryError("grafana-health", 401),
  );
  assert.equal(attempts, 1);
});

test("non-retryable Grafana datasource failures retain their stage and status", async (t) => {
  let attempts = 0;
  const origin = await loopbackServer(t, (_request, response) => {
    attempts += 1;
    response.writeHead(403, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ERROR" }));
  });

  await assert.rejects(
    waitForMonitoring("grafana-datasource", () => checkGrafanaDatasource(origin), []),
    queryError("grafana-datasource", 403),
  );
  assert.equal(attempts, 1);
});

test("datasource readiness retries an interrupted response body", async (t) => {
  let attempts = 0;
  // Successful headers do not mean the datasource body arrived intact.
  const origin = await loopbackServer(t, (_request, response) => {
    attempts += 1;
    response.writeHead(200, { "content-type": "application/json" });
    if (attempts === 1) {
      interruptBody(response);
      return;
    }
    response.end(JSON.stringify({ status: "OK" }));
  });

  await waitForMonitoring("grafana-datasource", () => checkGrafanaDatasource(origin), []);
  assert.equal(attempts, 2);
});

test("malformed or invalid Grafana datasource responses retain their stage and status", async (t) => {
  // Unparseable JSON and parsed bodies without a string status fail on separate paths.
  for (const body of ["invalid json", "null", "[]", '"OK"', "42", "{}", '{"status":null}']) {
    let attempts = 0;
    const origin = await loopbackServer(t, (_request, response) => {
      attempts += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(body);
    });

    await assert.rejects(
      waitForMonitoring("grafana-datasource", () => checkGrafanaDatasource(origin), []),
      queryError("grafana-datasource", 200),
    );
    assert.equal(attempts, 1);
  }
});

test("a timed-out Prometheus response body retries and accepts a later valid query", async (t) => {
  let attempts = 0;
  // Send successful headers, then leave the first body incomplete until fetch times out.
  const origin = await loopbackServer(t, (_request, response) => {
    attempts += 1;
    response.writeHead(200, { "content-type": "application/json" });
    if (attempts === 1) {
      response.flushHeaders();
      return;
    }
    response.end(JSON.stringify({ status: "success", data: { result: [{ value: [0, "1"] }] } }));
  });

  await waitForMonitoring(
    "prometheus-up",
    async () => (await queryPrometheus(origin, "prometheus-up", "up")).length === 1,
    [],
  );
  assert.equal(attempts, 2);
});

test("Prometheus readiness retries an interrupted response body", async (t) => {
  let attempts = 0;
  const origin = await loopbackServer(t, (_request, response) => {
    attempts += 1;
    response.writeHead(200, { "content-type": "application/json" });
    if (attempts === 1) {
      // The failure occurs while reading the Prometheus JSON body.
      interruptBody(response);
      return;
    }
    response.end(JSON.stringify({ status: "success", data: { result: [{ value: [0, "1"] }] } }));
  });

  await waitForMonitoring(
    "prometheus-up",
    async () => (await queryPrometheus(origin, "prometheus-up", "up")).length === 1,
    [],
  );
  assert.equal(attempts, 2);
});

test("null or malformed Prometheus responses retain their stage and status", async (t) => {
  const expected = queryError("prometheus-up", 200);
  // A null body parses but has no result; invalid JSON fails while parsing.
  for (const body of ["null", "invalid json"]) {
    const origin = await loopbackServer(t, (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(body);
    });

    // Dashboard checks call the query directly; readiness checks use the waiter.
    await assert.rejects(queryPrometheus(origin, "prometheus-up", "up"), expected);
    await assert.rejects(
      waitForMonitoring("prometheus-up", () => queryPrometheus(origin, "prometheus-up", "up"), []),
      expected,
    );
  }
});

test("monitoring ports are distinct and picked within a bound", async () => {
  const picks = [9100, 9100, 9200];
  assert.deepEqual(await distinctPorts(2, async () => picks.shift()), [9100, 9200]);
  let picked = 0;
  await assert.rejects(
    distinctPorts(
      2,
      async () => {
        picked += 1;
        return 9100;
      },
      4,
    ),
    {
      message: "Unable to pick 2 distinct free ports in 4 attempts.",
    },
  );
  assert.equal(picked, 4, "the bound counts every pick");
});

test("only a listener bind failure counts as a port clash", () => {
  assert.equal(
    portClash(
      'time=2026-10-17T05:20:03.290Z level=ERROR source=main.go:1180 msg="Unable to start web listener" err="listen tcp 127.0.0.1:41234: bind: address already in use"',
    ),
    true,
  );
  assert.equal(portClash('level=ERROR msg="Error loading config" err="parsing YAML file"'), false);
  // Another bind failure is not a port someone else took; new ports would not help.
  assert.equal(
    portClash(
      'msg="Unable to start web listener" err="listen tcp 127.0.0.1:80: bind: permission denied"',
    ),
    false,
  );
});

test("a container log diagnostic keeps the last lines one per entry", () => {
  const log = `${Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n")}\n\n`;
  assert.deepEqual(containerLogTail(log, 3), ["line 27", "line 28", "line 29"]);
  assert.deepEqual(containerLogTail("only\r\n"), ["only"]);
  // By default the last 15 lines.
  assert.deepEqual(
    containerLogTail(log),
    Array.from({ length: 15 }, (_, index) => `line ${index + 15}`),
  );
});
