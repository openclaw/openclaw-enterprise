import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import type { Pool } from "pg";
import type { AuthorizationRequest } from "../../packages/contracts/src/index.ts";
import { createAuthPrincipalSeed, NativeIAMDriver } from "../../packages/iam/src/index.ts";
import {
  AuthorizationDeniedError,
  OpenClawController,
  PostgresPlatformState,
} from "../../packages/occ/src/index.ts";
import { databaseUrl, testPool } from "../helpers/postgres-database.mjs";
import {
  createNamespaceAgentState,
  identifier,
  isLockTimeout,
} from "./postgres-namespace-iam-fixture.ts";

export async function actorAuthorityThroughCommit(context: TestContext) {
  const pool: Pool = testPool(context, { connectionString: databaseUrl });
  const state = new PostgresPlatformState(pool);
  const iam = new NativeIAMDriver(state, { id: `postgres-iam-commit-fence-${randomUUID()}` });
  const { installation, namespace, agent } = await createNamespaceAgentState(state);
  const issuer = "https://identity.example.com";

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
  async function humanActor(roleId: string) {
    const userId = randomUUID();
    const seed = createAuthPrincipalSeed(installation.id, issuer, { id: userId }, { roleId });
    await state.appendNativeIAMPrincipal(seed);
    await pool.query(
      `INSERT INTO occ."user" (id, name, email, created_at, updated_at)
       VALUES ($1, 'Fence actor', $2, clock_timestamp(), clock_timestamp())`,
      [userId, `fence-${userId}@example.test`],
    );
    await pool.query(
      `INSERT INTO occ.human_authentication_accounts (user_id, installation_id, principal_id)
       VALUES ($1, $2, $3)`,
      [userId, installation.id, seed.principal.id],
    );
    return { userId, principalId: seed.principal.id };
  }
  const admin = await humanActor(roles.admin);
  // Account seeds scope their binding to the Installation resource; the administrator
  // also holds the Role across the Installation, like the bootstrap administrator.
  await pool.query(
    `INSERT INTO occ.iam_access_bindings (id, identity_subject_id, role_id) VALUES ($1, $2, $3)`,
    [identifier("binding"), admin.principalId, roles.admin],
  );
  const delegate = await humanActor(roles.delegate);

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
