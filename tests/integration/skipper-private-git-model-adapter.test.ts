import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { cleanEnvironment, run } from "../fixtures/repository-credentials/process.ts";
import { createSkipperPreparedComputeEvents } from "../fixtures/skipper-prepared-compute-model.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

// These are the ordinary function-tool envelopes from Codex 0.164.0's
// ExecCommandToolOutput::response_text (core/src/tools/context.rs), not the
// separate JSON envelope used by code-mode tools. These adapter checks do not
// execute native tools.
type NativeToolOutput = {
  session?: number | undefined;
  exit?: number | null;
  output?: string;
  tokenCount?: number | null;
};

function nativeToolOutput({ session, exit, output = "", tokenCount = 12 }: NativeToolOutput) {
  return [
    "Chunk ID: abc123",
    "Wall time: 0.2500 seconds",
    ...(exit === undefined ? [] : ["Process exited with code " + exit]),
    ...(session === undefined ? [] : ["Process running with session ID " + session]),
    ...(tokenCount === null ? [] : ["Original token count: " + tokenCount]),
    "Output:",
    output,
  ].join("\n");
}

type ToolCall = { type: "function_call"; call_id: string; name: string; arguments: string };
type ModelInput =
  | { type: "message"; role: "user"; content: string }
  | ToolCall
  | { type: "function_call_output"; call_id: string; output: string };
type Observation = {
  event: string;
  exitCode?: number | null;
  status?: string;
  sessionPresent?: boolean;
  modelFixtureSelectedTerminalSuccess?: true;
};

async function controlledModel(t: TestContext, cmd = "set -eu; printf 'private git task'") {
  const directory = await temporaryDirectory(t, "skipper-model-");
  const path = join(directory, "command.json");
  const command = {
    cmd,
    id: "skipper-test",
    expiresAt: Date.now() + 170_000,
  };
  await writeFile(path, JSON.stringify(command));
  let respond = createSkipperPreparedComputeEvents(path);
  const observations: Observation[] = [];
  const input: ModelInput[] = [{ type: "message", role: "user", content: command.id }];
  const next = () =>
    respond({
      model: "test",
      request: JSON.stringify({ input }),
      answerEvents: (_model: string, text: string) => text,
      emit: (event: Observation) => observations.push(event),
    });
  const result = (call: ToolCall, output: string, delta = false) => {
    if (delta) {
      input.length = 0;
    }
    input.push(call, { type: "function_call_output", call_id: call.call_id, output });
    return next();
  };
  const restart = () => {
    respond = createSkipperPreparedComputeEvents(path);
  };
  return { path, command, observations, next, result, restart };
}

function toolCall(events: unknown): ToolCall {
  assert.ok(Array.isArray(events), "expected model response events");
  const responseEvents: unknown[] = events;
  const done = responseEvents.find(
    (event) =>
      event &&
      typeof event === "object" &&
      "type" in event &&
      event.type === "response.output_item.done",
  );
  assert.ok(done && typeof done === "object" && "item" in done);
  const item = done.item;
  assert.ok(item && typeof item === "object" && "type" in item && item.type === "function_call");
  assert.ok("name" in item && typeof item.name === "string");
  assert.ok("call_id" in item && typeof item.call_id === "string");
  assert.ok("arguments" in item && typeof item.arguments === "string");
  return { type: item.type, name: item.name, call_id: item.call_id, arguments: item.arguments };
}

function lastObservation(observations: Observation[]): Observation {
  const last = observations.at(-1);
  assert.ok(last, "expected the adapter to record an observation");
  return last;
}

test("the installed Skipper model preserves the exit status of its Git command", async (t) => {
  const cwd = await temporaryDirectory(t, "skipper-model-git-");
  const env = cleanEnvironment({ HOME: cwd });
  const commit =
    "git -C work -c user.name=Fixture -c user.email=fixture@example.invalid commit --quiet --allow-empty -m fixture";
  const command = commit + " && git -C work rev-parse HEAD";
  async function execute() {
    const model = await controlledModel(t, command);
    const call = toolCall(model.next());
    const args: unknown = JSON.parse(call.arguments);
    assert.ok(args && typeof args === "object" && "cmd" in args && typeof args.cmd === "string");
    const { code, stdout, stderr } = await run("sh", ["-c", args.cmd], {
      cwd,
      env,
      allowFailure: true,
    });
    const answer = model.result(call, nativeToolOutput({ exit: code, output: stdout + stderr }));
    return { code, stdout, answer };
  }

  const missing = await execute();
  assert.equal(missing.code, 128);
  assert.equal(missing.stdout, "");
  assert.equal(missing.answer, "SKIPPER_INCOMPLETE_skipper-test");

  await run("git", ["init", "--quiet", "work"], { cwd, env });
  const success = await execute();
  const head = await run("git", ["-C", "work", "rev-parse", "--verify", "HEAD^{commit}"], {
    cwd,
    env,
  });
  assert.equal(success.code, 0);
  assert.match(head.stdout.trim(), /^[0-9a-f]{40}$/);
  assert.equal(success.stdout, head.stdout + "SKIPPER_COMPUTE_DONE_skipper-test\n");
  assert.equal(success.answer, "SKIPPER_COMPUTE_DONE_skipper-test");
});

