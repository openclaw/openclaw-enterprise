import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import vm from "node:vm";
import { GATEWAY_RUNTIME_ENTRYPOINT as DOCKER_GATEWAY_RUNTIME_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/docker/index.ts";
import {
  AGENT_WITH_NODE_ENTRYPOINT,
  GATEWAY_RUNTIME_ENTRYPOINT,
} from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import {
  OPENCLAW_AGENT_DATABASE_SCHEMA_VERSION,
  OPENCLAW_STATE_DATABASE_SCHEMA_VERSION,
  openClawStateMigrationHelper,
} from "../../apps/controller/src/drivers/compute/runtime-startup.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

// Exercise the state migration step the Kubernetes and Docker Gateway programs
// and the Harness's workspace node share, against real SQLite files. Only Doctor
// is replaced: the runtime image tests prove the real Doctor migrates a released
// Gateway's and a released workspace node's state.
const helper = openClawStateMigrationHelper("Gateway", "restart the Pod");
const nodeRequire = createRequire(import.meta.url);
const CURRENT = OPENCLAW_AGENT_DATABASE_SCHEMA_VERSION;
const STATE_CURRENT = OPENCLAW_STATE_DATABASE_SCHEMA_VERSION;

// Agent databases by agent id at their schema versions, and optionally the
// shared state database (`shared`) with its content marker (`marker`).
async function stateDirectory(t, databases = {}, { shared, marker } = {}) {
  const directory = await temporaryDirectory(t, "oce-gateway-state-migration-");
  for (const [agentId, version] of Object.entries(databases)) {
    const agentDirectory = join(directory, "agents", agentId, "agent");
    await mkdir(agentDirectory, { recursive: true });
    setVersion(join(agentDirectory, "openclaw-agent.sqlite"), version);
  }
  if (shared !== undefined) {
    await mkdir(join(directory, "state"), { recursive: true });
    setVersion(sharedPath(directory), shared, marker);
  }
  return directory;
}

function databasePath(directory, agentId) {
  return join(directory, "agents", agentId, "agent", "openclaw-agent.sqlite");
}

function sharedPath(directory) {
  return join(directory, "state", "openclaw.sqlite");
}

// OpenClaw keeps the shared state content marker in config_machine_state.
function setVersion(path, version, marker) {
  const database = new DatabaseSync(path);
  database.exec(
    `CREATE TABLE IF NOT EXISTS fixture (id INTEGER); PRAGMA user_version = ${version}`,
  );
  if (marker !== undefined) {
    database.exec(
      "CREATE TABLE IF NOT EXISTS config_machine_state (state_key TEXT PRIMARY KEY, value_json TEXT)",
    );
    database
      .prepare(
        "INSERT OR REPLACE INTO config_machine_state VALUES ('state.schema.contentVersion', ?)",
      )
      .run(String(marker));
  }
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
    `${helper}\nconst outdated = outdatedOpenClawDatabases(process.env.OPENCLAW_STATE_DIR);\n` +
      "outdated.length === 0 ? Promise.resolve(true)\n" +
      "  : migrateOpenClawState(process.env.OPENCLAW_STATE_DIR, outdated, process.env);",
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
  ]) {
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
  const outcome = await migrate(directory, (child) => child.emit("exit", 0, null));
  assert.equal(outcome.started, false);
  assert.equal(outcome.spawned.length, 1);
  assert.match(
    outcome.errors[0],
    new RegExp(
      `^Migrating 1 OpenClaw database\\(s\\) from schema ${STATE_CURRENT - 1} to ${STATE_CURRENT} `,
    ),
  );
  assert.ok(
    outcome.errors.at(-1).includes(`${sharedPath(directory)} at schema ${STATE_CURRENT - 1}`),
  );
  assert.deepEqual(outcome.failures, [{ check: "state-migration", code: "UNAVAILABLE" }]);
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
  assert.ok(GATEWAY_RUNTIME_ENTRYPOINT.includes(helper));
  assert.ok(
    DOCKER_GATEWAY_RUNTIME_ENTRYPOINT.includes(
      openClawStateMigrationHelper("Gateway", "deploy the Agent again"),
    ),
  );
  // Kubernetes holds the Pod unready with its status published instead of restarting.
  assert.ok(
    GATEWAY_RUNTIME_ENTRYPOINT.includes(
      "  !(await migrateOpenClawState(gatewayStateDirectory, outdatedDatabases, process.env))\n" +
        ") {\n  setInterval(() => {}, 3600000);\n  return;\n}",
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

// Runs the Harness program, with its node state in `directory`/node-state, until it
// starts both children or holds. Real files, under `directory` as HOME; replaced:
// runtime asset publication, and every child process. Native setup succeeds; Doctor
// runs `doctor(child)`. Records the children in start order with their environments.
async function runHarness(directory, doctor = () => assert.fail("Doctor must not run")) {
  const spawned = [];
  const errors = [];
  let holds = 0;
  const context = {
    Buffer,
    Date,
    JSON,
    Math,
    Promise,
    clearTimeout,
    setTimeout,
    console: { error: (line) => errors.push(String(line)), log() {} },
    process: {
      env: {
        HOME: directory,
        PATH: "/usr/bin",
        OPENCLAW_NODE_STATE_DIR: join(directory, "node-state"),
        OPENCLAW_NODE_SETUP_CODE: "fixture-node-setup",
        OPENCLAW_WORKSPACE_DIR: join(directory, "workspace"),
        // A model credential the Codex child needs and Doctor must not receive.
        OPENAI_API_KEY: "sk-fixture-harness-model-credential",
      },
      execPath: "/usr/local/bin/node",
      on() {},
      off() {},
      exit: (code) => assert.fail(`Harness exited ${code}: ${errors.join("\n")}`),
    },
    setInterval: () => {
      holds += 1;
    },
    require(specifier) {
      if (specifier !== "node:child_process") {
        return nodeRequire(specifier);
      }
      const record = (args, options) => {
        const name =
          args[1] === "doctor"
            ? "doctor"
            : args[1] === "setup"
              ? "setup"
              : args[1] === "node"
                ? "node"
                : "codex";
        spawned.push({ name, env: options.env });
        return name;
      };
      return {
        execFile() {},
        spawnSync: (command, args, options) => (record(args, options), { status: 0 }),
        spawn(command, args, options) {
          const child = new EventEmitter();
          child.kill = () => {};
          if (record(args, options) === "doctor") {
            setImmediate(() => doctor(child));
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
    await new Promise((resolve) => setImmediate(resolve));
  }
  return { spawned, synchronous, errors, holds };
}

// A Harness's workspace node keeps a shared state database, and no agent database,
// on the Agent's workspace claim.
async function harnessDirectory(t, version) {
  const directory = await temporaryDirectory(t, "oce-harness-state-migration-");
  await mkdir(join(directory, "node-state", "state"), { recursive: true });
  await mkdir(join(directory, "workspace"));
  if (version !== undefined) {
    setVersion(sharedPath(join(directory, "node-state")), version);
  }
  return directory;
}

test("Harness starts current and fresh workspace node state without Doctor", async (t) => {
  for (const version of [undefined, STATE_CURRENT]) {
    const outcome = await runHarness(await harnessDirectory(t, version));
    // Current state adds no await before native setup and the children.
    assert.deepEqual(outcome.synchronous, ["setup", "codex", "node"]);
    assert.equal(outcome.holds, 0);
  }
});

test("Harness migrates older workspace node state with the node's environment before native setup", async (t) => {
  const directory = await harnessDirectory(t, STATE_CURRENT - 1);
  const nodeState = join(directory, "node-state");
  const outcome = await runHarness(directory, (child) => {
    setVersion(sharedPath(nodeState), STATE_CURRENT);
    child.emit("exit", 0, null);
  });
  assert.deepEqual(
    outcome.spawned.map(({ name }) => name),
    ["doctor", "setup", "codex", "node"],
  );
  const [doctor, setup] = outcome.spawned;
  // Doctor migrates the node's state, not the default OpenClaw state, and gets the
  // node's environment: never the model credential the Codex child receives.
  assert.deepEqual({ ...doctor.env }, { ...setup.env, OPENCLAW_CONFIG_READONLY: "1" });
  assert.equal(doctor.env.OPENCLAW_STATE_DIR, nodeState);
  assert.equal(doctor.env.OPENAI_API_KEY, undefined);
  assert.equal(outcome.spawned[2].env.OPENAI_API_KEY, "sk-fixture-harness-model-credential");
  assert.ok(outcome.errors.some((line) => /"phase":"state-migration","outcome":"ok"/.test(line)));
});

test("Harness holds without native setup or children when Doctor leaves older workspace node state", async (t) => {
  const directory = await harnessDirectory(t, STATE_CURRENT - 1);
  const outcome = await runHarness(directory, (child) => child.emit("exit", 1, null));
  assert.deepEqual(
    outcome.spawned.map(({ name }) => name),
    ["doctor"],
  );
  assert.equal(outcome.holds, 1);
  const message = outcome.errors.at(-1);
  assert.match(message, /^Harness state migration failed: openclaw doctor --fix \(exit-1\) left /);
  assert.ok(
    message.includes(`${sharedPath(join(directory, "node-state"))} at schema ${STATE_CURRENT - 1}`),
  );
  assert.match(message, /then deploy the Agent again\.$/);
  assert.equal(readVersion(sharedPath(join(directory, "node-state"))), STATE_CURRENT - 1);
});
