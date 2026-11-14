import assert from "node:assert/strict";

import test from "node:test";

import { WORKSPACE_NODE_BINDING_PATH, workspaceNodeBinding } from "../helpers/plugin-runtime.mjs";
import {
  GATEWAY_LOCAL_CODEX_TOOLS,
  codexGatewayConfig,
  launchGateway,
  readConfig,
  field,
  record,
  stringList,
  parseJson,
  type RuntimeSandbox,
  type RuntimeInterval,
  type RuntimeKill,
} from "./plugin-runtime-policy-fixture.ts";
import vm from "node:vm";

// The file-transfer entry of OpenClaw's live `plugins.list` answer.
function pluginList(
  state: "active" | "disabled" | "service-failed" | "unloaded",
  generation: number,
) {
  return {
    generation,
    plugins: [
      { id: "codex", runtime: { state: "active" } },
      { id: "file-transfer", runtime: { state } },
    ],
  };
}

// What the wrapper's private runtime status would report.
function workspaceNodeState(sandbox: RuntimeSandbox) {
  const observed: unknown = vm.runInContext(
    "[runtimeWorkspaceNodeId, runtimeWorkspaceNodeFailure?.code]",
    sandbox,
  );
  assert.ok(Array.isArray(observed) && observed.length === 2, "expected the VM node state");
  const nodeState: readonly unknown[] = observed;
  const [nodeId, failure] = nodeState;
  assert.ok(nodeId === undefined || typeof nodeId === "string");
  assert.ok(failure === undefined || typeof failure === "string");
  return { nodeId, failure };
}

// OpenClaw dynamic tools that execute against the Gateway Pod's local disk or shell,
// type into its terminals, proxy its ports, or change its configuration, plugins

function workspacePoll(intervals: RuntimeInterval[]): RuntimeInterval {
  const poll = intervals.find(({ ms }) => ms === 1000);
  assert.ok(poll, "the wrapper polls the binding every second");
  return poll;
}

