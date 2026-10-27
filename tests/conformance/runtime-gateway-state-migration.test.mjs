import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { writeSync } from "node:fs";
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
  NATIVE_WORKER_ENTRYPOINT,
} from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import {
  OPENCLAW_AGENT_DATABASE_SCHEMA_VERSION,
  OPENCLAW_STATE_DATABASE_SCHEMA_VERSION,
  openClawStateMigrationHelper,
} from "../../apps/controller/src/drivers/compute/runtime-startup.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

// Exercise the state migration step the Kubernetes and Docker Gateway programs,
// the Harness's workspace node and the dedicated OpenClaw worker share, against real SQLite files. Only Doctor
// is replaced: the runtime image tests prove the real Doctor migrates a released
// Gateway's and a released workspace node's state.
const helper = openClawStateMigrationHelper("Gateway", "restart the Pod");
const nodeRequire = createRequire(import.meta.url);
const CURRENT = OPENCLAW_AGENT_DATABASE_SCHEMA_VERSION;
const STATE_CURRENT = OPENCLAW_STATE_DATABASE_SCHEMA_VERSION;
const TRANSPORT_TOKEN = "fixture-transport-token";
// The Compute status port's identity, and a Sandbox provider's transport exposure (the
// token's verifier, never the token): where a held startup failure is read.
const COMPUTE_STATUS_ENV = {
  OPENCLAW_RUNTIME_STATUS_PORT: "18791",
  OPENCLAW_AGENT_REVISION_ID: "rev_fixture",
  OPENCLAW_RUNTIME_STATUS_CONTAINER: "agent",
  OPENCLAW_POD_UID: "pod-fixture",
};
const PROVIDER_TRANSPORT_ENV = {
  APP_TOKEN_SHA: createHash("sha256").update(TRANSPORT_TOKEN).digest("hex"),
  APP_SERVER_PORT: "18790",
};

// Answers one request to a captured server handler.
async function call(handler, { url = "/openclaw/runtime/status", authorization } = {}) {
  let status;
  let body = "";
  await new Promise((resolve) => {
    handler(
      { method: "GET", url, headers: authorization === undefined ? {} : { authorization } },
      {
        writeHead(code) {
          status = code;
        },
        end(chunk) {
          body += chunk ?? "";
          resolve();
        },
      },
    );
  });
  return { status, body: body === "" ? undefined : JSON.parse(body) };
}

// What a held startup failure serves: on the Compute status port, the status Compute
// validates (exact revision, container and Pod) with readiness held at 503; on the
// provider's transport, the failure to the token holder only. Never any log text.
async function assertHeldFailureServed(servers, env, check) {
  const listening = servers.filter((server) => server.port !== undefined);
  assert.equal(listening.length, 1, JSON.stringify(listening));
  const [{ port, handler }] = listening;
  const compute = env.OPENCLAW_RUNTIME_STATUS_PORT !== undefined;
  assert.equal(String(port), compute ? env.OPENCLAW_RUNTIME_STATUS_PORT : env.APP_SERVER_PORT);
  const authorization = compute ? undefined : `Bearer ${TRANSPORT_TOKEN}`;
  const answer = await call(handler, { authorization });
  assert.equal(answer.status, 200);
  const { checkedAt, ...held } = answer.body.runtimeFailure;
  assert.ok(!Number.isNaN(Date.parse(checkedAt)));
  assert.deepEqual(held, { component: "agent", check, code: "UNAVAILABLE" });
  if (compute) {
    assert.deepEqual(Object.keys(answer.body), [
      "revisionId",
      "container",
      "podUid",
      "runtimeFailure",
    ]);
    assert.deepEqual(
      [answer.body.revisionId, answer.body.container, answer.body.podUid],
      ["rev_fixture", "agent", "pod-fixture"],
    );
    assert.equal((await call(handler, { url: "/readyz" })).status, 503);
  } else {
    assert.deepEqual(Object.keys(answer.body), ["runtimeFailure"]);
    assert.equal((await call(handler, {})).status, 401);
  }
}

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
    // A current header over an older marker: OpenClaw publishes the header later
    // without rewriting the marker row, so the newer of the two names the schema.
    [{ main: CURRENT }, { shared: STATE_CURRENT, marker: STATE_CURRENT - 3 }],
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
// runtime asset publication, every child process and HTTP listener. Native setup
// runs `setup(options)` (it succeeds by default); Doctor runs `doctor(child)`. Records
// the children in start order with their environments, and the servers it listens with.
// A `bindError` code fails every listen with that error.
async function runHarness(
  directory,
  doctor = () => assert.fail("Doctor must not run"),
  { env = {}, setup = () => ({ status: 0 }), bindError } = {},
) {
  const spawned = [];
  const errors = [];
  const servers = [];
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
        ...env,
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
      if (specifier === "node:http") {
        return { createServer: (handler) => listener(servers, handler, bindError) };
      }
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
        spawnSync: (command, args, options) => (record(args, options), setup(options)),
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
  return { spawned, synchronous, errors, holds, servers };
}

