// Runs inside the selected controller image; all product modules come from /app.
// Passive Compute covers namespace queue settlement, not real workload execution.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createFastifyApp } from "/app/apps/controller/src/index.ts";
import { createPostgresControllerAuth } from "/app/apps/controller/src/auth/index.ts";
import { resolveApprovedHarness } from "/app/apps/controller/src/composition/production-harness.ts";
import { PostgresPlatformState, OpenClawController } from "/app/packages/occ/src/index.ts";
import { createControllerWorker } from "/app/apps/controller/src/worker.ts";
import { createReadyComputeDriver } from "./development.ts";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { NativeIAMDriver } from "/app/packages/iam/src/index.ts";

const { Pool } = createRequire("/app/packages/occ/package.json")("pg");
const pool = new Pool({ connectionString: process.env.OCC_DATABASE_URL });
const state = new PostgresPlatformState(pool);
const installation = await state.loadInstallation();
const candidate = process.env.OCC_TEST_CONTROLLER_ROLE === "candidate";
const preparedTokens = candidate
  ? new (await import("/app/apps/controller/src/backends/token-service/service.ts")).TokenService()
  : undefined;
const controller = new OpenClawController(installation, {
  state,
  ...(candidate ? { preparedTokens } : {}),
});
const iamDriver = new NativeIAMDriver(state, { id: "compatibility-iam" });
controller.registerDriver(iamDriver);
controller.selectDriver("iam", iamDriver.id);
const auth = await createPostgresControllerAuth({
  mode: "development",
  installationId: installation.id,
  baseURL: "http://127.0.0.1",
  secret: "local-compatibility-session-secret-32-bytes",
  pool,
});
const computeDriver = createReadyComputeDriver("compatibility-compute", {
  async stopRevision() {
    throw new Error("Unexpected revision stop in namespace-only proof");
  },
});
controller.registerDriver(computeDriver);
controller.selectDriver("compute", computeDriver.id);
if (candidate) {
  const { createTestSecretDriver } = await import("./secret-driver.ts");
  const secretDriver = createTestSecretDriver();
  controller.registerDriver(secretDriver);
  controller.selectDriver("secret", secretDriver.id);
  const { OAuthAccountTokens } =
    await import("/app/apps/controller/src/backends/token-service/oauth-connection.ts");
  preparedTokens.registerIssuer(
    new OAuthAccountTokens(
      state,
      secretDriver,
      controller.resolveConnectionClient.bind(controller),
    ),
  );
}
const worker = createControllerWorker({
  pool,
  computeDriver,
  pollIntervalMs: 25,
  emit: (event) => console.log(JSON.stringify({ workerEvent: event })),
});
await worker.start();
const app = createFastifyApp({
  controller,
  iamDriver,
  computeDriver,
  resolveHarness: resolveApprovedHarness,
  auditSink: state.auditSink,
  auth,
  publicOrigin: "https://occ-connections.test",
  development: { enabled: false },
});
const inputLines = createInterface({ input: process.stdin });
try {
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    headers: { host: "127.0.0.1" },
    payload: { email: "postgres-admin@openclaw.local", password: "postgres-development-password" },
  });
  assert.equal(login.statusCode, 200, login.body);
  const raw = login.headers["set-cookie"];
  const cookie = (Array.isArray(raw) ? raw : [raw]).map((x) => x.split(";")[0]).join("; ");
  const headers = { host: "127.0.0.1", origin: "http://127.0.0.1", cookie };
  console.log(JSON.stringify({ ready: true, pid: process.pid }));
  for await (const line of inputLines) {
    const input = JSON.parse(line);
    if (input.op === "stop") {
      break;
    }
    if (input.op === "connection") {
      const template = await app.inject({
        method: "POST",
        url: "/connection-templates",
        headers,
        payload: {
          namespaceId: input.namespaceId,
          displayName: "Compatibility",
          mode: "manual",
          issuer: "https://issuer.example.test",
          authorizationUrl: "https://issuer.example.test/authorize",
          tokenUrl: "https://issuer.example.test/token",
          destinations: [{ host: "api.example.test", port: 443, path: "/" }],
          scopes: ["read"],
        },
      });
      assert.equal(template.statusCode, 201, template.body);
      const data = template.json().data;
      const registration = await app.inject({
        method: "POST",
        url: "/oauth-clients",
        headers,
        payload: {
          connectionTemplateId: data.id,
          connectionTemplateVersion: data.current.version,
          displayName: "Compatibility client",
          clientId: "compatibility-public-client",
          tokenEndpointAuthMethod: "none",
        },
      });
      assert.equal(registration.statusCode, 201, registration.body);
      const started = await app.inject({
        method: "POST",
        url: `/namespaces/${input.namespaceId}/connections`,
        headers,
        payload: { connectionTemplateId: data.id },
      });
      assert.equal(started.statusCode, 201, started.body);
      const sourceId = started.json().data.credentialSourceId;
      const current = await app.inject({
        method: "GET",
        url: `/namespaces/${input.namespaceId}/credential-sources`,
        headers,
      });
      assert.equal(current.statusCode, 200, current.body);
      assert.ok(current.json().data.some((source) => source.id === sourceId));
      console.log(
        JSON.stringify({
          response: input.id,
          status: 201,
          readStatus: current.statusCode,
          sourceId,
          listedSourceIds: current.json().data.map((source) => source.id),
        }),
      );
    } else if (input.op === "work") {
      const write = await app.inject({
        method: "POST",
        url: "/namespaces",
        headers,
        payload: { name: input.name },
      });
      assert.equal(write.statusCode, 201, write.body);
      const id = write.json().data.id;
      let result;
      for (let i = 0; i < 200; i++) {
        result = await app.inject({ method: "GET", url: `/namespaces/${id}`, headers });
        assert.equal(result.statusCode, 200, result.body);
        if (result.json().data.status === "ready") {
          break;
        }
        await delay(25);
      }
      assert.equal(result.json().data.status, "ready");
      console.log(
        JSON.stringify({ response: input.id, status: 201, namespaceId: id, workerSettled: true }),
      );
    } else {
      assert.equal(input.op, "read");
      const result = await app.inject({
        method: "GET",
        url: `/namespaces/${input.namespaceId}/credential-sources`,
        headers,
      });
      console.log(
        JSON.stringify({
          response: input.id,
          status: result.statusCode,
          errorCode: result.json().error?.code ?? null,
          listedSourceIds:
            result.statusCode === 200 ? result.json().data.map((source) => source.id) : [],
        }),
      );
    }
  }
} finally {
  inputLines.close();
  process.stdin.pause();
  await app.close();
  await worker.stop();
  console.log(JSON.stringify({ shutdown: true }));
}
