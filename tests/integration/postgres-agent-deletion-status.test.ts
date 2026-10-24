import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";

import type { ControllerAppOptions } from "../../apps/controller/src/index.ts";
import { betterAuthIssuer } from "../../apps/controller/src/auth/index.ts";
import { ControllerWorker } from "../../apps/controller/src/worker.ts";
import { validateAuthAccountPrincipalSeed } from "../../packages/iam/src/index.ts";
import {
  OpenClawController,
  PostgresHumanAuthentication,
  PostgresWorkQueue,
} from "../../packages/occ/src/index.ts";
import { authenticatedHeaders, signInToControllerApp } from "../helpers/auth-session.mjs";
import { createPostgresAgentApp } from "../helpers/postgres-agent-app.mjs";
import { databaseUrl, requiresPostgres } from "../helpers/postgres-database.mjs";
import { waitFor } from "../helpers/wait-for.mjs";

test(
  "Agent deletion receipts follow real work through lost claims, takeover and removal of Agent access",
  requiresPostgres,
  async (t) => {
    // Seed a revision without starting its compute work. The users, their sessions and scoped
    // grants, the deletion, work claims and finalization all use their normal persisted paths.
    const f = await createPostgresAgentApp(t, {
      appOptions: {
        async provisionAuthAccount(seed, auditEvent, prepared) {
          const id = installation!.id;
          validateAuthAccountPrincipalSeed(seed, await f.state.loadNativeIAMState(id), id);
          const accounts = new PostgresHumanAuthentication(f.state, id, betterAuthIssuer(id));
          await accounts.provisionPasswordAccount(prepared, seed, auditEvent);
        },
      } satisfies Pick<ControllerAppOptions, "provisionAuthAccount">,
      controllerOptions: undefined,
      sandboxDriver: undefined,
      stateOptions: undefined,
      label: "agent-deletion-status",
      authSecret: "agent-deletion-status-postgres-password-32-chars",
    });
    const { namespace, agent } = await f.deployAgent("Deletion status");
    const installation = await f.state.loadInstallation();
    assert.ok(installation);
    const controller = new OpenClawController(installation, { state: f.state });
    const iam = f.controller.selectedDriver("iam");
    controller.registerDriver(iam);
    controller.selectDriver("iam", iam.id);
    const app = f.createApp(controller);
    const base = `/namespaces/${namespace.id}/agents/${agent.id}`;
    const statusPath = base + "/deletion-status";
    const policy = `/namespaces/${namespace.id}/iam`;
    async function create(path: string, body: object) {
      const res = await f.inject("POST", path, body);
      assert.equal(res.statusCode, 201, res.body);
      return res.json().data;
    }
    async function reader() {
      const credentials = {
        email: `deletion-${randomUUID()}@example.test`,
        password: randomUUID(),
      };
      const { principalId: subjectId } = await create("/api/auth/accounts", credentials);
      const grant = async (resourceKind: string, resourceId: string, actions: string[]) => {
        const role = await create(policy + "/roles", {
          permissions: actions.map((action) => ({ action, resourceKind })),
        });
        const binding = await create(policy + "/access-bindings", {
          subjectKind: "identity",
          subjectId,
          roleId: role.id,
          resourceKind,
          resourceId,
        });
        return async () => {
          const res = await f.inject("DELETE", policy + "/access-bindings/" + binding.id);
          assert.equal(res.statusCode, 204, res.body);
        };
      };
      const revokeAgent = await grant("agent", agent.id, ["read", "delete"]);
      const revokeNamespace = await grant("namespace", namespace.id, ["read"]);
      const session = await signInToControllerApp(app, credentials);
      const headers = authenticatedHeaders(session, { host: "127.0.0.1" });
      return {
        credentials,
        headers,
        revokeAgent,
        revokeNamespace,
        async request() {
          const accepted = await app.inject({ method: "DELETE", url: base, headers });
          assert.equal(accepted.statusCode, 202, accepted.body);
          const { data, meta } = accepted.json();
          assert.equal(data.id, agent.id);
          assert.equal(data.status, "deleting");
          assert.equal(typeof meta.deletionReceiptId, "string");
          return meta.deletionReceiptId as string;
        },
        async status(receiptId?: string, code = 200, path = statusPath) {
          const url = path + (receiptId === undefined ? "" : "?receiptId=" + receiptId);
          const res = await app.inject({ method: "GET", url, headers });
          assert.equal(res.statusCode, code, res.body);
          if (code === 200) {
            assert.equal(res.headers["cache-control"], "no-store");
          }
          return res.json().data;
        },
      };
    }

    const createWorker = () =>
      new ControllerWorker({
        pool: new pg.Pool({ connectionString: databaseUrl }),
        computeDriver: {
          ...f.computeDriver,
          capability: "compute",
          async stopRevision() {
            assert.fail("Deletion retires the revision");
          },
          async retireRevision(revision) {
            assert.equal(revision.agentId, agent.id);
          },
        },
      });
    // The bootstrap also queues creation of the default Namespace. Finish it normally so
    // the controlled claims below can name our exact deletion, even on a fresh file database.
    const bootstrapWorker = createWorker();
    try {
      await bootstrapWorker.start();
      await waitFor("the bootstrap Namespace to finish", async () => {
        const { rows } = await f.pool.query(
          "SELECT 1 FROM occ.controller_work WHERE namespace_target = 'ready' AND state IN ('queued', 'claimed') LIMIT 1",
        );
        return rows.length === 0 ? true : undefined;
      });
    } finally {
      await bootstrapWorker.stop();
    }

    const owner = await reader();
    const successor = await reader();
    await owner.status(undefined, 404); // A readable, active Agent has no live deletion.
    const receipt = await owner.request();
    const scope = { namespaceId: namespace.id, agentId: agent.id };
    assert.deepEqual(await successor.status(), { ...scope, status: "queued" });
    assert.deepEqual(await owner.status(receipt), {
      ...scope,
      receiptId: receipt,
      status: "queued",
    });
    await successor.status(receipt, 404); // Knows the receipt, can read this Agent, but is not its recipient.
    await owner.status("aud_" + randomUUID(), 404); // A bad receipt cannot fall back to the readable Agent.
    await owner.status(receipt, 404, statusPath.replace(agent.id, "agt_" + randomUUID()));
    await owner.status(receipt, 403, statusPath.replace(namespace.id, "ns_" + randomUUID()));

    // An authorized repeat during another actor's work receives its own acknowledgement, not ownership.
    const repeated = await successor.request();
    assert.notEqual(repeated, receipt);
    assert.equal((await successor.status(repeated)).status, "queued");
    const queue = new PostgresWorkQueue(f.pool, { leaseDurationMs: 2000, maxAttempts: 1 });
    const first = await queue.claim();
    assert.ok(first);
    assert.equal(first.agentId, agent.id);
    assert.equal((await owner.status(receipt)).status, "running");
    await queue.defer(first, { code: "PROVISIONING_EFFECT_PENDING" }, { delayMs: 1500 });
    const waiting = await owner.status(receipt);
    assert.equal(waiting.status, "waiting");
    assert.ok(Number.isFinite(Date.parse(waiting.nextAttemptAt)));
    const lost = await waitFor("the next deletion claim", () => queue.claim());
    assert.equal(lost.agentId, agent.id);
    const expectStatus = async (status: string) => {
      const data = await owner.status(receipt);
      return data.status === status ? data : undefined;
    };
    assert.deepEqual(await waitFor("the deletion claim to expire", () => expectStatus("waiting")), {
      ...scope,
      receiptId: receipt,
      status: "waiting",
    });
    assert.equal((await queue.recoverStale()).failedPermanent, 1);
    assert.equal((await owner.status(receipt)).status, "failed");

    await owner.revokeAgent();
    await owner.status(undefined, 403);
    assert.equal((await owner.status(receipt)).status, "failed"); // Receipt confers no access to the Agent.
    const takeover = await successor.request();
    assert.equal((await successor.status(takeover)).status, "queued");

    const worker = createWorker();
    t.after(() => worker.stop());
    await worker.start();
    assert.deepEqual(
      await waitFor("the worker to commit Agent deletion", () => expectStatus("deleted")),
      {
        ...scope,
        receiptId: receipt,
        status: "deleted",
      },
    );
    // New app instance and sign-in. The finalizer removed the successor's exact Agent grant as well.
    const fresh = f.createApp(controller);
    const session = await signInToControllerApp(fresh, successor.credentials);
    const headers = authenticatedHeaders(session, { host: "127.0.0.1" });
    const after = (url: string) => fresh.inject({ method: "GET", url, headers });
    assert.equal((await after(base)).statusCode, 403);
    assert.equal((await after(statusPath)).statusCode, 403);
    const completed = await after(statusPath + "?receiptId=" + repeated);
    assert.equal(completed.statusCode, 200, completed.body);
    assert.deepEqual(completed.json().data, { ...scope, receiptId: repeated, status: "deleted" });
    // Even an administrator cannot use this person's receipt or turn an absent Agent into completion.
    assert.equal(
      (await f.inject("GET", statusPath + "?receiptId=" + repeated, undefined, fresh)).statusCode,
      404,
    );
    assert.equal((await f.inject("GET", statusPath, undefined, fresh)).statusCode, 404);
    await owner.revokeNamespace();
    await owner.status(receipt, 403);
  },
);
