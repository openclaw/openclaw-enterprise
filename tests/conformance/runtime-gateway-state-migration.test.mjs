import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import vm from "node:vm";
import { GATEWAY_RUNTIME_ENTRYPOINT as DOCKER_GATEWAY_RUNTIME_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/docker/index.ts";
import { GATEWAY_RUNTIME_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import {
  OPENCLAW_AGENT_DATABASE_SCHEMA_VERSION,
  gatewayStateMigrationHelper,
} from "../../apps/controller/src/drivers/compute/runtime-startup.ts";

// Exercise the state migration step the Kubernetes and Docker Gateway programs
// share, against real SQLite files. Only Doctor is replaced: the runtime image
// tests prove the real Doctor migrates a database from the released runtime.
const helper = gatewayStateMigrationHelper("restart the Pod");
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
    process: {
      env: { OPENCLAW_CONFIG_PATH: "/etc/openclaw/openclaw.json", OPENCLAW_STATE_DIR: directory },
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
      OPENCLAW_STATE_DIR: directory,
    },
  );
  assert.deepEqual(outcome.phases, [{ phase: "state-migration", outcome: "ok" }]);
  assert.deepEqual(outcome.failures, []);
  assert.equal(outcome.holds, 0);
  assert.deepEqual(outcome.listeners, { SIGTERM: [], SIGINT: [] });
  assert.match(outcome.errors.join("\n"), new RegExp(`from schema ${CURRENT - 1} to ${CURRENT}`));
});

test("Gateway state migration names the failure when Doctor leaves an older agent database", async (t) => {
  const directory = await stateDirectory(t, { main: CURRENT - 1 });
  // Doctor can hold back a store it cannot verify and still exit 0.
  const outcome = await migrate(directory, (child) => child.emit("exit", 0, null));
  assert.equal(outcome.started, false);
  assert.equal(outcome.spawned.length, 1);
  assert.deepEqual(outcome.phases, [{ phase: "state-migration", outcome: "failed" }]);
  assert.deepEqual(outcome.failures, [{ check: "state-migration", code: "UNAVAILABLE" }]);
  // Each wrapper decides how to stay down: Kubernetes holds, Docker exits.
  assert.equal(outcome.holds, 0);
  assert.deepEqual(outcome.exits, []);
  const message = outcome.errors.at(-1);
  assert.match(message, /^Gateway state migration failed: openclaw doctor --fix \(exit-0\) left /);
  assert.ok(message.includes(`${databasePath(directory, "main")} at schema ${CURRENT - 1}`));
  assert.match(message, /OpenClaw was not started\. .* then restart the Pod\.$/);
  assert.equal(readVersion(databasePath(directory, "main")), CURRENT - 1);
});

test("Gateway state migration leaves an agent database it cannot read to OpenClaw's own check", async (t) => {
  const directory = await stateDirectory(t, { main: CURRENT });
  await mkdir(join(directory, "agents", "broken", "agent"), { recursive: true });
  await writeFile(databasePath(directory, "broken"), "not a SQLite database");
  // An agent directory without a database is skipped too.
  await mkdir(join(directory, "agents", "empty", "agent"), { recursive: true });
  const outcome = await migrate(directory);
  assert.equal(outcome.started, true);
  assert.deepEqual(outcome.spawned, []);
});

test("Gateway state migration names a Doctor that could not start or was killed", async (t) => {
  for (const [end, named] of [
    [
      (child) => child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" })),
      "error-ENOENT",
    ],
    [(child) => child.emit("exit", null, "SIGKILL"), "SIGKILL"],
  ]) {
    const directory = await stateDirectory(t, { main: CURRENT - 1 });
    const outcome = await migrate(directory, end);
    assert.equal(outcome.started, false);
    assert.deepEqual(outcome.failures, [{ check: "state-migration", code: "UNAVAILABLE" }]);
    assert.deepEqual(outcome.exits, []);
    assert.deepEqual(outcome.listeners, { SIGTERM: [], SIGINT: [] });
    assert.ok(
      outcome.errors
        .at(-1)
        .startsWith(`Gateway state migration failed: openclaw doctor --fix (${named}) left `),
    );
  }
});

test("Gateway state migration stops Doctor with the signal it got and exits", async (t) => {
  for (const signal of ["SIGTERM", "SIGINT"]) {
    const directory = await stateDirectory(t, { main: CURRENT - 1 });
    const killed = [];
    const outcome = await migrate(directory, (child, { listeners }) => {
      child.on("killed", (received) => {
        killed.push(received);
        child.emit("exit", null, received);
      });
      for (const listener of listeners[signal]) {
        listener();
      }
    });
    assert.deepEqual(killed, [signal]);
    assert.deepEqual(outcome.exits, [0]);
    assert.deepEqual(outcome.failures, []);
    assert.deepEqual(outcome.listeners, { SIGTERM: [], SIGINT: [] });
  }
});

test("Kubernetes and Docker Gateway programs share the migration step and stay down after a failure", () => {
  assert.ok(GATEWAY_RUNTIME_ENTRYPOINT.includes(gatewayStateMigrationHelper("restart the Pod")));
  assert.ok(
    DOCKER_GATEWAY_RUNTIME_ENTRYPOINT.includes(
      gatewayStateMigrationHelper("deploy the Agent again"),
    ),
  );
  // Kubernetes holds the Pod unready with its status published instead of restarting.
  assert.ok(
    GATEWAY_RUNTIME_ENTRYPOINT.includes(
      "if (outdatedDatabases.length > 0 && !(await migrateGatewayState(outdatedDatabases))) {\n" +
        "  setInterval(() => {}, 3600000);\n  return;\n}",
    ),
  );
});

