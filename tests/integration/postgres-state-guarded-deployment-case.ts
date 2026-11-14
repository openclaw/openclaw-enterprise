import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";

import type {
  AuthorizedAgentDeployment,
  FirstDeploymentIntent,
} from "../../packages/occ/src/index.ts";
import { databaseUrl } from "../helpers/postgres-platform-state.ts";
import { ensureInstallation } from "../helpers/postgres-state-installation.ts";

export async function persistGuardedDeployment(context: TestContext) {
  const [
    { Pool },
    { AuditEventFactory },
    { PostgresPlatformState },
    { OpenClawController, ResourceStateConflictError },
    { NativeIAMDriver, createAuthPrincipalSeed },
    { createTestConfigurationDriver },
    { createTestSecretDriver },
    { createReadyComputeDriver, registerAndSelectDrivers },
    { SlackChannelDriver },
    { resolveApprovedHarness },
    { grantAgentSecretOperate },
  ] = await Promise.all([
    import("pg"),
    import("../../packages/audit/src/index.ts"),
    import("../../packages/occ/src/state/postgres-state.ts"),
    import("../../packages/occ/src/index.ts"),
    import("../../packages/iam/src/index.ts"),
    import("../helpers/configuration-driver.ts"),
    import("../helpers/secret-driver.mjs"),
    import("../helpers/development.ts"),
    import("../../apps/controller/src/drivers/channel/slack.ts"),
    import("../../apps/controller/src/composition/production-harness.ts"),
    import("../helpers/postgres-harness-auth.mjs"),
  ]);
  const pool = new Pool({ connectionString: databaseUrl });
  context.after(() => pool.end());
  const state = new PostgresPlatformState(pool);
  const installation = await ensureInstallation(state, "guarded-first-deployment");
  const seed = createAuthPrincipalSeed(
    installation.id,
    "guarded-deployment-test",
    { id: randomUUID() },
    { grant: "administrator" },
  );
  await state.seedNativeIAM({
    identities: [seed.principal],
    roles: seed.roles,
    bindings: seed.bindings,
    groups: [],
    memberships: [],
    restrictions: [],
  });
  const principalId = seed.principal.id;
  const configurationDriver = createTestConfigurationDriver();
  const secretDriver = createTestSecretDriver();
  const compute = createReadyComputeDriver("guarded-test-compute", { validateHarnessAuth() {} });
  let senderCalls = 0;
  const channel = new SlackChannelDriver(async (input, init) => {
    senderCalls++;
    const request = new Request(input, init);
    assert.equal(request.url, "https://slack.com/api/auth.test");
    assert.equal(request.headers.get("authorization"), "Bearer xoxb-synthetic-bot");
    return Response.json({ ok: true, bot_id: "B123", team_id: "T123" });
  });
  const createController = (store: InstanceType<typeof PostgresPlatformState>) => {
    const controller = new OpenClawController(installation, {
      state: store,
      recordOperations: true,
    });
    registerAndSelectDrivers(controller, [
      new NativeIAMDriver(store),
      compute,
      configurationDriver,
      secretDriver,
      channel,
    ]);
    return controller;
  };
  const controller = createController(state);
  const namespace = await controller.createNamespace(principalId, {
    name: `guarded-${randomUUID()}`,
  });
  await controller.handleNamespaceLifecycle(principalId, namespace.id, "ready");
  const bot = await controller.createSecret(principalId, {
    namespaceId: namespace.id,
    name: "synthetic-slack",
    value: "xoxb-synthetic-bot",
  });
  const configuration = await controller.createConfiguration(principalId, {
    namespaceId: namespace.id,
    kind: "agent",
    values: {
      channels: { slack: { enabled: true, mode: "http", botToken: "${SLACK_BOT_TOKEN}" } },
    },
    secretBindings: {
      SLACK_BOT_TOKEN: { source: { kind: "secret", namespaceId: namespace.id, id: bot.id } },
    },
  });
  const secret = await controller.createSecret(principalId, {
    namespaceId: namespace.id,
    name: "synthetic-harness",
    value: "synthetic-test-key",
  });
  const agent = await controller.createAgent(principalId, {
    namespaceId: namespace.id,
    name: "guarded-agent",
    configurationId: configuration.id,
    harnessAuth: {
      method: "api_key",
      source: { kind: "secret", namespaceId: namespace.id, id: secret.id },
    },
  });
  await grantAgentSecretOperate(pool, agent, secret.id);
  await grantAgentSecretOperate(pool, agent, bot.id);
  const auditFactory = new AuditEventFactory();
  const mutationEvent = ({ revision, authorization }: Readonly<AuthorizedAgentDeployment>) =>
    auditFactory.create({
      installationId: installation.id,
      namespaceId: namespace.id,
      actorId: principalId,
      action: "openclaw.agents.deploy",
      source: "occ",
      kind: "mutation",
      outcome: "success",
      resource: { kind: "agent_revision", id: revision.id, namespaceId: namespace.id },
      authorization: authorization.request,
      details: { iamEvidence: authorization.decision.evidence },
      iamDriverId: authorization.decision.driverId,
    });
  const input = { namespaceId: namespace.id, agentId: agent.id };
  const intent: FirstDeploymentIntent = {
    key: "reviewed-first",
    expectedConfigurationId: configuration.id,
    expectedGeneration: 1,
  };
  const count = async () => {
    const counts = await pool.query<{ revisions: number; work: number; audit: number }>(
      `SELECT (SELECT count(*)::int FROM occ.agent_revisions WHERE namespace_id = $1 AND agent_id = $2) AS revisions,
          (SELECT count(*)::int FROM occ.controller_work WHERE namespace_id = $1 AND agent_id = $2 AND revision_id IS NOT NULL) AS work,
          (SELECT count(DISTINCT a.id)::int FROM occ.audit_events a
           JOIN occ.agent_revisions r ON r.id = a.resource_id
           WHERE r.namespace_id = $1 AND r.agent_id = $2 AND r.revision_number = 1
             AND a.kind = 'mutation' AND a.action = 'openclaw.agents.deploy'
             AND a.outcome = 'success') AS audit`,
      [namespace.id, agent.id],
    );
    return counts.rows[0];
  };
  secretDriver.calls.length = 0;
  assert.equal(await controller.recoverAgentFirstDeployment(principalId, input, intent), null);
  assert.deepEqual(await count(), { revisions: 0, work: 0, audit: 0 });
  assert.equal(secretDriver.calls.length, 0);
  const competing = { ...intent, key: "competing-first" };
  // Both reviewed intents race to admit revision one. The loser must see the winner's history.
  const deployFirst = (requested: FirstDeploymentIntent) =>
    controller.deployAgentFirst(
      principalId,
      input,
      requested,
      resolveApprovedHarness,
      mutationEvent,
    );
  const [reviewed, rival] = await Promise.allSettled([deployFirst(intent), deployFirst(competing)]);
  const [winner, loser, winnerIntent] =
    reviewed.status === "fulfilled" ? [reviewed, rival, intent] : [rival, reviewed, competing];
  assert.ok(winner.status === "fulfilled", "one first deployment must be admitted");
  assert.ok(loser.status === "rejected", "the other first deployment must be refused");
  const refusal: unknown = loser.reason;
  assert.ok(refusal instanceof ResourceStateConflictError);
  assert.match(refusal.message, /already has revision history/);
  const receipt = winner.value;
  assert.deepEqual(await count(), { revisions: 1, work: 1, audit: 1 });
  assert.equal(secretDriver.calls.filter((call) => call.operation === "resolve").length, 2);
  assert.ok(senderCalls >= 1 && senderCalls <= 2, "only the two fresh contenders can validate");
  assert.equal(
    secretDriver.calls.filter((call) => call.operation === "withValue").length,
    senderCalls,
  );
  const preparedSenderCalls = senderCalls;
  context.diagnostic(JSON.stringify({ senderCalls, resolve: 2, ...(await count()) }));

  // Reopening the State adapter must recover the durable receipt without calling either Driver.
  const reopened = createController(new PostgresPlatformState(pool));
  secretDriver.calls.length = 0;
  assert.deepEqual(
    await reopened.recoverAgentFirstDeployment(principalId, input, winnerIntent),
    receipt,
  );
  assert.deepEqual(
    await reopened.deployAgentFirst(
      principalId,
      input,
      winnerIntent,
      resolveApprovedHarness,
      mutationEvent,
    ),
    receipt,
  );
  assert.equal(
    await reopened.recoverAgentFirstDeployment(principalId, input, {
      ...winnerIntent,
      key: "unused",
    }),
    null,
  );
  assert.equal(secretDriver.calls.length, 0);
  assert.equal(senderCalls, preparedSenderCalls);
  assert.deepEqual(await count(), { revisions: 1, work: 1, audit: 1 });
  const stored = await pool.query<{
    first_deployment_digest: string | null;
    admitted_spec: unknown;
  }>("SELECT first_deployment_digest, admitted_spec FROM occ.agent_revisions WHERE id = $1", [
    receipt.revisionId,
  ]);
  assert.equal(stored.rowCount, 1);
  const snapshot = stored.rows[0];
  assert.ok(snapshot && typeof snapshot.first_deployment_digest === "string");
  assert.match(snapshot.first_deployment_digest, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(snapshot.admitted_spec).includes(winnerIntent.key), false);
  assert.equal(JSON.stringify(snapshot.admitted_spec).includes(principalId), false);
  const sibling = await reopened.createAgent(principalId, {
    namespaceId: namespace.id,
    name: "guarded-digest-constraint",
    configurationId: configuration.id,
    harnessAuth: agent.harnessAuth,
  });
  await grantAgentSecretOperate(pool, sibling, secret.id);
  await grantAgentSecretOperate(pool, sibling, bot.id);
  // Revision updates are already forbidden by the immutable-row trigger. These new
  // rows keep the admitted snapshot and Namespace intact, and isolate each CHECK rule:
  // a malformed digest on revision one, then a well-formed digest on revision two.
  for (const { agentId, revisionNumber, digest } of [
    { agentId: sibling.id, revisionNumber: 1, digest: "invalid-digest" },
    { agentId: agent.id, revisionNumber: 2, digest: "a".repeat(64) },
  ]) {
    await assert.rejects(
      pool.query(
        `INSERT INTO occ.agent_revisions
         (id, namespace_id, agent_id, revision_number, backend_id, admitted_spec,
          gateway_managed_mode, admitted_at, first_deployment_digest)
         SELECT $1, namespace_id, $2, $3, backend_id, admitted_spec,
                gateway_managed_mode, admitted_at, $4
         FROM occ.agent_revisions WHERE id = $5`,
        [`rev_${randomUUID()}`, agentId, revisionNumber, digest, receipt.revisionId],
      ),
      { code: "23514", constraint: "agent_revisions_first_deployment_digest" },
    );
  }
  assert.deepEqual(await count(), { revisions: 1, work: 1, audit: 1 });
  assert.deepEqual(
    await state.read((unit) => unit.revisions.listRevisionMetadata(namespace.id, sibling.id)),
    [],
  );
  const next = await reopened.deployAgent(principalId, input, resolveApprovedHarness);
  assert.equal(next.revision, 2);
  const unchanged = await pool.query(
    "SELECT id, first_deployment_digest FROM occ.agent_revisions WHERE namespace_id = $1 AND agent_id = $2 ORDER BY revision_number",
    [namespace.id, agent.id],
  );
  assert.deepEqual(unchanged.rows, [
    { id: receipt.revisionId, first_deployment_digest: snapshot.first_deployment_digest },
    { id: next.id, first_deployment_digest: null },
  ]);
  await reopened.updateConfiguration(principalId, {
    namespaceId: namespace.id,
    configurationId: configuration.id,
    values: { temperature: "1" },
  });
  assert.deepEqual(
    await reopened.recoverAgentFirstDeployment(principalId, input, winnerIntent),
    receipt,
  );
  assert.deepEqual(await count(), { revisions: 2, work: 2, audit: 1 });
  const publicRevision = await state.read((unit) =>
    unit.revisions.findRevision(namespace.id, agent.id, receipt.revisionId),
  );
  assert.ok(publicRevision);
  assert.equal(Object.hasOwn(publicRevision, "firstDeploymentDigest"), false);
  assert.equal(Object.hasOwn(publicRevision, "first_deployment_digest"), false);
}
