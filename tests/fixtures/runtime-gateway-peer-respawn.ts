import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { setTimeout } from "node:timers/promises";

// Runs inside a runtime image Gateway container started by the Kubernetes
// Gateway wrapper for a dedicated Codex Harness with a plugin selection. It
// stands in for the Harness plugin status endpoint, replaces the Harness (a new
// startup, pod and plugin result), and checks that the wrapper respawns only
// the OpenClaw process: readiness, judged by the production HTTP endpoint,
// drops and returns only when the new process serves with the new credential
// and plugin result, and the new process re-acknowledges the workspace node.
// The launcher passes the credential derivation domain.
const tokenDomain = process.env.OCC_TEST_TOKEN_DOMAIN;
const revisionId = process.env.OPENCLAW_AGENT_REVISION_ID;
const statusPort = Number(process.env.OPENCLAW_PLUGIN_STATUS_PORT);
const runtimeStatusUrl = `http://127.0.0.1:${process.env.OPENCLAW_RUNTIME_STATUS_PORT}/openclaw/runtime/status`;
const configPath = "/home/node/.openclaw/openclaw.json";
const linear = "codex-plugin:linear@openai-curated-remote";
const workspaceNodeId = process.env.OCC_TEST_WORKSPACE_NODE_ID;
const outageExit = process.env.OCC_TEST_GATEWAY_SCENARIO === "peer-outage-exit";
const staleReplacement = process.env.OCC_TEST_GATEWAY_SCENARIO === "stale-replacement";
const writableInitialConfig = process.env.OCC_TEST_WRITABLE_INITIAL_CONFIG === "true";
interface GatewayProcess {
  pid: number;
  startTicks: string;
  token: string | undefined;
}

interface PeerStatus {
  revisionId: string | undefined;
  container: string;
  startupId: string;
  podUid: string;
  phase: string;
  successfulPluginIds: string[];
  failures: { pluginId: string; code: string }[];
}

interface GatewayConfiguration {
  plugins: {
    entries: { codex: { config: { codexPlugins: { plugins: { linear: { enabled: boolean } } } } } };
  };
  tools: {
    gatewayPolicy: { allow: string[]; automations?: unknown; actions?: { plugins?: string[] } };
  };
  agents?: { defaults?: { modelSelectionScope?: string } };
  cron?: { triggers?: { enabled?: boolean } };
  messages?: { responsePrefix?: string };
}

interface WorkspaceNodeStatus {
  workspaceNodeId?: string;
  workspaceNodeFailure?: { code: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  assert.ok(isRecord(value), `${label} must be an object`);
  return value;
}

function optionalRecord(value: unknown, label: string) {
  return value === undefined ? undefined : requireRecord(value, label);
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === "string");
}

function assertGatewayConfiguration(value: unknown): asserts value is GatewayConfiguration {
  const config = requireRecord(value, "Gateway configuration");
  const entries = requireRecord(requireRecord(config.plugins, "plugins").entries, "plugin entries");
  const codex = requireRecord(requireRecord(entries.codex, "Codex entry").config, "Codex config");
  const plugins = requireRecord(
    requireRecord(codex.codexPlugins, "Codex plugins").plugins,
    "plugin settings",
  );
  const linearConfig = requireRecord(plugins.linear, "Linear plugin");
  assert.ok(
    typeof linearConfig.enabled === "boolean",
    "Linear plugin enabled state must be boolean",
  );

  const tools = requireRecord(config.tools, "tools");
  const policy = requireRecord(tools.gatewayPolicy, "Gateway tool policy");
  assert.ok(isStringList(policy.allow), "Gateway tool policy allow must be a string array");
  const actions = optionalRecord(policy.actions, "Gateway tool actions");
  assert.ok(
    actions?.plugins === undefined || isStringList(actions.plugins),
    "plugin actions must be a string array",
  );

  const agents = optionalRecord(config.agents, "agents");
  const defaults = optionalRecord(agents?.defaults, "agent defaults");
  assert.ok(
    defaults?.modelSelectionScope === undefined || typeof defaults.modelSelectionScope === "string",
    "model selection scope must be a string",
  );
  const cron = optionalRecord(config.cron, "cron");
  const triggers = optionalRecord(cron?.triggers, "cron triggers");
  assert.ok(
    triggers?.enabled === undefined || typeof triggers.enabled === "boolean",
    "cron enabled state must be boolean",
  );
  const messages = optionalRecord(config.messages, "messages");
  assert.ok(
    messages?.responsePrefix === undefined || typeof messages.responsePrefix === "string",
    "response prefix must be a string",
  );
}

