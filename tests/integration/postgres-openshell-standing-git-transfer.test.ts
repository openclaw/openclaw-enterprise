import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentRevision, ComputeRevisionContext } from "../../packages/contracts/src/index.ts";
import { protectedRepositoryGitRelease } from "../helpers/protected-repository-git-release.ts";
import {
  OpenShellGitRuntime,
  openShellRepositoryAccess,
} from "../../apps/controller/src/drivers/egress-proxy/openshell-git-runtime.ts";
import { PostgresOpenShellGitRouteStore } from "../../apps/controller/src/drivers/egress-proxy/openshell-git-route-store.ts";
import type { EgressAuthorityConfiguration } from "../../apps/controller/src/composition/egress-authority.ts";
import {
  cleanEnvironment,
  temporaryDirectory,
} from "../fixtures/repository-credentials/process.mjs";
import { gitExpiryGateway } from "../helpers/openshell-online-git-journey.mjs";
import { openShellOnlineGitWire } from "../helpers/openshell-online-git-wire.mjs";
import { invoke, token } from "../helpers/openshell-online-wire.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { standingExecutionFixture } from "../helpers/postgres-standing-execution.ts";
import { preparedStandingGitPeer } from "../helpers/prepared-standing-git-peer.ts";
import { waitFor } from "../helpers/wait-for.mjs";

