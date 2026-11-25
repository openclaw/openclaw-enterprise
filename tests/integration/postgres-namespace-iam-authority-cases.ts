import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import type { Pool } from "pg";
import { OCC_SERVICE_KEY_HEADER } from "../../apps/controller/src/auth/index.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import type { AuthorizationRequest } from "../../packages/contracts/src/index.ts";
import { createAuthPrincipalSeed, NativeIAMDriver } from "../../packages/iam/src/index.ts";
import {
  AuthorizationDeniedError,
  OpenClawController,
  PostgresPlatformState,
} from "../../packages/occ/src/index.ts";
import {
  authenticatedHeaders,
  createTestAuthPrincipal,
  signInToControllerApp,
} from "../helpers/auth-session.ts";
import { databaseUrl, testPool } from "../helpers/postgres-database.mjs";
import { waitFor } from "../helpers/wait-for.ts";
import {
  createNamespaceAgentState,
  identifier,
  isLockTimeout,
} from "./postgres-namespace-iam-fixture.ts";

async function namespacePolicyActors(context: TestContext) {
  const pool: Pool = testPool(context, { connectionString: databaseUrl });
  const state = new PostgresPlatformState(pool);
  const iam = new NativeIAMDriver(state, { id: `postgres-iam-commit-fence-${randomUUID()}` });
  const { installation, namespace, agent } = await createNamespaceAgentState(state);
  const issuer = "https://identity.example.com";
  const actorIds = new Set<string>();

  // Installation-scoped Roles for the actors. The administrator reads Namespaces
  // through the Installation; the delegate needs a Namespace-scoped read binding.
  const roles = { admin: identifier("role"), delegate: identifier("role") };
  await pool.query(
    `INSERT INTO occ.iam_roles (id, namespace_id, name, permissions)
     VALUES ($1, NULL, 'Fence admin', $2::jsonb), ($3, NULL, 'Fence delegate', $4::jsonb)`,
    [
      roles.admin,
      JSON.stringify([
        { action: "administer", resourceKind: "installation" },
        { action: "read", resourceKind: "namespace" },
        { action: "read", resourceKind: "agent" },
      ]),
      roles.delegate,
      JSON.stringify([{ action: "administer", resourceKind: "installation" }]),
    ],
  );
  async function humanActor(seed: ReturnType<typeof createAuthPrincipalSeed>, email?: string) {
    const userId = seed.principal.subject;
    await state.appendNativeIAMPrincipal(seed);
    await pool.query(
      `INSERT INTO occ."user" (id, name, email, created_at, updated_at)
       VALUES ($1, 'Fence actor', $2, clock_timestamp(), clock_timestamp())`,
      [userId, email ?? `fence-${userId}@example.test`],
    );
    await pool.query(
      `INSERT INTO occ.human_authentication_accounts (user_id, installation_id, principal_id)
       VALUES ($1, $2, $3)`,
      [userId, installation.id, seed.principal.id],
    );
    actorIds.add(seed.principal.id);
    return { userId, principalId: seed.principal.id };
  }
  const seedActor = (roleId: string) =>
    createAuthPrincipalSeed(installation.id, issuer, { id: randomUUID() }, { roleId });
  const admin = await humanActor(seedActor(roles.admin));
  // Account seeds scope their binding to the Installation resource; the administrator
  // also holds the Role across the Installation, like the bootstrap administrator.
  await pool.query(
    `INSERT INTO occ.iam_access_bindings (id, identity_subject_id, role_id) VALUES ($1, $2, $3)`,
    [identifier("binding"), admin.principalId, roles.admin],
  );
  const createDelegate = (seed = seedActor(roles.delegate), email?: string) =>
    humanActor(seed, email);
  // Bootstrap gives its Installation ServicePrincipal the same unscoped Role
  // as the administrator. Use a fresh identity so other fixtures keep their grants.
  async function createServiceAdministrator() {
    const principal = { kind: "service_principal" as const, id: identifier("spn") };
    await state.transact(async (unit) => {
      await state.queryInTransaction(
        unit,
        `INSERT INTO occ.iam_identities (id, kind, namespace_id, agent_id)
         VALUES ($1, 'service_principal', NULL, NULL)`,
        [principal.id],
      );
      await state.queryInTransaction(
        unit,
        `INSERT INTO occ.iam_access_bindings (id, identity_subject_id, role_id)
         VALUES ($1, $2, $3)`,
        [identifier("binding"), principal.id, roles.admin],
      );
    });
    actorIds.add(principal.id);
    return principal;
  }
  return {
    pool,
    state,
    iam,
    installation,
    namespace,
    agent,
    admin,
    createDelegate,
    createServiceAdministrator,
    actorIds,
    delegateRoleId: roles.delegate,
  };
}

