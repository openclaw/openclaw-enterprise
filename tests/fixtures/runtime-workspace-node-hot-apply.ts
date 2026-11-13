import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import { once } from "node:events";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import type { Readable } from "node:stream";
import { setTimeout } from "node:timers/promises";
import type { WorkspaceNodeGatewayReplies } from "./runtime-workspace-node.ts";

interface GatewayReplies extends WorkspaceNodeGatewayReplies {
  "plugins.list": {
    plugins: { id: string; runtime?: { state?: string } }[];
    generation: number;
  };
  "agents.files.get": { file?: { content?: string } };
}

interface GatewayRuntime {
  callGatewayFromCli<Method extends keyof GatewayReplies>(
    method: Method,
    connection: { url: string; password: string | undefined; json: boolean; timeout: string },
    params: Record<string, unknown>,
    options: { progress: boolean },
  ): Promise<GatewayReplies[Method]>;
}

interface GatewayProcess {
  pid: number;
  startTicks: string;
  argv: string;
}

interface FileTransferState {
  state: string | undefined;
  generation: number;
}

interface RuntimeStatus {
  workspaceNodeId?: string;
  workspaceNodeFailure?: { code: string; checkedAt: string };
}

interface GatewayConfig {
  gateway: unknown;
  plugins: {
    allow: string[];
    entries: Record<
      string,
      { enabled: boolean; config: { workspaces: { main: { nodeId: string; remoteRoot: string } } } }
    >;
  };
}

export interface WorkspaceNodeHotApplyReceipt {
  nodeId: string;
  ackMs: number;
  gatewayProcesses: GatewayProcess[];
  sameProcesses: boolean;
  fileTransferBefore: FileTransferState;
  fileTransferAfter: FileTransferState;
  readBefore: string;
  readAfter: string;
}

const gatewayRuntimeSpecifier = "openclaw/plugin-sdk/gateway-runtime";
const { callGatewayFromCli } = (await import(gatewayRuntimeSpecifier)) as GatewayRuntime;

// Runs inside a runtime image Gateway container started by the Kubernetes
// Gateway wrapper with an absent workspace node binding. It pairs a real node
// host, writes the binding the way the kubelet refreshes a ConfigMap volume,
// and checks that the running OpenClaw loads file-transfer and serves the
// Agent workspace from the node without a Gateway process restart.
const cli = "/app/openclaw.mjs";
const displayName = "runtime-workspace-node-proof";
const bindingPath = process.env.OPENCLAW_WORKSPACE_NODE_PATH;
const statusUrl = `http://127.0.0.1:${process.env.OPENCLAW_RUNTIME_STATUS_PORT}/openclaw/runtime/status`;
const configPath = "/home/node/.openclaw/openclaw.json";
const nodeRoot = "/home/node/workspace";
const localRoot = process.env.OCC_TEST_GATEWAY_WORKSPACE;
assert.ok(localRoot, "OCC_TEST_GATEWAY_WORKSPACE is required.");
assert.ok(bindingPath, "OPENCLAW_WORKSPACE_NODE_PATH is required.");

async function call<Method extends keyof GatewayReplies>(
  method: Method,
  params: Record<string, unknown> = {},
): Promise<GatewayReplies[Method]> {
  try {
    return await callGatewayFromCli(
      method,
      {
        url: "ws://127.0.0.1:8080",
        password: process.env.OPENCLAW_GATEWAY_PASSWORD,
        json: true,
        timeout: "30000",
      },
      params,
      { progress: false },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${method}: ${message}`, { cause: error });
  }
}

// The OpenClaw Gateway process the wrapper spawned, with its kernel start time.
// OpenClaw retitles itself, so its command line reads `openclaw-gateway`.
async function gatewayProcesses() {
  const found: GatewayProcess[] = [];
  for (const pid of await readdir("/proc")) {
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid) {
      continue;
    }
    const argv = (await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "")).split("\0");
    if (argv[0]?.trim() === "openclaw-gateway") {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const startTicks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      assert.ok(startTicks, "Expected the Gateway process start time.");
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

async function fileTransfer(): Promise<FileTransferState> {
  const list = await call("plugins.list");
  const plugin = list.plugins.find(({ id }) => id === "file-transfer");
  return { state: plugin?.runtime?.state, generation: list.generation };
}

async function runtimeStatus(): Promise<RuntimeStatus> {
  return (await (await fetch(statusUrl)).json()) as RuntimeStatus;
}

async function readAgentFile(name: string) {
  const result = await call("agents.files.get", { agentId: "main", name });
  return result.file?.content;
}

let node: ChildProcessByStdio<null, Readable, Readable> | undefined;
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
  node.stdout.on("data", (data: Buffer) => (nodeLog += data));
  node.stderr.on("data", (data: Buffer) => (nodeLog += data));
  let nodeId: string | undefined;
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
  const configBefore = JSON.parse(await readFile(configPath, "utf8")) as GatewayConfig;
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

  let status: RuntimeStatus | undefined;
  for (let attempt = 0; attempt < 240; attempt++) {
    status = await runtimeStatus();
    if (status.workspaceNodeId !== undefined || status.workspaceNodeFailure !== undefined) {
      break;
    }
    await setTimeout(250);
  }
  const ackMs = Date.now() - writtenAt;
  assert.ok(status);
  assert.equal(status.workspaceNodeFailure, undefined, JSON.stringify(status));
  assert.equal(status.workspaceNodeId, nodeId);

  const transferAfter = await fileTransfer();
  assert.equal(transferAfter.state, "active");
  assert.notEqual(transferAfter.generation, transferBefore.generation);
  const configAfter = JSON.parse(await readFile(configPath, "utf8")) as GatewayConfig;
  assert.deepEqual(configAfter.gateway, configBefore.gateway, "gateway.* is untouched");
  assert.equal(configAfter.plugins.allow.includes("file-transfer"), true);
  const transferEntry = configAfter.plugins.entries["file-transfer"];
  assert.ok(transferEntry);
  assert.equal(transferEntry.enabled, true);
  assert.deepEqual(transferEntry.config.workspaces.main, {
    nodeId,
    remoteRoot: nodeRoot,
  });
  const gatewayAfter = await gatewayProcesses();
  assert.deepEqual(gatewayAfter, gatewayBefore, "the OpenClaw Gateway process was not restarted");

  // The Agent workspace is now served through the paired node.
  const afterContent = await readAgentFile("AGENTS.md");
  assert.equal(afterContent, "served by the workspace node\n");

  const receipt: WorkspaceNodeHotApplyReceipt = {
    nodeId,
    ackMs,
    gatewayProcesses: gatewayAfter,
    sameProcesses: JSON.stringify(gatewayAfter) === JSON.stringify(gatewayBefore),
    fileTransferBefore: transferBefore,
    fileTransferAfter: transferAfter,
    readBefore: beforeContent.trim(),
    readAfter: afterContent.trim(),
  };
  console.log(JSON.stringify(receipt));
} finally {
  if (node && node.exitCode === null && node.signalCode === null) {
    const exited = once(node, "exit");
    node.kill("SIGTERM");
    await exited;
  }
}
