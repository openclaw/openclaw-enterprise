import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { waitFor } from "../helpers/wait-for.mjs";
import {
  beforeNarrowGitPreparation,
  narrowOnlineGitJourney,
} from "../helpers/postgres-repository-set-journey.ts";
import { createGitHubRepositoryDeliveryResolver } from "../../apps/controller/src/drivers/repo/github/credentials/registry.ts";
import { OpenShellGitRuntime } from "../../apps/controller/src/drivers/egress-proxy/openshell-git-runtime.ts";
import { PostgresOpenShellGitRouteStore } from "../../apps/controller/src/drivers/egress-proxy/openshell-git-route-store.ts";
import type { EgressAuthorityConfiguration } from "../../apps/controller/src/composition/egress-authority.ts";
import { standingExecutionFixture } from "../helpers/postgres-standing-execution.ts";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import type { PostgresPool } from "../../packages/occ/src/index.ts";

// Independent current-path coverage. The historical rotation cases below remain
// intact until their launch witness and real owner renewal can be reconstructed.
test(
  "held OpenShell route stays closed to a cold reader and closes on worker replacement",
  { ...requiresPostgres, timeout: 120_000 },
  async (t) => {
    await narrowOnlineGitJourney(t, async (journey) => {
      const { runtime, revision, client, workspace, sandbox, pool, peer } = journey;
      const routes = new PostgresOpenShellGitRouteStore(pool);
      const owner = runtime["owner"];
      assert.ok(owner);
      let reads = 0;
      const cold = new OpenShellGitRuntime(
        runtime.configuration,
        createGitHubRepositoryDeliveryResolver(peer.registry),
      );
      cold["routes"] = routes;
      // Delegate to the selected production owner; count only the cold worker's reads.
      cold["owner"] = {
        readOpenShellMaterial: (...args) => {
          reads++;
          return owner.readOpenShellMaterial(...args);
        },
        authorizeOnlineRequest: (...args) => owner.authorizeOnlineRequest(...args),
      };
      t.after(() => cold.close());
      const identity = {
        sandboxId: journey.sandboxId,
        workspace,
        requestId: "cold-held-route",
        bindingId: revision.egressPlan!.execution.executionId,
      };
      const context = async () => ({
        client,
        workspace,
        sandbox,
        continuity: { model: "openai", workload: async () => "controlled-pod-uid/container-id" },
      });
      const row = async () => {
        const { rows } = await pool.query(
          `SELECT fence, write_pending, blocked, material_version, preparation_attempt_id,
                  target_material_version FROM occ.credential_deliveries WHERE revision_id=$1`,
          [revision.id],
        );
        assert.equal(rows.length, 1);
        return rows[0];
      };
      const original = await row();
      assert.equal(original.blocked, null);
      assert.equal(original.write_pending, null);
      assert.equal(original.material_version, journey.installed.materialVersion);
      assert.equal(original.preparation_attempt_id, journey.installed.preparationAttemptId);
      const writes = journey.writes();
      const issues = peer.gh.issuesOfTokens.length;
      const traffic = peer.originCalls();
      // This fixture has finite admission, not a historical standing witness. A cold
      // read must not manufacture that witness from a currently held installation.
      assert.equal(revision.repositoryCredentials!.standingApprovalId, undefined);
      for (let read = 0; read < 2; read++) {
        assert.equal(await cold.verifyExecution(revision, t.signal, context), undefined);
        assert.equal(await cold.lookup(identity, t.signal), undefined);
        assert.deepEqual(
          await row(),
          original,
          "cold reads preserve the exact SQL fence and custody",
        );
      }
      assert.equal(reads, 0);
      await assert.rejects(
        cold.prepare(revision, client, workspace, sandbox, t.signal, ["openai"]),
        { name: "OpenShellGitRouteBlockedError", reason: "worker_replaced" },
      );
      const closed = await row();
      assert.deepEqual(closed, {
        ...original,
        fence: String(BigInt(original.fence) + 1n),
        blocked: "worker_replaced",
      });
      assert.equal(await cold.lookup(identity, t.signal), undefined);
      assert.equal(
        await runtime.lookup(identity, t.signal),
        undefined,
        "the former holder loses service",
      );
      await assert.rejects(
        cold.prepare(revision, client, workspace, sandbox, t.signal, ["openai"]),
        { name: "OpenShellGitRouteBlockedError", reason: "worker_replaced" },
      );
      assert.deepEqual(await row(), closed, "retry cannot take another fence or reopen the route");
      assert.equal(reads, 0, "replacement closes before asking the owner for material");
      assert.equal(journey.writes(), writes, "replacement sends no successor credential");
      assert.equal(peer.gh.issuesOfTokens.length, issues);
      assert.equal(peer.originCalls(), traffic);
    });
  },
);

