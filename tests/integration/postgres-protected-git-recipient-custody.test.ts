import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { openShellGitRecipientEvidence } from "../../apps/controller/src/drivers/repo/credentials/protected-repository-git-installation.ts";
import { PostgresOpenShellGitRouteStore } from "../../apps/controller/src/drivers/egress-proxy/openshell-git-route-store.ts";
import { postgresRepositorySessions } from "../../packages/occ/src/state/postgres-repository-sessions.ts";
import { CredentialDeliveries } from "../../packages/occ/src/index.ts";
import type {
  AdmittedRepositoryBinding,
  AgentRevision,
  DriverRegistrationRef,
  PreparedGitHubUseRequest,
} from "../../packages/contracts/src/index.ts";
import { resolveGitHubRepositoryBinding } from "../../apps/controller/src/drivers/repo/github/credentials/registry.ts";
import { fixture } from "../fixtures/prepared-repository-git.mjs";
import { standingGitOrigin } from "../helpers/prepared-standing-git-peer.ts";
import { waitForLockWaiter } from "../helpers/postgres-lock-waits.mjs";
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
    assert.deepEqual(
      await host.githubRepository!.readMaterial(route, t.signal),
      { absent: "unprepared" },
      "a selected-repository sender cannot get the installation-wide token",
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
  bindings: readonly AdmittedRepositoryBinding[] = [binding],
  deadlineWallMs = f.deadlineWallMs,
  pendingMember?: string,
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
    repositoryGit: { ...repositoryCredentials!, bindings, deadlineWallMs },
    ...(binding.profile === "github-repository" && {
      repositoryGitAuthorization: "online-request" as const,
    }),
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
      ...(binding.profile !== "github-repository" && { peerKeyId: "authenticated-test-peer" }),
      repositoryGitRecipient: {
        providerId: "provider",
        attachmentEpoch: "epoch",
        processInstanceId: "process",
        networkInstanceId: "net",
        ...(binding.profile === "github-repository" && {
          deliveryProfile: "github_repository" as const,
          authorization: "online-request" as const,
        }),
        ...(binding.profile === "github-installation" && {
          deliveryProfile: "github_installation" as const,
        }),
      },
    },
  };
  await f.state.transact(async (u) => {
    const sessions = u.repositorySessions;
    await u.agents.updateConfiguration(
      namespaceId,
      agentId,
      f.revision.configurationId,
      undefined,
      undefined,
      undefined,
      undefined,
      bindings.map(({ repositoryRef, profile }) => ({ repositoryRef, profile })),
    );
    await u.revisions.createRevision({
      ...(f.revision as AgentRevision),
      id: revisionId,
      revision: f.revision.revision + 1,
      executionAdmission: {
        version: binding.profile === "github-repository" ? 5 : 4,
        mode: "protected",
      },
      egressPlan: plan,
      repositoryCredentials: plan.repositoryGit,
    });
    assert.ok(
      await u.agents.compareAndSetActiveRevision(namespaceId, agentId, f.revision.id, revisionId),
    );
    for (const member of bindings) {
      const memberAdmission = member === binding ? admissionId : randomUUID();
      await sessions.createAttempt({
        namespaceId,
        agentId,
        revisionId,
        admissionId: memberAdmission,
        repositoryRef: member.repositoryRef,
        durationSeconds: 3600,
        deadlineWallMs,
        createdAt,
        brokerProtocol: 2,
      });
      if (member.repositoryRef === pendingMember) {
        continue;
      }
      await sessions.advanceAttempt({
        admissionId: memberAdmission,
        expectedPhase: "opening",
        phase: "open",
        sessionId: member === binding ? sessionId : randomUUID(),
        updatedAt: createdAt,
      });
    }
    await u.credentialSources.recordEgressInstallation(installation);
  });
  return { installation, sessionId, admissionId, revisionId };
}

