import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import { managedGoogleInstall } from "../../apps/controller/src/drivers/plugin/google-workspace/install.ts";
import {
  managedMcpInstalls,
  type ManagedCliInstall,
  type ManagedMcpInstall,
} from "../../apps/controller/src/drivers/plugin/managed-catalog.ts";
import {
  normalizeSecretBindings,
  type AgentRevision,
  type CredentialGatewayDriver,
  type HarnessWorkloadRequirements,
  type PluginDesiredSelection,
  type PluginDesiredState,
  type RevisionHarnessDescriptor,
  type SandboxDriver,
} from "../../packages/contracts/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import {
  runOpenClawRuntimeHelper,
  workspaceNodeBinding,
  WORKSPACE_NODE_BINDING_PATH,
} from "../helpers/plugin-runtime.mjs";
import {
  nativeHarnessResource,
  nativeSandboxIdentity,
  nativeSandboxRevision,
  type DedicatedDeployFixture,
} from "./kubernetes-dedicated-deploy-fixture.ts";
import {
  containerEnv,
  renderedRecord,
  templateContainer,
} from "./kubernetes-workspace-node-delivery-cases.ts";

type ManagedInstall = ManagedCliInstall | ManagedMcpInstall;
type CreateFixture = (options: {
  revision: Pick<AgentRevision, "sandboxDriverId" | "configuration" | "plugins"> & {
    // The fixture resolves Harness settings through Compute admission.
    harness: RevisionHarnessDescriptor;
  };
  credentialGatewayDriver: Pick<CredentialGatewayDriver, "id" | "capability" | "implementation">;
  sandboxDriver: ReturnType<typeof nativeSandboxIdentity> &
    Pick<SandboxDriver, "provisionHarness" | "workspaceNodePeerLabels">;
}) => DedicatedDeployFixture;

const [search, send] = ["slack_search_public", "slack_send_message"] as const;

function releaseSettings(install: ManagedInstall) {
  const { kind, packageName } = install;
  const slotId = install.kind === "mcp" ? install.slotId : Object.keys(install.credentials)[0];
  assert.ok(slotId, "expected a credential slot in the reviewed release");
  return { kind, packageName, slotId };
}

export async function checkManagedReleaseDelivery(createFixture: CreateFixture) {
  for (const enabled of [true, false]) {
    await checkSelection(createFixture, managedGoogleInstall, { enabled });
  }
  for (const install of managedMcpInstalls) {
    for (const enabled of [true, false]) {
      await checkSelection(createFixture, install, { enabled });
    }

    // No tools and no tool selection are distinct inputs to the mounted manifest.
    const tools = [search, send];
    const binding = {
      releaseSha256: install.releaseSha256,
      credentials: { [install.slotId]: "cs_test_account" },
    };
    for (const toolNames of [tools, [], undefined]) {
      const driverPolicy = toolNames === undefined ? binding : { ...binding, toolNames };
      await checkSelection(createFixture, install, { enabled: true, driverPolicy }, toolNames);
    }
    await checkSelection(
      createFixture,
      install,
      {
        enabled: true,
        driverPolicy: { ...binding, toolNames: tools },
        tools: { [send]: { approval: "all_actions" } },
      },
      tools,
    );
  }
}

