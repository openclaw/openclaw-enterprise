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

// Error bodies carry a fresh request ID; everything else must match byte for byte.
const withoutRequestId = (body: string) =>
  body.replace(/req_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "req");

test(
  "Agent deletion status follows the Agent, and completion follows the verified finalizing actor",
  requiresPostgres,
  async (t) => {
    // Seed revisions without starting their compute work. The users, their sessions and scoped
    // grants, the deletions, work claims and finalization all use their normal persisted paths.
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
    const selfDeleted = await f.deployAgent("Deletion status self");
    const revoked = await f.deployAgent("Deletion status revoked");
    const legacy = await f.deployAgent("Deletion status legacy");
    const installation = await f.state.loadInstallation();
    assert.ok(installation);
    const controller = new OpenClawController(installation, { state: f.state });
    const iam = f.controller.selectedDriver("iam");
    controller.registerDriver(iam);
    controller.selectDriver("iam", iam.id);
    const app = f.createApp(controller);
    type Target = { namespace: { id: string }; agent: { id: string } };
    const paths = ({ namespace: { id: ns }, agent: { id: agt } }: Target) => ({
      base: `/namespaces/${ns}/agents/${agt}`,
      status: `/namespaces/${ns}/agents/${agt}/deletion-status`,
      policy: `/namespaces/${ns}/iam`,
    });
    const main = paths({ namespace, agent });
    async function create(path: string, body: object) {
      const res = await f.inject("POST", path, body);
      assert.equal(res.statusCode, 201, res.body);
      return res.json().data;
    }
    async function reader(target: Target = { namespace, agent }) {
      const { base, status: statusPath, policy } = paths(target);
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
      const revokeAgent = await grant("agent", target.agent.id, ["read", "delete"]);
      const revokeNamespace = await grant("namespace", target.namespace.id, ["read"]);
      const session = await signInToControllerApp(app, credentials);
      const headers = authenticatedHeaders(session, { host: "127.0.0.1" });
      return {
        subjectId,
        credentials,
        headers,
        revokeAgent,
        revokeNamespace,
        async request() {
          const accepted = await app.inject({ method: "DELETE", url: base, headers });
          assert.equal(accepted.statusCode, 202, accepted.body);
          const { data, meta } = accepted.json();
          assert.equal(data.id, target.agent.id);
          assert.equal(data.status, "deleting");
          assert.deepEqual(Object.keys(meta), ["requestId"]);
        },
        async read(code: number, path = statusPath) {
          const res = await app.inject({ method: "GET", url: path, headers });
          assert.equal(res.statusCode, code, res.body);
          return res;
        },
        async status(code = 200, path = statusPath) {
          const res = await this.read(code, path);
          if (code === 200) {
            assert.equal(res.headers["cache-control"], "no-store");
          }
          return res.json().data;
        },
        // The not-visible answer, normalized only by its request ID.
        async denial(path = statusPath) {
          const res = await this.read(403, path);
          assert.equal(res.json().error.code, "FORBIDDEN");
          return withoutRequestId(res.body);
        },
      };
    }

    // Removing an actor's Agent access while teardown runs must stop its finalization.
    const duringRetire = new Map<string, () => Promise<void>>();
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
            assert.ok(
              [agent.id, selfDeleted.agent.id, revoked.agent.id].includes(revision.agentId),
            );
            await duringRetire.get(revision.agentId)?.();
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
    const otherAgent = main.status.replace(agent.id, "agt_" + randomUUID());
    await owner.status(404); // A readable, active Agent has no live deletion.
    await owner.read(400, main.status + "?receiptId=aud_" + randomUUID()); // No receipt.
    await owner.request();
    const scope = { namespaceId: namespace.id, agentId: agent.id };
    assert.deepEqual(await successor.status(), { ...scope, status: "queued" });
    assert.deepEqual(await owner.status(), { ...scope, status: "queued" });
    // Namespace read alone never discloses another Agent: a random ID gets the Agent denial.
    const unknown = await owner.denial(otherAgent);
    await owner.read(403, main.status.replace(namespace.id, "ns_" + randomUUID()));

    // An authorized repeat during another actor's work changes nothing about ownership.
    await successor.request();
    assert.equal((await successor.status()).status, "queued");
    const queue = new PostgresWorkQueue(f.pool, { leaseDurationMs: 2000, maxAttempts: 1 });
    const first = await queue.claim();
    assert.ok(first);
    assert.equal(first.agentId, agent.id);
    assert.equal((await owner.status()).status, "running");
    await queue.defer(first, { code: "PROVISIONING_EFFECT_PENDING" }, { delayMs: 1500 });
    const waiting = await owner.status();
    assert.equal(waiting.status, "waiting");
    assert.ok(Number.isFinite(Date.parse(waiting.nextAttemptAt)));
    const lost = await waitFor("the next deletion claim", () => queue.claim());
    assert.equal(lost.agentId, agent.id);
    const expectStatus = async (who: { status(): Promise<{ status: string }> }, status: string) => {
      const data = await who.status();
      return data.status === status ? data : undefined;
    };
    assert.deepEqual(
      await waitFor("the deletion claim to expire", () => expectStatus(owner, "waiting")),
      { ...scope, status: "waiting" },
    );
    assert.equal((await queue.recoverStale()).failedPermanent, 1);
    assert.equal((await owner.status()).status, "failed");

    // An administrator removes the owner's Agent access. From then on the owner learns nothing:
    // the same denial while the Agent exists, after it is deleted, and for an Agent that never was.
    await owner.revokeAgent();
    const revokedWhileLive = await owner.denial();
    assert.equal(revokedWhileLive, unknown.replaceAll(otherAgent.split("/")[4]!, agent.id));
    await successor.request(); // Takeover by a permitted actor.
    assert.equal((await successor.status()).status, "queued");

    const worker = createWorker();
    t.after(() => worker.stop());
    await worker.start();
    // The finalizer removed the successor's exact Agent grant. It finalized this deletion, so
    // with Namespace read it still sees completion.
    assert.deepEqual(
      await waitFor("the worker to commit Agent deletion", () =>
        expectStatus(successor, "deleted"),
      ),
      { ...scope, status: "deleted" },
    );
    assert.equal(await owner.denial(), revokedWhileLive);
    assert.equal(await owner.denial(otherAgent), unknown);
    // New app instance and sign-in as the finalizing actor.
    const fresh = f.createApp(controller);
    const session = await signInToControllerApp(fresh, successor.credentials);
    const headers = authenticatedHeaders(session, { host: "127.0.0.1" });
    const after = (url: string) => fresh.inject({ method: "GET", url, headers });
    assert.equal((await after(main.base)).statusCode, 403);
    const completed = await after(main.status);
    assert.equal(completed.statusCode, 200, completed.body);
    assert.deepEqual(completed.json().data, { ...scope, status: "deleted" });
    // A Namespace-wide Agent reader sees completion; an absent Agent is not a deletion.
    const admin = await f.inject("GET", main.status, undefined, fresh);
    assert.equal(admin.statusCode, 200, admin.body);
    assert.deepEqual(admin.json().data, { ...scope, status: "deleted" });
    assert.equal((await f.inject("GET", otherAgent, undefined, fresh)).statusCode, 404);
    // The finalizer recorded its recheck of the successor, the actor completion names.
    const rechecks = (agentId: string) =>
      f.pool
        .query("SELECT actor_id FROM occ.agent_deletion_rechecks WHERE agent_id = $1", [agentId])
        .then(({ rows }) => rows.map((row) => row.actor_id));
    assert.deepEqual(await rechecks(agent.id), [successor.subjectId]);
    // Losing Namespace read ends even the finalizing actor's view of completion.
    await successor.revokeNamespace();
    assert.equal(
      await successor.denial(),
      revokedWhileLive,
      "a deleted Agent and a revoked one read the same",
    );

    // An exact Agent grant is enough to delete and, with Namespace read, to see completion.
    // Without Namespace read the answer is the not-visible denial for any Agent ID.
    const self = await reader(selfDeleted);
    const selfPaths = paths(selfDeleted);
    const selfScope = { namespaceId: selfDeleted.namespace.id, agentId: selfDeleted.agent.id };
    await self.request();
    assert.deepEqual(
      await waitFor("the self-requested deletion to finish", () => expectStatus(self, "deleted")),
      { ...selfScope, status: "deleted" },
    );
    const selfUnknown = selfPaths.status.replace(selfDeleted.agent.id, "agt_" + randomUUID());
    await self.revokeNamespace();
    assert.equal(
      await self.denial(),
      (await self.denial(selfUnknown)).replaceAll(selfUnknown.split("/")[4]!, selfDeleted.agent.id),
    );

    // Revoking the actor's Agent access while teardown runs stops finalization: the work fails
    // as unauthorized, the Agent stays deleting, and the actor gets the not-visible denial.
    const late = await reader(revoked);
    const latePaths = paths(revoked);
    let retired = false;
    duringRetire.set(revoked.agent.id, async () => {
      if (!retired) {
        retired = true;
        await late.revokeAgent();
      }
    });
    await late.request();
    const work = `agent:${revoked.agent.id}:reconcile:deleted`;
    const failed = await waitFor("the late revocation to fail the deletion", async () => {
      const { rows } = await f.pool.query(
        "SELECT state, reason_code FROM occ.controller_work WHERE idempotency_key = $1",
        [work],
      );
      return rows[0]?.state === "failed_permanent" ? rows[0] : undefined;
    });
    assert.equal(retired, true);
    assert.equal(failed.reason_code, "AUTHORIZATION_DENIED");
    const kept = await f.inject("GET", latePaths.base);
    assert.equal(kept.statusCode, 200, kept.body);
    assert.equal(kept.json().data.status, "deleting");
    const lateUnknown = latePaths.status.replace(revoked.agent.id, "agt_" + randomUUID());
    assert.equal(
      await late.denial(),
      (await late.denial(lateUnknown)).replaceAll(lateUnknown.split("/")[4]!, revoked.agent.id),
    );
    const adminView = await f.inject("GET", latePaths.status);
    assert.equal(adminView.statusCode, 200, adminView.body);
    assert.equal(adminView.json().data.status, "failed");
    const { rows: deletions } = await f.pool.query(
      `SELECT 1 FROM occ.audit_events WHERE resource_id = $1
         AND action = 'openclaw.agents.lifecycle.delete' AND details->>'reasonCode' = 'AGENT_DELETED'`,
      [revoked.agent.id],
    );
    assert.equal(deletions.length, 0);

    // A completion finalized before migration 0077, or by a controller without the recheck,
    // records AGENT_DELETED for its actor but no recheck row. That actor still holds Namespace
    // read, yet gets the same denial as for an Agent that never existed; a Namespace-wide
    // reader still sees `deleted`.
    await worker.stop();
    const legacyActor = await reader(legacy);
    const legacyPaths = paths(legacy);
    await legacyActor.request();
    const legacyClaim = await waitFor("the legacy deletion claim", () => queue.claim());
    assert.equal(legacyClaim.agentId, legacy.agent.id);
    const { rows: legacyRows } = await f.pool.query(
      "SELECT occ.finalize_agent_deletion($1, $2, $3, $4) AS completed",
      [legacy.namespace.id, legacy.agent.id, legacyClaim.idempotencyKey, legacyClaim.claimToken],
    );
    assert.equal(legacyRows[0].completed, true);
    assert.deepEqual(await rechecks(legacy.agent.id), []);
    const { rows: legacyDeleted } = await f.pool.query(
      `SELECT actor_id FROM occ.audit_events WHERE resource_id = $1
         AND action = 'openclaw.agents.lifecycle.delete' AND details->>'reasonCode' = 'AGENT_DELETED'`,
      [legacy.agent.id],
    );
    assert.deepEqual(
      legacyDeleted.map((row) => row.actor_id),
      [legacyActor.subjectId],
    );
    const legacyUnknown = legacyPaths.status.replace(legacy.agent.id, "agt_" + randomUUID());
    assert.equal(
      await legacyActor.denial(),
      (await legacyActor.denial(legacyUnknown)).replaceAll(
        legacyUnknown.split("/")[4]!,
        legacy.agent.id,
      ),
    );
    const legacyAdmin = await f.inject("GET", legacyPaths.status);
    assert.equal(legacyAdmin.statusCode, 200, legacyAdmin.body);
    assert.equal(legacyAdmin.json().data.status, "deleted");
  },
);
