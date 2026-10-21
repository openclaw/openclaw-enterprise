import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type {
  AgentRevision,
  PreparedGitHubUseRequest,
} from "../../packages/contracts/src/index.ts";
import { fixture } from "../fixtures/prepared-repository-git.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";

test(
  "only the installed Git recipient owner may use its material or retire its ended admission",
  requiresPostgres,
  async (t) => {
    // These two workers share the Repo, issuer and custody key. Change only the installed Driver configuration.
    const f = await fixture(t);
    // Even this implementation name cannot select the bundled observer's privileged evidence path.
    const driver = {
      id: "custody-sender",
      implementation: "openshell",
      configurationId: "b".repeat(64),
    };
    const protectedOwner = (extra = {}) =>
      f.startOwner({ controlSocket: undefined, protectedGitDriver: driver, ...extra });
    const owner = await protectedOwner();
    const other = await protectedOwner({
      protectedGitDriver: { ...driver, configurationId: "a".repeat(64) },
    });
    const legacy = await f.startOwner({ controlSocket: undefined });
    const mine = owner.protectedGit!;
    const notMine = other.protectedGit!;
    const { namespaceId, agentId, servicePrincipalId, repositoryCredentials } =
      f.revision as AgentRevision;
    const admissionId = randomUUID();
    const sessionId = randomUUID();
    const revisionId = "rev_" + randomUUID();
    const executionId = randomUUID().replaceAll("-", "");
    const createdAt = new Date().toISOString();
    const plan = {
      id: "custody-proof",
      generation: 1,
      driver,
      execution: {
        namespaceId,
        agentId,
        servicePrincipalId,
        revisionId,
        executionId,
        installationId: "test",
      },
      sandboxDriverId: driver.id,
      egressDriverId: driver.id,
      repositoryGit: repositoryCredentials!,
      routes: [],
    };
    const installation = {
      plan,
      sandboxId: "recipient-" + randomUUID(),
      sender: { id: driver.id, generation: 1 },
      installedAt: createdAt,
      enforcement: {
        instanceId: "one-execution",
        configurationId: "one-config",
        policyHash: "one-policy",
        authorityScope: "execution" as const,
        peerKeyId: "authenticated-test-peer",
        repositoryGitRecipient: {
          providerId: "provider",
          attachmentEpoch: "epoch",
          processInstanceId: "process",
          networkInstanceId: "net",
        },
      },
    };
    // Close the fixture's protocol-1 session without issuing material. Admit a genuine distinct protected revision.
    await f.withdraw();
    await f.state.transact(async (u) => {
      const sessions = u.repositorySessions;
      const prior = (await sessions.findBrokerReceipt(f.admissionId))!;
      const old = { admissionId: f.admissionId, updatedAt: createdAt };
      await sessions.advanceBrokerReceipt({
        ...old,
        generation: prior.generation!,
        sessionId: f.sessionId,
        deadlineWallMs: f.deadlineWallMs,
        revoked: 0,
        expired: 0,
        expectedState: "active",
        state: "disposed",
      });
      await sessions.advanceAttempt({ ...old, expectedPhase: "closing", phase: "disposed" });
      await u.revisions.createRevision({
        ...(f.revision as AgentRevision),
        id: revisionId,
        revision: f.revision.revision + 1,
        executionAdmission: { version: 4, mode: "protected" },
        egressPlan: plan,
      });
      assert.ok(
        await u.agents.compareAndSetActiveRevision(namespaceId, agentId, f.revision.id, revisionId),
      );
      await sessions.createAttempt({
        namespaceId,
        agentId,
        revisionId,
        admissionId,
        repositoryRef: "source",
        durationSeconds: 3600,
        deadlineWallMs: f.deadlineWallMs,
        createdAt,
        brokerProtocol: 2,
      });
      await sessions.advanceAttempt({
        admissionId,
        expectedPhase: "opening",
        phase: "open",
        sessionId,
        updatedAt: createdAt,
      });
      await u.credentialSources.recordEgressInstallation(installation);
    });
    const request = () => f.request({ sessionId }) as PreparedGitHubUseRequest;
    const revocations = () => f.gh.trace.filter((call) => call.method === "DELETE").length;
    assert.equal(await notMine.recipients.observe(installation), undefined);
    const route = await mine.recipients.observe(installation);
    assert.ok(route);
    assert.deepEqual(await mine.readMaterial(route, t.signal), { absent: "unprepared" });
    await owner.maintain();
    const warm = await mine.readMaterial(route, t.signal);
    assert.ok(
      warm && "value" in warm,
      "the admitted recipient receives committed material, without another issuance",
    );
    assert.equal(f.gh.issuesOfTokens.length, 1);
    const { preparationAttemptId, materialVersion } = warm;
    const version = { preparationAttemptId, materialVersion };
    assert.equal(
      await mine.recipients.beginInstall(route, { ...version, materialVersion: randomUUID() }),
      undefined,
      "an attempt does not authorize installing a different material version",
    );
    const pending = await mine.recipients.beginInstall(route, version);
    assert.ok(pending);

    // We do not yet know whether installation succeeded. No owner may turn missing live evidence into retirement.
    assert.equal(await mine.recipients.observe(installation), undefined);
    assert.equal(
      await mine.recipients.beginInstall(route, version),
      undefined,
      "never repeat an uncertain installation",
    );
    await owner.maintain();
    await other.maintain();
    await legacy.maintain();
    assert.equal(revocations(), 0);
    const familyId = "repository-git:" + admissionId;
    const inspect = () => owner.inspectTokenAttempt(familyId, preparationAttemptId);
    assert.equal((await inspect())?.custody, "current");
    assert.equal(await other.inspectTokenAttempt(familyId, preparationAttemptId), undefined);
    assert.equal(await notMine.recipients.confirmInstall(pending), undefined);
    const installedRoute = await mine.recipients.confirmInstall(pending);
    assert.ok(installedRoute);
    const installed = { route: installedRoute, ...version };
    const denied = await notMine.readMaterial(installedRoute, t.signal);
    assert.deepEqual(
      denied,
      { absent: "unprepared" },
      "unknown is neither material nor proof of withdrawal",
    );
    const unavailable = { kind: "denied", reason: "unavailable" };
    assert.deepEqual(await notMine.authorize(request(), installed, t.signal), unavailable);
    const q = request();
    const permit = await mine.authorize(q, installed, t.signal);
    assert.equal(permit.kind, "permit");
    assert.deepEqual(
      await mine.authorize(q, installed, t.signal),
      unavailable,
      "a committed possible use is not replayable",
    );

    // PostgreSQL commits, but the reply is lost. The Driver gets no permit, even though a second
    // connection sees the possible use. Do not try to recover permission from that receipt.
    let commits = 0;
    const uncertain = await protectedOwner({
      pool: {
        async connect() {
          const client = await f.pool.connect();
          return {
            async query(sql: string, values?: unknown[]) {
              const result = await client.query(sql, values);
              if (sql === "COMMIT") {
                commits++;
                throw Object.assign(new Error("lost commit acknowledgment"), { code: "08007" });
              }
              return result;
            },
            release: (discard: boolean) => client.release(discard),
          };
        },
      },
    });
    const lost = request();
    assert.deepEqual(
      await uncertain.protectedGit!.authorize(lost, installed, t.signal),
      unavailable,
    );
    assert.equal(commits, 1, "the uncertain commit was not retried");
    const receipt = await f.pool.query(
      "SELECT attempt_id, material_version FROM occ.prepared_repository_git_uses WHERE exchange_id=$1",
      [lost.exchangeId],
    );
    assert.deepEqual(receipt.rows, [
      { attempt_id: preparationAttemptId, material_version: materialVersion },
    ]);
    assert.equal(f.gh.issuesOfTokens.length, 1);

    await f.state.transact((u) =>
      u.repositorySessions.advanceAttempt({
        admissionId,
        expectedPhase: "open",
        phase: "closing",
        updatedAt: new Date().toISOString(),
      }),
    );
    assert.deepEqual(await mine.authorize(request(), installed, t.signal), {
      kind: "denied",
      reason: "access_withdrawn",
    });
    // Same recipient owner, changed issuer: preserve the old issuer's explicit obligation (no secret in the report).
    const reports: string[] = [];
    const next = await protectedOwner({
      apiOrigin: f.gh.origin.replace("127.0.0.1", "localhost"),
      report: (code: string) => reports.push(code),
    });
    await next.maintain();
    assert.deepEqual(reports, ["PREPARED_GITHUB_RETIRED_UNREVOKED"]);
    assert.equal((await inspect())?.custody, "retire");
    // Now retirement is really due. Even with the correct issuer/key, the other recipient owner cannot take it.
    await other.maintain();
    await legacy.maintain();
    assert.equal(revocations(), 0);
    assert.equal((await inspect())?.custody, "retire");
    await owner.maintain();
    assert.equal(revocations(), 1);
    assert.equal((await inspect())?.custody, "revoked");
  },
);
