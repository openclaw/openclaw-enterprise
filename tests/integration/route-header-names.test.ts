import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";

import { createControllerAuth } from "../../apps/controller/src/auth/index.ts";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { createNativeIAMDriver } from "../../packages/iam/src/index.ts";

function createApp() {
  const installationId = `ins_${randomUUID()}`;
  return createFastifyApp({
    development: { enabled: true, installationId },
    auth: createControllerAuth({
      mode: "development",
      installationId,
      baseURL: "http://127.0.0.1",
      secret: randomBytes(48).toString("base64url"),
    }),
    iamDriver: createNativeIAMDriver({
      loadNativeIAMState: async () => assert.fail("These routes do not read IAM state"),
    }),
    auditSink: new InMemoryAuditSink(),
    resolveHarness: () => undefined,
  });
}

test("route registration rejects mixed-case literals that constrain a header name", async (t) => {
  const cases = {
    enum: { propertyNames: { enum: ["host", "X-Blocked"] } },
    const: { propertyNames: { const: "X-Blocked" } },
    "denied enum": { propertyNames: { not: { enum: ["x-other", "X-Blocked"] } } },
    "denied const": { propertyNames: { not: { const: "X-Blocked" } } },
    "composed header and name schemas": {
      allOf: [{ propertyNames: { anyOf: [{ not: { oneOf: [{ const: "X-Blocked" }] } }] } }],
    },
    "conditional header schema": {
      dependencies: { host: { propertyNames: { not: { const: "X-Blocked" } } } },
    },
    "dependency trigger": { dependencies: { "X-Blocked": ["x-companion"] } },
    "dependency array member": { dependencies: { "x-trigger": ["X-Blocked"] } },
    "conditional name": {
      propertyNames: { if: { const: "host" }, then: true, else: { not: { const: "X-Blocked" } } },
    },
  };
  for (const [name, headers] of Object.entries(cases)) {
    await t.test(name, async (t) => {
      const app = createApp();
      t.after(() => app.close());
      app.get("/example", { schema: { headers: { type: "object", ...headers } } }, () => "ok");
      await assert.rejects(async () => app.ready(), {
        code: "FST_ERR_SCH_VALIDATION_BUILD",
        message: /Route headers schemas must name headers in lowercase: X-Blocked/u,
      });
    });
  }
});

test("lowercase header constraints preserve header values and query names", async (t) => {
  const app = createApp();
  t.after(() => app.close());
  let hits = 0;
  app.get<{ Querystring: { Mode: string } }>(
    "/example",
    {
      schema: {
        headers: {
          type: "object",
          properties: { "x-mode": { const: "READ" } },
          required: ["x-mode"],
          dependencies: { "x-trigger": ["x-companion"] },
          propertyNames: { not: { enum: ["x-blocked"] } },
        },
        querystring: { type: "object", propertyNames: { enum: ["Mode"] } },
      },
    },
    (request) => {
      hits++;
      return { mode: request.headers["x-mode"], query: request.query.Mode };
    },
  );
  const url = "/example?Mode=READ";
  const response = await app.inject({ url, headers: { "X-Mode": "READ" } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { mode: "READ", query: "READ" });
  // Both wire spellings reach the validator as the same lowercase header name.
  for (const name of ["X-Blocked", "x-blocked"]) {
    const denied = await app.inject({ url, headers: { "X-Mode": "READ", [name]: "1" } });
    assert.equal(denied.statusCode, 400);
    assert.equal(denied.json().error.code, "INVALID_REQUEST");
  }
  for (const headers of [
    { "x-trigger": "1", "x-companion": "1" },
    { "X-Trigger": "1", "X-Companion": "1" },
    { "x-companion": "1" },
  ]) {
    const allowed = await app.inject({ url, headers: { "X-Mode": "READ", ...headers } });
    assert.equal(allowed.statusCode, 200);
    assert.deepEqual(allowed.json(), { mode: "READ", query: "READ" });
  }
  for (const name of ["x-trigger", "X-Trigger"]) {
    const missing = await app.inject({ url, headers: { "X-Mode": "READ", [name]: "1" } });
    assert.equal(missing.statusCode, 400);
    assert.equal(missing.json().error.code, "INVALID_REQUEST");
  }
  const wrongValue = await app.inject({ url, headers: { "X-Mode": "read" } });
  assert.equal(wrongValue.statusCode, 400);
  assert.equal(wrongValue.json().error.code, "INVALID_REQUEST");
  assert.equal(hits, 4);
});
