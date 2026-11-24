import assert from "node:assert/strict";
import type { ChildProcessEventMap, ExecFileOptionsWithStringEncoding } from "node:child_process";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import vm from "node:vm";

import { NATIVE_WORKER_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
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
  call,
  listener,
  workspaceNodeDirectory,
} from "./runtime-gateway-state-migration-node-fixture.ts";

const nodeRequire = createRequire(import.meta.url);

function workerChild() {
  return Object.assign(new EventEmitter<Pick<ChildProcessEventMap, "error" | "exit" | "close">>(), {
    stdout: new EventEmitter<{ data: [chunk: Buffer]; error: [error: Error] }>(),
    kill(_signal: NodeJS.Signals) {},
  });
}

type WorkerDoctor = (
  child: ReturnType<typeof workerChild>,
  readiness: { ready: () => Promise<number> },
) => void | Promise<void>;

type WorkerChildName = "doctor" | "connect";

type IdentityCallback = (...result: [error: Error] | [error: null, stdout: string]) => void;

function identityResult(
  callbacks: readonly IdentityCallback[],
  index: number,
  ...result: Parameters<IdentityCallback>
) {
  const callback = callbacks[index];
  assert.ok(callback);
  callback(...result);
}

interface WorkerTimer {
  unref(): WorkerTimer;
}

type ScheduleWorkerTimer = <Args extends unknown[]>(
  callback: (...args: Args) => void,
  delay: number,
  ...args: Args
) => WorkerTimer;

interface WorkerOptions {
  env?: NodeJS.ProcessEnv;
  identity?: (callback: IdentityCallback) => void;
  timer?: ScheduleWorkerTimer;
}

function readinessHandler(servers: CapturedServer[]): RequestHandler {
  const server = servers.find(
    ({ port }) => port === Number(COMPUTE_STATUS_ENV.OPENCLAW_RUNTIME_STATUS_PORT),
  );
  assert.ok(server, "Expected the Compute readiness listener");
  return server.handler;
}

