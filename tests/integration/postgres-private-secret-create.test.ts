import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, test, type TestContext } from "node:test";
import type { Installation, OAuthClient } from "../../packages/contracts/src/index.ts";
import { createBootstrapAdministratorSeed, NativeIAMDriver } from "../../packages/iam/src/index.ts";
import {
  createPostgresPool,
  OpenClawController,
  PostgresPlatformState,
} from "../../packages/occ/src/index.ts";
import { createPostgresControllerAuth } from "../../apps/controller/src/auth/index.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import { commitAckProxy } from "../fixtures/postgres-commit-ack-proxy.mjs";
import { useInstallationSecretDriver } from "../helpers/kubernetes-secret-core.mjs";
import { databaseUrl, requiresPostgres } from "../helpers/postgres-database.mjs";
import { waitFor } from "../helpers/wait-for.mjs";

const origin = "https://console.oce.localhost";
const authSecret = "private-test-auth-" + randomUUID();
const administrator = {
  email: "private-create-" + randomUUID() + "@example.test",
  password: "private-test-auth-" + randomUUID(),
};
let installation: Installation;
const inventedValue = () => "private-test-value-" + randomUUID();
const manual = {
  displayName: "Private registration",
  mode: "manual",
  issuer: "https://accounts.example.test",
  authorizationUrl: "https://accounts.example.test/authorize",
  tokenUrl: "https://accounts.example.test/token",
  scopes: ["mail.read"],
  destinations: [{ host: "mail.example.test", path: "/v1/**" }],
};
const authOptions = (id: string) => ({
  mode: "development" as const,
  installationId: id,
  baseURL: origin,
  agentDomain: "agents.oce.localhost",
  secret: authSecret,
});

before(async () => {
  if (!databaseUrl) {
    return;
  }
  const pool = await createPostgresPool(databaseUrl);
  try {
    const state = new PostgresPlatformState(pool);
    assert.equal(await state.loadInstallation(), undefined, "the file owns a fresh database");
    installation = {
      id: "ins_" + randomUUID(),
      name: "Private registration integration",
      createdAt: new Date().toISOString(),
    };
    const auth = await createPostgresControllerAuth({ ...authOptions(installation.id), pool });
    const account = await auth.createAccount({
      ...administrator,
      name: "Registration administrator",
    });
    const seed = createBootstrapAdministratorSeed(installation.id, auth.issuer, account);
    state.setBootstrapNativeIAM({
      identities: [seed.principal, seed.servicePrincipal],
      groups: [],
      memberships: [],
      roles: seed.roles,
      bindings: seed.bindings,
      restrictions: [],
    });
    const controller = new OpenClawController(installation, { state });
    const iam = new NativeIAMDriver(state);
    controller.registerDriver(iam);
    controller.selectDriver("iam", iam.id);
    // The normal first controller transaction persists the server-owned Installation and IAM seed.
    await controller.createNamespace(seed.principal.id, { name: "Default" });
    assert.equal((await state.loadInstallation())?.id, installation.id);
    const role = await pool.query(
      "SELECT current_user AS role, rolsuper FROM pg_roles WHERE rolname=current_user",
    );
    assert.equal(role.rows[0].role, "occ_app");
    assert.equal(role.rows[0].rolsuper, false);
  } finally {
    await pool.end();
  }
});

