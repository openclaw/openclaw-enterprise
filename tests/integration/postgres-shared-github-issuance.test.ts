import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { run, temporaryDirectory } from "../fixtures/repository-credentials/process.mjs";
import { within } from "../helpers/wait-for.mjs";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import type { PostgresClient } from "../../packages/occ/src/index.ts";
import { PostgresPlatformState } from "../../packages/occ/src/index.ts";
import { runPreparation } from "../../apps/controller/src/backends/token-service/service.ts";
import { createSystemClock } from "../../apps/controller/src/drivers/repo/access/clock.ts";
import { createGitHubKeyOwner } from "../../apps/controller/src/drivers/repo/github/access/material.ts";
import { preparationIssuerAuthority } from "../../apps/controller/src/drivers/repo/github/access/origin.ts";
import { createGitHubPreparationOwner } from "../../apps/controller/src/drivers/repo/github/access/prepared-owner.ts";
import { retirePreparedGitHubToken } from "../../apps/controller/src/drivers/repo/github/access/prepared-retirement.ts";
import type { PreparedRepositoryGitSource } from "../../apps/controller/src/drivers/repo/github/access/prepared-repository-git.ts";
import { loadInstallationConfiguration } from "../../apps/controller/src/composition/installation-config.ts";
import { resolveSelectedRepositoryGrant } from "../../apps/controller/src/drivers/repo/github/access/registry.ts";
import { createInstallationDriverConfiguration } from "../helpers/installation-driver-configuration.mjs";
import { protectedDriverPackage } from "../helpers/protected-driver-package.ts";
import { harnessTlsFixture } from "../helpers/harness-tls.mjs";
import { SharedPreparedRepositoryGit } from "../../apps/controller/src/drivers/repo/github/access/shared-prepared-git.ts";
import {
  seedSessionRevision,
  sessionAttempt,
} from "../conformance/repository-sessions.contract.mjs";
import {
  fixtureAppId,
  fixtureInstallationId,
  fixtureRepository,
  fixtureRepositoryId,
  startGitHubFixture,
} from "../fixtures/repository-credentials/github.mjs";
import { databaseUrl, requiresPostgres, testPool } from "../helpers/postgres-database.mjs";

const bounded = <T>(work: Promise<T>) => within(work, "shared issuance", 5000);
const providerArrival = (arrival: Promise<void>, work: Promise<unknown>) =>
  bounded(
    Promise.race([
      arrival,
      work.then(() => {
        throw new Error("issue ended before provider arrival");
      }),
    ]),
  );

