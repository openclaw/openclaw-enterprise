import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { zstdDecompressSync } from "node:zlib";
import { nativeToolText, nativeToolValue } from "./automation-model-only-dispatch-scenarios.mjs";

// Manual routed-proof fixture, not an image-smoke CI case. The preserved routed
// producer calls createProviderStrategy; the implementation plan records its
// source and images. Direct execution only rechecks retained native-state evidence.
const namespace = "multi_agent_v1";
const parentMarker = (nonce, phase) => `OCE_DISPATCH_${phase.toUpperCase()}_${nonce}`;
const childMarker = (nonce, phase) => `OCE_NATIVE_CHILD_${phase.toUpperCase()}_${nonce}`;

function declared(tools, name, fields) {
  const matches = tools.filter(
    (tool) => tool.type === "function" && tool.namespace === namespace && tool.name === name,
  );
  assert.equal(matches.length, 1, `the actual native request must advertise ${namespace}.${name}`);
  for (const field of fields) {
    assert.ok(
      matches[0].parameters?.properties?.[field],
      `the native ${name} schema must declare ${field}`,
    );
  }
  return matches[0];
}

function call(name, args) {
  // Native ResponseItem::FunctionCall carries namespace separately from name.
  // The actual packaged request supplies the descriptor and schema; local Rust
  // protocol/models.rs and handlers/multi_agents are protocol cross-checks only.
  return { call: { type: "function_call", namespace, name, arguments: JSON.stringify(args) } };
}

export function createProviderStrategy({ nonce, harness }) {
  assert.equal(harness, "codex");
  let stage = "initial";
  let childId;
  let waitCount = 0;
  let selected;
  const spawn = (phase) =>
    call("spawn_agent", {
      message: `Return exactly ${childMarker(nonce, phase)}. Do not call any tools.`,
      fork_context: false,
    });
  const wait = () => {
    assert.ok(++waitCount <= 3, "the child must complete within three native waits");
    return call("wait_agent", { targets: [childId], timeout_ms: 30000 });
  };
  return {
    auxiliary(body) {
      const user = JSON.stringify(
        (body.input ?? []).filter((item) => item.type === "message" && item.role === "user"),
      );
      if (
        user.includes(childMarker(nonce, "positive")) &&
        !["positive", "negative"].some((phase) => user.includes(parentMarker(nonce, phase)))
      ) {
        return { text: childMarker(nonce, "positive") };
      }
      return undefined;
    },
    plan({ phase, tools, output }) {
      if (phase === "negative") {
        assert.ok(selected, "the negative case reuses the verified positive namespace and schema");
        if (!output) {
          return spawn(phase);
        }
        const refusal = nativeToolText(output).trim();
        // A missing relay/credential/transport is setup failure, never proof of
        // the scheduled tool cap. Require the native router's unavailable-call
        // boundary for this exact attempted function.
        assert.doesNotMatch(
          refusal,
          /hook|relay|transport|auth|credential|permission denied|timeout/iu,
        );
        assert.match(refusal, /^unsupported call: /u);
        assert.ok(
          refusal.endsWith("spawn_agent"),
          "native refusal must name the attempted spawn function",
        );
        return {
          complete: true,
          summary: { family: "native-collaboration", namespace, tool: "spawn_agent" },
        };
      }
      assert.equal(phase, "positive");
      if (stage === "initial") {
        assert.equal(output, undefined);
        selected = declared(tools, "spawn_agent", ["message", "fork_context"]);
        assert.equal(selected.parameters.properties.message.type, "string");
        assert.equal(selected.parameters.properties.fork_context.type, "boolean");
        assert.ok(
          (selected.parameters.required ?? []).every((field) =>
            ["message", "fork_context"].includes(field),
          ),
        );
        const waiter = declared(tools, "wait_agent", ["targets", "timeout_ms"]);
        assert.equal(waiter.parameters.properties.targets.type, "array");
        assert.equal(waiter.parameters.properties.targets.items.type, "string");
        assert.ok(
          (waiter.parameters.required ?? []).every((field) =>
            ["targets", "timeout_ms"].includes(field),
          ),
        );
        stage = "spawned";
        return spawn(phase);
      }
      assert.ok(output, "native collaboration requires correlated native output");
      if (stage === "spawned") {
        const result = nativeToolValue(output);
        assert.ok(typeof result.agent_id === "string" && result.agent_id.length > 0);
        childId = result.agent_id;
        stage = "waiting";
        return wait();
      }
      assert.equal(stage, "waiting");
      const result = nativeToolValue(output);
      assert.equal(typeof result.timed_out, "boolean");
      assert.ok(result.status && typeof result.status === "object");
      if (result.timed_out && Object.keys(result.status).length === 0) {
        return wait();
      }
      // Native wait may key its result by the child's canonical agent path.
      // We requested exactly one returned child ID; its independent rollout
      // below supplies the identity check, while this proves native completion.
      const statuses = Object.values(result.status);
      assert.equal(statuses.length, 1);
      assert.equal(typeof statuses[0]?.completed, "string");
      assert.ok(statuses[0].completed.includes(childMarker(nonce, "positive")));
      stage = "complete";
      return {
        complete: true,
        summary: {
          family: "native-collaboration",
          namespace,
          tool: "spawn_agent",
          childThreadId: childId,
          nativeWaitCompleted: true,
        },
      };
    },
  };
}

