import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import type {
  Agent,
  AgentRevision,
  Configuration,
  Namespace,
  RepositoryBindingSelection,
  RepositoryRevisionState,
} from "@openclaw-enterprise/contracts";
import { RepositorySessionWithdrawnError } from "../../packages/occ/src/errors.ts";
import type {
  RepositorySessionPhase,
  RepositorySessionRepository,
} from "../../packages/occ/src/ports/repository-sessions.ts";
import { repositoryRemovalWorkKey } from "../../packages/occ/src/repository-withdrawal.ts";
import type { PlatformStateStore } from "../../packages/occ/src/state/platform-state.ts";
import {
  repositoryBinding,
  repositoryCredentials,
  repositoryGrant,
} from "../fixtures/repository-credentials/session-state.mjs";

type CreateAttemptInput = Parameters<RepositorySessionRepository["createAttempt"]>[0];
type AdvanceAttemptInput = Parameters<RepositorySessionRepository["advanceAttempt"]>[0];

type SessionRevision = AgentRevision & { readonly repositoryCredentials: RepositoryRevisionState };

interface SeededSessionRevision {
  readonly namespace: Pick<Namespace, "id">;
  readonly configuration: Pick<Configuration, "id">;
  readonly agent: Pick<Agent, "id" | "repositoryBindings">;
  readonly revision: SessionRevision;
}

export interface RepositorySessionCaseBuilders {
  seedSessionRevision(
    store: PlatformStateStore,
    credentials?: ReturnType<typeof repositoryCredentials>,
  ): Promise<SeededSessionRevision>;
  sessionAttempt(
    revision: SessionRevision,
    overrides?: Partial<CreateAttemptInput>,
  ): CreateAttemptInput;
}

const later = "2030-03-17T17:46:41.000Z";
const scopeError = { name: "ScopeViolationError" };