// Runs the dedicated OpenClaw worker program, with its node state in
// `directory`/node-state, until it starts its connect child or holds. Real files;
// replaced: runtime asset publication, the model probe (it answers "ok"), the
// readiness listener (`ready()` asks it) and every child process. Doctor runs
// `doctor(child, { ready })`; `node identity` runs `identity(callback)`, which answers
// with a fixed device id by default. `timer` replaces the program's setTimeout.
async function runNativeWorker(
  directory: string,
  doctor: WorkerDoctor = () => assert.fail("Doctor must not run"),
  {
    env = COMPUTE_STATUS_ENV,
    identity = (callback) => callback(null, JSON.stringify({ deviceId: "a".repeat(64) })),
    timer = setTimeout,
  }: WorkerOptions = {},
) {
  const spawned: Array<{ name: WorkerChildName; env: NodeJS.ProcessEnv }> = [];
  const identities: Array<string | undefined> = [];
  const errors: string[] = [];
  const servers: CapturedServer[] = [];
  const fixtureFailure = Promise.withResolvers<never>();
  let holds = 0;
  // The kubelet's readiness request on the Compute status port.
  const ready = async (): Promise<number> => {
    const { status } = await call(readinessHandler(servers), { url: "/readyz" });
    assert.ok(typeof status === "number");
    return status;
  };
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
    setTimeout: timer,
    console: { error: (line: unknown) => errors.push(String(line)), log() {} },
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
      stdout: { write() {} },
      execPath: "/usr/local/bin/node",
      on() {},
      off() {},
      exit: (code: number) => assert.fail(`Native worker exited ${code}: ${errors.join("\n")}`),
    },
    setInterval: () => {
      holds += 1;
    },
    require(specifier: string): unknown {
      if (specifier === "node:http") {
        return { createServer: (handler: RequestHandler) => listener(servers, handler) };
      }
      if (specifier !== "node:child_process") {
        return nodeRequire(specifier);
      }
      return {
        execFile(
          _command: string,
          args: string[],
          _options: ExecFileOptionsWithStringEncoding,
          callback: IdentityCallback,
        ) {
          identities.push(args[2]);
          identity(callback);
        },
        spawnSync: (_command: string, args: string[]) =>
          args.includes("--probe") ? { status: 0, stdout: probe } : { status: 0 },
        spawn(
          _command: string,
          args: [script: string, name: WorkerChildName, ...rest: string[]],
          options: { env: NodeJS.ProcessEnv },
        ) {
          const child = workerChild();
          const [, name] = args;
          spawned.push({ name, env: options.env });
          if (name === "doctor") {
            void nextTurn()
              .then(() => doctor(child, { ready }))
              .catch(fixtureFailure.reject);
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
    await Promise.race([nextTurn(), fixtureFailure.promise]);
  }
  return { spawned, synchronous, identities, errors, holds, ready, servers };
}

test("Native worker connects current and fresh node state without Doctor", async (t) => {
  for (const version of [undefined, STATE_CURRENT]) {
    const directory = await workspaceNodeDirectory(t, version);
    const outcome = await runNativeWorker(directory);
    // Current state adds no await before connect.
    assert.deepEqual(outcome.synchronous, ["connect"]);
    assert.equal(await outcome.ready(), 200);
  }
});

// Each readiness check spawns `openclaw node identity`. The kubelet, the agent Gateway
// and status-proxy callers can ask at once, so concurrent requests share the running
// check instead of each spawning another (finding 1789). No answer is cached: a request
// after the check settles runs a fresh one.
test("Native worker readiness shares one running identity check among concurrent requests", async (t) => {
  const callbacks: IdentityCallback[] = [];
  const outcome = await runNativeWorker(await workspaceNodeDirectory(t, STATE_CURRENT), undefined, {
    identity: (callback) => callbacks.push(callback),
  });
  const answers = Promise.all(Array.from({ length: 5 }, () => outcome.ready()));
  await nextTurn();
  assert.equal(callbacks.length, 1);
  identityResult(callbacks, 0, null, JSON.stringify({ deviceId: "a".repeat(64) }));
  assert.deepEqual(await answers, [200, 200, 200, 200, 200]);
  // A failed fresh check answers 503, not the earlier success.
  const later = outcome.ready();
  await nextTurn();
  assert.equal(callbacks.length, 2);
  identityResult(callbacks, 1, new Error("node identity failed"));
  assert.equal(await later, 503);
  assert.deepEqual(outcome.identities, ["identity", "identity"]);
});

// A check that throws or fails frees the slot as a success does, so a worker that recovers
// reports ready on the next probe instead of keeping the failure. A caller that disconnects
// while it waits gets no answer and does not stop or restart the check the others share.
test("Native worker readiness checks again after a failed check and ignores a disconnected caller", async (t) => {
  const callbacks: IdentityCallback[] = [];
  let throwNext = true;
  const outcome = await runNativeWorker(await workspaceNodeDirectory(t, STATE_CURRENT), undefined, {
    identity: (callback) => {
      if (throwNext) {
        throwNext = false;
        throw new Error("spawn failed");
      }
      callbacks.push(callback);
    },
  });
  assert.deepEqual(await Promise.all([outcome.ready(), outcome.ready()]), [503, 503]);
  const failed = outcome.ready();
  await nextTurn();
  assert.equal(callbacks.length, 1);
  identityResult(callbacks, 0, new Error("node identity failed"));
  assert.equal(await failed, 503);

  const handler = readinessHandler(outcome.servers);
  const first = outcome.ready();
  // node:http marks a response destroyed and emits "close" when its client disconnects.
  const writes: Array<number | "end"> = [];
  const dropped = Object.assign(new EventEmitter<{ close: [] }>(), {
    destroyed: false,
    writeHead: (code: number) => writes.push(code),
    end: () => writes.push("end"),
  });
  handler({ method: "GET", url: "/readyz", headers: {} }, dropped);
  dropped.destroyed = true;
  dropped.emit("close");
  const last = outcome.ready();
  await nextTurn();
  assert.equal(callbacks.length, 2);
  identityResult(callbacks, 1, null, JSON.stringify({ deviceId: "a".repeat(64) }));
  assert.deepEqual(await Promise.all([first, last]), [200, 200]);
  assert.deepEqual(writes, []);
  assert.deepEqual(outcome.identities, ["identity", "identity", "identity"]);
});

// A check that never settles (here an identity call that never answers) holds the shared
// slot only until the outer deadline: every waiting probe answers 503 then, and the next
// probe starts a fresh check instead of waiting on the hung one (finding 2941).
test("Native worker readiness answers 503 at its deadline when a check never settles", async (t) => {
  const callbacks: IdentityCallback[] = [];
  const deadlines: Array<WorkerTimer & { fire(): void }> = [];
  const outcome = await runNativeWorker(await workspaceNodeDirectory(t, STATE_CURRENT), undefined, {
    identity: (callback) => callbacks.push(callback),
    // The readiness deadline (5 s) fires when the test says; other timers run as usual.
    timer: (callback, delay, ...args) => {
      if (delay !== 5000) {
        return setTimeout(callback, delay, ...args);
      }
      const deadline = { fire: () => callback(...args), unref: () => deadline };
      deadlines.push(deadline);
      return deadline;
    },
  });
  const hung = Promise.all([outcome.ready(), outcome.ready()]);
  await nextTurn();
  assert.equal(callbacks.length, 1);
  assert.equal(deadlines.length, 1);
  const [deadline] = deadlines;
  assert.ok(deadline);
  deadline.fire();
  assert.deepEqual(await hung, [503, 503]);

  const next = outcome.ready();
  await nextTurn();
  assert.equal(callbacks.length, 2);
  // The hung check fails late, while the fresh check still runs: its answer reaches no probe
  // and does not free the fresh check's slot, so a probe now joins the fresh check.
  identityResult(callbacks, 0, new Error("node identity failed"));
  await nextTurn();
  const joined = outcome.ready();
  await nextTurn();
  assert.equal(callbacks.length, 2);
  identityResult(callbacks, 1, null, JSON.stringify({ deviceId: "a".repeat(64) }));
  assert.deepEqual(await Promise.all([next, joined]), [200, 200]);
  const after = outcome.ready();
  await nextTurn();
  assert.equal(callbacks.length, 3);
  identityResult(callbacks, 2, new Error("node identity failed"));
  assert.equal(await after, 503);
  assert.deepEqual(outcome.identities, ["identity", "identity", "identity"]);
});

test("Native worker migrates older node state without the model credential before it connects", async (t) => {
  const directory = await workspaceNodeDirectory(t, STATE_CURRENT - 1);
  const nodeState = join(directory, "node-state");
  let readyDuringDoctor: number | undefined;
  const outcome = await runNativeWorker(directory, async (child, { ready }) => {
    readyDuringDoctor = await ready();
    setVersion(sharedPath(nodeState), STATE_CURRENT);
    finishDoctor(child);
  });
  // Readiness does not open the node state while Doctor migrates it.
  assert.equal(readyDuringDoctor, 503);
  assert.deepEqual(outcome.identities, []);
  assert.deepEqual(
    outcome.spawned.map(({ name }) => name),
    ["doctor", "connect"],
  );
  const [doctor, connect] = outcome.spawned;
  assert.ok(doctor && connect);
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
    const directory = await workspaceNodeDirectory(t, STATE_CURRENT - 1);
    const outcome = await runNativeWorker(
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
    // A held worker never reports ready and never opens the older node state.
    if (env === COMPUTE_STATUS_ENV) {
      assert.equal(await outcome.ready(), 503);
    }
    assert.deepEqual(outcome.identities, []);
    const message = outcome.errors.at(-1);
    assert.ok(message);
    assert.match(
      message,
      /^Native worker state migration failed: openclaw doctor --fix \(exit-1\) left /,
    );
    assert.match(message, /then deploy the Agent again\.$/);
    assert.equal(readVersion(sharedPath(join(directory, "node-state"))), STATE_CURRENT - 1);
    await assertHeldFailureServed(outcome.servers, env, "state-migration");
  }
});
