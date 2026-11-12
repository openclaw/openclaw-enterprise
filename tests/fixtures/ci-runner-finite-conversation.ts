import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import test from "node:test";

type ExpectedFailure = { status: "failed"; detail: string };
type Expected = { status: "passed" } | ExpectedFailure;

function fails(detail: string): ExpectedFailure {
  return { status: "failed", detail };
}

type Stage = "execution identity" | "target discovery" | "gateway identity" | "model turn";
function stageFailure(stage: Stage, detail: string) {
  return { kind: "stage" as const, name: stage, stage, expected: fails(detail) };
}

type ReadFailure =
  | "command"
  | "timeout"
  | "integrity"
  | "answer_missing"
  | "source"
  | "session_missing"
  | "transcript";
function readFailure(reason: ReadFailure) {
  return {
    kind: "read" as const,
    name: "read " + reason,
    stage: "persisted reply" as const,
    reason,
    expected: fails("persisted reply; read=" + reason),
  };
}

type TranscriptCase =
  | "direct"
  | "recovered"
  | "foreign answer"
  | "foreign prompt"
  | "missing run"
  | "nonterminal"
  | "foreign thread"
  | "item suffix"
  | "empty turn"
  | "duplicate before"
  | "duplicate after"
  | "unmarked before"
  | "unmarked after"
  | "prior error"
  | "later answer"
  | "stale sequence";
function transcript(
  variant: TranscriptCase,
  outcome: "success" | "run" | "source" | "integrity" | "sequence",
) {
  const expected: Expected =
    outcome === "success" ? { status: "passed" } : fails("persisted reply; read=" + outcome);
  return {
    kind: "transcript" as const,
    name: variant,
    stage: "persisted reply" as const,
    variant,
    expected,
  };
}

function probe(
  name: string,
  response: { error: string; status: number | string; extra?: string },
  detail: string,
) {
  return {
    kind: "probe" as const,
    name,
    stage: "model turn" as const,
    response,
    expected: fails("model turn; probe=" + detail),
  };
}

const interval = { start: 1794140000000, end: 1794140001000 };
const signature =
  "chat completion failed: WorkspaceAccessUnavailableError: Remote workspace skill discovery failed";
const unknownWarning = "chat completion failed: private-command-data";
const warningFields = { level: "warn", subsystem: "openai-compat" };

function line(message: string, time = interval.start + 500) {
  return new Date(time).toISOString() + " " + message + "\n";
}

function warning(message = signature, time = interval.start + 500) {
  return JSON.stringify({
    time: new Date(time).toISOString().replace("Z", "+00:00"),
    ...warningFields,
    message,
  });
}

const failureLine = line(warning());

type Observation =
  | "no_matching_warning"
  | "unrecognized_warning"
  | "workspace_skill_discovery_failure_observed"
  | "observation_unavailable"
  | "ambiguous";

function observe(
  name: string,
  observation: Observation,
  logs?: string,
  {
    drift,
    requestInterval = interval,
    expectedReads = 1,
  }: {
    drift?: 2 | 3;
    requestInterval?: { start: number | string; end: number };
    expectedReads?: 0 | 1;
  } = {},
) {
  return {
    kind: "observation" as const,
    name,
    stage: "model turn" as const,
    expected: fails("model turn; probe=upstream; HTTP=500; gateway=" + observation),
    logs,
    drift,
    requestInterval,
    expectedReads,
  };
}