async function fixture(t: TestContext, transportUrl = databaseUrl) {
  assert.ok(databaseUrl && transportUrl);
  const pool = await createPostgresPool(databaseUrl);
  const transport = transportUrl === databaseUrl ? pool : await createPostgresPool(transportUrl);
  const state = new PostgresPlatformState(transport);
  const controller = new OpenClawController(installation, { state });
  const iam = new NativeIAMDriver(state);
  controller.registerDriver(iam);
  controller.selectDriver("iam", iam.id);
  const { core, driver } = useInstallationSecretDriver(controller);
  const auth = await createPostgresControllerAuth({
    ...authOptions(installation.id),
    pool: transport,
    state,
    iamDriver: iam,
  });
  const app = createFastifyApp({
    controller,
    iamDriver: iam,
    resolveHarness: resolveApprovedHarness,
    auditSink: state.auditSink,
    auth,
    development: { enabled: true, installationId: installation.id, browserOrigin: origin },
  });
  t.after(async () => {
    await app.close();
    if (transport !== pool) {
      await transport.end();
    }
    await pool.end();
  });
  const baseHeaders = { origin, host: new URL(origin).host, "content-type": "application/json" };
  const signIn = async (account: typeof administrator) => {
    const result = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: baseHeaders,
      payload: JSON.stringify(account),
    });
    assert.equal(result.statusCode, 200, "genuine password sign-in");
    const cookies = result.headers["set-cookie"];
    const cookie = (Array.isArray(cookies) ? cookies : [cookies])
      .filter((x): x is string => typeof x === "string")
      .map((x) => x.split(";")[0])
      .join("; ");
    assert.ok(cookie);
    return { ...baseHeaders, cookie };
  };
  const headers = await signIn(administrator);
  const inject = (
    method: "GET" | "POST" | "PATCH" | "DELETE",
    url: string,
    payload?: unknown,
    selectedHeaders: Record<string, string> = headers,
  ) =>
    app.inject({
      method,
      url,
      headers:
        payload === undefined
          ? Object.fromEntries(
              Object.entries(selectedHeaders).filter(([key]) => key !== "content-type"),
            )
          : selectedHeaders,
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    });
  const draft = async () => {
    const response = await inject("POST", "/connection-templates", manual);
    assert.equal(response.statusCode, 201, "manual template created");
    return response.json<{ data: { id: string } }>().data.id;
  };
  const input = (templateId: string, version = 1) => ({
    connectionTemplateId: templateId,
    connectionTemplateVersion: version,
    displayName: "Private client",
    clientId: randomUUID(),
    tokenEndpointAuthMethod: "client_secret_basic" as const,
    clientSecret: inventedValue(),
  });
  const row = async (clientId: string) =>
    (
      await pool.query<{ id: string; secret_driver_id: string; hidden: boolean; due: boolean }>(
        "SELECT id,secret_driver_id,cleanup_after IS NOT NULL AS hidden,cleanup_after<=now() AS due FROM occ.oauth_clients WHERE client_id=$1",
        [clientId],
      )
    ).rows[0];
  const due = async (clientId: string) => {
    assert.equal(
      (
        await pool.query(
          "UPDATE occ.oauth_clients SET cleanup_after=now() WHERE client_id=$1 AND cleanup_after IS NOT NULL",
          [clientId],
        )
      ).rowCount,
      1,
    );
  };
  const recoveryState = new PostgresPlatformState(pool);
  const recovered = new OpenClawController(installation, { state: recoveryState });
  recovered.registerDriver(driver);
  recovered.selectDriver("secret", driver.id);
  const absentFromPublic = async (value: string, clientId: string) => {
    const response = await inject("GET", "/oauth-clients");
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.includes(value), false);
    assert.equal(response.body.includes(driver.id), false);
    assert.equal(
      response
        .json<{ data: Array<{ clientId: string }> }>()
        .data.some((x) => x.clientId === clientId),
      false,
    );
    const audit = await pool.query("SELECT details FROM occ.audit_events");
    assert.equal(JSON.stringify(audit.rows).includes(value), false);
  };
  return {
    app,
    auth,
    pool,
    state,
    controller,
    core,
    driver,
    recovered,
    inject,
    draft,
    input,
    row,
    due,
    absentFromPublic,
    signIn,
    baseHeaders,
  };
}
type FailedResponse = { body: string; json<T>(): T };
function assertPrivateMaterialAbsent(
  response: FailedResponse,
  clientSecret: string,
  privateDriverId: string,
) {
  assert.equal(response.body.includes(clientSecret), false);
  assert.equal(response.body.includes(privateDriverId), false);
}
function assertSanitizedPrivateFailure(
  response: FailedResponse,
  clientSecret: string,
  privateDriverId: string,
  expectedCode: "NOT_FOUND" | "DEPENDENCY_UNAVAILABLE",
  expectedMessage = expectedCode === "NOT_FOUND"
    ? "The requested platform resource was not found."
    : "A required platform dependency is unavailable.",
) {
  const error = response.json<{ error: { code: string; message: string } }>().error;
  assert.equal(error.code, expectedCode);
  assert.equal(error.message, expectedMessage);
  assertPrivateMaterialAbsent(response, clientSecret, privateDriverId);
}
function observation(t: TestContext, value: Record<string, string | number | boolean | null>) {
  t.diagnostic("PRIVATE_CREATE_OBSERVATION " + JSON.stringify(value));
}
type CreateRequest = { namespace: string; body: { metadata: { name: string } } };
type DeleteRequest = {
  namespace: string;
  name: string;
  body: { preconditions?: { uid?: string; resourceVersion?: string } };
};