async function readPluginPhase(response: Response): Promise<string> {
  const raw: unknown = await response.json();
  const status = requireRecord(raw, "plugin runtime status");
  assert.ok(typeof status.phase === "string", "plugin runtime phase must be a string");
  return status.phase;
}

function assertWorkspaceNodeStatus(value: unknown): asserts value is WorkspaceNodeStatus {
  const status = requireRecord(value, "workspace node status");
  assert.ok(
    status.workspaceNodeId === undefined || typeof status.workspaceNodeId === "string",
    "workspace node ID must be a string",
  );
  const failure = optionalRecord(status.workspaceNodeFailure, "workspace node failure");
  assert.ok(
    !failure || typeof failure.code === "string",
    "workspace node failure code must be a string",
  );
}

let initialGateway: GatewayProcess | undefined;
let replacementPeerReads = 0;
let stalePhase = "initial";
let peer2SwitchedAt: number | undefined;

function breadcrumb(phase: string, value?: number | boolean, extra?: string | boolean) {
  if (
    ![
      "initial-ready",
      "peer2-switch",
      "replacement-request",
      "third-request-entry",
      "identity-check",
      "credential-check",
      "native-ready",
      "wrapper-ready",
      "peer3-switch",
      "peer3-response",
      "deadline",
    ].includes(phase)
  ) {
    return;
  }
  const record: Record<string, string | number | boolean | undefined> = {
    event: "stale-peer-diagnostic",
    phase,
  };
  if (phase === "peer2-switch") {
    peer2SwitchedAt = performance.now();
  }
  if (peer2SwitchedAt !== undefined) {
    record.elapsedMs = Math.max(0, performance.now() - peer2SwitchedAt);
  }
  if (phase === "replacement-request" || phase === "deadline") {
    record.ordinal = value;
  }
  if (phase === "deadline") {
    record.lastPhase = extra;
  }
  if (phase === "identity-check") {
    record.singleProcess = value;
    record.sameIdentity = extra;
  }
  if (phase === "credential-check") {
    record.sameCredential = value;
  }
  if (phase === "native-ready" || phase === "wrapper-ready") {
    record.ready = value;
  }
  stalePhase = phase;
  console.log(JSON.stringify(record));
}
let trackSamePeerOutage = false;
let trackSamePeerRecovery = false;
let samePeerOutageResponses = 0;
let samePeerRecoveryResponses = 0;

let peer: PeerStatus | undefined = {
  revisionId,
  container: "agent",
  startupId: "harness-startup-1",
  podUid: "harness-pod-1",
  phase: "ready",
  successfulPluginIds: [],
  failures: [{ pluginId: linear, code: "PLUGIN_AUTH_REQUIRED" }],
};
// The Gateway reads its peer at the APP_SERVER_URL host on its own status port.
// That host is [::1] here, beside the Gateway's own IPv4 status listener.
const server = createServer(async (request, response) => {
  assert.equal(request.url, "/openclaw/plugin-runtime/status");
  if (peer === undefined) {
    const countOutage = trackSamePeerOutage;
    response.writeHead(503).end(() => {
      if (countOutage) {
        samePeerOutageResponses++;
      }
    });
    return;
  }
  if (staleReplacement && peer.startupId === "harness-startup-2") {
    replacementPeerReads++;
    breadcrumb("replacement-request", replacementPeerReads);
    if (replacementPeerReads === 3) {
      breadcrumb("third-request-entry");
      // The verification read follows the replacement's native readiness.
      const processes = await gatewayProcess();
      const [current] = processes;
      assert.ok(initialGateway);
      breadcrumb(
        "identity-check",
        processes.length === 1,
        processes.length === 1 &&
          current !== undefined &&
          current.startTicks + current.pid === initialGateway.startTicks + initialGateway.pid,
      );
      assert.equal(processes.length, 1);
      assert.ok(current);
      assert.notEqual(
        current.startTicks + current.pid,
        initialGateway.startTicks + initialGateway.pid,
      );
      breadcrumb("credential-check", current.token === appServerToken("harness-startup-2"));
      assert.equal(current.token, appServerToken("harness-startup-2"));
      const native = await fetch(`http://127.0.0.1:${process.env.OPENCLAW_GATEWAY_PORT}/readyz`, {
        signal: AbortSignal.timeout(3_000),
        redirect: "error",
      });
      breadcrumb("native-ready", native.status === 200);
      assert.equal(native.status, 200);
      const phase = await readPluginPhase(
        await fetch(`http://127.0.0.1:${statusPort}/openclaw/plugin-runtime/status`, {
          signal: AbortSignal.timeout(3_000),
          redirect: "error",
        }),
      );
      assert.equal(phase, "starting");
      const wrapperReady = await ready();
      breadcrumb("wrapper-ready", wrapperReady);
      assert.equal(wrapperReady, false);
      peer = { ...peer, startupId: "harness-startup-3", podUid: "harness-pod-3" };
      breadcrumb("peer3-switch");
      await new Promise<void>((resolve, reject) => {
        process.stdout.write(
          `${JSON.stringify({ phase: "stale-peer-verified", pid: current.pid })}\n`,
          (error) => (error ? reject(error) : resolve()),
        );
      });
    }
  }
  response.writeHead(200, { "content-type": "application/json" });
  const countRecovery = trackSamePeerRecovery;
  const thirdPeerResponse = staleReplacement && peer.startupId === "harness-startup-3";
  response.end(JSON.stringify(peer), () => {
    if (thirdPeerResponse) {
      breadcrumb("peer3-response");
    }
    if (countRecovery) {
      samePeerRecoveryResponses++;
    }
  });
});
await new Promise<void>((resolve) => server.listen(statusPort, "::1", resolve));

