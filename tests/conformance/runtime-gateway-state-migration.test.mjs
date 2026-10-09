import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import vm from "node:vm";
import {
  GATEWAY_RUNTIME_ENTRYPOINT,
  OPENCLAW_AGENT_DATABASE_SCHEMA_VERSION,
} from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";

// Exercise the state migration step embedded in the generated Gateway program,
// against real SQLite files. Only Doctor is replaced: the runtime image test
// proves the real Doctor migrates a database from the released runtime.
const helperStart = GATEWAY_RUNTIME_ENTRYPOINT.indexOf("function outdatedAgentDatabases() {");
const helperEnd = GATEWAY_RUNTIME_ENTRYPOINT.indexOf("\nfunction gatewayRuntimeReady() {");
assert.ok(helperStart >= 0 && helperEnd > helperStart);
const helper = GATEWAY_RUNTIME_ENTRYPOINT.slice(helperStart, helperEnd);
const nodeRequire = createRequire(import.meta.url);
const CURRENT = OPENCLAW_AGENT_DATABASE_SCHEMA_VERSION;

async function stateDirectory(t, databases = {}) {
  const directory = await mkdtemp(join(tmpdir(), "oce-gateway-state-migration-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [agentId, version] of Object.entries(databases)) {
    const agentDirectory = join(directory, "agents", agentId, "agent");
    await mkdir(agentDirectory, { recursive: true });
    setVersion(join(agentDirectory, "openclaw-agent.sqlite"), version);
  }
  return directory;
}

function databasePath(directory, agentId) {
  return join(directory, "agents", agentId, "agent", "openclaw-agent.sqlite");
}

function setVersion(path, version) {
  const database = new DatabaseSync(path);
  database.exec(
    `CREATE TABLE IF NOT EXISTS fixture (id INTEGER); PRAGMA user_version = ${version}`,
  );
  database.close();
}

function readVersion(path) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return database.prepare("PRAGMA user_version").get().user_version;
  } finally {
    database.close();
  }
}

// Runs migrateGatewayState() with a stand-in Doctor: doctor(child) decides what
// it does to the databases and how it exits.
function migrate(directory, doctor = () => assert.fail("Doctor must not run")) {
  const spawned = [];
  const phases = [];
  const failures = [];
  const errors = [];
  const listeners = { SIGTERM: [], SIGINT: [] };
  const exits = [];
  let holds = 0;
  const exited = new Error("process exited");
  const context = {
    console: { error: (line) => errors.push(line) },
    Date,
    JSON,
    Promise,
    join,
    process: {
      env: { OPENCLAW_STATE_DIR: directory },
      execPath: "/usr/local/bin/node",
      on: (signal, listener) => listeners[signal].push(listener),
      off: (signal, listener) => {
        listeners[signal] = listeners[signal].filter((entry) => entry !== listener);
      },
      // process.exit does not return: end the step where the real process would.
      exit: (code) => {
        exits.push(code);
        throw exited;
      },
    },
    require: (specifier) => nodeRequire(specifier),
    spawn(command, args, options) {
      const child = new EventEmitter();
      child.kill = (signal) => child.emit("killed", signal);
      spawned.push({ command, args, env: options.env, stdio: options.stdio });
      setImmediate(() => doctor(child, { listeners }));
      return child;
    },
    gatewayEnvironment: () => ({ OPENCLAW_CONFIG_PATH: "/etc/openclaw/openclaw.json" }),
    gatewayTerminating: false,
    logStartupPhase: (phase, startedAt, outcome = "ok") => phases.push({ phase, outcome }),
    publishRuntimeFailure: (check, code) => failures.push({ check, code }),
    setInterval: () => {
      holds += 1;
    },
  };
  // The same guard the Gateway program applies before its spawn.
  const result = vm.runInNewContext(
    `${helper}\nconst outdated = outdatedAgentDatabases();\n` +
      "outdated.length === 0 ? Promise.resolve(true) : migrateGatewayState(outdated);",
    context,
  );
  return result.then(
    (started) => ({
      started,
      spawned,
      phases,
      failures,
      errors,
      exits,
      holds,
      listeners,
    }),
    (error) => {
      if (error !== exited) {
        throw error;
      }
      return { started: undefined, spawned, phases, failures, errors, exits, holds, listeners };
    },
  );
}