test(
  "a refused Installation-private create removes only its exact Kubernetes object",
  requiresPostgres,
  async (t) => {
    const f = await fixture(t);
    const input = f.input(await f.draft());
    const create = f.core.createNamespacedSecret.bind(f.core);
    let key = "";
    t.mock.method(
      f.core,
      "createNamespacedSecret",
      async (request: CreateRequest) => {
        const result = await create(request);
        key = request.namespace + "/" + request.body.metadata.name;
        f.core.secrets.get(key).immutable = true;
        return { ...result, immutable: true };
      },
      { times: 1 },
    );
    const response = await f.inject("POST", "/oauth-clients", input);
    assert.equal(response.statusCode, 404);
    assertSanitizedPrivateFailure(response, input.clientSecret, f.driver.id, "NOT_FOUND");
    const reserved = await f.row(input.clientId);
    assert.ok(reserved?.hidden);
    assert.equal(reserved.secret_driver_id, f.driver.id);
    await f.absentFromPublic(input.clientSecret, input.clientId);
    const immediatelyAbsent = !f.core.secrets.has(key);
    const immediateDeletes = f.core.calls.deleteNamespacedSecret;
    await f.due(input.clientId);
    await f.recovered.cleanupOAuthClients();
    const remaining = await f.row(input.clientId);
    observation(t, {
      case: "refused-create",
      status: response.statusCode,
      immediateDeletes,
      immediatelyAbsent,
      hiddenReservationObserved: true,
      cleanupRowRetained: !!remaining,
      cleanupRescheduled: remaining?.due === false,
      objectRemainsAfterCleanup: f.core.secrets.has(key),
    });
    assert.equal(
      immediatelyAbsent,
      true,
      "a successful but refused create must not retain its exact object",
    );
    assert.equal(immediateDeletes, 1);
    assert.deepEqual(f.core.deletes, [{ uid: "uid-1", resourceVersion: "1" }]);
    assert.equal(remaining, undefined);
  },
);

