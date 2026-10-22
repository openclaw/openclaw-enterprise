import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import test from "node:test";
import { createGitHubRepositoryDeliveryResolver } from "../../apps/controller/src/drivers/repo/github/credentials/registry.ts";
import { OpenShellGitRuntime } from "../../apps/controller/src/drivers/egress-proxy/openshell-git-runtime.ts";
import { PostgresOpenShellGitRouteStore } from "../../apps/controller/src/drivers/egress-proxy/openshell-git-route-store.ts";
import type { ProtectedRepositoryGitMaterial } from "../../packages/contracts/src/index.ts";
import type { EgressAuthorityConfiguration } from "../../apps/controller/src/composition/egress-authority.ts";
import { gitExpiryGateway } from "../helpers/openshell-online-git-journey.mjs";
import { standingExecutionFixture } from "../helpers/postgres-standing-execution.ts";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { preparedStandingGitPeer } from "../helpers/prepared-standing-git-peer.ts";
import type { PostgresPool } from "../../packages/occ/src/index.ts";

// Real standing approval, persisted route, runtime, provider and stock gRPC client. The
// supervisor, Pod identities and material are controlled; no credential or origin is needed.
for (const outcome of ["unsent", "lost-reply"] as const) {
  test(
    `OpenShell standing rotation preserves custody when ${outcome}`,
    { ...requiresPostgres, timeout: 45_000 },
    async (t) => {
      const { f, registry, revision, credentials, binding, key, approval } =
        await standingExecutionFixture(t, import.meta.url);
      const routes = new PostgresOpenShellGitRouteStore(f.observerPool);
      const model = "original-model";
      const workspace = "team-workspace";
      const sandbox = "git-execution";
      const firstDeadline = credentials.deadlineWallMs;
      const { client, world } = await gitExpiryGateway(t, {
        model,
        workspace,
        sandbox,
        revisionId: revision.id,
        deadline: firstDeadline,
        platformProfile: false,
        trackGitExpiry: true,
      });
      let workload = "original-pods-and-containers";
      const continuity = { model, workload: async () => workload };
      const context = async () => ({ client, workspace, sandbox, continuity });
      const signal = AbortSignal.timeout(40_000);
      const identity = {
        sandboxId: "original-sandbox-id",
        workspace,
        requestId: "fixture-request",
        bindingId: "",
      };
      let candidate = 1;
      let reads = 0;
      let afterSelection: (() => void) | undefined;
      let replaceAtWriter = false;
      const material = (n: number, end: number) =>
        ({
          ...binding.grant,
          value: randomBytes(32).toString("hex"),
          expiresAt: new Date(end).toISOString(),
          sessionId: "session-" + n,
          materialVersion: randomUUID(),
          preparationAttemptId: randomUUID(),
          repository: "example/source",
          pushRef: "refs/heads/review",
          apiOrigin: "https://api.github.com",
        }) satisfies ProtectedRepositoryGitMaterial;
      const materials = [
        undefined,
        material(1, firstDeadline),
        material(2, firstDeadline + 120_000),
        material(3, firstDeadline + 240_000),
        material(4, firstDeadline + 360_000),
      ];
      const assertReceived = () => {
        const { value, expiresAt } = materials[candidate]!;
        assert.equal(world.gitExpiresAt, Date.parse(expiresAt));
        assert.ok(
          world.installedDigest === createHash("sha256").update(value).digest("hex"),
          "the stock credential update carried the selected synthetic value",
        );
      };
      const worker = () => {
        const runtime = new OpenShellGitRuntime(
          {
            registrationName: "oce-prepared-git",
            authority: {} as EgressAuthorityConfiguration,
          },
          createGitHubRepositoryDeliveryResolver(registry),
        );
        runtime["routes"] = routes;
        runtime["owner"] = {
          readOpenShellMaterial: async () => {
            reads++;
            // The prepared owner's separate contract checks session and custody. This fixture
            // supplies a selected attempt only while this exact durable approval is current.
            const current = await f.state.read((v) =>
              v.repositorySessions.findStandingApproval(
                revision.namespaceId,
                revision.agentId,
                binding.repositoryRef,
              ),
            );
            if (
              current?.id !== approval.id ||
              current.generation !== approval.generation ||
              current.scopeFingerprint !== approval.scopeFingerprint
            ) {
              return { absent: "withdrawn" } as const;
            }
            afterSelection?.();
            const result = materials[candidate]!;
            return replaceAtWriter ? { ...result, sessionId: "different-session" } : result;
          },
          authorizeOpenShellRequest: async () => assert.fail("installation is not a recorded use"),
        };
        const prepare = () =>
          runtime.prepare(revision, client, workspace, sandbox, signal, [model]);
        const bind = () =>
          runtime.bind(
            revision.id,
            (box) => {
              assert.equal(box.id, identity.sandboxId);
              assert.equal(box.annotations["openclaw.dev/revision-id"], revision.id);
            },
            continuity,
          );
        const verify = () => runtime.verifyExecution(revision, signal, context);
        const lookup = () => runtime.lookup(identity, signal);
        const reconcile = async () => {
          const entry = (await runtime["entries"].get(revision.id))!;
          entry.nextRefreshAt = 0;
          await runtime["reconcile"](entry);
        };
        return { runtime, prepare, bind, verify, reconcile, lookup };
      };

      const warm = worker();
      const installed = await warm.prepare();
      identity.bindingId =
        installed.middlewares["oce-prepared-git"].config.fields.binding_id.stringValue;
      world.id = identity.sandboxId;
      await warm.bind();
      await warm.reconcile();
      assert.equal((await warm.lookup())?.sessionId, "session-1");
      assert.equal(world.writes, 1);
      assertReceived();
      const execution = await warm.verify();
      assert.ok(execution);
      await f.state.transact((u) => u.repositorySessions.recordStandingExecution(key, execution));
      const original = await routes.standing(revision);
      assert.equal(original?.route.fence, 2);
      const clock = Date.now;
      let advance = 125_000;
      t.mock.method(Date, "now", () => clock() + advance); // Cross both boundaries; no sleep or SQL clock change.

      const cold = worker();
      const before = reads;
      const probe = () => cold.verify();
      const invalid = { ...revision, id: "unknown-revision" };
      assert.equal(await cold.runtime.verifyExecution(invalid, signal, context), undefined);
      await assert.rejects(
        cold.runtime.prepare(invalid, client, workspace, sandbox, signal),
        /repository_expired/,
      );
      assert.equal(
        await routes.standing({
          ...revision,
          repositoryCredentials: {
            ...credentials,
            standingApprovalGeneration: credentials.standingApprovalGeneration + 1,
          },
        }),
        undefined,
        "another approval generation is not this route",
      );
      workload = "replacement-pods";
      assert.equal(await probe(), undefined, "matching names do not make a replacement our launch");
      workload = "original-pods-and-containers";
      assert.deepEqual(
        await probe(),
        execution,
        "a cold worker verifies identity before normal prepare",
      );
      assert.deepEqual(
        await routes.standing(revision),
        original,
        "read-only, including the route fence",
      );
      assert.equal(reads, before, "no material read to verify a cold execution");
      assert.equal(await cold.lookup(), undefined, "cold observation does not open the route");
      assert.deepEqual(
        await warm.verify(),
        execution,
        "expired status can still identify the predecessor",
      );
      assert.equal(await warm.lookup(), undefined, "the expired predecessor cannot be used");

      candidate = 2;
      await warm.reconcile();
      assert.equal((await warm.lookup())?.sessionId, "session-2");
      assert.equal(
        world.writes,
        2,
        "one successor CAS after the predecessor actually reported expired",
      );
      assertReceived();
      advance += 120_000;
      candidate = 3;
      assert.deepEqual(await cold.verify(), execution);
      assert.equal(await cold.lookup(), undefined, "no adoption or route opened by identity read");
      const resumed = await cold.prepare();
      assert.equal(resumed.existingSandboxId, identity.sandboxId);
      await cold.bind();
      await cold.reconcile();
      assert.equal((await cold.lookup())?.sessionId, "session-3");
      assert.equal(
        world.writes,
        3,
        "cold adoption installs the successor after the predecessor expired",
      );
      assertReceived();
      const fence = (await routes.standing(revision))!.route.fence;
      assert.equal(fence, 5);

      // Pause at the writer's provider read, after selection and write intent, before release/CAS.
      // Use the actual approval removal. No origin request, token disclosure or use receipt.
      // Standing readiness excludes pending writes; verifyExecution only proves the still-live
      // execution identity and may correctly succeed while its next credential is pending.
      candidate = 4;
      const get = client.getProvider.bind(client);
      let atProvider: (() => Promise<void>) | undefined;
      t.mock.method(client, "getProvider", async (...args: Parameters<typeof get>) => {
        const value = await get(...args);
        if (args[1] === installed.provider && atProvider) {
          const run = atProvider;
          atProvider = undefined;
          await run();
        }
        return value;
      });
      const gate = (act: () => Promise<void>) => {
        afterSelection = () => {
          afterSelection = undefined;
          atProvider = act;
        };
      };
      if (outcome === "lost-reply") {
        const update = client.updateProviderCredentialsConditionally!.bind(client);
        t.mock.method(
          client,
          "updateProviderCredentialsConditionally",
          async (...args: Parameters<typeof update>) => {
            await update(...args);
            throw new Error("controlled lost credential write reply");
          },
        );
        gate(async () => {
          assert.equal(
            await routes.standing(revision),
            undefined,
            "pending write cannot establish standing readiness",
          );
        });
        await cold.reconcile();
        assert.equal(world.writes, 4, "B reached the recipient before the reply was lost");
        assertReceived();
        assert.deepEqual(cold.runtime.route(revision.id), {
          state: "blocked",
          reason: "write_unknown",
        });
        assert.equal(await cold.lookup(), undefined);
        await cold.reconcile();
        const replacement = worker();
        await assert.rejects(replacement.prepare(), {
          name: "OpenShellGitRouteBlockedError",
          reason: "repository_expired",
        });
        assert.equal(world.writes, 4, "neither holder nor replacement replays an uncertain write");
        const { rows } = await f.observerPool.query(
          `SELECT write_pending,material_version,target_material_version FROM occ.credential_deliveries WHERE revision_id=$1`,
          [revision.id],
        );
        assert.deepEqual(
          rows,
          [
            {
              write_pending: "rotate",
              material_version: materials[3]!.materialVersion,
              target_material_version: materials[4]!.materialVersion,
            },
          ],
          "unknown B never relabels A or clears the target",
        );
        return;
      }
      gate(async () => {
        assert.equal(
          await routes.standing(revision),
          undefined,
          "pending write cannot establish standing readiness",
        );
        replaceAtWriter = true;
      });
      await cold.reconcile();
      assert.equal(world.writes, 3, "a different session at the final read cannot install");
      assert.ok(
        await cold.runtime["entries"].get(revision.id),
        "definite pre-send refusal retains the holder",
      );
      const canceled = await f.observerPool.query(
        "SELECT write_pending,material_version FROM occ.credential_deliveries WHERE revision_id=$1",
        [revision.id],
      );
      assert.deepEqual(canceled.rows, [
        { write_pending: null, material_version: materials[3]!.materialVersion },
      ]);
      assert.equal(
        await cold.lookup(),
        undefined,
        "canceling B is not evidence that B was installed",
      );
      replaceAtWriter = false;
      gate(async () => {
        await f.state.transact((u) =>
          u.repositorySessions.revokeStanding(approval, new Date().toISOString()),
        );
      });
      await cold.reconcile();
      assert.equal(
        world.writes,
        3,
        "withdrawal during the writer's final gateway read prevented the CAS",
      );
      assert.equal(await routes.standing(revision), undefined);
      const {
        rows: [last],
      } = await f.observerPool.query(
        "SELECT fence, write_pending, blocked, material_version FROM occ.credential_deliveries WHERE revision_id=$1",
        [revision.id],
      );
      assert.deepEqual(
        last,
        {
          fence: String(fence + 2),
          write_pending: null,
          blocked: null,
          material_version: materials[3]!.materialVersion,
        },
        "the unsent rotation was cleared; the previous write was neither relabeled nor replayed",
      );
      assert.equal(await cold.lookup(), undefined);
    },
  );
}

