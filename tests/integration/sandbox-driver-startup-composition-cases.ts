import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { OpenShellCredentialGatewayDriver } from "../../apps/controller/src/drivers/credential-gateway/openshell.ts";
import type { OpenShellSandboxExecRequest } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import type {
  AgentRevision,
  CredentialSourceControl,
  RepositoryGitDeliveryProfile,
  RevisionHarnessDescriptor,
  SandboxNamespaceContext,
} from "../../packages/contracts/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { loadInstallationFile } from "../helpers/installation-file.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";
import { makeStructuralRefusal } from "./sandbox-driver-installation-fixture.ts";
import {
  buildSandboxInstallation,
  rejectsAtStartup,
} from "./sandbox-driver-startup-installation-fixture.ts";
import type {
  kubernetesObjectClient as makeKubernetesObjectClient,
  KubernetesMutation,
} from "./sandbox-driver-startup-orchestration.ts";
import { workspaceGatewayClient } from "./sandbox-workspace-gateway-fixture.ts";

type Installation = ReturnType<typeof buildSandboxInstallation>;
type SandboxInput = Installation["drivers"]["sandbox"]["configuration"];
type GatewayClient = ReturnType<typeof workspaceGatewayClient>;
export async function verifySharedBackendComposition(t: TestContext) {
  // An explicit hard_requirement composes like the omitted default above.
  const configuration = buildSandboxInstallation();
  Object.assign(configuration.drivers.sandbox.configuration.policy, {
    landlockCompatibility: "hard_requirement",
  });
  const createdDriver = await loadInstallationFile(t, configuration);

  assert.ok(createdDriver?.credentialGatewayDriver instanceof OpenShellCredentialGatewayDriver);
  assert.equal(createdDriver.credentialGatewayDriver.id, "openshell-credentials");
  assert.equal(createdDriver.installation.drivers.credential_gateway?.implementation, "openshell");
  assert.deepEqual(createdDriver.installation.backend?.[0]?.drivers, {
    sandbox: createdDriver.sandboxDriver?.id,
    credential_gateway: createdDriver.credentialGatewayDriver.id,
  });
}

export function verifyRejectedCredentialGatewayExecutable(t: TestContext): Promise<void> {
  return rejectsAtStartup(
    t,
    (configuration) => {
      Object.assign(configuration.drivers.credential_gateway.configuration, {
        toolBinaries: ["bin/curl"],
      });
    },
    makeStructuralRefusal("/toolBinaries/0", "pattern", "INVALID_FORMAT"),
  );
}

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
  const wrapped = (payload: object, environment: NodeJS.ProcessEnv = {}, runnerExit?: number) => {
    let program = wrapper;
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
  configuration.gateway.workspaceMode = "managed";
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
    /managed workspace mode is not implemented; cannot ensure a Namespace/,
  );
  assert.deepEqual(events, []);
  assert.deepEqual(gatewayClient.calls, []);
}

export async function verifyProtectedGatewayAdmission({
  signal,
  setGatewayVersion,
  sourceControl,
  validateRepositoryCredentials,
}: {
  signal: AbortSignal;
  setGatewayVersion: (version: string) => void;
  sourceControl: Pick<CredentialSourceControl, "assertAvailable">;
  validateRepositoryCredentials: (harness: Pick<RevisionHarnessDescriptor, "id" | "mode">) => void;
}) {
  setGatewayVersion("unknown");
  const profiles: readonly RepositoryGitDeliveryProfile[] = ["repository_git", "github_repository"];
  for (const profile of profiles) {
    assert.deepEqual(await sourceControl.assertAvailable(signal, profile), {
      profile,
      authorization: "online-request",
    });
  }

  setGatewayVersion("0.1.5");
  validateRepositoryCredentials({ id: "codex", mode: "dedicated" });
  assert.throws(() => validateRepositoryCredentials({ id: "openclaw", mode: "embedded" }), {
    message: /[Rr]epository credentials require/,
  });
}
