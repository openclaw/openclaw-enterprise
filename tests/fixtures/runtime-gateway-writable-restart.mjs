import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { KubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { GATEWAY_RUNTIME_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { conformanceKubernetesOptions } from "../helpers/kubernetes-compute.mjs";
import {
  createAdmittedRuntimeImageConfiguration,
  image,
  runDocker,
  runGatewaySmoke,
} from "../helpers/runtime-image-startup.mjs";

// An owned Docker volume models the native-admin copy's Pod-local lifetime.
// The production init script copies once; restarting the actual Gateway
// container preserves that copy. Its HTTP Harness-status peer is synthetic.
export async function runWritableGatewayRestart(t) {
  const suffix = randomBytes(6).toString("hex");
  const owner = `oce-peer-restart-${suffix}`;
  const network = `${owner}-network`;
  const peerName = `${owner}-peer`;
  const directory = await mkdtemp(join(tmpdir(), "oce-peer-restart-"));
  const ownedContainers = [];
  const cleanup = [() => rm(directory, { recursive: true, force: true })];
  const scope = {
    after(fn) {
      cleanup.push(fn);
    },
  };
  t.after(async () => {
    const failures = [];
    for (const fn of cleanup.reverse()) {
      try {
        await fn();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) {
      throw new AggregateError(failures, "Owned peer restart cleanup failed.");
    }
    for (const name of ownedContainers) {
      const observed = await runDocker([
        "ps",
        "--all",
        "--filter",
        `name=^/${name}$`,
        "--format",
        "{{.ID}}",
      ]);
      assert.equal(observed.stdout.trim(), "", `owned container cleanup: ${name}`);
    }
    for (const kind of ["volume", "network"]) {
      const observed = await runDocker([
        kind,
        "ls",
        "--filter",
        `label=oce.proof.owner=${owner}`,
        "--quiet",
      ]);
      assert.equal(observed.stdout.trim(), "", `owned ${kind} cleanup`);
    }
    t.diagnostic(JSON.stringify({ owner, ownedContainers, cleanupVerified: true }));
  });
  await runDocker([
    "network",
    "create",
    "--internal",
    "--label",
    `oce.proof.owner=${owner}`,
    network,
  ]);
  cleanup.push(() => runDocker(["network", "rm", network]));
  const revisionId = "revision-writable-peer-restart";
  const pluginId = "codex-plugin:linear@openai-curated-remote";
  let peer = {
    revisionId,
    container: "agent",
    startupId: "startup-1",
    podUid: "peer-pod-1",
    phase: "ready",
    successfulPluginIds: [],
    failures: [{ pluginId, code: "PLUGIN_AUTH_REQUIRED" }],
  };
  const peerProgram = `const fs=require("node:fs");
    fs.writeFileSync("/tmp/peer.json", process.env.OCC_TEST_PEER_STATUS);
    require("node:http").createServer((request,response)=>{
      if(request.url!=="/openclaw/plugin-runtime/status")return response.writeHead(404).end();
      response.writeHead(200,{"content-type":"application/json"});
      response.end(fs.readFileSync("/tmp/peer.json"));
    }).listen(18791,"0.0.0.0");`;
  await runDocker([
    "run",
    "--detach",
    "--name",
    peerName,
    "--pull=never",
    "--network",
    network,
    "--label",
    `oce.proof.owner=${owner}`,
    "--read-only",
    "--user",
    "1000:1000",
    "--tmpfs",
    "/tmp:uid=1000,gid=1000,mode=700",
    "-e",
    `OCC_TEST_PEER_STATUS=${JSON.stringify(peer)}`,
    "--entrypoint",
    "node",
    image,
    "-e",
    peerProgram,
  ]);
  cleanup.push(() => runDocker(["rm", "-f", peerName]));
  ownedContainers.push(peerName);
  const configuration = createAdmittedRuntimeImageConfiguration("codex");
  const sourcePath = join(directory, "openclaw.json");
  await writeFile(sourcePath, JSON.stringify(configuration), { mode: 0o644 });
  const manifest = {
    kind: "codex",
    selections: {
      [pluginId]: {
        enabled: true,
        toolDefaults: { approval: "provider_default" },
      },
    },
  };
  const driver = new KubernetesComputeDriver(
    conformanceKubernetesOptions({
      gatewayTrustedProxyCidrs: ["127.0.0.1/32"],
      runtime: { transportSecretPrefix: "transport", gatewayStorageClassName: "local-path" },
    }),
  );
  const init = driver.privateStateInitContainer("gateway", image, false, true);
  assert.match(
    init.args[0],
    /copyFileSync\("\/etc\/openclaw-managed\/openclaw.json", "\/runtime-state\/home\/\.openclaw\/openclaw.json"\)/,
  );
  async function startPodCopy(label) {
    const volume = `${owner}-${label}`;
    await runDocker(["volume", "create", "--label", `oce.proof.owner=${owner}`, volume]);
    cleanup.push(() => runDocker(["volume", "rm", volume]));
    await runDocker([
      "run",
      "--rm",
      "--pull=never",
      "--network",
      "none",
      "--user",
      "0:0",
      "--volume",
      `${volume}:/runtime-state/home`,
      "--entrypoint",
      "node",
      image,
      "-e",
      'require("node:fs").chownSync("/runtime-state/home",1000,1000);',
    ]);
    await runDocker([
      "run",
      "--rm",
      "--pull=never",
      "--network",
      "none",
      "--user",
      "1000:1000",
      "--read-only",
      "--volume",
      `${volume}:/runtime-state/home`,
      "--volume",
      `${sourcePath}:/etc/openclaw-managed/openclaw.json:ro`,
      "--tmpfs",
      "/runtime-state:uid=1000,gid=1000,mode=700",
      "--tmpfs",
      "/runtime-temporary:uid=1000,gid=1000,mode=700",
      "--tmpfs",
      "/gateway-state:uid=1000,gid=1000,mode=700",
      "--entrypoint",
      "node",
      image,
      "-e",
      init.args[0],
    ]);
    const result = await runGatewaySmoke(scope, "codex", {
      configurationPath: "/home/node/.openclaw/openclaw.json",
      entrypoint: GATEWAY_RUNTIME_ENTRYPOINT,
      network,
      tmpfs: [],
      volumes: [`${volume}:/home/node`, `${sourcePath}:/etc/openclaw-managed/openclaw.json:ro`],
      extraEnvironment: [
        "OPENCLAW_DEBUG=1",
        `APP_SERVER_URL=ws://${peerName}:4500`,
        `OPENCLAW_PLUGIN_RUNTIME_JSON=${JSON.stringify({ manifest })}`,
        "OPENCLAW_PLUGIN_STATUS_CONTAINER=gateway",
        "OPENCLAW_PLUGIN_STATUS_PORT=18791",
        "OPENCLAW_RUNTIME_STATUS_PORT=18791",
        "OPENCLAW_RUNTIME_STATUS_CONTAINER=gateway",
        `OPENCLAW_AGENT_REVISION_ID=${revisionId}`,
        "OPENCLAW_POD_UID=pod-writable-peer",
        "OPENCLAW_WORKSPACE_DIR=/home/node/workspace",
      ],
      waitUntilReady: false,
    });
    ownedContainers.push(result.containerName);
    return { ...result, volume };
  }
  async function state(name) {
    const result = await runDocker([
      "exec",
      name,
      "node",
      "-e",
      `
      const fs=require("node:fs"),path="/home/node/.openclaw/openclaw.json";
      const config=JSON.parse(fs.readFileSync(path,"utf8"));
      const journal=path+".oce-peer-bridge.json";
      fetch("http://127.0.0.1:18791/readyz").then(r=>console.log(JSON.stringify({
        ready:r.status===200, prefix:config.messages?.responsePrefix,
        bridge:config.plugins?.entries?.codex?.config?.codexPlugins,
        journalMode:fs.existsSync(journal)?fs.statSync(journal).mode&0o777:null,
      }))).catch(()=>process.exit(1));`,
    ]);
    return JSON.parse(result.stdout.trim());
  }
  async function waitState(name, label, predicate) {
    const deadline = Date.now() + 90_000;
    let last;
    while (Date.now() < deadline) {
      try {
        last = await state(name);
        if (predicate(last)) {
          return last;
        }
      } catch {
        const observed = JSON.parse((await runDocker(["inspect", name])).stdout)[0];
        if (!observed.State.Running) {
          const logs = await runDocker(["logs", name]);
          throw new Error(
            `${label}: Gateway exited ${observed.State.ExitCode}\n${logs.stdout}\n${logs.stderr}`,
          );
        }
      }
      await delay(250);
    }
    const logs = await runDocker(["logs", name]);
    throw new Error(`${label}: ${JSON.stringify(last)}\n${logs.stdout}\n${logs.stderr}`);
  }
  async function edit(name, code) {
    await runDocker([
      "exec",
      name,
      "node",
      "-e",
      `const fs=require("node:fs"),p="/home/node/.openclaw/openclaw.json";const c=JSON.parse(fs.readFileSync(p,"utf8"));${code};fs.writeFileSync(p,JSON.stringify(c));`,
    ]);
  }
  const first = await startPodCopy("home-1");
  const before = await waitState(first.containerName, "initial Gateway", (s) => s.ready);
  const beforeInspect = JSON.parse((await runDocker(["inspect", first.containerName])).stdout)[0];
  assert.equal(before.bridge.plugins.linear.enabled, false);
  await edit(first.containerName, 'c.messages={...c.messages,responsePrefix:"Native admin edit"}');
  // Docker restart keeps the volume, like a container restart under the same Pod.
  await runDocker(["restart", "--time", "350", first.containerName], { timeout: 360_000 });
  const afterRestart = await waitState(
    first.containerName,
    "same-peer container restart",
    (s) => s.ready,
  );
  const afterRestartInspect = JSON.parse(
    (await runDocker(["inspect", first.containerName])).stdout,
  )[0];
  assert.notEqual(afterRestartInspect.State.StartedAt, beforeInspect.State.StartedAt);
  assert.equal(afterRestart.prefix, "Native admin edit");
  peer = {
    ...peer,
    startupId: "startup-2",
    podUid: "peer-pod-2",
    successfulPluginIds: [pluginId],
    failures: [],
  };
  await runDocker([
    "exec",
    "-e",
    `OCC_TEST_PEER_STATUS=${JSON.stringify(peer)}`,
    peerName,
    "node",
    "-e",
    'require("node:fs").writeFileSync("/tmp/peer.json",process.env.OCC_TEST_PEER_STATUS);',
  ]);
  const recovered = await waitState(
    first.containerName,
    "changed-peer recovery after restart",
    (s) => s.ready && s.bridge?.plugins?.linear?.enabled === true,
  );
  assert.equal(recovered.prefix, "Native admin edit");
  assert.equal(recovered.journalMode, 0o600);
  const inspect = JSON.parse((await runDocker(["inspect", first.containerName])).stdout)[0];
  assert.equal(
    inspect.State.StartedAt,
    afterRestartInspect.State.StartedAt,
    "peer recovery must not restart the container again",
  );
  // Also change the peer while the container is stopped: startup itself must
  // recognize its previous generated bridge, rather than treating it as an edit.
  await runDocker(["stop", "--time", "350", first.containerName], { timeout: 360_000 });
  peer = {
    ...peer,
    startupId: "startup-3",
    podUid: "peer-pod-3",
    successfulPluginIds: [],
    failures: [{ pluginId, code: "PLUGIN_AUTH_REQUIRED" }],
  };
  await runDocker([
    "exec",
    "-e",
    `OCC_TEST_PEER_STATUS=${JSON.stringify(peer)}`,
    peerName,
    "node",
    "-e",
    'require("node:fs").writeFileSync("/tmp/peer.json",process.env.OCC_TEST_PEER_STATUS);',
  ]);
  await runDocker(["start", first.containerName]);
  const changedAtStartup = await waitState(
    first.containerName,
    "changed peer at container startup",
    (s) => s.ready && s.bridge?.plugins?.linear?.enabled === false,
  );
  assert.equal(changedAtStartup.prefix, "Native admin edit");
  await edit(
    first.containerName,
    'c.plugins.entries.codex.config.codexPlugins.plugins.linear.name="Native bridge edit"',
  );
  await runDocker(["restart", "--time", "350", first.containerName], { timeout: 360_000 });
  const deadline = Date.now() + 30_000;
  let stopped;
  do {
    stopped = JSON.parse((await runDocker(["inspect", first.containerName])).stdout)[0];
    if (!stopped.State.Running) {
      break;
    }
    await delay(250);
  } while (Date.now() < deadline);
  assert.equal(stopped.State.Running, false, "an explicitly edited bridge must retain refusal");
  assert.equal(stopped.State.ExitCode, 1);
  const replacement = await startPodCopy("home-2");
  const fresh = await waitState(replacement.containerName, "fresh Pod-local copy", (s) => s.ready);
  assert.equal(fresh.prefix, undefined, "a fresh Pod-local copy restores the admitted snapshot");
  assert.equal(fresh.bridge.plugins.linear.enabled, false);
  // The peer bridge record survives container restarts in its Pod. An unreadable one
  // (here truncated, as an unsynced write after node power loss could leave it) must hold
  // the wrapper unready with its cause reported, not crash-loop on a bare SyntaxError.
  const record = "/home/node/.openclaw/openclaw.json.oce-peer-bridge.json";
  await runDocker([
    "exec",
    replacement.containerName,
    "node",
    "-e",
    `const fs=require("node:fs");fs.writeFileSync(${JSON.stringify(record)},fs.readFileSync(${JSON.stringify(record)},"utf8").slice(0,-5));`,
  ]);
  await runDocker(["restart", "--time", "350", replacement.containerName], { timeout: 360_000 });
  const heldDeadline = Date.now() + 60_000;
  let held;
  while (Date.now() < heldDeadline) {
    const observed = JSON.parse(
      (await runDocker(["inspect", replacement.containerName])).stdout,
    )[0];
    assert.equal(observed.State.Running, true, "an unreadable record holds instead of exiting");
    try {
      held = JSON.parse(
        (
          await runDocker([
            "exec",
            replacement.containerName,
            "node",
            "-e",
            `Promise.all([fetch("http://127.0.0.1:18791/readyz"),fetch("http://127.0.0.1:18791/openclaw/runtime/status").then((r)=>r.json())]).then(([ready,status])=>console.log(JSON.stringify({ready:ready.status,failure:status.runtimeFailure}))).catch(()=>process.exit(1));`,
          ])
        ).stdout.trim(),
      );
    } catch {
      held = undefined;
    }
    if (held?.failure !== undefined) {
      break;
    }
    await delay(250);
  }
  assert.equal(held?.failure?.check, "peer-bridge-record", JSON.stringify(held));
  assert.equal(held.failure.code, "UNAVAILABLE");
  assert.notEqual(held.ready, 200);
  const heldLogs = await runDocker(["logs", replacement.containerName]);
  assert.match(
    heldLogs.stderr + heldLogs.stdout,
    /Gateway peer configuration record \/home\/node\/\.openclaw\/openclaw\.json\.oce-peer-bridge\.json is unreadable\. OpenClaw was not started\. Delete the Pod/,
  );
  // Deleting the Pod is the remedy: the held wrapper ends on SIGTERM without the grace period.
  const stopStartedAt = Date.now();
  await runDocker(["stop", "--time", "60", replacement.containerName], { timeout: 90_000 });
  const heldStopMs = Date.now() - stopStartedAt;
  const heldStopped = JSON.parse(
    (await runDocker(["inspect", replacement.containerName])).stdout,
  )[0];
  assert.equal(heldStopped.State.ExitCode, 0);
  assert.ok(heldStopMs < 30_000, `held wrapper stop took ${heldStopMs} ms`);
  const logs = await runDocker(["logs", first.containerName]);
  assert.match(logs.stderr + logs.stdout, /OpenClaw Codex bridge configuration conflicts/);
  t.diagnostic(
    JSON.stringify({
      initialReady: before.ready,
      containerRestartCount: inspect.RestartCount,
      manualRestartChangedStartedAt:
        afterRestartInspect.State.StartedAt !== beforeInspect.State.StartedAt,
      peerRecoveryKeptContainer: inspect.State.StartedAt === afterRestartInspect.State.StartedAt,
      samePeerReady: afterRestart.ready,
      changedPeerReady: recovered.ready,
      changedPeerAtStartupReady: changedAtStartup.ready,
      nativeEditRetained: recovered.prefix === afterRestart.prefix,
      explicitBridgeRefused: stopped.State.ExitCode,
      freshCopyRestored: fresh.prefix === undefined,
      unreadableRecordHeld: held.failure.check,
      heldStopMs,
    }),
  );
}
