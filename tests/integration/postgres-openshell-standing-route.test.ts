import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import test from "node:test";
import { OpenShellGitRuntime } from "../../apps/controller/src/drivers/egress-proxy/openshell-git-runtime.ts";
import { PostgresOpenShellGitRouteStore } from "../../apps/controller/src/drivers/egress-proxy/openshell-git-route-store.ts";
import type { ProtectedRepositoryGitMaterial } from "../../packages/contracts/src/index.ts";
import type { EgressAuthorityConfiguration } from "../../apps/controller/src/composition/egress-authority.ts";
import { gitExpiryGateway } from "../helpers/openshell-online-git-journey.mjs";
import { standingExecutionFixture } from "../helpers/postgres-standing-execution.ts";
import { requiresPostgres } from "../helpers/postgres-database.mjs";

// Real standing approval, persisted route, runtime, provider and stock gRPC client. The
// supervisor, Pod identities and material are controlled; no credential or origin is needed.
test(
  "OpenShell observes the same expired standing execution across restart and rechecks authority at installation",
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
        registry,
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
      const prepare = () => runtime.prepare(revision, client, workspace, sandbox, signal, [model]);
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
    assert.equal(original?.route.fence, 1);
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
    // Do not clear or replay a possibly sent write. The fixture alone knows it sent nothing.
    assert.equal(await routes.writing(revision.id, 1, "rotate"), true);
    assert.equal(await probe(), undefined);
    assert.equal(
      await routes.record(revision.id, 1, {
        generation: original!.route.generation!,
        material: original!.route.material,
        observed: original!.route.observed,
        retainedLaunchHash: original!.retainedLaunchHash,
      }),
      true,
    );
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
    assert.equal(fence, 2);

    // Pause at the writer's provider read, after selection and write intent, before release/CAS.
    // Use the actual approval removal. No origin request, token disclosure or use receipt.
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
    gate(async () => {
      replaceAtWriter = true;
    });
    await cold.reconcile();
    assert.equal(world.writes, 3, "a different session at the final read cannot install");
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
      "SELECT fence, write_pending, blocked, material_version FROM occ.openshell_git_routes WHERE revision_id=$1",
      [revision.id],
    );
    assert.deepEqual(
      last,
      {
        fence: String(fence),
        write_pending: null,
        blocked: null,
        material_version: materials[3]!.materialVersion,
      },
      "the unsent rotation was cleared; the previous write was neither relabeled nor replayed",
    );
    assert.equal(await cold.lookup(), undefined);
  },
);