test("Gateway state migration skips fresh, current, uninitialized and newer agent databases", async (t) => {
  for (const databases of [
    {},
    { main: CURRENT },
    { main: 0 },
    { main: CURRENT + 1 },
    { main: CURRENT, helper: 0 },
  ]) {
    const directory = await stateDirectory(t, databases);
    const outcome = await migrate(directory);
    assert.equal(outcome.started, true);
    assert.deepEqual(outcome.spawned, []);
    assert.deepEqual(outcome.phases, []);
    for (const [agentId, version] of Object.entries(databases)) {
      assert.equal(readVersion(databasePath(directory, agentId)), version);
    }
  }
});

test("Gateway state migration runs Doctor once for an older agent database and trusts the result over its exit status", async (t) => {
  const directory = await stateDirectory(t, { main: CURRENT - 1, current: CURRENT });
  const outcome = await migrate(directory, (child) => {
    setVersion(databasePath(directory, "main"), CURRENT);
    // Doctor exits 1 here for problems it can only report, such as a read-only path.
    child.emit("exit", 1, null);
  });
  assert.equal(outcome.started, true);
  assert.equal(outcome.spawned.length, 1);
  assert.equal(outcome.spawned[0].command, "/usr/local/bin/node");
  assert.deepEqual(
    [...outcome.spawned[0].args],
    ["/app/openclaw.mjs", "doctor", "--fix", "--non-interactive"],
  );
  assert.equal(outcome.spawned[0].stdio, "inherit");
  assert.deepEqual(
    { ...outcome.spawned[0].env },
    {
      OPENCLAW_CONFIG_PATH: "/etc/openclaw/openclaw.json",
      OPENCLAW_CONFIG_READONLY: "1",
    },
  );
  assert.deepEqual(outcome.phases, [{ phase: "state-migration", outcome: "ok" }]);
  assert.deepEqual(outcome.failures, []);
  assert.equal(outcome.holds, 0);
  assert.deepEqual(outcome.listeners, { SIGTERM: [], SIGINT: [] });
  assert.match(outcome.errors.join("\n"), new RegExp(`from schema ${CURRENT - 1} to ${CURRENT}`));
});

test("Gateway state migration holds the Gateway unready when Doctor leaves an older agent database", async (t) => {
  const directory = await stateDirectory(t, { main: CURRENT - 1 });
  // Doctor can hold back a store it cannot verify and still exit 0.
  const outcome = await migrate(directory, (child) => child.emit("exit", 0, null));
  assert.equal(outcome.started, false);
  assert.equal(outcome.spawned.length, 1);
  assert.deepEqual(outcome.phases, [{ phase: "state-migration", outcome: "failed" }]);
  assert.deepEqual(outcome.failures, [{ check: "state-migration", code: "UNAVAILABLE" }]);
  assert.equal(outcome.holds, 1);
  assert.deepEqual(outcome.exits, []);
  const message = outcome.errors.at(-1);
  assert.match(message, /^Gateway state migration failed: openclaw doctor --fix \(exit-0\) left /);
  assert.ok(message.includes(`${databasePath(directory, "main")} at schema ${CURRENT - 1}`));
  assert.match(message, /OpenClaw was not started\./);
  assert.equal(readVersion(databasePath(directory, "main")), CURRENT - 1);
});

test("Gateway state migration stops Doctor and exits on termination", async (t) => {
  const directory = await stateDirectory(t, { main: CURRENT - 1 });
  const killed = [];
  const outcome = await migrate(directory, (child, { listeners }) => {
    child.on("killed", (signal) => {
      killed.push(signal);
      child.emit("exit", null, signal);
    });
    for (const listener of listeners.SIGTERM) {
      listener();
    }
  });
  assert.deepEqual(killed, ["SIGTERM"]);
  assert.deepEqual(outcome.exits, [0]);
  assert.deepEqual(outcome.failures, []);
  assert.deepEqual(outcome.listeners, { SIGTERM: [], SIGINT: [] });
});