export function registerWorkspacePollCases() {
  test("a running Gateway hot-applies its workspace node under plugins.* and acks only OpenClaw's reload", async () => {
    const intervals: RuntimeInterval[] = [];
    const kills: RuntimeKill[] = [];
    const lines: Record<string, unknown>[] = [];
    let openClaw = pluginList("disabled", 1);
    // The Gateway starts before the node pairs: the optional binding file is absent.
    // Its provider owns a private directory outside the model/file-transfer workspace.
    const { config: baseConfig, codex } = codexGatewayConfig();
    codex.config.appServer.nativeHookRelay = {
      url: "https://gateway.example.test/node/__openclaw__/native-hook",
      credentialDirectory: "/private/provider-home/.oce-native-hooks",
    };
    const hookDirectory = "/private/provider-home/.oce-native-hooks";
    const { files, calls, sandbox } = await launchGateway(undefined, [], {
      baseConfig,
      env: {
        APP_SERVER_URL: "ws://harness.example.test:18790",
        OPENCLAW_REMOTE_WORKSPACE_ROOT: "/sandbox/enterprise",
      },
      workspaceNodeBindingPath: true,
      intervals,
      kills,
      gatewayCall: (method) => (method === "plugins.list" ? openClaw : undefined),
      setTimeout: () => ({ unref() {} }),
      console: { error: (line) => lines.push(record(parseJson(line))) },
    });
    const configPath = "/home/node/.openclaw/openclaw.json";
    const atStart = readConfig(files, configPath);
    assert.equal(
      field(atStart, "plugins", "entries", "codex", "config", "appServer", "remoteWorkspaceRoot"),
      "/sandbox/enterprise",
    );
    assert.deepEqual(
      field(atStart, "plugins", "entries", "codex", "config", "appServer", "nativeHookRelay"),
      {
        ...codex.config.appServer.nativeHookRelay,
        credentialDirectory: hookDirectory,
      },
    );
    assert.equal(field(atStart, "plugins", "entries", "file-transfer"), undefined);
    // Before the node pairs, Codex already gets no tool that would act on the
    // Gateway Pod's empty workspace or run commands there.
    assert.deepEqual(
      field(atStart, "plugins", "entries", "codex", "config", "codexDynamicToolsExclude"),
      GATEWAY_LOCAL_CODEX_TOOLS,
    );
    // Automation triggers would run model-written commands in the Gateway Pod.
    assert.deepEqual(atStart.cron, { triggers: { enabled: false } });
    // The memory flush run gets Gateway-local read and write despite the excludes.
    assert.deepEqual(atStart.agents, {
      defaults: { compaction: { memoryFlush: { enabled: false } }, modelSelectionScope: "session" },
    });
    // Defaults the owner never set are not reported as overridden.
    assert.ok(
      lines.every(
        (line) =>
          line.event !== "runtime.gateway_settings_overridden" ||
          !stringList(line.settings).some((name) => name.startsWith("agents.")),
      ),
    );
    // A built-in runtime run in the Gateway gets no reachable model.
    assert.deepEqual(atStart.models, {
      providers: { codex: { baseUrl: "http://127.0.0.1:9", api: "openai-responses" } },
    });
    // gateway.* is final at start: the command grant precedes any node ID.
    assert.equal(
      stringList(field(atStart, "gateway", "nodes", "commands", "allow")).includes("file.fetch"),
      true,
    );
    const gatewayAtStart = JSON.stringify(atStart.gateway);
    const poll = intervals.find(({ ms }) => ms === 1000);
    assert.ok(poll, "the wrapper polls the binding every second");
    const tick = () => poll.callback();
    const gatewayCalls = () => calls.filter(({ method }) => method === "plugins.list");

    await tick();
    assert.equal(files.get(configPath), JSON.stringify(atStart), "no binding, no write");
    // A partial file, one for another revision of this Agent, or a malformed
    // device ID is treated as absent.
    for (const binding of [
      '{"revisionId":"revi',
      workspaceNodeBinding("enrolled-node", "revision-2"),
      workspaceNodeBinding("../escape"),
    ]) {
      files.set(WORKSPACE_NODE_BINDING_PATH, binding);
      await tick();
      assert.equal(files.get(configPath), JSON.stringify(atStart));
    }
    assert.equal(gatewayCalls().length, 0);

    files.set(WORKSPACE_NODE_BINDING_PATH, workspaceNodeBinding("enrolled-node"));
    await tick();
    const applied = readConfig(files, configPath);
    const changedKeys = Object.keys({ ...atStart, ...applied }).filter(
      (key) => JSON.stringify(atStart[key]) !== JSON.stringify(applied[key]),
    );
    assert.deepEqual(changedKeys, ["plugins"]);
    assert.equal(JSON.stringify(applied.gateway), gatewayAtStart, "gateway.* is byte-identical");
    assert.deepEqual(field(applied, "plugins", "allow"), ["codex", "file-transfer"]);
    assert.equal(field(applied, "plugins", "entries", "file-transfer", "enabled"), true);
    assert.deepEqual(
      field(applied, "plugins", "entries", "file-transfer", "config", "workspaces", "main"),
      {
        nodeId: "enrolled-node",
        remoteRoot: "/sandbox/enterprise",
      },
    );
    assert.deepEqual(
      field(applied, "plugins", "entries", "codex"),
      field(atStart, "plugins", "entries", "codex"),
    );
    // The write was a whole-file replacement, not an in-place rewrite.
    assert.equal(
      [...files.keys()].some((path) => path.includes(".workspace-node-")),
      false,
    );
    // Writing the file is not the ack: OpenClaw has not reloaded its plugins yet.
    assert.deepEqual(workspaceNodeState(sandbox), { nodeId: undefined, failure: undefined });
    await tick();
    assert.deepEqual(workspaceNodeState(sandbox), { nodeId: undefined, failure: undefined });

    // OpenClaw's reload published a registry with file-transfer active.
    openClaw = pluginList("active", 2);
    await tick();
    assert.deepEqual(workspaceNodeState(sandbox), { nodeId: "enrolled-node", failure: undefined });
    assert.deepEqual(
      gatewayCalls().map(({ method }) => method),
      ["plugins.list", "plugins.list", "plugins.list"],
    );
    // OpenClaw watches the file it was started with; the child is not replaced.
    assert.equal(
      calls.filter(({ args }) => args?.[1] === "gateway" && args.length === 4).length,
      1,
    );
    assert.deepEqual(kills, []);
    assert.deepEqual(
      lines
        .filter(({ phase }) => typeof phase === "string" && phase.startsWith("workspace-node"))
        .map(({ phase, outcome }) => [phase, outcome]),
      [["workspace-node", "ok"]],
    );

    // The same binding again is a no-op.
    await tick();
    assert.equal(files.get(configPath), JSON.stringify(applied));
    assert.equal(gatewayCalls().length, 3);
    // Another node for this revision replaces the config from a clean start.
    files.set(WORKSPACE_NODE_BINDING_PATH, workspaceNodeBinding("other-node"));
    await tick();
    assert.equal(files.get(configPath), JSON.stringify(applied));
    assert.deepEqual(kills, [{ signal: "SIGTERM" }]);
  });

  test("a Gateway reports why OpenClaw has not applied its workspace node and clears it on success", async () => {
    const intervals: RuntimeInterval[] = [];
    const lines: Record<string, unknown>[] = [];
    let now = 1_000_000;
    const clock = class extends Date {
      static override now() {
        return now;
      }
    };
    let openClaw: ReturnType<typeof pluginList> | undefined;
    const { files, sandbox } = await launchGateway(undefined, [], {
      baseConfig: codexGatewayConfig().config,
      env: { APP_SERVER_URL: "ws://harness.example.test:18790" },
      workspaceNodeBindingPath: true,
      intervals,
      Date: clock,
      gatewayCall: () => openClaw,
      setTimeout: () => ({ unref() {} }),
      console: { error: (line) => lines.push(record(parseJson(line))) },
    });
    const configPath = "/home/node/.openclaw/openclaw.json";
    const tick = () => workspacePoll(intervals).callback();
    const failures = () =>
      lines.filter(({ event }) => event === "runtime.workspace_node").map(({ code }) => code);
    files.set(WORKSPACE_NODE_BINDING_PATH, workspaceNodeBinding("enrolled-node"));

    // The Gateway does not answer: nothing is written, and after the budget that is the cause.
    await tick();
    now += 31_000;
    await tick();
    assert.deepEqual(workspaceNodeState(sandbox), {
      nodeId: undefined,
      failure: "GATEWAY_UNAVAILABLE",
    });
    assert.equal(
      field(readConfig(files, configPath), "plugins", "entries", "file-transfer"),
      undefined,
    );

    // A config that now denies file-transfer cannot host the node.
    openClaw = pluginList("disabled", 1);
    const denied = readConfig(files, configPath);
    record(denied.plugins).deny = ["file-transfer"];
    files.set(configPath, JSON.stringify(denied));
    await tick();
    assert.deepEqual(workspaceNodeState(sandbox), {
      nodeId: undefined,
      failure: "FILE_TRANSFER_DENIED",
    });
    delete record(denied.plugins).deny;
    files.set(configPath, JSON.stringify(denied));

    // Written, but OpenClaw's file-transfer service failed to start.
    await tick();
    assert.equal(
      field(
        readConfig(files, configPath),
        "plugins",
        "entries",
        "file-transfer",
        "config",
        "workspaces",
        "main",
        "nodeId",
      ),
      "enrolled-node",
    );
    openClaw = pluginList("service-failed", 2);
    await tick();
    assert.deepEqual(workspaceNodeState(sandbox), {
      nodeId: undefined,
      failure: "FILE_TRANSFER_FAILED",
    });
    // Still unloaded past the budget: the reload never happened.
    openClaw = pluginList("disabled", 1);
    now += 31_000;
    await tick();
    assert.deepEqual(workspaceNodeState(sandbox), {
      nodeId: undefined,
      failure: "RELOAD_NOT_CONFIRMED",
    });
    // A later reload clears the cause.
    openClaw = pluginList("active", 3);
    await tick();
    assert.deepEqual(workspaceNodeState(sandbox), { nodeId: "enrolled-node", failure: undefined });
    assert.deepEqual(failures(), [
      "GATEWAY_UNAVAILABLE",
      "FILE_TRANSFER_DENIED",
      "FILE_TRANSFER_FAILED",
      "RELOAD_NOT_CONFIRMED",
    ]);
  });

  // The error OpenClaw's CLI call rejects with when the Gateway refuses its connect
  // handshake: a GatewayClientRequestError carrying the server's connect-error details.
  function gatewayConnectRefusal(detailCode: string, retryable = false) {
    return Object.assign(new Error("unauthorized"), {
      name: "GatewayClientRequestError",
      gatewayCode: "INVALID_REQUEST",
      retryable,
      details: { code: detailCode, authReason: "trusted_proxy_untrusted_source" },
    });
  }

  test("a Gateway that refuses its own CLI as unauthorized reports it at once; other refusals keep waiting", async () => {
    const intervals: RuntimeInterval[] = [];
    let now = 1_000_000;
    const clock = class extends Date {
      static override now() {
        return now;
      }
    };
    const lines: Record<string, unknown>[] = [];
    let refusal: Error | undefined;
    let openClaw: ReturnType<typeof pluginList> | undefined;
    const { files, sandbox } = await launchGateway(undefined, [], {
      baseConfig: codexGatewayConfig().config,
      env: { APP_SERVER_URL: "ws://harness.example.test:18790" },
      workspaceNodeBindingPath: true,
      intervals,
      Date: clock,
      gatewayCall: () => {
        if (refusal !== undefined) {
          throw refusal;
        }
        return openClaw;
      },
      setTimeout: () => ({ unref() {} }),
      console: { error: (line) => lines.push(record(parseJson(line))) },
    });
    const configPath = "/home/node/.openclaw/openclaw.json";
    const tick = () => workspacePoll(intervals).callback();
    files.set(WORKSPACE_NODE_BINDING_PATH, workspaceNodeBinding("enrolled-node"));

    // A rate-limited or pairing refusal clears by itself: it waits like an
    // unreachable Gateway and is reported only as unavailable after the budget.
    refusal = gatewayConnectRefusal("AUTH_RATE_LIMITED", true);
    await tick();
    refusal = gatewayConnectRefusal("PAIRING_REQUIRED");
    await tick();
    assert.deepEqual(workspaceNodeState(sandbox), { nodeId: undefined, failure: undefined });
    now += 31_000;
    await tick();
    assert.deepEqual(workspaceNodeState(sandbox), {
      nodeId: undefined,
      failure: "GATEWAY_UNAVAILABLE",
    });

    // D381: without gateway.auth.password the in-Pod CLI connects with no
    // credential and the Gateway refuses it on every call. That is fixed by the
    // admitted configuration, so it is reported on the first refusal.
    refusal = gatewayConnectRefusal("AUTH_UNAUTHORIZED");
    await tick();
    assert.deepEqual(workspaceNodeState(sandbox), {
      nodeId: undefined,
      failure: "GATEWAY_UNAUTHORIZED",
    });
    assert.equal(
      field(readConfig(files, configPath), "plugins", "entries", "file-transfer"),
      undefined,
    );
    // The Pod log names OpenClaw's refusal reason, so the operator can see why.
    assert.deepEqual(
      lines
        .filter(({ event }) => event === "runtime.workspace_node")
        .map(({ code, reason }) => ({ code, reason })),
      [
        { code: "GATEWAY_UNAVAILABLE", reason: undefined },
        { code: "GATEWAY_UNAUTHORIZED", reason: "trusted_proxy_untrusted_source" },
      ],
    );

    // A refusal after the node was written is reported the same way.
    refusal = undefined;
    openClaw = pluginList("disabled", 1);
    await tick();
    assert.equal(
      field(
        readConfig(files, configPath),
        "plugins",
        "entries",
        "file-transfer",
        "config",
        "workspaces",
        "main",
        "nodeId",
      ),
      "enrolled-node",
    );
    refusal = gatewayConnectRefusal("AUTH_PASSWORD_MISSING");
    await tick();
    assert.deepEqual(workspaceNodeState(sandbox), {
      nodeId: undefined,
      failure: "GATEWAY_UNAUTHORIZED",
    });
    refusal = undefined;
    openClaw = pluginList("active", 2);
    await tick();
    assert.deepEqual(workspaceNodeState(sandbox), { nodeId: "enrolled-node", failure: undefined });
  });

  test("a Gateway that starts after its node paired applies the binding before OpenClaw starts", async () => {
    const intervals: RuntimeInterval[] = [];
    const kills: RuntimeKill[] = [];
    let openClaw = pluginList("unloaded", 1);
    const { files, calls, sandbox } = await launchGateway(undefined, [], {
      workspaceNodeId: "enrolled-node",
      intervals,
      kills,
      gatewayCall: () => openClaw,
      setTimeout: () => ({ unref() {} }),
    });
    const effective = readConfig(files);
    assert.equal(
      field(
        effective,
        "plugins",
        "entries",
        "file-transfer",
        "config",
        "workspaces",
        "main",
        "nodeId",
      ),
      "enrolled-node",
    );
    assert.equal(calls.length, 1);
    // The poll writes nothing and waits for OpenClaw to report file-transfer loaded.
    const written = files.get("/home/node/.openclaw/openclaw.json");
    const tick = () => workspacePoll(intervals).callback();
    await tick();
    assert.equal(workspaceNodeState(sandbox).nodeId, undefined);
    openClaw = pluginList("active", 1);
    await tick();
    assert.equal(workspaceNodeState(sandbox).nodeId, "enrolled-node");
    assert.equal(files.get("/home/node/.openclaw/openclaw.json"), written);
    assert.deepEqual(kills, []);
  });

  test("a Gateway starting with its node bound measures the apply budget from OpenClaw's spawn", async () => {
    const intervals: RuntimeInterval[] = [];
    // The wrapper's first clock read is its startup origin; login, the model probe
    // and plugin install then take a minute before OpenClaw spawns.
    let now = 0;
    let reads = 0;
    const clock = class extends Date {
      static override now() {
        return reads++ === 0 ? 0 : now;
      }
    };
    now = 60_000;
    const gateway: { reply?: ReturnType<typeof pluginList> } = {};
    const { sandbox } = await launchGateway(undefined, [], {
      workspaceNodeId: "enrolled-node",
      intervals,
      Date: clock,
      gatewayCall: () => gateway.reply,
      setTimeout: () => ({ unref() {} }),
      console: { error() {} },
    });
    const tick = () => workspacePoll(intervals).callback();
    // OpenClaw is still coming up: not a failure yet.
    await tick();
    assert.deepEqual(workspaceNodeState(sandbox), { nodeId: undefined, failure: undefined });
    now += 31_000;
    await tick();
    assert.deepEqual(workspaceNodeState(sandbox), {
      nodeId: undefined,
      failure: "GATEWAY_UNAVAILABLE",
    });
    gateway.reply = pluginList("active", 1);
    await tick();
    assert.deepEqual(workspaceNodeState(sandbox), { nodeId: "enrolled-node", failure: undefined });
  });

  test("a Gateway given its node in the environment configures it at start and arms no poll", async () => {
    // Native worker profiles, and Gateways whose controller cannot read runtime
    // status, receive OPENCLAW_WORKSPACE_NODE_ID instead of a binding file.
    const intervals: RuntimeInterval[] = [];
    const kills: RuntimeKill[] = [];
    const { files, calls, sandbox } = await launchGateway(undefined, [], {
      env: {
        APP_SERVER_URL: "ws://harness.example.test:18790",
        OPENCLAW_WORKSPACE_NODE_ID: "environment-node",
      },
      intervals,
      kills,
    });
    const effective = readConfig(files);
    assert.equal(
      field(
        effective,
        "plugins",
        "entries",
        "file-transfer",
        "config",
        "workspaces",
        "main",
        "nodeId",
      ),
      "environment-node",
    );
    assert.equal(sandbox.process.env.OPENCLAW_WORKSPACE_NODE_PATH, undefined);
    assert.equal(calls.filter(({ args }) => args?.[1] === "gateway").length, 1);
    assert.deepEqual(intervals, [], "no binding poll without a binding path");
    assert.deepEqual(workspaceNodeState(sandbox), { nodeId: undefined, failure: undefined });
    assert.deepEqual(kills, []);
  });
}

