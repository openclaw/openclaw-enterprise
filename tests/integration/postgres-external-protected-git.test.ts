import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type {
  AgentRevision,
  ComputeRevisionContext,
  ComputeDriver,
  RepositoryGitSendPermit,
} from "../../packages/contracts/src/index.ts";
import {
  loadInstallationConfiguration,
  readPublicCaBundle,
} from "../../apps/controller/src/composition/installation-config.ts";
import { startPreparedGitHubGitOwner } from "../../apps/controller/src/backends/repository-credentials/prepared-git-owner.ts";
import {
  bindRepositoryGitTransport,
  repositoryGitAuthority,
} from "../../apps/controller/src/composition/repository-credentials/transport.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { signComputeExecutionRelease } from "../../apps/controller/src/drivers/compute/egress-enrollment.ts";
import { ProtectedExecutionDriver } from "../../apps/controller/src/drivers/compute/protected-execution-driver.ts";
import {
  cleanEnvironment,
  run,
  temporaryDirectory,
} from "../fixtures/repository-credentials/process.mjs";
import { createBackendController } from "../helpers/postgres-backend-state.mjs";
import { protectedDriverPackage } from "../helpers/protected-driver-package.ts";
import { createInstallationDriverConfiguration } from "../helpers/installation-driver-configuration.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { standingExecutionPlatform } from "../helpers/postgres-standing-execution.ts";
import { standingGitOrigin } from "../helpers/prepared-standing-git-peer.ts";
import { waitFor } from "../helpers/wait-for.mjs";

