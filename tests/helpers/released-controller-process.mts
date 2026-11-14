// Runs inside the selected controller image; all product modules come from /app.
// Passive Compute covers namespace queue settlement, not real workload execution.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

import type { Static } from "typebox";
import type { ConnectionTemplate } from "../../packages/contracts/src/index.ts";
import type { ErrorResponse } from "../../packages/contracts/src/api/common.ts";
import type { ConnectionStartResponse } from "../../packages/contracts/src/api/connections.ts";
import type {
  CredentialSourceListResponse,
  NamespaceResponse,
} from "../../packages/contracts/src/api/resources.ts";
import type { PreparedAuthAccount } from "../../apps/controller/src/auth/index.ts";
import { controllerIAMConfiguration, defaultUsersIAM } from "./default-users-iam.mjs";
import { createReadyComputeDriver } from "./development.ts";

type NamespaceId = NamespaceResponse["data"]["id"];
type ProcessRequest =
  | { op: "stop" }
  | ({ id: string } & (
      | { op: "namespace" | "connection" | "read"; namespaceId: NamespaceId }
      | { op: "member-controls"; namespaceId: NamespaceId; outsideId: NamespaceId }
      | { op: "work"; name: string }
    ));

function liveCookie(header: string | string[] | undefined): string {
  const cookies = Array.isArray(header) ? header : header === undefined ? [] : [header];
  const cookie = cookies
    .filter((value) => !/Max-Age=0(?:;|$)/i.test(value))
    .map((value) => value.split(";", 1)[0])
    .join("; ");
  assert.ok(cookie, "Password sign-in must issue a live session cookie.");
  return cookie;
}

// Computed specifiers keep these runtime imports inside the selected image.
// The relative type queries are erased by the image's Node.
const controllerPath = "/app/apps/controller/src";
const { createFastifyApp }: typeof import("../../apps/controller/src/index.ts") = await import(
  `${controllerPath}/index.ts`
);
const controllerAuth: typeof import("../../apps/controller/src/auth/index.ts") = await import(
  `${controllerPath}/auth/index.ts`
);
const {
  resolveApprovedHarness,
}: typeof import("../../apps/controller/src/composition/production-harness.ts") = await import(
  `${controllerPath}/composition/production-harness.ts`
);
const { createControllerWorker }: typeof import("../../apps/controller/src/worker.ts") =
  await import(`${controllerPath}/worker.ts`);
const occPackage = "/app/packages/occ";
const iamPackage = "/app/packages/iam";
const {
  PostgresPlatformState,
  OpenClawController,
}: typeof import("../../packages/occ/src/index.ts") = await import(`${occPackage}/src/index.ts`);
const { NativeIAMDriver }: typeof import("../../packages/iam/src/index.ts") = await import(
  `${iamPackage}/src/index.ts`
);
const { Pool }: typeof import("pg") = createRequire(`${occPackage}/package.json`)("pg");
const databaseUrl = process.env.OCC_DATABASE_URL;
assert.ok(databaseUrl, "The image must receive its disposable database URL.");
const pool = new Pool({ connectionString: databaseUrl });
const state = new PostgresPlatformState(pool);
const installation = await state.loadInstallation();
assert.ok(installation, "The selected image must load the bootstrapped Installation.");
const candidate = process.env.OCC_TEST_CONTROLLER_ROLE === "candidate";
const configuredIAM = process.env.OCC_TEST_CONTROLLER_IAM === "1";
const baseURL = process.env.OCC_AUTH_BASE_URL;
const agentDomain = process.env.OCC_AGENT_NATIVE_ADMIN_DOMAIN;
assert.ok(
  baseURL && agentDomain,
  "The image must receive its selected browser origin and Agent domain.",
);
const {
  TokenService,
}: Partial<typeof import("../../apps/controller/src/backends/token-service/service.ts")> = candidate
  ? await import(`${controllerPath}/backends/token-service/service.ts`)
  : {};
const preparedTokens = TokenService === undefined ? undefined : new TokenService();
const controller = new OpenClawController(installation, {
  state,
  ...(configuredIAM
    ? {
        iamConfiguration: controllerIAMConfiguration({
          ...defaultUsersIAM(),
          roleBindings: [
            {
              group: "default-user",
              role: "agent_creator",
              scope: { namespace: "Compatibility allowed" },
            },
          ],
        }),
      }
    : {}),
  ...(preparedTokens === undefined ? {} : { preparedTokens }),
});
const iamDriver = new NativeIAMDriver(state, { id: "compatibility-iam" });
controller.registerDriver(iamDriver);
controller.selectDriver("iam", iamDriver.id);
const provisionAuthAccount = configuredIAM
  ? controllerAuth.createPostgresAuthAccountProvisioner?.({
      state,
      installationId: installation.id,
    })
  : undefined;