test(
  "lost initial OpenShell route commit acknowledgement prevents bootstrap and replay across restart",
  { ...requiresPostgres, timeout: 45_000 },
  async (t) => {
    let peer!: Awaited<ReturnType<typeof preparedStandingGitPeer>>;
    const { f, registry, revision, credentials } = await standingExecutionFixture(
      t,
      import.meta.url,
      async (pool, namespace) => (peer = await preparedStandingGitPeer(t, pool, namespace)),
    );
    const model = "original-model";
    const workspace = "route-reservation";
    const sandbox = "reservation-sandbox";
    const { client, world } = await gitExpiryGateway(t, {
      model,
      workspace,
      sandbox,
      revisionId: revision.id,
      deadline: credentials.deadlineWallMs,
      platformProfile: false,
    });
    let lostAcknowledgements = 0;
    const releases: boolean[] = [];
    // Keep the real transaction and committed row. Only its reply is lost; a pending
    // row inserted directly by the fixture would not test the runtime's failed-open path.
    const connection: PostgresPool = {
      end: () => f.observerPool.end(),
      async connect() {
        const database = await f.observerPool.connect();
        let initialReservation = false;
        return {
          async query(sql: string, values?: readonly unknown[]) {
            const result = await database.query(
              sql,
              values === undefined ? undefined : [...values],
            );
            if (sql.includes("INSERT INTO occ.credential_deliveries")) {
              initialReservation = true;
            }
            if (sql === "COMMIT" && initialReservation && lostAcknowledgements === 0) {
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
    const runtime = () => {
      const value = new OpenShellGitRuntime(
        { registrationName: peer.registrationName, authority: {} as EgressAuthorityConfiguration },
        createGitHubRepositoryDeliveryResolver(registry),
      );
      value["routes"] = routes;
      value["owner"] = peer.prepared;
      t.after(() => value.close());
      return value;
    };
    const first = runtime();
    const prepare = (value: OpenShellGitRuntime) =>
      value.prepare(revision, client, workspace, sandbox, t.signal, [model]);
    await assert.rejects(prepare(first), { name: "OpenShellGitObservationError" });
    assert.equal(lostAcknowledgements, 1);
    assert.ok(releases.includes(true), "the uncertain connection is discarded");
    const {
      rows: [reserved],
    } = await f.observerPool.query(
      "SELECT binding_id, write_pending, blocked, material_version FROM occ.credential_deliveries WHERE revision_id=$1",
      [revision.id],
    );
    assert.ok(reserved);
    assert.equal(reserved.write_pending, "bootstrap");
    assert.equal(reserved.blocked, null);
    assert.equal(reserved.material_version, null);

    // Neither the same process nor a cold process may turn uncertainty into a supplier
    // write. The cold attempt comes first so the failed opener's in-memory state cannot help it.
    const cold = runtime();
    await assert.rejects(prepare(cold), {
      name: "OpenShellGitRouteBlockedError",
      reason: "write_unknown",
    });
    await assert.rejects(prepare(first), {
      name: "OpenShellGitRouteBlockedError",
      reason: "write_unknown",
    });
    await assert.rejects(prepare(runtime()), {
      name: "OpenShellGitRouteBlockedError",
      reason: "write_unknown",
    });
    await peer.prepared.maintain();
    const material = await peer.prepared.readOpenShellMaterial(revision.id, t.signal);
    assert.ok(!material || "absent" in material);
    for (const value of [first, cold]) {
      assert.equal(
        await value.lookup(
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
    assert.deepEqual(world.profileImports, []);
    assert.deepEqual(world.providerCreates, []);
    assert.equal(world.writes, 0);
    assert.equal(peer.gh.issuesOfTokens.length, 0);
    assert.equal(peer.originCalls(), 0);
    assert.equal(lostAcknowledgements, 1);
    const { rows } = await f.observerPool.query(
      "SELECT blocked, material_version FROM occ.credential_deliveries WHERE revision_id=$1",
      [revision.id],
    );
    assert.deepEqual(rows, [{ blocked: "write_unknown", material_version: null }]);
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
