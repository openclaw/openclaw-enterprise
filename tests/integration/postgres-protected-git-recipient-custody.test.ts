import { jointWorker, connectJointMiddleware } from "../helpers/openshell-joint-worker.ts";
import { invoke, token } from "../helpers/openshell-online-wire.mjs";
import { redeem } from "../helpers/openshell-git-token-grant.mjs";
import { exerciseProjectedTokenGrant } from "../helpers/openshell-projected-token-fixture.mjs";
import { exerciseGitTokenGrant } from "../helpers/openshell-git-token-grant.mjs";
import assert from "node:assert/strict";
import { randomUUID, sign } from "node:crypto";
import test from "node:test";
import { openShellGitRecipientEvidence } from "../../apps/controller/src/drivers/repo/credentials/protected-repository-git-installation.ts";
import { PostgresOpenShellGitRouteStore } from "../../apps/controller/src/drivers/egress-proxy/openshell-git-route-store.ts";
import { CredentialDeliveries } from "../../packages/occ/src/index.ts";
import type {
  AdmittedRepositoryBinding,
  AgentRevision,
  DriverRegistrationRef,
  PreparedGitHubUseRequest,
} from "../../packages/contracts/src/index.ts";
import { resolveGitHubRepositoryBinding } from "../../apps/controller/src/drivers/repo/github/credentials/registry.ts";
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
    const otherDriver = { ...driver, configurationId: "a".repeat(64) };
    const other = await protectedOwner({ protectedGitDriver: otherDriver });
    const legacy = await f.startOwner({ controlSocket: undefined });
    const mine = owner.protectedGit!;
    const notMine = other.protectedGit!;
    await disposeNativeSession(f);
    const { installation, sessionId, admissionId } = await admitProtectedSession(
      f,
      driver,
      f.binding,
    );
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
    const installationOnly = mine.githubInstallation!;
    assert.deepEqual(
      await installationOnly.readMaterial(route, t.signal),
      { absent: "unprepared" },
      "a live repository-scoped credential cannot be installed as installation access",
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
    const deliveryKey = {
      revisionId: route.revisionId,
      bindingId: installation.plan.execution.executionId,
    };
    const deliveryReceipt = async () =>
      (
        await f.pool.query(
          "SELECT operation_fence,fence,write_pending FROM occ.credential_deliveries WHERE revision_id=$1 AND binding_id=$2",
          [deliveryKey.revisionId, deliveryKey.bindingId],
        )
      ).rows[0];
    const originalOperation = await deliveryReceipt();
    const client = await f.pool.connect();
    try {
      const deliveries = new CredentialDeliveries(client);
      assert.equal(
        await deliveries.record(deliveryKey, pending.fence, {
          desired: {},
          observed: installation,
          material: version,
        }),
        false,
        "a snapshot cannot impersonate independent recipient confirmation",
      );
      assert.equal(
        await deliveries.cancelWriting(deliveryKey, pending.fence),
        false,
        "the snapshot cancellation path cannot release a registered installation",
      );
      await deliveries.adopt(deliveryKey, randomUUID());
    } finally {
      client.release();
    }
    const replacementLease = await deliveryReceipt();
    assert.equal(replacementLease.operation_fence, originalOperation.operation_fence);
    assert.notEqual(replacementLease.fence, originalOperation.fence);
    assert.equal(
      await mine.recipients.confirmInstall({ ...pending, materialVersion: randomUUID() }),
      undefined,
      "unrelated C cannot settle the original B operation",
    );
    assert.equal(
      await mine.recipients.confirmInstall({
        ...pending,
        observed: {
          ...installation,
          sandboxId: "different-recipient",
        },
      }),
      undefined,
      "readback from another recipient cannot settle B",
    );
    assert.equal(
      await mine.recipients.confirmInstall({ ...pending, fence: Number(replacementLease.fence) }),
      undefined,
      "the replacement lease is not the consumed operation identity",
    );

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
    assert.equal((await f.pool.query("SELECT current_user")).rows[0].current_user, "occ_app");
    await assert.rejects(
      f.pool.query(
        "UPDATE occ.prepared_github_families SET source = jsonb_set(source, '{session,credentialProxyExecution,driver}', $2::jsonb) WHERE source_id = $1",
        [familyId, JSON.stringify(otherDriver)],
      ),
      { code: "42501" },
      "the application role cannot rewrite the protected owner's identity",
    );
    const inspect = () => owner.inspectTokenAttempt(familyId, preparationAttemptId);
    assert.equal((await inspect())?.custody, "current");
    assert.equal(await other.inspectTokenAttempt(familyId, preparationAttemptId), undefined);
    assert.equal(await notMine.recipients.confirmInstall(pending), undefined);
    const installedRoute = await mine.recipients.confirmInstall(pending);
    assert.ok(installedRoute);
    assert.equal(installedRoute.fence, Number(replacementLease.fence));
    assert.equal((await deliveryReceipt()).write_pending, null);
    const installed = { route: installedRoute, ...version };
    const denied = await notMine.readMaterial(installedRoute, t.signal);
    assert.deepEqual(
      denied,
      { absent: "unprepared" },
      "unknown is neither material nor proof of withdrawal",
    );
    const unavailable = { kind: "denied", reason: "unavailable" };
    assert.deepEqual(await notMine.authorize(request(), installed, t.signal), unavailable);
    const { repositoryId: _repository, pushRef: _ref, ...identity } = request();
    assert.deepEqual(
      await installationOnly.authorize(
        {
          ...identity,
          scope: "github-installation",
          installationId: "4545",
          operation: "github-graphql",
        },
        installed,
        t.signal,
      ),
      unavailable,
      "the installed repository credential cannot authorize an installation API request",
    );
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
    await f.owner.maintain();
    assert.equal(revocations(), 0);
    assert.equal((await inspect())?.custody, "retire");
    await owner.maintain();
    await owner.maintain();
    assert.equal(revocations(), 1);
    assert.equal((await inspect())?.custody, "revoked");
  },
);

