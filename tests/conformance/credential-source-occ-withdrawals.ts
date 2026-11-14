import type { AgentRevision } from "../../packages/contracts/src/index.ts";
import type { UpdateAgentInput } from "../../packages/occ/src/index.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { resolveApprovedHarness as resolveApprovedDevelopmentHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { AuthorizationDeniedError, ResourceConflictError } from "../../packages/occ/src/index.ts";
import {
  WITHDRAWAL_NO_ACTIVE_VERSION,
  WITHDRAWAL_NOT_FOUND,
  WITHDRAWAL_SOURCE_NOT_USED,
} from "../helpers/refusal-text.mjs";
import { refusedAnswer } from "./credential-source-occ-refusals.ts";
import { administrator, deployer, fixture } from "./credential-source-occ-fixture.ts";

export function registerWithdrawalCases(): void {
  test("withdrawal is recorded for the active revision and queued once, and the read prefers a stalled successor withdrawal", async () => {
    const {
      controller,
      dedicatedAgent,
      grantAgentSourceOperate,
      makeReady,
      modelSecret,
      namespace,
      state,
    } = await fixture();
    await makeReady();
    const secret = await modelSecret();
    const source = await controller.createCredentialSource(administrator, {
      namespaceId: namespace.id,
      name: "openai",
      type: "openai",
      secrets: { api_key: secret.ref },
    });
    const agent = await dedicatedAgent();
    await controller.updateAgent(administrator, {
      namespaceId: namespace.id,
      agentId: agent.id,
      configurationId: agent.configurationId,
      harnessAuth: { method: "credential_source", sourceId: source.id },
      credentialSources: [{ sourceId: source.id }],
    });
    grantAgentSourceOperate(agent, source);
    const request = { namespaceId: namespace.id, agentId: agent.id, credentialSourceId: source.id };

    // Withdrawal revokes a running revision's access, so the Agent needs an active revision.
    await assert.rejects(
      controller.withdrawAgentCredentialSource(administrator, request),
      ResourceConflictError,
    );
    // Its read says why there is nothing to read rather than a bare 404 (finding D762).
    assert.deepEqual(
      await refusedAnswer(() => controller.readAgentCredentialWithdrawal(administrator, request)),
      { status: 404, code: "NOT_FOUND", message: WITHDRAWAL_NO_ACTIVE_VERSION },
    );
    const revision = await controller.deployAgent(
      administrator,
      { namespaceId: namespace.id, agentId: agent.id },
      resolveApprovedDevelopmentHarness,
    );
    await controller.transact((unit) =>
      unit.agents.compareAndSetActiveRevision(namespace.id, agent.id, undefined, revision.id),
    );
    const withdrawalWork = () =>
      state
        .pendingOperations()
        .filter(
          (operation) =>
            operation.kind === "agent_revision" && operation.target === "credentials_withdrawn",
        );

    // Withdrawal requires operate on the Agent, which the deployer lacks.
    await assert.rejects(
      controller.withdrawAgentCredentialSource(deployer, request),
      AuthorizationDeniedError,
    );
    const withdrawal = await controller.withdrawAgentCredentialSource(administrator, request);
    assert.equal(withdrawal.state, "pending");
    assert.equal(withdrawal.revisionId, revision.id);
    assert.equal(withdrawal.requestedBy, administrator);
    assert.equal(withdrawalWork().length, 1);
    assert.equal(withdrawalWork()[0]?.resourceId, revision.id);
    assert.deepEqual(
      await controller.readAgentCredentialWithdrawal(administrator, request),
      withdrawal,
    );

    // A replay keeps the same withdrawal; while the first attempt is outstanding it queues none.
    assert.deepEqual(
      await controller.withdrawAgentCredentialSource(administrator, request),
      withdrawal,
    );
    assert.equal(withdrawalWork().length, 1);

    // Only a source the active revision was admitted with can be withdrawn. The check reads the
    // revision's bindings, never the source, so another source and a missing ID answer alike: a
    // 409 that names no source (finding 2536).
    const other = await controller.createCredentialSource(administrator, {
      namespaceId: namespace.id,
      name: "other",
      type: "openai",
      secrets: { api_key: secret.ref },
    });
    for (const credentialSourceId of [other.id, `cs_${crypto.randomUUID()}`]) {
      assert.deepEqual(
        await refusedAnswer(() =>
          controller.withdrawAgentCredentialSource(administrator, {
            ...request,
            credentialSourceId,
          }),
        ),
        { status: 409, code: "RESOURCE_CONFLICT", message: WITHDRAWAL_SOURCE_NOT_USED },
      );
      // The read of a withdrawal the active version lacks names that, the same for both IDs
      // (finding D762).
      assert.deepEqual(
        await refusedAnswer(() =>
          controller.readAgentCredentialWithdrawal(administrator, {
            ...request,
            credentialSourceId,
          }),
        ),
        { status: 404, code: "NOT_FOUND", message: WITHDRAWAL_NOT_FOUND },
      );
    }
    // A withdrawn source stays referenced by the active revision until a redeploy replaces it,
    // and that reference, not the queued withdrawal, is what the refusal names.
    await assert.rejects(
      controller.deleteCredentialSource(administrator, namespace.id, source.id),
      (error) =>
        error instanceof ResourceConflictError &&
        error.name === "ResourceStateConflictError" &&
        error.message.startsWith(
          "An Agent, active revision, pending deployment, or provisioning request",
        ),
    );

    // A later deployment's pending withdrawal with no attempt outstanding, as exhausted attempts
    // leave it (memory never runs work, so it is recorded without any), needs a replay. The read
    // reports it ahead of the active revision's withdrawal, whose attempt is still outstanding.
    const successor = await controller.deployAgent(
      administrator,
      { namespaceId: namespace.id, agentId: agent.id },
      resolveApprovedDevelopmentHarness,
    );
    await controller.transact((unit) =>
      unit.credentialSources.requestCredentialWithdrawal({
        namespaceId: namespace.id,
        agentId: agent.id,
        revisionId: successor.id,
        credentialSourceId: source.id,
        state: "pending",
        requestedBy: administrator,
        requestedAt: new Date().toISOString(),
      }),
    );
    const stalled = await controller.readAgentCredentialWithdrawal(administrator, request);
    assert.equal(stalled.revisionId, successor.id);
    assert.equal(stalled.state, "pending");
    assert.equal(stalled.withdrawalInProgress, false);
  });

  test("withdrawal also covers each admitted successor revision that holds the source", async () => {
    const {
      controller,
      dedicatedAgent,
      grantAgentSourceOperate,
      makeReady,
      modelSecret,
      namespace,
      state,
    } = await fixture();
    await makeReady();
    const model = await controller.createCredentialSource(administrator, {
      namespaceId: namespace.id,
      name: "openai",
      type: "openai",
      secrets: { api_key: (await modelSecret()).ref },
    });
    const registry = await controller.createCredentialSource(administrator, {
      namespaceId: namespace.id,
      name: "registry",
      type: "registry",
      config: { host: "registry.example.com" },
    });
    const agent = await dedicatedAgent();
    const bind = (credentialSources: NonNullable<UpdateAgentInput["credentialSources"]>) =>
      controller.updateAgent(administrator, {
        namespaceId: namespace.id,
        agentId: agent.id,
        configurationId: agent.configurationId,
        harnessAuth: { method: "credential_source", sourceId: model.id },
        credentialSources,
      });
    await bind([{ sourceId: model.id }, { sourceId: registry.id }]);
    grantAgentSourceOperate(agent, model);
    grantAgentSourceOperate(agent, registry, "registry");
    const deploy = () =>
      controller.deployAgent(
        administrator,
        { namespaceId: namespace.id, agentId: agent.id },
        resolveApprovedDevelopmentHarness,
      );
    const activate = (from: string | undefined, to: string) =>
      controller.transact((unit) =>
        unit.agents.compareAndSetActiveRevision(namespace.id, agent.id, from, to),
      );
    const rows = (revision: Pick<AgentRevision, "id">) =>
      controller.transact((unit) =>
        unit.credentialSources.listCredentialWithdrawals(namespace.id, revision.id),
      );
    const workFor = (revision: Pick<AgentRevision, "id">) =>
      state
        .pendingOperations()
        .filter(
          (operation) =>
            operation.kind === "agent_revision" &&
            operation.target === "credentials_withdrawn" &&
            operation.resourceId === revision.id,
        );
    const first = await deploy();
    await activate(undefined, first.id);
    // Two deployments are admitted but not active yet; only the first still holds the registry.
    const second = await deploy();
    await bind([{ sourceId: model.id }]);
    const third = await deploy();
    const request = {
      namespaceId: namespace.id,
      agentId: agent.id,
      credentialSourceId: registry.id,
    };

    const withdrawal = await controller.withdrawAgentCredentialSource(administrator, request);
    assert.equal(withdrawal.revisionId, first.id);
    assert.equal(withdrawal.state, "pending");
    // The successor gets its own pending row and work, so its deployment cannot attach the source.
    const [successorRow] = await rows(second);
    assert.ok(successorRow);
    assert.equal(successorRow.state, "pending");
    assert.equal(successorRow.credentialSourceId, registry.id);
    assert.equal(successorRow.requestedBy, administrator);
    assert.equal(workFor(first).length, 1);
    assert.equal(workFor(second).length, 1);
    assert.deepEqual(await rows(third), []);
    assert.equal(workFor(third).length, 0);
    // A replay keeps both rows and queues nothing while their attempts are outstanding.
    assert.deepEqual(
      await controller.withdrawAgentCredentialSource(administrator, request),
      withdrawal,
    );
    assert.equal(workFor(first).length + workFor(second).length, 2);

    // Once the successor activates, the read reports its withdrawal instead of a 404.
    await activate(first.id, second.id);
    const read = await controller.readAgentCredentialWithdrawal(administrator, request);
    assert.equal(read.revisionId, second.id);
    assert.equal(read.state, "pending");

    // A revoked withdrawal on the active revision still reaches a later successor, and the
    // response reports that successor's pending withdrawal instead of the revoked one. (The
    // in-memory store never retires the first revision, so its withdrawal is revoked here too.)
    for (const revision of [first, second]) {
      await controller.transact((unit) =>
        unit.credentialSources.markCredentialWithdrawalRevoked(
          namespace.id,
          revision.id,
          registry.id,
          new Date().toISOString(),
        ),
      );
    }
    await bind([{ sourceId: model.id }, { sourceId: registry.id }]);
    const fourth = await deploy();
    const replay = await controller.withdrawAgentCredentialSource(administrator, request);
    assert.equal(replay.revisionId, fourth.id);
    assert.equal(replay.state, "pending");
    assert.equal(replay.withdrawalInProgress, true);
    const [laterRow] = await rows(fourth);
    assert.equal(laterRow?.state, "pending");
    assert.equal(workFor(fourth).length, 1);
    assert.deepEqual(await rows(third), []);
    const pendingRead = await controller.readAgentCredentialWithdrawal(administrator, request);
    assert.equal(pendingRead.revisionId, fourth.id);
    assert.equal(pendingRead.withdrawalInProgress, true);

    // Once every revision that may run with the source confirmed it, the active one is reported.
    await controller.transact((unit) =>
      unit.credentialSources.markCredentialWithdrawalRevoked(
        namespace.id,
        fourth.id,
        registry.id,
        new Date().toISOString(),
      ),
    );
    const revokedRead = await controller.readAgentCredentialWithdrawal(administrator, request);
    assert.equal(revokedRead.revisionId, second.id);
    assert.equal(revokedRead.state, "revoked");
  });
}
