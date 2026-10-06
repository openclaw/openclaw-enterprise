import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";

// Runs inside a runtime image Gateway container started by the Kubernetes
// Gateway wrapper for a dedicated Codex Harness with a plugin selection. It
// stands in for the Harness plugin status endpoint, replaces the Harness (a new
// startup, pod and plugin result), and checks that the wrapper respawns only
// the OpenClaw process: readiness, judged by the production readiness command,
// drops and returns only when the new process serves with the new credential
// and plugin result, and the new process re-acknowledges the workspace node.
// The launcher passes the readiness command and the credential derivation domain.
const execute = promisify(execFile);
const readinessSource = process.env.OCC_TEST_GATEWAY_READINESS;
const tokenDomain = process.env.OCC_TEST_TOKEN_DOMAIN;
const revisionId = process.env.OPENCLAW_AGENT_REVISION_ID;
const statusPort = Number(process.env.OPENCLAW_PLUGIN_STATUS_PORT);
const runtimeStatusUrl = `http://127.0.0.1:${process.env.OPENCLAW_RUNTIME_STATUS_PORT}/openclaw/runtime/status`;
const configPath = "/home/node/.openclaw/openclaw.json";
const linear = "codex-plugin:linear@openai-curated-remote";
const workspaceNodeId = process.env.OCC_TEST_WORKSPACE_NODE_ID;
const outageExit = process.env.OCC_TEST_GATEWAY_SCENARIO === "peer-outage-exit";
const staleReplacement = process.env.OCC_TEST_GATEWAY_SCENARIO === "stale-replacement";
let initialGateway;
let replacementPeerReads = 0;
let trackSamePeerOutage = false;
let trackSamePeerRecovery = false;
let samePeerOutageResponses = 0;
let samePeerRecoveryResponses = 0;

let peer = {
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
    if (replacementPeerReads === 3) {
      // The verification read follows the replacement's native readiness.
      const processes = await gatewayProcess();
      assert.equal(processes.length, 1);
      assert.notEqual(
        processes[0].startTicks + processes[0].pid,
        initialGateway.startTicks + initialGateway.pid,
      );
      assert.equal(processes[0].token, appServerToken("harness-startup-2"));
      const native = await fetch(`http://127.0.0.1:${process.env.OPENCLAW_GATEWAY_PORT}/readyz`, {
        signal: AbortSignal.timeout(3_000),
        redirect: "error",
      });
      assert.equal(native.status, 200);
      const status = await (
        await fetch(`http://127.0.0.1:${statusPort}/openclaw/plugin-runtime/status`, {
          signal: AbortSignal.timeout(3_000),
          redirect: "error",
        })
      ).json();
      assert.equal(status.phase, "starting");
      assert.equal(await ready(), false);
      peer = { ...peer, startupId: "harness-startup-3", podUid: "harness-pod-3" };
      await new Promise((resolve, reject) => {
        process.stdout.write(
          `${JSON.stringify({ phase: "stale-peer-verified", pid: processes[0].pid })}\n`,
          (error) => (error ? reject(error) : resolve()),
        );
      });
    }
  }
  response.writeHead(200, { "content-type": "application/json" });
  const countRecovery = trackSamePeerRecovery;
  response.end(JSON.stringify(peer), () => {
    if (countRecovery) {
      samePeerRecoveryResponses++;
    }
  });
});
await new Promise((resolve) => server.listen(statusPort, "::1", resolve));

function appServerToken(startupId) {
  return createHmac("sha256", process.env.APP_SERVER_TOKEN)
    .update(tokenDomain)
    .update("\0")
    .update(revisionId)
    .update("\0")
    .update(startupId)
    .digest("hex");
}