test(
  "Installation-private refused-create compensation preserves replacements and unknown outcomes",
  requiresPostgres,
  async (t) => {
    const cases = [
      "uid-replacement",
      "version-change",
      "missing-uid",
      "missing-version",
      "delete-403",
      "delete-503",
      "delete-dropped",
      "same-name-absent",
      "alternate-name-absent",
      "create-request-failed",
    ] as const;
    for (const scenario of cases) {
      await t.test(scenario, async (s) => {
        const f = await fixture(s);
        const input = f.input(await f.draft());
        const create = f.core.createNamespacedSecret.bind(f.core);
        const remove = f.core.deleteNamespacedSecret.bind(f.core);
        let key = "";
        let requestName = "";
        let attempted:
          { name: string; namespace: string; uid?: string; resourceVersion?: string } | undefined;
        s.mock.method(
          f.core,
          "createNamespacedSecret",
          async (request: CreateRequest) => {
            const result = await create(request);
            requestName = request.body.metadata.name;
            key = request.namespace + "/" + requestName;
            f.core.secrets.get(key).immutable = true;
            result.immutable = true;
            if (scenario === "missing-uid") {
              delete result.metadata.uid;
            }
            if (scenario === "missing-version") {
              delete result.metadata.resourceVersion;
            }
            if (scenario === "same-name-absent" || scenario === "alternate-name-absent") {
              f.core.secrets.delete(key);
            }
            if (scenario === "alternate-name-absent") {
              result.metadata.name += "-other";
            }
            if (scenario === "create-request-failed") {
              throw Object.assign(new Error("create response lost"), { code: 503 });
            }
            return result;
          },
          { times: 1 },
        );
        s.mock.method(
          f.core,
          "deleteNamespacedSecret",
          async (request: DeleteRequest) => {
            attempted = {
              name: request.name,
              namespace: request.namespace,
              ...request.body?.preconditions,
            };
            if (scenario === "uid-replacement") {
              f.core.secrets.get(key).metadata.uid = "replacement";
            }
            if (scenario === "version-change") {
              f.core.secrets.get(key).metadata.resourceVersion = "2";
            }
            if (scenario === "delete-403" || scenario === "delete-503") {
              f.core.failureCodes.deleteNamespacedSecret.push(
                scenario === "delete-403" ? 403 : 503,
              );
            }
            const result = await remove(request);
            if (scenario === "delete-dropped") {
              throw Object.assign(new Error("delete response lost"), { code: 503 });
            }
            return result;
          },
          { times: 1 },
        );
        const response = await f.inject("POST", "/oauth-clients", input);
        const expectedStatus = scenario === "same-name-absent" ? 404 : 503;
        const calls = f.core.calls.deleteNamespacedSecret;
        const reserved = await f.row(input.clientId);
        observation(s, {
          case: scenario,
          status: response.statusCode,
          deletes: calls,
          hiddenReservation: !!reserved?.hidden,
          objectPresent: f.core.secrets.has(key),
        });
        assert.equal(response.statusCode, expectedStatus);
        assertSanitizedPrivateFailure(
          response,
          input.clientSecret,
          f.driver.id,
          expectedStatus === 404 ? "NOT_FOUND" : "DEPENDENCY_UNAVAILABLE",
        );
        assert.ok(reserved?.hidden);
        assert.equal(reserved.secret_driver_id, f.driver.id);
        await f.absentFromPublic(input.clientSecret, input.clientId);
        const hasPreconditions = ![
          "missing-uid",
          "missing-version",
          "create-request-failed",
        ].includes(scenario);
        assert.equal(calls, hasPreconditions ? 1 : 0);
        if (hasPreconditions) {
          assert.deepEqual(attempted, {
            name: requestName,
            namespace: "oce-installation-secrets",
            uid: "uid-1",
            resourceVersion: "1",
          });
        }
        if (scenario === "uid-replacement") {
          assert.equal(f.core.secrets.get(key).metadata.uid, "replacement");
        }
        if (scenario === "version-change") {
          assert.equal(f.core.secrets.get(key).metadata.resourceVersion, "2");
        }
        // Recovery is a separate current-state observation, never a replay of the uncertain create.
        await f.due(input.clientId);
        await f.recovered.cleanupOAuthClients();
        const remaining = await f.row(input.clientId);
        const absent = ["same-name-absent", "alternate-name-absent", "delete-dropped"].includes(
          scenario,
        );
        assert.equal(!!remaining, !absent);
        if (remaining) {
          assert.equal(remaining.due, false);
        }
        assert.equal(f.core.calls.createNamespacedSecret, 1);
        assert.equal(f.core.calls.deleteNamespacedSecret, calls);
      });
    }
  },
);

