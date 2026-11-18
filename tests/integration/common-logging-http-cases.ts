import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { createControllerAuth } from "../../apps/controller/src/auth/index.ts";
import {
  authLibraryFailureEvent,
  authLibraryLog,
  withAuthLogContext,
} from "../../apps/controller/src/auth/library-log.ts";
import { createFastifyApp, type ControllerAppOptions } from "../../apps/controller/src/index.ts";
import { emitOccLogEvent, type LoggingConfiguration } from "../../apps/controller/src/logging.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { createDevelopmentComputeDriver } from "../helpers/development.ts";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.ts";
import { captureLogs, logAt } from "./common-logging-output.ts";

async function withLoggingApp<Result>(
  level: LoggingConfiguration["level"],
  developmentEnabled: boolean,
  trustedProxies: ControllerAppOptions["trustedProxies"],
  exercise: (
    app: ReturnType<typeof createFastifyApp>,
    auth: ReturnType<typeof createControllerAuth>,
  ) => Promise<Result>,
) {
  const { logger, lines } = captureLogs("occ-api", level);
  const installationId = `ins_${randomUUID()}`;
  const auth = createControllerAuth({
    mode: "development",
    installationId,
    baseURL: "https://occ.oce.localhost",
    agentDomain: "agents.oce.localhost",
    secret: randomBytes(32).toString("hex"),
    memoryDatabase: { user: [], session: [], account: [], verification: [], apikey: [] },
    // As the API composes it: auth events go to the structured log.
    onOperationalEvent: (event) => emitOccLogEvent(logger, event),
  });
  const app = createFastifyApp({
    iamDriver: new NativeIAMDriver(
      {
        async loadNativeIAMState() {
          return {
            identities: [],
            groups: [],
            memberships: [],
            roles: [],
            bindings: [],
            restrictions: [],
          };
        },
      },
      { id: "native-iam" },
    ),
    computeDriver: createDevelopmentComputeDriver(),
    configurationDriver: createTestConfigurationDriver({ id: "configuration-logging-test" }),
    resolveHarness: () => undefined,
    auditSink: new InMemoryAuditSink(),
    development: { enabled: developmentEnabled, installationId },
    auth,
    logger,
    ...(trustedProxies === undefined ? {} : { trustedProxies }),
  });
  try {
    return { result: await exercise(app, auth), lines };
  } finally {
    await app.close();
  }
}

