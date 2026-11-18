import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import type { Pool } from "pg";
import type { Agent, AuthorizationRequest, Principal } from "../../packages/contracts/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import {
  OpenClawController,
  PostgresPlatformState,
  type PostgresPool,
} from "../../packages/occ/src/index.ts";
import { deferred } from "../helpers/deferred.ts";
import { databaseUrl, testPool } from "../helpers/postgres-database.mjs";
import {
  createHumanPrincipal,
  createNamespaceAgentState,
  identifier,
} from "./postgres-namespace-iam-fixture.ts";

/** Counts full policy reads (the one six-table statement) on every client the pool hands out. */
function countPolicyReads(pool: Pool) {
  const reads = { count: 0 };
  const countedPool: PostgresPool = {
    async connect() {
      const client = await pool.connect();
      return {
        query(statement, parameters) {
          if (statement.includes("FROM occ.iam_identities) v")) {
            reads.count += 1;
          }
          return client.query<Record<string, unknown>, unknown[]>(statement, parameters?.slice());
        },
        release: (discard) => client.release(discard),
        on: (event, listener) => client.on(event, listener),
        removeListener: (event, listener) => client.removeListener(event, listener),
      };
    },
    end: () => pool.end(),
  };
  return { reads, pool: countedPool };
}

/** An exact Agent read grant, as the Console share panel writes it. */
async function grantAgentRead(
  iam: NativeIAMDriver,
  state: PostgresPlatformState,
  agent: Agent,
  principal: Principal,
) {
  return state.transact(async (unit) => {
    const role = await iam.createNamespaceRole(
      { policy: unit.iamPolicy },
      {
        id: identifier("role"),
        namespaceId: agent.namespaceId,
        permissions: [{ action: "read", resourceKind: "agent" }],
      },
    );
    return iam.createNamespaceAccessBinding(
      { policy: unit.iamPolicy },
      {
        id: identifier("binding"),
        namespaceId: agent.namespaceId,
        subjectKind: "identity",
        subjectId: principal.id,
        roleId: role.id,
        resourceKind: "agent",
        resourceId: agent.id,
      },
    );
  });
}

/** A Namespace-wide read of the Namespace and its Agents, as a member Role grants it. */
async function grantNamespaceReader(
  state: PostgresPlatformState,
  namespaceId: string,
  principal: Principal,
) {
  const roleId = identifier("role");
  await state.transact(async (unit) => {
    await state.queryInTransaction(
      unit,
      `INSERT INTO occ.iam_roles (id, namespace_id, name, permissions)
       VALUES ($1, $2, 'Namespace reader', $3::jsonb)`,
      [
        roleId,
        namespaceId,
        JSON.stringify([
          { action: "read", resourceKind: "namespace" },
          { action: "read", resourceKind: "agent" },
        ]),
      ],
    );
    await state.queryInTransaction(
      unit,
      `INSERT INTO occ.iam_access_bindings (id, namespace_id, identity_subject_id, role_id)
       VALUES ($1, $2, $3, $4)`,
      [identifier("binding"), namespaceId, principal.id, roleId],
    );
  });
}

export async function originalUnitPolicy(context: TestContext) {
  // One connection also catches an accidental nested policy read: it cannot
  // acquire a second client while the original transaction owns the first.
  const pool: Pool = testPool(context, {
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: 1000,
  });
  const state = new PostgresPlatformState(pool);
  const iam = new NativeIAMDriver(state);
  const { namespace, secret, agent } = await createNamespaceAgentState(state);
  const request: AuthorizationRequest = {
    principalId: agent.servicePrincipalId,
    action: "operate",
    resource: { kind: "secret", id: secret.id, namespaceId: namespace.id },
  };
  assert.equal((await iam.authorize(request)).allowed, false);
  const roleId = identifier("role");
  await assert.rejects(
    state.transact(async (unit) => {
      // A policy this unit read before its own IAM writes must not be reused after them.
      assert.equal((await iam.authorize(request)).allowed, false);
      await iam.createNamespaceRole(
        { policy: unit.iamPolicy },
        {
          id: roleId,
          namespaceId: namespace.id,
          permissions: [{ action: "operate", resourceKind: "secret" }],
        },
      );
      const binding = await iam.createNamespaceAccessBinding(
        { policy: unit.iamPolicy },
        {
          id: identifier("binding"),
          namespaceId: namespace.id,
          subjectKind: "identity",
          subjectId: agent.servicePrincipalId,
          roleId,
          resourceKind: "secret",
          resourceId: secret.id,
        },
      );
      const granted = await iam.authorize(request);
      assert.equal(granted.allowed, true);
      assert.deepEqual(granted.evidence.bindingIds, [binding.id]);
      assert.equal(
        await iam.deleteNamespaceAccessBinding(
          { policy: unit.iamPolicy },
          namespace.id,
          binding.id,
        ),
        true,
      );
      assert.equal((await iam.authorize(request)).allowed, false);
      throw new Error("abort original policy operation");
    }),
    /abort original policy operation/,
  );
  assert.equal((await iam.authorize(request)).allowed, false);
  assert.equal(await state.read((unit) => unit.iamPolicy.getRole(namespace.id, roleId)), undefined);
}

