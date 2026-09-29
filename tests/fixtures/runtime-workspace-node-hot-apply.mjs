import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";

// Runs inside a runtime image Gateway container started by the Kubernetes
// Gateway wrapper with an absent workspace node binding. It pairs a real node
// host, writes the binding the way the kubelet refreshes a ConfigMap volume,
// and checks that the running OpenClaw loads file-transfer and serves the
// Agent workspace from the node without a Gateway process restart.
const execute = promisify(execFile);
const cli = "/app/openclaw.mjs";
const displayName = "runtime-workspace-node-proof";
const bindingPath = process.env.OPENCLAW_WORKSPACE_NODE_PATH;
const statusUrl = `http://127.0.0.1:${process.env.OPENCLAW_RUNTIME_STATUS_PORT}/openclaw/runtime/status`;
const configPath = "/home/node/.openclaw/openclaw.json";
const nodeRoot = "/home/node/workspace";
const localRoot = process.env.OCC_TEST_GATEWAY_WORKSPACE;

async function call(method, params = {}) {
  const { stdout } = await execute(
    process.execPath,
    [
      cli,
      "gateway",
      "call",
      method,
      "--url",
      "ws://127.0.0.1:8080",
      "--password",
      process.env.OPENCLAW_GATEWAY_PASSWORD,
      "--params",
      JSON.stringify(params),
      "--json",
    ],
    { timeout: 30_000, maxBuffer: 16_000_000 },
  );
  return JSON.parse(stdout);
}

// The OpenClaw Gateway process the wrapper spawned, with its kernel start time.
// OpenClaw retitles itself, so its command line reads `openclaw-gateway`.
async function gatewayProcesses() {
  const found = [];
  for (const pid of await readdir("/proc")) {
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid) {
      continue;
    }
    const argv = (await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "")).split("\0");
    if (argv[0].trim() === "openclaw-gateway") {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const startTicks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      found.push({
        pid: Number(pid),
        startTicks,
        argv: argv.filter(Boolean).slice(0, 4).join(" "),
      });
    }
  }
  assert.equal(found.length, 1, "one OpenClaw Gateway process is running");
  return found.sort((left, right) => left.pid - right.pid);
}

async function fileTransfer() {
  const list = await call("plugins.list");
  const plugin = list.plugins.find(({ id }) => id === "file-transfer");
  return { state: plugin?.runtime?.state, generation: list.generation };
}

async function runtimeStatus() {
  return await (await fetch(statusUrl)).json();
}

async function readAgentFile(name) {
  const result = await call("agents.files.get", { agentId: "main", name });
  return result.file?.content;
}

