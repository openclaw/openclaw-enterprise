import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  repositoryBinding,
  repositoryCredentials,
  repositoryGrant,
} from "../fixtures/repository-credentials/session-state.mjs";

export async function seedSessionRevision(
  store,
  credentials = repositoryCredentials(),
  options = {},
) {
  const createdAt = "2030-03-17T17:46:40.000Z";
  const namespace = {
    id: options.namespaceId ?? `ns_${randomUUID()}`,
    name: `Repository session ${randomUUID()}`,
    status: "ready",
    createdAt,
  };
  const configuration = {
    id: `cfg_${randomUUID()}`,
    namespaceId: namespace.id,
    kind: "agent",
    generation: 1,
    createdAt,
  };
  const secret = {
    id: `sec_${randomUUID()}`,
    namespaceId: namespace.id,
    name: `model-key-${randomUUID()}`,
    driverId: "kubernetes-secret",
    backendRef: {
      namespaceName: `ns-${randomUUID().slice(0, 8)}`,
      name: `agent-${randomUUID().slice(0, 8)}.credentials`,
      key: "value",
      uid: randomUUID(),
    },
    createdAt,
  };
  const harnessAuth = {
    method: "api_key",
    source: { kind: "secret", namespaceId: namespace.id, id: secret.id },
  };
  const agent = {
    id: `agt_${randomUUID()}`,
    namespaceId: namespace.id,
    name: `Session owner ${randomUUID()}`,
    configurationId: configuration.id,
    backendId: null,
    harnessAuth,
    executionMode: "embedded",
    servicePrincipalId: `service-agent-${randomUUID()}`,
    repositoryBindings: credentials.bindings.map(({ repositoryRef, profile }) => ({
      repositoryRef,
      profile,
    })),
    createdAt,
  };
  const revision = {
    id: `rev_${randomUUID()}`,
    namespaceId: namespace.id,
    agentId: agent.id,
    revision: 1,
    configurationId: configuration.id,
    configurationKind: "agent",
    configurationGeneration: 1,
    backendId: null,
    harnessAuth: { ...harnessAuth, secretDriverId: secret.driverId },
    configuration: { agents: { defaults: { model: "openai/gpt-fixture" } } },
    harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
    compute: { id: "compute-test", implementation: "deterministic-test" },
    servicePrincipalId: agent.servicePrincipalId,
    repositoryCredentials: credentials,
    createdAt,
  };
  await store.transact(async (unit) => {
    if ((await unit.installations.getInstallation()) === undefined) {
      await unit.installations.createInstallation({
        id: `ins_${randomUUID()}`,
        name: "Repository session State contract",
        createdAt,
      });
    }
    // A ready Namespace and admitted revision represent a runtime that may open sessions.
    await unit.namespaces.createNamespace(namespace);
    await unit.configurations.createConfiguration(configuration);
    await unit.secrets.createSecret(secret);
    await unit.agents.createAgent(agent);
    await unit.revisions.createRevision(revision);
    await unit.agents.transitionAgentDesiredRuntimeState(
      namespace.id,
      agent.id,
      "stopped",
      "running",
    );
  });
  return { namespace, configuration, agent, revision };
}

export function sessionAttempt(revision, overrides = {}) {
  return {
    namespaceId: revision.namespaceId,
    agentId: revision.agentId,
    revisionId: revision.id,
    repositoryRef: "source",
    admissionId: `admission-${randomUUID()}`,
    durationSeconds: 60,
    deadlineWallMs: revision.repositoryCredentials.deadlineWallMs,
    createdAt: revision.createdAt,
    ...overrides,
  };
}

const later = "2030-03-17T17:46:41.000Z";
const scopeError = { name: "ScopeViolationError" };