test(
  "OAuth registration and cleanup retain custody across unknown PostgreSQL commits",
  requiresPostgres,
  async (t) => {
    assert.ok(databaseUrl);
    for (const phase of ["publication", "cleanup"] as const) {
      for (const mode of ["acknowledgement-lost", "not-forwarded"] as const) {
        await t.test(phase + "-" + mode, async (s) => {
          const proxy = await commitAckProxy(databaseUrl);
          let closed = false;
          const close = async () => {
            if (!closed) {
              closed = true;
              await proxy.close();
            }
          };
          s.after(close);
          const f = await fixture(s, proxy.url);
          const input = f.input(await f.draft());
          const create = f.core.createNamespacedSecret.bind(f.core);
          const remove = f.core.deleteNamespacedSecret.bind(f.core);
          let key = "";
          s.mock.method(
            f.core,
            "createNamespacedSecret",
            async (request: CreateRequest) => {
              const result = await create(request);
              key = request.namespace + "/" + request.body.metadata.name;
              if (phase === "publication") {
                proxy.arm({ pauseCommit: mode === "not-forwarded" });
              } else {
                throw Object.assign(new Error("create response lost"), { code: 503 });
              }
              return result;
            },
            { times: 1 },
          );
          if (phase === "publication") {
            const pending = f.inject("POST", "/oauth-clients", input);
            if (mode === "not-forwarded") {
              await waitFor(
                "publication COMMIT is held",
                async () => proxy.commitPaused || undefined,
              );
              await close();
            }
            const result = await pending;
            assert.equal(result.statusCode, 503);
            assertSanitizedPrivateFailure(
              result,
              input.clientSecret,
              f.driver.id,
              "DEPENDENCY_UNAVAILABLE",
              "The operation outcome is unknown. Do not retry automatically; inspect current state before a deliberate new action.",
            );
            assert.ok(proxy.observedCommit);
            assert.equal(f.core.calls.createNamespacedSecret, 1);
            assert.equal(f.core.calls.deleteNamespacedSecret, 0);
            assert.equal(f.core.secrets.has(key), true);
            const row = await f.row(input.clientId);
            assert.ok(row);
            assert.equal(row.hidden, mode === "not-forwarded");
            observation(s, {
              case: phase + "-" + mode,
              status: result.statusCode,
              observedCommit: proxy.observedCommit,
              hidden: row.hidden,
              deletes: 0,
            });
            if (row.hidden) {
              await f.due(input.clientId);
              await f.recovered.cleanupOAuthClients();
              assert.equal(await f.row(input.clientId), undefined);
            } else {
              const current = await f.pool.query(
                "SELECT id FROM occ.oauth_clients WHERE client_id=$1 AND cleanup_after IS NULL",
                [input.clientId],
              );
              assert.equal(current.rowCount, 1);
              const registered = await new PostgresPlatformState(f.pool).read((view) =>
                view.connectionTemplates.findOAuthClient(row.id),
              );
              assert.ok(registered);
              assert.equal(
                await f.recovered.withOAuthClientSecret(
                  registered,
                  async (value) => value === input.clientSecret,
                ),
                true,
              );
            }
          } else {
            const result = await f.inject("POST", "/oauth-clients", input);
            assert.equal(result.statusCode, 503);
            assertSanitizedPrivateFailure(
              result,
              input.clientSecret,
              f.driver.id,
              "DEPENDENCY_UNAVAILABLE",
            );
            await f.due(input.clientId);
            s.mock.method(
              f.core,
              "deleteNamespacedSecret",
              async (request: DeleteRequest) => {
                const result = await remove(request);
                proxy.arm({ pauseCommit: mode === "not-forwarded" });
                return result;
              },
              { times: 1 },
            );
            const pending = f.controller.cleanupOAuthClients();
            const settled = pending.then(
              () => false,
              () => true,
            );
            if (mode === "not-forwarded") {
              await waitFor("cleanup COMMIT is held", async () => proxy.commitPaused || undefined);
              await close();
            }
            assert.equal(await settled, true, "unknown cleanup COMMIT must propagate");
            assert.ok(proxy.observedCommit);
            assert.equal(f.core.calls.deleteNamespacedSecret, 1);
            assert.equal(f.core.secrets.has(key), false);
            const row = await f.row(input.clientId);
            assert.equal(!!row, mode === "not-forwarded");
            observation(s, {
              case: phase + "-" + mode,
              status: result.statusCode,
              observedCommit: proxy.observedCommit,
              hidden: !!row?.hidden,
              deletes: f.core.calls.deleteNamespacedSecret,
            });
            if (row) {
              await f.recovered.cleanupOAuthClients();
              assert.equal(await f.row(input.clientId), undefined);
            }
            assert.equal(f.core.calls.deleteNamespacedSecret, 1);
          }
        });
      }
    }
  },
);

