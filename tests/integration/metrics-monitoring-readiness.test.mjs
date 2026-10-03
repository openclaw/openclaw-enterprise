import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import {
  checkGrafanaDatasource,
  queryPrometheus,
  waitForMonitoring,
} from "../helpers/metrics-monitoring-readiness.mjs";

async function loopbackServer(t, respond) {
  const server = createServer(respond);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
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
    {
      openclawCiDiagnostic: {
        kind: "metrics-monitoring",
        stage: "grafana-health",
        reason: "query-error",
        lastHttpStatus: 401,
      },
    },
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
    {
      openclawCiDiagnostic: {
        kind: "metrics-monitoring",
        stage: "grafana-datasource",
        reason: "query-error",
        lastHttpStatus: 403,
      },
    },
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
      response.flushHeaders();
      response.write('{"status":');
      setTimeout(() => response.destroy(), 50);
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
      {
        openclawCiDiagnostic: {
          kind: "metrics-monitoring",
          stage: "grafana-datasource",
          reason: "query-error",
          lastHttpStatus: 200,
        },
      },
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
      // Drop the connection after headers so the failure occurs while reading JSON.
      response.flushHeaders();
      response.write('{"status":');
      setTimeout(() => response.destroy(), 50);
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
  const expected = {
    openclawCiDiagnostic: {
      kind: "metrics-monitoring",
      stage: "prometheus-up",
      reason: "query-error",
      lastHttpStatus: 200,
    },
  };
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
