import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { OpenShellSandboxExecRequest } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import type { AgentRevision, SandboxNamespaceContext } from "../../packages/contracts/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";
import { buildSandboxInstallation } from "./sandbox-driver-startup-installation-fixture.ts";
import type {
  kubernetesObjectClient as makeKubernetesObjectClient,
  KubernetesMutation,
} from "./sandbox-driver-startup-orchestration.ts";
import { workspaceGatewayClient } from "./sandbox-workspace-gateway-fixture.ts";

type Installation = ReturnType<typeof buildSandboxInstallation>;
type SandboxInput = Installation["drivers"]["sandbox"]["configuration"];
type GatewayClient = ReturnType<typeof workspaceGatewayClient>;
export function verifyDedicatedHarnessSelection({
  configureAgent,
}: {
  configureAgent: (
    configuration: Parameters<OpenShellSandboxDriver["configureAgent"]>[0],
    id: string,
    mode?: AgentRevision["harness"]["mode"],
  ) => ReturnType<OpenShellSandboxDriver["configureAgent"]>;
}) {
  const configuration = { agents: { defaults: { model: "openai/gpt-5" } } };
  assert.deepEqual(configureAgent(configuration, "openclaw"), {
    agents: { defaults: { model: "openai/gpt-5", workspace: "/sandbox/enterprise" } },
  });
  assert.deepEqual(configuration, { agents: { defaults: { model: "openai/gpt-5" } } });

  const codex = configureAgent(configuration, "codex");
  assert.deepEqual(
    asRecord(asRecord(asRecord(asRecord(codex.plugins)?.entries)?.codex)?.config)?.appServer,
    {
      sandbox: "danger-full-access",
      approvalsReviewer: "user",
    },
  );
  assert.throws(
    () => configureAgent(configuration, "openclaw", "embedded"),
    /supports only dedicated Harness revisions/,
  );
  assert.throws(
    () => configureAgent(configuration, "other"),
    /does not support the selected Harness runtime/,
  );
}

export async function verifyWorkspaceWrapperDiagnostics({
  t,
  execution,
  setup,
}: {
  t: TestContext;
  execution: Pick<OpenShellSandboxExecRequest, "command">;
  setup: { files: Record<string, string>; completed: boolean };
}) {
  const wrapper = execution.command[2];
  assert.ok(wrapper, "the observed initializer command must include its Node program");
  const root = await temporaryDirectory(t, "openshell-workspace-wrapper-");
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const wrapped = (
    payload: object,
    environment: NodeJS.ProcessEnv = {},
    runnerExit?: number,
    afterLongWait = false,
  ) => {
    let program = wrapper;
    if (afterLongWait) {
      // Advance only elapsed time after the real flock succeeds.
      program =
        `{
        const cp = require("node:child_process");
        const spawn = cp.spawnSync;
        const now = performance.now.bind(performance);
        let elapsed = 0;
        Object.defineProperty(performance, "now", {value: () => now() + elapsed});
        cp.spawnSync = (command, ...args) => {
          const result = spawn(command, ...args);
          if (command === "/usr/bin/flock" && result.status === 0) elapsed = 30000;
          return result;
        };
      }\n` + program;
    }
    if (runnerExit !== undefined) {
      // Only the nested initializer's result is synthetic; the wrapper and flock run.
      program =
        `
      const childProcess = require("node:child_process");
      const originalSpawnSync = childProcess.spawnSync;
      childProcess.spawnSync = (command, ...args) => command === process.execPath
        ? { status: ${runnerExit}, stdout: "private native output", stderr: "private native output" }
        : originalSpawnSync(command, ...args);
    ` + program;
    }
    return spawnSync(process.execPath, ["-e", program], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      timeout: 60_000,
      env: {
        ...process.env,
        HOME: root,
        OPENCLAW_STATE_DIR: join(root, "state"),
        OPENCLAW_WORKSPACE_DIR: workspace,
        OPENCLAW_EXECUTABLE: join(root, "absent-runtime.mjs"),
        ...environment,
      },
    });
  };
  // A completed setup whose workspace has no record refuses on every retry.
  const { files: _files, ...record } = setup;
  assert.equal(wrapped({ ...record, completed: true }).status, 2);
  // A fresh owner reaches image validation. A late owner without a marker
  // must defer before starting setup, even if the first owner already exited.
  const unsupportedImage = { OPENCLAW_EXECUTABLE: process.execPath };
  assert.equal(wrapped(setup, unsupportedImage).status, 2);
  assert.equal(wrapped(setup, unsupportedImage, undefined, true).status, 1);
  // A missing runtime may be back on a retry; a workspace path the wrapper rejects exits 1.
  assert.equal(wrapped(setup).status, 1);
  assert.equal(wrapped(setup, { OPENCLAW_WORKSPACE_DIR: "relative" }).status, 1);
  for (const status of [3, 4]) {
    const result = wrapped(setup, {}, status);
    assert.equal(result.status, status);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  }
}

export async function verifyManagedNamespaceRejectsMutation({
  sandboxInstallation,
  openShellDriver,
  namespaceContext,
  kubernetesObjectClient,
}: {
  sandboxInstallation: () => Installation;
  openShellDriver: (client: GatewayClient, configuration: SandboxInput) => OpenShellSandboxDriver;
  namespaceContext: () => Omit<SandboxNamespaceContext, "kubernetes"> & { kubernetes: object };
  kubernetesObjectClient: typeof makeKubernetesObjectClient;
}) {
  const events: KubernetesMutation[] = [];
  const configuration = sandboxInstallation().drivers.sandbox.configuration;
  configuration.integrationMode = "service";
  Object.assign(configuration.gateway, {
    operatorWorkspaceResources: [
      { apiVersion: "v1", kind: "ServiceAccount", metadata: { name: "must-not-be-applied" } },
    ],
  });
  const gatewayClient = workspaceGatewayClient();
  const driver = openShellDriver(gatewayClient, configuration);
  const context = namespaceContext();
  context.kubernetes = kubernetesObjectClient(events);

  await assert.rejects(
    driver.ensureNamespace(context),
    /service integration requires the service Sandbox implementation; cannot ensure a Namespace/,
  );
  assert.deepEqual(events, []);
  assert.deepEqual(gatewayClient.calls, []);
}
