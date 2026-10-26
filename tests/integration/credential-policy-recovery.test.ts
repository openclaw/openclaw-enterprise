import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:https";
import test from "node:test";
import type {
  AgentRevision,
  Namespace,
  CredentialPolicyObservation,
  CredentialPolicyReduction,
  EgressInstallation,
  ProxyPlan,
} from "../../packages/contracts/src/index.ts";
import {
  InMemoryPlatformState,
  InstalledDriver,
  reduceCredentialPolicy,
} from "../../packages/occ/src/index.ts";
import { ProtectedExecutionDriver } from "../../apps/controller/src/drivers/compute/protected-execution-driver.ts";
import {
  seedSessionRevision,
  sessionAttempt,
} from "../conformance/repository-sessions.contract.mjs";
import {
  repositoryBinding,
  repositoryCredentials,
} from "../fixtures/repository-credentials/session-state.mjs";
import { createDriver } from "../fixtures/driver-packages/protected-execution-driver/index.ts";
import { createTlsMaterial, listen } from "../fixtures/repository-credentials/process.mjs";

test("Git reduction recovery observes its original operation despite discovery failure", async (t) => {
  const state = new InMemoryPlatformState();
  const credentials = repositoryCredentials({
    bindings: [repositoryBinding({ profile: "git-write" })],
  });
  const seeded = await seedSessionRevision(state, credentials, { executionMode: "dedicated" });
  const { cert, key, ca } = await createTlsMaterial(t);
  let supervisorRequests = 0;
  const supervisor = createServer({ cert, key }, (_request, response) => {
    supervisorRequests++;
    response.writeHead(500).end();
  });
  const endpoint = await listen(t, supervisor);
  t.after(() => {
    assert.equal(supervisorRequests, 0, "recovery must not query the release supervisor");
  });
  const registration = createDriver({
    id: "recovery-driver",
    implementation: "reference",
    configuration: { endpoint, ca: ca.toString("utf8") },
  });
  t.after(() => registration.close?.());
  let available = false;
  let applies = 0;
  let request: CredentialPolicyReduction | undefined;
  let observation: CredentialPolicyObservation | undefined;
  const proxy = registration.capabilities.credential_proxy!;
  const owner = new InstalledDriver(
    { id: proxy.id, implementation: proxy.implementation, configuration: {} },
    {
      capabilities: {
        ...registration.capabilities,
        credential_proxy: {
          ...proxy,
          policyReduction: {
            version: 2,
            async assertAvailable() {
              if (!available) {
                throw new Error("discovery unavailable");
              }
            },
            async apply(_context, value) {
              applies++;
              request = value;
              throw new Error("lost reply");
            },
            async observe() {
              return observation;
            },
          },
        },
      },
    },
  );
  const revisionId = `rev_${randomUUID()}`;
  const installationId = await state.read(
    async (view) => (await view.installations.getInstallation())!.id,
  );
  const plan: ProxyPlan = {
    id: randomUUID(),
    generation: 1,
    driver: owner.ref,
    sandboxDriverId: proxy.id,
    egressDriverId: proxy.id,
    execution: {
      installationId,
      namespaceId: seeded.namespace.id,
      agentId: seeded.agent.id,
      revisionId,
      servicePrincipalId: seeded.agent.servicePrincipalId,
      executionId: randomUUID(),
    },
    policyReductionVersion: 2,
    repositoryGit: credentials,
    routes: [],
  };
  const revision = {
    ...seeded.revision,
    id: revisionId,
    revision: 2,
    egressPlan: plan,
    sandboxDriverId: proxy.id,
    executionAdmission: { version: 7, mode: "protected" },
  } as AgentRevision;
  const initial: EgressInstallation = {
    plan,
    sandboxId: randomUUID(),
    sender: proxy.sourceControl.sender,
    installedAt: seeded.revision.createdAt,
    enforcement: {
      instanceId: randomUUID(),
      configurationId: "initial",
      policyHash: "a".repeat(64),
      authorityScope: "execution",
      peerKeyId: "peer",
      repositoryGitRecipient: {
        providerId: "provider",
        attachmentEpoch: "epoch",
        processInstanceId: "process",
        networkInstanceId: "network",
      },
    },
  };
  await state.transact(async (unit) => {
    await unit.revisions.createRevision(revision);
    await unit.agents.compareAndSetActiveRevision(
      seeded.namespace.id,
      seeded.agent.id,
      undefined,
      revision.id,
    );
    await unit.credentialSources.recordEgressInstallation(initial);
    // A failed opening is closed before cleanup tries to remove its Git authority.
    const attempt = await unit.repositorySessions.createAttempt(
      sessionAttempt(revision, { brokerProtocol: 2 }),
    );
    await unit.repositorySessions.advanceAttempt({
      admissionId: attempt.admissionId,
      expectedPhase: "opening",
      phase: "invalidated",
      updatedAt: seeded.revision.createdAt,
    });
  });
  const context = { namespace: seeded.namespace as Namespace, revision, plan, signal: t.signal };
  const reduce = () => reduceCredentialPolicy(state, owner, context, undefined);
  await assert.rejects(reduce(), /discovery unavailable/);
  assert.equal(
    (
      await state.read((view) =>
        view.credentialSources.listCredentialPolicyReductions(seeded.namespace.id, revision.id),
      )
    ).length,
    0,
  );
  available = true;
  await assert.rejects(reduce(), /lost reply/);
  assert.ok(request);
  available = false;
  assert.equal(
    await reduce(),
    "pending",
    "recovery does not need discovery and never replays apply",
  );
  assert.equal(applies, 1);
  const reduced: EgressInstallation = {
    ...initial,
    plan: request.retained,
    enforcement: { ...initial.enforcement, configurationId: "reduced", policyHash: "b".repeat(64) },
  };
  for (const installation of [
    initial,
    {
      ...reduced,
      enforcement: { ...reduced.enforcement, policyHash: initial.enforcement.policyHash },
    },
    { ...reduced, enforcement: { ...reduced.enforcement, configurationId: "" } },
  ]) {
    observation = { operationId: request.operationId, installation };
    assert.equal(
      await reduce(),
      "pending",
      "same identity without exact policy is not replacement",
    );
  }
  observation = {
    operationId: randomUUID(),
    installation: { ...reduced, sandboxId: "replacement" },
  };
  assert.equal(await reduce(), "pending", "another operation cannot establish replacement");
  observation = {
    operationId: request.operationId,
    installation: {
      ...reduced,
      sandboxId: "replacement",
      plan: { ...reduced.plan, generation: 99 },
    },
  };
  assert.equal(
    await reduce(),
    "pending",
    "unrelated policy evidence does not establish replacement",
  );
  observation = {
    operationId: request.operationId,
    installation: { ...reduced, sandboxId: "replacement" },
  };
  assert.equal(await reduce(), "retire-runtime");
  observation = { operationId: request.operationId, installation: reduced };
  assert.equal(await reduce(), "withdrawn");
  assert.equal(await reduce(), "withdrawn");
  assert.equal(applies, 1);
  assert.deepEqual(
    await state.read((view) =>
      view.credentialSources.findRevisionEgressInstallation(seeded.namespace.id, revision.id),
    ),
    reduced,
  );
  const [receipt] = await state.read((view) =>
    view.credentialSources.listCredentialPolicyReductions(seeded.namespace.id, revision.id),
  );
  assert.deepEqual(
    receipt?.request.expected,
    initial,
    "settlement preserves the original reliable receipt",
  );
  assert.deepEqual(receipt?.observed, reduced);
  assert.equal(
    (
      await state.read((view) =>
        view.repositorySessions.listRevisionAttempts({
          namespaceId: seeded.namespace.id,
          agentId: seeded.agent.id,
          revisionId,
        }),
      )
    ).every(({ phase }) => phase === "invalidated"),
    true,
  );

  const release = new ProtectedExecutionDriver(owner);
  assert.equal(release.admits(revision, "stored"), true);
  const { repositoryGit, policyReductionVersion, ...ordinary } = plan;
  assert.ok(repositoryGit && policyReductionVersion);
  assert.equal(
    release.admits(
      { executionAdmission: { version: 3, mode: "protected" }, egressPlan: ordinary },
      owner,
    ),
    true,
  );
  assert.equal(
    release.admits(
      {
        executionAdmission: { version: 3, mode: "protected" },
        egressPlan: { ...ordinary, policyReductionVersion },
      },
      owner,
    ),
    false,
  );
  const installationGit = {
    ...repositoryGit,
    bindings: repositoryGit.bindings.map((binding) => ({
      ...binding,
      profile: "github-installation",
    })),
  };
  for (const version of [4, 5, 6] as const) {
    const authorization = version === 5 ? "online-request" : "request-hook-observed";
    const legacyPlan = {
      ...ordinary,
      repositoryGit: installationGit,
      ...(version === 4
        ? {}
        : {
            repositoryGitAuthorization: authorization as "online-request" | "request-hook-observed",
          }),
    };
    assert.equal(
      release.admits(
        { executionAdmission: { version, mode: "protected" }, egressPlan: legacyPlan },
        owner,
      ),
      true,
    );
    assert.equal(
      release.admits(
        {
          executionAdmission: { version, mode: "protected" },
          egressPlan: { ...legacyPlan, policyReductionVersion: 2 },
        },
        owner,
      ),
      false,
    );
  }
  assert.equal(
    release.admits(
      {
        ...revision,
        egressPlan: {
          ...plan,
          repositoryGit: {
            ...repositoryGit,
            bindings: repositoryGit.bindings.map((binding) => ({
              ...binding,
              profile: "git-read",
            })),
          },
        },
      },
      owner,
    ),
    false,
  );
  for (const version of [1, 2, 8, 99]) {
    assert.equal(
      release.admits(
        { ...revision, executionAdmission: { version, mode: "protected" } } as AgentRevision,
        "stored",
      ),
      false,
    );
  }
});
