import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  nativeToolText as textOutput,
  nativeToolValue as jsonOutput,
  declaredFunction as declared,
} from "./automation-model-only-dispatch-scenarios.mjs";

const markerFor = (nonce, phase) => `OCE_DISPATCH_${phase.toUpperCase()}_${nonce}`;
const childMarker = (nonce, phase) => `OCE_DELEGATION_CHILD_${phase.toUpperCase()}_${nonce}`;
const labelFor = (nonce, phase) => `dispatch-child-${phase}-${nonce}`;

function call(name, args) {
  return { call: { type: "function_call", name, arguments: JSON.stringify(args) } };
}

export function createProviderStrategy({ nonce }) {
  let stage = "initial";
  let outerTool;
  let targetId;
  let discoveryTools;
  function spawnArgs(phase) {
    return {
      task: `Return exactly ${childMarker(nonce, phase)}. Do not use tools.`,
      label: labelFor(nonce, phase),
      runtime: "subagent",
      mode: "run",
      context: "isolated",
      cleanup: "keep",
      expectsCompletionMessage: false,
    };
  }
  function spawnCall(phase) {
    const args = spawnArgs(phase);
    return outerTool === "sessions_spawn"
      ? call(outerTool, args)
      : call(outerTool, { id: targetId, args });
  }
  function checkSpawnSchema(schema) {
    assert.equal(schema?.properties?.task?.type, "string");
    assert.equal(schema?.properties?.label?.type, "string");
    for (const name of Object.keys(spawnArgs("positive"))) {
      assert.ok(schema.properties[name], `the actual spawn schema must declare ${name}`);
    }
    assert.ok((schema.required ?? []).every((name) => Object.hasOwn(spawnArgs("positive"), name)));
  }
  return {
    auxiliary(body) {
      const input = JSON.stringify(
        (body.input ?? []).filter((item) => item.type === "message" && item.role === "user"),
      );
      if (
        input.includes(childMarker(nonce, "positive")) &&
        !["positive", "negative"].some((phase) => input.includes(markerFor(nonce, phase)))
      ) {
        return { text: childMarker(nonce, "positive") };
      }
      return undefined;
    },
    plan({ phase, tools, output }) {
      if (phase === "negative") {
        assert.ok(outerTool, "negative requires the successful positive callable");
        if (!output) {
          return spawnCall(phase);
        }
        assert.match(
          textOutput(output),
          /unknown tool|tool.{0,80}(?:not found|not available|unavailable|disabled)|unsupported.{0,40}(?:tool|call)|unrecognized.{0,40}tool|no tool/iu,
        );
        return {
          complete: true,
          summary: { family: "delegation", outerTool, targetTool: "sessions_spawn" },
        };
      }
      assert.equal(phase, "positive");
      if (stage === "initial") {
        assert.equal(output, undefined);
        if (tools.some((tool) => tool.name === "sessions_spawn")) {
          const tool = declared(tools, "sessions_spawn", ["task", "label"]);
          checkSpawnSchema(tool.parameters);
          outerTool = tool.name;
          stage = "spawned";
          return spawnCall(phase);
        }
        // The embedded Harness publishes deferred capabilities through its real
        // discovery controls. A catalog match is followed by an actual dispatch.
        declared(tools, "tool_search", ["query"]);
        declared(tools, "tool_describe", ["id"]);
        declared(tools, "dispatch_action", ["id", "args"]);
        discoveryTools = tools;
        stage = "searched";
        return call("tool_search", { query: "sessions_spawn", limit: 1 });
      }
      assert.ok(output, "each discovery or execution call must return correlated native output");
      if (stage === "searched") {
        const found = jsonOutput(output);
        assert.ok(Array.isArray(found));
        const matches = found.filter(
          (entry) => entry.name === "sessions_spawn" && entry.source === "openclaw",
        );
        assert.equal(matches.length, 1);
        assert.equal(typeof matches[0].id, "string");
        targetId = matches[0].id;
        stage = "described";
        return call("tool_describe", { id: targetId });
      }
      if (stage === "described") {
        const description = jsonOutput(output);
        assert.equal(description.id, targetId);
        assert.equal(description.name, "sessions_spawn");
        checkSpawnSchema(description.parameters);
        outerTool = declared(discoveryTools, "dispatch_action", ["id", "args"]).name;
        stage = "spawned";
        return spawnCall(phase);
      }
      assert.equal(stage, "spawned");
      let accepted = jsonOutput(output);
      if (outerTool === "dispatch_action") {
        assert.equal(accepted.tool?.id, targetId);
        assert.equal(accepted.tool?.name, "sessions_spawn");
        accepted = jsonOutput({ output: accepted.result?.content });
      }
      assert.equal(accepted.status, "accepted", "native delegation must really accept a child");
      assert.equal(typeof accepted.childSessionKey, "string");
      assert.equal(typeof accepted.runId, "string");
      stage = "complete";
      return {
        complete: true,
        summary: {
          family: "delegation",
          outerTool,
          targetTool: "sessions_spawn",
          childSessionKey: accepted.childSessionKey,
          childRunId: accepted.runId,
        },
      };
    },
  };
}

