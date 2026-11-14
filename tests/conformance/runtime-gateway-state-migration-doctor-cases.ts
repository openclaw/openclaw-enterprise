import assert from "node:assert/strict";
import type { SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import vm from "node:vm";

import type { RuntimeFailureEvidence } from "@openclaw-enterprise/contracts";
import {
  OPENCLAW_AGENT_DATABASE_SCHEMA_VERSION as CURRENT,
  OPENCLAW_STATE_DATABASE_SCHEMA_VERSION as STATE_CURRENT,
  openClawStateMigrationHelper,
} from "../../apps/controller/src/drivers/compute/runtime-startup.ts";
import {
  databasePath,
  finishDoctor,
  readVersion,
  setVersion,
  sharedPath,
  stateDirectory,
} from "./runtime-gateway-state-migration-fixture.ts";

const helper = openClawStateMigrationHelper("Gateway", "restart the Pod");
const nodeRequire = createRequire(import.meta.url);

type StopSignal = Extract<NodeJS.Signals, "SIGTERM" | "SIGINT">;
type StopListeners = Record<StopSignal, Array<() => void>>;

function doctorChild() {
  const events = new EventEmitter<{
    error: [error: NodeJS.ErrnoException];
    exit: [status: number | null, signal: NodeJS.Signals | null];
    close: [status: number | null, signal: NodeJS.Signals | null];
    killed: [signal: StopSignal];
  }>();
  return Object.assign(events, {
    stdout: new EventEmitter<{ data: [chunk: Buffer] }>(),
    kill: (signal: StopSignal) => events.emit("killed", signal),
  });
}

type Doctor = (
  child: ReturnType<typeof doctorChild>,
  listeners: StopListeners,
) => void | Promise<void>;

// Run the generated migration helper against real files. The Doctor callback
// controls only the external process, including its output and exit ordering.
async function migrate(
  directory: string,
  doctor: Doctor = () => assert.fail("Doctor must not run"),
) {
  const spawned: Array<
    Pick<Required<SpawnOptions>, "env" | "stdio"> & { command: string; args: string[] }
  > = [];
  const phases: Array<{ phase: string; outcome: string }> = [];
  const failures: Array<Pick<RuntimeFailureEvidence, "check" | "code">> = [];
  const errors: string[] = [];
  const stdout: string[] = [];
  const listeners: StopListeners = { SIGTERM: [], SIGINT: [] };
  const exits: number[] = [];
  let holds = 0;
  const exited = new Error("process exited");
  const fixtureFailure = Promise.withResolvers<never>();
  const context = {
    console: { error: (line: string) => errors.push(line) },
    process: {
      env: { OPENCLAW_CONFIG_PATH: "/etc/openclaw/openclaw.json", OPENCLAW_STATE_DIR: directory },
      stdout: { write: (line: string) => stdout.push(line) },
      execPath: "/usr/local/bin/node",
      on: (signal: StopSignal, listener: () => void) => listeners[signal].push(listener),
      off: (signal: StopSignal, listener: () => void) => {
        listeners[signal] = listeners[signal].filter((entry) => entry !== listener);
      },
      exit: (code: number): never => {
        exits.push(code);
        throw exited;
      },
    },
    require: nodeRequire,
    spawn(command: string, args: string[], options: SpawnOptions) {
      const child = doctorChild();
      spawned.push({ command, args: [...args], env: options.env, stdio: options.stdio });
      void nextTurn()
        .then(() => doctor(child, listeners))
        .catch(fixtureFailure.reject);
      return child;
    },
    logStartupPhase: (phase: string, _startedAt: number, outcome = "ok") =>
      phases.push({ phase, outcome }),
    publishRuntimeFailure: (check: string, code: string) => failures.push({ check, code }),
    setInterval: () => {
      holds += 1;
    },
  };
  const result: unknown = vm.runInNewContext(
    `${helper}\nconst outdated = outdatedOpenClawDatabases(process.env.OPENCLAW_STATE_DIR);\n` +
      "outdated.length === 0 && !openClawMaintenancePending(process.env.OPENCLAW_STATE_DIR) ? Promise.resolve(true)\n" +
      "  : migrateOpenClawState(process.env.OPENCLAW_STATE_DIR, outdated, process.env);",
    context,
  );
  let started: boolean | undefined;
  try {
    const value = await Promise.race([result, fixtureFailure.promise]);
    assert.ok(typeof value === "boolean", "Expected the migration helper's startup decision");
    started = value;
  } catch (error) {
    if (error !== exited) {
      throw error;
    }
  }
  return { started, spawned, phases, failures, errors, stdout, exits, holds, listeners };
}

test("Gateway state migration skips fresh, current, uninitialized and newer databases", async (t) => {
  for (const [databases, shared] of [
    [{}],
    [{ main: CURRENT }],
    [{ main: 0 }],
    [{ main: CURRENT + 1 }],
    [{ main: CURRENT, helper: 0 }],
    [{}, { shared: STATE_CURRENT }],
    [{ main: CURRENT }, { shared: 0 }],
    [{}, { shared: STATE_CURRENT + 1 }],
    // Current content published under an older header while an older updater runs.
    [{ main: CURRENT }, { shared: STATE_CURRENT - 2, marker: STATE_CURRENT }],
    // A current header over an older marker: OpenClaw publishes the header later
    // without rewriting the marker row, so the newer of the two names the schema.
    [{ main: CURRENT }, { shared: STATE_CURRENT, marker: STATE_CURRENT - 3 }],
  ] satisfies Array<
    [databases: Record<string, number>, shared?: Parameters<typeof stateDirectory>[2]]
  >) {
    const directory = await stateDirectory(t, databases, shared);
    const outcome = await migrate(directory);
    assert.equal(outcome.started, true);
    assert.deepEqual(outcome.spawned, []);
    assert.deepEqual(outcome.phases, []);
    for (const [agentId, version] of Object.entries(databases)) {
      assert.equal(readVersion(databasePath(directory, agentId)), version);
    }
  }
});

test("Gateway state migration runs Doctor for an older shared state database beside current agent databases", async (t) => {
  // The shared database holds client credentials, which OpenClaw moves only under
  // Doctor's backed-up migration custody; an older content marker does not hide it.
  const directory = await stateDirectory(
    t,
    { main: CURRENT },
    { shared: STATE_CURRENT - 2, marker: STATE_CURRENT - 1 },
  );
  const outcome = await migrate(directory, (child) => finishDoctor(child));
  assert.equal(outcome.started, false);
  assert.equal(outcome.spawned.length, 1);
  const [startMessage] = outcome.errors;
  assert.ok(startMessage);
  assert.match(
    startMessage,
    new RegExp(
      `^Migrating 1 OpenClaw database\\(s\\) from schema ${STATE_CURRENT - 1} to ${STATE_CURRENT} `,
    ),
  );
  const failure = outcome.errors.at(-1);
  assert.ok(failure?.includes(`${sharedPath(directory)} at schema ${STATE_CURRENT - 1}`));
  assert.deepEqual(outcome.failures, [{ check: "state-migration", code: "UNAVAILABLE" }]);
});

test("Gateway state migration waits for the settled Doctor result and preserves warnings", async (t) => {
  const directory = await stateDirectory(t, { main: CURRENT - 1, current: CURRENT });
  const warning = "Warning: Gateway is not configured";
  const outcome = await migrate(directory, async (child) => {
    setVersion(databasePath(directory, "main"), CURRENT);
    // Let any exit-driven decision settle before delivering the final output.
    child.emit("exit", 0, null);
    await nextTurn();
    child.stdout.emit("data", Buffer.from(warning + "\n"));
    child.stdout.emit("data", Buffer.from("OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_"));
    child.stdout.emit(
      "data",
      Buffer.from('RESULT_PATH={"status":"ok","warnings":["Gateway is not configured"]}\n'),
    );
    child.emit("close", 0, null);
  });
  assert.equal(outcome.started, true);
  assert.equal(outcome.spawned.length, 1);
  const [doctor] = outcome.spawned;
  assert.ok(doctor);
  assert.equal(doctor.command, "/usr/local/bin/node");
  assert.deepEqual(doctor.args, ["/app/openclaw.mjs", "doctor", "--fix", "--non-interactive"]);
  assert.ok(Array.isArray(doctor.stdio));
  assert.deepEqual([...doctor.stdio], ["inherit", "pipe", "inherit"]);
  assert.deepEqual(
    { ...doctor.env },
    {
      OPENCLAW_CONFIG_PATH: "/etc/openclaw/openclaw.json",
      OPENCLAW_CONFIG_READONLY: "1",
      OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH: "-",
      OPENCLAW_STATE_DIR: directory,
    },
  );
  assert.deepEqual(outcome.phases, [{ phase: "state-migration", outcome: "ok" }]);
  assert.deepEqual(outcome.failures, []);
  assert.equal(outcome.holds, 0);
  assert.deepEqual(outcome.listeners, { SIGTERM: [], SIGINT: [] });
  assert.deepEqual(outcome.stdout, [warning + "\n"]);
  assert.match(outcome.errors.join("\n"), new RegExp(`from schema ${CURRENT - 1} to ${CURRENT}`));
});

test("Gateway state migration refuses incomplete maintenance even after schemas advance", async (t) => {
  const records = [
    ["missing result", undefined],
    [
      "malformed advisory",
      {
        status: "advisory",
        advisory: {
          kind: "package-post-install-doctor",
          reason: "deferred-configured-plugin-repair",
        },
      },
    ],
    [
      "maintenance refusal",
      { status: "ok", maintenanceRefusal: { kind: "deferred", reason: "coordinator-contention" } },
    ],
    [
      "cleanup refusal",
      { status: "error", maintenanceRefusal: { kind: "data-at-risk", reason: "active-mutation" } },
    ],
    [
      "unsettled processes",
      { status: "ok", failureFacts: [{ code: "doctor-processes-unsettled" }] },
    ],
    ["config refusal", { status: "ok", configWriteRefusal: {} }],
    ["malformed facts", { status: "ok", failureFacts: false }],
    ["unknown outcome", { status: "future" }],
  ] satisfies Array<[name: string, result: Parameters<typeof finishDoctor>[1]]>;
  for (const [name, result] of records) {
    await t.test(name, async (t) => {
      const directory = await stateDirectory(t, { main: CURRENT - 1 });
      const outcome = await migrate(directory, (child) => {
        setVersion(databasePath(directory, "main"), CURRENT);
        if (result) {
          finishDoctor(child, result);
        } else {
          child.emit("exit", 0, null);
          child.emit("close", 0, null);
        }
      });
      assert.equal(outcome.started, false);
      assert.deepEqual(outcome.failures, [{ check: "state-migration", code: "UNAVAILABLE" }]);
      const failure = outcome.errors.at(-1);
      assert.ok(failure);
      assert.match(failure, /did not confirm completed maintenance/);
    });
  }
});

test("Gateway state migration names the failure when Doctor leaves an older agent database", async (t) => {
  const directory = await stateDirectory(t, { main: CURRENT - 1 });
  // Doctor can hold back a store it cannot verify and still exit 0.
  const outcome = await migrate(directory, (child) => finishDoctor(child));
  assert.equal(outcome.started, false);
  assert.equal(outcome.spawned.length, 1);
  assert.deepEqual(outcome.phases, [{ phase: "state-migration", outcome: "failed" }]);
  assert.deepEqual(outcome.failures, [{ check: "state-migration", code: "UNAVAILABLE" }]);
  // Each wrapper decides how to stay down: Kubernetes holds, Docker exits.
  assert.equal(outcome.holds, 0);
  assert.deepEqual(outcome.exits, []);
  const message = outcome.errors.at(-1);
  assert.ok(message);
  assert.match(message, /^Gateway state migration failed: openclaw doctor --fix \(exit-0\) left /);
  assert.ok(message.includes(`${databasePath(directory, "main")} at schema ${CURRENT - 1}`));
  assert.match(message, /OpenClaw was not started\. .* then restart the Pod\.$/);
  assert.equal(readVersion(databasePath(directory, "main")), CURRENT - 1);
});

test("Gateway state migration leaves an agent database it cannot read to OpenClaw's own check", async (t) => {
  const directory = await stateDirectory(t, { main: CURRENT });
  const broken = databasePath(directory, "broken");
  await mkdir(dirname(broken), { recursive: true });
  await writeFile(broken, "not a SQLite database");
  // An agent directory without a database is skipped too.
  await mkdir(dirname(databasePath(directory, "empty")), { recursive: true });
  const outcome = await migrate(directory);
  assert.equal(outcome.started, true);
  assert.deepEqual(outcome.spawned, []);
});

test("Gateway state migration names a Doctor that could not start or was killed", async (t) => {
  for (const [end, named] of [
    [
      (child) => {
        child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
        child.emit("close", -2, null);
      },
      "error-ENOENT",
    ],
    [(child) => child.emit("close", null, "SIGKILL"), "SIGKILL"],
  ] satisfies Array<[end: Doctor, outcome: string]>) {
    const directory = await stateDirectory(t, { main: CURRENT - 1 });
    const outcome = await migrate(directory, end);
    assert.equal(outcome.started, false);
    assert.deepEqual(outcome.failures, [{ check: "state-migration", code: "UNAVAILABLE" }]);
    assert.deepEqual(outcome.exits, []);
    assert.deepEqual(outcome.listeners, { SIGTERM: [], SIGINT: [] });
    assert.ok(
      outcome.errors
        .at(-1)
        ?.startsWith(`Gateway state migration failed: openclaw doctor --fix (${named}) left `),
    );
  }
});

test("Gateway state migration stops Doctor with the signal it got and exits", async (t) => {
  for (const signal of ["SIGTERM", "SIGINT"] satisfies StopSignal[]) {
    const directory = await stateDirectory(t, { main: CURRENT - 1 });
    const killed: StopSignal[] = [];
    const outcome = await migrate(directory, (child, listeners) => {
      setVersion(databasePath(directory, "main"), CURRENT);
      child.on("killed", (received) => {
        killed.push(received);
        child.emit("close", null, received);
      });
      for (const listener of listeners[signal]) {
        listener();
      }
    });
    assert.deepEqual(killed, [signal]);
    assert.deepEqual(outcome.exits, [0]);
    assert.deepEqual(outcome.failures, []);
    assert.deepEqual(outcome.listeners, { SIGTERM: [], SIGINT: [] });
    // Stop after schema publication still requires a completed repair on restart.
    const restarted = await migrate(directory, (child) => finishDoctor(child));
    assert.equal(restarted.spawned.length, 1);
    assert.equal(restarted.started, true);
  }
});
