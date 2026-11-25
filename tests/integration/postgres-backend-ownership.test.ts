import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Pool } from "pg";
import type { TSchema } from "typebox";
import {
  AgentReadResponse,
  AgentResponse,
  ConfigurationResponse,
  ErrorResponse,
  JsonValue,
  NamespaceResponse,
  PluginApproversSchema,
  PluginDesiredSelectionSchema,
  PluginDesiredStateSchema,
  PluginDriverIdentitySchema,
  PluginToolDefaultsSchema,
  PluginToolPolicySchema,
  type HarnessAuthBinding,
  type Namespace,
} from "../../packages/contracts/src/index.ts";
import type { OpenClawController } from "../../packages/occ/src/index.ts";
import { createFixtureResponse } from "../helpers/console-fixture-response.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { authenticatedHeaders, signInWithEmailPassword } from "../helpers/auth-session.ts";
import {
  createConsoleFixtureTransport,
  fetchLoopback,
} from "../helpers/console-fixture-transport.ts";
import { jsonRequestInit } from "../helpers/inject-json.ts";
import {
  createBootstrappedBackendState,
  createBackendController,
  createBackendFixture,
  backendId,
  requiresPostgres,
  startBackendlessDevelopmentServer,
} from "../helpers/postgres-backend-state.mjs";
import { reservePort } from "../helpers/available-port.ts";
import { stopProcess } from "../helpers/stop-process.ts";

type BackendFixture = Awaited<ReturnType<typeof createBackendFixture>>;
type AuthSession = Awaited<ReturnType<typeof signInWithEmailPassword>>;
const fixtureResponse = createFixtureResponse({
  SafeJsonValue: JsonValue,
  PluginApprovers: PluginApproversSchema,
  PluginDesiredSelection: PluginDesiredSelectionSchema,
  PluginDesiredState: PluginDesiredStateSchema,
  PluginDriverIdentity: PluginDriverIdentitySchema,
  PluginToolDefaults: PluginToolDefaultsSchema,
  PluginToolPolicy: PluginToolPolicySchema,
});

async function request<T extends TSchema>(
  origin: string,
  session: AuthSession,
  method: "GET" | "PATCH" | "POST",
  path: string,
  status: number,
  schema: T,
  body?: object,
) {
  const response = await fetchLoopback(`${origin}${path}`, {
    ...jsonRequestInit(method, body, {
      host: new URL(session.origin).host,
      ...authenticatedHeaders(session),
    }),
    signal: AbortSignal.timeout(5_000),
  });
  const payload: unknown = await response.json();
  return fixtureResponse(
    { status: response.status, body: payload },
    status,
    schema,
    `${method} ${path}`,
  );
}

async function createReadyNamespace(fixture: BackendFixture, label: string): Promise<Namespace> {
  const namespace: Namespace = {
    id: `ns_${randomUUID()}`,
    name: `backend-owner-${label}-${randomUUID()}`,
    status: "ready",
    createdAt: new Date().toISOString(),
  };
  await fixture.state.transact((unit) => unit.namespaces.createNamespace(namespace));
  fixture.track(namespace);
  return namespace;
}

async function createConfiguration(
  fixture: BackendFixture,
  controller: OpenClawController,
  namespace: Namespace,
  harness: "codex" | "openclaw" = "codex",
) {
  return controller.createConfiguration(fixture.actor.id, {
    namespaceId: namespace.id,
    kind: "agent",
    values: createHarnessConfiguration(harness, "gpt-4.1"),
  });
}

async function assertNoRevision(pool: Pool, namespaceId: string, agentId: string, label: string) {
  const result = await pool.query<{ count: number }>(
    "SELECT count(*)::integer AS count FROM occ.agent_revisions WHERE namespace_id = $1 AND agent_id = $2",
    [namespaceId, agentId],
  );
  assert.deepEqual(result.rows, [{ count: 0 }], label);
}

