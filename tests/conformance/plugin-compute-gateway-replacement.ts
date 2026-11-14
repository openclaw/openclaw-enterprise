import assert from "node:assert/strict";
import test from "node:test";
import {
  gatewayExitedBeforeServing,
  invalidGatewayConfiguration,
  invalidGatewayConfigurationLine,
  invalidGatewayConfigurationSecret,
} from "../helpers/openclaw-config-validation.mjs";
import {
  items,
  parseJson,
  property,
  record,
  required,
  text,
  waitForCondition,
} from "./plugin-compute-fixtures.ts";
import { readReadyStatusFromHandler } from "./plugin-compute-status.ts";
import {
  assertDeliberateRestart,
  DELIBERATE_RESTART,
  startCodexGatewaySupervisor,
  UNEXPLAINED_EXITS,
  unexplainedExits,
} from "./plugin-compute-supervisor.ts";

export function registerGatewayReplacement(): void {
  test("Codex gateway supervisor preserves native edits when its initial config is writable", async (t) => {
    const gateway = await startCodexGatewaySupervisor(t, { writableConfig: true });
    const first = required(gateway.children[0]);
    const path = "/home/node/.openclaw/openclaw.json";
    const edited = record(parseJson(gateway.files.get(path)));
    edited.messages = { responsePrefix: "Native admin edit" };
    gateway.files.set(path, JSON.stringify(edited));
    await gateway.pollPeer();
    assert.equal(gateway.children.length, 1, "the same peer keeps its native process and edits");
    gateway.peerStatus = {
      ...gateway.peerStatus,
      startupId: "agent-startup-2",
      podUid: "agent-pod-2",
      successfulPluginIds: ["codex-plugin:linear@openai-curated-remote"],
      failures: [],
    };
    const respawn = gateway.pollPeer();
    await waitForCondition("the stale Gateway stop", () => first.killed.length === 1);
    first.exit(null, "SIGTERM");
    await respawn;
    assert.equal(
      gateway.children.length,
      2,
      JSON.stringify({
        state: gateway.files.get(path + ".oce-peer-bridge.json"),
        logs: gateway.logs,
      }),
    );
    const replacement = required(gateway.children[1]);
    assert.equal(property(replacement.config, "messages", "responsePrefix"), "Native admin edit");
    assert.equal(
      property(
        replacement.config,
        "plugins",
        "entries",
        "codex",
        "config",
        "codexPlugins",
        "plugins",
        "linear",
        "enabled",
      ),
      true,
    );
    assert.equal(replacement.token, gateway.token("agent-startup-2"));
    assert.equal(property(gateway.status(), "phase"), "ready");
    assert.deepEqual(gateway.exits, []);
  });

  test("Codex gateway supervisor refuses a native edit back to an older generated bridge", async (t) => {
    const gateway = await startCodexGatewaySupervisor(t, { writableConfig: true });
    const first = required(gateway.children[0]);
    const path = "/home/node/.openclaw/openclaw.json";
    const oldBridge = property(
      first.config,
      "plugins",
      "entries",
      "codex",
      "config",
      "codexPlugins",
    );
    gateway.peerStatus = {
      ...gateway.peerStatus,
      startupId: "agent-startup-2",
      podUid: "agent-pod-2",
      successfulPluginIds: ["codex-plugin:linear@openai-curated-remote"],
      failures: [],
    };
    const recovery = gateway.pollPeer();
    await waitForCondition("the first Gateway stop", () => first.killed.length === 1);
    first.exit(null, "SIGTERM");
    await recovery;
    const edited = record(parseJson(gateway.files.get(path)));
    record(property(edited, "plugins", "entries", "codex", "config")).codexPlugins = oldBridge;
    gateway.files.set(path, JSON.stringify(edited));
    const replacement = required(gateway.children[1]);
    gateway.peerStatus = {
      ...gateway.peerStatus,
      startupId: "agent-startup-3",
      podUid: "agent-pod-3",
    };
    const refused = gateway.pollPeer();
    await waitForCondition("the replacement Gateway stop", () => replacement.killed.length === 1);
    replacement.exit(null, "SIGTERM");
    await refused;
    assert.equal(gateway.children.length, 2);
    assert.deepEqual(gateway.exits, [DELIBERATE_RESTART]);
    assert.equal(
      property(
        parseJson(gateway.files.get(path)),
        "plugins",
        "entries",
        "codex",
        "config",
        "codexPlugins",
        "plugins",
        "linear",
        "enabled",
      ),
      false,
    );
  });

  test("Codex gateway supervisor retains refusal of a native-edited managed bridge", async (t) => {
    const gateway = await startCodexGatewaySupervisor(t, { writableConfig: true });
    const first = required(gateway.children[0]);
    const path = "/home/node/.openclaw/openclaw.json";
    const edited = record(parseJson(gateway.files.get(path)));
    record(
      property(
        edited,
        "plugins",
        "entries",
        "codex",
        "config",
        "codexPlugins",
        "plugins",
        "linear",
      ),
    ).name = "Native edit";
    gateway.files.set(path, JSON.stringify(edited));
    gateway.peerStatus = {
      ...gateway.peerStatus,
      startupId: "agent-startup-2",
      podUid: "agent-pod-2",
      successfulPluginIds: ["codex-plugin:linear@openai-curated-remote"],
      failures: [],
    };
    const respawn = gateway.pollPeer();
    await waitForCondition("the stale Gateway stop", () => first.killed.length === 1);
    first.exit(null, "SIGTERM");
    await respawn;
    assert.equal(gateway.children.length, 1, "an operator edit cannot be overwritten by recovery");
    assert.equal(
      property(
        parseJson(gateway.files.get(path)),
        "plugins",
        "entries",
        "codex",
        "config",
        "codexPlugins",
        "plugins",
        "linear",
        "name",
      ),
      "Native edit",
    );
    assert.deepEqual(gateway.exits, [DELIBERATE_RESTART]);
    // The record lists only bridges the wrapper generated. Were the operator's bridge in it, the
    // container restart that follows would treat the edit as generated and overwrite it.
    const bridges = items(
      property(parseJson(gateway.files.get(`${path}.oce-peer-bridge.json`)), "bridges"),
    );
    assert.equal(bridges.length, 1);
    assert.equal(
      property(bridges[0], "plugins", "linear", "enabled"),
      true,
      "the bridge generated for the new peer",
    );
    assert.notEqual(property(bridges[0], "plugins", "linear", "name"), "Native edit");
  });

  test("Codex gateway supervisor keeps managed-mode restrictions when respawning for a changed Harness peer", async (t) => {
    const gateway = await startCodexGatewaySupervisor(t, {
      managedMode: true,
      writableConfig: true,
    });
    const first = required(gateway.children[0]);
    assert.equal(first.token, gateway.token("agent-startup-1"));
    assert.equal(
      property(
        first.config,
        "plugins",
        "entries",
        "codex",
        "config",
        "codexPlugins",
        "plugins",
        "linear",
        "enabled",
      ),
      false,
    );
    assert.equal(property(gateway.status(), "phase"), "ready");

    // The Harness restarted with a new startup and its plugin now authorized.
    gateway.peerStatus = {
      ...gateway.peerStatus,
      startupId: "agent-startup-2",
      podUid: "agent-pod-2",
      successfulPluginIds: ["codex-plugin:linear@openai-curated-remote"],
      failures: [],
    };
    gateway.serving = false;
    const respawn = gateway.pollPeer();
    await waitForCondition("the stale Gateway stop", () => first.killed.length === 1);
    assert.deepEqual(first.killed, ["SIGTERM"]);
    // Readiness drops before anything else, and nothing new starts while the
    // stale process (holding the old credential) is still running.
    assert.equal(property(gateway.status(), "phase"), "starting");
    assert.deepEqual(property(gateway.status(), "failures"), [gateway.initialFailure]);
    assert.equal(gateway.children.length, 1);

    first.exit(null, "SIGTERM");
    await waitForCondition("the respawned Gateway", () => gateway.children.length === 2);
    const second = required(gateway.children[1]);
    for (const child of [first, second]) {
      assert.equal(child.env.OPENCLAW_CONFIG_READONLY, "1");
      assert.equal(child.env.OPENCLAW_DISABLE_GATEWAY_LOCAL_TERMINALS, "1");
      assert.equal(child.env.OPENCLAW_DISABLE_CRON_HOST_EXECUTION, "1");
      assert.deepEqual(property(child.config, "tools", "gatewayPolicy", "automations"), {
        scope: "caller",
        allowCommandJobs: false,
      });
    }
    assert.equal(second.token, gateway.token("agent-startup-2"));
    assert.equal(
      property(
        second.config,
        "plugins",
        "entries",
        "codex",
        "config",
        "codexPlugins",
        "plugins",
        "linear",
        "enabled",
      ),
      true,
    );
    // Spawned but not yet serving: still unready. The second refused probe shows
    // that the supervisor handled the first one and kept waiting.
    await waitForCondition(
      "two refused readiness probes of the respawned Gateway",
      () =>
        gateway.readinessProbes.filter(({ child, status }) => child === 2 && status === 503)
          .length >= 2,
      10_000,
    );
    assert.equal(property(gateway.status(), "phase"), "starting");

    gateway.serving = true;
    await respawn;
    const ready = record(gateway.status());
    assert.equal(ready.phase, "ready");
    assert.deepEqual(ready.failures, []);
    assert.deepEqual(gateway.exits, [], "the wrapper, and so the container, keeps running");
    assert.deepEqual(second.killed, []);

    // An unchanged peer changes nothing.
    await gateway.pollPeer();
    assert.equal(gateway.children.length, 2);
    assert.deepEqual(second.killed, []);

    // An exit of the respawned process that no respawn asked for is still the container's.
    second.exit(1, null);
    assert.deepEqual(gateway.exits, [1]);
  });

  test("Codex gateway supervisor keeps OpenClaw when the same Harness returns after a status outage", async (t) => {
    const gateway = await startCodexGatewaySupervisor(t);
    const first = required(gateway.children[0]);
    gateway.peerAvailable = false;
    const poll = gateway.pollPeer();
    await waitForCondition(
      "readiness to drop",
      () => property(gateway.status(), "phase") === "starting",
    );
    gateway.peerAvailable = true;
    await poll;
    assert.equal(property(gateway.status(), "phase"), "ready");
    assert.deepEqual(first.killed, [], "the Gateway's credential is still valid");
    assert.equal(gateway.children.length, 1);
    assert.deepEqual(gateway.exits, []);
  });

  test("Codex gateway supervisor exits when OpenClaw crashes during a peer status outage", async (t) => {
    const gateway = await startCodexGatewaySupervisor(t);
    const first = required(gateway.children[0]);
    gateway.peerAvailable = false;
    const poll = gateway.pollPeer();
    await waitForCondition(
      "readiness to drop",
      () => property(gateway.status(), "phase") === "starting",
    );

    // A status outage must not hide the running Gateway's own failure.
    first.exit(1, null);
    const exitsAfterCrash = [...gateway.exits];
    // process.exit is captured by this fixture, so release the pending peer wait.
    gateway.peerAvailable = true;
    await poll;
    assert.deepEqual(exitsAfterCrash, [1]);
  });

  test("Codex gateway supervisor forwards container termination during a peer status outage", async (t) => {
    const gateway = await startCodexGatewaySupervisor(t);
    const first = required(gateway.children[0]);
    gateway.peerAvailable = false;
    const poll = gateway.pollPeer();
    await waitForCondition(
      "readiness to drop",
      () => property(gateway.status(), "phase") === "starting",
    );

    required(gateway.signalHandlers.SIGTERM)();
    assert.deepEqual(first.killed, ["SIGTERM"]);
    first.exit(null, "SIGTERM");
    assert.deepEqual(gateway.exits, [0]);
    gateway.peerAvailable = true;
    await poll;
    assert.equal(gateway.children.length, 1);
  });

  test("Codex gateway supervisor re-applies the workspace node binding on respawn", async (t) => {
    const deviceId = "a".repeat(64);
    const gateway = await startCodexGatewaySupervisor(t, { bindingDeviceId: deviceId });
    const first = required(gateway.children[0]);
    assert.deepEqual(
      property(first.config, "plugins", "entries", "file-transfer", "config", "workspaces", "main"),
      {
        nodeId: deviceId,
        remoteRoot: "/home/node/workspace",
      },
    );
    gateway.peerStatus = { ...gateway.peerStatus, startupId: "agent-startup-2" };
    const respawn = gateway.pollPeer();
    await waitForCondition("the stale Gateway stop", () => first.killed.length === 1);
    first.exit(null, "SIGTERM");
    await respawn;
    const second = required(gateway.children[1]);
    assert.deepEqual(
      property(
        second.config,
        "plugins",
        "entries",
        "file-transfer",
        "config",
        "workspaces",
        "main",
      ),
      {
        nodeId: deviceId,
        remoteRoot: "/home/node/workspace",
      },
    );
    assert.ok(
      items(property(second.config, "gateway", "nodes", "commands", "allow")).includes(
        "file.fetch",
      ),
    );
    // The new process must acknowledge the node itself before the controller sees it.
    assert.equal(property(gateway.runtimeStatus(), "workspaceNodeId"), undefined);
    assert.equal(property(gateway.status(), "phase"), "ready");
    assert.deepEqual(gateway.exits, []);
  });

  // A Gateway whose revision gets another workspace node restarts its container for a clean
  // start. The restart is deliberate: the wrapper exits 75 (EX_TEMPFAIL), which Kubernetes
  // Compute never counts toward a crash loop, and names the reason (finding 3041).
  test("Codex gateway supervisor restarts its container deliberately for another workspace node", async (t) => {
    const gateway = await startCodexGatewaySupervisor(t, { bindingDeviceId: "a".repeat(64) });
    const first = required(gateway.children[0]);
    gateway.files.set(
      "/home/node/workspace-node-binding/workspace-node.json",
      JSON.stringify({ revisionId: gateway.revisionId, deviceId: "b".repeat(64) }),
    );
    await required(gateway.intervals.find(({ delay }) => delay === 1_000)).callback();
    assert.deepEqual(first.killed, ["SIGTERM"]);
    assert.deepEqual(gateway.exits, [], "the wrapper waits for OpenClaw to stop");
    first.exit(null, "SIGTERM");
    assert.deepEqual(gateway.exits, [DELIBERATE_RESTART]);
    assertDeliberateRestart(gateway, "WORKSPACE_NODE_CHANGED");
  });

  // Kubernetes Compute fails a crash loop on consecutive unexplained exits only (finding 3041).
  // Each Gateway start counts its own exit in advance, in the termination message the kubelet
  // records at exit, so a kill the wrapper never sees counts too. A deliberate restart clears
  // the count and readiness starts it again from 1.
  test("Kubernetes Gateway counts consecutive unexplained exits across container restarts", async (t) => {
    // A deliberate restart, for another workspace node.
    const deliberate = await startCodexGatewaySupervisor(t, { bindingDeviceId: "a".repeat(64) });
    assert.equal(deliberate.files.get("/dev/termination-log"), unexplainedExits(1));
    deliberate.files.set(
      "/home/node/workspace-node-binding/workspace-node.json",
      JSON.stringify({ revisionId: deliberate.revisionId, deviceId: "b".repeat(64) }),
    );
    await required(deliberate.intervals.find(({ delay }) => delay === 1_000)).callback();
    required(deliberate.children[0]).exit(null, "SIGTERM");
    assert.deepEqual(deliberate.exits, [DELIBERATE_RESTART]);
    assertDeliberateRestart(deliberate, "WORKSPACE_NODE_CHANGED");
    // Then OpenClaw exits at every start; the second time something kills the container, which
    // the wrapper never sees.
    let previous = deliberate;
    for (const count of [1, 2, 3]) {
      const gateway = await startCodexGatewaySupervisor(t, { savedFiles: previous.files });
      assert.equal(gateway.files.get("/dev/termination-log"), unexplainedExits(count));
      assert.equal(gateway.files.get(UNEXPLAINED_EXITS), String(count));
      if (count !== 2) {
        required(gateway.children[0]).exit(1, null);
        assert.deepEqual(gateway.exits, [1]);
      }
      previous = gateway;
    }
    // A Gateway that becomes ready counts only its own exit.
    const ready = await startCodexGatewaySupervisor(t, {
      savedFiles: previous.files,
      runtimeStatus: true,
    });
    assert.equal(ready.files.get("/dev/termination-log"), unexplainedExits(4));
    assert.equal((await readReadyStatusFromHandler(ready.statusHandler)).status, 200);
    assert.equal(ready.files.get("/dev/termination-log"), unexplainedExits(1));
    assert.equal(ready.files.get(UNEXPLAINED_EXITS), "1");
    required(ready.children[0]).exit(1, null);
    const next = await startCodexGatewaySupervisor(t, { savedFiles: ready.files });
    assert.equal(next.files.get("/dev/termination-log"), unexplainedExits(2));
  });

  // A count write that stops half-way, as an out-of-memory kill would leave it, keeps the
  // previous count instead of a torn one that would lower the next start's count.
  test("Kubernetes Gateway replaces its unexplained exit count whole", async (t) => {
    const first = await startCodexGatewaySupervisor(t);
    required(first.children[0]).exit(1, null);
    const gateway = await startCodexGatewaySupervisor(t, {
      savedFiles: first.files,
      runtimeStatus: true,
    });
    assert.equal(gateway.files.get(UNEXPLAINED_EXITS), "2");
    gateway.tearWrite = (path) => path.startsWith(UNEXPLAINED_EXITS);
    assert.equal((await readReadyStatusFromHandler(gateway.statusHandler)).status, 200);
    assert.equal(gateway.tearWrite, undefined, "the count write should have been interrupted");
    assert.equal(gateway.files.get(UNEXPLAINED_EXITS), "2");
    assert.deepEqual(
      [...gateway.files.keys()].filter((path) => path.startsWith(`${UNEXPLAINED_EXITS}.`)),
      [],
    );
  });

  // Only the wrapper's own deliberate restart exits 75: an OpenClaw exit with that status is
  // reported as 1, so a native crash always counts toward a crash loop (finding 3041).
  test("Kubernetes Gateway reports a native exit with the deliberate restart status as 1", async (t) => {
    const gateway = await startCodexGatewaySupervisor(t);
    required(gateway.children[0]).exit(DELIBERATE_RESTART, null);
    assert.deepEqual(gateway.exits, [1]);
  });

  test("Codex gateway supervisor rejects changed plugin successes while its replacement starts", async (t) => {
    const gateway = await startCodexGatewaySupervisor(t);
    const first = required(gateway.children[0]);
    gateway.peerStatus = {
      ...gateway.peerStatus,
      startupId: "agent-startup-2",
      failures: [],
      successfulPluginIds: ["codex-plugin:linear@openai-curated-remote"],
    };
    gateway.serving = false;
    const respawn = gateway.pollPeer();
    await waitForCondition("the stale Gateway stop", () => first.killed.length === 1);
    first.exit(null, "SIGTERM");
    await waitForCondition("the replacement Gateway", () => gateway.children.length === 2);
    const replacement = required(gateway.children[1]);
    try {
      // Same peer identity and failure set, but its reported success set changed.
      gateway.peerStatus = { ...gateway.peerStatus, successfulPluginIds: [] };
      gateway.serving = true;
      await respawn;
      assert.equal(property(gateway.status(), "phase"), "starting");
      assert.deepEqual(replacement.killed, ["SIGTERM"]);
      assert.ok(
        gateway.logs.some((line) => {
          try {
            const entry = record(parseJson(text(line)));
            return entry.phase === "peer-verification-changed" && entry.outcome === "failed";
          } catch {
            return false;
          }
        }),
      );
    } finally {
      replacement.exit(null, "SIGTERM");
    }
    assert.deepEqual(gateway.exits, [DELIBERATE_RESTART]);
  });

  for (const [changedField, change] of [
    ["startup", { startupId: "agent-startup-3" }],
    ["pod", { podUid: "agent-pod-3" }],
    ["plugin failure set", { failures: [] }],
  ] satisfies readonly [
    string,
    Partial<Awaited<ReturnType<typeof startCodexGatewaySupervisor>>["peerStatus"]>,
  ][]) {
    test(`Codex gateway supervisor rejects a changed ${changedField} while its replacement starts`, async (t) => {
      const gateway = await startCodexGatewaySupervisor(t);
      const first = required(gateway.children[0]);
      gateway.peerStatus = { ...gateway.peerStatus, startupId: "agent-startup-2" };
      gateway.serving = false;
      const respawn = gateway.pollPeer();
      await waitForCondition("the stale Gateway stop", () => first.killed.length === 1);
      first.exit(null, "SIGTERM");
      await waitForCondition("the replacement Gateway", () => gateway.children.length === 2);
      gateway.peerStatus = { ...gateway.peerStatus, ...change };
      gateway.serving = true;
      await respawn;

      const replacement = required(gateway.children[1]);
      assert.equal(property(gateway.status(), "phase"), "starting");
      assert.deepEqual(replacement.killed, ["SIGTERM"]);
      assert.ok(
        gateway.logs.some((line) => {
          try {
            const entry = record(parseJson(text(line)));
            return entry.phase === "peer-verification-changed" && entry.outcome === "failed";
          } catch {
            return false;
          }
        }),
      );
      replacement.exit(null, "SIGTERM");
      assert.deepEqual(gateway.exits, [DELIBERATE_RESTART]);
    });
  }

  test("Codex gateway supervisor fails closed if peer status disappears during replacement startup", async (t) => {
    const gateway = await startCodexGatewaySupervisor(t);
    const first = required(gateway.children[0]);
    gateway.peerStatus = { ...gateway.peerStatus, startupId: "agent-startup-2" };
    gateway.serving = false;
    const respawn = gateway.pollPeer();
    await waitForCondition("the stale Gateway stop", () => first.killed.length === 1);
    first.exit(null, "SIGTERM");
    await waitForCondition("the replacement Gateway", () => gateway.children.length === 2);
    gateway.peerAvailable = false;
    gateway.serving = true;
    await respawn;

    const replacement = required(gateway.children[1]);
    assert.equal(property(gateway.status(), "phase"), "starting");
    assert.deepEqual(replacement.killed, ["SIGTERM"]);
    replacement.exit(null, "SIGTERM");
    assert.deepEqual(gateway.exits, [DELIBERATE_RESTART]);
  });

  for (const termination of ["crash", "SIGTERM", "SIGINT"] as const) {
    test(`Codex gateway supervisor handles ${termination} while verifying the replacement peer`, async (t) => {
      const gateway = await startCodexGatewaySupervisor(t);
      const first = required(gateway.children[0]);
      gateway.peerStatus = { ...gateway.peerStatus, startupId: "agent-startup-2" };
      gateway.serving = false;
      const respawn = gateway.pollPeer();
      await waitForCondition("the stale Gateway stop", () => first.killed.length === 1);
      first.exit(null, "SIGTERM");
      await waitForCondition("the replacement Gateway", () => gateway.children.length === 2);
      let releasePeer: (() => void) | undefined;
      gateway.peerGate = new Promise<void>((resolve) => {
        releasePeer = resolve;
      });
      gateway.serving = true;
      await waitForCondition("the peer verification request", () => gateway.peerRequestPending);

      const replacement = required(gateway.children[1]);
      try {
        if (termination !== "crash") {
          required(gateway.signalHandlers[termination])();
          assert.deepEqual(replacement.killed, [termination]);
          replacement.exit(null, termination);
        } else {
          replacement.exit(1, null);
        }
      } finally {
        required(releasePeer)();
      }
      await respawn;
      assert.equal(property(gateway.status(), "phase"), "starting");
      assert.deepEqual(gateway.exits, [termination === "SIGTERM" ? 0 : 1]);
      assert.equal(gateway.children.length, 2);
    });
  }

  test("Codex gateway supervisor bounds respawn retries and falls back to a container restart", async (t) => {
    const gateway = await startCodexGatewaySupervisor(t);
    gateway.peerStatus = { ...gateway.peerStatus, startupId: "agent-startup-2" };
    gateway.serving = false;
    const respawn = gateway.pollPeer();
    await waitForCondition(
      "the stale Gateway stop",
      () => required(gateway.children[0]).killed.length === 1,
    );
    required(gateway.children[0]).exit(null, "SIGTERM");
    // Every respawned process dies before it serves.
    for (let attempt = 1; attempt <= 3; attempt++) {
      // Retries back off by 1 s, then 2 s.
      const deadline = Date.now() + 5_000;
      while (gateway.children.length !== attempt + 1) {
        assert.ok(Date.now() < deadline, `respawn attempt ${attempt} did not start`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      required(gateway.children[attempt]).exit(1, null);
      assert.equal(property(gateway.status(), "phase"), "starting");
      assert.deepEqual(gateway.exits, [], "a respawn retry does not end the wrapper");
    }
    await respawn;
    assert.equal(gateway.children.length, 4);
    assert.deepEqual(gateway.exits, [DELIBERATE_RESTART]);
    // The peer changed once; the replacement that never served is what failed.
    assertDeliberateRestart(gateway, "HARNESS_PEER_RESPAWN_FAILED");
    assert.equal(property(gateway.status(), "phase"), "starting");
  });

  test("Codex gateway supervisor stops respawning a Gateway whose Harness keeps changing", async (t) => {
    const gateway = await startCodexGatewaySupervisor(t);
    for (let change = 2; change <= 6; change++) {
      const current = required(gateway.children.at(-1));
      gateway.peerStatus = { ...gateway.peerStatus, startupId: `agent-startup-${change}` };
      const respawn = gateway.pollPeer();
      await waitForCondition("the stale Gateway stop", () => current.killed.length === 1);
      current.exit(null, "SIGTERM");
      await respawn;
      assert.equal(property(gateway.status(), "phase"), "ready");
    }
    assert.equal(gateway.children.length, 6);
    assert.deepEqual(gateway.exits, []);
    // A sixth change within the window: the kubelet's backoff takes over.
    const last = required(gateway.children.at(-1));
    gateway.peerStatus = { ...gateway.peerStatus, startupId: "agent-startup-7" };
    await gateway.pollPeer();
    assert.deepEqual(last.killed, ["SIGTERM"]);
    assert.equal(property(gateway.status(), "phase"), "starting");
    last.exit(null, "SIGTERM");
    assert.deepEqual(gateway.exits, [DELIBERATE_RESTART]);
    assertDeliberateRestart(gateway, "HARNESS_PEER_CHANGED");
    assert.equal(gateway.children.length, 6);
  });

  test("Kubernetes Gateway holds a configuration OpenClaw refuses when its first start exits", async (t) => {
    const gateway = await startCodexGatewaySupervisor(t, {
      runtimeStatus: true,
      bindingDeviceId: "a".repeat(64),
    });
    gateway.validation = invalidGatewayConfiguration;
    // The kubelet's readiness probe finds OpenClaw unready; it exits at about 3 s, before
    // its /readyz ever answers 200.
    gateway.serving = false;
    assert.equal((await readReadyStatusFromHandler(gateway.statusHandler)).status, 503);
    const validationsBefore = gateway.validations;
    // OpenClaw refuses an invalid configuration with status 78 (EX_CONFIG).
    required(gateway.children[0]).exit(78, null);

    // The wrapper holds the failure instead of restarting the container into the same refusal.
    assert.deepEqual(gateway.exits, []);
    assert.equal(gateway.validations - validationsBefore, 1);
    const { checkedAt, ...held } = record(property(gateway.runtimeStatus(), "runtimeFailure"));
    assert.ok(!Number.isNaN(Date.parse(text(checkedAt))));
    assert.deepEqual(held, { component: "gateway", check: "gateway-config", code: "UNAVAILABLE" });
    // One log line names up to five settings. Only JSON Schema messages, which carry no
    // setting value, stay beside their paths: the configuration may hold secrets.
    assert.ok(
      gateway.logs.includes(invalidGatewayConfigurationLine(gatewayExitedBeforeServing("exit-78"))),
      JSON.stringify(gateway.logs),
    );
    assert.equal(JSON.stringify(gateway.logs).includes(invalidGatewayConfigurationSecret), false);

    // A held Gateway is not respawned for a changed Harness peer, nor restarted for another
    // workspace node; a container stop ends it. A respawn would validate again and hold anew,
    // so the validator count tells a skipped poll from a repeated hold.
    gateway.peerStatus = { ...gateway.peerStatus, startupId: "agent-startup-2" };
    await gateway.pollPeer();
    gateway.files.set(
      "/home/node/workspace-node-binding/workspace-node.json",
      JSON.stringify({ revisionId: gateway.revisionId, deviceId: "b".repeat(64) }),
    );
    await required(gateway.intervals.find(({ delay }) => delay === 1_000)).callback();
    assert.equal(gateway.children.length, 1);
    assert.deepEqual(gateway.exits, []);
    assert.equal(gateway.validations - validationsBefore, 1);
    assert.equal(property(gateway.runtimeStatus(), "runtimeFailure", "check"), "gateway-config");
    required(gateway.signalHandlers.SIGTERM)();
    assert.deepEqual(gateway.exits, [0]);
  });

  // Every other exit restarts the container as before; the hold covers only a Gateway that
  // never served, whose configuration OpenClaw's validator reports invalid.
  for (const {
    label,
    runtimeStatus = true,
    validation,
    served = false,
    exitCode = 1,
    validations,
  } of [
    { label: "a configuration the validator accepts", validation: undefined, validations: 1 },
    {
      label: "a validator that times out",
      validation: { status: null, error: new Error("spawnSync node ETIMEDOUT"), stdout: "" },
      validations: 1,
    },
    {
      label: "no Compute status port",
      runtimeStatus: false,
      validation: invalidGatewayConfiguration,
      validations: 0,
    },
    {
      label: "a Gateway that served first",
      validation: invalidGatewayConfiguration,
      served: true,
      validations: 0,
    },
    { label: "status 0", validation: invalidGatewayConfiguration, exitCode: 0, validations: 0 },
  ]) {
    test(`Kubernetes Gateway restarts after an exit with ${label}`, async (t) => {
      const gateway = await startCodexGatewaySupervisor(t, { runtimeStatus });
      if (validation !== undefined) {
        gateway.validation = validation;
      }
      if (served) {
        // The kubelet's readiness probe saw OpenClaw serve.
        assert.equal((await readReadyStatusFromHandler(gateway.statusHandler)).status, 200);
      }
      const validationsBefore = gateway.validations;
      required(gateway.children[0]).exit(exitCode, null);
      assert.deepEqual(gateway.exits, [exitCode]);
      assert.equal(gateway.validations - validationsBefore, validations);
      if (runtimeStatus) {
        assert.equal(property(gateway.runtimeStatus(), "runtimeFailure"), undefined);
      }
    });
  }
}