function positiveSummary(providerRecords) {
  const completed = providerRecords.filter(
    (record) => record.event === "scenario-completed" && record.phase === "positive",
  );
  assert.equal(completed.length, 1);
  const summary = completed[0].summary;
  assert.equal(summary.family, "native-collaboration");
  assert.equal(summary.namespace, namespace);
  assert.equal(summary.tool, "spawn_agent");
  assert.equal(summary.nativeWaitCompleted, true);
  assert.equal(typeof summary.childThreadId, "string");
  return summary;
}

/** Execute only in the actual dedicated Codex container; exports no transcript text. */
export function observeNativeState({ nonce }) {
  const home = process.env.CODEX_HOME;
  assert.ok(
    typeof home === "string" && isAbsolute(home),
    "the Agent must declare its native state directory",
  );
  const markers = {
    positiveParent: parentMarker(nonce, "positive"),
    negativeParent: parentMarker(nonce, "negative"),
    positiveChild: childMarker(nonce, "positive"),
    negativeChild: childMarker(nonce, "negative"),
  };
  const threads = new Map();
  let filesScanned = 0;
  function textOf(content) {
    if (typeof content === "string") {
      return content;
    }
    if (!Array.isArray(content)) {
      return "";
    }
    return content
      .filter((part) => ["text", "input_text", "output_text", "Text"].includes(part.type))
      .map((part) => part.text ?? "")
      .join("\n");
  }
  function scan(directory, depth = 0) {
    if (!existsSync(directory)) {
      return;
    }
    assert.ok(depth <= 8, "native rollout scan depth exceeded");
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) {
        scan(file, depth + 1);
        continue;
      }
      if (!entry.isFile() || !/\.jsonl(?:\.zst)?$/u.test(file)) {
        continue;
      }
      // Native readers prefer plain data when compression leaves both copies.
      if (file.endsWith(".zst") && existsSync(file.slice(0, -4))) {
        continue;
      }
      assert.ok(++filesScanned <= 1000, "native rollout scan count exceeded");
      assert.ok(statSync(file).size <= 8388608, "native rollout exceeds bounded reader");
      const bytes = readFileSync(file);
      const text = (
        file.endsWith(".zst") ? zstdDecompressSync(bytes, { maxOutputLength: 8388608 }) : bytes
      ).toString("utf8");
      // Parse a valid final row even without a newline. Truncation must fail
      // explicitly instead of concealing a last child or completion event.
      const rows = text
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const metas = rows.filter((row) => row.type === "session_meta");
      assert.equal(metas.length, 1, "each native rollout must identify exactly one thread");
      const meta = metas[0].payload;
      assert.equal(typeof meta.id, "string");
      assert.ok(!threads.has(meta.id), "duplicate native thread storage is ambiguous");
      const observed = {
        id: meta.id,
        parentThreadId: meta.parent_thread_id ?? null,
        forkedFromId: meta.forked_from_id ?? null,
        userMarkers: Object.fromEntries(Object.keys(markers).map((key) => [key, false])),
        assistantMarkers: Object.fromEntries(Object.keys(markers).map((key) => [key, false])),
        successfulCompletion: false,
        failedCompletion: false,
      };
      function observeMessage(role, content) {
        const flags =
          role === "user"
            ? observed.userMarkers
            : role === "assistant"
              ? observed.assistantMarkers
              : undefined;
        if (flags) {
          const value = textOf(content);
          for (const [key, marker] of Object.entries(markers)) {
            flags[key] ||= value.includes(marker);
          }
        }
      }
      for (const row of rows) {
        const payload = row.payload;
        if (!payload || typeof payload !== "object") {
          continue;
        }
        if (row.type === "response_item" && payload.type === "message") {
          observeMessage(payload.role, payload.content);
        }
        if (row.type !== "event_msg") {
          continue;
        }
        if (payload.type === "user_message") {
          observeMessage("user", payload.message);
        } else if (payload.type === "agent_message") {
          observeMessage("assistant", payload.message);
        } else if (payload.type === "item_completed") {
          if (payload.item?.type === "UserMessage") {
            observeMessage("user", payload.item.content);
          } else if (payload.item?.type === "AgentMessage") {
            observeMessage("assistant", payload.item.content);
          }
        } else if (["task_complete", "turn_complete"].includes(payload.type)) {
          observed.successfulCompletion ||= payload.error == null;
          observed.failedCompletion ||= payload.error != null;
        } else if (payload.type === "turn_aborted") {
          observed.failedCompletion = true;
        }
      }
      threads.set(meta.id, observed);
    }
  }
  scan(join(home, "sessions"));
  scan(join(home, "archived_sessions"));
  return { source: "actual-agent-native-rollouts", filesScanned, threads: [...threads.values()] };
}

