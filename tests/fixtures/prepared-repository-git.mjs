import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { get } from "node:https";
import { join } from "node:path";
import pg from "pg";
import {
  PostgresPlatformState,
  repositoryApprovalFingerprint,
} from "../../packages/occ/src/index.ts";
import { startPreparedGitHubGitOwner } from "../../apps/controller/src/backends/repository-credentials/prepared-git-owner.ts";
import {
  validateGitHubRepositoryRegistry,
  resolveGitHubRepositoryBinding,
  resolveGitHubStandingApprovalScope,
} from "../../apps/controller/src/drivers/repo/github/credentials/registry.ts";
import { createSystemClock } from "../../apps/controller/src/drivers/repo/credentials/clock.ts";
import {
  startGitHubFixture,
  fixtureAppId,
  fixtureInstallationId,
  fixtureRepositoryId,
  fixtureRepository,
} from "./repository-credentials/github.mjs";
import {
  seedSessionRevision,
  sessionAttempt,
} from "../conformance/repository-sessions.contract.mjs";
import { socketDirectory } from "../helpers/socket-directory.mjs";
import { databaseUrl } from "../helpers/postgres-database.mjs";
import { ensurePostgresAgentBootstrap } from "../helpers/postgres-agent-app.mjs";

// This exercises the production use service over real PostgreSQL and a synthetic
// HTTPS GitHub App issuer. It does not prove a Git subprocess or live GitHub push.
export async function fixture(
  t,
  {
    openBroker,
    draftPull = false,
    draftPullLimit = /** @type {"none" | undefined} */ (undefined),
    draftResponse,
    dnsIssuer = false,
    sessionLifetimeMs = 3_600_000,
    standingApproval = false,
    installationAccess = false,
  } = {},
) {
  const directory = await socketDirectory(t, "prepared-git-");
  const privateKeyPath = join(directory, "app.pem");
  const custodyKeyPath = join(directory, "custody.key");
  const permissions = {
    metadata: "read",
    contents: "write",
    ...(draftPull && { pull_requests: "write" }),
  };
  const gh = await startGitHubFixture(t, {
    clock: createSystemClock(),
    additionalPermissions: [permissions],
    installationAccess,
    draftResponse,
  });
  await writeFile(privateKeyPath, gh.privateKey.export({ type: "pkcs8", format: "pem" }), {
    mode: 0o600,
  });
  await writeFile(custodyKeyPath, randomBytes(32), { mode: 0o600 });
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  const state = new PostgresPlatformState(pool);
  const namespaceId = `ns_${randomUUID()}`;
  const driverId = "repository-credentials";
  const backendId = `prepared-git-${randomUUID()}`;
  const pushRef = "refs/heads/prepared-fixture";
  const repositoryRef = "source";
  const registry = validateGitHubRepositoryRegistry({
    version: 1,
    backendId,
    providerInstanceId: `github-${randomUUID()}`,
    appId: fixtureAppId,
    githubInstallationId: fixtureInstallationId,
    maximumDurationSeconds: 3600,
    ...(standingApproval && { allowStandingApprovals: true }),
    ...(installationAccess && {
      installationAccess: {
        repositoryRef: "team-install",
        namespaces: [{ namespaceId, accessMode: "installation" }],
      },
    }),
    repositories: [
      {
        repositoryRef,
        repositoryId: fixtureRepositoryId,
        repository: fixtureRepository,
        namespaces: [
          {
            namespaceId,
            profiles: ["git-write"],
            ...(standingApproval && { allowStandingApproval: true }),
            ...(draftPull
              ? { transport: "git-and-draft-pr", pullRequestBase: "main" }
              : { transport: "git-only" }),
            ...(draftPullLimit === undefined ? {} : { draftPullLimit }),
            pushRefAllowlist: [pushRef],
          },
        ],
      },
    ],
  });
  const binding = resolveGitHubRepositoryBinding(registry, {
    namespaceId,
    repositoryRef,
    profile: "git-write",
  });
  const driver = { id: driverId, implementation: "github" };
  await ensurePostgresAgentBootstrap(t, {
    label: "prepared-repository-git",
    authSecret: "prepared-repository-git-fixture-session-secret",
  });
  const deadlineWallMs = Date.now() + sessionLifetimeMs;
  let owner;
  t.after(async () => {
    try {
      await owner?.close();
    } finally {
      await pool.end();
    }
  });
  const { agent, revision: first } = await seedSessionRevision(
    state,
    {
      driver,
      deadlineWallMs,
      bindings: [binding],
    },
    { namespaceId, createdAt: new Date().toISOString(), executionMode: "dedicated" },
  );
  // Standing is admitted on a new revision; never rewrite the first, finite admission.
  let revision = first;
  let approval;
  if (standingApproval) {
    const agentId = agent.id;
    const scope = resolveGitHubStandingApprovalScope(registry, { namespaceId, binding });
    const scopeFingerprint = repositoryApprovalFingerprint({
      namespaceId,
      agentId,
      binding,
      scope,
    });
    approval = await state.transact((u) =>
      u.repositorySessions.approveStanding({
        id: randomUUID(),
        namespaceId,
        agentId,
        binding,
        scope,
        scopeFingerprint,
        approvedBy: "prepared-git-test-operator",
        createdAt: first.createdAt,
      }),
    );
    revision = {
      ...first,
      id: `rev_${randomUUID()}`,
      revision: first.revision + 1,
      repositoryCredentials: {
        ...first.repositoryCredentials,
        standingApprovalId: approval.id,
        standingApprovalGeneration: approval.generation,
        standingApprovalScopeFingerprint: scopeFingerprint,
      },
    };
    await state.transact((u) => u.revisions.createRevision(revision));
  }
  const attempt = sessionAttempt(revision, {
    repositoryRef,
    durationSeconds: 3600,
    brokerProtocol: 3,
  });
  const socketPath = join(directory, "prepared-git-use.sock");
  const broker = await openBroker?.({
    gh,
    registry,
    socketPath,
    namespaceId,
    binding,
    pushRef,
    deadlineWallMs,
    repository: fixtureRepository,
  });
  const sessionId = broker?.opened.session.sessionId ?? `session-${randomUUID()}`;
  await state.transact(async (unit) => {
    assert.ok(
      await unit.agents.compareAndSetActiveRevision(namespaceId, agent.id, undefined, revision.id),
    );
  });
  // Use State transitions so the session and its successor have authoritative distinct admission IDs.
  const admit = (sessionId, admissionId) =>
    state.transact(async (unit) => {
      const generation = randomUUID();
      const created = await unit.repositorySessions.createAttempt({ ...attempt, admissionId });
      assert.deepEqual(created.cleanupContext, { driver, binding });
      assert.equal(created.liveRevisionId, revision.id);
      await unit.repositorySessions.createBrokerReceipt({
        admissionId,
        state: "reserved",
        generation,
      });
      assert.ok(
        await unit.repositorySessions.advanceBrokerReceipt({
          admissionId,
          expectedState: "reserved",
          generation,
          state: "active",
          sessionId,
          deadlineWallMs,
        }),
      );
      assert.ok(
        await unit.repositorySessions.advanceAttempt({
          admissionId,
          expectedPhase: "opening",
          phase: "open",
          sessionId,
          updatedAt: new Date().toISOString(),
        }),
      );
    });
  await admit(sessionId, attempt.admissionId);
  const ownerOptions = {
    pool,
    controlSocket: join(directory, "control.sock"),
    driverId,
    implementation: "github",
    backendId,
    registry,
    privateKeyPath,
    custodyKeyPath,
    apiOrigin: dnsIssuer ? gh.origin.replace("127.0.0.1", "localhost") : gh.origin,
    ca: gh.tls.ca,
    startWorker: false,
  };
  owner = await startPreparedGitHubGitOwner(ownerOptions);
  return {
    /** Another worker owner on the same database, such as one after an issuer change. */
    async startOwner(overrides) {
      // Each owner serves its use socket beside its control socket: give it its own directory.
      const sockets = await socketDirectory(t, "pgit-", { longest: "prepared-git-use.sock" });
      const other = await startPreparedGitHubGitOwner({
        ...ownerOptions,
        controlSocket: join(sockets, "control.sock"),
        ...overrides,
      });
      t.after(() => other.close());
      return other;
    },
    pool,
    broker,
    permissions,
    admitReplacement: (sessionId) => admit(sessionId, "admission-" + randomUUID()),
    state,
    agent,
    revision,
    sessionId,
    deadlineWallMs,
    gh,
    owner,
    binding,
    admissionId: attempt.admissionId,
    approval,
    registry,
    familyId: `repository-git:${attempt.admissionId}`,
    request(overrides = {}) {
      return {
        ...binding.grant,
        sessionId,
        exchangeId: randomUUID(),
        operation: "upload-pack",
        requestDigestSha256: randomBytes(32).toString("hex"),
        pushRef,
        deadlineAt: new Date(Date.now() + 20_000).toISOString(),
        ...overrides,
      };
    },
    async withdraw() {
      await state.transact(async (unit) => {
        assert.ok(
          await unit.repositorySessions.advanceAttempt({
            admissionId: attempt.admissionId,
            expectedPhase: "open",
            phase: "closing",
            updatedAt: new Date().toISOString(),
          }),
        );
      });
    },
    providerStatus(value) {
      return new Promise((resolve, reject) => {
        get(
          `${gh.origin}/repos/${fixtureRepository}`,
          {
            ca: gh.tls.ca,
            headers: { authorization: `Bearer ${value}` },
          },
          (response) => {
            response.resume();
            response.once("end", () => resolve(response.statusCode));
          },
        ).once("error", reject);
      });
    },
  };
}

export async function prepare(f) {
  // Discovery and issuance may be separate worker passes; no use request drives either.
  await f.owner.maintain();
  if (f.gh.issuesOfTokens.length === 0) {
    await f.owner.maintain();
  }
  assert.equal(f.gh.issuesOfTokens.length, 1, "open OCC admission must prepare exactly one token");
  assert.deepEqual(f.gh.issuesOfTokens[0].permissions, f.permissions);
  assert.deepEqual(f.gh.issuesOfTokens[0].repositoryIds.map(String), [String(fixtureRepositoryId)]);
}