test(
  "ordinary Installation-private OAuth registration, rotation and retirement remain usable",
  requiresPostgres,
  async (t) => {
    const f = await fixture(t);
    const templateId = await f.draft();
    const input = f.input(templateId);
    const denied = await f.inject("POST", "/oauth-clients", input, f.baseHeaders);
    assert.equal(denied.statusCode, 401);
    assertPrivateMaterialAbsent(denied, input.clientSecret, f.driver.id);
    const readerAccount = {
      email: "private-reader-" + randomUUID() + "@example.test",
      password: "private-test-auth-" + randomUUID(),
    };
    const reader = await f.auth.createAccount({ ...readerAccount, name: "Reader" });
    await f.state.appendNativeIAMPrincipal(f.auth.principalSeed(reader, { grant: "none" }));
    const unauthorized = await f.inject(
      "POST",
      "/oauth-clients",
      input,
      await f.signIn(readerAccount),
    );
    assert.equal(unauthorized.statusCode, 403);
    assertPrivateMaterialAbsent(unauthorized, input.clientSecret, f.driver.id);
    const stale = await f.inject("POST", "/oauth-clients", {
      ...input,
      connectionTemplateVersion: 99,
    });
    assert.equal(stale.statusCode, 409);
    assertPrivateMaterialAbsent(stale, input.clientSecret, f.driver.id);
    assert.equal(f.core.calls.createNamespacedSecret, 0);
    const result = await f.inject("POST", "/oauth-clients", input);
    assert.equal(result.statusCode, 201);
    const client = result.json<{ data: OAuthClient }>().data;
    assert.equal(
      await f.controller.withOAuthClientSecret(
        client,
        async (value) => value === input.clientSecret,
      ),
      true,
    );
    const names = [...f.core.secrets.keys()];
    const replacement = inventedValue();
    assert.equal(
      (
        await f.inject("POST", "/oauth-clients/" + client.id + "/rotate-secret", {
          clientSecret: replacement,
        })
      ).statusCode,
      200,
    );
    assert.deepEqual([...f.core.secrets.keys()], names);
    assert.equal(
      await f.controller.withOAuthClientSecret(client, async (value) => value === replacement),
      true,
    );
    assert.equal(f.core.calls.deleteNamespacedSecret, 0);
    const listed = await f.inject("GET", "/oauth-clients");
    assert.equal(
      listed.body.includes(input.clientSecret) ||
        listed.body.includes(replacement) ||
        listed.body.includes(f.driver.id),
      false,
    );
    assert.equal((await f.inject("DELETE", "/connection-templates/" + templateId)).statusCode, 204);
    assert.equal((await f.inject("DELETE", "/oauth-clients/" + client.id)).statusCode, 204);
    await f.absentFromPublic(replacement, input.clientId);
    await f.due(input.clientId);
    await f.recovered.cleanupOAuthClients();
    assert.equal(await f.row(input.clientId), undefined);
    assert.equal(f.core.secrets.size, 0);
    observation(t, {
      case: "normal-lifecycle",
      create: 201,
      unauthenticated: 401,
      unauthorized: 403,
      stale: 409,
      deletes: f.core.calls.deleteNamespacedSecret,
      rotationStable: true,
    });
  },
);