export async function actorAuthorityThroughCommit(context: TestContext) {
  const { pool, state, iam, installation, namespace, agent, admin, createDelegate } =
    await namespacePolicyActors(context);
  const delegate = await createDelegate();
  // Runs `race` once, right after the admission decision for `trigger` is made.
  let pending:
    | {
        matches(request: AuthorizationRequest): boolean;
        run(): Promise<unknown>;
      }
    | undefined;
  const controller = new OpenClawController(installation, {
    state,
    recordOperations: false,
    authorize: async (request) => {
      const decision = await iam.authorize(request);
      const race = pending;
      if (race !== undefined && race.matches(request)) {
        pending = undefined;
        await race.run();
      }
      return decision;
    },
  });
  controller.registerDriver(iam);
  controller.selectDriver("iam", iam.id);
  const namespaceRead = (principalId: string) => (request: AuthorizationRequest) =>
    request.principalId === principalId &&
    request.action === "read" &&
    request.resource.kind === "namespace";

  const readRole = await controller.createIAMRole(admin.principalId, {
    namespaceId: namespace.id,
    permissions: [{ action: "read", resourceKind: "namespace" }],
  });
  const delegateRead = await controller.createIAMAccessBinding(admin.principalId, {
    namespaceId: namespace.id,
    subjectKind: "identity",
    subjectId: delegate.principalId,
    roleId: readRole.id,
    resourceKind: "namespace",
    resourceId: namespace.id,
  });
  const agentRole = await controller.createIAMRole(delegate.principalId, {
    namespaceId: namespace.id,
    permissions: [{ action: "read", resourceKind: "agent" }],
  });
  const roleIds = async () =>
    (await state.read((unit) => unit.iamPolicy.listRoles(namespace.id))).map((role) => role.id);
  const bindingIds = async () =>
    (await state.read((unit) => unit.iamPolicy.listAccessBindings(namespace.id))).map(
      (binding) => binding.id,
    );

  // A concurrent removal of the delegate's Namespace read commits after admission,
  // which reads the Namespace twice: as the policy scope and as the grant target.
  let delegateReads = 0;
  pending = {
    matches: (request) => namespaceRead(delegate.principalId)(request) && ++delegateReads === 2,
    run: () => controller.deleteIAMAccessBinding(admin.principalId, namespace.id, delegateRead.id),
  };
  const before = await bindingIds();
  await assert.rejects(
    controller.createIAMAccessBinding(delegate.principalId, {
      namespaceId: namespace.id,
      subjectKind: "identity",
      subjectId: agent.servicePrincipalId,
      roleId: readRole.id,
      resourceKind: "namespace",
      resourceId: namespace.id,
    }),
    AuthorizationDeniedError,
  );
  assert.equal(pending, undefined, "the revocation raced the admitted request");
  assert.deepEqual(
    (await bindingIds()).sort(),
    before.filter((id) => id !== delegateRead.id).sort(),
  );

  // Disabling the administrator's account after admission denies the write.
  const setAdminDisabled = (disabled: boolean) =>
    pool.query(
      `UPDATE occ.human_authentication_accounts
       SET disabled = $2, version = version + 1 WHERE user_id = $1`,
      [admin.userId, disabled],
    );
  pending = {
    matches: namespaceRead(admin.principalId),
    run: () => setAdminDisabled(true),
  };
  const rolesBefore = await roleIds();
  await assert.rejects(
    controller.deleteIAMRole(admin.principalId, namespace.id, agentRole.id),
    AuthorizationDeniedError,
  );
  assert.equal(pending, undefined, "the disable raced the admitted request");
  assert.deepEqual((await roleIds()).sort(), rolesBefore.sort());
  await setAdminDisabled(false);

  // ServicePrincipal creation is a policy write too: a disable after admission creates none.
  pending = {
    matches: namespaceRead(admin.principalId),
    run: () => setAdminDisabled(true),
  };
  await assert.rejects(
    controller.createIAMServicePrincipal(admin.principalId, namespace.id),
    AuthorizationDeniedError,
  );
  assert.equal(pending, undefined, "the disable raced the admitted ServicePrincipal create");
  assert.deepEqual(
    await state.read((unit) => unit.iamPolicy.listServicePrincipals(namespace.id)),
    [],
  );
  await setAdminDisabled(false);

  // Inside the transaction, the actor's account and Namespace stay locked until
  // COMMIT: a disable, Namespace policy write, or configuration change cannot slip in.
  const blocked: boolean[] = [];
  let inTransaction = 0;
  pending = {
    matches: (request) => namespaceRead(admin.principalId)(request) && ++inTransaction === 2,
    run: async () => {
      const competingWrites: [string, string][] = [
        [
          "UPDATE occ.human_authentication_accounts SET disabled = true WHERE user_id = $1",
          admin.userId,
        ],
        ["SELECT 1 FROM occ.namespaces WHERE id = $1 FOR UPDATE", namespace.id],
        ["SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", "occ:iam-configuration"],
      ];
      for (const [statement, parameter] of competingWrites) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL lock_timeout = '200ms'");
          await client.query(statement, [parameter]);
          blocked.push(false);
        } catch (error) {
          blocked.push(isLockTimeout(error));
        } finally {
          await client.query("ROLLBACK").catch(() => {});
          client.release();
        }
      }
    },
  };
  const kept = await controller.createIAMRole(admin.principalId, {
    namespaceId: namespace.id,
    permissions: [{ action: "read", resourceKind: "agent" }],
  });
  assert.equal(pending, undefined, "the in-transaction check ran");
  assert.deepEqual(blocked, [true, true, true]);
  assert.ok((await roleIds()).includes(kept.id));
}