export function registerHttpCases(): void {
  test("Fastify app writes one safe HTTP completion record and bounded unexpected-error diagnostics", async () => {
    const { lines } = await withLoggingApp("info", true, undefined, async (app) => {
      app.get("/boom", async () => {
        throw new Error("sensitive query token should not be logged");
      });

      const notFound = await app.inject({ method: "GET", url: "/missing?token=secret" });
      assert.equal(notFound.statusCode, 404);
      const failed = await app.inject({ method: "GET", url: "/boom?token=secret" });
      assert.equal(failed.statusCode, 500);
    });

    const completion = lines.filter((line) => line.event === "http.completed");
    assert.equal(completion.length, 2);
    assert.deepEqual(
      completion.map(({ method, route, status }) => ({ method, route, status })),
      [
        { method: "GET", route: "unmatched", status: 404 },
        { method: "GET", route: "/boom", status: 500 },
      ],
    );
    const { requestId, durationMs } = logAt(completion, 0);
    assert.ok(typeof requestId === "string");
    assert.match(requestId, /^req_[0-9a-f-]+$/);
    assert.equal(typeof durationMs, "number");

    const unexpected = lines.find((line) => line.event === "http.unexpected_error");
    assert.ok(unexpected);
    assert.equal(unexpected.code, "INTERNAL_ERROR");
    assert.equal(JSON.stringify(lines).includes("token=secret"), false);
    assert.equal(JSON.stringify(lines).includes("sensitive query"), false);
  });

  test("a refused forwarded API call names the trusted-proxy cause once a minute", async () => {
    const cases: ReadonlyArray<{
      trustedProxies: ControllerAppOptions["trustedProxies"];
      code: string;
    }> = [
      { trustedProxies: undefined, code: "TRUSTED_PROXY_NOT_CONFIGURED" },
      {
        trustedProxies: { trusts: (address) => address === "10.0.0.9" },
        code: "TRUSTED_PROXY_PEER_UNTRUSTED",
      },
    ];
    for (const { trustedProxies, code } of cases) {
      const { lines } = await withLoggingApp("info", false, trustedProxies, async (app) => {
        for (let index = 0; index < 3; index += 1) {
          const refused = await app.inject({
            method: "GET",
            url: "/namespaces/ns_00000000-0000-4000-8000-000000000001",
            remoteAddress: "192.0.2.7",
            headers: { "x-forwarded-for": `198.51.100.${index}` },
          });
          assert.equal(refused.statusCode, 403, refused.body);
          const error = asRecord(asRecord(refused.json<unknown>())?.error);
          assert.ok(typeof error?.message === "string");
          assert.match(error.message, /configured trusted proxy/);
        }
      });
      const warnings = lines.filter(
        (line) => line.event === "authentication.forwarded-refused-warning",
      );
      assert.deepEqual(
        warnings.map(({ severity, code: logged }) => ({ severity, code: logged })),
        [{ severity: "WARN", code }],
      );
      assert.doesNotMatch(JSON.stringify(warnings), /192\.0\.2\.7|198\.51\.100/);
    }
  });

  test("Fastify contract errors drop the request values that verbose validation attached", async () => {
    const token = "sensitive-validation-token";
    // The app's own Ajv options (verbose, so each failure carries its value) and error handler
    // judge this body. onError keeps a reference to the error; after the response it holds what
    // any later log of the error would see.
    const seen: (Error & { readonly validation?: unknown })[] = [];
    const { result: invalid, lines } = await withLoggingApp(
      "debug",
      true,
      undefined,
      async (app) => {
        app.addHook("onError", async (_request, _reply, error) => {
          seen.push(error);
        });
        app.post(
          "/validated",
          {
            schema: {
              body: {
                type: "object",
                properties: { token: { type: "string", maxLength: 4 } },
                required: ["token"],
                additionalProperties: false,
              },
            },
          },
          async () => ({}),
        );
        return app.inject({ method: "POST", url: "/validated", payload: { token } });
      },
    );

    assert.equal(invalid.statusCode, 400);
    const error = asRecord(asRecord(invalid.json<unknown>())?.error);
    assert.ok(error);
    assert.deepEqual(error.details, [{ path: "/token", code: "TOO_LONG" }]);
    assert.equal(seen.length, 1);
    const [observed] = seen;
    assert.ok(observed);
    const { validation } = observed;
    assert.ok(Array.isArray(validation));
    const entries: readonly unknown[] = validation;
    for (const entry of entries) {
      const detail = asRecord(entry);
      assert.ok(detail);
      assert.deepEqual(
        ["data", "schema", "parentSchema"].filter((key) => Object.hasOwn(detail, key)),
        [],
      );
    }
    assert.equal(JSON.stringify(observed).includes(token), false);
    assert.equal(invalid.body.includes(token), false);
    assert.equal(JSON.stringify(lines).includes(token), false);
  });

  test("a refused API key logs one structured line without the key, not the library's console block", async (t) => {
    const consoleCalls = ["error", "warn", "log", "info", "debug"].map((method) =>
      t.mock.method(console, method as "error" | "warn" | "log" | "info" | "debug", () => {}),
    );
    const forged = `occ_${randomBytes(24).toString("hex")}`;
    let revoked = "";
    let revokedId = "";
    // A browser cookie sent next to the key: request data a refusal line must never carry.
    // (This route refuses a query string before admission; the unit case below covers it.)
    const cookie = `session_${randomBytes(12).toString("hex")}`;
    const answers: { readonly requestId: unknown; readonly error: unknown }[] = [];
    const { lines } = await withLoggingApp("info", false, undefined, async (app, auth) => {
      const issued = await auth.createServiceKey({
        principal: {
          kind: "service_principal",
          id: `logging-automation-${randomUUID()}`,
          namespaceId: `ns_${randomUUID()}`,
        },
        name: "logging-proof",
      });
      await auth.revokeServiceKey(issued);
      revoked = issued.key;
      revokedId = issued.id;
      for (const key of [forged, revoked]) {
        const refused = await app.inject({
          method: "GET",
          url: "/namespaces/ns_00000000-0000-4000-8000-000000000001",
          headers: { "x-api-key": key, cookie: `${auth.sessionCookieName}=${cookie}` },
        });
        assert.equal(refused.statusCode, 401, refused.body);
        const body = asRecord(refused.json<unknown>());
        answers.push({ requestId: asRecord(body?.meta)?.requestId, error: body?.error });
      }
    });

    assert.deepEqual(
      consoleCalls.map((call) => call.mock.callCount()),
      [0, 0, 0, 0, 0],
      "the auth library must not print to the console",
    );
    // A revoked key's row is deleted, so the library cannot tell it from a forged one: both
    // callers get the same answer, and the log does not claim more than the library knows.
    assert.deepEqual(answers[0]?.error, answers[1]?.error);
    const refusals = lines.filter((line) => line.event === "authentication.request-refused");
    // Each refusal names the request the caller was answered with, its method and route
    // pattern, so an operator can match it to the 401 a caller reports.
    assert.deepEqual(
      refusals.map(({ time: _time, ...line }) => line),
      answers.map(({ requestId }) => ({
        severity: "INFO",
        service: "occ-api",
        event: "authentication.request-refused",
        operation: "verify-api-key",
        requestId,
        method: "GET",
        route: "/namespaces/:namespaceId",
        reasonCode: "INVALID_API_KEY",
      })),
    );
    assert.match(String(answers[0]?.requestId), /^req_[0-9a-f-]{36}$/);
    assert.equal(
      lines.filter((line) => String(line.event).startsWith("authentication.library-")).length,
      0,
    );
    assert.deepEqual(
      lines.filter((line) => line.event === "http.completed").map(({ status }) => status),
      [401, 401],
    );
    const logged = JSON.stringify(lines);
    assert.ok(revoked.length > 0 && revokedId.length > 0);
    // No key, key prefix beyond the fixed `occ_`, key ID or cookie value.
    for (const secret of [forged, revoked, forged.slice(0, 12), revoked.slice(0, 12), revokedId]) {
      assert.equal(logged.includes(secret), false, "no key material is logged");
    }
    assert.equal(logged.includes(cookie), false, "no cookie value is logged");
  });

  test("an unexpected auth library error stays a structured ERROR with only its code", () => {
    const { logger, lines } = captureLogs("occ-api", "info");
    const log = authLibraryLog((event) => emitOccLogEvent(logger, event));
    log(
      "error",
      "Failed to delete expired API keys:",
      Object.assign(new Error("select * from apikey where key = 'occ_secret'"), {
        code: "ECONNRESET",
      }),
    );
    assert.equal(lines.length, 1);
    const { time, ...line } = logAt(lines, 0);
    assert.ok(time);
    assert.deepEqual(line, {
      severity: "ERROR",
      service: "occ-api",
      event: "authentication.library-error",
      operation: "unattributed",
      reasonCode: "ECONNRESET",
    });
  });

  test("auth library error lines name the failed operation and request, never the library's text", () => {
    const { logger, lines } = captureLogs("occ-api", "info");
    const emit = (event: Readonly<Record<string, unknown>>) => emitOccLogEvent(logger, event);
    const log = authLibraryLog(emit);
    const requestId = `req_${randomUUID()}`;
    // What library messages and errors can carry: an email address, an origin with a query,
    // a session ID and cookie, and an API key with its ID.
    const email = `person-${randomBytes(4).toString("hex")}@example.com`;
    const query = `token=${randomBytes(8).toString("hex")}`;
    const sessionId = randomBytes(16).toString("hex");
    const cookie = `__Secure-openclaw_occ_shared.session_token=${sessionId}`;
    const key = `occ_${randomBytes(24).toString("hex")}`;
    const keyId = randomBytes(16).toString("hex");
    const text = `Invalid origin: https://evil.example/?${query} for ${email} ${cookie} ${key} ${keyId}`;
    class DatabaseError extends Error {
      readonly code = "57P01";
    }
    // The query builder's wrapper, as the Postgres adapter throws it.
    class DrizzleQueryError extends Error {}

    withAuthLogContext(
      "sign-in-password",
      { requestId, method: "POST", route: "/auth/sign-in/email" },
      () => {
        // A message-only call (Better Auth's origin check and failed session create).
        log("error", text);
        // A PostgreSQL error: its SQLSTATE starts with a digit, so it is kept as `code`
        // and the class name stands in as the reason.
        log("error", text, new DatabaseError(text), { cookie, email, sessionId, key, keyId });
        log("error", text, new DrizzleQueryError(text, { cause: new DatabaseError(text) }));
        // A code that is not an identifier falls back to the class name.
        log("error", text, Object.assign(new TypeError(text), { code: `${email} ${query}` }));
        log("warn", text, text);
      },
    );
    // An exception the router throws to OCE; outside every operation it says so.
    emit(authLibraryFailureEvent(Object.assign(new Error(text), { body: { message: text } })));

    const scoped = (severity: string, fields: Readonly<Record<string, string>> = {}) => ({
      severity,
      service: "occ-api",
      event:
        severity === "WARN" ? "authentication.library-warning" : "authentication.library-error",
      operation: "sign-in-password",
      requestId,
      method: "POST",
      route: "/auth/sign-in/email",
      ...fields,
    });
    assert.deepEqual(
      lines.map(({ time: _time, ...line }) => line),
      [
        scoped("ERROR"),
        scoped("ERROR", { reasonCode: "DatabaseError", code: "57P01" }),
        scoped("ERROR", { reasonCode: "DrizzleQueryError", code: "57P01" }),
        scoped("ERROR", { reasonCode: "TypeError" }),
        scoped("WARN"),
        {
          severity: "ERROR",
          service: "occ-api",
          event: "authentication.library-error",
          operation: "unattributed",
          reasonCode: "Error",
        },
      ],
    );
    const logged = JSON.stringify(lines);
    for (const secret of [email, query, sessionId, cookie, key, key.slice(0, 12), keyId, "evil"]) {
      assert.equal(logged.includes(secret), false, "no library text or request data is logged");
    }
  });

  test("the structured log keeps a request ID and route pattern, not a path with a query", () => {
    const { logger, lines } = captureLogs("occ-api", "info");
    const requestId = `req_${randomUUID()}`;
    emitOccLogEvent(logger, {
      event: "authentication.request-refused",
      requestId,
      route: "/agents/:agentId/chat",
    });
    emitOccLogEvent(logger, {
      event: "authentication.request-refused",
      requestId: `${requestId}?token=secret`,
      route: "/agents/a1/chat?token=secret",
    });
    assert.deepEqual(
      lines.map((line) => [line.requestId, line.route]),
      [
        [requestId, "/agents/:agentId/chat"],
        [undefined, undefined],
      ],
    );
  });
}
