import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Pool, PoolClient, QueryResult } from "pg";
import type { ProductionConfig } from "../../apps/controller/src/composition/production.ts";
import type { Permission } from "../../packages/contracts/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { OpenClawController, PostgresPlatformState } from "../../packages/occ/src/index.ts";
import { authenticatedHeaders } from "../helpers/auth-session.mjs";
import { composeProduction } from "../helpers/password-hasher.mjs";
import { waitForLockWaiter } from "../helpers/postgres-lock-waits.mjs";
import { waitFor } from "../helpers/wait-for.mjs";
import { commitAckProxy } from "../fixtures/postgres-commit-ack-proxy.mjs";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function record(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}

export function records(value: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(value));
  return value.map((item: unknown) => record(item));
}

export function text(value: unknown): string {
  assert.ok(typeof value === "string");
  return value;
}

export function recordId(value: unknown): string {
  return text(record(value).id);
}

export function row(result: QueryResult<Record<string, unknown>>): Record<string, unknown> {
  return record(result.rows[0]);
}

function integer(value: unknown): number {
  assert.ok(typeof value === "number" && Number.isInteger(value));
  return value;
}

export function json(value: string): unknown {
  return JSON.parse(value);
}

export function parsePrivateJson(value: string, label: string): unknown {
  try {
    return json(value);
  } catch {
    assert.fail(`${label} must be valid JSON`);
  }
}

export type Session = { cookie: string; origin: string; setCookie: string[] };
export type App = Awaited<ReturnType<typeof composeProduction>>;
export type Request = (
  method: string,
  path: string,
  payload?: unknown,
  caller?: Session,
) => Promise<{ status: number; data?: unknown }>;
type SharingFixture = {
  pool: Pool;
  request: Request;
  signInWithEmailPassword: (options: {
    origin: string;
    email: string;
    password: string;
  }) => Promise<Session>;
  productionDrivers: () => Promise<ProductionConfig["drivers"]>;
  apiLog: { logger: ProductionConfig["logger"] };
  databaseUrl: string;
  authSecret: string;
  authBaseURL: string;
  nativeAdmin: { enabled: boolean; domain: string };
  adminEmail: string;
  password: string;
  namespaceId: string;
  agentId: string;
  configurationId: string;
  app: App;
  endpoint: string;
};