export function registerWorkspaceTimeoutCase() {
  test("a timed-out workspace binding probe releases the poll and can recover", async () => {
    const intervals: RuntimeInterval[] = [];
    const probe: { timeout?: () => void; signal?: AbortSignal } = {};
    let unavailable = true;
    let openClaw = pluginList("disabled", 1);
    const { files, sandbox } = await launchGateway(undefined, [], {
      baseConfig: codexGatewayConfig().config,
      env: { APP_SERVER_URL: "ws://harness.example.test:18790" },
      workspaceNodeBindingPath: true,
      intervals,
      gatewayCall: (_method, probeSignal) => {
        probe.signal = probeSignal;
        return unavailable ? new Promise<never>(() => {}) : openClaw;
      },
      setTimeout: (callback, ms) => {
        if (ms === 8000) {
          probe.timeout = callback;
        }
        return { unref() {} };
      },
      console: { error() {} },
    });
    files.set(WORKSPACE_NODE_BINDING_PATH, workspaceNodeBinding("enrolled-node"));
    const poll = workspacePoll(intervals);
    const pending = poll.callback();
    await new Promise((resolve) => setImmediate(resolve));
    // A probe that never settles must still release the single-flight poll.
    assert.ok(probe.timeout, "the workspace probe arms a timeout");
    probe.timeout();
    await pending;
    assert.ok(probe.signal, "the workspace probe receives an abort signal");
    assert.equal(probe.signal.aborted, true);
    assert.deepEqual(workspaceNodeState(sandbox), { nodeId: undefined, failure: undefined });

    unavailable = false;
    await poll.callback();
    assert.deepEqual(workspaceNodeState(sandbox), { nodeId: undefined, failure: undefined });
    openClaw = pluginList("active", 2);
    await poll.callback();
    assert.deepEqual(workspaceNodeState(sandbox), { nodeId: "enrolled-node", failure: undefined });
  });
}