// Place these two Gateway observations before the private readback controls so
// all four named diagnostics remain within the reporter's detail cap.
export const finiteConversationScenarios = [
  observe("empty Gateway logs", "no_matching_warning", ""),
  observe("unrecognized Gateway failure", "unrecognized_warning", line(warning(unknownWarning))),
  stageFailure("execution identity", "execution identity"),
  stageFailure("target discovery", "target discovery"),
  stageFailure("gateway identity", "gateway identity"),
  stageFailure("model turn", "model turn; probe=execution"),
  readFailure("command"),
  readFailure("timeout"),
  readFailure("integrity"),
  readFailure("answer_missing"),
  readFailure("source"),
  readFailure("session_missing"),
  readFailure("transcript"),
  transcript("direct", "success"),
  transcript("recovered", "success"),
  transcript("foreign answer", "run"),
  transcript("foreign prompt", "run"),
  transcript("missing run", "run"),
  transcript("nonterminal", "run"),
  transcript("foreign thread", "source"),
  transcript("item suffix", "source"),
  transcript("empty turn", "source"),
  transcript("duplicate before", "integrity"),
  transcript("duplicate after", "integrity"),
  transcript("unmarked before", "integrity"),
  transcript("unmarked after", "integrity"),
  transcript("prior error", "integrity"),
  transcript("later answer", "integrity"),
  transcript("stale sequence", "sequence"),
  observe("unique Gateway failure", "workspace_skill_discovery_failure_observed", failureLine),
  observe(
    "quoted subsystem prefix",
    "no_matching_warning",
    line("[workspace] [openai-compat] " + signature),
  ),
  observe(
    "missing producer time",
    "observation_unavailable",
    failureLine + line(JSON.stringify({ ...warningFields, message: signature })),
  ),
  observe(
    "invalid producer time",
    "observation_unavailable",
    line(
      JSON.stringify({
        time: "private-command-invalid-time",
        ...warningFields,
        message: signature,
      }),
    ),
  ),
  observe(
    "delayed capture",
    "workspace_skill_discovery_failure_observed",
    line(warning(), interval.end + 1),
  ),
  observe(
    "early capture",
    "workspace_skill_discovery_failure_observed",
    line(warning(), interval.start - 1),
  ),
  observe(
    "delayed competing warning",
    "ambiguous",
    failureLine + line(warning(unknownWarning), interval.end + 1),
  ),
  observe("old producer time", "no_matching_warning", line(warning(signature, interval.start - 1))),
  observe("later producer time", "no_matching_warning", line(warning(signature, interval.end + 1))),
  observe("ambiguous Gateway failure", "ambiguous", failureLine + line(warning(unknownWarning))),
  observe("background disconnect", "no_matching_warning", line("[workspace] " + signature)),
  observe("truncated Gateway logs", "observation_unavailable", failureLine + "x".repeat(65536)),
  observe("incomplete Gateway record", "observation_unavailable", failureLine.trimEnd()),
  observe("log read failure", "observation_unavailable"),
  observe("Gateway replaced before read", "observation_unavailable", failureLine, {
    drift: 2,
    expectedReads: 0,
  }),
  observe("Gateway restarted during read", "observation_unavailable", failureLine, { drift: 3 }),
  observe("invalid request interval", "observation_unavailable", failureLine, {
    requestInterval: { start: "private-command-data", end: interval.end },
    expectedReads: 0,
  }),
  probe(
    "unauthenticated HTTP 500",
    { error: "unauthenticated", status: 500 },
    "unauthenticated; HTTP=500",
  ),
  probe(
    "upstream status",
    { error: "upstream", status: 503, extra: "private-command-data" },
    "upstream; HTTP=503",
  ),
  probe("unknown probe", { error: "private-command-data", status: 503 }, "unexpected"),
  probe("invalid status", { error: "upstream", status: "private-command-data" }, "unexpected"),
];

type Scenario = (typeof finiteConversationScenarios)[number];
type ReadScenario = Extract<Scenario, { kind: "read" | "transcript" }>;

const agent = { id: "agent", namespaceId: "namespace", revision: { id: "revision" } };
const runId = "chatcmpl_20000000-0000-4000-8000-000000000001";

function gatewayPod(restartCount: number) {
  const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 12);
  return {
    metadata: {
      name: "gateway",
      namespace: "tenant",
      uid: "pod-uid",
      labels: {
        "app.kubernetes.io/managed-by": "openclaw-enterprise",
        "openclaw.dev/workload-role": "gateway",
        "openclaw.dev/namespace": agent.namespaceId,
        "openclaw.dev/agent": agent.id,
      },
    },
    spec: {
      containers: [{ name: "gateway" }],
      volumes: [
        { configMap: { name: "gateway-" + hash(agent.id) + "-rev-" + hash(agent.revision.id) } },
      ],
    },
    status: {
      phase: "Running",
      conditions: [{ type: "Ready", status: "True" }],
      containerStatuses: [
        {
          name: "gateway",
          containerID: "container",
          imageID: "image",
          restartCount,
          state: { running: { startedAt: "2026-01-01T00:00:00Z" } },
        },
      ],
    },
  };
}

function privateFailure(): never {
  throw Object.assign(new Error("private-command-data"), {
    stdout: "private-command-stdout",
    stderr: "private-command-stderr",
    cause: new Error("private-command-cause"),
  });
}