async function checkSelection(
  createFixture: CreateFixture,
  install: ManagedInstall,
  selection: PluginDesiredSelection,
  toolNames?: readonly string[],
) {
  const includesGoogle = install.kind === "mcp";
  const selections: PluginDesiredState = {
    ...(includesGoogle && { [managedGoogleInstall.id]: { enabled: true } }),
    [install.id]: selection,
  };
  let worker: HarnessWorkloadRequirements | undefined;
  const identity = nativeSandboxIdentity();
  const fixture = createFixture({
    sandboxDriver: {
      ...identity,
      async workspaceNodePeerLabels() {
        return undefined;
      },
      async provisionHarness(context) {
        worker = context.requirements;
        return nativeHarnessResource(context);
      },
    },
    credentialGatewayDriver: {
      id: "openshell-credentials",
      implementation: "openshell",
      capability: "credential_gateway",
    },
    revision: {
      ...nativeSandboxRevision(identity.id),
      plugins: {
        driver: { id: "occ-plugin", implementation: "occ/openclaw-plugin" },
        plugins: selections,
      },
    },
  });
  await fixture.prepare();
  fixture.markReady(fixture.gatewayName);
  await fixture.prepare();
  assert.ok(worker, "expected the Sandbox to receive Harness requirements");
  assert.deepEqual(worker.files, []);

  // The worker receives only enabled packages. IDs and approvals belong to the Gateway.
  const google = {
    ...releaseSettings(managedGoogleInstall),
    releaseSha256: managedGoogleInstall.releaseSha256,
  };
  const current = {
    ...releaseSettings(install),
    ...(selection.enabled && { releaseSha256: install.releaseSha256 }),
    ...(toolNames?.length && { toolNames }),
  };
  const workerSettings = worker.environment.find(
    ({ name }) => name === "OPENCLAW_MANAGED_PLUGIN_JSON",
  );
  const encoded = workerSettings && "value" in workerSettings ? workerSettings.value : undefined;
  assert.deepEqual(JSON.parse(encoded ?? "[]"), [
    ...(includesGoogle ? [google] : []),
    ...(selection.enabled ? [current] : []),
  ]);

  const deployment = fixture.read("Deployment", fixture.gatewayName);
  const { pod, container } = templateContainer(
    renderedRecord(deployment.spec, "Gateway spec").template,
  );
  const gatewayEnv = containerEnv(container);
  const managed = gatewayEnv.find(({ name }) => name === "OPENCLAW_MANAGED_PLUGIN_JSON")?.value;
  assert.ok(typeof managed === "string", "expected managed Gateway settings");
  const expected = [
    ...(includesGoogle ? [{ id: managedGoogleInstall.id, ...google }] : []),
    { id: install.id, ...current, ...(selection.tools && { approvalToolNames: [send] }) },
  ];
  assert.deepEqual(JSON.parse(managed), expected);
  // An Agent editor cannot replace deployment inputs with Secret bindings.
  for (const { name } of gatewayEnv) {
    if (typeof name === "string" && name.startsWith("OPENCLAW_MANAGED_")) {
      assert.throws(
        () =>
          normalizeSecretBindings({
            [name]: { source: { kind: "secret", namespaceId: "ns", id: "secret" } },
          }),
        { destinationRule: "reserved_prefix" },
      );
    }
  }

  const [mountedPath, manifest] = mountedRuntime(fixture, pod, container);
  const manifestPath = gatewayEnv.find(
    ({ name }) => name === "OPENCLAW_PLUGIN_RUNTIME_MANIFEST",
  )?.value;
  assert.equal(manifestPath, mountedPath);
  assert.deepEqual(renderedRecord(JSON.parse(manifest), "runtime manifest").selections, selections);
  if (selection.tools) {
    await checkApprovalLauncher([managedGoogleInstall, install], [mountedPath, manifest], {
      OPENCLAW_MANAGED_PLUGIN_JSON: managed,
      OPENCLAW_PLUGIN_RUNTIME_MANIFEST: manifestPath,
    });
  }
}

function mountedRuntime(
  fixture: DedicatedDeployFixture,
  pod: Record<string, unknown>,
  container: Record<string, unknown>,
): [string, string] {
  const volumeName = "openclaw-plugin-runtime";
  assert.ok(Array.isArray(pod.volumes));
  const volume = pod.volumes.find((item: unknown) => asRecord(item)?.name === volumeName);
  const configMap = renderedRecord(asRecord(volume)?.configMap, "runtime ConfigMap volume");
  assert.ok(typeof configMap.name === "string");
  assert.ok(Array.isArray(configMap.items));
  const item = asRecord(
    configMap.items.find((entry: unknown) => asRecord(entry)?.key === "runtime.json"),
  );
  assert.ok(typeof item?.path === "string", "expected runtime.json in the ConfigMap projection");

  assert.ok(Array.isArray(container.volumeMounts));
  const mount = asRecord(
    container.volumeMounts.find((entry: unknown) => asRecord(entry)?.name === volumeName),
  );
  assert.ok(typeof mount?.mountPath === "string", "expected a runtime volume mount on the Gateway");
  assert.equal(mount.readOnly, true);
  assert.equal(mount.subPath, undefined);
  const { data } = fixture.read("ConfigMap", configMap.name);
  const manifest = asRecord(data)?.["runtime.json"];
  assert.ok(typeof manifest === "string");
  return [posix.join(mount.mountPath, item.path), manifest];
}

const policy = "oce-managed-mcp-policy";
const policyRoot = "/usr/local/lib/oce/platform-plugins/" + policy;