/** Host-side assertion over the separate, real Agent readback; no runtime decisions are simulated. */
export function verifyNativeState({ observed, providerRecords }) {
  const summary = positiveSummary(providerRecords);
  assert.equal(observed.source, "actual-agent-native-rollouts");
  assert.ok(observed.filesScanned >= 3 && Array.isArray(observed.threads));
  const one = (predicate, label) => {
    const matches = observed.threads.filter(predicate);
    assert.equal(matches.length, 1, label);
    return matches[0];
  };
  const parent = one(
    (thread) => thread.userMarkers.positiveParent,
    "one actual ordinary parent thread",
  );
  const negative = one(
    (thread) => thread.userMarkers.negativeParent,
    "one actual scheduled parent thread",
  );
  assert.notEqual(parent.id, negative.id);
  const child = one(
    (thread) => thread.id === summary.childThreadId,
    "the returned child must really exist",
  );
  assert.equal(child.parentThreadId, parent.id);
  assert.equal(child.forkedFromId, null);
  assert.equal(child.userMarkers.positiveChild, true);
  assert.equal(child.assistantMarkers.positiveChild, true);
  assert.equal(child.successfulCompletion, true);
  assert.equal(child.failedCompletion, false);
  // Native completion notifications can quote the child task in its parent's
  // user transcript. Count actual child relations, not those textual mentions.
  const positiveChildren = observed.threads.filter((thread) => thread.parentThreadId === parent.id);
  assert.equal(positiveChildren.length, 1);
  assert.equal(positiveChildren[0].id, child.id);
  assert.equal(
    observed.threads.filter(
      (thread) =>
        thread.id !== parent.id && thread.id !== negative.id && thread.userMarkers.negativeChild,
    ).length,
    0,
    "no child task with the scheduled nonce may exist under any parent",
  );
  assert.equal(
    observed.threads.filter((thread) => thread.parentThreadId === negative.id).length,
    0,
    "the scheduled native parent must create no child, even before its prompt is persisted",
  );
  return {
    family: "native-collaboration",
    namespace,
    tool: "spawn_agent",
    positiveEffectVerified: true,
    negativeEffectAbsent: true,
    parentThreadId: parent.id,
    childThreadId: child.id,
    scheduledParentThreadId: negative.id,
    nativeChildCompletionVerified: true,
    parentLineageVerified: true,
    negativeChildCount: 0,
    observationSource: observed.source,
    declarationSource: "actual packaged Harness provider request",
    protocolCrossCheck: "local native Rust source; actual runtime acceptance required",
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.equal(
    process.argv.length,
    4,
    "Usage: node <fixture> <routed-control-result.json> <native-state-readback-final.json>",
  );
  const report = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const observed = JSON.parse(readFileSync(process.argv[3], "utf8"));
  const evidence = verifyNativeState({ observed, providerRecords: report.provider.records });
  console.log(
    JSON.stringify({
      scope: "retained native collaboration state assertions only",
      modelReplay: false,
      evidence,
    }),
  );
}