export async function policyReadsPerUnit(context: TestContext) {
  // Finding 1322: every decision used to read, copy and validate the whole policy again.
  const pool: Pool = testPool(context, { connectionString: databaseUrl });
  const counted = countPolicyReads(pool);
  const state = new PostgresPlatformState(counted.pool);
  const iam = new NativeIAMDriver(state);
  const { installation, namespace, agent } = await createNamespaceAgentState(state);
  const principal = await createHumanPrincipal(state, installation.id);
  const read: AuthorizationRequest = {
    principalId: principal.id,
    action: "read",
    resource: { kind: "agent", id: agent.id, namespaceId: namespace.id },
  };
  const binding = await grantAgentRead(iam, state, agent, principal);

  // Every decision and lookup in one read unit shares one policy read.
  counted.reads.count = 0;
  const [first, identity, second] = await state.read(
    async () =>
      [
        await iam.authorize(read),
        await iam.lookupIdentity({ issuer: principal.issuer, subject: principal.subject }),
        await iam.authorize(read),
      ] as const,
  );
  assert.equal(first.allowed, true);
  assert.equal(identity?.id, principal.id);
  assert.deepEqual(second, first);
  assert.equal(counted.reads.count, 1);

  // Decisions outside a unit each open their own: nothing is kept between them.
  counted.reads.count = 0;
  assert.equal((await iam.authorize(read)).allowed, true);
  assert.equal((await iam.authorize(read)).allowed, true);
  assert.equal(counted.reads.count, 2);

  // A revocation committed by one request is enforced on the next.
  await state.transact((unit) =>
    iam.deleteNamespaceAccessBinding({ policy: unit.iamPolicy }, namespace.id, binding.id),
  );
  assert.equal((await state.read(() => iam.authorize(read))).allowed, false);
  assert.equal((await iam.authorize(read)).allowed, false);

  // Concurrent units never share a policy. One that read before a grant keeps its own
  // REPEATABLE READ view, as it always has; one that starts after the grant sees it.
  const started = deferred();
  const resume = deferred();
  const older = state.read(async () => {
    const before = await iam.authorize(read);
    started.resolve();
    await resume.promise;
    return { before, after: await iam.authorize(read) };
  });
  try {
    await Promise.race([started.promise, older]);
    const regrant = await grantAgentRead(iam, state, agent, principal);
    const newer = await state.read(() => iam.authorize(read));
    assert.equal(newer.allowed, true);
    assert.deepEqual(newer.evidence.bindingIds, [regrant.id]);
  } finally {
    resume.resolve();
    await older;
  }
  const { before, after } = await older;
  assert.equal(before.allowed, false);
  assert.equal(after.allowed, false);
}

export async function listAgentPolicyCost(context: TestContext) {
  // Finding 1322: listAgents made one full policy read per Agent, and each Agent adds its
  // ServicePrincipal to that policy, so the list grew with the square of the Namespace.
  const pool: Pool = testPool(context, { connectionString: databaseUrl });
  const counted = countPolicyReads(pool);
  const state = new PostgresPlatformState(counted.pool);
  const iam = new NativeIAMDriver(state, { id: `postgres-list-cost-${randomUUID()}` });
  const { installation, namespace, agent } = await createNamespaceAgentState(state);
  const principal = await createHumanPrincipal(state, installation.id);
  await grantNamespaceReader(state, namespace.id, principal);
  await state.transact(async (unit) => {
    for (let index = 1; index < 2000; index += 1) {
      await unit.agents.createAgent({
        ...agent,
        id: identifier("agt"),
        name: `Agent ${index} ${randomUUID()}`,
        servicePrincipalId: `service-agent-${randomUUID()}`,
      });
    }
  });
  const controller = new OpenClawController(installation, { state, recordOperations: false });
  controller.registerDriver(iam);
  controller.selectDriver("iam", iam.id);

  counted.reads.count = 0;
  const listed = await controller.listAgents(principal.id, namespace.id);
  assert.equal(listed.length, 2000);
  // One read for the Namespace check, which runs in its own unit, and one for the list.
  assert.equal(counted.reads.count, 2);

  // The bound is relative to reading the same Agents plus one standalone decision, so a slow
  // or busy runner does not fail it; each is timed at its best of three. The list makes two
  // policy reads and 2000 cheap decisions, so it takes a few such reads; with a policy read
  // per Agent it took hundreds.
  const namespaceRead: AuthorizationRequest = {
    principalId: principal.id,
    action: "read",
    resource: { kind: "namespace", id: namespace.id, namespaceId: namespace.id },
  };
  const timings = { listing: Infinity, reading: Infinity };
  const operations = {
    listing: () => controller.listAgents(principal.id, namespace.id),
    reading: async () => {
      await iam.authorize(namespaceRead);
      await state.read((unit) => unit.agents.listAgentsForBrowsing(namespace.id));
    },
  };
  for (let round = 0; round < 3; round += 1) {
    for (const name of ["listing", "reading"] as const) {
      const started = performance.now();
      await operations[name]();
      timings[name] = Math.min(timings[name], performance.now() - started);
    }
  }
  const { listing, reading } = timings;
  assert.ok(
    listing < 8 * reading,
    `listing took ${listing.toFixed(0)} ms, reading the Agents ${reading.toFixed(0)} ms`,
  );
}