function appServerToken(startupId: string) {
  const token = process.env.APP_SERVER_TOKEN;
  assert.ok(token);
  assert.ok(tokenDomain);
  assert.ok(revisionId);
  return createHmac("sha256", token)
    .update(tokenDomain)
    .update("\0")
    .update(revisionId)
    .update("\0")
    .update(startupId)
    .digest("hex");
}

async function ready() {
  try {
    const response = await fetch(`http://127.0.0.1:${statusPort}/readyz`, {
      signal: AbortSignal.timeout(5_000),
      redirect: "error",
    });
    return response.status === 200;
  } catch {
    return false;
  }
}

// The OpenClaw Gateway process (it retitles itself), its start time and the
// app-server credential it was started with.
async function gatewayProcess(): Promise<GatewayProcess[]> {
  const found: GatewayProcess[] = [];
  for (const pid of await readdir("/proc")) {
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid) {
      continue;
    }
    const argv = (await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "")).split("\0");
    if (argv[0]?.trim() !== "openclaw-gateway") {
      continue;
    }
    const procStat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => undefined);
    const environ = await readFile(`/proc/${pid}/environ`, "utf8").catch(() => undefined);
    if (procStat === undefined || environ === undefined) {
      continue;
    }
    const token = environ
      .split("\0")
      .find((entry) => entry.startsWith("APP_SERVER_TOKEN="))
      ?.slice("APP_SERVER_TOKEN=".length);
    const startTicks = procStat.slice(procStat.lastIndexOf(")") + 2).split(" ")[19];
    assert.ok(startTicks);
    found.push({
      pid: Number(pid),
      startTicks,
      token,
    });
  }
  return found;
}

async function waitFor(
  description: string,
  timeoutMs: number,
  check: () => Promise<boolean>,
  detail: () => string = () => "",
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result) {
      return result;
    }
    assert.ok(Date.now() < deadline, `timed out waiting for ${description}${detail()}`);
    await setTimeout(200);
  }
}

// The wrapper's 30 s apply budget runs from the native spawn. On a starved runner
// OpenClaw can outlast it and the wrapper reports GATEWAY_UNAVAILABLE or
// RELOAD_NOT_CONFIRMED, which the ack clears. That report can also be stale: the
// wrapper does not poll during the peer outage below. Any other failure is final.
const pendingWorkspaceNodeFailures = new Set(["GATEWAY_UNAVAILABLE", "RELOAD_NOT_CONFIRMED"]);
let lastWorkspaceNodeStatus: WorkspaceNodeStatus | undefined;

async function workspaceNodeAck() {
  const status: unknown = await (await fetch(runtimeStatusUrl)).json();
  assertWorkspaceNodeStatus(status);
  lastWorkspaceNodeStatus = status;
  if (status.workspaceNodeId === workspaceNodeId) {
    assert.equal(status.workspaceNodeFailure, undefined, JSON.stringify(status));
    return true;
  }
  assert.ok(
    status.workspaceNodeFailure === undefined ||
      pendingWorkspaceNodeFailures.has(status.workspaceNodeFailure.code),
    JSON.stringify(status),
  );
  return false;
}

