import assert from "node:assert/strict";
import type { ChildProcessEventMap } from "node:child_process";
import { EventEmitter } from "node:events";
import realFs, { type MakeDirectoryOptions } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import vm from "node:vm";

import { GATEWAY_RUNTIME_ENTRYPOINT as DOCKER_GATEWAY_RUNTIME_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/docker/index.ts";
import { GATEWAY_RUNTIME_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import {
  OPENCLAW_AGENT_DATABASE_SCHEMA_VERSION as CURRENT,
  openClawStateMigrationHelper,
} from "../../apps/controller/src/drivers/compute/runtime-startup.ts";
import {
  databasePath,
  finishDoctor,
  readVersion,
  setVersion,
  stateDirectory,
} from "./runtime-gateway-state-migration-fixture.ts";

const nodeRequire = createRequire(import.meta.url);

test("Kubernetes and Docker Gateway programs share the migration step and stay down after a failure", () => {
  assert.ok(
    GATEWAY_RUNTIME_ENTRYPOINT.includes(openClawStateMigrationHelper("Gateway", "restart the Pod")),
  );
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

function gatewayChild() {
  return Object.assign(new EventEmitter<Pick<ChildProcessEventMap, "error" | "exit" | "close">>(), {
    stdout: new EventEmitter<{ data: [chunk: Buffer]; error: [error: Error] }>(),
    kill(_signal: NodeJS.Signals) {},
  });
}

type DockerDoctor = (child: ReturnType<typeof gatewayChild>) => void;
type LoadSqlite = () => typeof import("node:sqlite");

function loadSqlite(): ReturnType<LoadSqlite> {
  // Resolve lazily, when the generated program first opens or re-reads state.
  return process.getBuiltinModule("node:sqlite");
}

// Runs the whole Docker development Gateway program with its file writes and
// child processes replaced; agent databases are read from `directory`. `sqlite`
// replaces the node:sqlite module each time the program loads it.
async function runDockerGateway(
  directory: string,
  doctor: DockerDoctor = () => assert.fail("Doctor must not run"),
  { sqlite = loadSqlite }: { sqlite?: LoadSqlite } = {},
) {
  const spawned: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const events: string[] = [];
  const errors: unknown[] = [];
  const exits: number[] = [];
  const fixtureFailure = Promise.withResolvers<never>();
  const context = {
    Buffer,
    Date,
    JSON,
    Promise,
    URL,
    console: { error: (line: unknown) => errors.push(line), log() {} },
    process: {
      env: {
        OPENCLAW_CONFIG_JSON: "{}",
        OPENCLAW_CONFIG_PATH: "/home/node/.openclaw/openclaw.json",
        OPENCLAW_GATEWAY_PORT: "8080",
        OPENCLAW_STATE_DIR: directory,
      },
      stdout: { write() {} },
      execPath: "/usr/local/bin/node",
      on() {},
      off() {},
      // The program calls exit last on every path it can reach here.
      exit: (code: number) => exits.push(code),
    },
    setInterval: () => assert.fail("Docker Gateway must not hold"),
    setTimeout: () => ({ unref() {} }),
    require(specifier: string): unknown {
      if (specifier === "node:fs") {
        return {
          ...realFs,
          chmodSync() {},
          mkdirSync(path: string, options: MakeDirectoryOptions) {
            if (path.startsWith(directory)) {
              realFs.mkdirSync(path, options);
            }
          },
          writeFileSync: () => events.push("write"),
        };
      }
      if (specifier === "node:child_process") {
        return {
          spawn(command: string, args: string[], options: { env: NodeJS.ProcessEnv }) {
            const child = gatewayChild();
            spawned.push({ command, args: [...args], env: options.env });
            events.push(`spawn:${args[1]}`);
            if (args[1] === "doctor") {
              void nextTurn()
                .then(() => doctor(child))
                .catch(fixtureFailure.reject);
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
    await Promise.race([nextTurn(), fixtureFailure.promise]);
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

test("Docker development Gateway refuses an unreadable pending-maintenance marker before native startup", async (t) => {
  const directory = await stateDirectory(t, { main: CURRENT });
  // A non-file at the reserved path cannot be treated as absent or silently removed.
  await mkdir(join(directory, "state", ".oce-maintenance-pending"), { recursive: true });
  await assert.rejects(runDockerGateway(directory), /Invalid pending maintenance marker/);
});

test("Docker development Gateway migrates an older agent database before starting OpenClaw", async (t) => {
  const directory = await stateDirectory(t, { main: CURRENT - 1 });
  const outcome = await runDockerGateway(directory, (child) => {
    setVersion(databasePath(directory, "main"), CURRENT);
    finishDoctor(child, {
      status: "advisory",
      advisory: {
        kind: "package-post-install-doctor",
        reason: "deferred-configured-plugin-repair",
        message: "Deferred configured plugin repair",
        details: ["A configured plugin needs repair after verified installation."],
      },
    });
  });
  assert.deepEqual(
    outcome.spawned.map(({ command, args }) => [command, ...args]),
    [
      ["/usr/local/bin/node", "/app/openclaw.mjs", "doctor", "--fix", "--non-interactive"],
      ["node", "/app/openclaw.mjs", "gateway", "--port", "8080"],
    ],
  );
  const [doctor] = outcome.spawned;
  assert.ok(doctor);
  assert.equal(doctor.env.OPENCLAW_CONFIG_READONLY, "1");
  // As on Kubernetes, the update opt-out covers Doctor as well as the Gateway.
  assert.equal(doctor.env.OPENCLAW_NO_AUTO_UPDATE, "1");
  // Doctor reads the configuration document written before it, not its environment copy.
  assert.deepEqual(outcome.events, ["write", "spawn:doctor", "spawn:gateway"]);
  assert.equal(doctor.env.OPENCLAW_CONFIG_JSON, undefined);
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
  const outcome = await runDockerGateway(directory, (child) =>
    finishDoctor(child, { status: "ok" }),
  );
  assert.deepEqual(
    outcome.spawned.map(({ args }) => args[1]),
    ["doctor"],
  );
  assert.deepEqual(outcome.exits, [1]);
  const message = outcome.errors.at(-1);
  assert.ok(typeof message === "string");
  assert.match(message, /^Gateway state migration failed: openclaw doctor --fix \(exit-0\) left /);
  assert.match(message, /OpenClaw was not started\. .* then deploy the Agent again\.$/);
  assert.equal(readVersion(databasePath(directory, "main")), CURRENT - 1);
});

test("Docker development Gateway exits without starting OpenClaw on an unexpected migration error", async (t) => {
  const directory = await stateDirectory(t, { main: CURRENT - 1 });
  let loads = 0;
  const outcome = await runDockerGateway(
    directory,
    (child) => finishDoctor(child, { status: "ok" }),
    {
      // The re-read after Doctor fails outside the per-database check.
      sqlite: () => {
        loads += 1;
        if (loads > 1) {
          throw new Error("node:sqlite is unavailable");
        }
        return loadSqlite();
      },
    },
  );
  assert.deepEqual(
    outcome.spawned.map(({ args }) => args[1]),
    ["doctor"],
  );
  assert.deepEqual(outcome.exits, [1]);
  assert.equal(outcome.errors.at(-1), "Gateway state migration failed: node:sqlite is unavailable");
});