test(
  "development API starts with stale Backend references and permits repair through Agent update",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    // Hold the private transport port until the child binds it, and again
    // across the restart, so no other socket takes it in between.
    let reservation = await reservePort();
    context.after(() => reservation.release());
    const { port } = reservation;
    const origin = `http://127.0.0.1:${port}`;
    const authBaseURL = "https://console.oce.localhost";
    const transport = createConsoleFixtureTransport(authBaseURL, origin);
    const email = "postgres-admin@openclaw.local";
    const password = "postgres-development-password";
    const authSecret = "openclaw-backend-repair-auth-secret-minimum-32-bytes";
    const fixture = await createBootstrappedBackendState(context, {
      email,
      password,
      authSecret,
      authBaseURL,
      installationName: "PostgreSQL Backend repair integration",
    });
    const server = await startBackendlessDevelopmentServer(context, {
      reservation,
      authBaseURL,
      authSecret,
      configurationRoot: fixture.configurationRoot,
    });
    const signIn = () =>
      signInWithEmailPassword({
        fetch: (input, init) => transport.fetchThroughLoopback(new Request(input, init)),
        origin: authBaseURL,
        email,
        password,
        rememberMe: undefined,
      });
    const session = await signIn();

    const { data: namespace } = await request(
      origin,
      session,
      "POST",
      "/namespaces",
      201,
      NamespaceResponse,
      {
        name: `backend-repair-${randomUUID()}`,
      },
    );
    fixture.track(namespace);
    await fixture.state.transact((unit) =>
      unit.namespaces.transitionNamespaceStatus(namespace.id, "provisioning", "ready"),
    );
    const { data: configuration } = await request(
      origin,
      session,
      "POST",
      `/namespaces/${namespace.id}/configurations`,
      201,
      ConfigurationResponse,
      {
        kind: "agent",
        values: createHarnessConfiguration("codex", "gpt-4.1"),
      },
    );
    const { data: agent } = await request(
      origin,
      session,
      "POST",
      `/namespaces/${namespace.id}/agents`,
      201,
      AgentResponse,
      {
        name: `backend-repair-${randomUUID()}`,
        configurationId: configuration.id,
        executionMode: "dedicated",
      },
    );

    reservation = await reservePort({ port });
    await stopProcess(server.child);
    await fixture.pool.query(
      "UPDATE occ.agents SET backend_id = $1 WHERE namespace_id = $2 AND id = $3",
      [backendId, namespace.id, agent.id],
    );

    await startBackendlessDevelopmentServer(context, {
      reservation,
      authBaseURL,
      authSecret,
      configurationRoot: fixture.configurationRoot,
    });
    const restartedSession = await signIn();
    const { data: visible } = await request(
      origin,
      restartedSession,
      "GET",
      `/namespaces/${namespace.id}/agents/${agent.id}`,
      200,
      AgentReadResponse,
    );
    assert.equal(visible.backendId, backendId);

    // Startup must allow API repair. Deploying a stale Backend reference is rejected
    // through the API's canonical unknown-reference response before admission.
    const deploy = await request(
      origin,
      restartedSession,
      "POST",
      `/namespaces/${namespace.id}/agents/${agent.id}/deploy`,
      404,
      ErrorResponse,
    );
    assert.equal(deploy.error.code, "NOT_FOUND");
    await assertNoRevision(
      fixture.pool,
      namespace.id,
      agent.id,
      "stale Backend deployment must be rejected before an AgentRevision is persisted",
    );

    const { data: repaired } = await request(
      origin,
      restartedSession,
      "PATCH",
      `/namespaces/${namespace.id}/agents/${agent.id}`,
      200,
      AgentResponse,
      {
        configurationId: configuration.id,
        backendId: null,
        harnessAuth: null,
        executionMode: "dedicated",
      },
    );
    assert.equal(repaired.backendId, null);

    const persisted = await fixture.pool.query<{
      backend_id: string | null;
      harness_auth: HarnessAuthBinding | null;
    }>("SELECT backend_id, harness_auth FROM occ.agents WHERE namespace_id = $1 AND id = $2", [
      namespace.id,
      agent.id,
    ]);
    assert.deepEqual(persisted.rows, [{ backend_id: null, harness_auth: null }]);
  },
);

test(
  "PostgreSQL persists an Agent draft Backend selection and explicit clearing",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    const fixture = await createBackendFixture(context);
    const controller = createBackendController(fixture, { nativeWorkerSupport: "custom-image" });

    await verifyDraftAssociation(fixture, controller);
  },
);

async function verifyDraftAssociation(fixture: BackendFixture, controller: OpenClawController) {
  const draftNamespace = await createReadyNamespace(fixture, "drafts");
  const draftConfiguration = await createConfiguration(fixture, controller, draftNamespace);
  const backendless = await controller.createAgent(fixture.actor.id, {
    namespaceId: draftNamespace.id,
    name: `backendless-${randomUUID()}`,
    configurationId: draftConfiguration.id,
  });
  assert.equal(backendless.backendId, null);
  const selected = await controller.updateAgent(fixture.actor.id, {
    namespaceId: draftNamespace.id,
    agentId: backendless.id,
    configurationId: draftConfiguration.id,
    backendId,
  });
  assert.equal(selected.backendId, backendId);
  const cleared = await controller.updateAgent(fixture.actor.id, {
    namespaceId: draftNamespace.id,
    agentId: backendless.id,
    configurationId: draftConfiguration.id,
    backendId: null,
  });
  assert.equal(cleared.backendId, null);
  const draftRows = await fixture.pool.query<{ backend_id: string | null }>(
    "SELECT backend_id FROM occ.agents WHERE namespace_id = $1 AND id = $2",
    [draftNamespace.id, backendless.id],
  );
  assert.deepEqual(draftRows.rows, [{ backend_id: null }]);
  return draftNamespace;
}