function assistantIdentity(variant: TranscriptCase) {
  switch (variant) {
    case "item suffix":
      return "turn:assistant:assistant";
    case "empty turn":
      return ":assistant";
    case "direct":
      return "turn:assistant";
    default:
      return "next:assistant";
  }
}

function answerRun(variant: TranscriptCase) {
  if (variant === "foreign answer") {
    return "other";
  }
  if (variant === "missing run") {
    return undefined;
  }
  return runId;
}

function seedTranscript(db: DatabaseSync, key: string, marker: string, scenario: ReadScenario) {
  db.exec(
    "CREATE TABLE session_nodes(session_key, current_session_id); CREATE TABLE transcript_events(session_id, seq INTEGER, event_json TEXT, event_zstd, event_utf8_bytes)",
  );
  if (scenario.kind === "read" && scenario.reason === "session_missing") {
    return;
  }

  db.prepare("INSERT INTO session_nodes VALUES (?, 'session')").run(key);
  const insert = db.prepare("INSERT INTO transcript_events VALUES ('session', ?, ?, null, null)");
  const variant = scenario.kind === "transcript" ? scenario.variant : undefined;
  const prompt = {
    role: "user",
    content: marker,
    __openclaw: {
      mirrorOrigin: "codex-app-server",
      mirrorIdentity: "turn:prompt",
      mirrorSourceFingerprint: "promptFingerprint",
      runId: variant === "foreign prompt" ? "other" : runId,
    },
  };
  const message = (value: object) => JSON.stringify({ type: "message", message: value });
  insert.run(
    1,
    scenario.kind === "read" && scenario.reason === "integrity" ? "malformed" : message(prompt),
  );
  if (scenario.kind === "read") {
    if (scenario.reason === "source") {
      insert.run(2, message({ role: "assistant", content: marker, stopReason: "stop" }));
    }
    return;
  }

  const identity = assistantIdentity(scenario.variant);
  const thread = variant === "foreign thread" ? "other" : "thread";
  const answer = {
    role: "assistant",
    content: marker,
    stopReason: "stop",
    idempotencyKey: `codex-app-server:${thread}:${identity}`,
    __openclaw: {
      mirrorOrigin: "codex-app-server",
      mirrorSourceFingerprint: "answerFingerprint",
      mirrorIdentity: identity,
      runId: answerRun(scenario.variant),
      runTerminal: variant !== "nonterminal",
    },
  };
  switch (variant) {
    case "duplicate before":
    case "duplicate after":
    case "unmarked before":
    case "unmarked after":
      insert.run(
        variant.endsWith("before") ? 2 : 4,
        message({
          ...answer,
          content: variant.startsWith("duplicate") ? marker : "earlier or later",
          idempotencyKey: "codex-app-server:thread:turn:assistant",
          __openclaw: { ...answer.__openclaw, mirrorIdentity: "turn:assistant" },
        }),
      );
      break;
    case "prior error":
      insert.run(2, message({ role: "assistant", stopReason: "error" }));
      break;
  }
  insert.run(3, message(answer));
  if (variant === "later answer") {
    insert.run(4, message({ role: "assistant", content: "later" }));
  }
}

