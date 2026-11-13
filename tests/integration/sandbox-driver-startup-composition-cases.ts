import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { OpenShellCredentialGatewayDriver } from "../../apps/controller/src/drivers/credential-gateway/openshell.ts";
import type { OpenShellSandboxExecRequest } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import {
  OpenShellSandboxDriver,
  type OpenShellSandboxDriverOptions,
  type OpenShellSandboxDriverSelection,
} from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import type {
  AgentRevision,
  ConfigurationValidationError,
  CredentialSourceControl,
  RepositoryGitDeliveryProfile,
  RevisionHarnessDescriptor,
  SandboxNamespaceContext,
} from "../../packages/contracts/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { loadInstallationFile } from "../helpers/installation-file.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";
import type { openShellWorkspaceChartResources as chartResources } from "../fixtures/openshell-workspace-chart.mjs";
import { makeStructuralRefusal } from "./sandbox-driver-installation-fixture.ts";
import {
  buildSandboxInstallation,
  rejectsAtStartup,
} from "./sandbox-driver-startup-installation-fixture.ts";
import { workspaceGatewayClient } from "./sandbox-workspace-gateway-fixture.ts";

type Installation = ReturnType<typeof buildSandboxInstallation>;
type SandboxInput = Installation["drivers"]["sandbox"]["configuration"];
type GatewayClient = ReturnType<typeof workspaceGatewayClient>;
type KubernetesEvent = ["kubernetes", "patch" | "delete", string, string, string];
type OperatorPolicy = {
  metadata: { name: string };
  spec: {
    ingress: [{ from: object[]; ports: [{ port: number }] }];
  };
};
type OperatorWire = OperatorPolicy & {
  metadata: OperatorPolicy["metadata"] & {
    namespace: string;
    labels: Record<string, string>;
    annotations: Record<string, string>;
  };
};

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
  execution: Pick<OpenShellSandboxExecRequest, "command"> & {
    command: readonly [string, string, string, ...string[]];
  };
  setup: { files: Record<string, string>; completed: boolean };
}) {
  const root = await temporaryDirectory(t, "openshell-workspace-wrapper-");
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const wrapped = (payload: object, environment: NodeJS.ProcessEnv = {}, runnerExit?: number) => {
    let program = execution.command[2];
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
  kubernetesObjectClient: (events: KubernetesEvent[]) => {
    patch: (resource: object) => Promise<object>;
    delete: (resource: object) => Promise<void>;
  };
}) {
  const events: KubernetesEvent[] = [];
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

export async function verifySandboxFactoryValidation({
  t,
  sandboxInstallation,
  structuralRefusal,
  SharedConfigurationValidationError,
}: {
  t: TestContext;
  sandboxInstallation: () => Installation;
  structuralRefusal: typeof makeStructuralRefusal;
  SharedConfigurationValidationError: typeof ConfigurationValidationError;
}) {
  const configuration = sandboxInstallation();
  Reflect.set(configuration.drivers.sandbox.configuration, "unsupported", true);
  let invokedFactory = false;
  const options: NonNullable<Parameters<typeof loadInstallationFile>[2]> & {
    createSandboxDriver(): never;
  } = {
    createSandboxDriver() {
      invokedFactory = true;
      throw new Error("An injected factory must not bypass provider configuration validation.");
    },
  };

  await assert.rejects(loadInstallationFile(t, configuration, options), (error: unknown) => {
    assert.ok(error instanceof SharedConfigurationValidationError);
    assert.deepEqual(
      error.error.details,
      structuralRefusal("", "additionalProperties", "UNKNOWN_FIELD"),
    );
    return true;
  });
  assert.equal(invokedFactory, false);
  // Control: the same factory is reached once the configuration is valid.
  await assert.rejects(loadInstallationFile(t, sandboxInstallation(), options), /injected factory/);
  assert.equal(invokedFactory, true);
}

export async function verifyOperatorPolicyDrift({
  observed,
  driver,
  context,
  gatewayClient,
  callCount,
  policy,
  metadata,
  setWire,
}: {
  observed: { spec: { ingress: [{ _from?: object[]; from?: object[] }] } };
  driver: OpenShellSandboxDriver;
  context: SandboxNamespaceContext;
  gatewayClient: GatewayClient;
  callCount: (client: GatewayClient, operation: GatewayClient["calls"][number][0]) => number;
  policy: OperatorPolicy;
  metadata: OperatorWire["metadata"];
  setWire: (value: OperatorWire) => void;
}) {
  assert.ok(observed.spec.ingress[0]._from);
  assert.equal(observed.spec.ingress[0].from, undefined);
  await driver.ensureNamespace(context);
  assert.equal(callCount(gatewayClient, "createWorkspace"), 1);
  for (const mutate of [
    (value: OperatorWire) => {
      value.spec.ingress[0].from = [{}];
    },
    (value: OperatorWire) => {
      value.spec.ingress[0].ports[0].port = 9090;
    },
  ]) {
    const wire = { ...structuredClone(policy), metadata };
    setWire(wire);
    mutate(wire);
    await assert.rejects(
      driver.ensureNamespace(context),
      /Operator workspace resource does not match/,
    );
  }
}

export async function verifyOperatorAliasesRejected({
  configuration,
  gatewayClient,
  backendFor,
  SharedConfigurationValidationError,
}: {
  configuration: OpenShellSandboxDriverOptions & {
    gateway: { networkPolicyResources: [OperatorPolicy] };
  };
  gatewayClient: GatewayClient;
  backendFor: (client: GatewayClient) => OpenShellSandboxDriverSelection["backend"];
  SharedConfigurationValidationError: typeof ConfigurationValidationError;
}) {
  const malformed = structuredClone(configuration);
  const rule = malformed.gateway.networkPolicyResources[0].spec.ingress[0];
  Reflect.set(rule, "_from", rule.from);
  Reflect.deleteProperty(rule, "from");
  let refusal: unknown;
  try {
    new OpenShellSandboxDriver(malformed, {
      id: "openshell-sandbox",
      implementation: "openshell",
      backend: backendFor(gatewayClient),
      operatorOwnedKubernetesResources: true,
    });
  } catch (error) {
    refusal = error;
  }
  assert.ok(refusal instanceof SharedConfigurationValidationError);
  // The write-only list is reported at its own path; its items stay out of diagnostics.
  assert.deepEqual(refusal.error.details, [
    {
      path: "/gateway/networkPolicyResources",
      code: "INVALID_VALUE",
      message: "Name NetworkPolicy ingress sources with the Kubernetes field from.",
    },
  ]);
}

export async function prepareStockWorkspaceChart({
  t,
  sandboxInstallation,
  sandboxOf,
  openShellWorkspaceChartResources,
}: {
  t: TestContext;
  sandboxInstallation: () => Installation;
  sandboxOf: (configuration: Installation) => SandboxInput;
  openShellWorkspaceChartResources: typeof chartResources;
}) {
  const chart = openShellWorkspaceChartResources();
  const forms = {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name: "value-forms" },
    spec: {
      podSelector: {},
      policyTypes: ["Ingress", "Egress"],
      ingress: [
        {
          from: [],
          ports: [
            { protocol: "TCP", port: "ssh" },
            { port: 1000, endPort: 2000 },
          ],
        },
        { from: null },
        {},
        { from: [{ ipBlock: { cidr: "10.0.0.0/8", except: [] } }] },
      ],
      egress: [{ to: [{ namespaceSelector: {}, podSelector: { matchExpressions: [] } }] }],
    },
  };
  const crd = {
    apiVersion: "crd.antrea.io/v1beta1",
    kind: "NetworkPolicy",
    metadata: { name: "provider-crd" },
    spec: { priority: 5, appliedTo: [{ podSelector: {} }], ingress: [{ action: "Allow" }] },
  };
  const installation = sandboxInstallation();
  Object.assign(sandboxOf(installation).gateway, {
    operatorWorkspaceResources: chart,
    networkPolicyResources: [forms, crd],
  });
  await loadInstallationFile(t, installation);
  return { chart, forms, crd, installation };
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
