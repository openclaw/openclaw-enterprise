import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Check } from "typebox/value";
import { createControllerAuth } from "../../apps/controller/src/auth/index.ts";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import {
  AgentRevisionListResponse,
  AgentRevisionResponse,
  ErrorResponse,
  JsonValue,
  type AgentRevision,
} from "../../packages/contracts/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import {
  OpenClawController,
  PostgresPlatformState,
  type PlatformUnitOfWork,
} from "../../packages/occ/src/index.ts";
import { databaseUrl, requiresPostgres, testPool } from "../helpers/postgres-database.mjs";

const browserOrigin = "https://console.oce.localhost";

async function seedRevisionHistory(unit: PlatformUnitOfWork) {
  const createdAt = new Date().toISOString();
  const namespaceId = `ns_${randomUUID()}`;
  const configurationId = `cfg_${randomUUID()}`;
  await unit.namespaces.createNamespace({
    id: namespaceId,
    name: `Revision list ${namespaceId}`,
    status: "provisioning",
    createdAt,
  });
  assert.ok(await unit.namespaces.transitionNamespaceStatus(namespaceId, "provisioning", "ready"));
  await unit.configurations.createConfiguration({
    id: configurationId,
    namespaceId,
    kind: "agent",
    generation: 1,
    createdAt,
  });
  const agent = await unit.agents.createAgent({
    id: `agt_${randomUUID()}`,
    name: "Revision list",
    namespaceId,
    configurationId,
    backendId: null,
    executionMode: "embedded",
    gatewayManagedMode: true,
    sandboxPolicyEditing: false,
    harnessAuth: { method: "runtime" },
    servicePrincipalId: `service-agent-${randomUUID()}`,
    status: "active",
    desiredRuntimeState: "stopped",
    createdAt,
  });
  async function admit(revision: number) {
    return unit.revisions.createRevision({
      id: `rev_${randomUUID()}`,
      namespaceId,
      agentId: agent.id,
      revision,
      configurationId,
      configurationKind: "agent",
      configurationGeneration: 1,
      configuration: { description: `Native settings for revision ${revision}` },
      backendId: agent.backendId,
      gatewayManagedMode: agent.gatewayManagedMode,
      harness: {
        id: "openclaw",
        version: "1.0.0",
        mode: "embedded",
        overrides: {},
        configuration: {},
      },
      harnessAuth: { method: "runtime" },
      compute: { id: "fixture-compute", implementation: "fixture" },
      executionAdmission: { version: 2, mode: "unprotected" },
      servicePrincipalId: agent.servicePrincipalId,
      createdAt,
    });
  }
  const oldestDenied = await admit(1);
  const older = await admit(2);
  const middleDenied = await admit(3);
  const newest = await admit(4);
  return { agent, newest, older, middleDenied, oldestDenied };
}

function summary(revision: Readonly<AgentRevision>, deploymentStatus: "queued" | null) {
  return {
    id: revision.id,
    agentId: revision.agentId,
    namespaceId: revision.namespaceId,
    revision: revision.revision,
    configurationId: revision.configurationId,
    configurationGeneration: revision.configurationGeneration,
    backendId: revision.backendId,
    harness: revision.harness,
    createdAt: revision.createdAt,
    deploymentStatus,
    deploymentErrorCode: null,
  };
}