test(
  "PostgreSQL shares one mint across admitted source members and retains it after one withdrawal",
  {
    ...requiresPostgres,
    timeout: 90_000,
  },
  async (t) => {
    const url = databaseUrl!;
    const poolA = testPool(t, { connectionString: url, max: 4 });
    const poolB = testPool(t, { connectionString: url, max: 4 });
    const platform = new PostgresPlatformState(poolA);
    const now = new Date().toISOString();
    const deadlineWallMs = Date.now() + 600_000;
    const driver = {
      id: "test-repository",
      implementation: "github",
      configurationId: "a".repeat(64),
    };
    const backendId = "test-repository-backend";
    const providerInstanceId = "test-github-enrollment";
    const permissions = { contents: "read", metadata: "read" };
    function repositoryCredentials() {
      return {
        driver: { id: driver.id, implementation: driver.implementation },
        deadlineWallMs,
        bindings: [
          {
            repositoryRef: "source",
            profile: "github-repository" as const,
            backendId,
            grant: { providerInstanceId, repositoryId: fixtureRepositoryId, grantId: randomUUID() },
          },
        ],
      };
    }
    const first = await seedSessionRevision(platform, repositoryCredentials(), {
      createdAt: now,
      executionMode: "dedicated",
    });
    const second = await platform.transact(async (unit) => {
      const config = { ...first.configuration, id: `cfg_${randomUUID()}` };
      const agent = {
        ...first.agent,
        id: `agt_${randomUUID()}`,
        name: "second source",
        configurationId: config.id,
        servicePrincipalId: `test-agent-${randomUUID()}`,
        desiredRuntimeState: "stopped",
        status: "active",
      };
      const revision = {
        ...first.revision,
        id: `rev_${randomUUID()}`,
        agentId: agent.id,
        configurationId: config.id,
        servicePrincipalId: agent.servicePrincipalId,
        repositoryCredentials: repositoryCredentials(),
      } as typeof first.revision;
      await unit.configurations.createConfiguration(
        config as Parameters<typeof unit.configurations.createConfiguration>[0],
      );
      await unit.agents.createAgent(agent as Parameters<typeof unit.agents.createAgent>[0]);
      await unit.revisions.createRevision(
        revision as Parameters<typeof unit.revisions.createRevision>[0],
      );
      await unit.agents.transitionAgentDesiredRuntimeState(
        agent.namespaceId,
        agent.id,
        "stopped",
        "running",
      );
      return revision;
    });
    const otherNamespace = await seedSessionRevision(platform, repositoryCredentials(), {
      createdAt: now,
      executionMode: "dedicated",
    });
    async function admit(revision: typeof first.revision): Promise<PreparedRepositoryGitSource> {
      const candidate = sessionAttempt(revision);
      const sessionId = randomUUID();
      const { driver: owner, bindings } = revision.repositoryCredentials;
      const binding = bindings[0] as PreparedRepositoryGitSource["session"]["binding"] | undefined;
      assert.ok(binding);
      await platform.transact(async (unit) => {
        await unit.agents.compareAndSetActiveRevision(
          candidate.namespaceId,
          candidate.agentId,
          undefined,
          candidate.revisionId,
        );
        await unit.repositorySessions.createAttempt(candidate);
        assert.ok(
          await unit.repositorySessions.advanceAttempt({
            admissionId: candidate.admissionId,
            expectedPhase: "opening",
            phase: "open",
            sessionId,
            updatedAt: now,
          }),
        );
      });
      return {
        adoption: "credential_proxy_github_repository",
        key: { source: { id: "repository-git:" + candidate.admissionId } },
        session: {
          namespaceId: candidate.namespaceId,
          agentId: candidate.agentId,
          revisionId: candidate.revisionId,
          admissionId: candidate.admissionId,
          sessionId,
          driver: owner,
          binding,
          bindings: [binding],
        },
        grant: {
          id: binding.grant.grantId,
          isolationId: revision.id,
          profile: "github-repository",
          appId: fixtureAppId,
          installationId: fixtureInstallationId,
          repositories: [{ repositoryId: fixtureRepositoryId, repository: fixtureRepository }],
          permissions,
        },
      };
    }
    const [a, b, c] = [
      await admit(first.revision),
      await admit(second),
      await admit(otherNamespace.revision),
    ] as const;
    const clock = createSystemClock();
    const github: (t: TestContext, options: object) => ReturnType<typeof startGitHubFixture> =
      startGitHubFixture;
    function holdProviderIssue() {
      return { arrived: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
    }
    let issueGate: ReturnType<typeof holdProviderIssue> | undefined;
    const gh = await github(t, {
      additionalPermissions: [permissions],
      async beforeIssue() {
        const gate = issueGate;
        if (gate) {
          gate.arrived.resolve();
          await gate.release.promise;
        }
      },
    });
    const issuerAuthority = preparationIssuerAuthority(gh.origin, gh.tls.ca);
    const custodyKey = randomBytes(32);
    t.after(() => {
      custodyKey.fill(0);
    });
    const issuer = createGitHubKeyOwner({ privateKey: gh.privateKey, appId: fixtureAppId, clock });
    t.after(() => issuer.close());
    // The signed broker journey separately exercises the production live-session checks. This
    // fixture drives the storage port with two distinct already-admitted database sessions.
    const liveSessions = `SELECT m.source->'session' AS session
    FROM occ.prepared_github_shared_members m
    JOIN occ.repository_session_attempts s USING (admission_id)
    WHERE s.phase='open'`;
    const options = {
      custodyKey,
      issuerAuthority,
      apiOrigin: gh.origin,
      driver,
      repositoryBackendId: backendId,
      providerInstanceId,
      issuerGeneration: 1,
      liveSessions,
    };
    const workerA = new SharedPreparedRepositoryGit({ ...options, pool: poolA });
    const workerB = new SharedPreparedRepositoryGit({ ...options, pool: poolB });
    async function admittedTransaction<T>(
      pool: typeof poolA,
      source: PreparedRepositoryGitSource,
      run: (client: PostgresClient) => Promise<T>,
    ) {
      const db = await pool.connect();
      try {
        await db.query("BEGIN");
        await db.query("SELECT set_config('occ.repository_git_driver', $1, true)", [
          JSON.stringify(driver),
        ]);
        const locked = await db.query(
          "SELECT FROM occ.repository_session_attempts WHERE admission_id=$1 AND phase='open' FOR SHARE",
          [source.session.admissionId],
        );
        const result =
          locked.rowCount === 1 ? await run(db as unknown as PostgresClient) : undefined;
        await db.query("COMMIT");
        return result;
      } catch (error) {
        await db.query("ROLLBACK");
        throw error;
      } finally {
        db.release();
      }
    }
    const inputVersion = "b".repeat(64);
    assert.equal(await workerA.observeIssuer(inputVersion), true);
    assert.equal(await workerB.observeIssuer(inputVersion), true);
    const [linkedA, linkedB, linkedC] = await Promise.all([
      admittedTransaction(poolA, a, (db) => workerA.attach(db, a, inputVersion)),
      admittedTransaction(poolB, b, (db) => workerB.attach(db, b, inputVersion)),
      admittedTransaction(poolA, c, (db) => workerA.attach(db, c, inputVersion)),
    ]);
    assert.ok(linkedA && linkedB && linkedC);
    assert.deepEqual(linkedA.admission, linkedB.admission);
    assert.notEqual(linkedA.admission.familyId, linkedC.admission.familyId);
    function prepare(
      family: NonNullable<typeof linkedA>,
      ca = gh.tls.ca,
      getKey = async () => issuer,
    ) {
      return createGitHubPreparationOwner({
        ...family,
        clock,
        apiOrigin: gh.origin,
        ca,
        getKey,
        renewBeforeMs: 60_000,
        minimumValidityMs: 60_000,
      });
    }
    const sharedIssue = (issueGate = holdProviderIssue());
    const mint = runPreparation(prepare(linkedA), t.signal);
    try {
      await providerArrival(sharedIssue.arrived.promise, mint);
      // Crossing the dispatch window alone must not fence an already dispatched response.
      await poolA.query(
        "UPDATE occ.prepared_github_attempts SET started_at=clock_timestamp()-interval '2 minutes' WHERE source_id=$1",
        [linkedA.admission.familyId],
      );
      assert.equal(await runPreparation(prepare(linkedB), t.signal), "blocked");
    } finally {
      issueGate = undefined;
      sharedIssue.release.resolve();
      await Promise.allSettled([mint]);
    }
    assert.equal(await mint, "committed");
    assert.equal(gh.issuesOfTokens.length, 1);
    const actual = await workerB.waitForVersion(linkedB.admission, Date.now() + 5000, t.signal);
    assert.ok(actual);
    assert.deepEqual(
      actual,
      await workerA.waitForVersion(linkedA.admission, Date.now() + 5000, t.signal),
    );
    assert.equal(
      await workerA.waitForVersion(linkedC.admission, Date.now() + 5000, t.signal),
      undefined,
    );
    const material = await admittedTransaction(poolB, b, (db) => workerB.readMember(db, b, actual));
    assert.ok(material);
    // A member cannot substitute another version, even within its own token family.
    assert.equal(
      await admittedTransaction(poolB, b, (db) =>
        workerB.readMember(db, b, { ...actual, materialVersion: randomUUID() }),
      ),
      undefined,
    );
    await platform.transact((unit) =>
      unit.repositorySessions.advanceAttempt({
        admissionId: a.session.admissionId,
        expectedPhase: "open",
        phase: "closing",
        updatedAt: new Date().toISOString(),
      }),
    );
    await workerA.retireUnused();
    assert.equal(
      await admittedTransaction(poolA, a, (db) => workerA.readMember(db, a, actual)),
      undefined,
    );
    assert.ok(await admittedTransaction(poolB, b, (db) => workerB.readMember(db, b, actual)));
    assert.equal(await workerA.takeRetirement(linkedA.admission.familyId), undefined);
    assert.equal(gh.issuesOfTokens.length, 1);

    const next = new SharedPreparedRepositoryGit({ ...options, pool: poolB, issuerGeneration: 2 });
    const nextVersion = "c".repeat(64);
    assert.equal(
      await workerB.observeIssuer(nextVersion),
      false,
      "same generation cannot change key",
    );
    const staleIssue = (issueGate = holdProviderIssue());
    const inFlight = runPreparation(prepare(linkedC), t.signal);
    try {
      await providerArrival(staleIssue.arrived.promise, inFlight);
      assert.equal(await next.observeIssuer(nextVersion), true);
    } finally {
      issueGate = undefined;
      staleIssue.release.resolve();
      await Promise.allSettled([inFlight]);
    }
    assert.equal(await inFlight, "quarantined");
    assert.equal(
      await workerA.waitForVersion(linkedC.admission, Date.now() + 1000, t.signal),
      undefined,
      "a provider response in flight cannot publish after its generation is fenced",
    );
    const restarted = new SharedPreparedRepositoryGit({
      ...options,
      pool: poolA,
      issuerGeneration: 2,
    });
    assert.equal(await restarted.observeIssuer(nextVersion), true);
    assert.equal(
      await admittedTransaction(poolA, c, (db) => restarted.attach(db, c, nextVersion)),
      undefined,
      "a restarted Worker cannot bypass the unsettled old mint",
    );
    assert.equal(gh.issuesOfTokens.length, 2);

    assert.equal(
      await workerA.observeIssuer(inputVersion),
      false,
      "stale Worker cannot reset epoch",
    );
    assert.equal(
      await workerA.waitForVersion(linkedA.admission, Date.now() + 1000, t.signal),
      undefined,
    );
    assert.equal(
      await admittedTransaction(poolA, b, (db) => workerA.readMember(db, b, actual)),
      undefined,
      "stale Worker cannot release material for an independently still-live member",
    );
    const newScope = {
      ...c,
      grant: { ...c.grant, permissions: { contents: "write", metadata: "read" } },
    } as PreparedRepositoryGitSource;
    assert.equal(
      await admittedTransaction(poolA, newScope, (db) =>
        workerA.attach(db, newScope, inputVersion),
      ),
      undefined,
      "stale Worker cannot create an unseen family",
    );
    assert.equal(
      await admittedTransaction(poolB, b, (db) => next.attach(db, b, nextVersion)),
      undefined,
      "replacement waits for old custody",
    );
    assert.equal(
      await retirePreparedGitHubToken(
        next,
        linkedA.admission.familyId,
        t.signal,
        gh.origin,
        gh.tls.ca,
        clock,
      ),
      "retired",
    );
    assert.equal(gh.tokenState()[0]?.revoked, true);
    const linkedNext = await admittedTransaction(poolB, b, (db) => next.attach(db, b, nextVersion));
    assert.ok(linkedNext);
    assert.equal(linkedNext.admission.ownerEpoch, 2);
    assert.equal(await runPreparation(prepare(linkedNext), t.signal), "committed");
    const replacement = await next.waitForVersion(
      linkedNext.admission,
      Date.now() + 1000,
      t.signal,
    );
    assert.ok(replacement);
    assert.notDeepEqual(replacement, actual);
    assert.equal(gh.issuesOfTokens.length, 3);

    // Selecting an old operation restores its duplicate fence, without replaying the provider.
    assert.equal(
      await prepare(linkedNext).run(actual.preparationAttemptId, {
        signal: t.signal,
        deadlineMonoMs: clock.monotonicNow() + 5000,
      }),
      "blocked",
    );
    // A live intent is projected; once its durable bound passes only its exact invocation
    // can settle it. A legitimate successor must remain current when the late response arrives.
    await poolA.query(
      "UPDATE occ.prepared_github_attempts SET usable_until=clock_timestamp()+interval '30 seconds' WHERE id=$1",
      [replacement.preparationAttemptId],
    );
    const trustDirectory = await temporaryDirectory(t);
    const additionalCaPath = join(trustDirectory, "additional-ca.pem");
    await run("openssl", [
      "req",
      "-x509",
      "-key",
      gh.tls.keyFile,
      "-out",
      additionalCaPath,
      "-days",
      "2",
      "-subj",
      "/CN=additional-test-trust",
    ]);
    const nextCa = Buffer.concat([gh.tls.ca, Buffer.from("\n"), await readFile(additionalCaPath)]);
    const changedAuthority = preparationIssuerAuthority(gh.origin, nextCa);
    assert.notEqual(changedAuthority, issuerAuthority);
    const changed = new SharedPreparedRepositoryGit({
      ...options,
      pool: poolB,
      issuerGeneration: 3,
      issuerAuthority: changedAuthority,
    });
    // Pause before the genuine dispatch fence. A successor claim must irrevocably
    // quarantine this intent, even if its timestamp later re-enters the dispatch window.
    const pausedId = randomUUID();
    const keyGate = holdProviderIssue();
    const paused = prepare(linkedNext, gh.tls.ca, async () => {
      keyGate.arrived.resolve();
      await keyGate.release.promise;
      return issuer;
    }).run(pausedId, { signal: t.signal, deadlineMonoMs: clock.monotonicNow() + 25_000 });
    const lateId = randomUUID();
    const lateIssue = holdProviderIssue();
    let lateMint: Promise<string> | undefined;
    let successor: Awaited<ReturnType<typeof next.waitForVersion>>;
    let successorMint: Promise<string> | undefined;
    let successorIssue: ReturnType<typeof holdProviderIssue> | undefined;
    let successorAdmission: typeof linkedNext.admission;
    const projection = () =>
      linkedNext.store.readCurrent(linkedNext.admission.familyId, (row) =>
        row?.attempts.map((attempt) => attempt.id).sort(),
      );
    try {
      await providerArrival(keyGate.arrived.promise, paused);
      await poolA.query(
        "UPDATE occ.prepared_github_attempts SET started_at=clock_timestamp()-interval '3 hours' WHERE id=$1",
        [pausedId],
      );
      issueGate = lateIssue;
      lateMint = prepare(linkedNext).run(lateId, {
        signal: t.signal,
        deadlineMonoMs: clock.monotonicNow() + 25_000,
      });
      await providerArrival(lateIssue.arrived.promise, lateMint);
      await poolA.query(
        "UPDATE occ.prepared_github_attempts SET started_at=clock_timestamp() WHERE id=$1",
        [pausedId],
      );
      keyGate.release.resolve();
      assert.equal(await bounded(paused), "quarantined");
      assert.equal(
        gh.issuesOfTokens.length,
        3,
        "the superseded original never dispatches while its successor is issuing",
      );
      // Age the fenced intent again before the independent authority-change case.
      await poolA.query(
        "UPDATE occ.prepared_github_attempts SET started_at=clock_timestamp()-interval '3 hours' WHERE id=$1",
        [pausedId],
      );
      assert.deepEqual(await projection(), [replacement.preparationAttemptId, lateId].sort());
      await poolA.query(
        "UPDATE occ.prepared_github_attempts SET started_at=clock_timestamp()-interval '3 hours' WHERE id=$1",
        [lateId],
      );
      assert.deepEqual(await projection(), [replacement.preparationAttemptId]);
      assert.ok(linkedNext.store.forAttempt);
      assert.deepEqual(
        await linkedNext.store
          .forAttempt(lateId, linkedNext.admission)
          .readCurrent(linkedNext.admission.familyId, (row) =>
            row?.attempts.map((attempt) => attempt.id).sort(),
          ),
        [replacement.preparationAttemptId, lateId].sort(),
      );
      assert.equal(await changed.observeIssuer(nextVersion), true);
      assert.equal(
        await retirePreparedGitHubToken(
          next,
          linkedNext.admission.familyId,
          t.signal,
          gh.origin,
          gh.tls.ca,
          clock,
        ),
        "retired",
      );
      const linkedChanged = await admittedTransaction(poolB, b, (db) =>
        changed.attach(db, b, nextVersion),
      );
      assert.ok(linkedChanged);
      assert.equal(linkedChanged.admission.familyId, linkedNext.admission.familyId);
      assert.equal(linkedChanged.admission.issuerAuthority, changedAuthority);
      successorAdmission = linkedChanged.admission;
      assert.equal(
        await linkedNext.store.readCurrent(
          linkedNext.admission.familyId,
          (row) => row !== undefined,
        ),
        false,
      );
      successorIssue = issueGate = holdProviderIssue();
      successorMint = runPreparation(prepare(linkedChanged, nextCa), t.signal);
      await providerArrival(successorIssue.arrived.promise, successorMint);
      // Rollback cannot restore the original's publication authority after successor dispatch.
      await poolA.query(
        "UPDATE occ.prepared_github_attempts SET started_at=clock_timestamp() WHERE id=$1",
        [lateId],
      );
      successorIssue.release.resolve();
      assert.equal(await bounded(successorMint), "committed");
      successor = await changed.waitForVersion(
        linkedChanged.admission,
        Date.now() + 1000,
        t.signal,
      );
      assert.ok(successor);
      lateIssue.release.resolve();
      assert.equal(await bounded(lateMint), "quarantined");
    } finally {
      issueGate = undefined;
      successorIssue?.release.resolve();
      keyGate.release.resolve();
      lateIssue.release.resolve();
      await Promise.allSettled([
        paused,
        ...(lateMint ? [lateMint] : []),
        ...(successorMint ? [successorMint] : []),
      ]);
    }
    assert.deepEqual(
      await changed.waitForVersion(successorAdmission, Date.now() + 1000, t.signal),
      successor,
    );
    assert.deepEqual(
      (
        await poolA.query(
          `SELECT state,custody,sealed IS NOT NULL AS captured,
        provider_expires_at > clock_timestamp() AS live, admission=$2::jsonb AS original
        FROM occ.prepared_github_attempts WHERE id=$1`,
          [lateId, linkedNext.admission],
        )
      ).rows,
      [{ state: "quarantined", custody: "retire", captured: true, live: true, original: true }],
    );
    assert.equal(
      await prepare(linkedNext).run(lateId, {
        signal: t.signal,
        deadlineMonoMs: clock.monotonicNow() + 5000,
      }),
      "fenced",
    );
    assert.deepEqual(
      (
        await poolA.query("SELECT state,custody FROM occ.prepared_github_attempts WHERE id=$1", [
          actual.preparationAttemptId,
        ])
      ).rows,
      [{ state: "committed", custody: "revoked" }],
    );
    // Only the original issuer can decrypt and retire its captured credential; the new
    // issuer's current version is neither selected nor changed by that cleanup.
    assert.equal(
      await retirePreparedGitHubToken(
        next,
        linkedNext.admission.familyId,
        t.signal,
        gh.origin,
        gh.tls.ca,
        clock,
      ),
      "retired",
    );
    assert.deepEqual(
      (
        await poolA.query(
          "SELECT custody,sealed IS NULL AS erased FROM occ.prepared_github_attempts WHERE id=$1",
          [lateId],
        )
      ).rows,
      [{ custody: "revoked", erased: true }],
    );
    assert.deepEqual(
      await changed.waitForVersion(successorAdmission, Date.now() + 1000, t.signal),
      successor,
    );
    assert.equal(gh.issuesOfTokens.length, 5);
  },
);

test(
  "PostgreSQL separates renamed repository grants through the installed Driver enrollment",
  { ...requiresPostgres, timeout: 90_000 },
  async (t) => {
    const namespaceId = `ns_${randomUUID()}`;
    const id = "repository-rename-fixture";
    const { directory } = await protectedDriverPackage(t, id, "repository-git");
    const { cert } = await harnessTlsFixture(t);
    const certFile = join(directory, "peer.pem");
    const registryPath = join(directory, "registry.json");
    await writeFile(certFile, cert);
    const registry = (repository: string) => ({
      version: 1,
      backendId: "github-primary",
      providerInstanceId: "github-com-primary",
      appId: fixtureAppId,
      githubInstallationId: fixtureInstallationId,
      maximumDurationSeconds: 3600,
      repositories: [
        {
          repositoryRef: "source",
          repositoryId: fixtureRepositoryId,
          repository,
          namespaces: [
            {
              namespaceId,
              profiles: ["github-repository"],
              permissions: { contents: "read", metadata: "read" },
            },
          ],
        },
      ],
    });
    const base = createInstallationDriverConfiguration();
    const configuration = {
      ...base,
      presets: { includeDefaults: false },
      backend: [
        {
          id: "github-primary",
          type: "github",
          configuration: { registryPath },
          drivers: { repo: "repo" },
        },
      ],
      repository: {
        id: "repo",
        configuration: { sessionDurationSeconds: 600 },
        preparedGitHub: {
          custodyKeyPath: join(directory, "custody"),
          privateKeyPath: join(directory, "signer"),
        },
      },
      drivers: {
        ...base.drivers,
        sandbox: {
          id,
          package: id,
          configuration: {
            origin: "https://127.0.0.1:41001",
            peerOrigin: "https://127.0.0.1:41002",
            capabilityOrigin: "https://127.0.0.1:41003",
            certFile,
            releaseKey: "fixture-release-key",
          },
        },
        credential_proxy: { id, configuration: {} },
      },
    };
    const configPath = join(directory, "installation.json");
    await writeFile(configPath, JSON.stringify(configuration));
    const load = async (repository: string) => {
      await writeFile(registryPath, JSON.stringify(registry(repository)), { mode: 0o600 });
      const runtime = await loadInstallationConfiguration({
        mode: "production",
        environment: { OCC_CONFIG_PATH: configPath },
        packageRoot: directory,
      });
      assert.ok(
        runtime?.repositoryGitDriver && runtime.repositoryRegistry && runtime.repositoryAdmission,
      );
      t.after(() => runtime.protectedDriver?.close());
      const resolution = runtime.repositoryAdmission.policy.resolveBindings({
        namespaceId,
        bindings: [{ repositoryRef: "source", profile: "github-repository" }],
      });
      return { runtime, binding: resolution.bindings[0]! };
    };
    const original = await load(fixtureRepository);
    const unchanged = await load(fixtureRepository);
    const renamed = await load("example/renamed");
    assert.deepEqual(
      unchanged.runtime.repositoryGitDriver!.ref,
      original.runtime.repositoryGitDriver!.ref,
    );
    assert.deepEqual(unchanged.binding, original.binding);
    assert.equal(renamed.binding.grant.repositoryId, original.binding.grant.repositoryId);
    assert.notEqual(renamed.binding.grant.grantId, original.binding.grant.grantId);
    assert.notEqual(
      renamed.runtime.repositoryGitDriver!.ref.configurationId,
      original.runtime.repositoryGitDriver!.ref.configurationId,
    );
    assert.throws(
      () =>
        resolveSelectedRepositoryGrant(
          renamed.runtime.repositoryRegistry!,
          namespaceId,
          "revision",
          [original.binding],
        ),
      /selected-repository-grant-changed/,
    );

    const pool = testPool(t, { connectionString: databaseUrl!, max: 4 });
    const platform = new PostgresPlatformState(pool);
    const createdAt = new Date().toISOString();
    const credentials = (binding: typeof original.binding) => ({
      driver: { id: "repo", implementation: "github" },
      bindings: [binding],
      deadlineWallMs: Date.now() + 600_000,
    });
    const first = await seedSessionRevision(platform, credentials(original.binding), {
      namespaceId,
      createdAt,
      executionMode: "dedicated",
    });
    // The rename requires a newly admitted revision and grant in the same Namespace.
    const second = await platform.transact(async (unit) => {
      const config = { ...first.configuration, id: `cfg_${randomUUID()}` };
      const agent = {
        ...first.agent,
        id: `agt_${randomUUID()}`,
        name: "renamed source",
        configurationId: config.id,
        servicePrincipalId: `test-agent-${randomUUID()}`,
        desiredRuntimeState: "stopped",
        status: "active",
      };
      const revision = {
        ...first.revision,
        id: `rev_${randomUUID()}`,
        agentId: agent.id,
        configurationId: config.id,
        servicePrincipalId: agent.servicePrincipalId,
        repositoryCredentials: credentials(renamed.binding),
      } as typeof first.revision;
      await unit.configurations.createConfiguration(
        config as Parameters<typeof unit.configurations.createConfiguration>[0],
      );
      await unit.agents.createAgent(agent as Parameters<typeof unit.agents.createAgent>[0]);
      await unit.revisions.createRevision(
        revision as Parameters<typeof unit.revisions.createRevision>[0],
      );
      await unit.agents.transitionAgentDesiredRuntimeState(
        namespaceId,
        agent.id,
        "stopped",
        "running",
      );
      return revision;
    });
    const source = async (
      selection: typeof original,
      revision: typeof first.revision,
    ): Promise<PreparedRepositoryGitSource> => {
      const attempt = sessionAttempt(revision);
      const sessionId = randomUUID();
      await platform.transact(async (unit) => {
        await unit.agents.compareAndSetActiveRevision(
          namespaceId,
          revision.agentId,
          undefined,
          revision.id,
        );
        await unit.repositorySessions.createAttempt(attempt);
        assert.ok(
          await unit.repositorySessions.advanceAttempt({
            admissionId: attempt.admissionId,
            expectedPhase: "opening",
            phase: "open",
            sessionId,
            updatedAt: createdAt,
          }),
        );
      });
      return {
        adoption: "credential_proxy_github_repository",
        key: { source: { id: "repository-git:" + attempt.admissionId } },
        session: {
          namespaceId,
          agentId: revision.agentId,
          revisionId: revision.id,
          admissionId: attempt.admissionId,
          sessionId,
          driver: revision.repositoryCredentials.driver,
          binding: selection.binding,
          bindings: [selection.binding],
        },
        grant: resolveSelectedRepositoryGrant(
          selection.runtime.repositoryRegistry!,
          namespaceId,
          revision.id,
          [selection.binding],
        ),
      };
    };
    const oldSource = await source(original, first.revision);
    const newSource = await source(renamed, second);
    const custodyKey = randomBytes(32);
    t.after(() => custodyKey.fill(0));
    const owner = (selection: typeof original) =>
      new SharedPreparedRepositoryGit({
        pool,
        custodyKey,
        issuerAuthority: "fixture-authority",
        apiOrigin: "https://api.github.com",
        driver: selection.runtime.repositoryGitDriver!.ref,
        repositoryBackendId: "github-primary",
        providerInstanceId: "github-com-primary",
        issuerGeneration: 1,
        liveSessions: "SELECT '{}'::jsonb AS session WHERE false",
      });
    const oldOwner = owner(original);
    const sameOwner = owner(unchanged);
    const newOwner = owner(renamed);
    const inputVersion = "b".repeat(64);
    assert.equal(await oldOwner.observeIssuer(inputVersion), true);
    assert.equal(await newOwner.observeIssuer(inputVersion), true);
    const attach = async (
      selectedOwner: SharedPreparedRepositoryGit,
      selection: typeof original,
      member: PreparedRepositoryGitSource,
    ) => {
      const db = await pool.connect();
      try {
        await db.query("BEGIN");
        await db.query("SELECT set_config('occ.repository_git_driver', $1, true)", [
          JSON.stringify(selection.runtime.repositoryGitDriver!.ref),
        ]);
        await db.query(
          "SELECT FROM occ.repository_session_attempts WHERE admission_id=$1 AND phase='open' FOR SHARE",
          [member.session.admissionId],
        );
        const result = await selectedOwner.attach(
          db as unknown as PostgresClient,
          member,
          inputVersion,
        );
        await db.query("COMMIT");
        return result;
      } catch (error) {
        await db.query("ROLLBACK");
        throw error;
      } finally {
        db.release();
      }
    };
    const oldFamily = await attach(oldOwner, original, oldSource);
    const sameFamily = await attach(sameOwner, unchanged, oldSource);
    const newFamily = await attach(newOwner, renamed, newSource);
    assert.ok(oldFamily && sameFamily && newFamily);
    assert.equal(sameFamily.admission.familyId, oldFamily.admission.familyId);
    assert.notEqual(newFamily.admission.familyId, oldFamily.admission.familyId);
    assert.deepEqual(oldFamily.admission.grant.repositories, [
      { repositoryId: fixtureRepositoryId, repository: fixtureRepository },
    ]);
    assert.deepEqual(newFamily.admission.grant.repositories, [
      { repositoryId: fixtureRepositoryId, repository: "example/renamed" },
    ]);
  },
);
