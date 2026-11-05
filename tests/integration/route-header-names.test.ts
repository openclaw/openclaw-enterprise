import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";

import { createControllerAuth } from "../../apps/controller/src/auth/index.ts";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { createNativeIAMDriver } from "../../packages/iam/src/index.ts";
import { assertApiError } from "../helpers/api-error.mjs";

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
    // Patterns match the lowercased name too, so an uppercase letter in one never matches.
    "pattern property": { patternProperties: { "^X-Blocked$": { type: "string" } } },
    "name pattern": { propertyNames: { not: { pattern: "^X-Blocked$" } } },
    "name pattern in a character class": { propertyNames: { pattern: "^[Xx]-blocked$" } },
    "hex-escaped name pattern": { propertyNames: { pattern: "^\\u0058-blocked$" } },
  };
  const refused: Record<string, string> = {
    "pattern property": "^X-Blocked$",
    "name pattern": "^X-Blocked$",
    "name pattern in a character class": "^[Xx]-blocked$",
    "hex-escaped name pattern": "^\\u0058-blocked$",
  };
  for (const [name, headers] of Object.entries(cases)) {
    await t.test(name, async (t) => {
      const app = createApp();
      t.after(() => app.close());
      app.get("/example", { schema: { headers: { type: "object", ...headers } } }, () => "ok");
      const expected = `Route headers schemas must name headers in lowercase: ${refused[name] ?? "X-Blocked"}`;
      await assert.rejects(
        async () => app.ready(),
        (error: Error & { code?: string }) => {
          assert.equal(error.code, "FST_ERR_SCH_VALIDATION_BUILD");
          assert.ok(error.message.endsWith(expected), error.message);
          return true;
        },
      );
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
          // Uppercase escapes (\d, \S) and header-value patterns are not header names.
          patternProperties: { "^x-count-\\d$": { type: "string", pattern: "^[A-F0-9]+$" } },
          dependencies: { "x-trigger": ["x-companion"] },
          propertyNames: { not: { enum: ["x-blocked"] }, pattern: "^\\S+$" },
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
    assertApiError(denied, 400, "INVALID_REQUEST");
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
    assertApiError(missing, 400, "INVALID_REQUEST");
  }
  // The pattern property matches the lowercased name and checks the value as sent.
  const counted = await app.inject({ url, headers: { "X-Mode": "READ", "X-Count-1": "AB" } });
  assert.equal(counted.statusCode, 200);
  const badCount = await app.inject({ url, headers: { "X-Mode": "READ", "X-Count-1": "ab" } });
  assertApiError(badCount, 400, "INVALID_REQUEST");
  const wrongValue = await app.inject({ url, headers: { "X-Mode": "read" } });
  assertApiError(wrongValue, 400, "INVALID_REQUEST");
  assert.equal(hits, 5);
});