if (configuredIAM) {
  assert.ok(
    provisionAuthAccount,
    "Configured IAM requires the image's PostgreSQL account provisioner.",
  );
}
const auth = await controllerAuth.createPostgresControllerAuth({
  mode: "development",
  installationId: installation.id,
  baseURL,
  agentDomain,
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
if (preparedTokens !== undefined) {
  const { createTestSecretDriver } = await import("./secret-driver.ts");
  const secretDriver = createTestSecretDriver();
  controller.registerDriver(secretDriver);
  controller.selectDriver("secret", secretDriver.id);
  const {
    OAuthAccountTokens,
  }: typeof import("../../apps/controller/src/backends/token-service/oauth-connection.ts") =
    await import(`${controllerPath}/backends/token-service/oauth-connection.ts`);
  preparedTokens.registerIssuer(
    new OAuthAccountTokens(
      state,
      secretDriver,
      controller.resolveConnectionClient.bind(controller),
    ),
  );
}
if (configuredIAM) {
  // This is the same configured-policy write the production composition makes at startup.
  await controller.applyIAMConfiguration();
}
const worker = createControllerWorker({
  pool,
  computeDriver,
  pollIntervalMs: 25,
  emit: (event) => console.log(JSON.stringify({ workerEvent: event })),
});
await worker.start();
const app = createFastifyApp({
  ...(provisionAuthAccount ? { provisionAuthAccount } : {}),
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
  const cookie = liveCookie(login.headers["set-cookie"]);
  const headers = { host: "127.0.0.1", origin: baseURL, cookie };
  const session = await app.inject({ method: "GET", url: "/api/auth/session", headers });
  assert.equal(session.statusCode, 200, session.body);
  const { data: sessionData } = session.json<{
    data: { user: Pick<PreparedAuthAccount, "id"> } | null;
  }>();
  assert.ok(sessionData, "Password sign-in must produce an authenticated session.");
  const accountId = sessionData.user.id;
  assert.equal(typeof accountId, "string");
  assert.ok(accountId.length > 0, "The authenticated session must identify an account.");
  console.log(JSON.stringify({ ready: true, pid: process.pid, accountId }));
  for await (const line of inputLines) {
    // The host sends only these requests over the container's private stdin.
    const input: ProcessRequest = JSON.parse(line);
    if (input.op === "stop") {
      break;
    }
    if (input.op === "namespace") {
      const result = await app.inject({
        method: "GET",
        url: `/namespaces/${input.namespaceId}`,
        headers,
      });
      if (result.statusCode === 200) {
        assert.equal(result.json<NamespaceResponse>().data.id, input.namespaceId);
      }
      console.log(
        JSON.stringify({
          response: input.id,
          namespaceId: input.namespaceId,
          status: result.statusCode,
          errorCode: result.json<Partial<ErrorResponse>>().error?.code ?? null,
        }),
      );
    } else if (input.op === "member-controls") {
      // Provision through the account API: configured default membership must be applied
      // by the real account transaction, not a fixture-written Group membership.
      const credentials = {
        email: "compatibility-member@example.com",
        password: "local-compatibility-member-password",
      };
      const created = await app.inject({
        method: "POST",
        url: "/api/auth/accounts",
        headers,
        payload: credentials,
      });
      assert.equal(created.statusCode, 201, created.body);
      const signedIn = await app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        headers: { host: "127.0.0.1" },
        payload: credentials,
      });
      assert.equal(signedIn.statusCode, 200, signedIn.body);
      const memberCookie = liveCookie(signedIn.headers["set-cookie"]);
      const results = [];
      for (const namespaceId of [input.namespaceId, input.outsideId]) {
        const result = await app.inject({
          method: "GET",
          url: `/namespaces/${namespaceId}`,
          headers: { ...headers, cookie: memberCookie },
        });
        results.push({
          namespaceId,
          status: result.statusCode,
          errorCode: result.json<Partial<ErrorResponse>>().error?.code ?? null,
        });
      }
      console.log(
        JSON.stringify({
          response: input.id,
          accountId: created.json<{ data: Pick<PreparedAuthAccount, "id"> }>().data.id,
          results,
        }),
      );
    } else if (input.op === "connection") {
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
      const data = template.json<{ data: ConnectionTemplate }>().data;
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
      const sourceId =
        started.json<Static<typeof ConnectionStartResponse>>().data.credentialSourceId;
      const current = await app.inject({
        method: "GET",
        url: `/namespaces/${input.namespaceId}/credential-sources`,
        headers,
      });
      assert.equal(current.statusCode, 200, current.body);
      const listedSourceIds = current.json<CredentialSourceListResponse>().data.map(({ id }) => id);
      assert.ok(listedSourceIds.includes(sourceId));
      console.log(
        JSON.stringify({
          response: input.id,
          status: 201,
          readStatus: current.statusCode,
          sourceId,
          listedSourceIds,
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
      const id = write.json<NamespaceResponse>().data.id;
      let status: NamespaceResponse["data"]["status"] | undefined;
      for (let i = 0; i < 200; i++) {
        const result = await app.inject({ method: "GET", url: `/namespaces/${id}`, headers });
        assert.equal(result.statusCode, 200, result.body);
        status = result.json<NamespaceResponse>().data.status;
        if (status === "ready") {
          break;
        }
        await delay(25);
      }
      assert.equal(status, "ready");
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
          errorCode: result.json<Partial<ErrorResponse>>().error?.code ?? null,
          listedSourceIds:
            result.statusCode === 200
              ? result.json<CredentialSourceListResponse>().data.map(({ id }) => id)
              : [],
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