function launchedConfiguration(files: ReadonlyMap<string, unknown>) {
  const raw = files.get("/home/node/.openclaw/openclaw.json");
  assert.ok(typeof raw === "string", "expected the launcher to write the OpenClaw configuration");
  return renderedRecord(JSON.parse(raw), "launched configuration");
}

function policyConfiguration(config: Record<string, unknown>) {
  const plugins = asRecord(config.plugins);
  const entries = renderedRecord(plugins?.entries, "launched plugin entries");
  return renderedRecord(entries[policy], "installed managed MCP policy").config;
}

async function checkApprovalLauncher(
  installs: readonly ManagedInstall[],
  mountedManifest: [string, string],
  env: Record<string, string>,
) {
  // Only the image files are staged here. Compute supplied the mount and both environment values.
  const files = [mountedManifest];
  for (const install of installs) {
    const root = "/usr/local/lib/oce/plugin-catalog/" + install.packageName + "/";
    const paths = ["ai.openclaw.oce/release.json"];
    if (install.kind === "cli") {
      paths.push("skills/" + install.skill + "/SKILL.md");
    }
    for (const path of paths) {
      files.push([root + path, await readFile(new URL(path, install.directory), "utf8")]);
    }
  }
  for (const name of ["openclaw.plugin.json", "package.json", "index.mjs"]) {
    const url = new URL(`../../deploy/runtime/managed-mcp-policy/${name}`, import.meta.url);
    files.push([policyRoot + "/" + name, await readFile(url, "utf8")]);
  }

  const launched = await runOpenClawRuntimeHelper(undefined, [], {
    workspaceNodeId: "native-worker",
    baseConfig: {
      gateway: { port: 8080 },
      plugins: { allow: [] },
      approvals: { plugin: { slack: { plugins: { dormant: { approvers: [] } } } } },
    },
    files,
    env,
  });
  const servers = { oce_mcp_slack: { [search]: "allow", [send]: "ask" } };
  const config = launchedConfiguration(launched.files);
  assert.deepEqual(policyConfiguration(config), { servers, nodeId: "native-worker" });
  assert.partialDeepStrictEqual(config, {
    plugins: {
      entries: { [policy]: { enabled: true } },
      load: { paths: [policyRoot] },
      allow: [policy],
    },
    gateway: { nodes: { commands: { allow: ["mcp.tools.call.v1"] } } },
  });
  assert.partialDeepStrictEqual(config, { plugins: { allow: ["file-transfer"] } });

  // On first deployment the node pairs later. Hot binding must preserve both tool decisions.
  const intervals: { ms: number; callback: () => unknown }[] = [];
  const staged = await runOpenClawRuntimeHelper(undefined, [], {
    workspaceNodeBindingPath: true,
    files,
    env,
    intervals,
    setTimeout: () => ({ unref() {} }),
    gatewayCall: (method: string) =>
      method === "plugins.list"
        ? { generation: 1, plugins: [{ id: "file-transfer", runtime: { state: "disabled" } }] }
        : undefined,
  });
  assert.deepEqual(policyConfiguration(launchedConfiguration(staged.files)), { servers });
  staged.files.set(WORKSPACE_NODE_BINDING_PATH, workspaceNodeBinding("paired-node"));
  const poll = intervals.find(({ ms }) => ms === 1000);
  assert.ok(poll, "expected the workspace node binding poll");
  await poll.callback();
  assert.deepEqual(policyConfiguration(launchedConfiguration(staged.files)), {
    servers,
    nodeId: "paired-node",
  });

  const missingCalls: { args?: string[] }[] = [];
  await assert.rejects(
    async () =>
      runOpenClawRuntimeHelper(undefined, [], {
        workspaceNodeId: "native-worker",
        files: files.filter(([path]) => path !== policyRoot + "/index.mjs"),
        env,
        calls: missingCalls,
      }),
    /managed MCP approval policy is missing/,
  );
  assert.ok(!missingCalls.some(({ args }) => args?.[1] === "gateway"));

  const conflictCalls: { args?: string[] }[] = [];
  await assert.rejects(
    async () =>
      runOpenClawRuntimeHelper(undefined, [], {
        workspaceNodeId: "native-worker",
        baseConfig: {
          gateway: { port: 8080 },
          channels: { slack: { enabled: true } },
          approvals: { plugin: { slack: { plugins: { another: { approvers: [] } } } } },
        },
        files,
        env,
        calls: conflictCalls,
      }),
    /native Slack per-plugin approver overrides/,
  );
  assert.ok(!conflictCalls.some(({ args }) => args?.[1] === "gateway"));
}