for (const removal of [
  "B session",
  "B replacement",
  "B deadline",
  "NULL selection",
  "empty selection",
] as const) {
  test(
    `selected repository set retires after ${removal} across owner restart`,
    requiresPostgres,
    async (t) => {
      const f = await fixture(t);
      await disposeNativeSession(f);
      const entries = [
        { repositoryRef: "A", repository: "fixture/repository", repositoryId: "73" },
        { repositoryRef: "B", repository: "fixture/second", repositoryId: "74" },
      ];
      const peer = await standingGitOrigin(t, f.revision.namespaceId, 600_000, undefined, false, {
        entries,
        selectedRepositoryIds: ["73", "74"],
        permissions: { contents: "write", metadata: "read" },
      });
      const registry = { ...peer.registry, backendId: f.registry.backendId };
      const bindings = entries.map(({ repositoryRef }) =>
        resolveGitHubRepositoryBinding(registry, {
          namespaceId: f.revision.namespaceId,
          repositoryRef,
          profile: "github-repository",
        }),
      );
      const driver = {
        id: "set-custody",
        implementation: "custody-fixture",
        configurationId: "c".repeat(64),
      };
      const start = () =>
        f.startOwner({
          controlSocket: undefined,
          registry,
          protectedGitDriver: driver,
          privateKeyPath: peer.privateKeyPath,
          custodyKeyPath: peer.custodyKeyPath,
          apiOrigin: peer.gh.origin,
          ca: peer.tls.ca,
        });
      const owner = await start();
      const { installation, revisionId, admissionId, sessionId } = await admitProtectedSession(
        f,
        driver,
        bindings[0]!,
        bindings,
        removal === "B deadline" ? Date.now() + 5000 : undefined,
        "B",
      );
      const host = owner.protectedGit!;
      const selected = host.online.githubRepository!;
      const route = await host.recipients.observe(installation);
      assert.ok(route);
      await owner.maintain();
      assert.equal(peer.gh.issuesOfTokens.length, 0, "an opening B cannot issue an A-only subset");
      const pendingMember = await f.pool.query(
        "SELECT admission_id FROM occ.repository_session_attempts WHERE revision_id=$1 AND repository_ref='B'",
        [revisionId],
      );
      await f.state.transact((u) =>
        u.repositorySessions.advanceAttempt({
          admissionId: pendingMember.rows[0].admission_id,
          expectedPhase: "opening",
          phase: "open",
          sessionId: randomUUID(),
          updatedAt: new Date().toISOString(),
        }),
      );
      await owner.maintain();
      const material = await selected.readMaterial(route, t.signal);
      assert.ok(material && "value" in material);
      const version = {
        preparationAttemptId: material.preparationAttemptId,
        materialVersion: material.materialVersion,
      };
      const pending = await host.recipients.beginInstall(route, version);
      assert.ok(pending);
      const installedRoute = await host.recipients.confirmInstall(pending);
      assert.ok(installedRoute);
      const installed = { route: installedRoute, ...version };
      const request = () => ({
        sessionId,
        exchangeId: randomUUID(),
        requestDigestSha256: "a".repeat(64),
        deadlineAt: new Date(Date.now() + 5000).toISOString(),
        providerInstanceId: bindings[0]!.grant.providerInstanceId,
        grantId: bindings[0]!.grant.grantId,
        scope: "github-repository" as const,
        installationId: registry.githubInstallationId,
        repositories: entries.map(({ repositoryId, repository }) => ({ repositoryId, repository })),
        operation: "receive-pack" as const,
      });
      assert.equal((await selected.authorize(request(), installed, t.signal)).kind, "allow");
      // The use check compares the request's repository set with the token's exact grant:
      // a request that also names an unselected C cannot use the A+B token.
      const withC = [
        ...request().repositories,
        { repositoryId: "75", repository: "fixture/third" },
      ];
      assert.equal(
        (await selected.authorize({ ...request(), repositories: withC }, installed, t.signal)).kind,
        "denied",
      );
      const sessions = await f.pool.query(
        "SELECT admission_id,repository_ref,phase FROM occ.repository_session_attempts WHERE revision_id=$1 ORDER BY repository_ref",
        [revisionId],
      );
      assert.deepEqual(
        sessions.rows.map((r) => [r.repository_ref, r.phase]),
        [
          ["A", "open"],
          ["B", "open"],
        ],
      );
      const useCount = async () =>
        (
          await f.pool.query(
            "SELECT count(*)::int n FROM occ.prepared_repository_git_uses WHERE admission_id=$1",
            [admissionId],
          )
        ).rows[0].n;
      assert.equal(await useCount(), 1);
      const originalSource = (
        await f.pool.query("SELECT source FROM occ.prepared_github_families WHERE source_id=$1", [
          "repository-git:" + admissionId,
        ])
      ).rows[0].source;
      if (removal === "B session") {
        // Pause the real authorization at B's row, then close B before releasing it.
        // PostgreSQL's lock graph proves the wait; no timing-based synchronization.
        const writer = await f.pool.connect();
        let pending: ReturnType<typeof selected.authorize> | undefined;
        try {
          await writer.query("BEGIN");
          const held = await writer.query(
            "SELECT pg_backend_pid() pid FROM occ.repository_session_attempts WHERE admission_id=$1 FOR UPDATE",
            [sessions.rows[1].admission_id],
          );
          pending = selected.authorize(request(), installed, t.signal);
          await waitForLockWaiter(f.pool, held.rows[0].pid, "authorization waits for B", {
            queryLike: "%FOR SHARE OF s,%",
            timeoutMs: 3000,
          });
          await assert.rejects(
            f.pool.query(
              "SELECT FROM occ.repository_session_attempts WHERE admission_id=$1 FOR UPDATE NOWAIT",
              [admissionId],
            ),
            { code: "55P03" },
            "authorization already holds A before waiting for B",
          );
          assert.ok(
            await postgresRepositorySessions(writer).advanceAttempt({
              admissionId: sessions.rows[1].admission_id,
              expectedPhase: "open",
              phase: "closing",
              updatedAt: new Date().toISOString(),
            }),
          );
          await writer.query("COMMIT");
        } finally {
          await writer.query("ROLLBACK");
          writer.release();
        }
        assert.ok(pending);
        assert.equal(
          (await pending).kind,
          "denied",
          "waiting authorization rechecks B after commit",
        );
      } else if (removal === "B replacement") {
        await f.state.transact(async (u) => {
          for (const [expectedPhase, phase] of [
            ["open", "closing"],
            ["closing", "disposed"],
          ] as const) {
            assert.ok(
              await u.repositorySessions.advanceAttempt({
                admissionId: sessions.rows[1].admission_id,
                expectedPhase,
                phase,
                updatedAt: new Date().toISOString(),
              }),
            );
          }
          const replacement = randomUUID();
          await u.repositorySessions.createAttempt({
            namespaceId: f.revision.namespaceId,
            agentId: f.revision.agentId,
            revisionId,
            admissionId: replacement,
            repositoryRef: "B",
            durationSeconds: 3600,
            deadlineWallMs: f.deadlineWallMs,
            createdAt: new Date().toISOString(),
            brokerProtocol: 2,
          });
          await u.repositorySessions.advanceAttempt({
            admissionId: replacement,
            expectedPhase: "opening",
            phase: "open",
            sessionId: randomUUID(),
            updatedAt: new Date().toISOString(),
          });
        });
      } else if (removal === "B deadline") {
        // Finite members share their immutable admitted deadline. A shorter B-only
        // deadline is rejected by PostgreSQL; both rows remain open as real time passes.
        await f.pool.query(
          "SELECT pg_sleep(GREATEST(0, deadline_wall_ms/1000.0-extract(epoch FROM clock_timestamp())+0.01)) FROM occ.repository_session_attempts WHERE admission_id=$1",
          [sessions.rows[1].admission_id],
        );
        const expired = await f.pool.query(
          "SELECT repository_ref,phase,deadline_wall_ms < extract(epoch FROM clock_timestamp())*1000 expired FROM occ.repository_session_attempts WHERE revision_id=$1 ORDER BY repository_ref",
          [revisionId],
        );
        assert.deepEqual(expired.rows, [
          { repository_ref: "A", phase: "open", expired: true },
          { repository_ref: "B", phase: "open", expired: true },
        ]);
      } else if (removal === "empty selection") {
        await f.state.transact((u) =>
          u.agents.updateConfiguration(
            f.revision.namespaceId,
            f.revision.agentId,
            f.revision.configurationId,
            undefined,
            undefined,
            undefined,
            undefined,
            [],
          ),
        );
      } else {
        await f.pool.query("UPDATE occ.agents SET repository_bindings=$2::jsonb WHERE id=$1", [
          f.revision.agentId,
          null,
        ]);
      }
      assert.deepEqual(
        (
          await f.pool.query("SELECT repository_bindings FROM occ.agents WHERE id=$1", [
            f.revision.agentId,
          ])
        ).rows[0].repository_bindings,
        removal.startsWith("B ")
          ? entries.map(({ repositoryRef }) => ({ repositoryRef, profile: "github-repository" }))
          : null,
      );
      const denied = await selected.authorize(request(), installed, t.signal);
      const unavailable = await selected.readMaterial(installedRoute, t.signal);
      // Replacing B leaves a live selection with different session identities. It has
      // no matching material, rather than withdrawn authority. Neither result permits
      // reading or using the old family; discovery separately retires that family.
      const absence = { absent: removal === "B replacement" ? "unprepared" : "withdrawn" };
      assert.equal(denied.kind, "denied", "changed set cannot authorize the old material");
      assert.deepEqual(unavailable, absence);
      assert.equal(await useCount(), 1, "denial must precede background retirement");
      const beforeRestart = await f.pool.query(
        "SELECT enabled FROM occ.prepared_github_families WHERE source_id=$1",
        ["repository-git:" + admissionId],
      );
      assert.equal(
        beforeRestart.rows[0].enabled,
        true,
        "use denial did not retire the family; discovery must do it",
      );
      await owner.close();
      const restarted = await start();
      await restarted.maintain();
      if (removal === "B replacement") {
        // A later pass may rediscover the new live selection, but it cannot rebind or
        // re-enable the old anchor's family after its original token was retired.
        await restarted.maintain();
      }
      assert.deepEqual(
        await restarted.protectedGit!.online.githubRepository!.readMaterial(
          installedRoute,
          t.signal,
        ),
        absence,
      );
      const afterRestart = await restarted.protectedGit!.online.githubRepository!.authorize(
        request(),
        installed,
        t.signal,
      );
      const saved = await f.pool.query(
        "SELECT f.enabled,a.custody,a.sealed IS NULL erased,f.source=$2::jsonb original_source,a.id=$3::uuid original_attempt FROM occ.prepared_github_families f JOIN occ.prepared_github_attempts a USING(source_id) WHERE f.source_id=$1",
        ["repository-git:" + admissionId, originalSource, material.preparationAttemptId],
      );
      t.diagnostic(
        JSON.stringify({
          removal,
          before: denied.kind,
          after: afterRestart.kind,
          custody: saved.rows,
        }),
      );
      assert.deepEqual(saved.rows, [
        {
          enabled: false,
          custody: "revoked",
          erased: true,
          original_source: true,
          original_attempt: true,
        },
      ]);
      assert.equal(afterRestart.kind, "denied");
      assert.equal(await useCount(), 1, "no post-end dispatch receipt");
      assert.equal(peer.gh.issuesOfTokens.length, 1, "no renewal after a member ends");
    },
  );
}