export async function verifyRepositorySessionCases(
  t: TestContext,
  store: PlatformStateStore,
  { seedSessionRevision, sessionAttempt }: RepositorySessionCaseBuilders,
) {
  await t.test(
    "draft updates preserve or clear selections without changing the admitted snapshot",
    async () => {
      const credentials = repositoryCredentials();
      // Backend grant identities are opaque UTF-8 strings, not normalized route tokens.
      credentials.driver.id = " driver identity ";
      credentials.driver.implementation = "é".repeat(256);
      const [binding] = credentials.bindings;
      assert.ok(binding);
      binding.backendId = "😀".repeat(100);
      binding.grant.providerInstanceId = "é".repeat(256);
      binding.grant.repositoryId = " repository/é ";
      const expectedCredentials = structuredClone(credentials);
      const { namespace, configuration, agent, revision } = await seedSessionRevision(
        store,
        credentials,
      );
      binding.grant.repositoryId = "changed-after-admission";
      const saved = await store.read((view) =>
        view.revisions.findRevision(namespace.id, agent.id, revision.id),
      );
      const snapshot = saved?.repositoryCredentials;
      assert.deepEqual(snapshot, expectedCredentials);
      const [savedBinding] = snapshot.bindings;
      assert.ok(savedBinding);
      assert.ok(Object.isFrozen(savedBinding.grant));
      await store.transact(async (unit) => {
        const preserved = await unit.agents.updateConfiguration(
          namespace.id,
          agent.id,
          configuration.id,
        );
        assert.deepEqual(preserved?.repositoryBindings, [
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
        assert.deepEqual(replaced?.repositoryBindings, [
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
        assert.ok(cleared);
        assert.equal(Object.hasOwn(cleared, "repositoryBindings"), false);
      });
      const unchanged = await store.read((view) =>
        view.revisions.findRevision(namespace.id, agent.id, revision.id),
      );
      assert.deepEqual(unchanged?.repositoryCredentials, expectedCredentials);
      const current = await store.read((view) => view.agents.findAgent(namespace.id, agent.id));
      assert.ok(current);
      assert.equal(Object.hasOwn(current, "repositoryBindings"), false);

      // Revisions without a repository snapshot remain valid and gain no implicit admission.
      const { repositoryCredentials: _credentials, ...withoutCredentials } = revision;
      const unbound = { ...withoutCredentials, id: `rev_${randomUUID()}`, revision: 2 };
      await store.transact((unit) => unit.revisions.createRevision(unbound));
      const storedUnbound = await store.read((view) =>
        view.revisions.findRevision(namespace.id, agent.id, unbound.id),
      );
      assert.ok(storedUnbound);
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

  for (const intent of ["running", "stopped"] as const) {
    await t.test(
      `finite withdrawal with ${intent} intent requires original deployment authority and commits atomically`,
      async () => {
        const { namespace, agent, revision, configuration } = await seedSessionRevision(store);
        const owner = { namespaceId: namespace.id, agentId: agent.id, revisionId: revision.id };
        const attempt = sessionAttempt(revision);
        await store.transact(async (unit) => {
          await unit.agents.compareAndSetActiveRevision(
            namespace.id,
            agent.id,
            undefined,
            revision.id,
          );
          await unit.repositorySessions.createAttempt(attempt);
        });
        const remove = () =>
          store.transact(async (unit) => {
            await unit.namespaces.lockNamespace(namespace.id);
            await unit.agents.lockAgent(namespace.id, agent.id);
            await unit.agents.updateConfiguration(
              namespace.id,
              agent.id,
              configuration.id,
              undefined,
              undefined,
              undefined,
              undefined,
              [],
            );
            await unit.repositorySessions.withdrawFinite(owner, later);
          });
        const key = repositoryRemovalWorkKey(revision.id);
        if (intent === "stopped") {
          await store.transact((unit) =>
            unit.agents.transitionAgentDesiredRuntimeState(
              namespace.id,
              agent.id,
              "running",
              "stopped",
            ),
          );
        }
        // An editor cannot substitute for missing original runtime authority. Failed mutation
        // must preserve both configuration and opening-session custody in either State adapter.
        await assert.rejects(remove(), scopeError);
        const unchanged = await store.read((view) => view.agents.findAgent(namespace.id, agent.id));
        assert.ok(unchanged);
        assert.deepEqual(unchanged.repositoryBindings, agent.repositoryBindings);
        assert.equal(
          (await store.read((v) => v.repositorySessions.findAttempt(attempt.admissionId)))?.phase,
          "opening",
        );
        assert.equal(await store.read((v) => v.operations.findWork(key)), undefined);
        const actorId = "original-deployer";
        await store.transact((unit) =>
          unit.operations.append({
            kind: "agent_revision",
            action: "reconcile",
            namespaceId: namespace.id,
            resourceId: revision.id,
            actorId,
          }),
        );
        await remove();
        const work = await store.read((v) => v.operations.findWork(key));
        assert.ok(work);
        assert.equal(work.actorId, actorId);
        assert.equal(work.state, "queued");
        assert.equal(work.revisionId, revision.id);
        assert.equal(
          (await store.read((v) => v.repositorySessions.findAttempt(attempt.admissionId)))?.phase,
          "closing",
        );
        await remove();
        assert.deepEqual(
          await store.read((v) => v.operations.findWork(key)),
          work,
          "repeat removal retains original work custody",
        );
        // Disposal and a later editable re-add cannot revive the immutable admission.
        await store.transact(async (unit) => {
          await unit.repositorySessions.advanceAttempt({
            admissionId: attempt.admissionId,
            expectedPhase: "closing",
            phase: "disposed",
            sessionId: `session-${randomUUID()}`,
            updatedAt: later,
          });
          await unit.agents.updateConfiguration(
            namespace.id,
            agent.id,
            configuration.id,
            undefined,
            undefined,
            undefined,
            undefined,
            agent.repositoryBindings,
          );
        });
        if (intent === "stopped") {
          await store.transact((unit) =>
            unit.agents.transitionAgentDesiredRuntimeState(
              namespace.id,
              agent.id,
              "stopped",
              "running",
            ),
          );
        }
        await assert.rejects(
          store.transact((unit) => unit.repositorySessions.createAttempt(sessionAttempt(revision))),
          RepositorySessionWithdrawnError,
        );
        assert.equal(
          (await store.read((view) => view.repositorySessions.listRevisionAttempts(owner))).length,
          1,
        );
      },
    );
  }

  await t.test(
    "invalid draft and admitted repository identities cannot be persisted",
    async (t) => {
      const { namespace, configuration, agent, revision } = await seedSessionRevision(store);
      const invalidDrafts: Record<string, (RepositoryBindingSelection & { bearer?: string })[]> = {
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
        "bindings are empty": { ...repositoryCredentials(), bindings: [] },
        "bindings are an object": { ...repositoryCredentials(), bindings: {} },
        "driver contains an extra field": {
          ...repositoryCredentials(),
          driver: { id: "repository-credentials", implementation: "github", bearer: "unexpected" },
        },
        "binding contains an extra field": {
          ...repositoryCredentials(),
          bindings: [{ ...repositoryBinding(), bearer: "unexpected" }],
        },
        "grant is null": {
          ...repositoryCredentials(),
          bindings: [{ ...repositoryBinding(), grant: null }],
        },
        "grant contains an extra field": {
          ...repositoryCredentials(),
          bindings: [
            { ...repositoryBinding(), grant: { ...repositoryGrant(), bearer: "unexpected" } },
          ],
        },
        "deadline is zero": { ...repositoryCredentials(), deadlineWallMs: 0 },
        "deadline exceeds the safe integer range": {
          ...repositoryCredentials(),
          deadlineWallMs: Number.MAX_SAFE_INTEGER + 1,
        },
        "driver identity is empty": {
          ...repositoryCredentials(),
          driver: { id: "", implementation: "native" },
        },
        "driver identity exceeds 512 UTF-8 bytes": {
          ...repositoryCredentials(),
          driver: { id: `${"é".repeat(256)}x`, implementation: "github" },
        },
        "provider identity contains surrounding spaces": {
          ...repositoryCredentials(),
          bindings: [{ ...repositoryBinding(), backendId: " provider " }],
        },
        "provider identity exceeds 200 UTF-16 code units": {
          ...repositoryCredentials(),
          bindings: [{ ...repositoryBinding(), backendId: "😀".repeat(101) }],
        },
        "provider identity starts with a nonbreaking space": {
          ...repositoryCredentials(),
          bindings: [{ ...repositoryBinding(), backendId: "\u00a0provider" }],
        },
        "grant identity contains DEL": {
          ...repositoryCredentials(),
          bindings: [
            {
              ...repositoryBinding(),
              grant: { ...repositoryGrant(), grantId: "bad\u007fidentity" },
            },
          ],
        },
        "grant identity exceeds 512 UTF-8 bytes": {
          ...repositoryCredentials(),
          bindings: [
            {
              ...repositoryBinding(),
              grant: { ...repositoryGrant(), grantId: `${"é".repeat(256)}x` },
            },
          ],
        },
        "snapshot contains an extra field": {
          ...repositoryCredentials(),
          bearer: "unexpected-field",
        },
      };
      for (const [name, credentials] of Object.entries(invalidSnapshots)) {
        await t.test(`snapshot: ${name}`, async () => {
          await assert.rejects(
            store.transact((unit) =>
              unit.revisions.createRevision({
                ...revision,
                id: `rev_${randomUUID()}`,
                revision: 2,
                // Send the malformed fixture to the State boundary without normalizing it.
                repositoryCredentials: credentials as RepositoryRevisionState,
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
      const invalidAttempts: Record<string, Partial<CreateAttemptInput>> = {
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
      const malformedRepresentations: Record<
        string,
        [override: Partial<CreateAttemptInput>, memoryMessage: RegExp, sqlState: string]
      > = {
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
            (error: unknown) =>
              error instanceof Error &&
              (error.name === "ScopeViolationError"
                ? memoryMessage.test(error.message)
                : "code" in error && error.code === sqlState),
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
      const advance = (
        expectedPhase: RepositorySessionPhase,
        phase: RepositorySessionPhase,
        extra: Partial<Pick<AdvanceAttemptInput, "sessionId" | "updatedAt">> = {},
      ) =>
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
      assert.equal(open?.sessionId, sessionId);
      assert.equal(await advance("opening", "invalidated"), undefined);
      await assert.rejects(
        advance("open", "closing", { sessionId: "different-session" }),
        scopeError,
      );
      const closing = await advance("open", "closing");
      assert.equal(closing?.sessionId, sessionId);
      const disposed = await advance("closing", "disposed");
      assert.ok(disposed);
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
        assert.ok(closing);
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
        assert.ok(recovered);
        assert.ok(disposed);
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
        assert.ok(invalidated);
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
      const rolledBack: { sessions?: RepositorySessionRepository } = {};
      const rollback = new Error("rollback session admission");
      await assert.rejects(
        store.transact(async (unit) => {
          rolledBack.sessions = unit.repositorySessions;
          await unit.repositorySessions.createAttempt(input);
          throw rollback;
        }),
        (error) => error === rollback,
      );
      assert.equal(
        await store.read((view) => view.repositorySessions.findAttempt(input.admissionId)),
        undefined,
      );
      const rolledBackSessions = rolledBack.sessions;
      assert.ok(rolledBackSessions);
      await assert.rejects(rolledBackSessions.findAttempt(input.admissionId), scopeError);
      await assert.rejects(rolledBackSessions.createAttempt(input), scopeError);

      let completed = false;
      const { sessions, accepted } = await store.transact(async (unit) => {
        const sessions = unit.repositorySessions;
        // Work admitted during the callback must drain before the transaction publishes.
        const accepted = sessions.createAttempt(input).then((value) => {
          completed = true;
          return value;
        });
        return { sessions, accepted };
      });
      assert.equal(completed, true);
      assert.equal((await accepted).admissionId, input.admissionId);
      await assert.rejects(
        sessions.advanceAttempt({
          admissionId: input.admissionId,
          expectedPhase: "opening",
          phase: "invalidated",
          updatedAt: later,
        }),
        scopeError,
      );
      const escapedRead = await store.read(async (view) => {
        const sessions = view.repositorySessions;
        assert.equal(Object.hasOwn(sessions, "createAttempt"), false);
        assert.equal(Object.hasOwn(sessions, "advanceAttempt"), false);
        assert.equal((await sessions.findAttempt(input.admissionId))?.phase, "opening");
        return sessions;
      });
      await assert.rejects(escapedRead.findAttempt(input.admissionId), scopeError);
      await assert.rejects(escapedRead.listNamespaceAttempts(revision.namespaceId), scopeError);
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
      assert.equal((await view.namespaces.findNamespace(namespace.id))?.status, "deleting");
      assert.ok(await view.revisions.findRevision(namespace.id, agent.id, revision.id));
      const attempts = await view.repositorySessions.listNamespaceAttempts(namespace.id);
      assert.equal(attempts.length, 1);
      assert.equal(attempts[0]?.admissionId, input.admissionId);
      assert.equal(attempts[0]?.phase, "closing");
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
      (["closing", "invalidated"] as const).map((phase) =>
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