export async function registerFiniteConversationTests() {
  // The outer test imports the inventory without initializing the child readers.
  const { DatabaseSync } = await import("node:sqlite");
  const { run } = await import("./repository-credentials/process.mjs");
  const { createFiniteGitConversation, finiteGitConversationFailureStage } =
    await import("../helpers/finite-git-conversation.ts");

  for (const scenario of finiteConversationScenarios) {
    test(scenario.name, async () => {
      const logReads: { args: string[]; timeout: number | undefined }[] = [];
      let probeCompleted = false;
      let posts = 0;
      let guards = 0;
      const reading = scenario.kind === "read" || scenario.kind === "transcript";
      const stage = scenario.stage;
      const pod = gatewayPod(0);
      const conversation = createFiniteGitConversation({
        agent,
        signal: new AbortController().signal,
        originalIdentity: "original",
        readExecution: async () =>
          stage === "execution identity" ? privateFailure() : { identity: "original" },
        kube: async (args, options) => {
          if (args[0] === "get") {
            if (stage === "target discovery") {
              return privateFailure();
            }
            if (args[1] === "namespaces") {
              return JSON.stringify({ items: [{ metadata: { name: "tenant" } }] });
            }
            if (args[1] === "pods") {
              return JSON.stringify({ items: [pod] });
            }
            if (stage === "gateway identity") {
              return privateFailure();
            }
            if (scenario.kind === "observation" && probeCompleted && ++guards === scenario.drift) {
              return JSON.stringify(gatewayPod(1));
            }
            return JSON.stringify(pod);
          }
          if (args[0] === "logs") {
            logReads.push({ args, timeout: options?.timeout });
            return scenario.kind === "observation" && scenario.logs !== undefined
              ? scenario.logs
              : privateFailure();
          }
          if (args[1] === "-i") {
            if (scenario.kind === "observation") {
              probeCompleted = true;
              return JSON.stringify({
                error: "upstream",
                status: 500,
                requestInterval: scenario.requestInterval,
              });
            }
            if (scenario.kind === "probe") {
              return JSON.stringify(scenario.response);
            }
            if (reading) {
              posts++;
              const nonce = options?.input?.match(/FIRST_AGENT_[0-9a-f-]+/)?.[0];
              assert.ok(nonce);
              return JSON.stringify({ nonce, runId });
            }
          }
          if (reading && args[0] === "exec") {
            if (scenario.kind === "read") {
              if (scenario.reason === "command") {
                return privateFailure();
              }
              if (scenario.reason === "timeout") {
                // A real subprocess timeout must be recognized by the persisted reader.
                await run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeout: 1 });
                return assert.fail("Expected the reader command to time out");
              }
            }
            const scriptIndex = args.indexOf("-e") + 1;
            const [script, key, marker] = args.slice(scriptIndex);
            if (
              args.at(-1) === "conversation-reply" &&
              !(scenario.kind === "read" && scenario.reason === "session_missing")
            ) {
              return JSON.stringify({ sessionId: "session", threadId: "thread" });
            }
            if (scenario.kind === "read" && scenario.reason === "transcript") {
              return JSON.stringify({ failure: "private-command-forged" });
            }
            assert.ok(script && key && marker !== undefined);
            const file = scenario.name.replaceAll(" ", "-") + ".sqlite";
            const db = new DatabaseSync(file);
            try {
              seedTranscript(db, key, marker, scenario);
            } finally {
              db.close();
            }
            const local = script
              .replaceAll("/home/node/.openclaw/agents/main/agent/openclaw-agent.sqlite", file)
              .replaceAll("/home/node/.openclaw/state/openclaw.sqlite", file);
            return execFileSync(process.execPath, ["-e", local, ...args.slice(scriptIndex + 1)], {
              encoding: "utf8",
            });
          }
          return privateFailure();
        },
      });

      const prior =
        scenario.kind === "transcript" && scenario.variant === "stale sequence"
          ? { sessionId: "session", threadId: "thread", userSeq: 0, assistantSeq: 1 }
          : undefined;
      let tuple;
      try {
        tuple = await conversation.turn(prior, 1000);
      } catch (error) {
        if (reading) {
          assert.equal(posts, 1);
        }
        assert.equal(scenario.expected.status, "failed");
        assert.equal(finiteGitConversationFailureStage(error), scenario.expected.detail);
        assert.equal(
          logReads.length,
          scenario.kind === "observation" ? scenario.expectedReads : 0,
          "one bounded read only after an eligible model failure",
        );
        // Assert after the turn so the observer cannot absorb assertion failures.
        for (const { args, timeout } of logReads) {
          assert.deepEqual(args, [
            "logs",
            "gateway",
            "--namespace",
            "tenant",
            "-c",
            "gateway",
            "--timestamps=true",
            "--tail=-1",
            "--limit-bytes=65536",
            "--since-time=" + new Date(interval.start).toISOString(),
          ]);
          assert.ok(timeout !== undefined && timeout > 0 && timeout <= 5000);
        }
        assert.ok(error instanceof Error);
        assert.equal(
          finiteGitConversationFailureStage({ stage, message: error.message }),
          undefined,
        );
        assert.equal(finiteGitConversationFailureStage(new Error(error.message)), undefined);
        assert.equal(error.cause, undefined);
        throw error;
      }
      assert.equal(
        scenario.expected.status,
        "passed",
        "Expected the selected diagnostic boundary to fail",
      );
      assert.equal(posts, 1);
      assert.deepEqual(tuple, {
        sessionId: "session",
        threadId: "thread",
        userSeq: 1,
        assistantSeq: 3,
      });
    });
  }
}