test(
  "changing between repository and installation scope waits for the previous owner to settle its token",
  requiresPostgres,
  async (t) => {
    const f = await fixture(t, { installationAccess: true });
    const prior = f.revision as AgentRevision;
    const { namespaceId, agentId } = prior;
    const providerWrites = () =>
      f.gh.trace
        .filter((r: { method: string }) => r.method === "POST" || r.method === "DELETE")
        .map((r: { method: string }) => r.method);
    await f.owner.maintain();
    assert.deepEqual(providerWrites(), ["POST"]);
    const repositoryRef = "team-install";
    const profile = "github-installation";
    const binding = resolveGitHubRepositoryBinding(f.registry, {
      namespaceId,
      repositoryRef,
      profile,
    });
    assert.notEqual(repositoryRef, f.binding.repositoryRef, "the two selection names are distinct");
    const driver = {
      id: "scope-successor",
      implementation: "custody-fixture",
      configurationId: "a".repeat(64),
    };
    const owner = await f.startOwner({ controlSocket: undefined, protectedGitDriver: driver });
    const host = owner.protectedGit!;
    const { installation, admissionId, revisionId } = await admitProtectedSession(
      f,
      driver,
      binding,
    );
    const route = await host.recipients.observe(installation);
    assert.ok(route);
    const onlyNarrowIssued = ["POST"];
    await owner.maintain();
    assert.deepEqual(
      providerWrites(),
      onlyNarrowIssued,
      "a different selection cannot bypass an open predecessor",
    );
    await disposeNativeSession(f);
    await owner.maintain();
    assert.deepEqual(
      providerWrites(),
      onlyNarrowIssued,
      "a disposed narrow session still has a live token; the new owner cannot revoke it or issue",
    );
    await f.owner.maintain();
    assert.deepEqual(
      providerWrites(),
      ["POST", "DELETE"],
      "the narrow owner retires its own token",
    );
    await owner.maintain();
    const wideIssued = ["POST", "DELETE", "POST"];
    assert.deepEqual(providerWrites(), wideIssued);
    const read = await host.githubInstallation!.readMaterial(route, t.signal);
    assert.ok(read && "value" in read);
    assert.deepEqual(
      await host.readMaterial(route, t.signal),
      { absent: "unprepared" },
      "the narrow sender cannot get the wide token",
    );
    // Deliberately lose the installation confirmation. Only provider retirement can settle the token;
    // changing the Agent's binding and disposing its session cannot adopt or replay that installation.
    const { preparationAttemptId, materialVersion } = read;
    const pending = await host.recipients.beginInstall(route, {
      preparationAttemptId,
      materialVersion,
    });
    assert.ok(pending);
    assert.equal(await host.recipients.observe(installation), undefined);
    await f.state.transact(async (u) => {
      await u.agents.updateConfiguration(
        namespaceId,
        agentId,
        prior.configurationId,
        undefined,
        undefined,
        undefined,
        undefined,
        [{ repositoryRef: f.binding.repositoryRef, profile: f.binding.profile }],
      );
      assert.ok(
        await u.agents.compareAndSetActiveRevision(namespaceId, agentId, revisionId, prior.id),
      );
      for (const [expectedPhase, phase] of [
        ["open", "closing"],
        ["closing", "disposed"],
      ] as const) {
        await u.repositorySessions.advanceAttempt({
          admissionId,
          expectedPhase,
          phase,
          updatedAt: new Date().toISOString(),
        });
      }
    });
    // The delayed authenticated readback settles history after withdrawal, without
    // changing the live Agent or authorizing another provider request.
    const settled = await host.recipients.confirmInstall(pending);
    assert.ok(settled);
    assert.deepEqual(await host.githubInstallation!.readMaterial(settled, t.signal), {
      absent: "withdrawn",
    });
    assert.equal(
      await host.recipients.beginInstall(settled, { preparationAttemptId, materialVersion }),
      undefined,
    );
    assert.deepEqual(providerWrites(), wideIssued);
    await f.admitReplacement(randomUUID());
    await f.owner.maintain();
    assert.deepEqual(
      providerWrites(),
      wideIssued,
      "return to narrow cannot adopt, retire or ignore the installation token",
    );
    await owner.maintain();
    assert.deepEqual(
      providerWrites(),
      [...wideIssued, "DELETE"],
      "the installation owner settles its own provider token",
    );
    await f.owner.maintain();
    assert.deepEqual(
      providerWrites(),
      [...wideIssued, "DELETE", "POST"],
      "only then may the narrow issuer mint again",
    );
    assert.deepEqual(
      f.gh.issuesOfTokens.map((i: { repositoryIds: number[] | "installation" }) => i.repositoryIds),
      [
        [Number(f.binding.grant.repositoryId)],
        "installation",
        [Number(f.binding.grant.repositoryId)],
      ],
    );
  },
);

