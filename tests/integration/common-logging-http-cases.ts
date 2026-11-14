import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { createControllerAuth } from "../../apps/controller/src/auth/index.ts";
import { createFastifyApp, type ControllerAppOptions } from "../../apps/controller/src/index.ts";
import type { LoggingConfiguration } from "../../apps/controller/src/logging.ts";
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
  exercise: (app: ReturnType<typeof createFastifyApp>) => Promise<Result>,
) {
  const { logger, lines } = captureLogs("occ-api", level);
  const installationId = `ins_${randomUUID()}`;
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
    auth: createControllerAuth({
      mode: "development",
      installationId,
      baseURL: "https://occ.oce.localhost",
      agentDomain: "agents.oce.localhost",
      secret: randomBytes(32).toString("hex"),
      memoryDatabase: { user: [], session: [], account: [], verification: [], apikey: [] },
    }),
    logger,
    ...(trustedProxies === undefined ? {} : { trustedProxies }),
  });
  try {
    return { result: await exercise(app), lines };
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
}