// A stand-in for node:http's server that records its handler and the port it listens on.
// With `bindError`, listening emits that error instead, as a failed bind does: an
// "error" event nobody handles throws.
function listener(servers, handler, bindError) {
  const server = { handler, port: undefined };
  servers.push(server);
  const emitter = new EventEmitter();
  return {
    on: (event, handle) => emitter.on(event, handle),
    listen(port) {
      if (bindError !== undefined) {
        emitter.emit("error", Object.assign(new Error("bind failed"), { code: bindError }));
        return;
      }
      server.port = port;
    },
  };
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
  // Codex, which serves this container's runtime status, never starts, so the supervisor
  // serves the held check itself: to Compute on the status port, or to a Sandbox
  // provider's token holder on the Harness port (finding 2686).
  for (const env of [COMPUTE_STATUS_ENV, PROVIDER_TRANSPORT_ENV]) {
    const directory = await harnessDirectory(t, STATE_CURRENT - 1);
    const outcome = await runHarness(directory, (child) => child.emit("exit", 1, null), { env });
    assert.deepEqual(
      outcome.spawned.map(({ name }) => name),
      ["doctor"],
    );
    assert.equal(outcome.holds, 1);
    const message = outcome.errors.at(-1);
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
    const directory = await harnessDirectory(t);
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
  ]) {
    const directory = await harnessDirectory(t);
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
  ]) {
    const directory = await harnessDirectory(t);
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
  const directory = await harnessDirectory(t);
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
  const directory = await harnessDirectory(t);
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
  assert.ok(replayed[0].length < 65536, "at most the last 64 KiB is replayed");
});

test("Harness names a failed native setup that reported no message", async (t) => {
  for (const [result, outcome] of [
    [{ status: null, signal: "SIGKILL" }, "SIGKILL"],
    [
      { status: null, error: Object.assign(new Error("spawn"), { code: "EACCES" }) },
      "error-EACCES",
    ],
    [{ status: 2, signal: null }, "exit-2"],
  ]) {
    const directory = await harnessDirectory(t);
    const run = await runHarness(directory, undefined, { setup: () => result });
    assert.equal(run.holds, 1);
    assert.equal(
      run.errors.at(-1),
      `Workspace initialization failed: openclaw setup --baseline (${outcome}) reported no error message. Codex was not started. Fix the cause, then deploy the Agent again.`,
    );
  }
});