export async function verify({ rpc, nonce, providerRecords, parentSessionKey, until }) {
  const completed = providerRecords.filter(
    (entry) => entry.event === "scenario-completed" && entry.phase === "positive",
  );
  assert.equal(completed.length, 1);
  const accepted = completed[0].summary;
  assert.equal(accepted.family, "delegation");
  const listed = await rpc("sessions.list", {
    spawnedBy: parentSessionKey,
    label: labelFor(nonce, "positive"),
  });
  assert.ok(Array.isArray(listed.sessions));
  const children = listed.sessions.filter((entry) => entry.label === labelFor(nonce, "positive"));
  assert.equal(children.length, 1, "the ordinary parent must create exactly one labeled child");
  assert.equal(children[0].key, accepted.childSessionKey);
  assert.notEqual(children[0].key, parentSessionKey);
  await until(
    "actual delegated child completion",
    async () => {
      const result = await rpc("agent.wait", { runId: accepted.childRunId, timeoutMs: 1000 });
      assert.equal(result.runId, accepted.childRunId);
      if (["pending", "timeout"].includes(result.status) && result.endedAt === undefined) {
        return undefined;
      }
      assert.equal(result.status, "ok");
      return result;
    },
    90000,
  );
  const history = await rpc("chat.history", { sessionKey: accepted.childSessionKey, limit: 20 });
  assert.ok(Array.isArray(history.messages));
  assert.ok(
    history.messages.some((message) => {
      if (message.role !== "assistant") {
        return false;
      }
      assert.notEqual(message.stopReason, "error");
      const text =
        typeof message.content === "string"
          ? message.content
          : message.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n");
      return text.includes(childMarker(nonce, "positive"));
    }),
    "independent native history must contain the child's completed reply",
  );
  // Cron may remove its per-run alias while retaining a stable parent. Count
  // exact nonce labels in the real database, independent of session-list lineage
  // projection. The actual positive row proves this query reads the right state.
  const database = new DatabaseSync(
    "/home/node/.openclaw/agents/main/agent/openclaw-agent.sqlite",
    { readOnly: true },
  );
  let persisted;
  try {
    persisted = database
      .prepare(
        "SELECT session_key, label, spawned_by, parent_session_key FROM session_nodes WHERE label IN (?, ?)",
      )
      .all(labelFor(nonce, "positive"), labelFor(nonce, "negative"));
  } finally {
    database.close();
  }
  const persistedPositive = persisted.filter((row) => row.label === labelFor(nonce, "positive"));
  assert.equal(persistedPositive.length, 1);
  assert.equal(persistedPositive[0].session_key, accepted.childSessionKey);
  assert.equal(persistedPositive[0].spawned_by, parentSessionKey);
  assert.equal(persistedPositive[0].parent_session_key, parentSessionKey);
  assert.equal(
    persisted.filter((row) => row.label === labelFor(nonce, "negative")).length,
    0,
    "the scheduled attempt must create no child under any parent key",
  );
  return {
    family: "delegation",
    path: "Gateway sessions_spawn",
    nativeCodexCollaborationCovered: false,
    positiveEffectVerified: true,
    negativeEffectAbsent: true,
    positiveChildSessionKey: accepted.childSessionKey,
    positiveChildRunId: accepted.childRunId,
    parentLineageVerified: true,
    positiveChildCompletionVerified: true,
    positivePersistedChildCount: 1,
    negativePersistedChildCount: 0,
    negativeChildAbsent: true,
  };
}
