import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { inflateRawSync } from "node:zlib";
import type {
  KubernetesComputeDriver as ComputeDriver,
  KubernetesComputeDriverOptions,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import {
  PROTECTED_CODEX_WITH_NODE_ENTRYPOINT,
  RUNTIME_WRAPPER_COMMAND,
} from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import {
  nodeProgramArguments,
  withoutLineComments,
} from "../../apps/controller/src/drivers/compute/node-program.ts";
import type {
  OpenShellSandboxDriver,
  OpenShellSandboxDriverOptions,
} from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import type {
  OpenShellGatewayClient,
  OpenShellSandboxCreateRequest,
  OpenShellSandboxResponse,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import type {
  AgentRevision,
  HarnessWorkloadRequirements,
  SandboxNamespaceContext,
} from "../../packages/contracts/src/index.ts";
import {
  completeSandboxRevision,
  type SandboxFixtureRevision,
} from "./sandbox-driver-revision-fixture.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { workspaceGatewayClient } from "./sandbox-workspace-gateway-fixture.ts";

type Gateway = Omit<
  ReturnType<typeof workspaceGatewayClient>,
  "createSandbox" | "getSandbox" | "getService"
> &
  Pick<OpenShellGatewayClient, "createSandbox" | "getSandbox" | "getService">;
type Dependencies = {
  t: TestContext;
  sandboxInstallation: () => {
    drivers: {
      sandbox: {
        configuration: OpenShellSandboxDriverOptions;
      };
    };
  };
  openShellDriver: (
    gateway: Gateway,
    options: OpenShellSandboxDriverOptions,
  ) => OpenShellSandboxDriver;
  runtimeSandboxFixture: (
    driver: OpenShellSandboxDriver,
    options: { nodeSetupUrl: (target: SandboxFixtureRevision) => string },
  ) => {
    context: SandboxNamespaceContext;
    revision: SandboxFixtureRevision;
    requirements: HarnessWorkloadRequirements;
    runtimeManifest: string;
    codexConfig: string;
    nodeSetup: { url: string; bootstrapToken: string; expiresAtMs: number; tlsFingerprint: string };
  };
  conformanceKubernetesOptions: (options: {
    gatewayTrustedProxyCidrs: string[];
    runtime: { transportSecretPrefix: string; gatewayStorageClassName: string };
  }) => KubernetesComputeDriverOptions;
  KubernetesComputeDriver: typeof ComputeDriver;
};

function record(value: unknown): Record<string, unknown> {
  const parsed = asRecord(value);
  assert.ok(parsed);
  return parsed;
}

function string(value: unknown): string {
  assert.ok(typeof value === "string");
  return value;
}

function stringArray(value: unknown): string[] {
  assert.ok(Array.isArray(value) && value.every((item: unknown) => typeof item === "string"));
  return value;
}

function fields(value: unknown): Record<string, unknown> {
  return record(record(value).fields);
}

function structFields(value: unknown): Record<string, unknown> {
  return fields(record(value).structValue);
}

function optionalField(value: unknown, key: string): unknown {
  return value === undefined ? undefined : record(value)[key];
}

function withProtobufKinds(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(withProtobufKinds);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const normalized = Object.fromEntries(
    Object.entries(record(value)).map(([key, entry]) => [key, withProtobufKinds(entry)]),
  );
  const kind = [
    "nullValue",
    "numberValue",
    "stringValue",
    "boolValue",
    "structValue",
    "listValue",
  ].find((key) => Object.hasOwn(normalized, key));
  return kind === undefined ? normalized : { ...normalized, kind };
}

export async function verifyDedicatedCodexStartup({
  t,
  sandboxInstallation,
  openShellDriver,
  runtimeSandboxFixture,
  conformanceKubernetesOptions,
  KubernetesComputeDriver,
}: Dependencies) {
  const requests: OpenShellSandboxCreateRequest[] = [];
  let getServiceCalls = 0;
  let storedSandbox: OpenShellSandboxResponse | undefined;
  const gatewayClient: Gateway = workspaceGatewayClient();
  gatewayClient.createSandbox = async (request) => {
    requests.push(structuredClone(request));
    const template = record(request.spec.template);
    storedSandbox = {
      name: request.name,
      workspace: request.workspace,
      labels: structuredClone(request.labels),
      annotations: {
        ...structuredClone(request.annotations),
        "internal.openshell.ai/auth-epoch": "1",
        "internal.openshell.ai/runtime-generation": "runtime-generation",
      },
      spec: {
        ...structuredClone(request.spec),
        template: {
          ...structuredClone(template),
          driver_config: withProtobufKinds(template.driver_config),
        },
      },
      serviceUrls: {},
    };
    return { ...storedSandbox, serviceUrls: { "": "http://codex.example.test" } };
  };
  gatewayClient.getSandbox = async () => storedSandbox;
  gatewayClient.getService = async () => {
    getServiceCalls++;
    assert.ok(storedSandbox);
    return {
      sandbox: storedSandbox.name,
      name: "",
      targetPort: 8080,
      authorizationMode: "SERVICE_AUTHORIZATION_MODE_BEARER_PASSTHROUGH",
      advertisedUrl: "http://codex.example.test:8080/",
      url: "http://codex.example.test",
    };
  };
  const installationOptions = sandboxInstallation().drivers.sandbox.configuration;
  // The advertised workspace, Harness environment, and writable mount must agree even
  // when an operator chooses a path other than the development default.
  const options: OpenShellSandboxDriverOptions = {
    ...installationOptions,
    kubernetes: {
      ...installationOptions.kubernetes,
      sandboxDataMount: {
        ...installationOptions.kubernetes.sandboxDataMount,
        mountPath: "/sandbox/custom-workspace",
      },
    },
  };
  const driver = openShellDriver(gatewayClient, options);
  // Exercise Sandbox delivery with a supported scoped node URL on the in-cluster
  // Envoy hostname used by the k3d profile. Live first-Agent proof covers enrollment.
  const routeHost = "occ-gateway-0123456789ab.envoy-gateway-system.svc.cluster.local";
  const computeOptions = conformanceKubernetesOptions({
    gatewayTrustedProxyCidrs: ["127.0.0.1/32"],
    runtime: { transportSecretPrefix: "transport", gatewayStorageClassName: "local-path" },
  });
  // Routing derives the Gateway client peer from the Envoy namespace.
  const { gatewayClients: _gatewayClients, ...network } = computeOptions.network;
  const compute = new KubernetesComputeDriver(
    {
      ...computeOptions,
      network,
      gatewayRouting: {
        hostname: routeHost,
        gatewayName: "oce-agent-gateways",
        gatewayNamespace: "openclaw-system",
        envoyNamespace: "envoy-gateway-system",
      },
    },
    { sandboxDriver: driver },
  );
  const {
    context,
    revision: fixtureRevision,
    requirements: fixtureRequirements,
    runtimeManifest,
    codexConfig,
    nodeSetup,
  } = runtimeSandboxFixture(driver, {
    nodeSetupUrl: (target) => `${compute.getGatewayEndpoint(completeSandboxRevision(target))}/node`,
  });
  // Account fields are opaque claims, even when their text resembles a Harness path.
  const account = {
    accountId: "workspace/home/node/account",
    planType: "business",
    userId: "user/home/node/identity",
    accountUserId: "account-user/home/node/identity",
    email: "dev/home/node/alice@example.test",
    isFedramp: false,
  };
  const accountJson = JSON.stringify(account);
  const harnessAuth = {
    method: "credential_source",
    sourceId: "cs_00000000-0000-4000-8000-000000000001",
    credentialGatewayId: "openshell-credentials",
    sourceType: "codex-oauth",
    loginMode: "chatgptAuthTokens",
  } satisfies AgentRevision["harnessAuth"];
  const revision = completeSandboxRevision(fixtureRevision, harnessAuth);
  const [attachment, ...remainingAttachments] = fixtureRequirements.credentialAttachments;
  assert.ok(attachment);
  const credentialAttachments = [
    {
      ...attachment,
      sourceId: harnessAuth.sourceId,
      externalChatgptAuth: {
        accessTokenPlaceholder: `openshell:resolve:env:s${"1".repeat(64)}_CODEX_ACCESS_TOKEN`,
        ...account,
      },
    },
    ...remainingAttachments,
  ];
  const requirements: HarnessWorkloadRequirements = {
    ...fixtureRequirements,
    credentialAttachments,
    command: [
      ...RUNTIME_WRAPPER_COMMAND,
      ...nodeProgramArguments(PROTECTED_CODEX_WITH_NODE_ENTRYPOINT),
    ],
    loginMode: harnessAuth.loginMode,
    environment: [
      ...fixtureRequirements.environment,
      { name: "CODEX_LOGIN_MODE", value: harnessAuth.loginMode },
      ...compute["credentialSourceEnvironment"](revision, credentialAttachments),
    ],
  };
  assert.match(nodeSetup.url, new RegExp(`^wss://${routeHost.replaceAll(".", "\\.")}/`));

  await driver.ensureNamespace(context);
  await driver.provisionHarness({ ...context, revision, requirements });
  await driver.provisionHarness({ ...context, revision, requirements });
  assert.deepEqual(await driver.harnessEndpoint({ ...context, revision, requirements }), {
    url: "ws://codex.example.test:8080/",
    workspaceRoot: "/sandbox/custom-workspace",
    codexPermissionProfile: ":danger-full-access",
  });

  assert.equal(requests.length, 1);
  assert.equal(getServiceCalls, 2);
  const [request] = requests;
  assert.ok(request);
  const spec = request.spec;
  const environment = record(spec.environment);
  const template = record(spec.template);
  const policy = record(spec.policy);
  const filesystem = record(policy.filesystem);
  assert.equal(spec.tty, undefined);
  assert.equal(template.annotations, undefined);
  assert.deepEqual(request.serviceExposures, [
    { service: "", targetPort: 8080, authorizationMode: "bearer_passthrough" },
  ]);
  assert.equal(environment.APP_TOKEN_SHA, "a".repeat(64));
  assert.equal(environment.APP_SERVER_TOKEN, undefined);
  assert.equal(environment.OPENCLAW_NODE_SETUP_CODE, undefined);
  assert.equal(environment.OPENCLAW_NODE_CA_PEM, undefined);
  assert.equal(environment.HOME, "/sandbox/.openclaw-runtime/home");
  assert.equal(environment.TMPDIR, "/tmp");
  assert.equal(environment.CODEX_HOME, "/sandbox/.openclaw-runtime/home/.codex");
  assert.equal(environment.NODE_PATH, "/home/node_modules");
  assert.equal(environment.OCE_CODEX_CHATGPT_ACCOUNT, accountJson);
  const nodeStateDirectory = string(environment.OPENCLAW_NODE_STATE_DIR);
  assert.match(nodeStateDirectory, /^\/sandbox\/\.openclaw-mounts\/[a-f0-9]{16}\/state$/u);
  assert.equal(environment.OPENCLAW_WORKSPACE_DIR, "/sandbox/custom-workspace");
  const kubernetesDriver = structFields(fields(template.driver_config).kubernetes);
  const agentContainer = structFields(structFields(kubernetesDriver.containers).agent);
  const resources = structFields(agentContainer.resources);
  assert.deepEqual(structFields(resources.requests)["ephemeral-storage"], { stringValue: "256Mi" });
  assert.deepEqual(structFields(resources.limits)["ephemeral-storage"], { stringValue: "1Gi" });
  const mountValues = record(record(agentContainer.volume_mounts).listValue).values;
  assert.ok(Array.isArray(mountValues));
  const mounts = mountValues.map((value: unknown) => structFields(value));
  const mountPaths = mounts.map((mount) => {
    const mountPath = optionalField(mount.mount_path, "stringValue");
    return mountPath === undefined ? "" : string(mountPath);
  });
  assert.equal(mountPaths.includes("/home/node/workspace"), false);
  const runtimeMount = mounts[mountPaths.indexOf("/sandbox/.openclaw-runtime")];
  assert.ok(runtimeMount, "OpenShell requires a writable runtime root mount.");
  assert.match(
    string(record(runtimeMount.sub_path).stringValue),
    /^openshell-runtime-[a-f0-9]{16}$/,
  );
  assert.equal(record(runtimeMount.read_only).boolValue, false);
  assert.ok(mountPaths.some((path) => /^\/sandbox\/\.openclaw-mounts\/[a-f0-9]{16}$/u.test(path)));
  assert.ok(
    mounts.some(
      (mount) =>
        `${optionalField(mount.mount_path, "stringValue")}/state` === nodeStateDirectory &&
        optionalField(mount.read_only, "boolValue") === false,
    ),
    "the node-state environment must name a process-owned child of its real writable PVC mount",
  );
  assert.equal(
    mountPaths.some((path) => path.startsWith("/sandbox/.openclaw-runtime/")),
    false,
  );
  const command = stringArray(spec.command);
  const commandBytes = Buffer.byteLength(JSON.stringify(command));
  assert.ok(commandBytes <= 65_536, `final OpenShell command is ${commandBytes} bytes`);
  t.diagnostic(`Final OpenShell account command: ${commandBytes} bytes`);
  const loader = nodeProgramArguments("")[0];
  assert.ok(loader);
  const wrapper = command[RUNTIME_WRAPPER_COMMAND.length];
  assert.ok(wrapper);
  const script =
    wrapper.slice(0, -loader.length) +
    inflateRawSync(
      Buffer.from(command.slice(RUNTIME_WRAPPER_COMMAND.length + 1).join(""), "base64"),
    ).toString("utf8");
  assert.ok(script.endsWith(withoutLineComments(PROTECTED_CODEX_WITH_NODE_ENTRYPOINT)));
  assert.match(script, /\/sandbox\/\.openclaw-runtime\/home\/\.codex\/sessions/);
  assert.match(script, /\/sandbox\/\.openclaw-mounts\/[a-f0-9]{16}/);
  assert.doesNotMatch(
    script,
    /\.openclaw-node/,
    "node state must not use a symlink because OpenClaw atomically replaces files below it",
  );
  for (const path of [
    "/sandbox/.openclaw-runtime",
    "/sandbox/custom-workspace",
    "/tmp",
    "/dev/null",
  ]) {
    assert.ok(stringArray(filesystem.read_write).includes(path), path);
  }
  assert.deepEqual(filesystem.read_only, [
    "/bin",
    "/usr",
    "/lib",
    "/proc",
    "/dev/urandom",
    "/etc",
    "/var/log",
    "/app",
  ]);
  return {
    driver,
    gatewayClient,
    compute,
    context,
    revision,
    runtimeManifest,
    codexConfig,
    nodeSetup,
    routeHost,
    spec,
    environment,
  };
}