// Runs the dedicated OpenClaw worker program, with its node state in
// `directory`/node-state, until it starts its connect child or holds. Real files;
// replaced: runtime asset publication, the model probe (it answers "ok"), the
// readiness listener (`ready()` asks it) and every child process. Doctor runs
// `doctor(child, { ready })`; `node identity` answers with a fixed device id.
async function runNativeWorker(
  directory,
  doctor = () => assert.fail("Doctor must not run"),
  { env = COMPUTE_STATUS_ENV } = {},
) {
  const spawned = [];
  const identities = [];
  const errors = [];
  const servers = [];
  let holds = 0;
  // The kubelet's readiness request on the Compute status port.
  const ready = async () =>
    (
      await call(
        servers.find(({ port }) => port === Number(COMPUTE_STATUS_ENV.OPENCLAW_RUNTIME_STATUS_PORT))
          .handler,
        { url: "/readyz" },
      )
    ).status;
  const probe = JSON.stringify({
    auth: {
      probes: {
        results: [{ provider: "openai", model: "openai/fixture", source: "env", status: "ok" }],
      },
    },
  });
  const inference = { models: { providers: { openai: { baseUrl: "http://127.0.0.1:9" } } } };
  const context = {
    Buffer,
    Date,
    JSON,
    Math,
    Number,
    Promise,
    URL,
    clearTimeout,
    setTimeout,
    console: { error: (line) => errors.push(String(line)), log() {} },
    process: {
      env: {
        HOME: directory,
        PATH: "/usr/bin",
        TMPDIR: join(directory, "tmp"),
        OPENCLAW_NODE_STATE_DIR: join(directory, "node-state"),
        OPENCLAW_NODE_SETUP_CODE: "fixture-node-setup",
        OPENCLAW_WORKSPACE_DIR: join(directory, "workspace"),
        OPENCLAW_NATIVE_WORKER_CAPACITY: "8",
        OPENCLAW_NATIVE_INFERENCE_CONFIG: JSON.stringify(inference),
        ...env,
        OPENCLAW_HARNESS_MODEL: "openai/fixture",
        OPENCLAW_HARNESS_PROVIDER: "openai",
        OPENCLAW_HARNESS_CREDENTIAL_ENV: "OPENAI_API_KEY",
        OPENCLAW_HARNESS_PROBE_CONFIG: JSON.stringify({
          ...inference,
          agents: { defaults: { model: "openai/fixture" } },
        }),
        // The model credential the connect child needs and Doctor must not receive.
        OPENAI_API_KEY: "sk-fixture-native-worker-model-credential",
      },
      execPath: "/usr/local/bin/node",
      on() {},
      off() {},
      exit: (code) => assert.fail(`Native worker exited ${code}: ${errors.join("\n")}`),
    },
    setInterval: () => {
      holds += 1;
    },
    require(specifier) {
      if (specifier === "node:http") {
        return { createServer: (handler) => listener(servers, handler) };
      }
      if (specifier !== "node:child_process") {
        return nodeRequire(specifier);
      }
      return {
        execFile(command, args, options, callback) {
          identities.push(args[2]);
          callback(null, JSON.stringify({ deviceId: "a".repeat(64) }));
        },
        spawnSync: (command, args) =>
          args.includes("--probe") ? { status: 0, stdout: probe } : { status: 0 },
        spawn(command, args, options) {
          const child = new EventEmitter();
          child.kill = () => {};
          spawned.push({ name: args[1], env: options.env });
          if (args[1] === "doctor") {
            setImmediate(() => doctor(child, { ready }));
          }
          return child;
        },
      };
    },
  };
  vm.runInNewContext(
    NATIVE_WORKER_ENTRYPOINT.replace("\ninitializeRuntimeAssets();\n", "\n"),
    context,
  );
  const synchronous = spawned.map(({ name }) => name);
  const connected = () => spawned.some(({ name }) => name === "connect");
  for (let turn = 0; turn < 100 && holds === 0 && !connected(); turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  return { spawned, synchronous, identities, errors, holds, ready, servers };
}

test("Native worker connects current and fresh node state without Doctor", async (t) => {
  for (const version of [undefined, STATE_CURRENT]) {
    const directory = await harnessDirectory(t, version);
    const outcome = await runNativeWorker(directory);
    // Current state adds no await before connect.
    assert.deepEqual(outcome.synchronous, ["connect"]);
    assert.equal(await outcome.ready(), 200);
  }
});

test("Native worker migrates older node state without the model credential before it connects", async (t) => {
  const directory = await harnessDirectory(t, STATE_CURRENT - 1);
  const nodeState = join(directory, "node-state");
  let readyDuringDoctor;
  const outcome = await runNativeWorker(directory, async (child, { ready }) => {
    readyDuringDoctor = await ready();
    setVersion(sharedPath(nodeState), STATE_CURRENT);
    child.emit("exit", 0, null);
  });
  // Readiness does not open the node state while Doctor migrates it.
  assert.equal(readyDuringDoctor, 503);
  assert.deepEqual(outcome.identities, []);
  assert.deepEqual(
    outcome.spawned.map(({ name }) => name),
    ["doctor", "connect"],
  );
  const [doctor, connect] = outcome.spawned;
  assert.equal(doctor.env.OPENCLAW_STATE_DIR, nodeState);
  assert.equal(doctor.env.OPENCLAW_CONFIG_PATH, join(nodeState, "openclaw.json"));
  assert.equal(doctor.env.OPENCLAW_CONFIG_READONLY, "1");
  assert.equal(doctor.env.OPENAI_API_KEY, undefined);
  assert.equal(doctor.env.OPENCLAW_NODE_SETUP_CODE, undefined);
  assert.equal(connect.env.OPENAI_API_KEY, "sk-fixture-native-worker-model-credential");
  assert.ok(outcome.errors.some((line) => /"phase":"state-migration","outcome":"ok"/.test(line)));
  assert.equal(await outcome.ready(), 200);
  assert.deepEqual(outcome.identities, ["identity"]);
});

test("Native worker holds unready without connecting when Doctor leaves older node state", async (t) => {
  // The held check is served beside readiness on the Compute status port, or on the
  // Harness port to a Sandbox provider's token holder (finding 2686).
  for (const env of [COMPUTE_STATUS_ENV, PROVIDER_TRANSPORT_ENV]) {
    const directory = await harnessDirectory(t, STATE_CURRENT - 1);
    const outcome = await runNativeWorker(directory, (child) => child.emit("exit", 1, null), {
      env,
    });
    assert.deepEqual(
      outcome.spawned.map(({ name }) => name),
      ["doctor"],
    );
    assert.equal(outcome.holds, 1);
    // A held worker never reports ready and never opens the older node state.
    if (env === COMPUTE_STATUS_ENV) {
      assert.equal(await outcome.ready(), 503);
    }
    assert.deepEqual(outcome.identities, []);
    const message = outcome.errors.at(-1);
    assert.match(
      message,
      /^Native worker state migration failed: openclaw doctor --fix \(exit-1\) left /,
    );
    assert.match(message, /then deploy the Agent again\.$/);
    assert.equal(readVersion(sharedPath(join(directory, "node-state"))), STATE_CURRENT - 1);
    await assertHeldFailureServed(outcome.servers, env, "state-migration");
  }
});