export async function runSharingCases(t: TestContext, fixture: SharingFixture): Promise<void> {
  const {
    pool,
    request,
    signInWithEmailPassword,
    productionDrivers,
    apiLog,
    databaseUrl,
    authSecret,
    authBaseURL,
    nativeAdmin,
    adminEmail,
    password,
    namespaceId,
    agentId,
    configurationId,
  } = fixture;

  // Account enrollment is a precondition, not the behavior under test. Seed an
  // existing Installation-reader Role, then provision people through the real API.
  // Their initial Role grants no Namespace, Agent, or policy administration access.
  const readerRoleId = `role-reader-${randomUUID()}`;
  await pool.query("INSERT INTO occ.iam_roles (id, name, permissions) VALUES ($1, $2, $3)", [
    readerRoleId,
    "Installation reader",
    JSON.stringify([{ action: "read", resourceKind: "installation" }]),
  ]);
  const people = [];
  for (const label of ["recipient", "unaffected"]) {
    const email = `${label}-${randomUUID()}@example.test`;
    const personPassword = `sharing-${randomUUID()}`;
    const created = await request("POST", "/api/auth/accounts", {
      email,
      password: personPassword,
      name: label,
      roleId: readerRoleId,
    });
    assert.equal(created.status, 201);
    const personSession = await signInWithEmailPassword({
      origin: fixture.endpoint,
      email,
      password: personPassword,
    });
    people.push({ principalId: text(record(created.data).principalId), session: personSession });
    assert.deepEqual((await request("GET", "/namespaces", undefined, personSession)).data, []);
  }
  const agentsPath = `/namespaces/${namespaceId}/agents`;
  const policyPath = `/namespaces/${namespaceId}/iam`;
  const sibling = await request("POST", agentsPath, {
    name: `private-sibling-${randomUUID()}`,
    configurationId,
  });
  assert.equal(sibling.status, 201);
  const discoveryRole = await request("POST", `${policyPath}/roles`, {
    name: "Namespace discovery",
    permissions: [{ action: "read", resourceKind: "namespace" }],
  });
  const agentRole = await request("POST", `${policyPath}/roles`, {
    name: "Agent native administration",
    permissions: [
      { action: "read", resourceKind: "agent" },
      { action: "administer", resourceKind: "agent" },
    ],
  });
  assert.equal(discoveryRole.status, 201);
  assert.equal(agentRole.status, 201);
  const bindings: Record<string, unknown>[] = [];
  for (const person of people) {
    assert.equal(
      (await request("GET", `${agentsPath}/${agentId}`, undefined, person.session)).status,
      403,
    );
    // Use the same exact-scope API sequence as Console sharing. An account's
    // ability to sign in does not by itself grant discovery or sibling access.
    for (const [resourceKind, resourceId, roleId] of [
      ["namespace", namespaceId, recordId(discoveryRole.data)],
      ["agent", agentId, recordId(agentRole.data)],
    ]) {
      const binding = await request("POST", `${policyPath}/access-bindings`, {
        subjectKind: "identity",
        subjectId: person.principalId,
        roleId,
        resourceKind,
        resourceId,
      });
      assert.equal(binding.status, 201);
      if (resourceKind === "agent") {
        bindings.push(record(binding.data));
      }
    }
  }

  // A fresh application and IAM instance must reconstruct both authority and
  // sessions from PostgreSQL. Keep the same cookies; do not mint fixture sessions.
  await fixture.app.close();
  fixture.app = await composeProduction({
    mode: "production",
    host: "127.0.0.1",
    databaseUrl,
    authSecret,
    authBaseURL,
    nativeAdmin,
    drivers: await productionDrivers(),
    logger: apiLog.logger,
  });
  let bodyAdmission: { marker: string; resolve: (requestId: string) => void } | undefined;
  let policyRequestId: string | undefined;
  // Observe completed production admission without replacing it or pausing a
  // handler. A real HTTP request can still be uploading its body at this point.
  fixture.app.addHook("preParsing", async (request, _reply, payload) => {
    if (
      (request.method === "POST" || request.method === "DELETE") &&
      request.url.startsWith(`${policyPath}/`)
    ) {
      policyRequestId = request.id;
    }
    if (
      bodyAdmission !== undefined &&
      bodyAdmission.marker === request.headers["x-test-admission"]
    ) {
      bodyAdmission.resolve(request.id);
    }
    return payload;
  });
  fixture.endpoint = await fixture.app.listen({ port: 0, host: "127.0.0.1" });
  for (const person of people) {
    const namespaces = await request("GET", "/namespaces", undefined, person.session);
    assert.equal(namespaces.status, 200);
    assert.deepEqual(
      records(namespaces.data).map(({ id }) => id),
      [namespaceId],
    );
    const agents = await request("GET", agentsPath, undefined, person.session);
    assert.equal(agents.status, 200);
    assert.deepEqual(
      records(agents.data).map(({ id }) => id),
      [agentId],
    );
    assert.equal(
      (await request("GET", `${agentsPath}/${agentId}`, undefined, person.session)).status,
      200,
    );
    assert.equal(
      (await request("GET", `${agentsPath}/${recordId(sibling.data)}`, undefined, person.session))
        .status,
      403,
    );
    assert.equal(
      (
        await request(
          "GET",
          `/namespaces/${namespaceId}/configurations/${configurationId}`,
          undefined,
          person.session,
        )
      ).status,
      403,
    );
    assert.equal(
      (await request("GET", `${policyPath}/roles`, undefined, person.session)).status,
      403,
    );
  }

  const [recipient, unaffected] = people;
  assert.ok(recipient && unaffected);
  const [recipientBinding, unaffectedBinding] = bindings;
  assert.ok(recipientBinding && unaffectedBinding);
  const revoked = await request(
    "DELETE",
    `${policyPath}/access-bindings/${recordId(recipientBinding)}`,
  );
  assert.equal(revoked.status, 204);
  // Check the next real authenticated HTTP request, not a manufactured abort or
  // changed cookie. This does not claim closure of an already-open native stream.
  assert.equal(
    (await request("GET", `${agentsPath}/${agentId}`, undefined, recipient.session)).status,
    403,
  );
  assert.deepEqual((await request("GET", agentsPath, undefined, recipient.session)).data, []);
  assert.deepEqual(
    records((await request("GET", "/namespaces", undefined, recipient.session)).data).map(
      ({ id }) => id,
    ),
    [namespaceId],
  );
  assert.equal(
    (await request("GET", `${agentsPath}/${agentId}`, undefined, unaffected.session)).status,
    200,
  );
  const remaining = await request("GET", `${policyPath}/access-bindings`);
  assert.equal(remaining.status, 200);
  assert.equal(
    records(remaining.data).some(({ id }) => id === recordId(recipientBinding)),
    false,
  );
  assert.equal(
    records(remaining.data).some(({ id }) => id === recordId(unaffectedBinding)),
    true,
  );

  const grant = {
    subjectKind: "identity",
    subjectId: recipient.principalId,
    roleId: recordId(agentRole.data),
    resourceKind: "agent",
    resourceId: agentId,
  };
  const signInAdministrator = () =>
    signInWithEmailPassword({ origin: fixture.endpoint, email: adminEmail, password });

  await t.test("a revoked assigning session cannot finish an admitted sharing grant", async () => {
    const assigning = await signInAdministrator();
    const marker = randomUUID();
    const admitted = Promise.withResolvers<string>();
    bodyAdmission = { marker, resolve: admitted.resolve };
    const encoded = JSON.stringify(grant);
    const response = Promise.withResolvers<number | undefined>();
    const upload = httpRequest(
      `${fixture.endpoint}${policyPath}/access-bindings`,
      {
        method: "POST",
        headers: authenticatedHeaders(assigning, {
          origin: authBaseURL,
          "x-test-admission": marker,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(encoded),
        }),
      },
      (received) => {
        received.once("error", response.reject);
        received.once("end", () => response.resolve(received.statusCode));
        received.resume();
      },
    );
    upload.on("error", response.reject);
    response.promise.catch(() => {});
    try {
      upload.write(encoded.slice(0, 1));
      const requestId = await admitted.promise;
      // Logout completes after admission but before the policy transaction starts.
      assert.equal((await request("POST", "/api/auth/sign-out", undefined, assigning)).status, 200);
      assert.equal((await request("GET", `${policyPath}/roles`, undefined, assigning)).status, 401);
      upload.end(encoded.slice(1));
      const deniedStatus = await response.promise;
      assert.equal(deniedStatus, 403, "the revoked assigning session must be denied");
      assert.equal(
        (await request("GET", `${agentsPath}/${agentId}`, undefined, recipient.session)).status,
        403,
      );
      const persisted = await pool.query(
        "SELECT id FROM occ.iam_access_bindings WHERE namespace_id=$1 AND identity_subject_id=$2 AND resource_id=$3",
        [namespaceId, recipient.principalId, agentId],
      );
      assert.equal(persisted.rowCount, 0, "a denied assigning session must leave no grant");
      const events = (
        await new PostgresPlatformState(pool).transact((unit) => unit.audit.list())
      ).filter((event) => event.requestId === requestId);
      assert.ok(events.some(({ kind }) => kind === "authorization_denial"));
      assert.equal(
        events.some(({ kind }) => kind === "mutation"),
        false,
      );
      t.diagnostic(
        JSON.stringify({
          scenario: "revoked-after-http-admission",
          status: deniedStatus,
          persistedGrants: persisted.rowCount,
          denialAudit: events.filter(({ kind }) => kind === "authorization_denial").length,
          successAudit: events.filter(({ kind }) => kind === "mutation").length,
        }),
      );
    } finally {
      bodyAdmission = undefined;
      upload.destroy();
    }
  });

  await t.test(
    "a sharing commit orders cross-replica logout and releases its session hold",
    async () => {
      const assigning = await signInAdministrator();
      const replica = await composeProduction({
        mode: "production",
        host: "127.0.0.1",
        databaseUrl,
        authSecret,
        authBaseURL,
        nativeAdmin,
        drivers: await productionDrivers(),
        logger: apiLog.logger,
      });
      const replicaEndpoint = await replica.listen({ port: 0, host: "127.0.0.1" });
      const blocker = await pool.connect();
      let released = false;
      let pendingGrant: ReturnType<Request> | undefined;
      let pendingLogout: Promise<Response> | undefined;
      try {
        await blocker.query("BEGIN");
        const pid = integer(
          row(await blocker.query<Record<string, unknown>>("SELECT pg_backend_pid() AS pid")).pid,
        );
        await blocker.query("SELECT id FROM occ.namespaces WHERE id=$1 FOR UPDATE", [namespaceId]);
        pendingGrant = request("POST", `${policyPath}/access-bindings`, grant, assigning);
        const protectedPid: unknown = await waitForLockWaiter(
          pool,
          pid,
          "the protected sharing write waiting for the Namespace",
        );
        // Another API instance has no shared JavaScript lock. PostgreSQL must
        // keep logout from deleting the assigning session before this commit.
        pendingLogout = fetch(`${replicaEndpoint}/api/auth/sign-out`, {
          method: "POST",
          headers: authenticatedHeaders(assigning, { origin: authBaseURL }),
        });
        await waitForLockWaiter(
          pool,
          integer(protectedPid),
          "cross-replica logout waiting on the held session",
        );
        await blocker.query("COMMIT");
        released = true;
        const committed = await pendingGrant;
        assert.equal(committed.status, 201);
        const logout = await pendingLogout;
        assert.equal(logout.status, 200);
        const committedRows = await pool.query(
          "SELECT id FROM occ.iam_access_bindings WHERE id=$1",
          [recordId(committed.data)],
        );
        assert.equal(committedRows.rowCount, 1);
        const committedEvents = (
          await new PostgresPlatformState(pool).transact((unit) => unit.audit.list())
        ).filter((event) => event.requestId === policyRequestId);
        assert.ok(committedEvents.some(({ kind }) => kind === "mutation"));
        t.diagnostic(
          JSON.stringify({
            scenario: "cross-replica-logout",
            policyStatus: committed.status,
            logoutStatus: logout.status,
            persistedGrants: committedRows.rowCount,
            successAudit: committedEvents.filter(({ kind }) => kind === "mutation").length,
          }),
        );
        assert.equal(
          (await request("GET", `${policyPath}/roles`, undefined, assigning)).status,
          401,
        );
        assert.equal(
          (await request("GET", `${agentsPath}/${agentId}`, undefined, recipient.session)).status,
          200,
        );
        assert.equal(
          (await request("DELETE", `${policyPath}/access-bindings/${recordId(committed.data)}`))
            .status,
          204,
        );
        assert.equal(
          (await request("GET", `${agentsPath}/${agentId}`, undefined, recipient.session)).status,
          403,
        );
      } finally {
        if (!released) {
          await blocker.query("ROLLBACK");
        }
        blocker.release();
        await Promise.allSettled([pendingGrant, pendingLogout]);
        await replica.close();
      }
    },
  );

  await t.test(
    "expiry after the last client check rejects COMMIT without persisting sharing authority",
    async () => {
      const proxy = await commitAckProxy(databaseUrl);
      let replica: App | undefined;
      let blocker: PoolClient | undefined;
      let released = false;
      let pending: Promise<Response> | undefined;
      let requestId: string | undefined;
      let committedBindingId: string | undefined;
      try {
        replica = await composeProduction({
          mode: "production",
          host: "127.0.0.1",
          databaseUrl: proxy.url,
          authSecret,
          authBaseURL,
          nativeAdmin,
          drivers: await productionDrivers(),
          logger: apiLog.logger,
        });
        const path = `${policyPath}/access-bindings`;
        replica.addHook("preParsing", async (request, _reply, payload) => {
          if (request.method === "POST" && request.url === path) {
            requestId = request.id;
          }
          return payload;
        });
        const replicaEndpoint = await replica.listen({ port: 0, host: "127.0.0.1" });
        const assigning = await signInWithEmailPassword({
          origin: replicaEndpoint,
          email: adminEmail,
          password,
        });
        await pool.query(
          `UPDATE occ.session SET expires_at=clock_timestamp()+interval '3 seconds'
         WHERE id=(SELECT s.id FROM occ.session s JOIN occ."user" u ON u.id=s.user_id
                   WHERE u.email=$1 ORDER BY s.created_at DESC LIMIT 1)`,
          [adminEmail],
        );
        blocker = await pool.connect();
        await blocker.query("BEGIN");
        const pid = integer(
          row(await blocker.query<Record<string, unknown>>("SELECT pg_backend_pid() AS pid")).pid,
        );
        await blocker.query("SELECT id FROM occ.namespaces WHERE id=$1 FOR UPDATE", [namespaceId]);
        pending = fetch(`${replicaEndpoint}${path}`, {
          method: "POST",
          headers: authenticatedHeaders(assigning, {
            origin: authBaseURL,
            "content-type": "application/json",
          }),
          body: JSON.stringify(grant),
        });
        // Arm only after the IAM unit holds the session and waits for its
        // Namespace, so authentication's earlier transactions are unaffected.
        await waitForLockWaiter(pool, pid, "the policy transaction waiting for its Namespace");
        proxy.arm({ pauseCommit: true });
        await blocker.query("COMMIT");
        released = true;
        await waitFor("COMMIT paused after the client's expiry checks", () =>
          proxy.commitPaused ? true : undefined,
        );
        // Time passes after every client check, before the real server sees
        // COMMIT. No clock, auth, State or IAM implementation is replaced.
        await waitFor("the assigning session expiring before server COMMIT", async () => {
          const expiry = await pool.query<Record<string, unknown>>(
            `SELECT expires_at <= clock_timestamp() AS expired FROM occ.session
           WHERE user_id=(SELECT id FROM occ."user" WHERE email=$1)
           ORDER BY created_at DESC LIMIT 1`,
            [adminEmail],
          );
          const expired = row(expiry).expired;
          assert.ok(typeof expired === "boolean");
          return expired ? true : undefined;
        });
        proxy.resumeCommit();
        const denied = await pending;
        const responseBody = parsePrivateJson(await denied.text(), "sharing grant response");
        if (denied.status === 201) {
          // Keep the unexpected grant ID so teardown can remove a leaked binding.
          committedBindingId = recordId(record(responseBody).data);
        }
        assert.equal(denied.status, 403, "the expired assigning session must be denied");
        const persisted = await pool.query(
          "SELECT id FROM occ.iam_access_bindings WHERE namespace_id=$1 AND identity_subject_id=$2 AND resource_id=$3",
          [namespaceId, recipient.principalId, agentId],
        );
        assert.equal(persisted.rowCount, 0, "server commit rejection must roll back the grant");
        assert.ok(requestId);
        const events = (
          await new PostgresPlatformState(pool).transact((unit) => unit.audit.list())
        ).filter((event) => event.requestId === requestId);
        assert.ok(events.some(({ kind }) => kind === "authorization_denial"));
        assert.equal(
          events.some(({ kind }) => kind === "mutation"),
          false,
        );
        t.diagnostic(
          JSON.stringify({
            scenario: "expired-before-server-commit",
            status: denied.status,
            persistedGrants: persisted.rowCount,
            denialAudit: events.filter(({ kind }) => kind === "authorization_denial").length,
            successAudit: events.filter(({ kind }) => kind === "mutation").length,
          }),
        );
        const following = await request("POST", path, grant);
        assert.equal(following.status, 201);
        assert.equal((await request("DELETE", `${path}/${recordId(following.data)}`)).status, 204);
      } finally {
        if (blocker) {
          if (!released) {
            await blocker.query("ROLLBACK");
          }
          blocker.release();
        }
        if (proxy.commitPaused) {
          proxy.resumeCommit();
        }
        await pending?.catch(() => {});
        await replica?.close();
        await proxy.close();
        if (committedBindingId !== undefined) {
          await request("DELETE", `${policyPath}/access-bindings/${committedBindingId}`);
        }
      }
    },
  );

  await t.test("expiry rolls back a waiting sharing grant and releases its locks", async () => {
    const assigning = await signInAdministrator();
    // Expiry is a clock boundary, not a competing UPDATE that row locks can delay.
    await pool.query(
      `UPDATE occ.session SET expires_at=clock_timestamp()+interval '3 seconds'
     WHERE id=(SELECT s.id FROM occ.session s JOIN occ."user" u ON u.id=s.user_id
               WHERE u.email=$1 ORDER BY s.created_at DESC LIMIT 1)`,
      [adminEmail],
    );
    const blocker = await pool.connect();
    let released = false;
    let pending: ReturnType<Request> | undefined;
    try {
      await blocker.query("BEGIN");
      const pid = integer(
        row(await blocker.query<Record<string, unknown>>("SELECT pg_backend_pid() AS pid")).pid,
      );
      await blocker.query("SELECT id FROM occ.namespaces WHERE id=$1 FOR UPDATE", [namespaceId]);
      pending = request("POST", `${policyPath}/access-bindings`, grant, assigning);
      await waitForLockWaiter(pool, pid, "the expiring sharing write waiting for the Namespace");
      await delay(3_100);
      await blocker.query("COMMIT");
      released = true;
      const denied = await pending;
      assert.equal(denied.status, 403);
      assert.equal(
        (await request("GET", `${agentsPath}/${agentId}`, undefined, recipient.session)).status,
        403,
      );
      const persisted = await pool.query(
        "SELECT id FROM occ.iam_access_bindings WHERE namespace_id=$1 AND identity_subject_id=$2 AND resource_id=$3",
        [namespaceId, recipient.principalId, agentId],
      );
      assert.equal(persisted.rowCount, 0, "expiry must roll back the grant, not just its response");
      const events = (
        await new PostgresPlatformState(pool).transact((unit) => unit.audit.list())
      ).filter((event) => event.requestId === policyRequestId);
      assert.ok(events.some(({ kind }) => kind === "authorization_denial"));
      assert.equal(
        events.some(({ kind }) => kind === "mutation"),
        false,
      );
      t.diagnostic(
        JSON.stringify({
          scenario: "expired-during-policy-wait",
          status: denied.status,
          persistedGrants: persisted.rowCount,
          denialAudit: events.filter(({ kind }) => kind === "authorization_denial").length,
          successAudit: events.filter(({ kind }) => kind === "mutation").length,
        }),
      );
      // Another authorized session can immediately write and remove the same grant.
      const following = await request("POST", `${policyPath}/access-bindings`, grant);
      assert.equal(following.status, 201);
      assert.equal(
        (await request("DELETE", `${policyPath}/access-bindings/${recordId(following.data)}`))
          .status,
        204,
      );
    } finally {
      if (!released) {
        await blocker.query("ROLLBACK");
      }
      blocker.release();
      await pending?.catch(() => {});
    }
  });

  await t.test("configured read grants fence Namespace IAM mutations through COMMIT", async (t) => {
    const state = new PostgresPlatformState(pool);
    const installation = await state.loadInstallation();
    assert.ok(installation);
    assert.deepEqual(await state.read((unit) => unit.iamPolicy.listConfiguredPolicy()), {
      roles: [],
      groups: [],
      bindings: [],
    });
    const namespaceName = text(
      row(
        await pool.query<Record<string, unknown>>("SELECT name FROM occ.namespaces WHERE id=$1", [
          namespaceId,
        ]),
      ).name,
    );
    const configuredName = `policy_reader_${randomUUID().replaceAll("-", "")}`;
    const groupName = `policy-reader-${randomUUID()}`;
    const granted: readonly Permission[] = [
      { action: "read", resourceKind: "namespace" },
      { action: "read", resourceKind: "agent" },
      { action: "read", resourceKind: "configuration" },
    ];
    // Use the same configuration application that production startup calls, on
    // another controller and transaction. Its Group binding stays unchanged;
    // only the configured Role's supported read permissions change.
    const configurationController = (permissions: readonly Permission[]) => {
      const configurationState = new PostgresPlatformState(pool);
      const iam = new NativeIAMDriver(configurationState, { id: `configuration-${randomUUID()}` });
      const controller = new OpenClawController(installation, {
        state: configurationState,
        iamConfiguration: {
          roles: [{ id: configuredName, permissions }],
          defaultUserGroups: [],
          roleBindings: [
            { group: groupName, role: configuredName, scope: { namespace: namespaceName } },
          ],
        },
        recordOperations: false,
      });
      controller.registerDriver(iam);
      controller.selectDriver("iam", iam.id);
      return { controller, state: configurationState };
    };
    const grantConfiguration = configurationController(granted);
    await grantConfiguration.controller.applyIAMConfiguration();
    const configuredBindings = await pool.query<Record<string, unknown>>(
      "SELECT id FROM occ.iam_access_bindings WHERE role_id=$1 ORDER BY id",
      [`role_config_${configuredName}`],
    );
    assert.equal(configuredBindings.rowCount, 1);

    // This appointed administrator's Installation authority is independent of
    // configured Roles, which cannot contain Installation permissions.
    const administratorRoleId = `role-${randomUUID()}`;
    await pool.query("INSERT INTO occ.iam_roles (id, name, permissions) VALUES ($1, $2, $3)", [
      administratorRoleId,
      "Policy configuration administrator",
      JSON.stringify([
        { action: "read", resourceKind: "installation" },
        { action: "administer", resourceKind: "installation" },
      ]),
    ]);
    const email = `policy-administrator-${randomUUID()}@example.test`;
    const personPassword = `policy-${randomUUID()}`;
    const created = await request("POST", "/api/auth/accounts", {
      email,
      password: personPassword,
      name: "Policy configuration administrator",
      roleId: administratorRoleId,
    });
    assert.equal(created.status, 201);
    const assigning = await signInWithEmailPassword({
      origin: fixture.endpoint,
      email,
      password: personPassword,
    });
    await pool.query(
      "INSERT INTO occ.iam_group_memberships (namespace_id, group_id, principal_id) VALUES (NULL, $1, $2)",
      [`group_config_${groupName}`, text(record(created.data).principalId)],
    );
    assert.equal((await request("GET", `${policyPath}/roles`, undefined, assigning)).status, 200);
    assert.equal(
      (await request("GET", `${agentsPath}/${agentId}`, undefined, assigning)).status,
      200,
    );

    const policyRows = async () => ({
      roles: (
        await pool.query(
          "SELECT id, name, permissions FROM occ.iam_roles WHERE namespace_id=$1 ORDER BY id",
          [namespaceId],
        )
      ).rows,
      bindings: (
        await pool.query(
          "SELECT id, identity_subject_id, group_subject_id, role_id, resource_kind, resource_id FROM occ.iam_access_bindings WHERE namespace_id=$1 ORDER BY id",
          [namespaceId],
        )
      ).rows,
    });
    const assertUnrelatedGrant = async () => {
      assert.equal(
        (await request("GET", `${agentsPath}/${agentId}`, undefined, unaffected.session)).status,
        200,
      );
      assert.equal(
        (
          await pool.query("SELECT id FROM occ.iam_access_bindings WHERE id=$1", [
            recordId(unaffectedBinding),
          ])
        ).rowCount,
        1,
      );
      assert.deepEqual(
        (
          await pool.query("SELECT id FROM occ.iam_access_bindings WHERE role_id=$1 ORDER BY id", [
            `role_config_${configuredName}`,
          ])
        ).rows,
        configuredBindings.rows,
      );
    };
    type MutationKind =
      "create Role" | "delete Role" | "create AccessBinding" | "delete AccessBinding";
    const prepareMutation = async (kind: MutationKind) => {
      const roleName = `configuration-fence-${randomUUID()}`;
      const roleBody = { name: roleName, permissions: [{ action: "read", resourceKind: "agent" }] };
      let roleId: string | undefined;
      let bindingId: string | undefined;
      if (kind !== "create Role") {
        const role = await request("POST", `${policyPath}/roles`, roleBody);
        assert.equal(role.status, 201);
        roleId = recordId(role.data);
      }
      const bindingBody = { ...grant, roleId };
      if (kind === "delete AccessBinding") {
        const binding = await request("POST", `${policyPath}/access-bindings`, bindingBody);
        assert.equal(binding.status, 201);
        bindingId = recordId(binding.data);
      }
      const isRole = kind.endsWith("Role");
      const isCreate = kind.startsWith("create");
      const path = `${policyPath}/${isRole ? "roles" : "access-bindings"}${isCreate ? "" : `/${isRole ? roleId : bindingId}`}`;
      const observe = () =>
        isRole
          ? pool.query<Record<string, unknown>>(
              "SELECT id FROM occ.iam_roles WHERE namespace_id=$1 AND name=$2",
              [namespaceId, roleName],
            )
          : pool.query<Record<string, unknown>>(
              "SELECT id FROM occ.iam_access_bindings WHERE namespace_id=$1 AND role_id=$2",
              [namespaceId, roleId],
            );
      return {
        run: () =>
          request(
            isCreate ? "POST" : "DELETE",
            path,
            isCreate ? (isRole ? roleBody : bindingBody) : undefined,
            assigning,
          ),
        expectedStatus: isCreate ? 201 : 204,
        expectedRows: isCreate ? 1 : 0,
        observe,
        cleanup: async () => {
          for (const entry of (await observe()).rows) {
            assert.equal(
              (
                await request(
                  "DELETE",
                  `${policyPath}/${isRole ? "roles" : "access-bindings"}/${recordId(entry)}`,
                )
              ).status,
              204,
            );
          }
          if (!isRole) {
            assert.equal((await request("DELETE", `${policyPath}/roles/${roleId}`)).status, 204);
          }
        },
      };
    };

    for (const kind of [
      "create Role",
      "delete Role",
      "create AccessBinding",
      "delete AccessBinding",
    ] as const) {
      // Binding creation additionally needs read on the exact target. The other
      // three cases withdraw Namespace read without removing their Group binding.
      const revokedKind = kind === "create AccessBinding" ? "agent" : "namespace";
      const revoked = configurationController(
        granted.filter(({ resourceKind }) => resourceKind !== revokedKind),
      );
      for (const order of ["configuration first", "policy first"] as const) {
        await t.test(`${kind}: ${order}`, async () => {
          await grantConfiguration.controller.applyIAMConfiguration();
          const mutation = await prepareMutation(kind);
          const before = await policyRows();
          let pendingMutation: ReturnType<Request> | undefined;
          let pendingConfiguration: Promise<void> | undefined;
          const releaseConfiguration = Promise.withResolvers<void>();
          let blocker: PoolClient | undefined;
          let released = false;
          try {
            if (order === "configuration first") {
              const written = Promise.withResolvers<number>();
              pendingConfiguration = revoked.controller.transact(async (unit) => {
                await revoked.controller.applyIAMConfiguration();
                written.resolve(
                  integer(
                    record(
                      (
                        await revoked.state.queryInTransaction(
                          unit,
                          "SELECT pg_backend_pid() AS pid",
                        )
                      ).rows[0],
                    ).pid,
                  ),
                );
                await releaseConfiguration.promise;
              });
              pendingConfiguration.catch(written.reject);
              const configurationPid = await written.promise;
              pendingMutation = mutation.run();
              await Promise.race([
                waitForLockWaiter(
                  pool,
                  configurationPid,
                  "the IAM mutation waiting for configured read revocation",
                  { queryLike: "SELECT pg_advisory_xact_lock_shared(%" },
                ),
                pendingMutation.then(({ status }) =>
                  assert.fail(`IAM mutation returned ${status} before configuration COMMIT`),
                ),
              ]);
              releaseConfiguration.resolve();
              await pendingConfiguration;
              const denied = await pendingMutation;
              const requestId = policyRequestId;
              assert.equal(denied.status, 403);
              assert.deepEqual(
                await policyRows(),
                before,
                "revocation-first denial leaves policy unchanged",
              );
              const events = (await state.transact((unit) => unit.audit.list())).filter(
                (event) => event.requestId === requestId,
              );
              assert.ok(events.some(({ kind }) => kind === "authorization_denial"));
              assert.equal(
                events.some(({ kind }) => kind === "mutation"),
                false,
              );
            } else {
              blocker = await pool.connect();
              await blocker.query("BEGIN");
              const blockerPid = integer(
                row(await blocker.query<Record<string, unknown>>("SELECT pg_backend_pid() AS pid"))
                  .pid,
              );
              await blocker.query("SELECT id FROM occ.namespaces WHERE id=$1 FOR UPDATE", [
                namespaceId,
              ]);
              pendingMutation = mutation.run();
              const mutationPid = integer(
                await waitForLockWaiter(
                  pool,
                  blockerPid,
                  "the IAM mutation waiting for its Namespace",
                ),
              );
              pendingConfiguration = revoked.controller.applyIAMConfiguration();
              await Promise.race([
                waitForLockWaiter(
                  pool,
                  mutationPid,
                  "configuration revocation waiting for the IAM mutation",
                  { queryLike: "SELECT pg_advisory_xact_lock(%" },
                ),
                pendingConfiguration.then(() =>
                  assert.fail("configuration committed before the IAM mutation released its fence"),
                ),
              ]);
              await blocker.query("COMMIT");
              released = true;
              const committed = await pendingMutation;
              const requestId = policyRequestId;
              assert.equal(committed.status, mutation.expectedStatus);
              await pendingConfiguration;
              assert.equal((await mutation.observe()).rowCount, mutation.expectedRows);
              const events = (await state.transact((unit) => unit.audit.list())).filter(
                (event) => event.requestId === requestId,
              );
              assert.equal(events.filter(({ kind }) => kind === "mutation").length, 1);
              assert.equal(
                events.some(({ kind }) => kind === "authorization_denial"),
                false,
              );
            }
            const deniedPath =
              revokedKind === "agent" ? `${agentsPath}/${agentId}` : `/namespaces/${namespaceId}`;
            assert.equal((await request("GET", deniedPath, undefined, assigning)).status, 403);
            await assertUnrelatedGrant();
          } finally {
            releaseConfiguration.resolve();
            if (blocker !== undefined) {
              if (!released) {
                await blocker.query("ROLLBACK");
              }
              blocker.release();
            }
            await Promise.allSettled([pendingMutation, pendingConfiguration]);
            await mutation.cleanup();
          }
        });
      }
    }
  });
}
