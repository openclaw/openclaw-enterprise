import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import {
  GATEWAY_STATE_DATABASE_PATH,
  gatewayOwnerTermination,
  gatewayOwnerTerminationMessage,
  nativeGatewayOwnersMatch,
  parseNativeGatewayOwnerRecords,
  parseNativeGatewayStateOwner,
  TRUSTED_GATEWAY_TOOL_BOUNDARY,
  GATEWAY_RECOVERY_SOURCE_PROTECTION,
  GATEWAY_PRIVATE_STATE_ORIGIN,
  parseNativeGatewayStateObservation,
  NATIVE_GATEWAY_STATE_OBSERVATION_VALIDATORS,
} from "../../apps/controller/src/drivers/compute/native-state-owner.ts";
import {
  NATIVE_GATEWAY_STATE_RECOVERY_RUNTIME,
  nativeGatewayRecoveryConfigurationEligible,
} from "../../apps/controller/src/drivers/compute/native-state-recovery-runtime.ts";
import { codexOpenClawConfiguration } from "../../apps/controller/src/drivers/plugin/runtime-translator.ts";
import { KubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { routedOptions, routedRevision } from "../helpers/kubernetes-routed-scenarios.mjs";
import { runOpenClawRuntimeHelper } from "../helpers/plugin-runtime.mjs";

const owner = {
  databasePath: GATEWAY_STATE_DATABASE_PATH,
  ownerId: "native-owner-1",
  role: "gateway",
  pid: 21,
  startTime: 987654,
  processNamespace: {
    platform: "linux",
    host: "gateway-pod",
    identity: "operating-system-boot",
    pidNsInode: "4026532999",
  },
};
const binding = {
  version: 1,
  toolBoundary: TRUSTED_GATEWAY_TOOL_BOUNDARY,
  sourceProtection: GATEWAY_RECOVERY_SOURCE_PROTECTION,
  stateOrigin: GATEWAY_PRIVATE_STATE_ORIGIN,
  pvcUid: "private-state-pvc-uid",
  revisionId: "revision-1",
  instanceId: "wrapper-1",
  podName: "gateway-pod",
  podUid: "pod-uid-1",
  containerId: "containerd://old-container",
  owner,
};
const records = ["state-owner", "state-lock", "config-lock", "gateway-lease"].map((kind) => ({
  kind,
  owner,
}));

test("automatic recovery needs every complete native holder to match the observed owner", () => {
  assert.deepEqual(parseNativeGatewayStateOwner(owner), owner);
  assert.equal(nativeGatewayOwnersMatch(parseNativeGatewayOwnerRecords(records), owner), true);
  assert.equal(nativeGatewayOwnersMatch([], owner), false);
  for (const malformed of [
    undefined,
    [{ kind: "state-owner", owner: null }],
    [{ kind: "future-holder", owner }],
    [records[0], records[0]],
    [{ kind: "gateway-lease", owner: { ...owner, ownerId: null } }],
    [{ kind: "state-lock", owner: { ...owner, startTime: null } }],
    [{ kind: "state-lock", owner: { ...owner, role: "sqlite-maintenance" } }],
  ]) {
    assert.equal(parseNativeGatewayOwnerRecords(malformed), undefined);
  }
  for (const changed of [
    { ownerId: "different-owner" },
    { databasePath: "/another/state/openclaw.sqlite" },
    { startTime: owner.startTime + 1 },
    { processNamespace: { ...owner.processNamespace, pidNsInode: "4026533000" } },
  ]) {
    const mixed = parseNativeGatewayOwnerRecords([
      ...records.slice(0, 3),
      { ...records[3], owner: { ...owner, ...changed } },
    ]);
    assert.equal(nativeGatewayOwnersMatch(mixed, owner), false);
  }
});

test("container death requires the exact container's own native-owner termination message", () => {
  const terminated = {
    containerID: binding.containerId,
    reason: "Error",
    exitCode: 137,
    finishedAt: "2026-10-23T10:00:00.000Z",
    message: gatewayOwnerTerminationMessage(binding),
  };
  const pod = {
    metadata: { name: binding.podName, uid: binding.podUid },
    status: { containerStatuses: [{ name: "gateway", state: { terminated } }] },
  };
  const expected = {
    containerId: binding.containerId,
    finishedAt: terminated.finishedAt,
    exitCode: 137,
  };
  assert.deepEqual(gatewayOwnerTermination(pod, binding), expected);
  const restarted = structuredClone(pod);
  restarted.status.containerStatuses[0] = {
    name: "gateway",
    containerID: "containerd://new-container",
    state: { running: {} },
    lastState: { terminated },
  };
  assert.deepEqual(gatewayOwnerTermination(restarted, binding), expected);
  for (const invalid of [
    undefined,
    { ...pod, metadata: { ...pod.metadata, uid: "replacement-pod-uid" } },
    { ...pod, metadata: { ...pod.metadata, deletionGracePeriodSeconds: 0 } },
    { ...pod, status: { ...pod.status, reason: "NodeLost" } },
    { ...pod, status: { phase: "Failed", containerStatuses: [] } },
  ]) {
    assert.equal(gatewayOwnerTermination(invalid, binding), undefined);
  }
  for (const changed of [
    { containerID: "containerd://another-container" },
    { reason: "ContainerStatusUnknown" },
    { message: terminated.message.slice(0, -1) },
    { message: "unrelated runtime error: " + terminated.message },
    { finishedAt: "0001-01-01T00:00:00Z" },
  ]) {
    const invalid = structuredClone(pod);
    Object.assign(invalid.status.containerStatuses[0].state.terminated, changed);
    assert.equal(gatewayOwnerTermination(invalid, binding), undefined);
  }
  // Before/after API snapshots can still show A's old ID while a request reaches B.
  // A's own termination message cannot prove B's separately observed owner dead.
  assert.equal(
    gatewayOwnerTermination(pod, {
      ...binding,
      instanceId: "wrapper-2",
      owner: { ...owner, ownerId: "still-live-owner-2" },
    }),
    undefined,
  );
});

function runtimeFixture({
  inspectionRecords = records,
  request = binding,
  confirmed = true,
  protectedBoundary = true,
  environment = {},
  configuration = {
    plugins: {
      entries: {
        codex: { config: { appServer: { transport: "websocket", url: "ws://harness:18790" } } },
      },
    },
  },
  globalEnvironment = false,
  imageWritable = false,
  hangCommand = false,
  inventory = {
    workspaceScope: "selected",
    workspaceDir: "/home/node/workspace",
    registry: {
      source: "derived",
      diagnostics: [{ level: "info", code: "persisted-registry-missing" }],
    },
    diagnostics: [],
    plugins: [
      {
        id: "codex",
        enabled: true,
        status: "loaded",
        origin: "bundled",
        source: "/app/dist/extensions/codex/index.js",
        rootDir: "/app/dist/extensions/codex",
      },
    ],
  },
} = {}) {
  const commands = [];
  const timers = [];
  const writes = [];
  const processGroups = [];
  const children = [];
  let inspections = 0;
  let paused;
  const waiting = new Promise((resolve) => {
    paused = resolve;
  });
  const context = {
    Buffer,
    URL,
    runtimeGatewayState: undefined,
    runtimeStatusObservation: undefined,
    pluginStatusReport: { startupId: binding.instanceId },
    process: {
      kill: (...args) => processGroups.push(args),
      env: {
        OPENCLAW_STATE_OWNER_RECOVERY_PATH: "/etc/openclaw-state-recovery/request.json",
        OPENCLAW_AGENT_REVISION_ID: binding.revisionId,
        OPENCLAW_POD_UID: binding.podUid,
        OPENCLAW_STATE_RECOVERY_ORIGIN: GATEWAY_PRIVATE_STATE_ORIGIN,
        OPENCLAW_STATE_RECOVERY_STORAGE_ID: binding.pvcUid,
        ...(protectedBoundary
          ? { OPENCLAW_TRUSTED_GATEWAY_TOOL_BOUNDARY: TRUSTED_GATEWAY_TOOL_BOUNDARY }
          : {}),
        OPENCLAW_GATEWAY_PORT: "8080",
        ...environment,
      },
    },
    child: { pid: owner.pid },
    childRunning: true,
    gatewayEnvironment: () => ({ OPENCLAW_CONFIG_PATH: "/etc/openclaw-managed/openclaw.json" }),
    readOpenClawConfig: () => configuration,
    require: () => ({
      constants: { W_OK: 2 },
      lstatSync: () => {
        if (globalEnvironment) {
          return {};
        }
        throw Object.assign(new Error("absent"), { code: "ENOENT" });
      },
      realpathSync: (path) => path,
      accessSync: () => {
        if (!imageWritable) {
          throw Object.assign(new Error("read only"), { code: "EROFS" });
        }
      },
    }),
    pluginReadFileSync: () => JSON.stringify({ storageId: binding.pvcUid, ...request }),
    pluginWriteFileSync: (...args) => writes.push(args),
    callNativeGateway: async () => ({ ok: true, value: { stateOwner: owner } }),
    setTimeout: (callback, delay) => {
      const timer = { callback, delay };
      timers.push(timer);
      if (delay === 500) {
        paused();
      }
      return timer;
    },
    clearTimeout: (timer) => timers.splice(timers.indexOf(timer), 1),
    spawn: (executable, args, options) => {
      commands.push({ executable, args, options });
      const child = new EventEmitter();
      child.pid = 4242;
      children.push(child);
      child.stdout = new EventEmitter();
      child.stderr = { resume() {} };
      child.kill = () => {};
      if (hangCommand) {
        return child;
      }
      queueMicrotask(() => {
        if (args[1] === "plugins") {
          child.stdout.emit("data", Buffer.from(JSON.stringify(inventory)));
          child.emit("close", 0);
          return;
        }
        const confirmation = args.includes("--confirm");
        const empty = confirmed && inspections++ >= 2;
        const result = confirmation
          ? { recovered: confirmed }
          : {
              present: !empty,
              ownerRecords: empty ? [] : inspectionRecords,
              confirmation: "unchanged-native-snapshot",
            };
        child.stdout.emit("data", Buffer.from(JSON.stringify(result)));
        child.emit("close", confirmation && !confirmed ? 1 : 0);
      });
      return child;
    },
  };
  runInNewContext(NATIVE_GATEWAY_STATE_RECOVERY_RUNTIME, context);
  return { context, commands, timers, writes, waiting, processGroups, children, inventory };
}

test("the trusted wrapper confirms only matching holders and keeps native CAS refusal", async () => {
  const fixture = runtimeFixture();
  assert.equal(await fixture.context.prepareNativeGatewayStateRecovery(), true);
  assert.deepEqual(
    fixture.commands.map(({ args }) => [...args]),
    [
      ["/app/openclaw.mjs", "gateway", "recover-lock", "--json"],
      ["/app/openclaw.mjs", "gateway", "recover-lock", "--json"],
      [
        "/app/openclaw.mjs",
        "gateway",
        "recover-lock",
        "--json",
        "--confirm",
        "unchanged-native-snapshot",
      ],
      ["/app/openclaw.mjs", "gateway", "recover-lock", "--json"],
    ],
  );
  for (const command of fixture.commands) {
    assert.deepEqual(
      { ...command.options.env },
      { OPENCLAW_CONFIG_PATH: "/etc/openclaw-managed/openclaw.json" },
    );
  }
  const refused = runtimeFixture({ confirmed: false });
  assert.equal(await refused.context.prepareNativeGatewayStateRecovery(), false);
  assert.equal(refused.context.runtimeGatewayState.recovery.state, "refused");
  assert.equal(refused.commands.filter(({ args }) => args.includes("--confirm")).length, 1);
});

test(
  "foreign wrapper intent and mixed holder identities never reach confirmation",
  { timeout: 2000 },
  async () => {
    for (const options of [
      { request: { ...binding, instanceId: "previous-wrapper" } },
      { request: { ...binding, podUid: "previous-pod" } },
      { inspectionRecords: [{ ...records[0], owner: { ...owner, ownerId: "another-owner" } }] },
    ]) {
      const fixture = runtimeFixture(options);
      void fixture.context.prepareNativeGatewayStateRecovery();
      await fixture.waiting;
      assert.equal(fixture.context.runtimeGatewayState.recovery.state, "waiting");
      assert.equal(
        fixture.commands.some(({ args }) => args.includes("--confirm")),
        false,
      );
      assert.equal(
        fixture.timers.some(({ delay }) => delay === 500),
        true,
      );
    }
  },
);

test("the runtime performs no observation or recovery without the trusted composition fence", async () => {
  for (const options of [
    { protectedBoundary: false },
    { environment: { OPENCLAW_STATE_RECOVERY_ORIGIN: undefined } },
    { environment: { OPENCLAW_STATE_RECOVERY_STORAGE_ID: undefined } },
  ]) {
    const fixture = runtimeFixture(options);
    assert.equal(await fixture.context.prepareNativeGatewayStateRecovery(), true);
    await fixture.context.observeNativeGatewayStateOwner();
    assert.equal(fixture.context.runtimeStatusObservation, undefined);
    assert.equal(fixture.context.runtimeGatewayState, undefined);
    assert.equal(fixture.commands.length, 0);
    assert.equal(fixture.writes.length, 0);
  }
});

test("the wrapper attests a live child before exposing its identity and ignores replaced children", async () => {
  const fixture = runtimeFixture();
  await fixture.context.observeNativeGatewayStateOwner();
  assert.equal(fixture.writes[0][0], "/dev/termination-log");
  assert.equal(fixture.writes[0][1], gatewayOwnerTerminationMessage(binding));
  assert.deepEqual(
    JSON.parse(JSON.stringify(fixture.context.runtimeGatewayState.liveOwner)),
    owner,
  );
  let release;
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  fixture.context.callNativeGateway = () =>
    new Promise((resolve) => {
      release = resolve;
      entered();
    });
  const observing = fixture.context.observeNativeGatewayStateOwner();
  await started;
  fixture.context.child = { pid: owner.pid + 1 };
  fixture.context.runtimeGatewayState = { instanceId: binding.instanceId };
  release({ ok: true, value: { stateOwner: owner } });
  await observing;
  assert.equal(fixture.context.runtimeGatewayState.liveOwner, undefined);
  assert.equal(fixture.writes.length, 1);
});

test("unqualified control inputs skip automatic recovery and preserve application data", async () => {
  for (const options of [
    { globalEnvironment: true },
    { configuration: { env: { NODE_OPTIONS: "--require=/workspace/helper.js" } } },
    {
      configuration: {
        secrets: { providers: { custom: { source: "exec", command: "/workspace/credential" } } },
      },
    },
    { configuration: { $include: "/home/node/workspace/config.json" } },
    { configuration: { hooks: { internal: { enabled: true } } } },
    { configuration: { agents: { defaults: { compaction: { memoryFlush: { enabled: true } } } } } },
    {
      configuration: {
        browser: { enabled: true, executablePath: "/home/node/workspace/browser" },
      },
    },
    {
      configuration: {
        browser: { enabled: false, profiles: { custom: { executablePath: "/workspace/browser" } } },
      },
    },
    {
      configuration: { channels: { signal: { transport: { cliPath: "/workspace/signal-cli" } } } },
    },
    {
      configuration: {
        channels: {
          signal: { accounts: { custom: { transport: { cliPath: "/workspace/signal-cli" } } } },
        },
      },
    },
    {
      configuration: {
        mcp: {
          apps: { enabled: true },
          servers: {
            workspace: { command: "node", args: ["/home/node/workspace/server.js"] },
          },
        },
      },
    },
    { configuration: { plugins: { load: { paths: ["/home/node/workspace/plugins"] } } } },
    {
      configuration: {
        plugins: {
          entries: {
            codex: {
              config: {
                appServer: { transport: "stdio", command: "/home/node/workspace/launcher" },
              },
            },
          },
        },
      },
    },
    {
      configuration: {
        plugins: { entries: { extension: { config: { helper: "/workspace/helper" } } } },
      },
    },
  ]) {
    const fixture = runtimeFixture(options);
    assert.equal(await fixture.context.prepareNativeGatewayStateRecovery(), true);
    assert.equal(fixture.context.runtimeGatewayState.recovery?.state, "manual");
    assert.equal(fixture.commands.length, 0, "unknown sources must precede Native CLI execution");
    assert.equal(fixture.writes.length, 0);
    fixture.context.readOpenClawConfig = () => ({});
    await fixture.context.observeNativeGatewayStateOwner();
    assert.equal(
      fixture.context.runtimeGatewayState.liveOwner,
      undefined,
      "same-process cleanup cannot restore trust",
    );
  }
});

test("metadata must cover enabled image sources before a new live owner is recorded", async () => {
  for (const options of [
    { inventory: { workspaceScope: "omitted" } },
    {
      inventory: {
        workspaceScope: "selected",
        workspaceDir: "/workspace",
        registry: { source: "derived", diagnostics: [] },
        diagnostics: [],
        plugins: [
          {
            id: "untrusted",
            enabled: true,
            status: "loaded",
            origin: "workspace",
            source: "/workspace/plugin/index.js",
            rootDir: "/workspace/plugin",
          },
        ],
      },
    },
    { imageWritable: true },
  ]) {
    const fixture = runtimeFixture(options);
    await fixture.context.observeNativeGatewayStateOwner();
    assert.equal(fixture.context.runtimeGatewayState.recovery.state, "manual");
    assert.equal(fixture.commands.length, 1);
    assert.equal(fixture.commands[0].args[1], "plugins");
    assert.equal(fixture.context.runtimeGatewayState.liveOwner, undefined);
  }
});

test("only the known fresh derived-registry information permits qualification", async () => {
  const missing = { level: "info", code: "persisted-registry-missing" };
  for (const registry of [
    { source: "derived", diagnostics: [{ level: "info", code: "unknown-information" }] },
    { source: "derived", diagnostics: [{ ...missing, level: "warn" }] },
    { source: "derived", diagnostics: [{ ...missing, level: "error" }] },
    { source: "derived", diagnostics: [missing, { level: "warn", code: "stale-index" }] },
    { source: "persisted", diagnostics: [missing] },
  ]) {
    const fixture = runtimeFixture();
    fixture.inventory.registry = registry;
    await fixture.context.observeNativeGatewayStateOwner();
    assert.equal(fixture.context.runtimeGatewayState.recovery.state, "manual");
    assert.equal(fixture.context.runtimeGatewayState.liveOwner, undefined);
  }
  const incomplete = runtimeFixture({ configuration: { plugins: { allow: ["codex"] } } });
  incomplete.inventory.plugins = [];
  await incomplete.context.observeNativeGatewayStateOwner();
  assert.equal(incomplete.context.runtimeGatewayState.recovery.state, "manual");
  const warning = runtimeFixture();
  warning.inventory.diagnostics = [{ level: "warn", code: "discovery-incomplete" }];
  await warning.context.observeNativeGatewayStateOwner();
  assert.equal(warning.context.runtimeGatewayState.recovery.state, "manual");
});

test("inventory has a separate finite output budget from native lock recovery", async () => {
  const inventory = runtimeFixture();
  // Native's actual enabled catalog exceeds 64 KiB even without custom plugins.
  // Description is an ordinary inventory field ignored by source authorization.
  inventory.inventory.plugins[0].description = "x".repeat(80 * 1024);
  await inventory.context.observeNativeGatewayStateOwner();
  assert.equal(inventory.context.runtimeGatewayState.liveOwner?.ownerId, owner.ownerId);
  assert.deepEqual(inventory.processGroups, []);

  const oversized = runtimeFixture();
  oversized.inventory.plugins[0].description = "x".repeat(256 * 1024);
  await oversized.context.observeNativeGatewayStateOwner();
  assert.equal(oversized.context.runtimeGatewayState.recovery.state, "manual");
  assert.equal(oversized.context.runtimeGatewayState.liveOwner, undefined);
  assert.deepEqual(oversized.processGroups, [[-4242, "SIGKILL"]]);

  const recovery = runtimeFixture({ hangCommand: true });
  const pending = recovery.context.nativeStateCommand(["gateway", "recover-lock", "--json"]);
  recovery.children[0].stdout.emit("data", Buffer.alloc(65537, " "));
  recovery.children[0].emit("close", 0);
  assert.equal(await pending, undefined);
  assert.deepEqual(recovery.processGroups, [[-4242, "SIGKILL"]]);
});

test("native inventory JSON preserves Unicode split across stdout chunks", async () => {
  const fixture = runtimeFixture({ hangCommand: true });
  fixture.inventory.plugins[0].description = "capability résumé";
  const bytes = Buffer.from(JSON.stringify(fixture.inventory));
  const split = bytes.indexOf(Buffer.from("é")) + 1;
  const pending = fixture.context.nativeStateCommand(["plugins", "list", "--enabled", "--json"]);
  fixture.children[0].stdout.emit("data", bytes.subarray(0, split));
  fixture.children[0].stdout.emit("data", bytes.subarray(split));
  fixture.children[0].emit("close", 0);
  assert.equal((await pending).plugins[0].description, "capability résumé");
});

test("default Codex configurations remain eligible after the OCE-generated overlay", async () => {
  const driver = new KubernetesComputeDriver(
    routedOptions({
      runtime: { transportSecretPrefix: "transport", gatewayStorageClassName: "local-path" },
    }),
  );
  for (const name of ["default-codex", "standard-codex"]) {
    const preset = JSON.parse(
      readFileSync(new URL(`../../deploy/presets/${name}.json`, import.meta.url), "utf8"),
    );
    const config = preset.template.configuration.values;
    assert.equal(nativeGatewayRecoveryConfigurationEligible(config), true, name);
    assert.equal(
      nativeGatewayRecoveryConfigurationEligible({ ...config, mcp: { apps: { enabled: true } } }),
      true,
      name,
    );
    const generated = codexOpenClawConfiguration(
      {
        "codex-plugin:linear@openai-curated-remote": { enabled: true },
      },
      [],
      { dedicatedCodex: true, pluginApprovers: [{ channel: "slack", id: "U123456" }] },
    );
    const codex = config.plugins.entries.codex.config;
    const additional = generated.plugins.entries.codex.config;
    Object.assign(config, { approvals: generated.approvals });
    Object.assign(codex, additional, {
      appServer: { ...codex.appServer, ...additional.appServer },
    });
    codex.codexDynamicToolsExclude = ["gateway_exec"];
    assert.equal(nativeGatewayRecoveryConfigurationEligible(config), true, name);
    // Routed Gateway publication also supplies the Compute-owned remote hook
    // callback. It does not load workspace hook code into the Gateway.
    const published = driver.gatewayNativeHookRelayConfiguration(
      routedRevision(driver, { configuration: config }),
      config,
    );
    assert.ok(published.plugins.entries.codex.config.appServer.nativeHookRelay);
    assert.equal(nativeGatewayRecoveryConfigurationEligible(published), true, name);
    const running = await runOpenClawRuntimeHelper(undefined, [], {
      baseConfig: published,
      workspaceNodeId: "a".repeat(64),
      env: { APP_SERVER_URL: "ws://harness.example.test:18790" },
    });
    const effective = JSON.parse(
      running.files.get("/home/node/.openclaw/openclaw.json") ??
        running.files.get("/etc/openclaw/openclaw.json"),
    );
    assert.equal(nativeGatewayRecoveryConfigurationEligible(effective), true, name);
    const fixture = runtimeFixture({
      configuration: effective,
      inventory: {
        workspaceScope: "selected",
        workspaceDir: "/home/node/workspace",
        registry: { source: "derived", diagnostics: [] },
        diagnostics: [],
        plugins: ["codex", "file-transfer"].map((id) => ({
          id,
          enabled: true,
          status: "loaded",
          origin: "bundled",
          source: `/app/dist/extensions/${id}/index.js`,
          rootDir: `/app/dist/extensions/${id}`,
        })),
      },
    });
    await fixture.context.observeNativeGatewayStateOwner();
    assert.equal(fixture.context.runtimeGatewayState.liveOwner?.ownerId, owner.ownerId, name);
    published.plugins.entries.codex.config.appServer.nativeHookRelay.command = "/workspace/helper";
    assert.equal(nativeGatewayRecoveryConfigurationEligible(published), false, name);
    codex.appServer.command = "/workspace/launcher";
    assert.equal(nativeGatewayRecoveryConfigurationEligible(config), false, name);
  }
});

test("health observations separate pending old-proof recovery from qualified live custody", () => {
  const base = {
    revisionId: binding.revisionId,
    container: "gateway",
    gatewayState: {
      toolBoundary: binding.toolBoundary,
      stateOrigin: binding.stateOrigin,
      storageId: binding.pvcUid,
      instanceId: binding.instanceId,
    },
  };
  for (const gatewayState of [
    { ...base.gatewayState, recovery: { state: "waiting", ownerRecords: records } },
    { ...base.gatewayState, recovery: { state: "manual" } },
    { ...base.gatewayState, sourceProtection: GATEWAY_RECOVERY_SOURCE_PROTECTION },
    {
      ...base.gatewayState,
      sourceProtection: GATEWAY_RECOVERY_SOURCE_PROTECTION,
      liveOwner: { ...owner, secret: "excluded-fixture-value" },
    },
  ]) {
    const input = { ...base, gatewayState, secret: "excluded-fixture-value" };
    const selected = parseNativeGatewayStateObservation(input);
    assert.ok(selected);
    assert.doesNotMatch(JSON.stringify(selected), /excluded-fixture-value/);
    const context = { input, selected: undefined };
    runInNewContext(
      `${NATIVE_GATEWAY_STATE_OBSERVATION_VALIDATORS}\nselected = parseNativeGatewayStateObservation(input);`,
      context,
    );
    assert.deepEqual(JSON.parse(JSON.stringify(context.selected)), selected);
  }
  for (const gatewayState of [
    { ...base.gatewayState, liveOwner: owner },
    { ...base.gatewayState, recovery: { state: "waiting", ownerRecords: [] } },
    {
      ...base.gatewayState,
      recovery: { state: "waiting", ownerRecords: [{ kind: "gateway-lease", owner: null }] },
    },
    { ...base.gatewayState, sourceProtection: "unknown/v2", liveOwner: owner },
  ]) {
    assert.equal(parseNativeGatewayStateObservation({ ...base, gatewayState }), undefined);
  }
});

test("default dedicated OC qualifies bundled file-transfer code while retaining workspace data paths", async () => {
  const config = JSON.parse(
    readFileSync(new URL("../../deploy/presets/standard-openclaw.json", import.meta.url), "utf8"),
  ).template.configuration.values;
  // Execute the existing production startup producer rather than copying its
  // worker profile, command grants and file-transfer configuration into the test.
  const deviceId = "a".repeat(64);
  const running = await runOpenClawRuntimeHelper(undefined, [], {
    baseConfig: config,
    workspaceNodeId: deviceId,
    env: {
      OPENCLAW_NATIVE_WORKER_PROFILE: "dedicated-native",
      OPENCLAW_WORKSPACE_NODE_ID: deviceId,
    },
  });
  const effective = JSON.parse(
    running.files.get("/home/node/.openclaw/openclaw.json") ??
      running.files.get("/etc/openclaw/openclaw.json"),
  );
  assert.equal(effective.cloudWorkers.requiredProfile, "dedicated-native");
  assert.equal(nativeGatewayRecoveryConfigurationEligible(effective), true);
  const fixture = runtimeFixture({
    configuration: effective,
    inventory: {
      workspaceScope: "selected",
      workspaceDir: "/home/node/workspace",
      registry: { source: "derived", diagnostics: [] },
      diagnostics: [],
      plugins: [
        {
          id: "file-transfer",
          enabled: true,
          status: "loaded",
          origin: "bundled",
          source: "/app/dist/extensions/file-transfer/index.js",
          rootDir: "/app/dist/extensions/file-transfer",
        },
      ],
    },
  });
  await fixture.context.observeNativeGatewayStateOwner();
  assert.equal(
    fixture.context.runtimeGatewayState.sourceProtection,
    GATEWAY_RECOVERY_SOURCE_PROTECTION,
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(fixture.context.runtimeGatewayState.liveOwner)),
    owner,
  );
});

test("an expired Native CLI command terminates its owned process group", async () => {
  const fixture = runtimeFixture({ hangCommand: true });
  const completion = fixture.context.nativeStateCommand(["gateway", "recover-lock", "--json"]);
  assert.equal(fixture.commands[0].options.detached, true);
  fixture.timers[0].callback();
  assert.deepEqual(fixture.processGroups, [[-4242, "SIGKILL"]]);
  fixture.children[0].emit("close", null);
  assert.equal(await completion, undefined);
  assert.equal(fixture.timers.length, 0);
});
