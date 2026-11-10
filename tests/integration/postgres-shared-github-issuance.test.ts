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
    function prepare(family: NonNullable<typeof linkedA>) {
      return createGitHubPreparationOwner({
        ...family,
        clock,
        apiOrigin: gh.origin,
        ca: gh.tls.ca,
        getKey: async () => issuer,
        renewBeforeMs: 60_000,
        minimumValidityMs: 60_000,
      });
    }
    const sharedIssue = (issueGate = holdProviderIssue());
    const mint = runPreparation(prepare(linkedA), t.signal);
    try {
      await sharedIssue.arrived.promise;
      assert.equal(await runPreparation(prepare(linkedB), t.signal), "blocked");
    } finally {
      issueGate = undefined;
      sharedIssue.release.resolve();
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
      await staleIssue.arrived.promise;
      assert.equal(await next.observeIssuer(nextVersion), true);
    } finally {
      issueGate = undefined;
      staleIssue.release.resolve();
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
  },
);
