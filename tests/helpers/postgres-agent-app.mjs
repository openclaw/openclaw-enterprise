import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

import { createPostgresControllerAuth } from "../../apps/controller/src/auth/index.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { OpenClawController, PostgresPlatformState } from "../../packages/occ/src/index.ts";
import { authenticatedHeaders, cookieHeaderFromSetCookie } from "./auth-session.mjs";
import {
  ensureDevelopmentBootstrap,
  privateBootstrapDirectory,
} from "./bootstrap-installation.mjs";
import { createTestConfigurationDriver } from "./configuration-driver.mjs";
import { createHarnessConfiguration } from "./harness-configuration.mjs";
import { grantAgentSecretOperate } from "./postgres-harness-auth.mjs";
import { databaseUrl } from "./postgres-database.mjs";
import { createRuntimeLogComputeDriver } from "./runtime-logs.mjs";
import { createTestSecretDriver } from "./secret-driver.mjs";

const adminEmail = "postgres-admin@openclaw.local";
const adminPassword = "postgres-development-password";
const origin = "http://127.0.0.1";

// Bootstraps the shared development Installation once per database; later suites reuse it.
async function ensureBootstrap(t, { label, authSecret }) {
  const observer = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  t.after(() => observer.end());
  if ((await new PostgresPlatformState(observer).loadInstallation()) !== undefined) {
    return;
  }
  await ensureDevelopmentBootstrap(t, {
    databaseUrl,
    directory: await privateBootstrapDirectory(t, `openclaw-${label}-pg-`),
    email: adminEmail,
    password: adminPassword,
    authSecret,
    authBaseURL: origin,
    installationName: `${label} PostgreSQL test`,
  });
}

/**
 * The real Fastify controller over PostgreSQL State and Native IAM, with the bootstrap
 * administrator signed in by password. Compute is the runtime-log test Driver; Configuration
 * and Secret are the test Drivers.
 *
 * @param t the test context; pools and the app close after it.
 * @param options.label names the Drivers (`<label>-pg-iam`, …) and, when this run bootstraps
 *   the database, its Installation.
 * @param options.authSecret the session signing secret (at least 32 characters).
 * @param options.createAuditSink receives the PostgreSQL audit sink and returns the sink the
 *   app writes to (default: that sink).
 * @param options.appOptions extra Fastify app options, such as `agentRuntimeLogs`. They are
 *   spread last, so they may also replace a default above.
 * @returns `{ pool, state, controller, computeDriver, app, principal, inject, deployAgent }`.
 *   `inject(method, url, body)` sends an administrator request. `deployAgent(name)` creates a
 *   ready Namespace, an Agent Configuration and API-key Secret, and an Agent whose
 *   ServicePrincipal may operate that Secret, deploys it, and returns
 *   `{ namespace, secretRef, agent, revision }`.
 */
export async function createPostgresAgentApp(
  t,
  { label, authSecret, createAuditSink = (persisted) => persisted, appOptions },
) {
  await ensureBootstrap(t, { label, authSecret });
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 6 });
  t.after(() => pool.end());
  const state = new PostgresPlatformState(pool);
  const installation = await state.loadInstallation();
  assert.ok(installation);
  const auth = await createPostgresControllerAuth({
    mode: "development",
    installationId: installation.id,
    baseURL: origin,
    secret: authSecret,
    pool,
  });
  const iamDriver = new NativeIAMDriver(state, { id: `${label}-pg-iam` });
  const computeDriver = createRuntimeLogComputeDriver({ id: `${label}-pg-compute` });
  const configurationDriver = createTestConfigurationDriver({ id: `${label}-pg-config` });
  const secretDriver = createTestSecretDriver({ id: `${label}-pg-secret` });
  const controller = new OpenClawController(installation, { state, recordOperations: false });
  for (const driver of [iamDriver, computeDriver, configurationDriver, secretDriver]) {
    controller.registerDriver(driver);
    controller.selectDriver(driver.capability, driver.id);
  }
  const app = createFastifyApp({
    controller,
    iamDriver,
    computeDriver,
    configurationDriver,
    secretDriver,
    resolveHarness: resolveApprovedHarness,
    auditSink: createAuditSink(state.auditSink),
    auth,
    development: { enabled: false },
    ...appOptions,
  });
  t.after(() => app.close());

  const signIn = await app.inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    payload: JSON.stringify({ email: adminEmail, password: adminPassword }),
  });
  assert.equal(signIn.statusCode, 200, signIn.body);
  const setCookie = signIn.headers["set-cookie"];
  const session = {
    origin,
    cookie: cookieHeaderFromSetCookie(Array.isArray(setCookie) ? setCookie : [setCookie]),
  };
  const inject = (method, url, body) =>
    app.inject({
      method,
      url,
      headers: {
        host: "127.0.0.1",
        ...authenticatedHeaders(session),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });

  const account = await pool.query(`SELECT id FROM occ."user" WHERE email = $1`, [adminEmail]);
  const principal = (await state.loadNativeIAMState()).identities.find(
    (identity) => identity.kind === "principal" && identity.subject === account.rows[0].id,
  );
  assert.ok(principal);

  async function deployAgent(name) {
    const created = await inject("POST", "/namespaces", { name: `${name} ${randomUUID()}` });
    assert.equal(created.statusCode, 201, created.body);
    const namespace = created.json().data;
    await controller.handleNamespaceLifecycle(principal.id, namespace.id, "ready");
    const configuration = await inject("POST", `/namespaces/${namespace.id}/configurations`, {
      kind: "agent",
      values: createHarnessConfiguration("openclaw", "gpt-4.1"),
    });
    assert.equal(configuration.statusCode, 201, configuration.body);
    const secret = await inject("POST", `/namespaces/${namespace.id}/secrets`, {
      name: `${name} key ${randomUUID()}`,
      value: `test-key-${randomUUID()}`,
    });
    assert.equal(secret.statusCode, 201, secret.body);
    const secretRef = secret.json().data.ref;
    const createdAgent = await inject("POST", `/namespaces/${namespace.id}/agents`, {
      name: `${name} ${randomUUID()}`,
      configurationId: configuration.json().data.id,
      harnessAuth: { method: "api_key", source: secretRef },
    });
    assert.equal(createdAgent.statusCode, 201, createdAgent.body);
    const agent = createdAgent.json().data;
    // The Agent's ServicePrincipal is the subject of this Secret binding.
    await grantAgentSecretOperate(pool, agent, secretRef.id);
    const revision = await controller.deployAgent(
      principal.id,
      { namespaceId: namespace.id, agentId: agent.id },
      resolveApprovedHarness,
    );
    return { namespace, secretRef, agent, revision };
  }

  return { pool, state, controller, computeDriver, app, principal, inject, deployAgent };
}