import { standingGitConversation } from "../helpers/standing-git-conversation.ts";
import { CREDENTIAL_GATEWAY_FIXTURE_ID } from "../helpers/postgres-worker-revision-fixture.mjs";
import { options } from "../helpers/kubernetes-routed-scenarios.mjs";
import { openShellProviderName } from "../../apps/controller/src/backends/openshell.ts";
import { OpenShellCredentialGatewayDriver } from "../../apps/controller/src/drivers/credential-gateway/openshell.ts";
import {
  KubernetesComputeDriver,
  kubernetesNamespaceName,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import {
  pluginRuntimeEnvironment,
  pluginRuntimeSpecForRevision,
} from "../../apps/controller/src/drivers/compute/plugin-runtime.ts";
import { COMPUTE_RELEASE_PUBLIC_KEY } from "../../apps/controller/src/drivers/compute/egress-enrollment.ts";

// Release code owns the sessions, material, per-request authority, route, withdrawal and
// continued supervision. Compute, the stock-protocol supervisor/sender and HTTPS origin are
// controlled. The test crosses real deadlines and imports actual private-origin Git objects.
const conversationRequired = process.env.OCC_TEST_REQUIRE_STANDING_GIT_CONVERSATION === "1";
if (conversationRequired) {
  assert.ok(
    process.env.OCC_TEST_DATABASE_URL,
    "conversation qualification requires an owned PostgreSQL database",
  );
  assert.ok(
    process.env.OCC_TEST_STANDING_GIT_CODEX,
    "conversation qualification requires the shipped Codex executable",
  );
}
test(
  "broker-absent protected OpenShell execution fetches a missing private Git object past both first expiries and then loses only Git",
  { ...requiresPostgres, timeout: 385_000 },
  async (t) => {
    let peer!: Awaited<ReturnType<typeof preparedStandingGitPeer>>;
    // Qualifying actual conversation requires the shipped Codex executable. Ordinary database
    // CI exercises the model grant, attachment and withdrawal but cannot claim a model response.
    const codex = process.env.OCC_TEST_STANDING_GIT_CODEX;
    const conversation = codex && (await standingGitConversation(t, codex));
    const modelConfig = conversation ? { base_url: conversation.baseUrl } : undefined;
    const protectedGit = protectedRepositoryGitRelease(() => standing());
    const gatewayId = CREDENTIAL_GATEWAY_FIXTURE_ID;
    const gateway = new OpenShellCredentialGatewayDriver(
      { binaries: ["/usr/bin/codex"] },
      {
        id: gatewayId,
        backend: {
          id: "fixture-gateway",
          drivers: { credential_gateway: gatewayId },
          client: { placement: () => undefined, clientForNamespace: () => client },
        } as never,
      },
    );
    const { f, key, driver, revision, registry, owner, approval, credentials } =
      await standingExecutionFixture(t, import.meta.url, async (pool, ns) => ({
        ...(peer = await preparedStandingGitPeer(t, pool, ns)),
        protectedDriver: protectedGit.owner,
        credentialGateway: gateway,
        ...(modelConfig && { modelConfig }),
      }));
    const { prepared, registrationName, gh, send, input } = peer;
    let oid = peer.oid;
    const workspace = kubernetesNamespaceName(revision.namespaceId);
    const sandbox = "standing-sandbox";
    const sandboxId = "original-sandbox-id";
    const auth = revision.egressPlan!.harnessCredentialSource!;
    assert.deepEqual(auth, revision.harnessAuth);
    const model = openShellProviderName(auth.sourceId);
    let installed: string | undefined;
    let creates = 0;
    let bindingId = "";
    let stops = 0;
    let withdrawn = 0;
    const deadline = credentials.deadlineWallMs;
    const cwd = await temporaryDirectory(t, "standing-private-git-destination-");
    const git = (args: string[], pack?: Buffer) =>
      spawnSync("git", args, { cwd, env: cleanEnvironment(), input: pack, timeout: 5000 });
    const { client, world } = await gitExpiryGateway(t, {
      model,
      workspace,
      sandbox,
      deadline,
      platformProfile: false,
      modelSourceId: auth.sourceId,
      revisionId: revision.id,
      trackGitExpiry: true,
      onGitInstall(value: string) {
        installed = value;
      },
    });
    const continuity = { model, workload: async () => cwd };
    const routes = new PostgresOpenShellGitRouteStore(f.observerPool);
    const newRuntime = () => {
      const r = new OpenShellGitRuntime(
        {
          registrationName,
          protectedExecution: true,
          authority: {} as EgressAuthorityConfiguration,
        },
        registry,
      );
      r["routes"] = routes;
      r["owner"] = prepared;
      return r;
    };
    let runtime = newRuntime();
    const readiness = async (r: AgentRevision) => {
      const entry = (await runtime["entries"].get(r.id))!;
      entry.nextRefreshAt = 0;
      await runtime["reconcile"](entry);
    };
    // Admit, release and observe through Kubernetes and its actual registered repository
    // capability. Only the platform transports, observations and unrelated workload setup are controlled.
    const kube = new KubernetesComputeDriver(
      options({
        runtime: {
          transportSecretPrefix: "fixture-transport",
          gatewayStorageClassName: "local-path",
        },
      }) as never,
      {
        ...revision.compute,
        protectedDriver: protectedGit.owner,
        credentialGatewayDriver: gateway,
      },
    );
    const metadata = {
      name: workspace,
      ...kube["ownershipMetadata"]({ namespaceId: revision.namespaceId }),
    };
    t.mock.method(kube, "clients" as never, async () => ({
      core: {
        listNamespace: async () => ({ items: [{ metadata }] }),
        readNamespace: async () => ({
          apiVersion: "v1",
          kind: "Namespace",
          metadata,
          status: { phase: "Active" },
        }),
      },
    }));
    const standing = () =>
      openShellRepositoryAccess(runtime, (ctx) => {
        assert.equal(ctx.namespace.name, workspace);
        assert.deepEqual(ctx.revision.harnessAuth, auth);
        return { client, continuity, workspace, sandbox };
      });
    kube.validateExecutionAdmission(revision, protectedGit.owner);
    kube.validateRepositoryCredentials(revision.harness, revision.sandboxDriverId);
    assert.throws(() => kube.validateRepositoryCredentials(revision.harness, "other-sandbox"), {
      code: "SANDBOX_REPOSITORY_RECIPIENT_UNVERIFIED",
    });
    assert.throws(
      () =>
        kube.validateRepositoryCredentials(
          { id: "openclaw", version: "1", mode: "embedded" },
          revision.sandboxDriverId,
        ),
      { message: /require an embedded OpenClaw or dedicated Codex/ },
    );
    let lastCustody: ComputeRevisionContext | undefined;
    let modelEnvironment: Record<string, string> | undefined;
    let askModel: ((phase: "before" | "after") => Promise<void>) | undefined;
    const compute = {
      ...f.compute,
      validateRepositoryCredentials: kube.validateRepositoryCredentials.bind(kube),
      validateExecutionAdmission: kube.validateExecutionAdmission.bind(kube),
      async prepareRevision(r: AgentRevision, custody: ComputeRevisionContext) {
        kube["validateRevisionExecution"](r, custody);
        const resolved = custody.harnessAuth!;
        assert.equal(resolved.method, "credential_source");
        const source = resolved.source;
        const attachments = await gateway.attachForRevision({
          revision: r,
          sources: [source],
          namespace: { ...f.namespace, status: "ready", name: workspace },
          signal: t.signal,
        });
        assert.deepEqual(attachments, [{ sourceId: auth.sourceId, ref: model }]);
        const address = { name: workspace, plane: "execution" } as const;
        const login = kube["harnessAuthForRevision"](r, custody, address);
        assert.deepEqual(kube["credentialSourceEnvironment"](r, attachments, source), []);
        assert.equal(login.credentialSource?.id, auth.sourceId);
        assert.equal(login.loginMode, "api_key");
        if (conversation) {
          assert.equal(login.credentialSource?.config.base_url, conversation.baseUrl);
          const manifest = pluginRuntimeSpecForRevision(
            r,
            undefined,
            login.credentialSource!.config.base_url,
          )!;
          modelEnvironment = {
            ...Object.fromEntries(
              login.environment.map(({ name, value }: { name: string; value?: string }) => [
                name,
                value!,
              ]),
            ),
            ...pluginRuntimeEnvironment(manifest),
            OPENCLAW_EGRESS_ENROLLMENT_REVISION_ID: r.id,
            [COMPUTE_RELEASE_PUBLIC_KEY]: protectedGit.publicKey,
          };
          lastCustody = custody;
        }
        assert.equal(r.id, revision.id);
        const s = AbortSignal.timeout(15000);
        const p = await runtime
          .prepare(r, client, workspace, sandbox, s, [model])
          .catch((e: Error) => {
            t.diagnostic("prepare: " + e.message);
            throw e;
          });
        bindingId = p.middlewares["oce-prepared-git"].config.fields.binding_id.stringValue;
        if (!world.id) {
          creates++;
          world.id = sandboxId;
        } else if (Date.now() > deadline) {
          assert.equal(p.existingSandboxId, sandboxId, "cold recovery keeps the original Sandbox");
        }
        await runtime.bind(
          r.id,
          (box) => {
            assert.equal(box.id, sandboxId);
          },
          continuity,
        );
        // Drive each background owner at its normal boundary, outside any request.
        await readiness(r);
        await protectedGit.enroll(r, custody, p.middlewares, sandboxId).catch((e: Error) => {
          t.diagnostic("release: " + e.message);
          throw e;
        });
        await prepared.maintain();
        await readiness(r);
        return f.compute.prepareRevision(r);
      },
      verifyRepositoryExecution: kube.verifyRepositoryExecution.bind(kube),
      async retireExpiredRepositoryAccess(r: AgentRevision, signal: AbortSignal) {
        const result = await kube.retireExpiredRepositoryAccess(r, signal);
        if (result === "withdrawn") {
          withdrawn++;
        }
        return result;
      },
      async stopRevision() {
        stops++;
      },
    };
    type Event = { event?: string; code?: string; reason?: string };
    const events: Event[] = [];
    const start = () =>
      f.start(compute, {
        emit: (e?: Event) => {
          if (e && e.event !== "worker.health") {
            events.push(e);
          }
        },
        transformDrivers: (d: { installation: { drivers: object } }) => ({
          ...d,
          credentialGatewayDriver: gateway,
          installation: {
            ...d.installation,
            drivers: { ...d.installation.drivers, credential_gateway: { id: gatewayId } },
          },
          repoDriver: driver,
          protectedDriver: protectedGit.owner,
        }),
      });
    const { client: wire, keys } = await openShellOnlineGitWire(t, {
      registrationName,
      budgetMs: 4000,
      lookupBinding: (id: Parameters<typeof runtime.lookup>[0], signal: AbortSignal) =>
        runtime.lookup(id, signal),
      approve: prepared.authorizeOpenShellRequest,
    });
    const evaluate = (upload: boolean) =>
      invoke(
        wire,
        "EvaluateHttpRequest",
        {
          ...input(bindingId, sandboxId, upload, workspace),
        },
        token(keys, "supervisor", sandboxId),
      );
    const known = () => f.state.read((v) => v.repositorySessions.findStandingExecution(key));
    const attempts = () => f.state.read((v) => v.repositorySessions.listRevisionAttempts(key));
    const uses = async () =>
      (
        await f.observerPool.query(
          "select operation,material_version,attempt_id from occ.prepared_repository_git_uses order by exchange_id",
        )
      ).rows;
    const absent = () => {
      assert.equal(
        git(["cat-file", "-e", oid]).status,
        1,
        "the destination does not have this commit",
      );
    };
    const allow = async (upload: boolean) => {
      assert.ok(installed);
      const count = (await uses()).length;
      assert.deepEqual(await evaluate(upload), { decision: 1 });
      assert.equal((await uses()).length, count + 1);
      const response = await send(installed, upload);
      assert.equal(
        response.status,
        200,
        "the Git origin accepted the token received on the provider update wire",
      );
      return response.bytes;
    };

    assert.equal(git(["init", "--quiet"]).status, 0);
    absent();
    assert.equal(
      (await send(undefined, false)).status,
      401,
      "the private origin requires a credential",
    );
    try {
      await start();
      await f.work(revision, "succeeded");
      const execution = await waitFor("admitted standing execution", known, 15_000);
      const first = (await attempts())[0]!;
      assert.equal(first.deadlineWallMs, deadline);
      assert.equal(world.writes, 1);
      assert.match((await allow(false)).toString(), new RegExp(oid));
      const firstPack = await allow(true);
      assert.equal(git(["index-pack", "--strict", "--stdin"], firstPack.subarray(8)).status, 0);
      assert.equal(git(["cat-file", "-t", oid]).stdout.toString().trim(), "commit");
      if (conversation) {
        assert.ok(modelEnvironment);
        askModel = await conversation.launch(
          modelEnvironment,
          async (phase) => {
            const receipt = await client.getSandboxProviderStatus(
              workspace,
              sandbox,
              model,
              t.signal,
            );
            assert.equal(receipt?.state, "PROVIDER_READINESS_STATE_READY");
            const expected = phase === "after" ? "reduced" : "original";
            assert.equal(receipt.receipt?.desired?.attachmentEpoch, expected);
          },
          (startup) => protectedGit.releaseStartup(startup, lastCustody!),
        );
        await askModel("before");
      }
      const firstOid = oid;
      await peer.noBroker();
      assert.equal(first.brokerProtocol, 2);
      assert.equal(driver.checkAdmissionReady, undefined, "no broker health dependency");
      await assert.rejects(
        f.observerPool.query(
          "insert into occ.repository_broker_receipts(admission_id,state,generation) values ($1,'reserved',$2)",
          [first.admissionId, crypto.randomUUID()],
        ),
        /receipt requires a current durable admission/,
      );
      const route = (await routes.standing(revision))!.route;
      assert.deepEqual(
        await prepared.readOpenShellMaterial(revision.id, t.signal, {
          revisionId: revision.id,
          fence: route.fence + 1,
          observed: route.observed,
        }),
        { absent: "unprepared" },
        "a stale installer receives no committed material",
      );
      oid = await peer.nextObject();
      assert.notEqual(oid, firstOid);
      absent();
      const issue1 = gh.issuesOfTokens[0]!;
      assert.equal(gh.issuesOfTokens.length, 1);
      assert.ok(world.gitExpiresAt <= Math.min(deadline, issue1.expires));
      const oldFence = (await routes.standing(revision))!;
      const initialBinding = bindingId;
      t.diagnostic(
        "first private commit transferred, second does not exist locally; no broker or receipt",
      );
      // A worker stops after recording custody. The next worker and the warm predecessor
      // both inspect an actually expired installation; neither gets to extend its first deadline.
      await f.stop();
      // This provider would refuse DELETE for an expired credential. No such request is
      // needed after the authenticated expiry plus the owner's full clock-skew allowance.
      gh.setRevokeStatus(401);
      await delay(Math.max(0, Math.max(issue1.expires + 60_100, deadline) - Date.now()));
      assert.ok(Date.now() > Math.max(issue1.expires, deadline, world.gitExpiresAt));
      const signal = AbortSignal.timeout(15_000);
      const id = { bindingId, sandboxId, workspace, requestId: "expired" };
      const warm = (await runtime["entries"].get(revision.id))!.revision;
      assert.deepEqual(await runtime.verifyExecution(warm, signal), {
        executionId: execution.executionId,
        fingerprint: execution.fingerprint,
      });
      assert.equal(
        await runtime.lookup(id, signal),
        undefined,
        "expired identity cannot authorize Git",
      );
      await runtime.close();
      runtime = newRuntime();
      const identity = await kube.verifyRepositoryExecution(warm, signal);
      assert.deepEqual(identity, {
        executionId: execution.executionId,
        fingerprint: execution.fingerprint,
      });
      assert.deepEqual(
        await routes.standing(revision),
        oldFence,
        "cold observation does not claim a new fence",
      );
      assert.equal(await runtime.lookup(id, signal), undefined);
      await start();
      await waitFor(
        "same execution with a newly installed bounded successor",
        async () => {
          if (world.writes !== 2) {
            return undefined;
          }
          const mapping = await runtime.lookup(id, AbortSignal.timeout(4000));
          return mapping && mapping.sessionId !== first.sessionId ? mapping.sessionId : undefined;
        },
        80_000,
      );
      // The provider write precedes durable installation confirmation. Wait for the latter
      // before asking for a *single* use; neither a pending write nor an uncertain use is retried.
      await f.stop();
      const later = Date.now();
      const [prior, second] = [...(await attempts())].sort(
        (a, b) => a.deadlineWallMs - b.deadlineWallMs,
      );
      assert.equal(prior!.phase, "disposed");
      assert.equal(second!.predecessorAdmissionId, prior!.admissionId);
      assert.equal(second!.executionFingerprint, identity!.fingerprint);
      assert.notEqual(second!.sessionId, prior!.sessionId);
      assert.equal(bindingId, initialBinding);
      assert.equal(creates, 1);
      const issue2 = gh.issuesOfTokens[1]!;
      assert.equal(gh.issuesOfTokens.length, 2);
      assert.ok(later > Math.max(deadline, issue1.expires + 60_000));
      const custody = () =>
        f.observerPool
          .query(
            "SELECT state,custody,sealed IS NULL AS erased FROM occ.prepared_github_attempts ORDER BY provider_expires_at",
          )
          .then((x) => x.rows);
      const expired = { state: "committed", custody: "expired", erased: true };
      assert.deepEqual(await custody(), [
        expired,
        { state: "committed", custody: "current", erased: false },
      ]);
      assert.equal(
        gh.trace.filter((x) => x.method === "DELETE").length,
        0,
        "no retirement send for the expired token",
      );
      assert.ok(world.gitExpiresAt <= Math.min(second!.deadlineWallMs, issue2.expires));
      // This second commit was created after the first transfer. Its absence and the actual
      // imported pack distinguish successful renewal from a cached checkout or a discovery.
      absent();
      assert.match((await allow(false)).toString(), new RegExp(oid));
      const pack = await allow(true);
      assert.equal(pack.subarray(0, 12).toString(), "0008NAK\nPACK");
      assert.equal(git(["index-pack", "--stdin", "--strict"], pack.subarray(8)).status, 0);
      assert.equal(git(["cat-file", "-t", oid]).stdout.toString().trim(), "commit");
      assert.equal(git(["checkout", "-q", "--detach", oid]).status, 0);
      const durable = await uses();
      assert.equal(durable.length, 4);
      await peer.noBroker();
      assert.equal(new Set(durable.map((x) => x.material_version)).size, 2);
      assert.equal(gh.tokenState()[1]!.uses, 2, "both Git requests used the successor token");
      // Cleanup is still paused. The still-installed token and fresh signed request must be denied by
      // the prepared owner, not hidden by an expired credential, retired session or absent peer.
      const before = peer.originCalls();
      await f.controller.removeAgentStandingApproval(f.actor.id, {
        ...key,
        approvalId: approval.id,
        expectedGeneration: 1,
      });
      assert.deepEqual(await evaluate(true), { decision: 2, reason_code: "access_withdrawn" });
      assert.ok(Date.now() < Math.min(issue2.expires, second!.deadlineWallMs, world.gitExpiresAt));
      assert.equal(peer.originCalls(), before);
      assert.deepEqual(await uses(), durable);
      const live = gh.tokenState()[1]!;
      assert.equal(live.revoked, false);
      assert.equal(live.uses, 2);
      gh.setRevokeStatus(204);
      await prepared.maintain();
      assert.deepEqual(await custody(), [
        expired,
        { state: "committed", custody: "revoked", erased: true },
      ]);
      assert.equal(
        gh.trace.filter((x) => x.method === "DELETE").length,
        1,
        "one live successor retirement",
      );
      await start();
      // The peer commits the first detach but loses its reply. Normal subsequent maintenance
      // must again prove Git absent and the independently authorized model ready on this launch.
      await waitFor(
        "withdrawal followed by ordinary maintenance on the reduced execution",
        async () => (withdrawn >= 2 && true) || undefined,
        100_000,
      );
      await f.stop();
      await prepared.maintain();
      assert.deepEqual([world.detaches.length, world.writes, creates, stops], [1, 2, 1, 0]);
      assert.ok(
        world.reports.some(([name, state]: string[]) => name === model && state === "READY"),
      );
      assert.ok(
        world.reports.some(([name, state]: string[]) => name !== model && state === "REVOKED"),
      );
      assert.equal(gh.tokenState()[1]!.revoked, true);
      assert.equal((await f.currentAgent(owner))?.activeRevisionId, revision.id);
      if (askModel) {
        await askModel("after");
      }
      assert.equal(await readFile(join(cwd, "README.md"), "utf8"), "Controlled repository\n");
      t.diagnostic(
        JSON.stringify({
          revision: revision.id,
          approval: approval.id,
          execution: identity!.executionId,
          firstCommit: firstOid,
          successorCommit: oid,
          brokerReceipts: 0,
          afterAdmissionMs: later - deadline,
          afterProviderExpiryMs: later - issue1.expires,
          originCallsAtDenial: before,
          gitWrites: world.writes,
          detaches: world.detaches.length,
          withdrawnObservations: withdrawn,
          evidence: askModel
            ? "controlled supervisor and model, real Codex conversation across Git withdrawal"
            : "controlled supervisor, actual model grant and continued authorized maintenance; no model turn exercised",
        }),
      );
    } catch (error) {
      t.diagnostic(
        JSON.stringify({
          writes: world.writes,
          issued: gh.issuesOfTokens.length,
          events: events.slice(-8).map(({ event, code, reason }) => ({ event, code, reason })),
        }),
      );
      throw error;
    } finally {
      await f.stop();
      await runtime.close();
    }
  },
);