async function roleDeletionFixture(context: TestContext) {
  const {
    pool,
    state,
    iam,
    installation,
    namespace,
    admin,
    createDelegate,
    createServiceAdministrator,
    actorIds,
    delegateRoleId,
  } = await namespacePolicyActors(context);
  const administrator = new OpenClawController(installation, { state, recordOperations: false });
  administrator.registerDriver(iam);
  administrator.selectDriver("iam", iam.id);
  const readRole = await administrator.createIAMRole(admin.principalId, {
    namespaceId: namespace.id,
    permissions: [{ action: "read", resourceKind: "namespace" }],
  });
  // Only the delegate's Namespace read depends on this binding. The target Role
  // is unreferenced, so a foreign key or an in-use check cannot prevent its deletion.
  const grantRead = (principalId: string) =>
    administrator.createIAMAccessBinding(admin.principalId, {
      namespaceId: namespace.id,
      subjectKind: "identity",
      subjectId: principalId,
      roleId: readRole.id,
      resourceKind: "namespace",
      resourceId: namespace.id,
    });
  const createTarget = () =>
    administrator.createIAMRole(admin.principalId, {
      namespaceId: namespace.id,
      permissions: [{ action: "read", resourceKind: "agent" }],
    });
  const target = await createTarget();

  // Check effective permissions independently of the request and its audit.
  // Compare every binding for these actors and every binding in this Namespace.
  async function observeGrants(principalId: string, canReadNamespace: boolean) {
    const decision = await iam.authorize({
      principalId,
      action: "administer",
      resource: { kind: "installation", id: installation.id },
    });
    assert.equal(decision.allowed, true, "the delegate retains Installation administer");
    const read = await iam.authorize({
      principalId,
      action: "read",
      resource: { kind: "namespace", id: namespace.id, namespaceId: namespace.id },
    });
    assert.equal(read.allowed, canReadNamespace, "the delegate's effective Namespace read");
    const policy = await state.loadNativeIAMState(installation.id);
    return policy.bindings.filter(
      (binding) =>
        binding.namespaceId === namespace.id ||
        (binding.subjectKind === "identity" && actorIds.has(binding.subjectId)),
    );
  }

  // Pin the caller to one PostgreSQL session with a stronger default. Ordinary
  // Read Committed installations would conceal an omitted transaction option.
  const callerPool: Pool = testPool(context, {
    connectionString: databaseUrl,
    max: 1,
    idleTimeoutMillis: 0,
    connectionTimeoutMillis: 5_000,
  });
  await callerPool.query(
    "SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL REPEATABLE READ",
  );
  const session = await callerPool.query<{ pid: number; isolation: string }>(
    "SELECT pg_backend_pid() AS pid, current_setting('transaction_isolation') AS isolation",
  );
  const caller = session.rows[0];
  assert.ok(caller);
  const callerPid = caller.pid;
  assert.equal(caller.isolation, "repeatable read");
  const callerState = new PostgresPlatformState(callerPool);
  const callerIAM = new NativeIAMDriver(callerState);
  const controller = new OpenClawController(installation, {
    state: callerState,
    recordOperations: false,
  });
  controller.registerDriver(callerIAM);
  controller.selectDriver("iam", callerIAM.id);
  // Let the delegate pass admission while the real AccessBinding deletion is
  // uncommitted. Commit it only when this caller is blocked by the administrator.
  async function revokeBeforeDelete<T>(
    bindingId: string,
    deleteRole: () => Promise<T>,
  ): Promise<T> {
    let deletion: Promise<T> | undefined;
    try {
      await administrator.transact(async (unit) => {
        await administrator.deleteIAMAccessBinding(admin.principalId, namespace.id, bindingId);
        deletion = deleteRole();
        let finished = false;
        const markFinished = () => {
          finished = true;
        };
        void deletion.then(markFinished, markFinished);
        await waitFor(
          "Role DELETE waiting behind AccessBinding DELETE",
          async () => {
            if (finished) {
              await deletion;
              assert.fail("Role deletion returned before reaching the Namespace lock");
            }
            const blocked = await state.queryInTransaction(
              unit,
              "SELECT 1 WHERE pg_backend_pid() = ANY(pg_blocking_pids($1))",
              [callerPid],
            );
            return blocked.rowCount === 1 ? true : undefined;
          },
          5_000,
        );
        const waiting = await state.queryInTransaction(
          unit,
          `SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'
           AND query LIKE '%FROM occ.namespaces%FOR UPDATE%'`,
          [callerPid],
        );
        assert.equal(waiting.rowCount, 1, "the caller reached its Namespace lock");
      });
      assert.ok(deletion);
      return await deletion;
    } finally {
      await Promise.allSettled([deletion]);
    }
  }
  // Stop the writer at its exact Role row, after it has acquired the Namespace
  // lock. The revoker must wait for that writer before removing the read grant.
  async function deleteBeforeRevoke<T>(
    roleId: string,
    bindingId: string,
    deleteRole: () => Promise<T>,
  ): Promise<T> {
    const blocker = await pool.connect();
    let discard = true;
    let deletion: Promise<T> | undefined;
    let revocation: ReturnType<typeof administrator.deleteIAMAccessBinding> | undefined;
    let revokerPid: number | undefined;
    // Each observation uses a fresh transaction so PostgreSQL cannot reuse an
    // activity snapshot from before a backend started waiting.
    async function blockedAt(pid: number, ownerPid: number, statement: string) {
      const result = await pool.query(
        `SELECT 1 FROM pg_stat_activity
         WHERE pid = $1 AND datname = current_database() AND wait_event_type = 'Lock'
           AND $2::int = ANY(pg_blocking_pids(pid)) AND query LIKE $3`,
        [pid, ownerPid, statement],
      );
      return result.rowCount === 1 ? true : undefined;
    }
    try {
      await blocker.query("BEGIN");
      const locked = await blocker.query<{ pid: number }>(
        `SELECT pg_backend_pid() AS pid FROM occ.iam_roles
         WHERE namespace_id = $1 AND id = $2 FOR UPDATE NOWAIT`,
        [namespace.id, roleId],
      );
      const owner = locked.rows[0];
      assert.ok(owner);
      const blockerPid = owner.pid;
      deletion = deleteRole();
      void deletion.catch(() => {});
      await waitFor(
        "the Role writer waiting at DELETE on its target row",
        () => blockedAt(callerPid, blockerPid, "%DELETE FROM occ.iam_roles%"),
        5_000,
      );
      revocation = administrator.transact(async (unit) => {
        const result = await state.queryInTransaction(unit, "SELECT pg_backend_pid() AS pid");
        const row = result.rows[0];
        assert.ok(
          typeof row === "object" && row !== null && "pid" in row && typeof row.pid === "number",
        );
        revokerPid = row.pid;
        return administrator.deleteIAMAccessBinding(admin.principalId, namespace.id, bindingId);
      });
      void revocation.catch(() => {});
      await waitFor(
        "the AccessBinding revoker waiting on the Role writer's Namespace lock",
        () =>
          revokerPid === undefined
            ? undefined
            : blockedAt(revokerPid, callerPid, "%FROM occ.namespaces%FOR UPDATE%"),
        5_000,
      );
    } finally {
      try {
        await blocker.query("ROLLBACK");
        discard = false;
      } finally {
        blocker.release(discard);
        await Promise.allSettled([deletion, revocation]);
      }
    }
    assert.equal((await revocation).id, bindingId);
    return await deletion;
  }
  const checkDeniedState = (bindingId: string) =>
    state.read(async (unit) => {
      assert.equal(await unit.iamPolicy.getAccessBinding(namespace.id, bindingId), undefined);
      assert.deepEqual(await unit.iamPolicy.getRole(namespace.id, target.id), target);
    });
  return {
    state,
    installation,
    namespace,
    admin,
    createDelegate,
    createServiceAdministrator,
    delegateRoleId,
    target,
    createTarget,
    grantRead,
    observeGrants,
    callerIAM,
    auditSink: callerState.auditSink,
    controller,
    revokeBeforeDelete,
    deleteBeforeRevoke,
    checkDeniedState,
  };
}