function workspaceNodeDetail() {
  return `: ${JSON.stringify(lastWorkspaceNodeStatus)}`;
}

async function readGatewayConfiguration(): Promise<GatewayConfiguration> {
  const config: unknown = JSON.parse(await readFile(configPath, "utf8"));
  assertGatewayConfiguration(config);
  return config;
}

function linearEnabled(config: GatewayConfiguration) {
  return config.plugins.entries.codex.config.codexPlugins.plugins.linear.enabled;
}

try {
  await waitFor("the first Gateway to become ready", 240_000, ready);
  if (staleReplacement) {
    breadcrumb("initial-ready");
  }
  const [before] = await gatewayProcess();
  assert.ok(before);
  initialGateway = before;
  assert.equal(before.token, appServerToken("harness-startup-1"));
  const initialConfig = await readGatewayConfiguration();
  assert.equal(linearEnabled(initialConfig), false);
  assert.equal(initialConfig.tools.gatewayPolicy.allow.includes("sessions"), true);
  assert.equal(initialConfig.tools.gatewayPolicy.allow.includes("plugins"), false);
  assert.deepEqual(initialConfig.tools.gatewayPolicy.automations, {
    scope: "caller",
    allowCommandJobs: false,
  });
  if (outageExit) {
    // The wrapper must still notice its child exit while peer status is unavailable.
    peer = undefined;
    await waitFor("the Gateway to wait for peer status", 30_000, async () => {
      const response = await fetch(`http://127.0.0.1:${statusPort}/openclaw/plugin-runtime/status`);
      return (await readPluginPhase(response)) === "starting" && !(await ready());
    });
    const [running] = await gatewayProcess();
    assert.ok(running);
    assert.equal(running.pid, before.pid);
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(
        `${JSON.stringify({ phase: "peer-unready", pid: before.pid })}\n`,
        (error) => (error ? reject(error) : resolve()),
      );
    });
    process.kill(before.pid, "SIGKILL");
    await setTimeout(15_000);
    throw new Error("Gateway wrapper remained running after its child exited.");
  }
  if (staleReplacement) {
    peer = {
      ...peer,
      startupId: "harness-startup-2",
      podUid: "harness-pod-2",
      successfulPluginIds: ["codex-plugin:linear@openai-curated-remote"],
      failures: [],
    };
    breadcrumb("peer2-switch");
    await setTimeout(60_000);
    breadcrumb("deadline", replacementPeerReads, stalePhase);
    throw new Error("Gateway wrapper did not reject the stale replacement peer.");
  }

  // A transient status outage does not require a new Gateway if the same
  // Harness returns. Observe production readiness before restoring the peer.
  const samePeer = peer;
  trackSamePeerOutage = true;
  peer = undefined;
  await waitFor("the Gateway to become unready during a peer outage", 30_000, async () => {
    const phase = await readPluginPhase(
      await fetch(`http://127.0.0.1:${statusPort}/openclaw/plugin-runtime/status`, {
        signal: AbortSignal.timeout(3_000),
      }),
    );
    return phase === "starting" && !(await ready());
  });
  let samePeerUnreadySamples = 0;
  await waitFor("the Gateway to stay unready while peer status fails", 30_000, async () => {
    const phase = await readPluginPhase(
      await fetch(`http://127.0.0.1:${statusPort}/openclaw/plugin-runtime/status`, {
        signal: AbortSignal.timeout(3_000),
      }),
    );
    assert.equal(phase, "starting");
    assert.equal(await ready(), false);
    samePeerUnreadySamples++;
    return samePeerOutageResponses >= 2 && samePeerUnreadySamples >= 2;
  });
  const duringOutage = await gatewayProcess();
  assert.equal(duringOutage.length, 1);
  assert.ok(duringOutage[0]);
  assert.equal(duringOutage[0].pid, before.pid);
  assert.equal(duringOutage[0].startTicks, before.startTicks);
  trackSamePeerOutage = false;
  trackSamePeerRecovery = true;
  peer = samePeer;
  await waitFor("the same peer to restore Gateway readiness", 60_000, async () => {
    const phase = await readPluginPhase(
      await fetch(`http://127.0.0.1:${statusPort}/openclaw/plugin-runtime/status`, {
        signal: AbortSignal.timeout(3_000),
      }),
    );
    if (phase !== "ready") {
      return false;
    }
    assert.ok(samePeerRecoveryResponses > 0, "readiness returned before a restored peer response");
    return await ready();
  });
  trackSamePeerRecovery = false;
  const afterOutage = await gatewayProcess();
  assert.equal(afterOutage.length, 1);
  assert.ok(afterOutage[0]);
  assert.equal(afterOutage[0].pid, before.pid);
  assert.equal(afterOutage[0].startTicks, before.startTicks);
  assert.equal(afterOutage[0].token, before.token);

  if (writableInitialConfig) {
    const edited = await readGatewayConfiguration();
    edited.messages = { ...edited.messages, responsePrefix: "Native admin edit" };
    // A native admin can edit ordinary configuration. On respawn, only OCE's
    // admitted revision can approve model tools; local edits cannot widen it.
    edited.tools.gatewayPolicy.allow.push("plugins");
    assert.ok(edited.tools.gatewayPolicy.actions);
    assert.ok(edited.agents?.defaults);
    assert.ok(edited.cron?.triggers);
    edited.tools.gatewayPolicy.actions.plugins = ["list"];
    edited.agents.defaults.modelSelectionScope = "agent";
    edited.cron.triggers.enabled = true;
    await writeFile(configPath, JSON.stringify(edited));
  }

  await waitFor("the first workspace node ack", 60_000, workspaceNodeAck, workspaceNodeDetail);
  const assetsBefore = (await stat("/home/node/openclaw-runtime-assets/bundled-skills")).mtimeMs;

  // The Harness restarts: a new startup and pod, and the plugin is now authorized.
  const changedAt = Date.now();
  peer = {
    ...peer,
    startupId: "harness-startup-2",
    podUid: "harness-pod-2",
    successfulPluginIds: ["codex-plugin:linear@openai-curated-remote"],
    failures: [],
  };
  const samples: { at: number; ready: boolean; pids: number[] }[] = [];
  let unreadyAt: number | undefined;
  let readyAgainAt: number | undefined;
  let after: GatewayProcess | undefined;
  while (readyAgainAt === undefined) {
    assert.ok(Date.now() - changedAt < 240_000, `no respawn: ${JSON.stringify(samples)}`);
    const processes = await gatewayProcess();
    const isReady = await ready();
    const at = Date.now() - changedAt;
    samples.push({ at, ready: isReady, pids: processes.map(({ pid }) => pid) });
    if (!isReady) {
      unreadyAt ??= at;
    } else if (unreadyAt !== undefined) {
      // Once readiness dropped, it returns only with the new process serving.
      assert.equal(processes.length, 1, JSON.stringify(samples));
      assert.ok(processes[0]);
      assert.notEqual(processes[0].startTicks + processes[0].pid, before.startTicks + before.pid);
      readyAgainAt = at;
      after = processes[0];
    }
    await setTimeout(200);
  }
  assert.ok(after);
  assert.equal(after.token, appServerToken("harness-startup-2"));
  const recoveredConfig = await readGatewayConfiguration();
  assert.equal(linearEnabled(recoveredConfig), true);
  assert.deepEqual(recoveredConfig.tools.gatewayPolicy, initialConfig.tools.gatewayPolicy);
  assert.equal(recoveredConfig.agents?.defaults?.modelSelectionScope, "session");
  assert.equal(recoveredConfig.cron?.triggers?.enabled, false);
  if (writableInitialConfig) {
    assert.equal((await readGatewayConfiguration()).messages?.responsePrefix, "Native admin edit");
  }
  // The new process loaded the node binding again and acknowledged it itself.
  await waitFor("the respawned workspace node ack", 60_000, workspaceNodeAck, workspaceNodeDetail);
  const ackAt = Date.now() - changedAt;
  // Runtime assets were published once, by the first start.
  assert.equal(
    (await stat("/home/node/openclaw-runtime-assets/bundled-skills")).mtimeMs,
    assetsBefore,
  );

  console.log(
    JSON.stringify({
      before: { pid: before.pid, startTicks: before.startTicks },
      after: { pid: after.pid, startTicks: after.startTicks },
      samePeerOutageResponses,
      samePeerUnreadySamples,
      samePeerRecoveryResponses,
      unreadyAfterMs: unreadyAt,
      readyAgainAfterMs: readyAgainAt,
      workspaceNodeAckAfterMs: ackAt,
      samples: samples.length,
    }),
  );
} finally {
  server.close();
}