let node;
let nodeLog = "";
try {
  // Distinct content on each side shows which host served the read.
  await mkdir(localRoot, { recursive: true });
  await writeFile(`${localRoot}/AGENTS.md`, "served by the Gateway host\n");
  await mkdir(nodeRoot, { recursive: true });
  await writeFile(`${nodeRoot}/AGENTS.md`, "served by the workspace node\n");

  const state = "/home/node/workspace-node-host";
  await mkdir(state, { recursive: true, mode: 0o700 });
  await writeFile(
    `${state}/openclaw.json`,
    JSON.stringify({
      agents: { defaults: { workspace: nodeRoot } },
      plugins: {
        allow: ["file-transfer"],
        slots: { memory: "none" },
        entries: { "file-transfer": { enabled: true } },
      },
      nodeHost: { skills: { enabled: false } },
    }),
    { mode: 0o600 },
  );
  const setup = await call("device.pair.setupCode", {
    publicUrl: "ws://127.0.0.1:8080",
    bootstrapProfile: "node",
    includeQr: false,
  });
  await writeFile(`${state}/connect-target`, setup.setupCode, { mode: 0o600 });
  node = spawn(
    process.execPath,
    [
      cli,
      "connect",
      "--target-file",
      `${state}/connect-target`,
      "--ephemeral",
      "--display-name",
      displayName,
    ],
    {
      env: {
        PATH: process.env.PATH,
        HOME: "/home/node",
        OPENCLAW_STATE_DIR: state,
        OPENCLAW_CONFIG_PATH: `${state}/openclaw.json`,
        OPENCLAW_NO_AUTO_UPDATE: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  node.stdout.on("data", (data) => (nodeLog += data));
  node.stderr.on("data", (data) => (nodeLog += data));
  let nodeId;
  for (let attempt = 0; attempt < 120 && nodeId === undefined; attempt++) {
    if (node.exitCode !== null) {
      throw new Error(`Node host exited: ${nodeLog}`);
    }
    const { nodes } = await call("node.list");
    nodeId = nodes.find((item) => item.connected && item.displayName === displayName)?.nodeId;
    if (nodeId === undefined) {
      await setTimeout(500);
    }
  }
  assert.ok(nodeId, `node host did not connect: ${nodeLog}`);

  const gatewayBefore = await gatewayProcesses();
  const configBefore = JSON.parse(await readFile(configPath, "utf8"));
  const transferBefore = await fileTransfer();
  const statusBefore = await runtimeStatus();
  const beforeContent = await readAgentFile("AGENTS.md");
  assert.equal(configBefore.plugins.allow.includes("file-transfer"), false);
  assert.notEqual(transferBefore.state, "active");
  assert.equal(statusBefore.workspaceNodeId, undefined);
  assert.equal(beforeContent, "served by the Gateway host\n");

  // The kubelet swaps a refreshed ConfigMap volume in with a rename.
  const writtenAt = Date.now();
  await mkdir(bindingPath.slice(0, bindingPath.lastIndexOf("/")), { recursive: true });
  await writeFile(
    `${bindingPath}.new`,
    JSON.stringify({ revisionId: process.env.OPENCLAW_AGENT_REVISION_ID, deviceId: nodeId }),
  );
  await rename(`${bindingPath}.new`, bindingPath);

  let status;
  for (let attempt = 0; attempt < 240; attempt++) {
    status = await runtimeStatus();
    if (status.workspaceNodeId !== undefined || status.workspaceNodeFailure !== undefined) {
      break;
    }
    await setTimeout(250);
  }
  const ackMs = Date.now() - writtenAt;
  assert.equal(status.workspaceNodeFailure, undefined, JSON.stringify(status));
  assert.equal(status.workspaceNodeId, nodeId);

  const transferAfter = await fileTransfer();
  assert.equal(transferAfter.state, "active");
  assert.notEqual(transferAfter.generation, transferBefore.generation);
  const configAfter = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(configAfter.gateway, configBefore.gateway, "gateway.* is untouched");
  assert.equal(configAfter.plugins.allow.includes("file-transfer"), true);
  assert.equal(configAfter.plugins.entries["file-transfer"].enabled, true);
  assert.deepEqual(configAfter.plugins.entries["file-transfer"].config.workspaces.main, {
    nodeId,
    remoteRoot: nodeRoot,
  });
  const gatewayAfter = await gatewayProcesses();
  assert.deepEqual(gatewayAfter, gatewayBefore, "the OpenClaw Gateway process was not restarted");

  // The Agent workspace is now served through the paired node.
  const afterContent = await readAgentFile("AGENTS.md");
  assert.equal(afterContent, "served by the workspace node\n");

  console.log(
    JSON.stringify({
      nodeId,
      ackMs,
      gatewayProcesses: gatewayAfter,
      sameProcesses: JSON.stringify(gatewayAfter) === JSON.stringify(gatewayBefore),
      fileTransferBefore: transferBefore,
      fileTransferAfter: transferAfter,
      readBefore: beforeContent.trim(),
      readAfter: afterContent.trim(),
    }),
  );
} finally {
  if (node && node.exitCode === null && node.signalCode === null) {
    const exited = once(node, "exit");
    node.kill("SIGTERM");
    await exited;
  }
}