// Shared sender controls start from the supported selected v5 held installation.
// Only the successor selection is controlled: this is not standing owner renewal.
for (const outcome of ["unsent", "lost-reply", "withdrawn"] as const) {
  test(
    `selected held OpenShell rotation preserves custody when ${outcome}`,
    { ...requiresPostgres, timeout: 120_000 },
    async (t) => {
      await narrowOnlineGitJourney(t, async (journey) => {
        const { runtime, revision, client, pool, peer } = journey;
        const owner = runtime["owner"];
        const entry = runtime["states"].get(revision.id)?.entry;
        assert.ok(owner);
        assert.ok(entry?.installed);
        assert.equal(revision.executionAdmission.version, 5);
        assert.equal(revision.repositoryCredentials!.standingApprovalId, undefined);
        const readRow = async () => {
          const { rows } = await pool.query(
            `SELECT fence, write_pending, blocked, material_version, preparation_attempt_id,
                    target_material_version, desired, observed
             FROM occ.credential_deliveries WHERE revision_id=$1`,
            [revision.id],
          );
          assert.equal(rows.length, 1);
          return rows[0];
        };
        const original = await readRow();
        assert.equal(original.write_pending, null);
        assert.equal(original.blocked, null);
        assert.equal(original.material_version, journey.installed.materialVersion);
        const writes = journey.writes();
        const issues = peer.gh.issuesOfTokens.length;
        const traffic = peer.originCalls();
        const successor = {
          value: randomBytes(32).toString("hex"),
          materialVersion: randomUUID(),
          preparationAttemptId: randomUUID(),
          sessionId: randomUUID(),
        };
        let selected = false;
        let atWriter = false;
        let boundaryError: unknown;
        let finalReads = 0;
        // Delegate every authority read. Never turn an absent/withdrawn answer into material.
        // The controlled successor isolates the shared CAS path from issuer renewal policy.
        runtime["owner"] = {
          authorizeOnlineRequest: (...args) => owner.authorizeOnlineRequest(...args),
          readOpenShellMaterial: async (...args) => {
            const current = await owner.readOpenShellMaterial(...args);
            if (atWriter) {
              finalReads++;
            }
            if (!current || "absent" in current) {
              return current;
            }
            selected = true;
            return {
              ...current,
              ...successor,
              ...(atWriter && outcome === "unsent" ? { sessionId: "changed-at-final-read" } : {}),
            };
          },
        };
        t.after(() => {
          runtime["owner"] = owner;
        });
        const get = client.getProvider.bind(client);
        t.mock.method(client, "getProvider", async (...args: Parameters<typeof get>) => {
          const value = await get(...args);
          if (selected && !atWriter && args[1] === entry.binding.provider) {
            atWriter = true;
            try {
              const pending = await readRow();
              assert.equal(pending.fence, String(BigInt(original.fence) + 1n));
              assert.equal(pending.write_pending, "rotate");
              assert.equal(pending.material_version, original.material_version);
              assert.equal(pending.preparation_attempt_id, original.preparation_attempt_id);
              assert.equal(pending.target_material_version, successor.materialVersion);
              assert.deepEqual(pending.desired, original.desired);
              assert.deepEqual(pending.observed, original.observed);
              if (outcome === "withdrawn") {
                await journey.removeBinding();
              }
            } catch (error) {
              boundaryError = error;
              throw error;
            }
          }
          return value;
        });
        let accepted = 0;
        const update = client.updateProviderCredentialsConditionally!.bind(client);
        if (outcome === "lost-reply") {
          const originalUpdate = client.updateProviderCredentialsConditionally;
          assert.ok(originalUpdate);
          client.updateProviderCredentialsConditionally = async (
            ...args: Parameters<typeof update>
          ) => {
            assert.equal(args[0].credentials.GITHUB_TOKEN, successor.value);
            const result = await update(...args);
            accepted++;
            assert.notEqual(result.resourceVersion, entry.binding.resourceVersion);
            throw new Error("controlled lost selected rotation acknowledgement");
          };
          t.after(() => {
            client.updateProviderCredentialsConditionally = originalUpdate;
          });
        }
        // Let the existing maintenance loop own the pass; never race it with reconcile().
        const pass = async () => {
          const previous = runtime["running"];
          entry.nextRefreshAt = 0;
          await waitFor(
            "selected rotation maintenance",
            async () => {
              const running = runtime["running"];
              if (running === previous) {
                return undefined;
              }
              await running;
              return true;
            },
            { timeoutMs: 10_000, intervalMs: 20 },
          );
          if (boundaryError) {
            throw boundaryError;
          }
        };
        await pass();
        runtime["owner"] = owner;
        assert.equal(atWriter, true, "reach the provider read after reserving rotation");
        assert.ok(finalReads > 0, "recheck authority after the provider read");
        const after = await readRow();
        assert.equal(after.fence, String(BigInt(original.fence) + 1n));
        assert.equal(after.material_version, original.material_version);
        assert.equal(after.preparation_attempt_id, original.preparation_attempt_id);
        assert.deepEqual(after.desired, original.desired);
        assert.deepEqual(after.observed, original.observed);
        if (outcome === "lost-reply") {
          assert.equal(accepted, 1, "the stock CAS completed before its reply was lost");
          assert.equal(journey.writes(), writes + 1);
          assert.equal(after.write_pending, "rotate");
          assert.equal(after.target_material_version, successor.materialVersion);
          assert.deepEqual(runtime.route(revision.id), {
            state: "blocked",
            reason: "write_unknown",
          });
        } else {
          assert.equal(journey.writes(), writes, "the final authority check prevents sending CAS");
          assert.equal(after.write_pending, null);
          assert.equal(after.target_material_version, null);
          assert.ok(runtime["states"].get(revision.id)?.entry, "retain the provably unsent holder");
        }
        const identity = {
          sandboxId: journey.sandboxId,
          workspace: journey.workspace,
          requestId: "selected-rotation-custody",
          bindingId: revision.egressPlan!.execution.executionId,
        };
        assert.equal(await runtime.lookup(identity, t.signal), undefined);
        await pass();
        if (outcome === "lost-reply") {
          // Reconcile may not have committed the durable tombstone at the first lookup.
          // Require it to land, and reject any other custody or target change on every read.
          await waitFor(
            "original rotation is durably blocked",
            async () => {
              const row = await readRow();
              assert.deepEqual({ ...row, blocked: after.blocked }, after);
              assert.ok(row.blocked === null || row.blocked === "write_unknown");
              return row.blocked === "write_unknown" ? true : undefined;
            },
            { timeoutMs: 2_000, intervalMs: 20 },
          );
        }
        assert.equal(
          journey.writes(),
          writes + accepted,
          "maintenance never replays the refused or uncertain write",
        );
        assert.equal(peer.gh.issuesOfTokens.length, issues);
        assert.equal(peer.originCalls(), traffic);
        if (outcome === "lost-reply") {
          assert.deepEqual(
            await readRow(),
            { ...after, blocked: "write_unknown" },
            "only the durable terminal refusal changes, not the custody or rotation target",
          );
          const cold = new OpenShellGitRuntime(
            runtime.configuration,
            createGitHubRepositoryDeliveryResolver(peer.registry),
          );
          cold["routes"] = new PostgresOpenShellGitRouteStore(pool);
          cold["owner"] = owner;
          t.after(() => cold.close());
          await assert.rejects(
            cold.prepare(revision, client, journey.workspace, journey.sandbox, t.signal, [
              "openai",
            ]),
            { name: "OpenShellGitRouteBlockedError" },
          );
          assert.equal(await cold.lookup(identity, t.signal), undefined);
          assert.equal(journey.writes(), writes + 1, "replacement cannot replay an uncertain CAS");
        }
      });
    },
  );
}