test("the installed Skipper model waits for the same native session without replaying its command", async (t) => {
  const model = await controlledModel(t);
  const initial = toolCall(model.next());
  assert.equal(initial.name, "exec_command");
  assert.partialDeepStrictEqual(JSON.parse(initial.arguments) as unknown, {
    yield_time_ms: 30_000,
  });
  // Held discovery can outlive exec_command's first yield. Poll the returned
  // process, even if earlier output already contains part of the success marker.
  const first = toolCall(
    model.result(initial, nativeToolOutput({ session: 42, output: "SKIPPER_COMPUTE_" })),
  );
  assert.equal(first.name, "write_stdin");
  assert.equal(first.call_id, model.command.id + "-wait-1");
  assert.equal(lastObservation(model.observations).exitCode, null);
  assert.equal(lastObservation(model.observations).status, "running");
  assert.equal(lastObservation(model.observations).sessionPresent, true);
  assert.deepEqual(JSON.parse(first.arguments), {
    session_id: 42,
    chars: "",
    yield_time_ms: 30_000,
  });
  // Reconstruct from replayed full history after callback state is lost.
  model.restart();
  // A process may have exited while its output still drains. The session ID
  // remains authoritative until Codex reports that collection has finished.
  const second = toolCall(
    model.result(first, nativeToolOutput({ session: 42, exit: 0, output: "DONE_" })),
  );
  assert.equal(second.name, "write_stdin");
  assert.equal(second.call_id, model.command.id + "-wait-2");
  assert.equal(lastObservation(model.observations).exitCode, 0);
  assert.equal(lastObservation(model.observations).sessionPresent, true);
  // The same full history must not append either result again.
  assert.equal(toolCall(model.next()).call_id, second.call_id);
  assert.deepEqual(JSON.parse(second.arguments), {
    session_id: 42,
    chars: "",
    yield_time_ms: 30_000,
  });
  assert.equal(
    model.result(
      second,
      nativeToolOutput({ exit: 0, output: "skipper-test\n", tokenCount: null }),
      true,
    ),
    "SKIPPER_COMPUTE_DONE_skipper-test",
  );
  assert.equal(
    model.observations.filter((event) => event.event === "skipper-native-request").length,
    1,
  );
  assert.equal(lastObservation(model.observations).status, "completed");
  assert.equal(lastObservation(model.observations).exitCode, 0);
});

test("the installed Skipper model requires terminal success and keeps failure diagnostics content-free", async (t) => {
  const completed = await controlledModel(t);
  assert.equal(
    completed.result(
      toolCall(completed.next()),
      nativeToolOutput({ exit: 0, output: "SKIPPER_COMPUTE_DONE_skipper-test\n" }),
    ),
    "SKIPPER_COMPUTE_DONE_skipper-test",
  );
  const echoed = "`private-error-canary SKIPPER_COMPUTE_DONE_skipper-test`";
  const denied =
    "exec_command failed: CreateProcess { message: " +
    JSON.stringify(
      "Rejected(" +
        JSON.stringify(
          echoed + " rejected: rm -f style commands are not permitted. Use a safer approach",
        ) +
        ")",
    ) +
    " }";
  for (const [output, status] of [
    [
      nativeToolOutput({
        exit: 1,
        output: "SKIPPER_COMPUTE_DONE_skipper-test\nprivate-error-canary",
      }),
      "completed",
    ],
    [
      nativeToolOutput({
        exit: 0,
        output: "Process running with session ID 99\nprivate-error-canary",
      }),
      "completed",
    ],
    ["private-error-canary", "unrecognized"],
    [denied, "tool-denied"],
    ["private-error-canary " + denied, "unrecognized"],
  ] as const) {
    const model = await controlledModel(t);
    const initial = toolCall(model.next());
    assert.equal(model.result(initial, output), "SKIPPER_INCOMPLETE_skipper-test");
    assert.equal(lastObservation(model.observations).status, status);
    assert.equal(
      lastObservation(model.observations).modelFixtureSelectedTerminalSuccess,
      undefined,
    );
    assert.doesNotMatch(JSON.stringify(model.observations), /private-error-canary/);
    assert.equal(
      model.observations.some((event) => event.event === "skipper-native-poll"),
      false,
    );
  }
});

