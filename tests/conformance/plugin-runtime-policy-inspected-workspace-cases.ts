import assert from "node:assert/strict";
import test from "node:test";

import { gatewayRuntimeEntrypoint } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { WORKSPACE_NODE_BINDING_PATH, workspaceNodeBinding } from "../helpers/plugin-runtime.mjs";
import {
  codexGatewayConfig,
  field,
  launchGateway,
  nativeGatewaySpawns,
  parseJson,
  stringList,
  readConfig,
  record,
  type GatewayOptions,
} from "./plugin-runtime-policy-fixture.ts";

const configPath = "/home/node/.openclaw/openclaw.json";
const enrolled = "1".repeat(64);
const replacement = "2".repeat(64);
const root = "/sandbox/workspace";
const profile = {
  kind: "inspected-dedicated-codex",
  revisionId: "revision-1",
  bindingPath: WORKSPACE_NODE_BINDING_PATH,
} as const;

const managedConfig = () => codexGatewayConfig().config;

function transferConfig(config: ReturnType<typeof managedConfig>, fileConfig: unknown) {
  record(record(config.plugins).entries)["file-transfer"] = { enabled: true, config: fileConfig };
  return config;
}

function transferPolicy(config: unknown) {
  return record(field(config, "plugins", "entries", "file-transfer", "config"));
}

function launchSelected(options: GatewayOptions = {}, useProfile = true) {
  return launchGateway(undefined, [], {
    baseConfig: managedConfig(),
    workspaceNodeBindingPath: true,
    ...options,
    env: {
      APP_SERVER_URL: "ws://harness.example.test:18790",
      OPENCLAW_REMOTE_WORKSPACE_ROOT: root,
      ...options.env,
    },
    gatewayEntrypoint: gatewayRuntimeEntrypoint(true, useProfile ? profile : undefined),
    setTimeout: () => ({ unref() {} }),
  });
}

