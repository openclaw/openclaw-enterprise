import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { inflateRawSync } from "node:zlib";
import {
  MANAGED_BY,
  MANAGED_BY_LABEL,
  OpenShellGateway,
  openShellProviderName,
  SOURCE_ID_LABEL,
} from "../../apps/controller/src/backends/openshell.ts";
import {
  PROTECTED_CODEX_WITH_NODE_ENTRYPOINT,
  RUNTIME_WRAPPER_COMMAND,
} from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import {
  nodeProgramArguments,
  withoutLineComments,
} from "../../apps/controller/src/drivers/compute/node-program.ts";
import { OpenShellCredentialGatewayDriver } from "../../apps/controller/src/drivers/credential-gateway/openshell.ts";
import { CODEX_ACCOUNT_CONFIG } from "../../apps/controller/src/drivers/credential-refresh/codex-device-authorization.ts";
import {
  OpenShellSandboxDriver,
  type OpenShellSandboxDriverOptions,
} from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import type {
  OpenShellGatewayClient,
  OpenShellSandboxCreateRequest,
  OpenShellSandboxResponse,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import {
  admitLoggingConfiguration,
  type AgentRevision,
  type CredentialSource,
  type HarnessWorkloadRequirements,
  type SandboxNamespaceContext,
} from "../../packages/contracts/src/index.ts";
import { asRecord, type WorkspaceNodeSetupEnvelope } from "../../packages/utils/src/index.ts";
import { providerEndpointFixture } from "../fixtures/kubernetes-provider-endpoint.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { buildSandboxInstallation } from "./sandbox-driver-installation-fixture.ts";
import {
  completeSandboxRevision,
  type SandboxFixtureRevision,
} from "./sandbox-driver-revision-fixture.ts";
import {
  completeOpenShellGatewayClient,
  workspaceGatewayClient,
} from "./sandbox-workspace-gateway-fixture.ts";

type Gateway = Omit<
  ReturnType<typeof workspaceGatewayClient>,
  "createSandbox" | "getSandbox" | "getService"
> &
  Pick<OpenShellGatewayClient, "createSandbox" | "getSandbox" | "getService">;
type Dependencies = {
  t: TestContext;
  sandboxPolicy: OpenShellSandboxDriverOptions["policy"];
  runtimeSandboxFixture: (
    driver: OpenShellSandboxDriver,
    options: { nodeSetupUrl: (target: SandboxFixtureRevision) => string },
  ) => {
    context: SandboxNamespaceContext;
    revision: SandboxFixtureRevision;
    requirements: HarnessWorkloadRequirements;
    runtimeManifest: string;
    codexConfig: string;
    nodeSetup: WorkspaceNodeSetupEnvelope;
  };
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
  sandboxPolicy,
  runtimeSandboxFixture,
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
      id: "7b620136-6184-4fba-ae3e-62352e892d12",
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
  const installation = buildSandboxInstallation();
  const { sandbox, credential_gateway: selectedGateway } = installation.drivers;
  const [selectedBackend] = installation.backend;
  assert.ok(selectedBackend);
  const installationOptions = sandbox.configuration;
  // The advertised workspace, Harness environment, and writable mount must agree even
  // when an operator chooses a path other than the development default.
  const options: OpenShellSandboxDriverOptions = {
    ...installationOptions,
    policy: sandboxPolicy,
    kubernetes: {
      ...installationOptions.kubernetes,
      sandboxDataMount: {
        ...installationOptions.kubernetes.sandboxDataMount,
        mountPath: "/sandbox/custom-workspace",
      },
    },
  };
  const backend = {
    id: selectedBackend.id,
    // OpenShell exposes Codex OAuth only when this Backend owns credential refresh.
    drivers: { ...selectedBackend.drivers, credential_refresh: "openshell-refresh" },
    client: new OpenShellGateway(selectedBackend.configuration, {
      gatewayClient: completeOpenShellGatewayClient(gatewayClient),
    }),
  };
  const credentialGateway = new OpenShellCredentialGatewayDriver(selectedGateway.configuration, {
    id: selectedGateway.id,
    backend,
  });
  const driver = new OpenShellSandboxDriver(options, {
    id: sandbox.id,
    implementation: "openshell",
    backend,
  });
  // Exercise Sandbox delivery with a supported scoped node URL on the in-cluster
  // Envoy hostname used by the k3d profile. Live first-Agent proof covers enrollment.
  const routeHost = "occ-gateway-0123456789ab.envoy-gateway-system.svc.cluster.local";
  const gatewayRouting = {
    hostname: routeHost,
    gatewayName: "oce-agent-gateways",
    gatewayNamespace: "openclaw-system",
    envoyNamespace: "envoy-gateway-system",
  };
  const {
    context,
    revision: fixtureRevision,
    requirements: fixtureRequirements,
    runtimeManifest,
    codexConfig,
    nodeSetup,
  } = runtimeSandboxFixture(driver, {
    nodeSetupUrl: ({ namespaceId, agentId }) =>
      `wss://${routeHost}/namespaces/${namespaceId}/agents/${agentId}/node`,
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
  const harnessAuth = {
    method: "credential_source",
    sourceId: "cs_00000000-0000-4000-8000-000000000001",
    credentialGatewayId: credentialGateway.id,
    sourceType: "codex-oauth",
    loginMode: "chatgptAuthTokens",
  } satisfies AgentRevision["harnessAuth"];
  const {
    compute: _compute,
    gatewayManagedMode: _gatewayManagedMode,
    ...original
  } = completeSandboxRevision(fixtureRevision, harnessAuth);
  const configuration = admitLoggingConfiguration(
    driver.configureAgent(createHarnessConfiguration("codex", "gpt-5"), original.harness),
    "info",
  );
  const gateway = providerEndpointFixture({
    gatewayRouting,
    sandboxDriver: driver,
    credentialGatewayDriver: credentialGateway,
    servicePrincipalCredentials: { mode: "disabled" },
    revisionOverrides: {
      ...original,
      configuration,
      credentialSources: [
        {
          sourceId: harnessAuth.sourceId,
          sourceType: harnessAuth.sourceType,
          credentialGatewayId: harnessAuth.credentialGatewayId,
        },
      ],
    },
  });
  const { driver: compute, revision } = gateway;
  const source: CredentialSource = {
    id: harnessAuth.sourceId,
    namespaceId: revision.namespaceId,
    type: harnessAuth.sourceType,
    name: "fixture Codex OAuth source",
    config: {},
    secrets: {},
    ownerCapability: credentialGateway.capability,
    driverId: credentialGateway.id,
    state: "ready",
    createdAt: revision.createdAt,
  };
  // Seed the stored OpenShell provider returned after OAuth has completed.
  const providerName = openShellProviderName(source.id);
  gatewayClient.providers.set(providerName, {
    name: providerName,
    type: providerName,
    labels: { [MANAGED_BY_LABEL]: MANAGED_BY, [SOURCE_ID_LABEL]: source.id },
    config: { [CODEX_ACCOUNT_CONFIG]: JSON.stringify(account) },
    resourceVersion: "1",
  });
  // The Worker resolves this source through harnessAuth, separately from non-model sources.
  // Compute's first pass renders the mounted Gateway configuration before provisioning the Sandbox.
  const prepared = await compute.prepareRevision(revision, {
    harnessAuth: { ...harnessAuth, source },
    secretEnvironment: [],
  });
  assert.equal(prepared.ready, false);
  assert.equal(requests.length, 0, "Gateway bootstrap must precede Harness provisioning");

  await driver.ensureNamespace(context);
  const sourceContext = { namespace: context.namespace, source, signal: context.signal };
  const credentialAttachments = await credentialGateway.attachForRevision({
    namespace: context.namespace,
    revision,
    sources: [source],
    signal: context.signal,
  });
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
      ...compute["credentialSourceEnvironment"](revision, credentialAttachments, source),
    ],
  };
  assert.equal(nodeSetup.url, `${compute.getGatewayEndpoint(revision)}/node`);

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
  assert.equal(environment.OCE_CODEX_CHATGPT_ACCOUNT, JSON.stringify(account));
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
  const deployment = record(gateway.gateway());
  const annotations = record(record(deployment.metadata).annotations);
  assert.equal(annotations["openclaw.dev/agent-revision-id"], revision.id);
  const pod = record(record(record(deployment.spec).template).spec);
  const volumes = pod.volumes;
  assert.ok(Array.isArray(volumes));
  const mountedConfig = volumes
    .map((volume: unknown) => record(volume))
    .find((volume) => volume.name === "openclaw-configuration");
  assert.ok(mountedConfig);
  const containers = pod.containers;
  assert.ok(Array.isArray(containers));
  const [gatewayContainer] = containers;
  const gatewayMounts = record(gatewayContainer).volumeMounts;
  assert.ok(Array.isArray(gatewayMounts));
  assert.ok(gatewayMounts.some((mount: unknown) => record(mount).name === mountedConfig.name));
  const configName = string(record(mountedConfig.configMap).name);
  const config = record(gateway.read("ConfigMap", configName, gateway.gatewayNamespace));
  const document: unknown = JSON.parse(string(record(config.data)["openclaw.json"]));
  const plugins = asRecord(record(document).plugins);
  const codex = asRecord(asRecord(plugins?.entries)?.codex);
  const appServer = asRecord(asRecord(codex?.config)?.appServer);
  const relay = asRecord(appServer?.nativeHookRelay);
  assert.ok(relay, "the mounted Gateway ConfigMap must configure the native hook relay");
  return {
    driver,
    gatewayClient,
    credentialGateway,
    sourceContext,
    relay: { url: string(relay.url), credentialDirectory: string(relay.credentialDirectory) },
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

export function verifyNativeOpenClawCreateRequest({
  request,
  expectedCommand,
  labels,
  nodeSetup,
  gatewayClient,
}: {
  request: OpenShellSandboxCreateRequest;
  expectedCommand: HarnessWorkloadRequirements["command"];
  labels: HarnessWorkloadRequirements["labels"];
  nodeSetup: ReturnType<Dependencies["runtimeSandboxFixture"]>["nodeSetup"];
  gatewayClient: Pick<ReturnType<typeof workspaceGatewayClient>, "providers" | "profiles">;
}): string {
  const template = record(request.spec.template);
  const pod = structFields(fields(template.driver_config).kubernetes).pod;
  const command = stringArray(request.spec.command);
  const environment = record(request.spec.environment);
  const policy = record(request.spec.policy);
  const filesystem = record(policy.filesystem);
  assert.equal(template.runtime_class_name, "openshell-skipper");
  assert.equal(record(structFields(pod).runtime_class_name).stringValue, "openshell-skipper");
  assert.deepEqual(request.serviceExposures, []);
  assert.deepEqual(command.slice(0, RUNTIME_WRAPPER_COMMAND.length), RUNTIME_WRAPPER_COMMAND);
  const wrapper = command[RUNTIME_WRAPPER_COMMAND.length];
  assert.notEqual(wrapper, expectedCommand.at(-2));
  assert.match(string(wrapper), /OpenShell workspace link conflicts/);
  assert.deepEqual(request.labels, labels);
  assert.equal(environment.TMPDIR, "/tmp");
  assert.equal(filesystem.include_workdir, false);
  assert.deepEqual(filesystem.read_only, ["/app"]);
  const writablePaths = stringArray(filesystem.read_write);
  assert.ok(writablePaths.includes("/var/tmp/openclaw"));
  assert.ok(writablePaths.includes("/tmp"));
  assert.equal(stringArray(filesystem.read_only).includes("/bin"), false);
  // The real Gateway receives this mode with the Sandbox request; a weaker
  // Landlock setting could let a ready Harness run without filesystem policy.
  assert.equal(record(policy.landlock).compatibility, "hard_requirement");
  assert.equal(environment.OPENCLAW_NODE_SETUP_CODE, undefined);
  assert.equal(environment.OPENCLAW_NODE_CA_PEM, undefined);
  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.equal(environment.OPENCLAW_WORKSPACE_DIR, "/sandbox/enterprise");
  assert.match(
    string(environment.OPENCLAW_NODE_STATE_DIR),
    /^\/sandbox\/\.openclaw-mounts\/[a-f0-9]{16}\/state$/u,
  );
  const runtimeProvider = stringArray(request.spec.providers).find((name) =>
    name.startsWith("oce-runtime-"),
  );
  assert.ok(runtimeProvider, "the native node must receive its enrollment provider");
  assert.deepEqual(gatewayClient.providers.get(runtimeProvider)?.config, {
    node_setup_json: JSON.stringify(nodeSetup),
    node_ca_pem: "-----BEGIN CERTIFICATE-----\npublic-ca\n-----END CERTIFICATE-----\n",
  });
  assert.deepEqual(gatewayClient.profiles.get("oce-openclaw-runtime")?.profile?.files, [
    {
      path: "node-setup.json",
      content: "{{config.node_setup_json}}",
      environmentVariable: "OPENCLAW_NODE_SETUP_ENVELOPE",
    },
    {
      path: "node-ca.pem",
      content: "{{config.node_ca_pem}}",
      environmentVariable: "OPENCLAW_NODE_CA_PATH",
    },
  ]);
  assert.deepEqual(record(record(policy.network_policies)["workspace-node-enrollment"]).endpoints, [
    {
      host: "gateway.example.test",
      ports: [443],
      tls: "NETWORK_TLS_MODE_SKIP",
      enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
    },
  ]);
  return runtimeProvider;
}
