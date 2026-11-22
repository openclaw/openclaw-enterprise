import { randomBytes, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { startDispatchProvider } from "./automation-model-only-dispatch-provider.mjs";
import { loadDispatchScenario } from "./automation-model-only-dispatch-scenarios.mjs";

const execute = promisify(execFile);
const input = JSON.parse(readFileSync("/fixture/input.json", "utf8"));
const { harness, dummyCredential, transportToken, nonce } = input;
const gatewayPassword = randomBytes(32).toString("base64url");
const workspace = harness === "codex" ? "/home/node/workspace" : "/home/node/.openclaw/workspace";
mkdirSync(workspace, { recursive: true });
const scenario = await loadDispatchScenario(input.scenario, { nonce, harness, workspace });
let sink;
const provider = await startDispatchProvider({
  harness,
  credential: dummyCredential,
  nonce,
  workspace,
  probe: input.probe,
  strategy: scenario?.strategy,
});
const children = [];
const stderr = [];
const common = {
  ...input.scenarioEnvironment,
  PATH: process.env.PATH,
  HOME: "/home/node",
  NODE_EXTRA_CA_CERTS: "/fixture/ca.pem",
  SSL_CERT_FILE: "/fixture/ca.pem",
  CODEX_CA_CERTIFICATE: "/fixture/ca.pem",
};
function start(label, args, env) {
  const child = spawn(process.execPath, ["-e", ...args], {
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (chunk) => {
    stderr.push(label + ": " + chunk.toString());
    if (stderr.length > 100) {
      stderr.shift();
    }
  });
  children.push(child);
  return child;
}
async function until(label, probe, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result) {
      return result;
    }
    assert.ok(
      children.every((child) => child.exitCode === null),
      `${label}: native process exited`,
    );
    await delay(250);
  }
  throw new Error(`${label}: timed out`);
}
const gatewayEnv = {
  ...common,
  OPENCLAW_CONFIG_PATH: "/fixture/openclaw.json",
  OPENCLAW_GATEWAY_PORT: "18800",
  OPENCLAW_GATEWAY_PASSWORD: gatewayPassword,
  OPENCLAW_STATE_DIR: "/home/node/.openclaw",
  ...(harness === "codex"
    ? { APP_SERVER_URL: "ws://127.0.0.1:18790", APP_SERVER_TOKEN: transportToken }
    : { OPENAI_API_KEY: dummyCredential }),
};
async function rpc(method, params) {
  const result = await execute(
    process.execPath,
    [
      "/app/openclaw.mjs",
      "gateway",
      "call",
      method,
      "--url",
      "ws://127.0.0.1:18800",
      "--password",
      gatewayPassword,
      "--json",
      "--params",
      JSON.stringify(params),
    ],
    { env: gatewayEnv, timeout: 20000, maxBuffer: 1024 * 1024 },
  );
  return JSON.parse(result.stdout);
}
try {
  sink = await scenario?.module.startSink?.({ nonce });
  start("gateway", input.gatewayEntrypoint, gatewayEnv);
  await until(
    "Gateway readiness",
    async () => {
      try {
        return (await fetch("http://127.0.0.1:18800/readyz")).status === 200;
      } catch {
        return false;
      }
    },
    90000,
  );
  const parentSessionKey = `agent:main:dispatch-positive-${randomUUID()}`;
  const positive = await fetch("http://127.0.0.1:18800/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${gatewayPassword}`,
      "content-type": "application/json",
      "x-openclaw-session-key": parentSessionKey,
    },
    body: JSON.stringify({
      model: "openclaw/default",
      messages: [
        {
          role: "user",
          content: `${provider.markerFor("positive")} Execute the requested local dispatch probe once.`,
        },
      ],
    }),
    signal: AbortSignal.timeout(scenario ? 120000 : 60000),
  });
  assert.equal(positive.status, 200, "ordinary chat must complete through the genuine runtime");
  await positive.text();
  assert.equal(
    provider.cases.get("positive")?.complete,
    true,
    "ordinary dispatch requires a correlated tool result",
  );
  const scheduled = await rpc("cron.add", {
    name: input.nonemptyCap ? "Supplemental MCP-cap dispatch" : "Supplemental model-only dispatch",
    enabled: true,
    agentId: "main",
    declarationKey: `occ-dispatch-${nonce}`,
    schedule: { kind: "at", at: new Date(Date.now() + 3000).toISOString() },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: {
      kind: "agentTurn",
      message: `${provider.markerFor("negative")} Execute the same local dispatch probe once.`,
      toolsAllow: input.nonemptyCap ? ["qa__allowed_probe"] : [],
    },
    delivery: { mode: "none" },
  });
  const job = scheduled.job ?? scheduled;
  assert.ok(job.id);
  await until(
    "scheduled rejected dispatch",
    async () => provider.cases.get("negative")?.complete,
    60000,
  );
  assert.equal(
    provider.cases.get("negative").rejected,
    true,
    "the native runtime must reject the injected unavailable tool call",
  );
  const requests = provider.records.filter(
    (record) => record.event === "model-request" && record.phase === "negative",
  );
  assert.ok(requests.length > 0);
  if (input.nonemptyCap) {
    assert.ok(
      requests.every(
        (request) =>
          request.tools.length > 0 &&
          request.tools.every(
            (tool) =>
              typeof tool.name === "string" &&
              (tool.name === "qa__allowed_probe" ||
                tool.name.endsWith("__qa__allowed_probe") ||
                (tool.name === "allowed_probe" && ["qa", "mcp__qa"].includes(tool.namespace))),
          ),
      ),
      "each scheduled request must advertise only the configured MCP operation",
    );
  } else {
    assert.ok(
      requests.every((request) => request.tools.length === 0),
      "every scheduled request must advertise zero tools",
    );
  }
  const runs = await until("native run history", async () => {
    const history = await rpc("cron.runs", { id: job.id, limit: 10 });
    return history.entries?.length ? history : undefined;
  });
  let scenarioEvidence;
  if (scenario) {
    assert.equal(
      typeof scenario.module.verify,
      "function",
      "scenario must verify independent real effects",
    );
    scenarioEvidence = await scenario.module.verify({
      rpc,
      nonce,
      providerRecords: provider.records,
      parentSessionKey,
      jobId: job.id,
      sink,
      until,
      harness,
    });
    assert.equal(scenarioEvidence.positiveEffectVerified, true);
    assert.equal(scenarioEvidence.negativeEffectAbsent, true);
  }
  assert.equal(
    provider.records.some((record) => record.event === "provider-contract-failure"),
    false,
    "synthetic provider must satisfy its own transport contract",
  );
  console.log(
    JSON.stringify({
      kind: "supplemental-dispatch-projection",
      harness,
      probe: input.probe,
      scenarioEvidence,
      realRuntime: true,
      realProvider: false,
      positiveCorrelatedDispatchResult: true,
      negativeToolsEmpty: !input.nonemptyCap,
      negativeMcpOnly: Boolean(input.nonemptyCap),
      negativeCorrelatedRejection: true,
      nativeRunRecorded: runs.entries.length > 0,
      nativeRunStatus: runs.entries[0].status,
      observations: provider.records,
    }),
  );
  // Keep both native processes alive until the host independently verifies the
  // selected Harness filesystem; shared-container paths are not evidence.
  await until("host filesystem verification", async () =>
    existsSync("/tmp/dispatch-proof-release"),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      kind: "supplemental-dispatch-projection-failure",
      harness,
      reason: error.message,
      nativeDiagnostics: stderr.join("").slice(-10000),
      observations: provider.records,
    }),
  );
  process.exitCode = 1;
} finally {
  for (const child of children.reverse()) {
    child.kill("SIGTERM");
  }
  await Promise.all(
    children.map((child) =>
      child.exitCode !== null
        ? undefined
        : Promise.race([
            new Promise((resolve) => child.once("exit", resolve)),
            delay(5000).then(() => child.kill("SIGKILL")),
          ]),
    ),
  );
  await Promise.all([provider.close(), sink?.close?.()]);
}
