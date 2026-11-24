import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, matchesGlob } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInContext } from "node:vm";

import { gatewayRuntimeEntrypoint } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { workspaceNodeNetworkPolicy } from "../../apps/controller/src/drivers/sandbox/openshell-workspace-node-policy.ts";
import {
  admitsInspectedOpenClawWorkspace,
  inspectedWorkspaceBuild,
} from "../../apps/controller/src/drivers/sandbox/inspected-workspace-release.ts";
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
  type RuntimeSandbox,
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

const statusOwner = {
  OPENCLAW_RUNTIME_STATUS_CONTAINER: "gateway",
  OPENCLAW_POD_UID: "gateway-pod",
};

function acknowledgedNode(sandbox: RuntimeSandbox) {
  return field(runInContext("runtimeStatusReport()", sandbox), "workspaceNodeId");
}

export function registerInspectedWorkspaceCases() {
  test("Dedicated OpenClaw inspected placement requires a qualified immutable Gateway image and scopes node traffic", (t) => {
    const gateway = "registry.example.test/gateway@sha256:" + "a".repeat(64);
    const agent = "registry.example.test/codex@sha256:" + "b".repeat(64);
    const revision = { namespaceId: "ns_123", agentId: "agt_456", gatewayManagedMode: true };
    const path = `/namespaces/${revision.namespaceId}/agents/${revision.agentId}/node`;
    const url = `wss://gateway.example.test${path}`;
    assert.equal(admitsInspectedOpenClawWorkspace({ gateway, agent }, revision, url), false);
    t.mock.getter(inspectedWorkspaceBuild, "openClawRelease", () => ({
      gatewayDigest: "sha256:" + "a".repeat(64),
    }));
    assert.equal(admitsInspectedOpenClawWorkspace({ gateway, agent }, revision, url), true);
    assert.equal(admitsInspectedOpenClawWorkspace({ gateway: agent, agent }, revision, url), false);
    assert.equal(
      admitsInspectedOpenClawWorkspace({ gateway, agent }, revision, url + "/other"),
      false,
    );
    const policy = record(
      workspaceNodeNetworkPolicy({
        host: "gateway.example.test",
        port: 443,
        path,
        tls: true,
        inspected: true,
        nativeWorker: true,
      })["workspace-node-enrollment"],
    );
    assert.deepEqual(policy.binaries, [{ path: "/usr/local/bin/node" }]);
    const endpoints = policy.endpoints;
    assert.ok(Array.isArray(endpoints));
    for (const endpoint of endpoints) {
      const admitted = record(endpoint);
      assert.equal(admitted.host, "gateway.example.test");
      assert.deepEqual(admitted.ports, [443]);
      assert.equal(admitted.enforcement, "NETWORK_ENFORCEMENT_MODE_ENFORCE");
      assert.ok(typeof admitted.path === "string" && admitted.path.startsWith(path));
      assert.equal(admitted.credential_binding, undefined);
      assert.equal(admitted.path.includes("native-hook"), false);
    }
    // Probe concrete Worker requests against the generated policy. This is a policy-shape
    // check, not an assertion that an OpenShell runtime has enforced the policy.
    const matches = (pattern: unknown, requestPath: string) =>
      typeof pattern === "string" && matchesGlob(requestPath, pattern);
    const permits = (protocol: string, method: string, requestPath: string) =>
      endpoints.some((item) => {
        const endpoint = record(item);
        if (endpoint.protocol !== protocol || !matches(endpoint.path, requestPath)) {return false;}
        const denied =
          Array.isArray(endpoint.deny_rules) &&
          endpoint.deny_rules.some((item) => {
            const rule = record(item);
            return rule.method === method && matches(rule.path, requestPath);
          });
        return (
          !denied &&
          Array.isArray(endpoint.rules) &&
          endpoint.rules.some((item) => {
            const allow = record(record(item).allow);
            return allow.method === method && matches(allow.path, requestPath);
          })
        );
      });
    const digest = "a".repeat(64);
    const worker = `${path}/__openclaw__/worker`;
    const bundle = `${path}/__openclaw__/worker-bundle/v1/bundles/${digest}`;
    const transfer = `${path}/__openclaw__/worker-transfer/v1/environments/env_123`;
    for (const [protocol, method, requestPath] of [
      ["websocket", "GET", worker],
      ["websocket", "WEBSOCKET_TEXT", worker],
      ["rest", "GET", bundle],
      ["rest", "GET", `${transfer}/snapshots/${digest}/manifest`],
      ["rest", "GET", `${transfer}/snapshots/${digest}/pack`],
      ["rest", "GET", `${transfer}/blobs/${digest}`],
      ["rest", "POST", `${transfer}/reconciliations/${digest}`],
    ] as const) {
      assert.equal(permits(protocol, method, requestPath), true, `${method} ${requestPath}`);
    }
    for (const [protocol, method, requestPath] of [
      ["websocket", "HEAD", worker],
      ["rest", "POST", bundle],
      ["rest", "GET", `${transfer}/reconciliations/${digest}`],
      ["rest", "GET", `${transfer}/blobs/${digest}/extra`],
      ["rest", "GET", `${transfer}/nested/blobs/${digest}`],
      ["rest", "GET", bundle.replace("agt_456", "agt_foreign")],
      ["rest", "POST", `${path}/__openclaw__/native-hook/codex-${"a".repeat(40)}`],
    ] as const) {
      assert.equal(permits(protocol, method, requestPath), false, `${method} ${requestPath}`);
    }
  });

  test("inspected Dedicated OpenClaw uses the enrolled native worker and exact bounded reply policy", async () => {
    const entrypoint = gatewayRuntimeEntrypoint(true, {
      kind: "inspected-dedicated-openclaw",
      revisionId: "revision-1",
    });
    const env = {
      OPENCLAW_AGENT_REVISION_ID: "revision-1",
      OPENCLAW_NATIVE_WORKER_PROFILE: "dedicated-native",
      OPENCLAW_WORKSPACE_NODE_ID: enrolled,
    };
    const baseConfig = {
      gateway: { port: 8080 },
      agents: { defaults: { workspace: root } },
      plugins: { entries: {} },
    };
    const { files, calls } = await launchGateway(undefined, [], {
      baseConfig,
      env,
      gatewayEntrypoint: entrypoint,
    });
    const config = readConfig(files, configPath);
    assert.equal(field(config, "cloudWorkers", "requiredProfile"), "dedicated-native");
    assert.equal(
      field(config, "cloudWorkers", "profiles", "dedicated-native", "settings", "device"),
      enrolled,
    );
    assert.equal(field(transferPolicy(config), "nodes", enrolled, "boundedReplies"), true);
    assert.equal(field(transferPolicy(config), "workspaces", "main", "nodeId"), enrolled);
    assert.equal(nativeGatewaySpawns(calls).length, 1);
    for (const extra of [
      { OPENCLAW_WORKSPACE_NODE_PATH: WORKSPACE_NODE_BINDING_PATH },
      { OPENCLAW_AGENT_REVISION_ID: "foreign" },
      { APP_SERVER_URL: "ws://other.example.test" },
      { OPENCLAW_NATIVE_WORKER_PROFILE: "other-profile" },
      { OPENCLAW_WORKSPACE_NODE_ID: "not-a-device" },
    ]) {
      await assert.rejects(
        launchGateway(undefined, [], {
          baseConfig,
          env: { ...env, ...extra },
          gatewayEntrypoint: entrypoint,
        }),
        /revision-owned node binding/,
      );
    }
  });

  test("controller builds pin a complete inspected Workspace image digest pair", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "inspected-workspace-image-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const pinPath = "apps/controller/src/drivers/sandbox/inspected-workspace-release.ts";
    const target = join(directory, pinPath);
    const source = await readFile(new URL(`../../${pinPath}`, import.meta.url), "utf8");
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, source);
    const render = (gateway: string, agent: string) =>
      spawnSync(
        process.execPath,
        [
          fileURLToPath(
            new URL("../../scripts/write-inspected-workspace-image-pin.ts", import.meta.url),
          ),
          gateway,
          agent,
        ],
        { cwd: directory, encoding: "utf8" },
      );

    const gateway = `sha256:${enrolled}`;
    const agent = `sha256:${replacement}`;
    assert.equal(render("", "").status, 0);
    assert.equal(await readFile(target, "utf8"), source);
    for (const [gatewayInput, agentInput] of [
      [gateway, ""],
      ["runtime:tag", agent],
    ] as const) {
      const refused = render(gatewayInput, agentInput);
      assert.equal(refused.status, 1, refused.stderr);
      assert.match(refused.stderr, /exact Gateway and Agent image manifest digests/u);
      assert.equal(await readFile(target, "utf8"), source);
    }

    const pinned = render(gateway, agent);
    assert.equal(pinned.status, 0, pinned.stderr);
    const content = await readFile(target, "utf8");
    assert.ok(content.includes(`gatewayDigest: "${gateway}"`));
    assert.ok(content.includes(`agentDigest: "${agent}"`));
    assert.match(content, /const pin: InspectedWorkspaceRelease \| undefined = Object.freeze/u);
    assert.equal(await readFile(new URL(`../../${pinPath}`, import.meta.url), "utf8"), source);
  });

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

  for (const [cause, invalidBinding] of [
    ["deleted", undefined],
    ["malformed", "{"],
    ["from another revision", workspaceNodeBinding(enrolled, "foreign-revision")],
  ] as const) {
    test(`inspected workspace retires an acknowledged binding that is ${cause}`, async () => {
      const intervals: NonNullable<GatewayOptions["intervals"]> = [];
      const kills: NonNullable<GatewayOptions["kills"]> = [];
      const gatewayCall = () => ({
        generation: 2,
        plugins: [{ id: "file-transfer", runtime: { state: "active" } }],
      });
      const { files, sandbox } = await launchSelected({
        workspaceNodeId: enrolled,
        env: statusOwner,
        intervals,
        kills,
        gatewayCall,
      });
      const poll = intervals.find(({ ms }) => ms === 1000);
      assert.ok(poll);
      await poll.callback();
      assert.equal(acknowledgedNode(sandbox), enrolled);
      assert.deepEqual(Object.keys(record(transferPolicy(readConfig(files, configPath)).nodes)), [
        enrolled,
      ]);

      if (invalidBinding === undefined) {
        files.delete(WORKSPACE_NODE_BINDING_PATH);
      } else {
        files.set(WORKSPACE_NODE_BINDING_PATH, invalidBinding);
        await poll.callback();
      }
      // The status reader itself must not serve an old ack between polls.
      assert.equal(acknowledgedNode(sandbox), undefined);
      assert.deepEqual(kills, [{ signal: "SIGTERM" }]);

      // A clean restart uses the admitted configuration, even if the prior output still exists.
      const freshIntervals: NonNullable<GatewayOptions["intervals"]> = [];
      const fresh = await launchSelected({
        files: [...files],
        workspaceNodeId: replacement,
        env: statusOwner,
        intervals: freshIntervals,
        gatewayCall,
      });
      const freshPoll = freshIntervals.find(({ ms }) => ms === 1000);
      assert.ok(freshPoll);
      await freshPoll.callback();
      const policy = transferPolicy(readConfig(fresh.files, configPath));
      assert.deepEqual(Object.keys(record(policy.nodes)), [replacement]);
      assert.equal(field(policy, "workspaces", "main", "nodeId"), replacement);
      assert.equal(acknowledgedNode(fresh.sandbox), replacement);
    });
  }

  test("inspected workspace rejects a plugin result after its binding disappears", async () => {
    const intervals: NonNullable<GatewayOptions["intervals"]> = [];
    const kills: NonNullable<GatewayOptions["kills"]> = [];
    const { files, sandbox } = await launchSelected({
      workspaceNodeId: enrolled,
      env: statusOwner,
      intervals,
      kills,
      gatewayCall: () => {
        files.delete(WORKSPACE_NODE_BINDING_PATH);
        return { plugins: [{ id: "file-transfer", runtime: { state: "active" } }] };
      },
    });
    const poll = intervals.find(({ ms }) => ms === 1000);
    assert.ok(poll);
    await poll.callback();
    assert.deepEqual(kills, [{ signal: "SIGTERM" }]);
    assert.equal(acknowledgedNode(sandbox), undefined);
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
