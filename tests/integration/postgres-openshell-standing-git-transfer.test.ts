import { createGitHubRepositoryDeliveryResolver } from "../../apps/controller/src/drivers/repo/github/credentials/registry.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { Pool } from "pg";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentRevision, ComputeRevisionContext } from "../../packages/contracts/src/index.ts";
import { exerciseInstallationRequests } from "../helpers/openshell-installation-github-requests.ts";
import { protectedRepositoryGitRelease } from "../helpers/protected-repository-git-release.ts";
import {
  OpenShellGitRuntime,
  protectedOpenShellGitOwner,
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
import { databaseUrl, requiresPostgres } from "../helpers/postgres-database.mjs";
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
  "standing OpenShell installation grant crosses both expiries, serves two Git repositories and the API, then loses only GitHub",
  { ...requiresPostgres, timeout: 385_000 },
  async (t) => {
    let peer!: Awaited<ReturnType<typeof preparedStandingGitPeer>>;
    const issuanceReader = new Pool({ connectionString: databaseUrl, max: 1 });
    t.after(() => issuanceReader.end());
    const activeAtIssuance: (string | null)[] = [];
    // Observe each token POST at the supplier boundary, including the interval between
    // Compute returning ready and activation committing. Never use the worker's transaction.
    const beforeIssue = async () => {
      const { rows } = await issuanceReader.query(
        "SELECT active_revision_id FROM occ.agents WHERE namespace_id=$1 AND id=$2",
        [revision.namespaceId, revision.agentId],
      );
      assert.equal(rows.length, 1);
      activeAtIssuance.push(rows[0].active_revision_id);
      assert.equal(
        rows[0].active_revision_id,
        revision.id,
        "issuance requires committed activation",
      );
    };
    // Qualifying actual conversation requires the shipped Codex executable. Ordinary database
    // CI exercises the model grant, attachment and withdrawal but cannot claim a model response.
    const codex = process.env.OCC_TEST_STANDING_GIT_CODEX;
    const conversation = codex && (await standingGitConversation(t, codex));
    const modelConfig = conversation ? { base_url: conversation.baseUrl } : undefined;
    let onlineOwner!: ReturnType<typeof protectedOpenShellGitOwner>;
    const protectedGit = protectedRepositoryGitRelease(
      () => standing(),
      async (authority) => {
        onlineOwner = protectedOpenShellGitOwner(authority);
        return { close: async () => {} };
      },
    );
    const gatewayId = CREDENTIAL_GATEWAY_FIXTURE_ID;
    const gateway = new OpenShellCredentialGatewayDriver(
      { binaries: ["/usr/bin/codex"] },
      {
        id: gatewayId,
        backend: {
          id: "fixture-gateway",
          drivers: { credential_gateway: gatewayId },
          client: {
            placement: () => undefined,
            clientForNamespace: () => client,
          },
        } as never,
      },
    );
    const { f, key, driver, revision, predecessor, registry, owner, approval, credentials } =
      await standingExecutionFixture(
        t,
        import.meta.url,
        async (pool, ns) => ({
          ...(peer = await preparedStandingGitPeer(t, pool, ns, {
            beforeIssue,
            driver: protectedGit.owner.ref,
            installationAccess: true,
          })),
          requestedBinding: {
            repositoryRef: "team-installation",
            profile: "github-installation",
          },
          activePredecessor: true,
          protectedDriver: protectedGit.owner,
          credentialGateway: gateway,
          ...(modelConfig && { modelConfig }),
        }),
        { sandbox: protectedGit.sandboxConfiguration },
      );
    const { prepared, registrationName, gh, send, input } = peer;
    const authority = prepared.protectedGit!;
    await protectedGit.owner.requireRepositoryGitTransport()(authority);
    assert.ok(predecessor);
    const preparationClaims: string[] = [];
    let oid = peer.oid;
    const workspace = kubernetesNamespaceName(revision.namespaceId);
    const sandbox = "standing-sandbox";
    const sandboxId = crypto.randomUUID();
    const auth = revision.egressPlan!.harnessCredentialSource!;
    assert.deepEqual(auth, revision.harnessAuth);
    const model = openShellProviderName(auth.sourceId);
    let installed: string | undefined;
    let creates = 0;
    let bindingId = "";
    let stops = 0;
    let withdrawn = 0;
    let lostDetachReply = false;
    let originCallsBeforeActivation = 0;
    const deadline = credentials.deadlineWallMs;
    const cwd = await temporaryDirectory(t, "standing-private-git-destination-");
    const git = (args: string[], pack?: Buffer) =>
      spawnSync("git", args, {
        cwd,
        env: cleanEnvironment(),
        input: pack,
        timeout: 5000,
      });
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
        createGitHubRepositoryDeliveryResolver(registry),
      );
      r["routes"] = routes;
      r["owner"] = onlineOwner;
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
    let preparationFailure: unknown;
    let modelEnvironment: Record<string, string> | undefined;
    let askModel: ((phase: "before" | "after") => Promise<void>) | undefined;
    const compute = {
      ...f.compute,
      validateRepositoryCredentials: kube.validateRepositoryCredentials.bind(kube),
      validateExecutionAdmission: kube.validateExecutionAdmission.bind(kube),
      async prepareRevision(r: AgentRevision, custody: ComputeRevisionContext) {
        try {
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
          const environment = Object.fromEntries(
            p.environment.map(({ name, value }) => [name, value]),
          );
          assert.equal(environment.GIT_CONFIG_KEY_1, "credential.https://github.com.helper");
          assert.equal(environment.GIT_CONFIG_KEY_2, "http.followRedirects");
          assert.equal(environment.GIT_CONFIG_VALUE_2, "false");
          assert.equal(
            environment.GITHUB_TOKEN,
            undefined,
            "the sender supplies only its workload alias",
          );
          assert.equal(environment.OCE_OPENSHELL_GIT_PUSH_REF, undefined);
          if (!world.id) {
            creates++;
            world.id = sandboxId;
          } else if (Date.now() > deadline) {
            assert.equal(
              p.existingSandboxId,
              sandboxId,
              "cold recovery keeps the original Sandbox",
            );
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
          await protectedGit.enroll(
            r,
            custody,
            p.middlewares,
            workspace,
            sandboxId,
            world.repositoryGitRecipient,
          );
          await prepared.maintain();
          await readiness(r);
          if ((await f.currentAgent(owner))?.activeRevisionId !== r.id) {
            // Read the actual queue claim. Two incomplete passes must release it; the next
            // pass reuses the bootstrap under a different claim without receiving material.
            const {
              rows: [claim],
            } = await f.observerPool.query(
              "SELECT state, claim_token FROM occ.controller_work WHERE idempotency_key=$1",
              [`agent_revision:${r.id}:reconcile`],
            );
            assert.equal(claim.state, "claimed");
            assert.equal(typeof claim.claim_token, "string");
            assert.ok(!preparationClaims.includes(claim.claim_token));
            preparationClaims.push(claim.claim_token);
            assert.ok(preparationClaims.length <= 3);
            assert.equal((await f.currentAgent(owner))?.activeRevisionId, predecessor.id);
            assert.deepEqual(runtime.route(r.id), {
              state: "pending",
              reason: "awaiting_material",
            });
            assert.equal(standing().routeReadiness(r.id), "ready");
            assert.equal(gh.issuesOfTokens.length, 0);
            assert.equal(peer.originCalls(), originCallsBeforeActivation);
            assert.equal(world.writes, 0);
            assert.deepEqual(world.providerCreates, [p.provider]);
            assert.deepEqual(
              world.profileImports.filter((id: string) => id !== model),
              [p.provider],
            );
            const {
              rows: [route],
            } = await f.observerPool.query(
              "SELECT fence, desired->>'credentialState' AS credential_state, material_version, preparation_attempt_id FROM occ.credential_deliveries WHERE revision_id=$1",
              [r.id],
            );
            assert.deepEqual(route, {
              fence: "1",
              credential_state: "bootstrap",
              material_version: null,
              preparation_attempt_id: null,
            });
            const material = await prepared.readOpenShellMaterial(r.id, s);
            assert.ok(!material || "absent" in material);
            assert.equal(
              await runtime.lookup(
                { bindingId, sandboxId, workspace, requestId: "before-active" },
                s,
              ),
              undefined,
            );
            const observed = await f.compute.prepareRevision(r);
            return { ...observed, ready: preparationClaims.length === 3 };
          }
          return f.compute.prepareRevision(r);
        } catch (error) {
          preparationFailure ??= error;
          throw error;
        }
      },
      verifyRepositoryExecution: kube.verifyRepositoryExecution.bind(kube),
      async retireExpiredRepositoryAccess(r: AgentRevision, signal: AbortSignal) {
        const result = await kube.retireExpiredRepositoryAccess(r, signal);
        if (result === "withdrawn") {
          withdrawn++;
        }
        if (result === "pending" && world.detaches.length === 1) {
          lostDetachReply = true;
        }
        return result;
      },
      async stopRevision(r: AgentRevision) {
        // Replacing the initial revision may stop it; Git withdrawal must not stop
        // the successor whose independent model authority remains current.
        if (r.id === revision.id) {
          stops++;
        }
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
            drivers: {
              ...d.installation.drivers,
              credential_gateway: { id: gatewayId },
            },
          },
          repositoryPolicy: driver,
          protectedDriver: protectedGit.owner,
          sandboxDriver: protectedGit.owner.require("sandbox"),
          proxyDriver: protectedGit.owner.require("credential_proxy"),
        }),
      });
    const { client: wire, keys } = await openShellOnlineGitWire(t, {
      registrationName,
      budgetMs: 4000,
      lookupBinding: (id: Parameters<typeof runtime.lookup>[0], signal: AbortSignal) =>
        runtime.lookup(id, signal),
      authorizeOnlineRequest: onlineOwner.authorizeOnlineRequest,
    });
    const inspected = (upload: boolean) => input(bindingId, sandboxId, upload, workspace);
    const evaluateRequest = (request: object) =>
      invoke(wire, "EvaluateHttpRequest", request, token(keys, "supervisor", sandboxId));
    const evaluate = (upload: boolean) => evaluateRequest(inspected(upload));
    const known = () => f.state.read((v) => v.repositorySessions.findStandingExecution(key));
    const attempts = () => f.state.read((v) => v.repositorySessions.listRevisionAttempts(key));
    const uses = async () =>
      (
        await f.observerPool.query(
          "select operation,material_version,attempt_id,send_start_by,authorization_reply_by from occ.prepared_repository_git_uses order by exchange_id",
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
      const response = await peer.exchange(() => evaluate(upload), installed, upload);
      assert.ok("status" in response);
      assert.equal((await uses()).length, count + 1);
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
      originCallsBeforeActivation = peer.originCalls();
      await start();
      try {
        await f.work(revision, "succeeded");
      } catch (error) {
        throw preparationFailure ?? error;
      }
      assert.equal(preparationFailure, undefined);
      assert.equal(preparationClaims.length, 3);
      assert.equal((await f.currentAgent(owner))?.activeRevisionId, revision.id);
      const execution = await waitFor("admitted standing execution", known, 15_000);
      const first = (await attempts())[0]!;
      assert.equal(first.deadlineWallMs, deadline);
      assert.equal(world.writes, 1);
      assert.deepEqual(activeAtIssuance, [revision.id]);
      assert.equal(world.providerCreates.length, 1);
      assert.deepEqual(
        world.profileImports.filter((id: string) => id !== model),
        world.providerCreates,
      );
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
      assert.equal("checkAdmissionReady" in driver, false, "no broker health dependency");
      await assert.rejects(
        f.observerPool.query(
          "insert into occ.repository_broker_receipts(admission_id,state,generation) values ($1,'reserved',$2)",
          [first.admissionId, crypto.randomUUID()],
        ),
        /receipt requires a current durable admission/,
      );
      const route = (await routes.standing(revision))!.route;
      assert.deepEqual(
        await authority.readMaterial(
          {
            revisionId: revision.id,
            fence: route.fence,
            observed: route.observed,
          },
          t.signal,
        ),
        { absent: "unprepared" },
        "exact-dispatch port cannot release online material",
      );
      const installation = {
        revisionId: revision.id,
        fence: route.fence,
        observed: route.observed,
      };
      for (const other of [authority.online, authority.githubInstallation!]) {
        assert.deepEqual(
          await other.readMaterial(installation, t.signal),
          { absent: "unprepared" },
          "neither a narrow online reader nor an exact-dispatch installation reader receives this material",
        );
      }
      assert.deepEqual(
        await onlineOwner.readOpenShellMaterial(
          revision.id,
          t.signal,
          {
            revisionId: revision.id,
            fence: route.fence + 1,
            observed: route.observed,
          },
          "github-installation",
        ),
        { absent: "unprepared" },
        "a stale installer receives no committed material",
      );
      oid = await peer.nextObject();
      assert.notEqual(oid, firstOid);
      absent();
      const issue1 = gh.issuesOfTokens[0]!;
      assert.equal(issue1.repositoryIds, "installation");
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
      assert.deepEqual(activeAtIssuance, [revision.id, revision.id]);
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
      assert.equal(issue2.repositoryIds, "installation");
      const more = await exerciseInstallationRequests(t, peer, {
        inspected: () => inspected(false),
        evaluateRequest,
        value: installed!,
        cwd,
        oid,
      });
      const durable = await uses();
      assert.deepEqual(
        durable.map((x) => x.operation).sort(),
        [
          ...Array(2).fill(["advertise-upload-pack", "upload-pack"]).flat(),
          "advertise-receive-pack",
          "receive-pack",
          "github-rest",
          "github-rest", // Bodyless workflow rerun was authorized, not sent.
          "github-graphql",
        ].sort(),
      );
      await peer.noBroker();
      assert.equal(new Set(durable.map((x) => x.material_version)).size, 2);
      assert.equal(gh.tokenState()[1]!.uses, 6);
      // Cleanup is still paused. The still-installed token and fresh signed request must be denied by
      // the prepared owner, not hidden by an expired credential, retired session or absent peer.
      const before = more.originCalls();
      // Hold the positive reply across withdrawal. This exact request may still finish.
      const authorized = await evaluate(false);
      assert.equal(authorized.decision, 1);
      const withAllow = await uses();
      assert.equal(withAllow.length, durable.length + 1);
      assert.ok(
        withAllow.every(
          (r) => r.send_start_by === null && r.authorization_reply_by instanceof Date,
        ),
      );
      await f.controller.removeAgentStandingApproval(f.actor.id, {
        ...key,
        approvalId: approval.id,
        expectedGeneration: 1,
      });
      assert.deepEqual(await peer.exchange(() => evaluate(true), installed!, true), {
        decision: 2,
        reason_code: "access_withdrawn",
      });
      assert.ok(Date.now() < Math.min(issue2.expires, second!.deadlineWallMs, world.gitExpiresAt));
      assert.equal(more.originCalls(), before);
      assert.deepEqual(await uses(), withAllow);
      // Only now finish the authorized request. This also proves the still-installed token works.
      assert.equal((await send(installed!, false)).status, 200);
      assert.equal(more.originCalls(), before + 1);
      const live = gh.tokenState()[1]!;
      assert.equal(live.revoked, false);
      assert.equal(live.uses, 7);
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
      // Stop both owners after the peer committed detach but lost its reply. Recovery must
      // observe the reduced policy, never send a second detach or bootstrap an installation.
      await waitFor("lost detach reply", async () => lostDetachReply || undefined, 60_000);
      await f.stop();
      const reduction = async () =>
        (
          await f.observerPool.query(
            `SELECT binding_id, fence, recipient, material_version, retained_policy_hash,
                request_id, expected_version, observed_generation
         FROM occ.credential_delivery_reductions WHERE revision_id=$1`,
            [revision.id],
          )
        ).rows;
      const [pendingReduction] = await reduction();
      assert.ok(pendingReduction?.request_id);
      assert.equal(pendingReduction.binding_id, bindingId);
      assert.equal(pendingReduction.recipient.sandboxId, sandboxId);
      // The worker can complete an observation before stop joins it; neither disposition
      // permits replay. The accepted operation identity must survive either restart point.
      const acceptedRequest = pendingReduction.request_id;
      await runtime.close();
      runtime = newRuntime();
      const beforeRestartObservations = withdrawn;
      await start();
      await waitFor(
        "withdrawal followed by ordinary maintenance on the reduced execution",
        async () => (withdrawn >= beforeRestartObservations + 2 && true) || undefined,
        100_000,
      );
      await f.stop();
      await prepared.maintain();
      assert.deepEqual([world.detaches.length, world.writes, creates, stops], [1, 2, 1, 0]);
      const [settledReduction] = await reduction();
      assert.equal(settledReduction.request_id, acceptedRequest);
      assert.ok(settledReduction.observed_generation);
      assert.equal(settledReduction.material_version, pendingReduction.material_version);
      const originalSandbox = world.id;
      world.id = crypto.randomUUID();
      assert.equal(
        await kube.retireExpiredRepositoryAccess(revision, t.signal),
        "retire-runtime",
        "a replacement execution cannot confirm or inherit the old reduction",
      );
      world.id = originalSandbox;
      assert.deepEqual(await reduction(), [settledReduction]);
      assert.ok(
        world.reports.some(([name, state]: string[]) => name === model && state === "READY"),
      );
      assert.ok(
        world.reports.some(([name, state]: string[]) => name !== model && state === "REVOKED"),
      );
      assert.equal(gh.tokenState()[1]!.revoked, true);
      assert.deepEqual(activeAtIssuance, [revision.id, revision.id]);
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