test(
  "lost initial OpenShell route commit acknowledgement prevents bootstrap and replay across restart",
  { ...requiresPostgres, timeout: 45_000 },
  async (t) => {
    await beforeNarrowGitPreparation(
      t,
      async ({ runtime: first, revision, client, workspace, sandbox, pool, peer, writes }) => {
        let lostAcknowledgements = 0;
        const releases: boolean[] = [];
        // Run the real reservation transaction for this admitted route, then lose only
        // the acknowledgement of the commit.
        const connection: PostgresPool = {
          end: () => pool.end(),
          async connect() {
            const database = await pool.connect();
            let reservation = false;
            return {
              async query(sql: string, values?: readonly unknown[]) {
                const result = await database.query(
                  sql,
                  values === undefined ? undefined : [...values],
                );
                reservation ||= sql.includes("INSERT INTO occ.credential_deliveries");
                if (sql === "COMMIT" && reservation && lostAcknowledgements === 0) {
                  lostAcknowledgements++;
                  throw new Error("controlled lost initial reservation acknowledgement");
                }
                return result;
              },
              release(discard?: boolean) {
                releases.push(discard === true);
                database.release(discard);
              },
            };
          },
        };
        const routes = new PostgresOpenShellGitRouteStore(connection);
        first["routes"] = routes;
        const cold = new OpenShellGitRuntime(
          first.configuration,
          createGitHubRepositoryDeliveryResolver(peer.registry),
        );
        cold["routes"] = routes;
        cold["owner"] = first["owner"];
        t.after(() => cold.close());
        const read = () =>
          pool
            .query(
              `SELECT binding_id, fence, write_pending, blocked, material_version
         FROM occ.credential_deliveries WHERE revision_id=$1`,
              [revision.id],
            )
            .then(({ rows }) => {
              assert.equal(rows.length, 1);
              return rows[0];
            });
        const prepare = (owner: OpenShellGitRuntime) =>
          owner.prepare(revision, client, workspace, sandbox, t.signal, ["openai"]);
        const baseline = {
          writes: writes(),
          issues: peer.gh.issuesOfTokens.length,
          traffic: peer.originCalls(),
        };
        await assert.rejects(prepare(first), { name: "OpenShellGitObservationError" });
        assert.equal(lostAcknowledgements, 1);
        assert.ok(releases.includes(true), "discard the connection with uncertain commit reply");
        const reserved = await read();
        assert.deepEqual(reserved, {
          binding_id: revision.egressPlan!.execution.executionId,
          fence: "1",
          write_pending: "bootstrap",
          blocked: null,
          material_version: null,
        });
        const closed = { name: "OpenShellGitRouteBlockedError", reason: "worker_replaced" };
        await assert.rejects(prepare(cold), closed);
        await assert.rejects(prepare(first), closed);
        await assert.rejects(prepare(cold), closed);
        assert.deepEqual(await read(), { ...reserved, fence: "2", blocked: "worker_replaced" });
        for (const owner of [first, cold]) {
          assert.equal(
            await owner.lookup(
              {
                workspace,
                sandboxId: "uncreated-sandbox",
                bindingId: reserved.binding_id,
                requestId: "uncertain-reservation",
              },
              t.signal,
            ),
            undefined,
          );
        }
        await peer.prepared.maintain();
        assert.deepEqual(
          { writes: writes(), issues: peer.gh.issuesOfTokens.length, traffic: peer.originCalls() },
          baseline,
        );
        assert.equal(lostAcknowledgements, 1);
      },
    );
  },
);