export async function verifyRepositorySessions(t, store) {
  await t.test(
    "draft updates preserve or clear selections without changing the admitted snapshot",
    async () => {
      const credentials = repositoryCredentials();
      // Backend grant identities are opaque UTF-8 strings, not normalized route tokens.
      credentials.driver.id = " driver identity ";
      credentials.driver.implementation = "é".repeat(256);
      credentials.bindings[0].backendId = "😀".repeat(100);
      credentials.bindings[0].grant.providerInstanceId = "é".repeat(256);
      credentials.bindings[0].grant.repositoryId = " repository/é ";
      const expectedCredentials = structuredClone(credentials);
      const { namespace, configuration, agent, revision } = await seedSessionRevision(
        store,
        credentials,
      );
      credentials.bindings[0].grant.repositoryId = "changed-after-admission";
      const saved = await store.read((view) =>
        view.revisions.findRevision(namespace.id, agent.id, revision.id),
      );
      assert.deepEqual(saved.repositoryCredentials, expectedCredentials);
      assert.ok(Object.isFrozen(saved.repositoryCredentials.bindings[0].grant));
      await store.transact(async (unit) => {
        const preserved = await unit.agents.updateConfiguration(
          namespace.id,
          agent.id,
          configuration.id,
        );
        assert.deepEqual(preserved.repositoryBindings, [
          { repositoryRef: "source", profile: "git-read" },
        ]);
        const replaced = await unit.agents.updateConfiguration(
          namespace.id,
          agent.id,
          configuration.id,
          undefined,
          undefined,
          undefined,
          undefined,
          [{ repositoryRef: "replacement", profile: "write" }],
        );
        assert.deepEqual(replaced.repositoryBindings, [
          { repositoryRef: "replacement", profile: "write" },
        ]);
        const cleared = await unit.agents.updateConfiguration(
          namespace.id,
          agent.id,
          configuration.id,
          undefined,
          undefined,
          undefined,
          undefined,
          [],
        );
        assert.equal(Object.hasOwn(cleared, "repositoryBindings"), false);
      });
      const unchanged = await store.read((view) =>
        view.revisions.findRevision(namespace.id, agent.id, revision.id),
      );
      assert.deepEqual(unchanged.repositoryCredentials, expectedCredentials);
      const current = await store.read((view) => view.agents.findAgent(namespace.id, agent.id));
      assert.equal(Object.hasOwn(current, "repositoryBindings"), false);

      // Revisions without a repository snapshot remain valid and gain no implicit admission.
      const { repositoryCredentials: _credentials, ...withoutCredentials } = revision;
      const unbound = { ...withoutCredentials, id: `rev_${randomUUID()}`, revision: 2 };
      await store.transact((unit) => unit.revisions.createRevision(unbound));
      const storedUnbound = await store.read((view) =>
        view.revisions.findRevision(namespace.id, agent.id, unbound.id),
      );
      assert.equal(Object.hasOwn(storedUnbound, "repositoryCredentials"), false);
      await assert.rejects(
        store.transact((unit) =>
          unit.repositorySessions.createAttempt(
            sessionAttempt(revision, { revisionId: unbound.id }),
          ),
        ),
        scopeError,
      );
    },
  );

  await t.test(
    "invalid draft and admitted repository identities cannot be persisted",
    async (t) => {
      const { namespace, configuration, agent, revision } = await seedSessionRevision(store);
      const invalidDrafts = {
        "repository reference contains a space": [{ repositoryRef: "bad ref", profile: "read" }],
        "repository reference ends with a newline": [
          { repositoryRef: "source\n", profile: "git-read" },
        ],
        "profile ends with a newline": [{ repositoryRef: "source", profile: "git-read\n" }],
        "profile is empty": [{ repositoryRef: "source", profile: "" }],
        "binding contains an extra field": [
          { repositoryRef: "source", profile: "read", bearer: "unexpected-field" },
        ],
        "repository reference appears twice": [
          { repositoryRef: "source", profile: "read" },
          { repositoryRef: "source", profile: "write" },
        ],
        "binding count exceeds sixteen": Array.from({ length: 17 }, (_, index) => ({
          repositoryRef: `source-${index}`,
          profile: "read",
        })),
      };
      for (const [name, bindings] of Object.entries(invalidDrafts)) {
        await t.test(`draft: ${name}`, async () => {
          await assert.rejects(
            store.transact((unit) =>
              unit.agents.updateConfiguration(
                namespace.id,
                agent.id,
                configuration.id,
                undefined,
                undefined,
                undefined,
                undefined,
                bindings,
              ),
            ),
            scopeError,
          );
        });
      }
      const invalidSnapshots = {
        "bindings are empty": repositoryCredentials({ bindings: [] }),
        "bindings are an object": repositoryCredentials({ bindings: {} }),
        "driver contains an extra field": repositoryCredentials({
          driver: { id: "repository-credentials", implementation: "github", bearer: "unexpected" },
        }),
        "binding contains an extra field": repositoryCredentials({
          bindings: [repositoryBinding({ bearer: "unexpected" })],
        }),
        "grant is null": repositoryCredentials({ bindings: [repositoryBinding({ grant: null })] }),
        "grant contains an extra field": repositoryCredentials({
          bindings: [repositoryBinding({ grant: repositoryGrant({ bearer: "unexpected" }) })],
        }),
        "deadline is zero": repositoryCredentials({ deadlineWallMs: 0 }),
        "deadline exceeds the safe integer range": repositoryCredentials({
          deadlineWallMs: Number.MAX_SAFE_INTEGER + 1,
        }),
        "driver identity is empty": repositoryCredentials({
          driver: { id: "", implementation: "native" },
        }),
        "driver identity exceeds 512 UTF-8 bytes": repositoryCredentials({
          driver: { id: `${"é".repeat(256)}x`, implementation: "github" },
        }),
        "provider identity contains surrounding spaces": repositoryCredentials({
          bindings: [repositoryBinding({ backendId: " provider " })],
        }),
        "provider identity exceeds 200 UTF-16 code units": repositoryCredentials({
          bindings: [repositoryBinding({ backendId: "😀".repeat(101) })],
        }),
        "provider identity starts with a nonbreaking space": repositoryCredentials({
          bindings: [repositoryBinding({ backendId: "\u00a0provider" })],
        }),
        "grant identity contains DEL": repositoryCredentials({
          bindings: [
            repositoryBinding({ grant: repositoryGrant({ grantId: "bad\u007fidentity" }) }),
          ],
        }),
        "grant identity exceeds 512 UTF-8 bytes": repositoryCredentials({
          bindings: [
            repositoryBinding({ grant: repositoryGrant({ grantId: `${"é".repeat(256)}x` }) }),
          ],
        }),
        "snapshot contains an extra field": repositoryCredentials({ bearer: "unexpected-field" }),
      };
      for (const [name, credentials] of Object.entries(invalidSnapshots)) {
        await t.test(`snapshot: ${name}`, async () => {
          await assert.rejects(
            store.transact((unit) =>
              unit.revisions.createRevision({
                ...revision,
                id: `rev_${randomUUID()}`,
                revision: 2,
                repositoryCredentials: credentials,
              }),
            ),
            scopeError,
          );
        });
      }
      assert.equal(
        (await store.read((view) => view.revisions.listRevisions(namespace.id, agent.id))).length,
        1,
      );
    },
  );

  await t.test(
    "attempts retain exact owners, admitted membership and immutable deadlines",
    async (t) => {
      const { revision } = await seedSessionRevision(store);
      const other = await seedSessionRevision(store);
      const invalidAttempts = {
        "namespace belongs to another revision": { namespaceId: other.namespace.id },
        "agent belongs to another revision": { agentId: other.agent.id },
        "repository was not admitted": { repositoryRef: "unadmitted" },
        "deadline differs from the admitted deadline": {
          deadlineWallMs: revision.repositoryCredentials.deadlineWallMs + 1,
        },
        "duration is zero": { durationSeconds: 0 },
        "duration exceeds the safe integer range": { durationSeconds: Number.MAX_SAFE_INTEGER + 1 },
        "admission identity contains a space": { admissionId: "bad admission" },
        "admission identity ends with a newline": { admissionId: "admission\n" },
      };
      for (const [name, override] of Object.entries(invalidAttempts)) {
        await t.test(name, async () => {
          await assert.rejects(
            store.transact((unit) =>
              unit.repositorySessions.createAttempt(sessionAttempt(revision, override)),
            ),
            scopeError,
          );
        });
      }
      // PostgreSQL rejects malformed bigint/timestamp representations while parsing parameters,
      // before CHECK constraints, with the SQLSTATE for that type; the in-memory store refuses
      // the same values through its input and timestamp validation.
      const malformedRepresentations = {
        "duration is fractional": [
          { durationSeconds: 1.5 },
          /The repository session input is invalid/,
          "22P02",
        ],
        "creation time is not a timestamp": [
          { createdAt: "not-a-timestamp" },
          /The repository session timestamp is invalid/,
          "22007",
        ],
      };
      for (const [name, [override, memoryMessage, sqlState]] of Object.entries(
        malformedRepresentations,
      )) {
        await t.test(name, async () => {
          await assert.rejects(
            store.transact((unit) =>
              unit.repositorySessions.createAttempt(sessionAttempt(revision, override)),
            ),
            (error) =>
              error.name === "ScopeViolationError"
                ? memoryMessage.test(error.message)
                : error.code === sqlState,
          );
        });
      }
      const input = sessionAttempt(revision);
      const opened = await store.transact((unit) => unit.repositorySessions.createAttempt(input));
      assert.deepEqual(opened, {
        ...input,
        liveRevisionId: revision.id,
        cleanupContext: {
          driver: revision.repositoryCredentials.driver,
          binding: revision.repositoryCredentials.bindings[0],
        },
        phase: "opening",
        brokerProtocol: 0,
        updatedAt: input.createdAt,
      });
      assert.ok(Object.isFrozen(opened));
      assert.ok(Object.isFrozen(opened.cleanupContext.binding.grant));
      assert.deepEqual(
        await store.read((view) => view.repositorySessions.findAttempt(input.admissionId)),
        opened,
      );
      assert.deepEqual(
        await store.read((view) =>
          view.repositorySessions.listRevisionAttempts({
            namespaceId: revision.namespaceId,
            agentId: revision.agentId,
            revisionId: revision.id,
          }),
        ),
        [opened],
      );
      assert.deepEqual(
        await store.read((view) =>
          view.repositorySessions.listNamespaceAttempts(other.namespace.id),
        ),
        [],
      );
      assert.deepEqual(
        await store.read((view) =>
          view.repositorySessions.listRevisionAttempts({
            namespaceId: revision.namespaceId,
            agentId: other.agent.id,
            revisionId: revision.id,
          }),
        ),
        [],
      );
      await assert.rejects(
        store.transact((unit) => unit.repositorySessions.createAttempt(input)),
        { name: "ResourceConflictError" },
      );
      await assert.rejects(
        store.transact((unit) => unit.repositorySessions.createAttempt(sessionAttempt(revision))),
        { name: "ResourceConflictError" },
      );
    },
  );

  await t.test(
    "phase CAS preserves known sessions and terminal evidence across replacement attempts",
    async () => {
      const { revision } = await seedSessionRevision(store);
      const input = sessionAttempt(revision);
      await store.transact((unit) => unit.repositorySessions.createAttempt(input));
      const sessionId = `session-${randomUUID()}`;
      const advance = (expectedPhase, phase, extra = {}) =>
        store.transact((unit) =>
          unit.repositorySessions.advanceAttempt({
            admissionId: input.admissionId,
            expectedPhase,
            phase,
            updatedAt: later,
            ...extra,
          }),
        );
      await assert.rejects(advance("opening", "open"), scopeError);
      await assert.rejects(advance("opening", "open", { sessionId: "bad session" }), scopeError);
      await assert.rejects(advance("opening", "open", { sessionId: "session\n" }), scopeError);
      await assert.rejects(
        advance("opening", "open", { sessionId, updatedAt: "2030-03-17T17:46:39.000Z" }),
        scopeError,
      );
      const open = await advance("opening", "open", { sessionId });
      assert.equal(open.sessionId, sessionId);
      assert.equal(await advance("opening", "invalidated"), undefined);
      await assert.rejects(
        advance("open", "closing", { sessionId: "different-session" }),
        scopeError,
      );
      const closing = await advance("open", "closing");
      assert.equal(closing.sessionId, sessionId);
      const disposed = await advance("closing", "disposed");
      assert.equal(disposed.sessionId, sessionId);
      assert.equal(disposed.phase, "disposed");
      await assert.rejects(advance("disposed", "open", { sessionId }), scopeError);
      const replacement = await store.transact((unit) =>
        unit.repositorySessions.createAttempt(sessionAttempt(revision)),
      );
      const attempts = await store.read((view) =>
        view.repositorySessions.listNamespaceAttempts(revision.namespaceId),
      );
      assert.equal(attempts.length, 2);
      assert.ok(
        attempts.some(
          (attempt) => attempt.admissionId === disposed.admissionId && attempt.phase === "disposed",
        ),
      );
      assert.ok(
        attempts.some(
          (attempt) =>
            attempt.admissionId === replacement.admissionId && attempt.phase === "opening",
        ),
      );
    },
  );

  await t.test(
    "closing can recover a session identity before disposal and unknown admissions can invalidate",
    async () => {
      const { revision } = await seedSessionRevision(store);
      const input = sessionAttempt(revision);
      await store.transact((unit) => unit.repositorySessions.createAttempt(input));
      await store.transact(async (unit) => {
        const closing = await unit.repositorySessions.advanceAttempt({
          admissionId: input.admissionId,
          expectedPhase: "opening",
          phase: "closing",
          updatedAt: later,
        });
        assert.equal(Object.hasOwn(closing, "sessionId"), false);
        const recovered = await unit.repositorySessions.advanceAttempt({
          admissionId: input.admissionId,
          expectedPhase: "closing",
          phase: "closing",
          sessionId: `session-${randomUUID()}`,
          updatedAt: later,
        });
        const disposed = await unit.repositorySessions.advanceAttempt({
          admissionId: input.admissionId,
          expectedPhase: "closing",
          phase: "disposed",
          updatedAt: later,
        });
        assert.equal(disposed.sessionId, recovered.sessionId);
      });
      const replacement = sessionAttempt(revision);
      await store.transact(async (unit) => {
        await unit.repositorySessions.createAttempt(replacement);
        const invalidated = await unit.repositorySessions.advanceAttempt({
          admissionId: replacement.admissionId,
          expectedPhase: "opening",
          phase: "invalidated",
          updatedAt: later,
        });
        assert.equal(invalidated.phase, "invalidated");
        assert.equal(Object.hasOwn(invalidated, "sessionId"), false);
      });
    },
  );

  await t.test(
    "rollback removes attempts and repository handles close after transaction exit",
    async () => {
      const { revision } = await seedSessionRevision(store);
      const input = sessionAttempt(revision);
      let escaped;
      const rollback = new Error("rollback session admission");
      await assert.rejects(
        store.transact(async (unit) => {
          escaped = unit.repositorySessions;
          await escaped.createAttempt(input);
          throw rollback;
        }),
        (error) => error === rollback,
      );
      assert.equal(
        await store.read((view) => view.repositorySessions.findAttempt(input.admissionId)),
        undefined,
      );
      await assert.rejects(escaped.findAttempt(input.admissionId), scopeError);
      await assert.rejects(escaped.createAttempt(input), scopeError);

      let accepted;
      let completed = false;
      await store.transact(async (unit) => {
        escaped = unit.repositorySessions;
        // Work admitted during the callback must drain before the transaction publishes.
        accepted = escaped.createAttempt(input).then((value) => {
          completed = true;
          return value;
        });
      });
      assert.equal(completed, true);
      assert.equal((await accepted).admissionId, input.admissionId);
      await assert.rejects(
        escaped.advanceAttempt({
          admissionId: input.admissionId,
          expectedPhase: "opening",
          phase: "invalidated",
          updatedAt: later,
        }),
        scopeError,
      );
      await store.read(async (view) => {
        escaped = view.repositorySessions;
        assert.equal(Object.hasOwn(escaped, "createAttempt"), false);
        assert.equal(Object.hasOwn(escaped, "advanceAttempt"), false);
        assert.equal((await escaped.findAttempt(input.admissionId)).phase, "opening");
      });
      await assert.rejects(escaped.findAttempt(input.admissionId), scopeError);
      await assert.rejects(escaped.listNamespaceAttempts(revision.namespaceId), scopeError);
    },
  );

  await t.test("deleting Namespaces retain closing session obligations for cleanup", async () => {
    const { namespace, agent, revision } = await seedSessionRevision(store);
    const input = sessionAttempt(revision);
    await store.transact(async (unit) => {
      await unit.repositorySessions.createAttempt(input);
      await unit.repositorySessions.advanceAttempt({
        admissionId: input.admissionId,
        expectedPhase: "opening",
        phase: "closing",
        updatedAt: later,
      });
      await unit.namespaces.transitionNamespaceStatus(namespace.id, "ready", "deleting");
    });
    // Closing sessions remain discoverable while the owning Namespace is being removed.
    await store.read(async (view) => {
      assert.equal((await view.namespaces.findNamespace(namespace.id)).status, "deleting");
      assert.ok(await view.revisions.findRevision(namespace.id, agent.id, revision.id));
      const attempts = await view.repositorySessions.listNamespaceAttempts(namespace.id);
      assert.equal(attempts.length, 1);
      assert.equal(attempts[0].admissionId, input.admissionId);
      assert.equal(attempts[0].phase, "closing");
    });
  });

  await t.test("stopped and deleting owners cannot admit new attempts", async () => {
    const { namespace, agent, revision } = await seedSessionRevision(store);
    await store.transact((unit) =>
      unit.agents.transitionAgentDesiredRuntimeState(namespace.id, agent.id, "running", "stopped"),
    );
    await assert.rejects(
      store.transact((unit) => unit.repositorySessions.createAttempt(sessionAttempt(revision))),
      scopeError,
    );
    await store.transact((unit) =>
      unit.agents.transitionAgentStatus(namespace.id, agent.id, "active", "deleting"),
    );
    await assert.rejects(
      store.transact((unit) => unit.repositorySessions.createAttempt(sessionAttempt(revision))),
      scopeError,
    );
    const other = await seedSessionRevision(store);
    await store.transact((unit) =>
      unit.namespaces.transitionNamespaceStatus(other.namespace.id, "ready", "deleting"),
    );
    await assert.rejects(
      store.transact((unit) =>
        unit.repositorySessions.createAttempt(sessionAttempt(other.revision)),
      ),
      scopeError,
    );
  });

  await t.test("concurrent expected-phase advances publish one winner", async () => {
    const { revision } = await seedSessionRevision(store);
    const input = sessionAttempt(revision);
    await store.transact((unit) => unit.repositorySessions.createAttempt(input));
    const results = await Promise.all(
      ["closing", "invalidated"].map((phase) =>
        store.transact((unit) =>
          unit.repositorySessions.advanceAttempt({
            admissionId: input.admissionId,
            expectedPhase: "opening",
            phase,
            updatedAt: later,
          }),
        ),
      ),
    );
    const winners = results.filter((result) => result !== undefined);
    assert.equal(winners.length, 1);
    assert.deepEqual(
      await store.read((view) => view.repositorySessions.findAttempt(input.admissionId)),
      winners[0],
    );
  });
}