// Runs the whole Docker development Gateway program with its file writes and
// child processes replaced; agent databases are read from `directory`. `sqlite`
// replaces the node:sqlite module each time the program loads it.
async function runDockerGateway(
  directory,
  doctor = () => assert.fail("Doctor must not run"),
  { sqlite = () => nodeRequire("node:sqlite") } = {},
) {
  const spawned = [];
  const events = [];
  const errors = [];
  const exits = [];
  const realFs = nodeRequire("node:fs");
  const context = {
    Buffer,
    Date,
    JSON,
    Promise,
    URL,
    console: { error: (line) => errors.push(line), log() {} },
    process: {
      env: {
        OPENCLAW_CONFIG_JSON: "{}",
        OPENCLAW_CONFIG_PATH: "/home/node/.openclaw/openclaw.json",
        OPENCLAW_GATEWAY_PORT: "8080",
        OPENCLAW_STATE_DIR: directory,
      },
      execPath: "/usr/local/bin/node",
      on() {},
      off() {},
      // The program calls exit last on every path it can reach here.
      exit: (code) => exits.push(code),
    },
    setInterval: () => assert.fail("Docker Gateway must not hold"),
    setTimeout: () => ({ unref() {} }),
    require(specifier) {
      if (specifier === "node:fs") {
        return {
          ...realFs,
          chmodSync() {},
          mkdirSync() {},
          writeFileSync: () => events.push("write"),
        };
      }
      if (specifier === "node:child_process") {
        return {
          spawn(command, args, options) {
            const child = new EventEmitter();
            child.kill = () => {};
            spawned.push({ command, args: [...args], env: options.env });
            events.push(`spawn:${args[1]}`);
            if (args[1] === "doctor") {
              setImmediate(() => doctor(child));
            }
            return child;
          },
        };
      }
      return specifier === "node:sqlite" ? sqlite() : nodeRequire(specifier);
    },
  };
  vm.runInNewContext(DOCKER_GATEWAY_RUNTIME_ENTRYPOINT, context);
  const synchronousEvents = [...events];
  const gatewayStarted = () => spawned.some(({ args }) => args[1] === "gateway");
  for (let turn = 0; turn < 100 && !gatewayStarted() && exits.length === 0; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  return { spawned, events, synchronousEvents, errors, exits };
}

test("Docker development Gateway starts current state without Doctor", async (t) => {
  const directory = await stateDirectory(t, { main: CURRENT });
  const outcome = await runDockerGateway(directory);
  assert.deepEqual(
    outcome.spawned.map(({ command, args }) => [command, ...args]),
    [["node", "/app/openclaw.mjs", "gateway", "--port", "8080"]],
  );
  // Current state adds no await before the spawn.
  assert.deepEqual(outcome.synchronousEvents, ["write", "spawn:gateway"]);
  assert.deepEqual(outcome.exits, []);
});

test("Docker development Gateway migrates an older agent database before starting OpenClaw", async (t) => {
  const directory = await stateDirectory(t, { main: CURRENT - 1 });
  const outcome = await runDockerGateway(directory, (child) => {
    setVersion(databasePath(directory, "main"), CURRENT);
    child.emit("exit", 1, null);
  });
  assert.deepEqual(
    outcome.spawned.map(({ command, args }) => [command, ...args]),
    [
      ["/usr/local/bin/node", "/app/openclaw.mjs", "doctor", "--fix", "--non-interactive"],
      ["node", "/app/openclaw.mjs", "gateway", "--port", "8080"],
    ],
  );
  assert.equal(outcome.spawned[0].env.OPENCLAW_CONFIG_READONLY, "1");
  // Doctor reads the configuration document written before it, not its environment copy.
  assert.deepEqual(outcome.events, ["write", "spawn:doctor", "spawn:gateway"]);
  assert.equal(outcome.spawned[0].env.OPENCLAW_CONFIG_JSON, undefined);
  assert.deepEqual(outcome.exits, []);
  assert.ok(
    outcome.errors.some(
      (line) =>
        typeof line === "string" &&
        line.includes('"phase":"state-migration"') &&
        line.includes('"outcome":"ok"'),
    ),
  );
});

test("Docker development Gateway exits without starting OpenClaw when Doctor leaves an older agent database", async (t) => {
  const directory = await stateDirectory(t, { main: CURRENT - 1 });
  const outcome = await runDockerGateway(directory, (child) => child.emit("exit", 0, null));
  assert.deepEqual(
    outcome.spawned.map(({ args }) => args[1]),
    ["doctor"],
  );
  assert.deepEqual(outcome.exits, [1]);
  const message = outcome.errors.at(-1);
  assert.match(message, /^Gateway state migration failed: openclaw doctor --fix \(exit-0\) left /);
  assert.match(message, /OpenClaw was not started\. .* then deploy the Agent again\.$/);
  assert.equal(readVersion(databasePath(directory, "main")), CURRENT - 1);
});

test("Docker development Gateway exits without starting OpenClaw on an unexpected migration error", async (t) => {
  const directory = await stateDirectory(t, { main: CURRENT - 1 });
  let loads = 0;
  const outcome = await runDockerGateway(directory, (child) => child.emit("exit", 0, null), {
    // The re-read after Doctor fails outside the per-database check.
    sqlite: () => {
      loads += 1;
      if (loads > 1) {
        throw new Error("node:sqlite is unavailable");
      }
      return nodeRequire("node:sqlite");
    },
  });
  assert.deepEqual(
    outcome.spawned.map(({ args }) => args[1]),
    ["doctor"],
  );
  assert.deepEqual(outcome.exits, [1]);
  assert.equal(outcome.errors.at(-1), "Gateway state migration failed: node:sqlite is unavailable");
});
