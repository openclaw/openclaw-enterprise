import assert from "node:assert/strict";
import type { ChildProcessEventMap, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { writeSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import vm from "node:vm";

import { AGENT_WITH_NODE_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { OPENCLAW_STATE_DATABASE_SCHEMA_VERSION as STATE_CURRENT } from "../../apps/controller/src/drivers/compute/runtime-startup.ts";
import {
  finishDoctor,
  readVersion,
  setVersion,
  sharedPath,
} from "./runtime-gateway-state-migration-fixture.ts";
import {
  type CapturedServer,
  type RequestHandler,
  COMPUTE_STATUS_ENV,
  PROVIDER_TRANSPORT_ENV,
  assertHeldFailureServed,
  listener,
  workspaceNodeDirectory,
} from "./runtime-gateway-state-migration-node-fixture.ts";

const nodeRequire = createRequire(import.meta.url);

function harnessChild() {
  return Object.assign(new EventEmitter<Pick<ChildProcessEventMap, "error" | "exit" | "close">>(), {
    stdout: new EventEmitter<{ data: [chunk: Buffer]; error: [error: Error] }>(),
    kill(_signal: NodeJS.Signals) {},
  });
}

type HarnessDoctor = (child: ReturnType<typeof harnessChild>) => void;
type HarnessChildName = "doctor" | "setup" | "node" | "codex";

interface HarnessSpawnOptions extends SpawnOptions {
  env: NodeJS.ProcessEnv;
}

interface SetupOptions extends HarnessSpawnOptions {
  stdio: ["inherit", resultFd: number, stderrFd: number];
}

type SetupResult =
  | { status: number | null; signal?: NodeJS.Signals | null; error?: never }
  | { status: null; error: NodeJS.ErrnoException };

interface HarnessOptions {
  env?: NodeJS.ProcessEnv;
  setup?: (options: SetupOptions) => SetupResult;
  bindError?: string;
}

function assertSetupDescriptors(options: HarnessSpawnOptions): asserts options is SetupOptions {
  assert.ok(Array.isArray(options.stdio));
  assert.equal(options.stdio.length, 3);
  const [stdin, resultFd, stderrFd] = options.stdio;
  assert.equal(stdin, "inherit");
  assert.equal(typeof resultFd, "number");
  assert.equal(typeof stderrFd, "number");
}

// Runs the Harness program, with its node state in `directory`/node-state, until it
// starts both children or holds. Real files, under `directory` as HOME; replaced:
// runtime asset publication, every child process and HTTP listener. Native setup
// runs `setup(options)` (it succeeds by default); Doctor runs `doctor(child)`. Records
// the children in start order with their environments, and the servers it listens with.
// A `bindError` code fails every listen with that error.
async function runHarness(
  directory: string,
  doctor: HarnessDoctor = () => assert.fail("Doctor must not run"),
  { env = {}, setup = () => ({ status: 0 }), bindError }: HarnessOptions = {},
) {
  const spawned: Array<{ name: HarnessChildName; env: NodeJS.ProcessEnv }> = [];
  const errors: string[] = [];
  const servers: CapturedServer[] = [];
  const fixtureFailure = Promise.withResolvers<never>();
  let holds = 0;
  const context = {
    Buffer,
    Date,
    JSON,
    Math,
    Promise,
    URL,
    clearTimeout,
    setTimeout,
    console: { error: (line: unknown) => errors.push(String(line)), log() {} },
    process: {
      env: {
        HOME: directory,
        PATH: "/usr/bin",
        OPENCLAW_NODE_STATE_DIR: join(directory, "node-state"),
        OPENCLAW_NODE_SETUP_CODE: "fixture-node-setup",
        OPENCLAW_WORKSPACE_DIR: join(directory, "workspace"),
        // A model credential the Codex child needs and Doctor must not receive.
        OPENAI_API_KEY: "sk-fixture-harness-model-credential",
        ...env,
      },
      stdout: { write() {} },
      execPath: "/usr/local/bin/node",
      on() {},
      off() {},
      exit: (code: number) => assert.fail(`Harness exited ${code}: ${errors.join("\n")}`),
    },
    setInterval: () => {
      holds += 1;
    },
    require(specifier: string): unknown {
      if (specifier === "node:http") {
        return { createServer: (handler: RequestHandler) => listener(servers, handler, bindError) };
      }
      if (specifier !== "node:child_process") {
        return nodeRequire(specifier);
      }
      return {
        execFile() {},
        spawn(_command: string, args: string[], options: HarnessSpawnOptions) {
          const child = harnessChild();
          const role = args[1];
          const name = role === "doctor" || role === "setup" || role === "node" ? role : "codex";
          spawned.push({ name, env: options.env });
          if (name === "doctor") {
            void nextTurn()
              .then(() => doctor(child))
              .catch(fixtureFailure.reject);
          } else if (name === "setup") {
            // Setup writes its result and diagnostics while its descriptors are open.
            assertSetupDescriptors(options);
            const result = setup(options);
            void nextTurn()
              .then(() => {
                if (result.error === undefined) {
                  child.emit("exit", result.status, result.signal ?? null);
                } else {
                  child.emit("error", result.error);
                }
              })
              .catch(fixtureFailure.reject);
          }
          return child;
        },
      };
    },
  };
  vm.runInNewContext(
    AGENT_WITH_NODE_ENTRYPOINT.replace("\ninitializeRuntimeAssets();\n", "\n").replace(
      "\npublishAgentPluginSkillPath();\n",
      "\n",
    ),
    context,
  );
  const synchronous = spawned.map(({ name }) => name);
  for (let turn = 0; turn < 100 && holds === 0 && spawned.length < 3; turn += 1) {
    await Promise.race([nextTurn(), fixtureFailure.promise]);
  }
  return { spawned, synchronous, errors, holds, servers };
}

test("Harness starts current and fresh workspace node state without Doctor", async (t) => {
  for (const version of [undefined, STATE_CURRENT]) {
    const outcome = await runHarness(await workspaceNodeDirectory(t, version));
    // Current state adds no await before native setup; the children follow its exit.
    assert.deepEqual(outcome.synchronous, ["setup"]);
    assert.deepEqual(
      outcome.spawned.map(({ name }) => name),
      ["setup", "codex", "node"],
    );
    assert.equal(outcome.holds, 0);
  }
});

test("Harness migrates older workspace node state with the node's environment before native setup", async (t) => {
  const directory = await workspaceNodeDirectory(t, STATE_CURRENT - 1);
  const nodeState = join(directory, "node-state");
  const outcome = await runHarness(directory, (child) => {
    setVersion(sharedPath(nodeState), STATE_CURRENT);
    finishDoctor(child);
  });
  assert.deepEqual(
    outcome.spawned.map(({ name }) => name),
    ["doctor", "setup", "codex", "node"],
  );
  const [doctor, setup, codex] = outcome.spawned;
  assert.ok(doctor && setup && codex);
  // Doctor migrates the node's state, not the default OpenClaw state, and gets the
  // node's environment: never the model credential the Codex child receives.
  assert.deepEqual(
    { ...doctor.env },
    {
      ...setup.env,
      OPENCLAW_CONFIG_READONLY: "1",
      OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH: "-",
    },
  );
  assert.equal(doctor.env.OPENCLAW_STATE_DIR, nodeState);
  assert.equal(doctor.env.OPENAI_API_KEY, undefined);
  assert.equal(codex.env.OPENAI_API_KEY, "sk-fixture-harness-model-credential");
  assert.ok(outcome.errors.some((line) => /"phase":"state-migration","outcome":"ok"/.test(line)));
});

test("Harness retries refused maintenance after schemas advance and skips it only after successful settlement", async (t) => {
  const directory = await workspaceNodeDirectory(t, STATE_CURRENT - 1);
  const state = join(directory, "node-state");
  const refusal = {
    status: "error",
    maintenanceRefusal: { kind: "data-at-risk", reason: "active-mutation" },
  };
  // The first repair advances SQLite before its external process reports failed cleanup.
  const first = await runHarness(directory, (child) => {
    setVersion(sharedPath(state), STATE_CURRENT);
    finishDoctor(child, refusal);
  });
  assert.equal(first.holds, 1);
  assert.deepEqual(
    first.spawned.map(({ name }) => name),
    ["doctor"],
  );

  // A new wrapper receives the same retained files. Current schemas cannot erase refusal.
  const second = await runHarness(directory, (child) => finishDoctor(child, refusal));
  assert.equal(second.holds, 1);
  assert.deepEqual(
    second.spawned.map(({ name }) => name),
    ["doctor"],
  );
  const pending = await lstat(join(state, "state", ".oce-maintenance-pending"));
  assert.equal(pending.mode & 0o777, 0o600);

  const recovered = await runHarness(directory, (child) => finishDoctor(child));
  assert.deepEqual(
    recovered.spawned.map(({ name }) => name),
    ["doctor", "setup", "codex", "node"],
  );
  const current = await runHarness(directory);
  assert.deepEqual(
    current.spawned.map(({ name }) => name),
    ["setup", "codex", "node"],
  );
});

test("Harness holds without native setup or children when Doctor leaves older workspace node state", async (t) => {
  // Codex, which serves this container's runtime status, never starts, so the supervisor
  // serves the held check itself: to Compute on the status port, or to a Sandbox
  // provider's token holder on the Harness port (finding 2686).
  for (const env of [COMPUTE_STATUS_ENV, PROVIDER_TRANSPORT_ENV]) {
    const directory = await workspaceNodeDirectory(t, STATE_CURRENT - 1);
    const outcome = await runHarness(
      directory,
      (child) => {
        child.emit("close", 1, null);
      },
      { env },
    );
    assert.deepEqual(
      outcome.spawned.map(({ name }) => name),
      ["doctor"],
    );
    assert.equal(outcome.holds, 1);
    const message = outcome.errors.at(-1);
    assert.ok(message);
    assert.match(
      message,
      /^Harness state migration failed: openclaw doctor --fix \(exit-1\) left /,
    );
    assert.ok(
      message.includes(
        `${sharedPath(join(directory, "node-state"))} at schema ${STATE_CURRENT - 1}`,
      ),
    );
    assert.match(message, /then deploy the Agent again\.$/);
    assert.equal(readVersion(sharedPath(join(directory, "node-state"))), STATE_CURRENT - 1);
    await assertHeldFailureServed(outcome.servers, env, "state-migration");
  }
});

test("Harness holds on a failed native setup with one bounded line and serves the held check", async (t) => {
  // Setup reports a long multi-line message with control characters, and setting paths
  // of which only plain key paths are kept (finding 2696 and review-3817).
  const message = `first line\n\u001b[31mred\u001b[0m\r\t${"x".repeat(1000)}.`;
  const issues = [
    { path: "agents.defaults.skipBootstrap", message: "expected boolean", allowedValues: ["true"] },
    { path: "agents.defaults.skipBootstrap" },
    { path: "agents.list.0.id" },
    { path: "models.providers.sk-\u001b[0m" },
    { path: `a.${"b".repeat(80)}` },
    { path: { value: "secret" } },
    { path: "one" },
    { path: "two" },
    { path: "three" },
    { path: "four" },
  ];
  for (const env of [COMPUTE_STATUS_ENV, PROVIDER_TRANSPORT_ENV]) {
    const directory = await workspaceNodeDirectory(t);
    const outcome = await runHarness(directory, undefined, {
      env,
      setup(options) {
        writeSync(
          options.stdio[1],
          JSON.stringify({ ok: false, error: { type: "cli_error", message }, issues }, null, 2),
        );
        return { status: 1, signal: null };
      },
    });
    assert.deepEqual(
      outcome.spawned.map(({ name }) => name),
      ["setup"],
      "neither child starts on an uninitialized workspace",
    );
    assert.equal(outcome.holds, 1);
    const failures = outcome.errors.filter((line) => line.includes("Workspace initialization"));
    assert.equal(failures.length, 1);
    const [line] = failures;
    assert.ok(line);
    // eslint-disable-next-line no-control-regex -- matching control characters is the point
    assert.doesNotMatch(line, /[\u0000-\u001f\u007f-\u009f]/u);
    const reported =
      /^Workspace initialization failed: openclaw setup --baseline \(exit-1\) reported: (.*) \(invalid settings: (.*)\)\. Codex was not started\. Fix the cause, then deploy the Agent again\.$/u.exec(
        line,
      );
    assert.ok(reported, line);
    assert.equal(reported[1], `first line [31mred [0m ${"x".repeat(1000)}`.slice(0, 400));
    assert.equal(reported[2], "agents.defaults.skipBootstrap, agents.list.0.id, one, two, three");
    assert.ok(
      outcome.errors.some((entry) => /"phase":"workspace-baseline","outcome":"failed"/.test(entry)),
    );
    await assertHeldFailureServed(outcome.servers, env, "workspace-baseline");
  }
});

test("Harness keeps OpenClaw's recovery hints out of a failed native setup's log", async (t) => {
  // OpenClaw tells its reader to run doctor or config validate, which no Agent user can
  // do in the container; the setting it rejected still reaches the log (finding 2699).
  const stderr = [
    "Config observe anomaly: /fixture/openclaw.json (size-drop-vs-last-good:542->160)",
    "Config invalid at /fixture/openclaw.json. Run `openclaw doctor --fix` to apply supported repairs, then re-run setup.",
    "Fix: openclaw --profile fixture doctor --fix",
    "Inspect: openclaw config validate",
    "Audit, status, health, logs, and doctor commands still run with invalid config.",
    "[openclaw] For help, run `openclaw doctor`.",
    "",
  ].join("\n");
  for (const [message, reported] of [
    [
      "OpenClaw config is invalid: /fixture/openclaw.json. Run `openclaw doctor --fix` or `openclaw config validate`.",
      "reported: OpenClaw config is invalid: /fixture/openclaw.json",
    ],
    // A message that is only a hint is still what OpenClaw reported.
    ["Run `openclaw doctor --fix`.", "reported: Run `openclaw doctor --fix`"],
  ] satisfies Array<[string, string]>) {
    const directory = await workspaceNodeDirectory(t);
    const outcome = await runHarness(directory, undefined, {
      setup(options) {
        writeSync(options.stdio[2], stderr);
        writeSync(
          options.stdio[1],
          JSON.stringify({
            ok: false,
            error: { type: "cli_error", message },
            issues: [{ path: "agents.defaults.skipOptionalBootstrapFiles", message: "invalid" }],
          }),
        );
        return { status: 1, signal: null };
      },
    });
    assert.equal(outcome.holds, 1);
    assert.deepEqual(
      outcome.errors.filter((line) => !line.startsWith("{")),
      [
        "Config observe anomaly: /fixture/openclaw.json (size-drop-vs-last-good:542->160)",
        "Config invalid at /fixture/openclaw.json.",
        `Workspace initialization failed: openclaw setup --baseline (exit-1) ${reported} (invalid settings: agents.defaults.skipOptionalBootstrapFiles). Codex was not started. Fix the cause, then deploy the Agent again.`,
      ],
    );
  }
});

test("Harness keeps the cause beside OpenClaw's recovery hint", async (t) => {
  // The hint is the command, not a path naming openclaw and doctor; one in a later
  // clause or in parentheses is cut and the cause before it kept (finding 2701).
  const claim = "/home/node/workspace/.openclaw/openclaw-workspace-state.json.doctor-importing";
  for (const [message, kept] of [
    [
      `Run openclaw doctor --fix. Legacy workspace setup state requires migration for ${claim}.`,
      `Legacy workspace setup state requires migration for ${claim}.`,
    ],
    [
      "Auth profile credential fields require migration; run openclaw doctor --fix.",
      "Auth profile credential fields require migration.",
    ],
    [
      "slack: missing dependency @slack/bolt (run `openclaw doctor --fix` to install missing bundled runtime dependencies for channel slack)",
      "slack: missing dependency @slack/bolt",
    ],
  ] satisfies Array<[string, string]>) {
    const directory = await workspaceNodeDirectory(t);
    const outcome = await runHarness(directory, undefined, {
      setup(options) {
        writeSync(options.stdio[2], `${message}\n`);
        writeSync(
          options.stdio[1],
          JSON.stringify({ ok: false, error: { type: "cli_error", message } }),
        );
        return { status: 1, signal: null };
      },
    });
    assert.equal(outcome.holds, 1);
    assert.deepEqual(
      outcome.errors.filter((line) => !line.startsWith("{")),
      [
        kept,
        `Workspace initialization failed: openclaw setup --baseline (exit-1) reported: ${kept.replace(/\.$/, "")}. Codex was not started. Fix the cause, then deploy the Agent again.`,
      ],
    );
  }
});

test("Harness keeps holding when the status port cannot be bound", async (t) => {
  // A bind failure that ended the supervisor would restart it into Doctor again.
  const directory = await workspaceNodeDirectory(t);
  const outcome = await runHarness(directory, undefined, {
    env: COMPUTE_STATUS_ENV,
    bindError: "EADDRINUSE",
    setup: () => ({ status: 1, signal: null }),
  });
  assert.deepEqual(
    outcome.spawned.map(({ name }) => name),
    ["setup"],
  );
  assert.equal(outcome.holds, 1);
  assert.deepEqual(
    outcome.errors.filter((line) => line.startsWith("Runtime readiness server")),
    ["Runtime readiness server failed: EADDRINUSE"],
  );
});

test("Harness replays a successful native setup's diagnostics", async (t) => {
  const directory = await workspaceNodeDirectory(t);
  const outcome = await runHarness(directory, undefined, {
    setup(options) {
      writeSync(options.stdio[2], `${"z".repeat(70000)}\nfirst note\n\nsecond note\n`);
      return { status: 0, signal: null };
    },
  });
  assert.deepEqual(
    outcome.spawned.map(({ name }) => name),
    ["setup", "codex", "node"],
  );
  const replayed = outcome.errors.filter((line) => !line.startsWith("{"));
  assert.deepEqual(replayed.slice(1), ["first note", "second note"]);
  const [longLine] = replayed;
  assert.ok(longLine && longLine.length < 65536, "at most the last 64 KiB is replayed");
});

test("Harness names a failed native setup that reported no message", async (t) => {
  for (const [result, outcome] of [
    [{ status: null, signal: "SIGKILL" }, "SIGKILL"],
    [
      { status: null, error: Object.assign(new Error("spawn"), { code: "EACCES" }) },
      "error-EACCES",
    ],
    [{ status: 2, signal: null }, "exit-2"],
  ] satisfies Array<[SetupResult, string]>) {
    const directory = await workspaceNodeDirectory(t);
    const run = await runHarness(directory, undefined, { setup: () => result });
    assert.equal(run.holds, 1);
    assert.equal(
      run.errors.at(-1),
      `Workspace initialization failed: openclaw setup --baseline (${outcome}) reported no error message. Codex was not started. Fix the cause, then deploy the Agent again.`,
    );
  }
});
