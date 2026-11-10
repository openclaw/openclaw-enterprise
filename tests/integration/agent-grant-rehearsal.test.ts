import assert from "node:assert/strict";
import test from "node:test";
import { runAgentGrantRehearsal } from "../helpers/agent-grant-rehearsal.ts";

const initial = {
  agentId: "agent",
  revisionId: "revision",
  runtimeId: "sandbox",
  sessionId: "session",
  turnId: "first-turn",
};
const next = { ...initial, turnId: "next-turn" };
const firstSha = "a".repeat(40);
const nextSha = "b".repeat(40);
const fetched = {
  expectedSha: firstSha,
  beforePresent: false,
  afterSha: firstSha,
  originRequests: 3,
};
const refused = {
  expectedSha: nextSha,
  beforePresent: false,
  afterPresent: false,
  exitCode: 128,
  originRequests: 0,
};

test("grant rehearsal rejects a cached or wrong Git object", (t) =>
  runAgentGrantRehearsal(t, (scenario) => {
    scenario.modelBefore(initial);
    assert.throws(() => scenario.gitFetched({ ...fetched, beforePresent: true }), /already had/);
    assert.throws(
      () => scenario.gitFetched({ ...fetched, afterSha: nextSha }),
      /differs from origin/,
    );
    scenario.gitFetched(fetched);
    scenario.gitRefused(refused);
    scenario.modelAfter(next);
  }));

test("grant rehearsal requires a fresh denial without origin traffic or object arrival", (t) =>
  runAgentGrantRehearsal(t, (scenario) => {
    scenario.modelBefore(initial);
    scenario.gitFetched(fetched);
    assert.throws(
      () => scenario.gitRefused({ ...refused, expectedSha: firstSha }),
      /different origin commit/,
    );
    assert.throws(
      () => scenario.gitRefused({ ...refused, originRequests: 1 }),
      /reached the origin/,
    );
    assert.throws(
      () => scenario.gitRefused({ ...refused, exitCode: null }),
      /terminate with a fetch failure/,
    );
    assert.throws(
      () => scenario.gitRefused({ ...refused, afterPresent: true }),
      /entered the workload/,
    );
    scenario.gitRefused(refused);
    scenario.modelAfter(next);
  }));

test("grant rehearsal requires a new model turn on the original Agent session", (t) =>
  runAgentGrantRehearsal(t, (scenario) => {
    scenario.modelBefore(initial);
    scenario.gitFetched(fetched);
    assert.throws(() => scenario.modelAfter(next), /follows the withdrawal refusal/);
    scenario.gitRefused(refused);
    assert.throws(
      () => scenario.modelAfter({ ...next, runtimeId: "replacement" }),
      /original Agent session/,
    );
    assert.throws(
      () => scenario.modelAfter({ ...next, sessionId: "replacement" }),
      /original Agent session/,
    );
    assert.throws(() => scenario.modelAfter(initial), /requires a new turn/);
    scenario.modelAfter(next);
  }));

test("grant rehearsal fails when an adapter returns after Git refusal", async (t) => {
  await assert.rejects(
    runAgentGrantRehearsal(t, (scenario) => {
      scenario.modelBefore(initial);
      scenario.gitFetched(fetched);
      scenario.gitRefused(refused);
    }),
    /must observe a new model turn after Git withdrawal/,
  );
});
