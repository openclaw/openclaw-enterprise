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
import { openShellGitRecipientEvidence } from "../../apps/controller/src/drivers/repo/credentials/protected-repository-git-installation.ts";
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
    tokenLifetimeMs = /** @type {number | undefined} */ (undefined),
    /** The first owner's clock argument; undefined starts it as the worker does. */
    ownerClock = /** @type {import("../../apps/controller/src/drivers/repo/credentials/backend-contracts.ts").Clock | undefined} */ (
      undefined
    ),
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
    ...(tokenLifetimeMs && { tokenLifetimeMs }),
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
  owner = await startPreparedGitHubGitOwner(ownerOptions, ownerClock);
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
    socketPath,
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

/** The controlled Credential Proxy selection that protected versions in these tests name. */
export const controlledProtectedDriver = Object.freeze({
  id: "controlled",
  implementation: "openshell",
  configurationId: "d".repeat(64),
});

/** Another worker owner that serves protected (Credential Proxy) Git for that selection. */
export function startProtectedOwner(f, overrides = {}) {
  return f.startOwner({
    controlSocket: undefined,
    protectedGitDriver: controlledProtectedDriver,
    protectedGitEvidence: openShellGitRecipientEvidence,
    ...overrides,
  });
}

/**
 * Deploy a protected version after `previous`, with one open repository session and the
 * released OpenShell Git recipient of its Sandbox. The installation and the delivery receipt
 * are controlled evidence; the standing transfer test exercises the real release.
 */
export async function admitProtectedVersion(f, previous = f.revision) {
  const { namespaceId, agentId, servicePrincipalId, repositoryCredentials } = previous;
  const driver = controlledProtectedDriver;
  const revisionId = "rev_" + randomUUID();
  const sessionId = randomUUID();
  const admissionId = randomUUID();
  const executionId = randomUUID().replaceAll("-", "");
  const plan = {
    id: "migration-proof",
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
    sandboxDriverId: "controlled",
    egressDriverId: "controlled",
    routes: [],
    repositoryGit: repositoryCredentials,
  };
  const attempt = {
    namespaceId,
    agentId,
    revisionId,
    admissionId,
    repositoryRef: "source",
    durationSeconds: 3600,
    deadlineWallMs: f.deadlineWallMs,
    createdAt: new Date().toISOString(),
    brokerProtocol: /** @type {const} */ (2),
  };
  const revision = {
    ...previous,
    id: revisionId,
    revision: previous.revision + 1,
    executionAdmission: { version: 4, mode: "protected" },
    egressPlan: plan,
  };
  await f.state.transact(async (u) => {
    await u.revisions.createRevision(revision);
    assert.ok(
      await u.agents.compareAndSetActiveRevision(namespaceId, agentId, previous.id, revisionId),
    );
    await u.repositorySessions.createAttempt(attempt);
    await u.repositorySessions.advanceAttempt({
      admissionId,
      expectedPhase: "opening",
      phase: "open",
      sessionId,
      updatedAt: attempt.createdAt,
    });
  });
  const providerId = "controlled-provider";
  const policyHash = "controlled-policy";
  const sandboxId = "controlled-box-" + randomUUID();
  const observed = {
    workspace: "w",
    sandbox: "s",
    sandboxId,
    executionId: revisionId,
    provider: "p",
    providerId,
    providerResourceVersion: "1",
    profileVersion: "1",
    credentialState: "active",
    attachmentEpoch: "e",
    providerEnvRevision: "1",
    configRevision: "1",
    policyHash,
    supervisorSessionId: "s",
    processInstanceId: "p",
    networkInstanceId: "n",
  };
  await f.state.transact((u) =>
    u.credentialSources.recordEgressInstallation({
      plan,
      sandboxId,
      sender: { id: "sender", generation: 1 },
      installedAt: attempt.createdAt,
      enforcement: {
        policyHash,
        instanceId: "released-supervisor-A",
        repositoryGitRecipient: {
          providerId,
          attachmentEpoch: observed.attachmentEpoch,
          processInstanceId: observed.processInstanceId,
          networkInstanceId: observed.networkInstanceId,
        },
        configurationId: "c",
        authorityScope: "execution",
        peerKeyId: "fixture",
      },
    }),
  );
  // Match the OpenShell delivery owner's snapshot receipt, tied to this live revision.
  await f.pool.query(
    `insert into occ.credential_deliveries
    (revision_id,live_revision_id,settlement,namespace_id,agent_id,target,binding_id,worker_instance,desired,observed)
    values($1,$1,'snapshot',$2,$3,'{"transport":"openshell-repository-git/v1","workspace":"w","sandbox":"s"}',$4,$5,
      jsonb_build_object('credentialState','bootstrap','providerId',$6::text,'profileVersion','1','resourceVersion','1','expiresAt',''),$7)`,
    [
      revisionId,
      namespaceId,
      agentId,
      executionId,
      randomUUID(),
      providerId,
      JSON.stringify(observed),
    ],
  );
  return {
    revision,
    revisionId,
    sessionId,
    admissionId,
    executionId,
    plan,
    attempt,
    observed,
    route: { revisionId, fence: 1, observed },
    familyId: `repository-git:${admissionId}`,
  };
}

/** End a protected version's repository session, as the worker does once its version is replaced. */
export async function disposeProtectedSession(f, version) {
  const updatedAt = new Date().toISOString();
  await f.state.transact(async (u) => {
    for (const [expectedPhase, phase] of [
      ["open", "closing"],
      ["closing", "disposed"],
    ]) {
      assert.ok(
        await u.repositorySessions.advanceAttempt({
          admissionId: version.admissionId,
          expectedPhase,
          phase,
          updatedAt,
        }),
      );
    }
  });
}

/** Close and dispose the fixture's broker session, as its broker does after replacement. */
export async function disposeBrokerSession(f, updatedAt = new Date().toISOString()) {
  await f.withdraw();
  const at = { admissionId: f.admissionId, updatedAt };
  await f.state.transact(async (u) => {
    const sessions = u.repositorySessions;
    const receipt = await sessions.findBrokerReceipt(f.admissionId);
    await sessions.advanceBrokerReceipt({
      ...at,
      generation: receipt.generation,
      sessionId: f.sessionId,
      deadlineWallMs: f.deadlineWallMs,
      revoked: 0,
      expired: 0,
      expectedState: "active",
      state: "disposed",
    });
    await sessions.advanceAttempt({ ...at, expectedPhase: "closing", phase: "disposed" });
  });
}