for (const fault of ["before write", "after commit", "during worker replacement"] as const) {
  test(
    `uncertain preview release preserves fenced retirement with a fault ${fault}`,
    { ...requiresPostgres, timeout: 45_000 },
    async (t) => {
      const { f, registry, revision } = await standingExecutionFixture(t, import.meta.url);
      const terminal = "preview_release_unconfirmed";
      let writes = 0;
      // Exercise the real transaction. Either refuse its first update before PostgreSQL sees it,
      // or commit it and lose just the reply. The next transaction can distinguish these outcomes.
      const routes = new PostgresOpenShellGitRouteStore({
        end: () => f.observerPool.end(),
        async connect() {
          const client = await f.observerPool.connect();
          let closing = false;
          return {
            async query(sql: string, values?: readonly unknown[]) {
              if (values?.includes(terminal)) {
                closing = true;
                writes++;
                if (writes === 1 && fault !== "after commit") {
                  throw new Error("terminal write refused before execution");
                }
              }
              const result = await client.query(sql, values && [...values]);
              if (sql === "COMMIT" && closing && writes === 1 && fault === "after commit") {
                throw new Error("terminal write committed but reply lost");
              }
              return result;
            },
            release: (discard) => client.release(discard),
          };
        },
      });

      // Start at the installed preview's release boundary. This test needs no token or sender:
      // it tests immediate local closure and what a separate database reader can act on.
      let sawPending!: () => void;
      const pending = new Promise<void>((resolve) => {
        sawPending = resolve;
      });
      const statuses: unknown[] = [];
      const runtime = new OpenShellGitRuntime(
        { registrationName: "preview", authority: {} as EgressAuthorityConfiguration },
        createGitHubRepositoryDeliveryResolver(registry),
      );
      runtime["routes"] = routes;
      runtime["emit"] = (event: Readonly<Record<string, unknown>>) => {
        if (event.event === "worker.openshell-preview-closure") {
          statuses.push(event.status);
          if (event.status === "pending") {
            sawPending();
          }
        }
      };
      t.after(() => runtime.close());
      const { id, namespaceId, agentId } = revision;
      const worker = runtime["instance"];
      await routes.open(
        {
          revisionId: id,
          namespaceId,
          agentId,
          workspace: "team",
          sandbox: "one",
          bindingId: randomBytes(24).toString("base64url"),
        },
        worker,
      );
      // Neither an old fence nor a different worker who knows the fence can close this open row.
      assert.equal(await routes.confirmPreviewBlocked(id, worker, 2, "unknown"), "superseded");
      assert.equal(
        await routes.confirmPreviewBlocked(id, randomUUID(), 1, "unknown"),
        "superseded",
      );
      const hook = { startupId: randomUUID(), observationId: "b".repeat(64) };
      const entry = {
        revision,
        fence: 1,
        preview: { hook },
        installed: { observedHook: hook },
      } as Parameters<OpenShellGitRuntime["reconcile"]>[0];
      runtime["states"].set(id, { entry });
      let deliveries = 0;
      const release = () =>
        runtime.releasePreview(id, hook.startupId, async () => {
          deliveries++;
          throw new Error("lost release acknowledgement");
        });
      await assert.rejects(release(), /lost release acknowledgement/);
      await pending;
      assert.deepEqual(runtime.route(id), { state: "blocked", reason: terminal });
      await assert.rejects(release(), /Cannot release/);
      assert.equal(deliveries, 1);

      const blocked = async () =>
        (
          await f.observerPool.query(
            "SELECT blocked FROM occ.credential_deliveries WHERE revision_id = $1",
            [id],
          )
        ).rows[0]!.blocked;
      assert.equal(await blocked(), fault === "after commit" ? terminal : null);
      const replaced = fault === "during worker replacement";
      if (replaced) {
        // A restarted preview closes instead of inheriting the old launcher's observation.
        const next = await routes.adopt(id, randomUUID(), "close-preview");
        assert.equal(next?.blocked, "worker_replaced");
        assert.equal(next?.fence, 2);
      }

      // The ordinary maintenance path must recover. A lost commit reply needs only a read;
      // a successor's terminal record takes precedence; no later pass writes or delivers again.
      await runtime["reconcile"](entry);
      await runtime["reconcile"](entry);
      assert.deepEqual(statuses, ["pending", replaced ? "superseded" : "confirmed"]);
      assert.equal(await blocked(), replaced ? "worker_replaced" : terminal);
      assert.equal(writes, fault === "before write" ? 2 : 1);
      assert.equal(deliveries, 1);
    },
  );
}
