import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { beforeNarrowGitPreparation } from "../helpers/postgres-repository-set-journey.ts";
import { createGitHubRepositoryDeliveryResolver } from "../../apps/controller/src/drivers/repo/github/access/registry.ts";
import { OpenShellGitRuntime } from "../../apps/controller/src/drivers/egress-proxy/openshell-git-runtime.ts";
import { PostgresOpenShellGitRouteStore } from "../../apps/controller/src/drivers/egress-proxy/openshell-git-route-store.ts";
import { ObservedHookPreview } from "../../apps/controller/src/drivers/egress-proxy/openshell-request-hook-preview.ts";
import type { EgressAuthorityConfiguration } from "../../apps/controller/src/composition/egress-authority.ts";
import { standingExecutionFixture } from "../helpers/postgres-standing-execution.ts";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import type { PostgresPool } from "../../packages/occ/src/index.ts";

test(
  "lost initial OpenShell route commit acknowledgement prevents bootstrap and replay across restart",
  { ...requiresPostgres, timeout: 45_000 },
  async (t) => {
    await beforeNarrowGitPreparation(
      t,
      import.meta.url,
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
          owner.prepare(revision, client, workspace, sandbox, t.signal, "/sandbox/enterprise");
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
      const repositoryCredentials = revision.repositoryCredentials;
      assert.ok(
        repositoryCredentials && repositoryCredentials.authorization !== "credential_source",
      );
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
      const workspace = "team";
      const sandbox = "one";
      const bindingId = randomBytes(24).toString("base64url");
      await routes.open(
        { revisionId: id, namespaceId, agentId, workspace, sandbox, bindingId },
        worker,
      );
      // Neither an old fence nor a different worker who knows the fence can close this open row.
      assert.equal(await routes.confirmPreviewBlocked(id, worker, 2, "unknown"), "superseded");
      assert.equal(
        await routes.confirmPreviewBlocked(id, randomUUID(), 1, "unknown"),
        "superseded",
      );
      const hook = { startupId: randomUUID(), observationId: "b".repeat(64) };
      const preview = new ObservedHookPreview(workspace, bindingId);
      preview.hook = hook;
      const provider = "prepared-git";
      const binding = {
        workspace,
        sandbox,
        executionId: id,
        provider,
        providerId: randomUUID(),
        profile: "git-write",
        profileVersion: "1",
        resourceVersion: "2",
        expiresAt: new Date(repositoryCredentials.deadlineWallMs).toISOString(),
        credentialState: "active",
        update: "accepted",
        supervisor: "unknown",
        readiness: { rpc: "GetSandboxProviderStatus", workspace, sandbox, provider },
      } as const;
      const installed = {
        workspace,
        sandbox,
        sandboxId: randomUUID(),
        executionId: id,
        provider,
        providerId: binding.providerId,
        providerResourceVersion: binding.resourceVersion,
        profileVersion: binding.profileVersion,
        credentialState: binding.credentialState,
        attachmentEpoch: "1",
        providerEnvRevision: "2",
        configRevision: "1",
        policyHash: "a".repeat(64),
        supervisorSessionId: randomUUID(),
        processInstanceId: randomUUID(),
        networkInstanceId: randomUUID(),
        observedHook: hook,
      } as const;
      const entry = {
        revision,
        binding,
        bindingId,
        fence: 1,
        preview,
        supervisor: installed,
        installed,
      } as Parameters<OpenShellGitRuntime["reconcile"]>[0];
      runtime["states"].set(id, { entry });
      let deliveries = 0;
      const release = () =>
        runtime.releasePreview(id, hook.startupId, {
          prepare: async () => {},
          deliver: async () => {
            deliveries++;
            // A separate reader can observe the bound generation before the launcher starts.
            const { rows } = await f.observerPool.query(
              "SELECT desired, observed FROM occ.credential_deliveries WHERE revision_id = $1",
              [id],
            );
            assert.equal(rows[0]?.desired.resourceVersion, binding.resourceVersion);
            assert.deepEqual(rows[0]?.observed.observedHook, hook);
            throw new Error("lost release acknowledgement");
          },
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
        const next = await routes.adopt(id, randomUUID());
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
