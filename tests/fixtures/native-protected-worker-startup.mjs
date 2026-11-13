import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  COMPUTE_RELEASE_PUBLIC_KEY,
  computeReleasePublicKey,
  HARNESS_EGRESS_ENROLLMENT_PATH,
  harnessEgressEnrollment,
  NATIVE_MODEL_ENROLLMENT_ENV,
  NATIVE_MODEL_ORIGIN_ENV,
  signComputeExecutionRelease,
} from "../../apps/controller/src/drivers/compute/egress-enrollment.ts";
import { PROTECTED_NATIVE_WORKER_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { nodeProgramArguments } from "../../apps/controller/src/drivers/compute/node-program.ts";

const upstreamOrigin = "https://models.example.test";
const transportToken = "fixture-native-worker-transport";
const modelId = "fixture-model";
const upstreamBase = upstreamOrigin + "/v1";
const plan = {
  authorization: "online-request",
  id: "fixture-plan",
  generation: 1,
  routes: [{ binding: { grant: { kind: "inference" } } }],
  execution: {
    installationId: "installation",
    namespaceId: "namespace",
    agentId: "agent",
    servicePrincipalId: "principal",
    revisionId: "revision",
    executionId: "execution",
  },
};

function fixture(directory, probeStatus, probeGate) {
  const skills = join(directory, "skills");
  mkdirSync(skills);
  writeFileSync(join(skills, "fixture"), "");
  // Use the real compressed launcher and HTTP enrollment. Only substitute the
  // image executables and skill mount, each with a disposable process or file.
  const preload = join(directory, "image.cjs");
  writeFileSync(
    preload,
    String.raw`
const cp = require("node:child_process");
const fs = require("node:fs");
const { join } = require("node:path");
const fixture = process.env.HOME;
// Advance long observation and probe timers only inside this launcher. The image processes,
// socket deadlines, model sender startup and test runner use their real clocks.
const timers = new Map();
const schedule = setTimeout;
const now = Date.now;
let elapsed = 0;
let sender;
Date.now = () => now() + elapsed;
global.setTimeout = (callback, delay, ...args) => {
  const handle = schedule(callback, delay, ...args);
  if (delay >= 60000) timers.set(handle, { at: elapsed + delay, callback, args });
  return handle;
};
const cancel = clearTimeout;
global.clearTimeout = (handle) => { timers.delete(handle); cancel(handle); };
process.on("message", (command) => {
  if (command === "probe") {
    sender.stdin.end("start");
  } else {
    elapsed += command;
    for (const [handle, task] of timers) {
      if (task.at <= elapsed) {
        clearTimeout(handle);
        task.callback(...task.args);
      }
    }
  }
  process.send(command);
});
for (const name of ["existsSync", "lstatSync", "readdirSync", "cpSync"]) {
  const run = fs[name];
  fs[name] = (source, ...args) => run(
    source === "/app/skills" ? join(fixture, "skills") : source,
    ...args,
  );
}
for (const name of ["spawn", "spawnSync", "execFile"]) {
  const run = cp[name];
  cp[name] = (executable, args, options, ...rest) => {
    if (executable === "/opt/oce/bin/openclaw-model-sender") {
      sender = run(process.execPath, [join(fixture, "sender.cjs"), ...args], {
        ...options, stdio: ["pipe", ...options.stdio.slice(1)],
      });
      return sender;
    }
    if (args.includes("/app/openclaw.mjs")) {
      return run(process.execPath, args.map((arg) => arg === "/app/openclaw.mjs" ? join(fixture, "openclaw.cjs") : arg), options, ...rest);
    }
    return run(executable, args, options, ...rest);
  };
}
`,
  );
  writeFileSync(
    join(directory, "sender.cjs"),
    String.raw`
const assert = require("node:assert/strict");
const { createServer } = require("node:http");
assert.deepEqual(process.argv.slice(2), ["--origin", "https://models.example.test"]);
assert.deepEqual(Object.keys(process.env), []);
const server = createServer((request, response) => {
  assert.equal(request.method, "POST");
  assert.equal(request.url, "/v1/responses");
  assert.equal(request.headers.authorization, "Bearer oce:request-authorized:model");
  response.end("fixture model response");
});
server.listen(0, "127.0.0.1", () => {
  process.stdin.once("data", () => process.stdout.write(JSON.stringify({ port: server.address().port }) + "\n"));
});
`,
  );
  writeFileSync(
    join(directory, "openclaw.cjs"),
    String.raw`
const assert = require("node:assert/strict");
const { readFileSync, statSync } = require("node:fs");
const config = JSON.parse(readFileSync(process.env.OPENCLAW_CONFIG_PATH, "utf8"));
const provider = config.models.providers.openai;
assert.equal(process.env.OPENAI_API_KEY, "oce:request-authorized:model");
assert.match(provider.baseUrl, /^http:\/\/127\.0\.0\.1:[0-9]+\/v1$/);
if (process.argv[2] === "models") {
  assert.equal(provider.request.allowPrivateNetwork, true);
  fetch(provider.baseUrl + "/responses", {
    method: "POST",
    headers: { Authorization: "Bearer " + process.env.OPENAI_API_KEY },
  }).then(async (response) => {
    assert.equal(await response.text(), "fixture model response");
    await (await fetch(${JSON.stringify(probeGate)})).text();
    console.log(JSON.stringify({ auth: { probes: { results: [
      { provider: "openai", model: "openai/fixture-model", source: "env", status: ${JSON.stringify(probeStatus)} },
    ] } } }));
  }).catch((error) => { console.error(error); process.exitCode = 1; });
} else {
  assert.equal(process.argv[2], "connect");
  assert.equal(provider.models[0].baseUrl, provider.baseUrl);
  assert.ok(!process.env.OPENCLAW_CONFIG_PATH.startsWith(process.env.OPENCLAW_STATE_DIR + "/"));
  assert.equal(statSync(process.env.OPENCLAW_CONFIG_PATH).mode & 0o777, 0o400);
  assert.equal(process.env.OPENCLAW_NATIVE_MODEL_ORIGIN, undefined);
  assert.equal(process.env.OPENCLAW_NATIVE_MODEL_ENROLLMENT, undefined);
  assert.equal(process.env.OPENCLAW_EGRESS_COMPUTE_RELEASE_PUBLIC_KEY, undefined);
  console.log(JSON.stringify({ event: "node-connect", endpoint: provider.baseUrl }));
  setInterval(() => {}, 1000);
}
`,
  );
  return preload;
}

export async function exerciseProtectedNativeWorkerStartup(t) {
  const { privateKey } = generateKeyPairSync("ed25519");
  let previousRelease;
  for (const [name, status, lateProbe] of [
    ["held before the observation boundary", "auth", false],
    ["held after the observation boundary", "auth", true],
    ["connected after the observation boundary", "ok", true],
    ["deadline while the probe is running", "deadline", true],
    ["terminated while the probe is running", "terminate", true],
  ]) {
    await t.test(name, async (subtest) => {
      previousRelease = await runLauncher(subtest, privateKey, previousRelease, status, lateProbe);
    });
  }
}

async function runLauncher(t, privateKey, previousRelease, probeStatus, lateProbe) {
  const directory = mkdtempSync(join(tmpdir(), "oce-protected-native-worker-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const gate = createHttpServer().listen(0, "127.0.0.1");
  await once(gate, "listening");
  t.after(() => {
    gate.closeAllConnections();
    gate.close();
  });

  const preload = fixture(directory, probeStatus, "http://127.0.0.1:" + gate.address().port);
  const socket = createServer().listen(0, "127.0.0.1");
  await once(socket, "listening");
  const { port } = socket.address();
  socket.close();
  await once(socket, "close");
  const model = { id: modelId, api: "openai-responses" };
  const worker = spawn(
    process.execPath,
    ["--require", preload, "-e", ...nodeProgramArguments(PROTECTED_NATIVE_WORKER_ENTRYPOINT)],
    {
      env: {
        PATH: dirname(process.execPath),
        HOME: directory,
        TMPDIR: join(directory, "tmp"),
        OPENCLAW_NODE_STATE_DIR: join(directory, "node-state"),
        OPENCLAW_NODE_SETUP_CODE: "fixture-setup",
        OPENCLAW_WORKSPACE_DIR: join(directory, "workspace"),
        OPENCLAW_NATIVE_WORKER_CAPACITY: "1",
        OPENCLAW_NATIVE_INFERENCE_CONFIG: JSON.stringify({
          models: {
            providers: {
              openai: { baseUrl: upstreamBase, models: [{ ...model, baseUrl: upstreamBase }] },
            },
          },
        }),
        OPENCLAW_HARNESS_PROBE_CONFIG: JSON.stringify({
          agents: { defaults: { model: "openai/" + modelId } },
          models: {
            providers: { openai: { baseUrl: upstreamBase, api: model.api, models: [model] } },
          },
        }),
        OPENCLAW_HARNESS_MODEL: "openai/" + modelId,
        OPENCLAW_HARNESS_PROVIDER: "openai",
        OPENCLAW_HARNESS_CREDENTIAL_ENV: "OPENAI_API_KEY",
        OPENAI_API_KEY: "oce:request-authorized:model",
        APP_SERVER_PORT: String(port),
        APP_TOKEN_SHA: createHash("sha256").update(transportToken).digest("hex"),
        OPENCLAW_EGRESS_ENROLLMENT_REVISION_ID: plan.execution.revisionId,
        [COMPUTE_RELEASE_PUBLIC_KEY]: computeReleasePublicKey(privateKey),
        [NATIVE_MODEL_ENROLLMENT_ENV]: JSON.stringify(harnessEgressEnrollment(plan)),
        [NATIVE_MODEL_ORIGIN_ENV]: upstreamOrigin,
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  const exited = once(worker, "exit");
  t.after(async () => {
    worker.kill("SIGTERM");
    await exited;
  });
  let diagnostics = "";
  worker.stderr.setEncoding("utf8").on("data", (chunk) => {
    diagnostics += chunk;
  });
  let output = "";
  worker.stdout.setEncoding("utf8").on("data", (chunk) => {
    output += chunk;
  });
  const url = "http://127.0.0.1:" + port + HARNESS_EGRESS_ENROLLMENT_PATH;
  const headers = {
    Authorization: "Bearer " + transportToken,
    "content-type": "application/json",
  };
  const request = async () => {
    try {
      return await fetch(url, { headers });
    } catch {
      return undefined;
    }
  };
  const held = await waitFor(
    async () => (await request())?.json(),
    worker,
    () => diagnostics,
  );
  assert.equal(output, "");
  assert.doesNotMatch(diagnostics, /model_probe/);
  assert.equal(held.plan?.id, plan.id, "must serve the held release challenge");
  const release = (startupId) =>
    signComputeExecutionRelease(privateKey, startupId, {
      plan,
      sandboxId: "fixture-sandbox",
      enforcement: { instanceId: "instance", configurationId: "configuration" },
    });
  const send = (body) => fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  if (previousRelease) {
    assert.notEqual(previousRelease.challenge.startupId, held.startupId);
    assert.equal((await send(previousRelease)).status, 409);
  }
  const expired = release(held.startupId);
  expired.expiresAt = Date.now() - 1000;
  expired.signature = sign(
    null,
    Buffer.from(JSON.stringify([expired.challenge, expired.installation, expired.expiresAt])),
    privateKey,
  ).toString("base64url");
  assert.equal((await send(expired)).status, 409);
  assert.equal((await request()).status, 200);
  assert.equal(output, "");
  assert.doesNotMatch(diagnostics, /model_probe/);

  const signedRelease = release(held.startupId);
  const accepted = await send(signedRelease);
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { enrolled: true, startupId: held.startupId });
  const control = async (command) => {
    const ack = once(worker, "message");
    worker.send(command);
    assert.deepEqual(await ack, [command, undefined]);
  };
  const observe = async () => {
    assert.deepEqual(
      await (await fetch(url, { headers, signal: AbortSignal.timeout(1500) })).json(),
      {
        acceptedRelease: signedRelease,
      },
    );
    assert.equal((await send(signedRelease)).status, 410);
    assert.equal((await fetch(url)).status, 401);
  };
  const statusUrl = new URL("/openclaw/runtime/status", url);
  const readFailure = async () => {
    const response = await fetch(statusUrl, { headers });
    return response.ok && (await response.json()).runtimeFailure;
  };
  await control(599999);
  await observe();
  assert.equal(await readFailure(), false);
  if (lateProbe) {
    await control(2);
    await observe();
  }
  const probeEntered = once(gate, "request", { signal: AbortSignal.timeout(5000) });
  await control("probe");
  const [, probeResponse] = await probeEntered;
  try {
    await observe();
    assert.equal(await readFailure(), false);
    assert.equal(output, "");
    if (probeStatus === "terminate" || probeStatus === "deadline") {
      const closed = once(probeResponse, "close", { signal: AbortSignal.timeout(3000) });
      if (probeStatus === "terminate") {
        worker.kill("SIGTERM");
        assert.deepEqual(await exited, [0, null]);
      } else {
        await control(600001);
      }
      await closed;
      assert.equal(probeResponse.writableEnded, false);
      if (probeStatus === "terminate") {
        return signedRelease;
      }
    }
  } finally {
    probeResponse.end();
  }
  let connected;
  if (probeStatus === "ok") {
    await waitFor(
      () => output.includes("\n"),
      worker,
      () => diagnostics,
    );
    connected = JSON.parse(output);
    assert.equal(connected.event, "node-connect");
    assert.match(connected.endpoint, /^http:\/\/127\.0\.0\.1:[0-9]+\/v1$/);
    assert.match(diagnostics, /"event":"openclaw.model_probe".*"code":"READY"/);
  } else {
    const failure = await waitFor(readFailure, worker, () => diagnostics);
    assert.equal(failure.check, "model-probe");
    assert.equal(
      failure.code,
      probeStatus === "deadline" ? "MODEL_PROBE_TIMEOUT" : "AUTHENTICATION_FAILED",
    );
    if (!lateProbe) {
      await control(2);
    }
    assert.deepEqual(await readFailure(), failure);
    assert.equal((await fetch(statusUrl)).status, 401);
    assert.equal(output, "");
  }
  await observe();
  worker.kill("SIGTERM");
  assert.deepEqual(await exited, [0, null]);
  const refused = (error) => error.cause?.code === "ECONNREFUSED";
  await assert.rejects(fetch(url, { headers }), refused);
  if (connected) {
    await assert.rejects(fetch(connected.endpoint + "/responses"), refused);
  }
  return signedRelease;
}

async function waitFor(read, worker, diagnostics) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && worker.exitCode === null) {
    const result = await read();
    if (result) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("Native worker did not reach its expected state.\n" + diagnostics());
}