async function ready() {
  try {
    await execute(process.execPath, ["-e", readinessSource], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

// The OpenClaw Gateway process (it retitles itself), its start time and the
// app-server credential it was started with.
async function gatewayProcess() {
  const found = [];
  for (const pid of await readdir("/proc")) {
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid) {
      continue;
    }
    const argv = (await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "")).split("\0");
    if (argv[0].trim() !== "openclaw-gateway") {
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
    found.push({
      pid: Number(pid),
      startTicks: procStat.slice(procStat.lastIndexOf(")") + 2).split(" ")[19],
      token,
    });
  }
  return found;
}

async function waitFor(description, timeoutMs, check, detail = () => "") {
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
let lastWorkspaceNodeStatus;

async function workspaceNodeAck() {
  const status = await (await fetch(runtimeStatusUrl)).json();
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

function linearEnabled(config) {
  return config.plugins.entries.codex.config.codexPlugins.plugins.linear.enabled;
}

try {
  await waitFor("the first Gateway to become ready", 240_000, ready);
  const [before] = await gatewayProcess();
  initialGateway = before;
  assert.equal(before.token, appServerToken("harness-startup-1"));
  assert.equal(linearEnabled(JSON.parse(await readFile(configPath, "utf8"))), false);
  if (outageExit) {
    // The wrapper must still notice its child exit while peer status is unavailable.
    peer = undefined;
    await waitFor("the Gateway to wait for peer status", 30_000, async () => {
      const response = await fetch(`http://127.0.0.1:${statusPort}/openclaw/plugin-runtime/status`);
      const status = await response.json();
      return status.phase === "starting" && !(await ready());
    });
    const [running] = await gatewayProcess();
    assert.equal(running.pid, before.pid);
    await new Promise((resolve, reject) => {
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
    await setTimeout(60_000);
    throw new Error("Gateway wrapper did not reject the stale replacement peer.");
  }

  // A transient status outage does not require a new Gateway if the same
  // Harness returns. Observe production readiness before restoring the peer.
  const samePeer = peer;
  trackSamePeerOutage = true;
  peer = undefined;
  await waitFor("the Gateway to become unready during a peer outage", 30_000, async () => {
    const status = await (
      await fetch(`http://127.0.0.1:${statusPort}/openclaw/plugin-runtime/status`, {
        signal: AbortSignal.timeout(3_000),
      })
    ).json();
    return status.phase === "starting" && !(await ready());
  });
  let samePeerUnreadySamples = 0;
  await waitFor("the Gateway to stay unready while peer status fails", 30_000, async () => {
    const status = await (
      await fetch(`http://127.0.0.1:${statusPort}/openclaw/plugin-runtime/status`, {
        signal: AbortSignal.timeout(3_000),
      })
    ).json();
    assert.equal(status.phase, "starting");
    assert.equal(await ready(), false);
    samePeerUnreadySamples++;
    return samePeerOutageResponses >= 2 && samePeerUnreadySamples >= 2;
  });
  const duringOutage = await gatewayProcess();
  assert.equal(duringOutage.length, 1);
  assert.equal(duringOutage[0].pid, before.pid);
  assert.equal(duringOutage[0].startTicks, before.startTicks);
  trackSamePeerOutage = false;
  trackSamePeerRecovery = true;
  peer = samePeer;
  await waitFor("the same peer to restore Gateway readiness", 60_000, async () => {
    const status = await (
      await fetch(`http://127.0.0.1:${statusPort}/openclaw/plugin-runtime/status`, {
        signal: AbortSignal.timeout(3_000),
      })
    ).json();
    if (status.phase !== "ready") {
      return false;
    }
    assert.ok(samePeerRecoveryResponses > 0, "readiness returned before a restored peer response");
    return await ready();
  });
  trackSamePeerRecovery = false;
  const afterOutage = await gatewayProcess();
  assert.equal(afterOutage.length, 1);
  assert.equal(afterOutage[0].pid, before.pid);
  assert.equal(afterOutage[0].startTicks, before.startTicks);
  assert.equal(afterOutage[0].token, before.token);

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
  const samples = [];
  let unreadyAt;
  let readyAgainAt;
  let after;
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
      assert.notEqual(processes[0].startTicks + processes[0].pid, before.startTicks + before.pid);
      readyAgainAt = at;
      after = processes[0];
    }
    await setTimeout(200);
  }
  assert.equal(after.token, appServerToken("harness-startup-2"));
  assert.equal(linearEnabled(JSON.parse(await readFile(configPath, "utf8"))), true);
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