test("the installed Skipper model rejects a changed native session and stops polling at its chat deadline", async (t) => {
  const model = await controlledModel(t);
  const initial = toolCall(model.next());
  const poll = toolCall(model.result(initial, nativeToolOutput({ session: 42 })));
  assert.equal(
    model.result(poll, nativeToolOutput({ session: 43 })),
    "SKIPPER_INCOMPLETE_skipper-test",
  );
  assert.equal(lastObservation(model.observations).status, "unrecognized");

  // Replay the mixed-session history with a terminal result after losing callback state.
  model.restart();
  const beforeReplay = model.observations.length;
  assert.equal(
    model.result(
      { ...poll, call_id: model.command.id + "-wait-2" },
      nativeToolOutput({ exit: 0, output: "SKIPPER_COMPUTE_DONE_skipper-test" }),
    ),
    "SKIPPER_INCOMPLETE_skipper-test",
  );
  assert.equal(model.observations.length, beforeReplay + 1);
  const replay = model.observations[beforeReplay];
  assert.ok(replay);
  assert.equal(replay.modelFixtureSelectedTerminalSuccess, undefined);
  assert.partialDeepStrictEqual(replay, {
    event: "skipper-native-result",
    id: model.command.id,
    status: "unrecognized",
  });

  const expired = await controlledModel(t);
  const exec = toolCall(expired.next());
  await writeFile(expired.path, JSON.stringify({ ...expired.command, expiresAt: Date.now() - 1 }));
  assert.equal(
    expired.result(exec, nativeToolOutput({ session: 42 })),
    "SKIPPER_INCOMPLETE_skipper-test",
  );
  assert.equal(lastObservation(expired.observations).status, "deadline");
  assert.equal(
    expired.observations.some((event) => event.event === "skipper-native-poll"),
    false,
  );
});

test("the installed Skipper model rejects orphan or out-of-order native results", async (t) => {
  for (const session of [42, undefined]) {
    const orphan = await controlledModel(t);
    const exec = toolCall(orphan.next());
    const poll = toolCall(orphan.result(exec, nativeToolOutput({ session: 42 })));
    orphan.restart();
    assert.equal(
      orphan.result(
        poll,
        nativeToolOutput({ session, exit: 0, output: "SKIPPER_COMPUTE_DONE_skipper-test" }),
        true,
      ),
      "SKIPPER_INCOMPLETE_skipper-test",
    );
    assert.equal(lastObservation(orphan.observations).status, "unrecognized");
  }
  const reordered = await controlledModel(t);
  const exec = toolCall(reordered.next());
  const poll = toolCall(reordered.result(exec, nativeToolOutput({ session: 42 })));
  assert.equal(
    reordered.result(
      { ...poll, call_id: reordered.command.id + "-wait-2" },
      nativeToolOutput({ session: 42 }),
    ),
    "SKIPPER_INCOMPLETE_skipper-test",
  );
});

test("the installed Skipper model reserves the native poll minimum and rejects late success", async (t) => {
  for (const remaining of [1_000, -1]) {
    const model = await controlledModel(t);
    const exec = toolCall(model.next());
    await writeFile(
      model.path,
      JSON.stringify({ ...model.command, expiresAt: Date.now() + remaining }),
    );
    assert.equal(
      model.result(exec, nativeToolOutput({ session: 42 })),
      "SKIPPER_INCOMPLETE_skipper-test",
    );
    assert.equal(lastObservation(model.observations).status, "deadline");
  }
  const late = await controlledModel(t);
  const exec = toolCall(late.next());
  const poll = toolCall(late.result(exec, nativeToolOutput({ session: 42 })));
  await writeFile(late.path, JSON.stringify({ ...late.command, expiresAt: Date.now() - 1 }));
  assert.equal(
    late.result(poll, nativeToolOutput({ exit: 0, output: "SKIPPER_COMPUTE_DONE_skipper-test" })),
    "SKIPPER_INCOMPLETE_skipper-test",
  );
  assert.equal(lastObservation(late.observations).status, "deadline");
});