export async function roleDeletionAfterRevocation(context: TestContext) {
  const fixture = await roleDeletionFixture(context);
  const { controller, namespace, target, state } = fixture;
  const delegate = await fixture.createDelegate();
  const binding = await fixture.grantRead(delegate.principalId);
  const beforeRevocation = await fixture.observeGrants(delegate.principalId, true);
  const deleteRole = () => controller.deleteIAMRole(delegate.principalId, namespace.id, target.id);
  await assert.rejects(
    fixture.revokeBeforeDelete(binding.id, deleteRole),
    AuthorizationDeniedError,
  );
  await fixture.checkDeniedState(binding.id);
  assert.deepEqual(
    await fixture.observeGrants(delegate.principalId, false),
    beforeRevocation.filter((grant) => grant.id !== binding.id),
  );

  // Restore the delegate's grant and race the same deletion against removal
  // of another principal's binding. The delegate still has access this time.
  await fixture.grantRead(delegate.principalId);
  const unrelated = await fixture.grantRead(fixture.admin.principalId);
  const beforeUnrelated = await fixture.observeGrants(delegate.principalId, true);
  assert.deepEqual(await fixture.revokeBeforeDelete(unrelated.id, deleteRole), target);
  assert.deepEqual(
    await fixture.observeGrants(delegate.principalId, true),
    beforeUnrelated.filter((grant) => grant.id !== unrelated.id),
  );
  assert.equal(
    await state.read((unit) => unit.iamPolicy.getRole(namespace.id, target.id)),
    undefined,
  );
}