test(
  "OpenShell custody requires the current fence and the actually observed material generation",
  requiresPostgres,
  async (t) => {
    const f = await fixture(t);
    await disposeNativeSession(f);
    const driver = {
      id: "openshell-custody",
      implementation: "openshell",
      configurationId: "c".repeat(64),
    };
    const { installation, revisionId } = await admitProtectedSession(f, driver, f.binding);
    const routes = new PostgresOpenShellGitRouteStore(f.pool);
    await routes.open(
      {
        revisionId,
        namespaceId: f.revision.namespaceId,
        agentId: f.revision.agentId,
        bindingId: installation.plan.execution.executionId,
        workspace: "team",
        sandbox: "git",
      },
      randomUUID(),
    );
    const observed = {
      ...installation.enforcement.repositoryGitRecipient,
      workspace: "team",
      sandbox: "git",
      sandboxId: installation.sandboxId,
      executionId: revisionId,
      provider: "oce-git-" + "a".repeat(32),
      providerResourceVersion: "1",
      profileVersion: "1",
      credentialState: "bootstrap" as const,
      providerEnvRevision: "1",
      configRevision: "1",
      policyHash: installation.enforcement.policyHash,
      supervisorSessionId: "session",
    };
    const generation = {
      providerId: observed.providerId,
      resourceVersion: "1",
      profileVersion: "1",
      credentialState: "bootstrap" as const,
      expiresAt: "",
    };
    assert.equal(
      await routes.record(revisionId, 1, { generation, observed, material: undefined }),
      true,
    );
    const eligible = async (
      kind: "observed" | "installed",
      fence: number,
      observation: object,
      material?: { preparationAttemptId: string; materialVersion: string },
    ) => {
      const args = [
        revisionId,
        fence,
        JSON.stringify(observation),
        ...(material ? [material.preparationAttemptId, material.materialVersion] : []),
      ];
      const { rows } = await f.pool.query(
        `SELECT EXISTS (${openShellGitRecipientEvidence[kind]}) AS allowed`,
        args,
      );
      return rows[0].allowed;
    };
    const owner = await f.startOwner({
      controlSocket: undefined,
      protectedGitDriver: driver,
      protectedGitEvidence: openShellGitRecipientEvidence,
    });
    await owner.maintain();
    const selectedRoute = { revisionId, fence: 1, observed };
    const selected = await owner.readOpenShellMaterial(revisionId, t.signal, selectedRoute);
    assert.ok(
      selected && !("absent" in selected),
      "the real prepared owner selects committed material",
    );
    const a = {
      preparationAttemptId: selected.preparationAttemptId,
      materialVersion: selected.materialVersion,
    };
    assert.equal(await routes.writing(revisionId, 1, "rotate", a), 2);
    assert.deepEqual(
      await owner.readOpenShellMaterial(revisionId, t.signal, selectedRoute),
      { absent: "unprepared" },
      "the real custody reader refuses the pre-reservation fence",
    );
    assert.deepEqual(
      await owner.readOpenShellMaterial(revisionId, t.signal, { ...selectedRoute, fence: 2 }),
      selected,
      "the real custody reader preserves the material and recipient at the reservation fence",
    );
    const active = {
      ...observed,
      credentialState: "active" as const,
      providerResourceVersion: "2",
    };
    const activeGeneration = {
      ...generation,
      credentialState: "active" as const,
      resourceVersion: "2",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
    assert.equal(
      await routes.record(revisionId, 2, {
        generation: activeGeneration,
        observed: active,
        material: a,
      }),
      true,
    );
    assert.equal(await eligible("installed", 2, active, a), true);
    const b = { preparationAttemptId: randomUUID(), materialVersion: randomUUID() };
    assert.equal(await routes.writing(revisionId, 2, "rotate", b), 3);
    // The write of B is acknowledged before its supervisor observation arrives. A is still
    // the genuine observed recipient; it cannot attest installation of B's new generation.
    const next = { ...activeGeneration, resourceVersion: "3" };
    assert.equal(
      await routes.record(revisionId, 3, { generation: next, observed: active, material: b }),
      true,
    );
    assert.equal(await eligible("observed", 3, active), true);
    assert.equal(
      await eligible("installed", 3, active, b),
      false,
      "old provider generation cannot authorize current material",
    );
    const wrongProfile = { ...active, providerResourceVersion: "3", profileVersion: "2" };
    assert.equal(
      await routes.record(revisionId, 3, { generation: next, observed: wrongProfile, material: b }),
      true,
    );
    assert.equal(
      await eligible("installed", 3, wrongProfile, b),
      false,
      "old or different profile cannot authorize current material",
    );
    const current = { ...active, providerResourceVersion: "3" };
    assert.equal(
      await routes.record(revisionId, 3, { generation: next, observed: current, material: b }),
      true,
    );
    assert.equal(await eligible("installed", 3, current, b), true);
  },
);

test(
  "projected TokenReview and current supervisor Pod must agree before claim and disclosure",
  exerciseProjectedTokenGrant,
);

test(
  "signed Git request and authenticated issuer release current installation custody",
  requiresPostgres,
  async (t) => {
    const f = await fixture(t, { installationAccess: true });
    await disposeNativeSession(f);
    const driver = {
      id: "grant-sender",
      implementation: "openshell",
      configurationId: "b".repeat(64),
    };
    const grant = resolveGitHubRepositoryBinding(f.registry, {
      namespaceId: f.revision.namespaceId,
      repositoryRef: "team-install",
      profile: "github-installation",
    });
    const { installation, admissionId, revisionId, sessionId } = await admitProtectedSession(
      f,
      driver,
      grant,
      true,
    );
    const owner = await f.startOwner({ controlSocket: undefined, protectedGitDriver: driver });
    const host = owner.protectedGit!;
    const initial = await host.recipients.observe(installation);
    assert.ok(initial);
    await owner.maintain();
    const {
      rows: [version],
    } = await f.pool.query(
      "SELECT id AS \"preparationAttemptId\", material_version AS \"materialVersion\" FROM occ.prepared_github_attempts WHERE custody='current' AND source_id IN (SELECT source_id FROM occ.prepared_github_families WHERE source #>> '{session,revisionId}'=$1)",
      [revisionId],
    );
    assert.ok(version);
    const reserved = await host.recipients.beginInstall(initial, version);
    assert.ok(reserved);
    const route = await host.recipients.confirmInstall(reserved);
    assert.ok(route);
    const selected = host.online.githubInstallation!;
    const binding = {
      executionId: revisionId,
      scope: "github-installation",
      installationId: f.registry.githubInstallationId,
      sessionId,
      grantId: grant.grant.grantId,
      providerInstanceId: grant.grant.providerInstanceId,
      apiOrigin: "https://api.github.com",
      installed: { route, ...version },
    };
    await exerciseGitTokenGrant(t, {
      f,
      binding,
      installation,
      authorize: (q: Parameters<typeof selected.authorize>[0], signal: AbortSignal) =>
        selected.authorize(q, binding.installed, signal),
      current: async (signal: AbortSignal) => {
        const receipt = await owner.readOpenShellReceipt(route, signal);
        if (!receipt || "absent" in receipt) {
          return false;
        }
        assert.equal("value" in receipt, false);
        return (
          receipt.preparationAttemptId === binding.installed.preparationAttemptId &&
          receipt.materialVersion === binding.installed.materialVersion &&
          receipt.sessionId === binding.sessionId &&
          receipt.grantId === binding.grantId
        );
      },
      read: (signal: AbortSignal) => selected.readMaterial(route, signal),
      withdraw: () =>
        f.state.transact((u) =>
          u.repositorySessions.advanceAttempt({
            admissionId,
            expectedPhase: "open",
            phase: "closing",
            updatedAt: new Date().toISOString(),
          }),
        ),
    });
  },
);

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function disposeNativeSession(f: Fixture) {
  await f.withdraw();
  await f.state.transact(async (u) => {
    const sessions = u.repositorySessions;
    const prior = (await sessions.findBrokerReceipt(f.admissionId))!;
    const old = { admissionId: f.admissionId, updatedAt: new Date().toISOString() };
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
  });
}

async function admitProtectedSession(
  f: Fixture,
  driver: DriverRegistrationRef,
  binding: AdmittedRepositoryBinding,
  online = false,
) {
  const { namespaceId, agentId, servicePrincipalId, repositoryCredentials } =
    f.revision as AgentRevision;
  const admissionId = randomUUID();
  const sessionId = randomUUID();
  const revisionId = "rev_" + randomUUID();
  const executionId = randomUUID().replaceAll("-", "");
  const createdAt = new Date().toISOString();
  const plan = {
    id: "custody-proof",
    ...(online && { repositoryGitAuthorization: "online-request" as const }),
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
    repositoryGit: { ...repositoryCredentials!, bindings: [binding] },
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
      ...(!online && { peerKeyId: "authenticated-test-peer" }),
      repositoryGitRecipient: {
        ...(online && { authorization: "online-request" as const }),
        providerId: "provider",
        attachmentEpoch: "epoch",
        processInstanceId: "process",
        networkInstanceId: "net",
        ...(binding.profile === "github-installation" && {
          deliveryProfile: "github_installation" as const,
        }),
      },
    },
  };
  await f.state.transact(async (u) => {
    const sessions = u.repositorySessions;
    const { repositoryRef, profile } = binding;
    await u.agents.updateConfiguration(
      namespaceId,
      agentId,
      f.revision.configurationId,
      undefined,
      undefined,
      undefined,
      undefined,
      [{ repositoryRef, profile }],
    );
    await u.revisions.createRevision({
      ...(f.revision as AgentRevision),
      id: revisionId,
      revision: f.revision.revision + 1,
      executionAdmission: { version: online ? 5 : 4, mode: "protected" },
      egressPlan: plan,
      repositoryCredentials: plan.repositoryGit,
    });
    assert.ok(
      await u.agents.compareAndSetActiveRevision(namespaceId, agentId, f.revision.id, revisionId),
    );
    await sessions.createAttempt({
      namespaceId,
      agentId,
      revisionId,
      admissionId,
      repositoryRef,
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
  return { installation, sessionId, admissionId, revisionId };
}

test(
  "the prepared owner cannot mint for an unbound pair of GitHub recipients",
  requiresPostgres,
  async (t) => {
    const f = await fixture(t, { installationAccess: true });
    await disposeNativeSession(f);
    const driver = {
      id: "joint-custody",
      implementation: "openshell",
      configurationId: "d".repeat(64),
    };
    const binding = resolveGitHubRepositoryBinding(f.registry, {
      namespaceId: f.revision.namespaceId,
      repositoryRef: "team-install",
      profile: "github-installation",
    });
    const owner = await f.startOwner({
      protectedGitDriver: driver,
      protectedGitEvidence: openShellGitRecipientEvidence,
      controlSocket: undefined,
    });
    const { revisionId, installation } = await admitProtectedSession(f, driver, binding);
    const store = new PostgresOpenShellGitRouteStore(f.pool);
    const e = installation.plan.execution;
    await store.open(
      {
        revisionId,
        namespaceId: e.namespaceId,
        agentId: e.agentId,
        bindingId: e.executionId,
        workspace: "test",
        sandbox: "test",
      },
      randomUUID(),
    );
    const db = await f.pool.connect();
    try {
      // A session and two named provider objects do not constitute a released joint
      // execution. The actual credential family discovery must not contact the issuer.
      const key = { revisionId, bindingId: e.executionId };
      const recipients = ["github.com", "api.github.com"].map((host) => ({
        host,
        providerName: randomUUID(),
        providerId: randomUUID(),
        attachmentEpoch: randomUUID(),
      }));
      const grant = { id: binding.grant.grantId, generation: "9", scope: "e".repeat(64) };
      const deliveries = new CredentialDeliveries(db);
      assert.equal(
        await deliveries.record(key, 1, {
          desired: { grant, recipients },
          observed: {
            sandboxId: installation.sandboxId,
            wiring: { grant, recipients, runtimeProvider: "test-files" },
          },
        }),
        true,
      );
      await owner.maintain();
      assert.equal(
        f.gh.issuesOfTokens.length,
        0,
        "unbound provider objects cannot trigger issuance",
      );
      assert.deepEqual(
        await owner.protectedGit!.online.githubInstallation!.readMaterial(
          { revisionId, fence: 1, observed: { grant, recipients } },
          t.signal,
        ),
        { absent: "unprepared" },
      );
    } finally {
      db.release();
    }
  },
);

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

for (const host of ["github.com", "api.github.com", "standing"] as const) {
  test(
    host === "standing"
      ? "the registered joint Sandbox captures its standing execution and a cold worker can only confirm it"
      : "the registered worker refuses held Git material after observing a replaced supervisor: " +
          host,
    requiresPostgres,
    async (t) => {
      const standingApproval = host === "standing";
      const f = await fixture(t, {
        installationAccess: true,
        standingApproval,
        grantGeneration: standingApproval ? undefined : 7,
      });
      await disposeNativeSession(f);
      const driver = {
        id: "sandbox-compat",
        implementation: "openshell",
        configurationId: "d".repeat(64),
      };
      const w = await jointWorker(t, {
        registry: f.registry,
        revision: f.revision as AgentRevision,
        driver,
      });
      const { binding } = w;
      async function admit(revision: AgentRevision, previousId: string) {
        const { namespaceId, agentId } = revision;
        const sessionId = randomUUID();
        const admissionId = randomUUID();
        const createdAt = new Date().toISOString();
        await f.state.transact(async (u) => {
          await u.agents.updateConfiguration(
            namespaceId,
            agentId,
            f.revision.configurationId,
            undefined,
            undefined,
            undefined,
            undefined,
            [{ repositoryRef: binding.repositoryRef, profile: binding.profile }],
          );
          await u.revisions.createRevision(revision);
          assert.ok(
            await u.agents.compareAndSetActiveRevision(
              namespaceId,
              agentId,
              previousId,
              revision.id,
            ),
          );
          await u.repositorySessions.createAttempt({
            namespaceId,
            agentId,
            revisionId: revision.id,
            admissionId,
            repositoryRef: binding.repositoryRef,
            durationSeconds: 600,
            deadlineWallMs: revision.repositoryCredentials!.deadlineWallMs,
            createdAt,
            brokerProtocol: 2,
          });
          await u.repositorySessions.advanceAttempt({
            admissionId,
            expectedPhase: "opening",
            phase: "open",
            sessionId,
            updatedAt: createdAt,
          });
        });
        return admissionId;
      }
      const admissionId = await admit(w.revision, f.revision.id);
      const owner = await f.startOwner({
        controlSocket: undefined,
        protectedGitDriver: driver,
        protectedGitEvidence: openShellGitRecipientEvidence,
      });
      const release = gate();
      const entered = gate();
      let hold = false;
      let reads = 0;
      const selected = owner.protectedGit!.online.githubInstallation!;
      const read = selected.readMaterial;
      let afterApproval: (() => Promise<void>) | undefined;
      const custody = {
        ...owner,
        protectedGit: {
          ...owner.protectedGit!,
          online: {
            ...owner.protectedGit!.online,
            githubInstallation: {
              ...selected,
              authorize: async (...args: Parameters<typeof selected.authorize>) => {
                const result = await selected.authorize(...args);
                if (result.kind === "allow") {
                  await afterApproval?.();
                }
                return result;
              },
              readMaterial: async (...args: Parameters<typeof read>) => {
                const material = await read(...args);
                reads++;
                return material;
              },
            },
          },
        },
        readOpenShellReceipt: async (...args: Parameters<typeof owner.readOpenShellReceipt>) => {
          const receipt = await owner.readOpenShellReceipt(...args);
          if (hold && reads === 2) {
            hold = false;
            entered.open();
            await release.promise;
          }
          if (!receipt || "absent" in receipt) {
            return receipt;
          }
          // Present the loopback App peer under the GitHub destination the supervisor requests.
          assert.equal(receipt.apiOrigin, f.gh.origin);
          return { ...receipt, apiOrigin: "https://api.github.com" };
        },
      };
      assert.ok(w.capabilities.repositoryTransport && w.capabilities.proxy);
      // The supplier is a controlled peer in this worker test; the worker itself installs its
      // production PostgreSQL route, authorization, Pod and material callbacks.
      let signerCurrent = true;
      w.capabilities.proxy.verifyInstallation = async (_ctx, installation) =>
        signerCurrent && installation.sandboxId === w.peer.sandboxId;
      await w.capabilities.repositoryTransport.bind(custody, f.pool);
      async function releaseInstallation(
        version: ReturnType<typeof w.version>,
        expectedIssues: number,
      ) {
        const box = await w.provision(version);
        const wiring = box.proxyWiring;
        assert.ok(wiring && "jointGit" in wiring && wiring.jointGit);
        const [runtimeProvider, ...names] = w.peer.sandbox!.spec.providers;
        const recipients = names.map((name, i) => ({
          host: i === 0 ? "github.com" : "api.github.com",
          providerId: w.peer.providers.get(name)!.metadata.id,
          providerName: name,
          attachmentEpoch: w.peer.epoch,
        }));
        const git = { ...wiring.jointGit.grant, recipient: "git" };
        const installation = {
          plan: version.plan,
          sandboxId: w.peer.sandboxId,
          sender: { id: driver.id, generation: 1 },
          installedAt: new Date().toISOString(),
          enforcement: {
            peerKeyId: "fixture-admitted-signer",
            instanceId: "fixture-supervisor",
            configurationId: "fixture-config",
            policyHash: "b".repeat(64),
            authorityScope: "execution" as const,
            joint: {
              git,
              model: { ...git, id: "model", recipient: "model" },
              ownerEvidence: {
                runtimeProvider,
                recipients: recipients.map((r) => ({
                  host: r.host,
                  provider_id: r.providerId,
                  provider_name: r.providerName,
                  attachment_epoch: r.attachmentEpoch,
                })),
              },
            },
            repositoryGitRecipient: {
              authorization: "online-request" as const,
              providerId: recipients[0]!.providerId,
              attachmentEpoch: recipients[0]!.attachmentEpoch,
              processInstanceId: "fixture-process",
              networkInstanceId: "fixture-network",
              deliveryProfile: "github_installation" as const,
            },
          },
        };
        await f.state.transact((u) => u.credentialSources.recordEgressInstallation(installation));
        if (expectedIssues) {
          await owner.maintain();
        }
        assert.equal(
          f.gh.issuesOfTokens.length,
          expectedIssues,
          "the released execution has prepared installation custody",
        );
      }
      await releaseInstallation(w, standingApproval ? 0 : 1);
      if (host === "standing") {
        const { revision } = w;
        const ctx = w.context(revision);
        const delivery = async () =>
          (
            await f.pool.query(
              "SELECT to_jsonb(r) AS route FROM occ.credential_deliveries r WHERE revision_id = $1",
              [revision.id],
            )
          ).rows[0].route;
        const original = await delivery();
        signerCurrent = false;
        assert.equal(
          await w.capabilities.sandbox.repositoryAccess!.verifyExecution(ctx),
          undefined,
          "a matching delivery and Pod alone cannot witness a changed installation",
        );
        signerCurrent = true;
        const identity = await w.capabilities.sandbox.repositoryAccess!.verifyExecution(ctx);
        assert.ok(identity, "the admitting worker can capture the released joint execution");
        assert.equal(identity.executionId, revision.id);

        // Stop the admitting worker before starting a fresh registration on its listener ports.
        // The Gateway and the observed Sandbox, supervisor Pod and recipients all stay in place.
        await w.capabilities.close();
        const cold = w.register();
        t.after(() => cold.close());
        cold.proxy!.verifyInstallation = w.capabilities.proxy.verifyInstallation;
        await cold.repositoryTransport!.bind(custody, f.pool);
        const verify = () => cold.sandbox.repositoryAccess!.verifyExecution(ctx);
        assert.equal(await verify(), undefined, "a cold worker cannot establish the first witness");
        const ref = {
          namespaceId: revision.namespaceId,
          agentId: revision.agentId,
          revisionId: revision.id,
        };
        await f.state.transact((u) => u.repositorySessions.recordStandingExecution(ref, identity));
        const recipient = w.peer.providers.get(original.desired.recipients[0].providerName)!;
        const version = recipient.metadata.resource_version;
        recipient.metadata.resource_version = version + "0";
        assert.equal(
          await verify(),
          undefined,
          "cold verification rejects a changed provider version",
        );
        recipient.metadata.resource_version = version;
        assert.deepEqual(await verify(), identity, "the cold worker confirms the saved execution");
        w.pod.uid = randomUUID();
        assert.equal(
          await verify(),
          undefined,
          "a replacement Pod cannot inherit standing approval",
        );
        assert.deepEqual(
          await delivery(),
          original,
          "verification neither takes the fence nor changes custody",
        );
        assert.equal(reads, 0, "no material read for execution verification");
        assert.equal(f.gh.issuesOfTokens.length, 0, "no issuance for execution verification");
        return;
      }
      const rpc = connectJointMiddleware(t, w);
      const decision = async (id: string, bindingId = w.execution.executionId) => {
        const result = await invoke(
          rpc,
          "EvaluateHttpRequest",
          {
            phase: 1,
            middleware_name: "fixture-installation",
            context: {
              workspace: [...w.peer.providers.values()][0]!.metadata.workspace,
              request_id: id,
              sandbox_id: w.peer.sandboxId,
            },
            config: { fields: { binding_id: { stringValue: bindingId } } },
            target: {
              scheme: "https",
              port: 443,
              host,
              method: "GET",
              path:
                host === "github.com"
                  ? "/fixture/repository.git/info/refs"
                  : "/repos/fixture/repository",
              query: host === "github.com" ? "service=git-upload-pack" : "",
            },
            headers: [],
          },
          token(w.keys, "supervisor", w.peer.sandboxId),
        );
        return result.decision;
      };
      const assertion = (uid: string) => {
        const enc = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
        const msg =
          enc({ alg: "EdDSA", kid: "test-only" }) +
          "." +
          enc({
            aud: w.endpoint,
            sub: "spiffe://test.invalid/supervisor/" + w.peer.sandboxId + "/pod/" + uid,
            exp: Math.floor(Date.now() / 1000) + 120,
          });
        return msg + "." + sign(null, Buffer.from(msg), w.keys.privateKey).toString("base64url");
      };
      const jwt = assertion(w.pod.uid);
      const send = (id: string, proof = jwt) =>
        redeem(w.endpoint, { ca: w.tls.caBundle }, id, host, proof);
      const first = randomUUID();
      assert.equal(await decision(first), 1);
      assert.equal((await send(first, assertion(randomUUID()))).status, 403);
      assert.equal(reads, 0, "a different Pod cannot spend the intended recipient's permit");
      const good = await send(first);
      assert.equal(good.status, 200);
      const tokenValue = JSON.parse(good.bytes.toString()).access_token;
      const auth = host === "github.com" ? "Basic " + tokenValue : "Bearer " + tokenValue;
      assert.ok(f.gh.authorize(auth, host === "github.com" ? "git" : "api"));
      assert.equal((await send(first)).status, 403);
      const id = randomUUID();
      assert.equal(await decision(id), 1);
      hold = true;
      const pending = send(id);
      const podRead = gate();
      const releasePod = gate();
      let delayedDecision: number | undefined;
      try {
        await Promise.race([
          entered.promise,
          pending.then(() => assert.fail("response arrived before final receipt")),
        ]);
        const sibling = randomUUID();
        assert.equal(await decision(sibling), 1);
        assert.equal(
          (await send(sibling)).status,
          200,
          "same-Pod work does not cancel an overlapping permit",
        );

        // The old read holds A's snapshot. B must invalidate it before the stale reply arrives.
        w.pod.beforeReply = async () => {
          w.pod.beforeReply = undefined;
          podRead.open();
          await releasePod.promise;
        };
        const earlier = decision(randomUUID());
        await podRead.promise;
        w.pod.uid = randomUUID();
        const denied = randomUUID();
        assert.equal(await decision(denied), 2);
        assert.equal((await send(denied)).status, 403);
        releasePod.open();
        delayedDecision = await earlier;
      } finally {
        releasePod.open();
        release.open();
      }
      const stale = await pending;
      assert.equal(
        stale.status,
        403,
        "the obsolete supervisor received material after observed replacement",
      );
      assert.deepEqual(JSON.parse(stale.bytes.toString()), { error: "access_denied" });
      assert.equal(
        delayedDecision,
        2,
        "a delayed A read cannot restore admission after B was seen",
      );
      assert.equal((await send(id)).status, 403);
      assert.equal(reads, 3);

      // A replacement needs a new admission. Retire the original session and provision the
      // next execution on this same worker. Neither a prior permit nor its subject transfers.
      w.runtime.withdraw(w.revision.id);
      await f.state.transact(async (u) => {
        for (const [expectedPhase, phase] of [
          ["open", "closing"],
          ["closing", "disposed"],
        ] as const) {
          await u.repositorySessions.advanceAttempt({
            admissionId,
            expectedPhase,
            phase,
            updatedAt: new Date().toISOString(),
          });
        }
      });
      await owner.maintain();
      w.peer.removeSandbox();
      const next = w.version(2);
      await admit(next.revision, w.revision.id);
      await releaseInstallation(next, 2);
      const fresh = randomUUID();
      assert.equal(await decision(fresh, next.execution.executionId), 1);
      assert.equal((await send(fresh, jwt)).status, 403);
      const nextJwt = assertion(w.pod.uid);
      assert.equal((await send(fresh, nextJwt)).status, 200);
      assert.equal((await send(fresh, nextJwt)).status, 403);
      assert.equal(reads, 4);
      const committed = gate();
      const resume = gate();
      const lost = randomUUID();
      afterApproval = async () => {
        afterApproval = undefined;
        committed.open();
        await resume.promise;
      };
      const lostDecision = decision(lost, next.execution.executionId);
      try {
        await Promise.race([
          committed.promise,
          lostDecision.then(() => assert.fail("approval did not commit")),
        ]);
        const original = w.pod.uid;
        w.pod.uid = "";
        assert.equal(await decision(randomUUID(), next.execution.executionId), 2);
        w.pod.uid = original;
      } finally {
        resume.open();
      }
      assert.equal(
        await lostDecision,
        2,
        "a later positive read cannot restore an interrupted signed approval",
      );
      assert.equal(
        await decision(lost, next.execution.executionId),
        2,
        "the committed possible use cannot be replayed",
      );
      assert.equal((await send(lost, nextJwt)).status, 403);
      assert.equal(reads, 4);
    },
  );
}
