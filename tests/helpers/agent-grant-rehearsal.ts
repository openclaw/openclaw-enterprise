import assert from "node:assert/strict";
import type { TestContext } from "node:test";

type ModelTurn = {
  agentId: string;
  revisionId: string;
  runtimeId: string;
  sessionId: string;
  turnId: string;
};

type GitObject = {
  expectedSha: string;
  beforePresent: boolean;
  originRequests: number;
};

export type AgentGrantRehearsal = {
  modelBefore(turn: ModelTurn): void;
  gitFetched(observed: GitObject & { afterSha: string }): void;
  gitRefused(observed: GitObject & { exitCode: number | null; afterPresent: boolean }): void;
  modelAfter(turn: ModelTurn): void;
};

function assertFreshObject({ expectedSha, beforePresent }: GitObject) {
  assert.match(expectedSha, /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u, "origin commit SHA");
  assert.equal(beforePresent, false, "the workload already had the origin commit");
}

// Adapters perform the real operations and own their resource cleanup via t.after.
// Pass independent provider and workload observations, never a synthesized success flag.
export async function runAgentGrantRehearsal(
  t: Pick<TestContext, "diagnostic">,
  run: (rehearsal: AgentGrantRehearsal) => void | Promise<void>,
) {
  let original: ModelTurn | undefined;
  let fetchedSha: string | undefined;
  let refused = false;
  let continued = false;
  const record = (check: string, facts: object) =>
    t.diagnostic(JSON.stringify({ check, ...facts }));

  await run({
    modelBefore(turn) {
      assert.equal(original, undefined, "initial turn already recorded");
      for (const id of [
        turn.agentId,
        turn.revisionId,
        turn.runtimeId,
        turn.sessionId,
        turn.turnId,
      ]) {
        assert.ok(id, "initial turn must identify its Agent, runtime, session and turn");
      }
      original = { ...turn };
      record("model-before", { turnId: turn.turnId });
    },

    gitFetched(observed) {
      assert.ok(original && !fetchedSha, "fetch follows the initial model turn");
      assertFreshObject(observed);
      assert.equal(observed.afterSha, observed.expectedSha, "fetched commit differs from origin");
      assert.ok(Number.isSafeInteger(observed.originRequests) && observed.originRequests > 0);
      fetchedSha = observed.expectedSha;
      record("git-fetched", { sha: fetchedSha, originRequests: observed.originRequests });
    },

    gitRefused(observed) {
      assert.ok(fetchedSha && !refused, "refusal follows the authorized fetch");
      assertFreshObject(observed);
      assert.notEqual(
        observed.expectedSha,
        fetchedSha,
        "withdrawal needs a different origin commit",
      );
      assert.equal(observed.originRequests, 0, "withdrawn Git reached the origin");
      assert.equal(observed.exitCode, 128, "withdrawn Git must terminate with a fetch failure");
      assert.equal(observed.afterPresent, false, "the refused commit entered the workload");
      refused = true;
      record("git-refused", { sha: observed.expectedSha, originRequests: observed.originRequests });
    },

    modelAfter(turn) {
      assert.ok(original && refused, "continuity follows the withdrawal refusal");
      assert.equal(continued, false, "continuity already recorded");
      const { turnId, ...identity } = turn;
      const { turnId: originalTurnId, ...originalIdentity } = original;
      assert.deepEqual(identity, originalIdentity, "the original Agent session must continue");
      assert.ok(turnId);
      assert.notEqual(turnId, originalTurnId, "continuity requires a new turn");
      continued = true;
      record("model-after", { turnId, sameSession: true });
    },
  });
  assert.ok(continued, "rehearsal must observe a new model turn after Git withdrawal");
}