export function registerInspectedWorkspaceCases() {
  test("inspected workspace starts for ordinary setup then selects the exact revision-owned node", async () => {
    const intervals: NonNullable<GatewayOptions["intervals"]> = [];
    const kills: NonNullable<GatewayOptions["kills"]> = [];
    let active = false;
    const { files, calls } = await launchSelected({
      intervals,
      kills,
      gatewayCall: (method) => {
        assert.equal(method, "plugins.list");
        return {
          generation: active ? 2 : 1,
          plugins: [{ id: "file-transfer", runtime: { state: active ? "active" : "disabled" } }],
        };
      },
    });
    const before = readConfig(files, configPath);
    assert.deepEqual(field(before, "gateway", "nodes", "pairing"), {
      autoApproveLocal: false,
      sshVerify: false,
    });
    const gatewayBefore = JSON.stringify(before.gateway);
    const allowed = stringList(field(before, "gateway", "nodes", "commands", "allow"));
    assert.ok(allowed.includes("dir.list"));
    assert.ok(allowed.includes("file.fetch"));
    assert.ok(!allowed.includes("dir.fetch"));
    assert.equal(field(before, "plugins", "entries", "file-transfer"), undefined);
    assert.equal(nativeGatewaySpawns(calls).length, 1);
    assert.equal(nativeGatewaySpawns(calls)[0]?.options?.env?.OPENCLAW_CONFIG_READONLY, "1");
    const poll = intervals.find(({ ms }) => ms === 1000);
    assert.ok(poll);

    for (const binding of [
      workspaceNodeBinding(enrolled, "foreign-revision"),
      workspaceNodeBinding("not-a-device-digest"),
      workspaceNodeBinding("*"),
    ]) {
      files.set(WORKSPACE_NODE_BINDING_PATH, binding);
      await poll.callback();
      assert.equal(files.get(configPath), JSON.stringify(before));
    }
    assert.equal(calls.filter(({ method }) => method === "plugins.list").length, 0);

    files.set(WORKSPACE_NODE_BINDING_PATH, workspaceNodeBinding(enrolled));
    await poll.callback();
    const enrolledConfig = readConfig(files, configPath);
    const fileConfig = transferPolicy(enrolledConfig);
    assert.deepEqual(fileConfig.workspaces, {
      main: { nodeId: enrolled, remoteRoot: root },
    });
    assert.deepEqual(Object.keys(record(fileConfig.nodes)), [enrolled]);
    assert.equal(field(fileConfig, "nodes", enrolled, "boundedReplies"), true);
    assert.equal(JSON.stringify(enrolledConfig.gateway), gatewayBefore);
    active = true;
    await poll.callback();
    const statusCalls = calls.filter(({ method }) => method === "plugins.list").length;
    assert.equal(statusCalls, 2);
    await poll.callback();
    assert.equal(calls.filter(({ method }) => method === "plugins.list").length, statusCalls);

    files.set(WORKSPACE_NODE_BINDING_PATH, workspaceNodeBinding(replacement));
    await poll.callback();
    assert.deepEqual(kills, [{ signal: "SIGTERM" }]);
    assert.equal(files.get(configPath), JSON.stringify(enrolledConfig));
    const fresh = await launchSelected({ workspaceNodeId: replacement });
    const freshPolicy = transferPolicy(readConfig(fresh.files, configPath));
    assert.deepEqual(Object.keys(record(freshPolicy.nodes)), [replacement]);
    assert.equal(field(freshPolicy, "nodes", replacement, "boundedReplies"), true);
  });

  test("inspected workspace preserves existing exact path and approval rights", async () => {
    const exact = {
      ask: "always",
      followSymlinks: false,
      maxBytes: 768,
      allowReadPaths: [root + "/AGENTS.md"],
      allowWritePaths: [],
      denyPaths: [root + "/.git/**"],
    };
    const other = { ask: "off", allowReadPaths: ["/other"] };
    const fileConfig = {
      policyVersion: 2,
      nodes: { [enrolled]: exact, [replacement]: other },
      literalGrants: [
        {
          nodeId: enrolled,
          command: "file.stat",
          requestedPath: root,
          canonicalPath: root,
        },
      ],
      pendingReapprovals: [{ selector: enrolled, kind: "read", path: root + "/README.md" }],
      workspaces: { main: { nodeId: enrolled, remoteRoot: root } },
    };
    const explicitPairing = { autoApproveLocal: false, sshVerify: false, autoApproveCidrs: [] };
    const authored = managedConfig();
    const baseConfig = {
      ...authored,
      gateway: {
        ...authored.gateway,
        nodes: { ...authored.gateway.nodes, pairing: explicitPairing },
      },
    };
    const { files } = await launchSelected({
      baseConfig: transferConfig(baseConfig, fileConfig),
      workspaceNodeId: enrolled,
    });
    assert.deepEqual(
      field(readConfig(files, configPath), "gateway", "nodes", "pairing"),
      explicitPairing,
    );
    const effective = transferPolicy(readConfig(files, configPath));
    assert.deepEqual(effective, {
      ...fileConfig,
      nodes: { [enrolled]: { ...exact, boundedReplies: true }, [replacement]: other },
    });
    // Recreating the native process with the same owned binding rebuilds the
    // same effective ACL from the admitted configuration.
    const recovered = await launchSelected({
      baseConfig: transferConfig(managedConfig(), fileConfig),
      workspaceNodeId: enrolled,
    });
    assert.deepEqual(transferPolicy(readConfig(recovered.files, configPath)), effective);
  });

  test("inspected workspace refuses preexisting policies it cannot preserve", async () => {
    const cases = [
      ["wildcard", { policyVersion: 2, nodes: { "*": { ask: "off" } } }],
      [
        "display-name fallback",
        { policyVersion: 2, nodes: { "Workspace Node": { ask: "always" } } },
      ],
      ["empty explicit map", { policyVersion: 2, nodes: {} }],
      ["standing grants without the exact policy", { policyVersion: 2, literalGrants: [] }],
      [
        "foreign profile",
        { policyVersion: 2, nodes: { [enrolled]: {}, [replacement]: { boundedReplies: true } } },
      ],
      [
        "exact explicit false",
        { policyVersion: 2, nodes: { [enrolled]: { boundedReplies: false } } },
      ],
      [
        "different workspace node",
        { policyVersion: 2, workspaces: { main: { nodeId: replacement, remoteRoot: root } } },
      ],
      [
        "different workspace root",
        { policyVersion: 2, workspaces: { main: { nodeId: enrolled, remoteRoot: "/other" } } },
      ],
      ["unreviewed legacy rights", { nodes: { [enrolled]: { allowReadPaths: [root] } } }],
    ] as const;
    for (const [name, fileConfig] of cases) {
      const calls: NonNullable<GatewayOptions["calls"]> = [];
      await assert.rejects(
        launchSelected({
          baseConfig: transferConfig(managedConfig(), fileConfig),
          workspaceNodeId: enrolled,
          calls,
        }),
        /exact File Transfer node policy|no exact File Transfer policy|conflicts with the enrolled|Review existing File Transfer approvals/,
        name,
      );
      assert.equal(nativeGatewaySpawns(calls).length, 0, name);
    }
  });

  test("inspected workspace refuses implicit pairing and unowned launch inputs", async () => {
    for (const pairing of [
      { autoApproveLocal: true },
      { autoApproveCidrs: ["192.0.2.31/32"] },
      { sshVerify: true },
      { sshVerify: { cidrs: ["192.0.2.31/32"] } },
    ]) {
      const baseConfig = { ...managedConfig(), gateway: { nodes: { pairing } } };
      const calls: NonNullable<GatewayOptions["calls"]> = [];
      await assert.rejects(launchSelected({ baseConfig, calls }), /requires explicit approval/);
      assert.equal(nativeGatewaySpawns(calls).length, 0);
    }
    for (const env of [
      { OPENCLAW_WORKSPACE_NODE_ID: enrolled },
      { OPENCLAW_WORKSPACE_NODE_PATH: "/tmp/unowned-workspace-binding.json" },
      { OPENCLAW_AGENT_REVISION_ID: "foreign-revision" },
      { OPENCLAW_NATIVE_WORKER_PROFILE: "other-profile" },
      { OPENCLAW_CONFIG_PATH: configPath },
      { OPENCLAW_CONFIG_PATH: "/tmp/unowned-openclaw.json" },
      { APP_SERVER_URL: "" },
    ]) {
      const calls: NonNullable<GatewayOptions["calls"]> = [];
      await assert.rejects(launchSelected({ env, calls }), /revision-owned node binding/);
      assert.equal(nativeGatewaySpawns(calls).length, 0);
    }
  });

  test("inspected workspace refuses existing rights before a binding and hot application preserves a conflicting file", async () => {
    const intervals: NonNullable<GatewayOptions["intervals"]> = [];
    const diagnostics: Record<string, unknown>[] = [];
    const existing = {
      policyVersion: 2,
      nodes: { "Workspace Node": { ask: "always", allowReadPaths: [root] } },
    };
    const calls: NonNullable<GatewayOptions["calls"]> = [];
    await assert.rejects(
      launchSelected({ baseConfig: transferConfig(managedConfig(), existing), calls }),
      /require the enrolled inspected node binding before startup/,
    );
    assert.equal(nativeGatewaySpawns(calls).length, 0);

    const { files } = await launchSelected({
      intervals,
      gatewayCall: () => ({
        generation: 1,
        plugins: [{ id: "file-transfer", runtime: { state: "active" } }],
      }),
      console: {
        error: (line) => {
          diagnostics.push(record(parseJson(line)));
        },
      },
    });
    // Supply a conflicting config file at the hot-application boundary.
    const configured = readConfig(files, configPath);
    record(field(configured, "plugins", "entries"))["file-transfer"] = {
      enabled: true,
      config: existing,
    };
    const before = JSON.stringify(configured);
    files.set(configPath, before);
    const poll = intervals.find(({ ms }) => ms === 1000);
    assert.ok(poll);
    files.set(WORKSPACE_NODE_BINDING_PATH, workspaceNodeBinding(enrolled));
    await poll.callback();
    assert.equal(files.get(configPath), before);
    assert.ok(diagnostics.some(({ code }) => code === "FILE_TRANSFER_DENIED"));
  });

  test("inspected workspace settings stay absent without the private launch profile", async () => {
    const baseConfig = {
      ...managedConfig(),
      gateway: { nodes: { pairing: { autoApproveLocal: true } } },
    };
    const { files } = await launchSelected(
      {
        baseConfig,
        workspaceNodeId: enrolled,
        env: { OPENCLAW_WORKSPACE_NODE_PROFILE: profile.kind },
      },
      false,
    );
    const config = readConfig(files, configPath);
    assert.deepEqual(field(config, "gateway", "nodes", "pairing"), { autoApproveLocal: true });
    assert.equal(field(transferPolicy(config), "nodes", enrolled, "boundedReplies"), undefined);
  });
}