// Production package selection, OCC deployment, worker and custody. The external package,
// its workload, Kubernetes placement, GitHub and the private Git origin are controlled locally.
test(
  "an installed external Driver fetches private Git across rotation and receives the next fetch after withdrawal",
  { ...requiresPostgres, timeout: 150_000 },
  async (t) => {
    const f = await standingExecutionPlatform(t, import.meta.url);
    const { id: namespaceId } = f.namespace;
    const { registry, backendId, origin, gh, tls, privateKeyPath, custodyKeyPath } =
      await standingGitOrigin(t, namespaceId, 300_000);
    const id = "cedar-git-fixture";
    const { directory, entry } = await protectedDriverPackage(t, id, "repository-git");
    const cedar = (await import(
      join(entry, "repository-git.mjs")
    )) as typeof import("../fixtures/driver-packages/protected-execution-driver/repository-git.ts");
    const base = createInstallationDriverConfiguration();
    const registryPath = join(directory, "registry.json");
    await writeFile(registryPath, JSON.stringify(registry));
    const path = join(directory, "installation.json");
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const { keyFile, certFile } = tls;
    const releaseKey = publicKey.export({ format: "pem", type: "spki" }).toString();
    await writeFile(
      path,
      JSON.stringify({
        ...base,
        presets: { includeDefaults: false },
        backend: [
          {
            id: backendId,
            type: "github",
            configuration: { registryPath },
            drivers: { repo: backendId },
          },
        ],
        drivers: {
          ...base.drivers,
          sandbox: {
            id,
            package: id,
            configuration: { origin: origin.origin, keyFile, certFile, releaseKey },
          },
          credential_proxy: { id, configuration: {} },
          repo: {
            id: backendId,
            configuration: { sessionDurationSeconds: 180 },
            preparedGitHub: {
              privateKeyPath,
              custodyKeyPath,
              issuerCaPath: certFile,
              apiOrigin: gh.origin,
            },
          },
        },
      }),
    );
    const drivers = (await loadInstallationConfiguration({
      mode: "production",
      packageRoot: directory,
      environment: { OCC_CONFIG_PATH: path },
    }))!;
    const { repositoryOwner, repositoryRegistry, repositoryGitDriver: owner } = drivers;
    assert.ok(owner && repositoryOwner && repositoryRegistry && drivers.preparedRepositoryGit);
    assert.equal(repositoryOwner.controlSocket, undefined);
    assert.equal(drivers.openShellGit, undefined);
    const repo = drivers.repoDriver!;
    const kube = drivers.computeDriver;
    const release = new ProtectedExecutionDriver(owner);
    // Use the worker's selected authority, configured trust and sender binding. Control only the
    // maintenance schedule so we can withdraw while the replacement credential is still usable.
    const { issuerCaPath, ...preparedConfig } = drivers.preparedRepositoryGit;
    const prepared = await startPreparedGitHubGitOwner({
      ...repositoryOwner,
      ...preparedConfig,
      ca: Buffer.from(await readPublicCaBundle(issuerCaPath!)),
      pool: f.observerPool,
      registry: repositoryRegistry,
      ...repositoryGitAuthority(drivers),
      startWorker: false,
    });
    t.after(() => prepared.close());
    const transport = await bindRepositoryGitTransport(drivers, prepared, f.observerPool);
    assert.ok(transport);
    t.after(() => transport.close());
    const { peer } = cedar;

    // The worker still opens and proves a real standing session. Model and cluster availability
    // are outside this test; only workload preparation and the Namespace observation are controlled.
    const namespace = { ...f.namespace, status: "ready" as const };
    const compute: ComputeDriver = {
      ...f.compute,
      capability: "compute",
      async stopRevision() {},
      id: kube.id,
      implementation: kube.implementation,
      validateHarnessAuth: kube.validateHarnessAuth!.bind(kube),
      validateExecutionAdmission: kube.validateExecutionAdmission!.bind(kube),
      validateRepositoryCredentials: kube.validateRepositoryCredentials!.bind(kube),
      async prepareRevision(revision: AgentRevision, custody: ComputeRevisionContext) {
        const { egressPlan: plan } = revision;
        assert.ok(plan?.repositoryGit && custody.currentEgressInstallation);
        const context = { plan, revision, namespace, signal: t.signal };
        const wiring = await release.configure(context);
        assert.equal(
          await release.enroll(
            context,
            wiring,
            custody,
            async () => true,
            async () => ({
              ...context,
              kubernetes: undefined,
              transportToken: "fixture",
              requirements: {
                loginMode: "runtime",
                image: "fixture",
                command: [],
                workspaceMounts: [],
                files: [],
                environment: [],
                labels: {},
                credentialAttachments: [],
                proxyWiring: wiring,
              },
            }),
            (startup, current) => signComputeExecutionRelease(privateKey, startup, current),
          ),
          true,
        );
        return f.compute.prepareRevision(revision);
      },
      verifyRepositoryExecution: (revision: AgentRevision, signal: AbortSignal) =>
        release.sandbox.repositoryAccess!.verifyExecution({
          revision,
          signal,
          namespace,
          kubernetes: undefined,
        }),
    };
    const { actor, observerPool: pool } = f;
    const backends = drivers.installation.backend;
    const controller = createBackendController(f, { backends });
    const { id: who } = actor;
    controller.installDriver(owner, ["sandbox", "credential_proxy"]);
    for (const d of [repo, compute]) {
      controller.registerDriver(d);
      controller.selectDriver(d.capability, d.id);
    }
    const repositoryRef = "source";
    const approvalId = randomUUID();
    const { id: configurationId } = await controller.createConfiguration(who, {
      namespaceId,
      kind: "agent",
      values: createHarnessConfiguration("codex", "fixture"),
    });
    const { id: agentId } = await controller.createAgent(
      who,
      {
        namespaceId,
        configurationId,
        name: "External Git",
        executionMode: "dedicated",
        harnessAuth: { method: "runtime" },
        repositoryBindings: [{ repositoryRef, profile: "git-write" }],
      },
      resolveApprovedHarness,
    );
    const key = { namespaceId, agentId, configurationId };
    const [review] = await controller.listAgentStandingApprovalScopes(
      who,
      namespaceId,
      key.agentId,
    );
    await controller.updateAgent(
      who,
      {
        ...key,
        repositoryStandingApproval: {
          repositoryRef,
          approvalId,
          approved: true,
          duration: "until-removed",
          expectedScopeFingerprint: review!.scopeFingerprint,
        },
      },
      resolveApprovedHarness,
    );
    const revision = await controller.deployAgent(who, key, resolveApprovedHarness);
    assert.deepEqual(revision.executionAdmission, { version: 4, mode: "protected" });
    assert.deepEqual(revision.egressPlan?.driver, owner.ref);
    assert.equal(revision.repositoryCredentials?.standingApprovalId, approvalId);
    assert.equal(revision.harnessAuth.method, "runtime");
    const ref = { ...key, revisionId: revision.id };
    try {
      await f.start(compute, {
        transformDrivers: () => ({
          ...drivers,
          computeDriver: compute,
          configurationDriver: controller.selectedDriver("configuration"),
        }),
      });
      await waitFor(
        "worker's standing execution",
        () => f.state.read((v) => v.repositorySessions.findStandingExecution(ref)),
        25_000,
      );
      assert.equal(
        gh.issuesOfTokens.length,
        0,
        "observation and enrollment did not mint a credential",
      );
      await prepared.maintain();
      const first = await peer.install();

      const cwd = await temporaryDirectory(t, "cedar-git-destination-");
      const env = cleanEnvironment({ GIT_SSL_CAINFO: certFile });
      const git = (args: string[], allowFailure = false) =>
        run("git", ["-C", cwd, ...args], { env, allowFailure, timeout: 15_000 });
      await git(["init", "--quiet"]);
      const { traffic } = origin;
      const fetch = (mayDeny = false) =>
        git(
          [
            "-c",
            "http.extraHeader=" + peer.clientHeader,
            "fetch",
            "--no-tags",
            new URL("/" + origin.repository + ".git", peer.url).href,
            "refs/heads/main",
          ],
          mayDeny,
        );
      const transfer = async (oid: string) => {
        assert.notEqual(
          (await git(["cat-file", "-e", oid], true)).code,
          0,
          "destination must lack this exact commit",
        );
        const n = traffic().requests;
        await fetch();
        assert.equal(
          traffic().requests,
          n + 2,
          "the real Git discovery and upload reached the private origin",
        );
        assert.equal((await git(["rev-parse", "FETCH_HEAD"])).stdout.trim(), oid);
        assert.equal((await git(["cat-file", "-t", oid])).stdout.trim(), "commit");
      };
      await transfer(await origin.ref("main"));

      // The same working sender now holds a committed positive until its actual send cutoff,
      // while the original request is still in time. Never ask for a second authorization.
      for (const holdAt of ["connect", "request"] as const) {
        const before = traffic();
        const decisions = peer.decisions.length;
        const held: { permit: RepositoryGitSendPermit; releaseAt: number; deadlineAt: string }[] =
          [];
        peer.beforeSend = async (stage, permit, deadlineAt) => {
          if (stage !== holdAt) {
            return;
          }
          const until = Date.parse(permit.sendStartBy);
          let releaseAt = Date.now();
          assert.ok(releaseAt < until, "the sender received a live, committed permit");
          while (releaseAt < until) {
            await delay(until - releaseAt, undefined, { signal: t.signal });
            releaseAt = Date.now();
          }
          held.push({ permit, releaseAt, deadlineAt });
        };
        const expired = await fetch(true);
        delete peer.beforeSend;
        assert.deepEqual(
          traffic(),
          {
            connections: before.connections + Number(holdAt === "request"),
            requests: before.requests,
          },
          `expired permit before ${holdAt} must not start an origin request`,
        );
        assert.equal(
          held.length,
          1,
          "the already issued permit crossed its send cutoff exactly once",
        );
        const { permit, releaseAt, deadlineAt } = held[0]!;
        assert.ok(
          Date.parse(permit.sendStartBy) <= releaseAt && releaseAt < Date.parse(deadlineAt),
        );
        assert.deepEqual(peer.decisions.slice(decisions), [
          { operation: "advertise-upload-pack", decision: permit },
        ]);
        const { rows } = await pool.query(
          `SELECT send_start_by, material_version, attempt_id, request_digest_sha256
             FROM occ.prepared_repository_git_uses WHERE exchange_id=$1`,
          [permit.exchangeId],
        );
        assert.deepEqual(
          rows,
          [
            {
              send_start_by: new Date(permit.sendStartBy),
              material_version: permit.materialVersion,
              attempt_id: permit.preparationAttemptId,
              request_digest_sha256: permit.requestDigestSha256,
            },
          ],
          "possible use remains committed with exactly the permit the sender let expire",
        );
        assert.equal(expired.code, 128);
        assert.match(expired.stderr.toString(), /403/);
        t.diagnostic(
          `expired before ${holdAt}: ${JSON.stringify(before)} -> ${JSON.stringify(traffic())}, one possible use`,
        );
      }

      // Real owner deadlines: the 5-minute fixture token is inside the 10-minute renewal window.
      // Wait for the persisted next check, without extending or editing a token or session deadline.
      const {
        rows: [{ delay_ms }],
      } = await pool.query(
        "SELECT extract(epoch FROM next_check_at-clock_timestamp())*1000 AS delay_ms FROM occ.prepared_github_families WHERE enabled AND source #>> '{session,revisionId}'=$1",
        [revision.id],
      );
      await delay(Math.max(0, Number(delay_ms) + 25), undefined, { signal: t.signal });
      await prepared.maintain();
      const second = await peer.install();
      assert.notEqual(first.materialVersion, second.materialVersion);
      await transfer(await origin.addCommit());
      const receiptCount = () =>
        pool
          .query(
            "SELECT count(*)::integer n FROM occ.prepared_repository_git_uses WHERE material_version=$1",
            [second.materialVersion],
          )
          .then((r) => r.rows[0].n);
      assert.equal(await receiptCount(), 2);

      // Send another actual request to the same still-equipped sender. Check the transport and
      // HTTP boundaries before the client result, so an erroneous forward fails at the origin oracle.
      const before = traffic();
      const decisions = peer.decisions.length;
      await controller.removeAgentStandingApproval(who, {
        ...key,
        approvalId,
        expectedGeneration: 1,
      });
      const denied = await fetch(true);
      assert.deepEqual(
        traffic(),
        before,
        "no connection or HTTP request may reach the origin after withdrawal",
      );
      assert.deepEqual(peer.decisions.slice(decisions), [
        {
          operation: "advertise-upload-pack",
          decision: { kind: "denied", reason: "access_withdrawn" },
        },
      ]);
      assert.equal(denied.code, 128);
      assert.match(denied.stderr.toString(), /403/);
      assert.ok(
        Date.now() < Date.parse(second.expiresAt),
        "withdrawal was tested while the installed credential was usable",
      );
      const [, live] = gh.tokenState();
      assert.equal(live?.uses, 2);
      assert.equal(live.revoked, false);
      assert.equal(await receiptCount(), 2);
      t.diagnostic(
        "fetched two previously absent commits using distinct material; withdrawn request reached the same sender, with zero additional origin connections or HTTP requests",
      );
    } finally {
      await f.stop();
    }
  },
);