test(
  "revision history uses one PostgreSQL Native IAM policy snapshot for the parent and rows",
  { ...requiresPostgres, timeout: 30_000 },
  async (context) => {
    const pool = testPool(context, {
      connectionString: databaseUrl,
      max: 4,
      connectionTimeoutMillis: 3000,
    });
    const state = new PostgresPlatformState(pool);
    const writer = new PostgresPlatformState(pool);
    const installation =
      (await state.loadInstallation()) ??
      (await state.transact((unit) =>
        unit.installations.createInstallation({
          id: `ins_${randomUUID()}`,
          name: "Revision list fixture",
          createdAt: new Date().toISOString(),
        }),
      ));
    const auth = createControllerAuth({
      mode: "development",
      installationId: installation.id,
      baseURL: browserOrigin,
      agentDomain: "agents.oce.localhost",
      secret: randomUUID(),
    });
    const credentials = { email: `reader-${randomUUID()}@example.test`, password: randomUUID() };
    const account = await auth.createAccount(credentials);
    const seed = auth.principalSeed(account, { grant: "none" });
    const principalId = seed.principal.id;
    const { agent, newest, older } = await writer.transactWithQueue(async (unit, queue) => {
      await writer.insertNativeIAMPrincipal(unit, seed);
      const history = await seedRevisionHistory(unit);
      // Persist deployment work for a visible revision and both hidden revisions.
      // The other visible revision must remain visible with a null deployment outcome.
      for (const revision of [history.newest, history.middleDenied, history.oldestDenied]) {
        await queue.enqueue({
          idempotencyKey: `agent_revision:${revision.id}:reconcile`,
          namespaceId: revision.namespaceId,
          agentId: revision.agentId,
          revisionId: revision.id,
          actorId: principalId,
        });
      }
      return history;
    });

    const iam = new NativeIAMDriver(state);
    const { namespaceId } = agent;
    const agentBindingId = `binding-${randomUUID()}`;
    const revisionBindings = [newest, older].map(({ id }) => ({
      id: `binding-${randomUUID()}`,
      resourceId: id,
    }));
    const agentRoleId = `role-${randomUUID()}`;
    const revisionRoleId = `role-${randomUUID()}`;
    await writer.transact(async (unit) => {
      const policy = { policy: unit.iamPolicy };
      await iam.createNamespaceRole(policy, {
        id: agentRoleId,
        namespaceId,
        permissions: [{ action: "read", resourceKind: "agent" }],
      });
      await iam.createNamespaceRole(policy, {
        id: revisionRoleId,
        namespaceId,
        permissions: [{ action: "read", resourceKind: "agent_revision" }],
      });
      await iam.createNamespaceAccessBinding(policy, {
        id: agentBindingId,
        namespaceId,
        subjectKind: "identity",
        subjectId: principalId,
        roleId: agentRoleId,
        resourceKind: "agent",
        resourceId: agent.id,
      });
    });
    async function grantRevisions(unit: PlatformUnitOfWork) {
      for (const binding of revisionBindings) {
        await iam.createNamespaceAccessBinding(
          { policy: unit.iamPolicy },
          {
            ...binding,
            namespaceId,
            subjectKind: "identity",
            subjectId: principalId,
            roleId: revisionRoleId,
            resourceKind: "agent_revision",
          },
        );
      }
    }

    let swapOnAgentRead = false;
    let swapCommitted = false;
    const authorize = iam.authorize.bind(iam);
    context.mock.method(iam, "authorize", async (request: Parameters<typeof iam.authorize>[0]) => {
      const decision = await authorize(request);
      if (
        swapOnAgentRead &&
        decision.allowed &&
        request.principalId === principalId &&
        request.action === "read" &&
        request.resource.kind === "agent" &&
        request.resource.namespaceId === namespaceId &&
        request.resource.id === agent.id
      ) {
        swapOnAgentRead = false;
        // Keep the original decision. Replace its grant with revision-only
        // grants in one independent commit before the request checks any row.
        await writer.transact(async (unit) => {
          assert.ok(
            await iam.deleteNamespaceAccessBinding(
              { policy: unit.iamPolicy },
              namespaceId,
              agentBindingId,
            ),
          );
          await grantRevisions(unit);
        });
        swapCommitted = true;
      }
      return decision;
    });
    const controller = new OpenClawController(installation, { state });
    controller.registerDriver(iam);
    controller.selectDriver("iam", iam.id);
    const app = createFastifyApp({
      controller,
      iamDriver: iam,
      auditSink: new InMemoryAuditSink(),
      development: { enabled: true, browserOrigin },
      auth,
      resolveHarness: () => {
        throw new Error("Reading persisted revisions needs no Harness resolver.");
      },
    });
    context.after(() => app.close());
    const host = new URL(browserOrigin).host;
    const signIn = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { host, origin: browserOrigin },
      remoteAddress: "127.0.0.1",
      payload: credentials,
    });
    assert.equal(signIn.statusCode, 200, "the fixture reader signs in");
    const cookies = signIn.headers["set-cookie"];
    const session = (typeof cookies === "string" ? [cookies] : (cookies ?? [])).find((cookie) =>
      cookie.startsWith(`${auth.sessionCookieName}=`),
    );
    const sessionCookie = session?.split(";", 1)[0];
    assert.ok(sessionCookie, "sign-in issued a session cookie");

    const revisionPath = `/namespaces/${namespaceId}/agents/${agent.id}/revisions`;
    const get = (url: string) =>
      app.inject({
        method: "GET",
        url,
        headers: { host, cookie: sessionCookie },
        remoteAddress: "127.0.0.1",
      });
    async function list(query = "?limit=1") {
      const response = await get(`${revisionPath}${query}`);
      assert.equal(response.statusCode, 200, response.body);
      const page: unknown = response.json();
      assert.ok(
        Check(AgentRevisionListResponse, page),
        "the HTTP body is a revision-list envelope",
      );
      return page;
    }

    const agentOnly = await list();
    assert.deepEqual(agentOnly.data, [], "Agent read alone grants no revision rows");
    assert.equal(agentOnly.meta.nextCursor, null);

    await writer.transact(grantRevisions);
    const first = await list();
    assert.deepEqual(first.data, [summary(newest, "queued")]);
    assert.equal(first.meta.nextCursor, "v1.4");
    const last = await list(`?limit=1&cursor=${first.meta.nextCursor}`);
    assert.deepEqual(last.data, [summary(older, null)]);
    assert.equal(last.meta.nextCursor, null, "a denied older row does not create a cursor");

    await writer.transact(async ({ iamPolicy }) => {
      for (const { id } of revisionBindings) {
        assert.ok(await iam.deleteNamespaceAccessBinding({ policy: iamPolicy }, namespaceId, id));
      }
    });
    swapOnAgentRead = true;
    const duringSwap = await list();
    assert.equal(swapCommitted, true, "the independent grant swap committed during this request");

    const denied = await get(revisionPath);
    assert.equal(denied.statusCode, 403);
    const error: unknown = denied.json();
    assert.ok(Check(ErrorResponse, error));
    assert.equal(error.error.code, "FORBIDDEN");

    const detailResponse = await get(`${revisionPath}/${newest.id}`);
    assert.equal(detailResponse.statusCode, 200, detailResponse.body);
    const detail: unknown = detailResponse.json();
    assert.ok(
      Check({ SafeJsonValue: JsonValue }, AgentRevisionResponse, detail),
      "revision-only reads still return saved settings",
    );
    assert.equal(detail.data.id, newest.id);
    assert.deepEqual(detail.data.configuration, newest.configuration);

    // Neither committed policy grants both checks. Returning a row here combines authorities.
    assert.deepEqual(duringSwap.data, [], "a page cannot combine grants from two policies");
    assert.equal(duringSwap.meta.nextCursor, null);
  },
);