export async function httpRoleDeletionAfterRevocation(context: TestContext) {
  const fixture = await roleDeletionFixture(context);
  const { state, installation, namespace, target } = fixture;
  // Development authentication supplies the browser session. The real Fastify
  // handler, native IAM, Role mutation and audit all use PostgreSQL State.
  const login = await createTestAuthPrincipal({ installationId: installation.id });
  const delegate = await fixture.createDelegate(
    login.auth.principalSeed(login.account, { roleId: fixture.delegateRoleId }),
    login.account.email,
  );
  const principal = await fixture.createServiceAdministrator();
  const firstBinding = await fixture.grantRead(delegate.principalId);
  const origin = "https://console.oce.localhost";
  const app = createFastifyApp({
    controller: fixture.controller,
    iamDriver: fixture.callerIAM,
    auth: login.auth,
    auditSink: fixture.auditSink,
    resolveHarness: resolveApprovedHarness,
    development: { enabled: true, browserOrigin: origin, installationId: installation.id },
  });
  context.after(() => app.close());
  const session = await signInToControllerApp(app, login);
  const deleteRole = (headers: Record<string, string>, roleId = target.id) =>
    app.inject({
      method: "DELETE",
      url: `/namespaces/${namespace.id}/iam/roles/${roleId}`,
      headers: { host: new URL(origin).host, ...headers },
      remoteAddress: "127.0.0.1",
    });

  // Run the writer-first control before the baseline's expected denial failure.
  // The delegate still holds Namespace read at the writer's final check.
  const firstTarget = await fixture.createTarget();
  const beforeWriter = await fixture.observeGrants(delegate.principalId, true);
  const written = await fixture.deleteBeforeRevoke(firstTarget.id, firstBinding.id, () =>
    deleteRole(authenticatedHeaders(session), firstTarget.id),
  );
  assert.equal(written.statusCode, 204);
  const writerRequestId = written.headers["x-request-id"];
  assert.equal(typeof writerRequestId, "string");
  await state.read(async (unit) => {
    assert.equal(await unit.iamPolicy.getRole(namespace.id, firstTarget.id), undefined);
    assert.equal(await unit.iamPolicy.getAccessBinding(namespace.id, firstBinding.id), undefined);
    const mutation = (await unit.audit.list()).find(
      (event) => event.requestId === writerRequestId && event.kind === "mutation",
    );
    assert.ok(mutation);
    assert.equal(mutation.actorId, delegate.principalId);
    assert.equal(mutation.action, "openclaw.iam.roles.delete");
    assert.equal(mutation.outcome, "success");
    assert.equal(mutation.details?.roleId, firstTarget.id);
  });
  assert.deepEqual(
    await fixture.observeGrants(delegate.principalId, false),
    beforeWriter.filter((grant) => grant.id !== firstBinding.id),
  );

  // Restore the exact grant and reverse the order against the original target.
  const binding = await fixture.grantRead(delegate.principalId);
  const beforeRevocation = await fixture.observeGrants(delegate.principalId, true);
  const denied = await fixture.revokeBeforeDelete(binding.id, () =>
    deleteRole(authenticatedHeaders(session)),
  );
  assert.equal(denied.statusCode, 403);
  const body = denied.json<{ error: { code: string }; meta: { requestId: string } }>();
  assert.equal(body.error.code, "FORBIDDEN");
  await fixture.checkDeniedState(binding.id);
  const remainingGrants = beforeRevocation.filter((grant) => grant.id !== binding.id);
  assert.deepEqual(await fixture.observeGrants(delegate.principalId, false), remainingGrants);
  const requestId = denied.headers["x-request-id"];
  assert.equal(typeof requestId, "string");
  assert.equal(body.meta.requestId, requestId);
  const events = await state.read((unit) => unit.audit.list());
  const requestEvents = events.filter((event) => event.requestId === requestId);
  const denial = requestEvents.find((event) => event.kind === "authorization_denial");
  assert.ok(denial);
  assert.equal(denial.actorId, delegate.principalId);
  assert.equal(denial.action, "openclaw.iam.roles.delete");
  assert.equal(denial.outcome, "denied");
  assert.equal(denial.authorization?.action, "read");
  assert.deepEqual(denial.authorization?.resource, {
    kind: "namespace",
    id: namespace.id,
    namespaceId: namespace.id,
  });
  assert.ok(
    !requestEvents.some((event) => event.kind === "mutation" && event.outcome === "success"),
  );

  // The service administrator has Namespace read. Its request takes
  // the other HTTP transaction branch and must delete the same unreferenced Role.
  const key = await login.auth.createServiceKey({ principal, name: "Role deletion control" });
  context.after(() => login.auth.revokeServiceKey(key));
  const allowed = await deleteRole({ [OCC_SERVICE_KEY_HEADER]: key.key });
  assert.equal(allowed.statusCode, 204);
  assert.deepEqual(await fixture.observeGrants(delegate.principalId, false), remainingGrants);
  assert.equal(typeof allowed.headers["x-request-id"], "string");
  await state.read(async (unit) => {
    assert.equal(await unit.iamPolicy.getRole(namespace.id, target.id), undefined);
    const mutation = (await unit.audit.list()).find(
      (event) => event.requestId === allowed.headers["x-request-id"] && event.kind === "mutation",
    );
    assert.ok(mutation);
    assert.equal(mutation.actorId, principal.id);
    assert.equal(mutation.action, "openclaw.iam.roles.delete");
    assert.equal(mutation.outcome, "success");
    assert.equal(mutation.details?.actorServiceKeyId, key.id);
    assert.equal(mutation.details?.roleId, target.id);
  });
}
