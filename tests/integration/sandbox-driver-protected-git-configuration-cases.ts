import { gatewayRuntimeEntrypoint } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { nodeProgramArguments } from "../../apps/controller/src/drivers/compute/node-program.ts";
import { selectFixtureRelease } from "../helpers/inspected-workspace-release.ts";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { Server, Socket } from "node:net";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { brotliDecompressSync, inflateRawSync } from "node:zlib";
import { loadYaml } from "../../apps/controller/node_modules/@kubernetes/client-node/dist/index.js";
import {
  openShellProviderName,
  openShellWorkspaceName,
} from "../../apps/controller/src/backends/openshell.ts";
import { object } from "../../apps/controller/src/composition/installation-fields.ts";
import {
  KubernetesComputeDriver,
  type KubernetesComputeDriverOptions,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import {
  resolveGitHubRepositoryBinding,
  type GitHubRepositoryRegistry,
} from "../../apps/controller/src/drivers/repo/github/access/registry.ts";
import {
  harnessRuntimeCredentials,
  OpenShellSandboxDriver,
  type OpenShellSandboxDriverOptions,
} from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import type { OpenShellSandboxCreateRequest } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { ManagedOpenShellSandbox } from "../../apps/controller/src/drivers/sandbox/openshell/managed.ts";
import { inspectedWorkspaceNodeTrustPrelude } from "../../apps/controller/src/drivers/sandbox/openshell-workspace-node-policy.ts";
import { formatStartupConfigurationFailure } from "../../apps/controller/src/startup-failure.ts";
import { ControllerWorker } from "../../apps/controller/src/worker.ts";
import type {
  AgentRevision,
  HarnessAuthSnapshot,
  HarnessWorkloadRequirements,
  OpenShellBackendConfiguration,
} from "../../packages/contracts/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { bindReservedPortInProcess, reservePort } from "../helpers/available-port.ts";
import { harnessTlsFixture } from "../helpers/harness-tls.ts";
import { loadInstallationFile } from "../helpers/installation-file.ts";
import { loader } from "../helpers/openshell-grpc-sdk.ts";
import { storedSandbox } from "./sandbox-driver-gateway-response-fixture.ts";
import { backendFor } from "./sandbox-driver-openshell-fixture.ts";
import {
  capturedWorkspaceRevision,
  verifyManagedScopedGitExecution,
  verifyProtectedRepositoryRuntimeImages,
  verifyProtectedOpenShellGitExecution,
} from "./sandbox-driver-protected-git-execution-cases.ts";
import {
  verifyProtectedChartListenerRefusals,
  verifyProtectedStartupRefusals,
} from "./sandbox-driver-protected-startup-guard-cases.ts";
import { completeSandboxRevision } from "./sandbox-driver-revision-fixture.ts";
import { verifyProtectedGatewayAdmission } from "./sandbox-driver-startup-composition-cases.ts";
import { buildSandboxInstallation } from "./sandbox-driver-startup-installation-fixture.ts";
import {
  harnessService,
  namespaceContext,
  ownedWorkspace,
  runtimeSandboxFixture,
} from "./sandbox-driver-startup-orchestration.ts";
import {
  workspaceNodeSetupSecret,
  workspaceNodeSetupSecretData,
} from "./sandbox-driver-workspace-node-setup-fixture.ts";
import { workspaceGatewayClient } from "./sandbox-workspace-gateway-fixture.ts";

export type ProtectedOpenShellGitFixture = Awaited<
  ReturnType<typeof configureProtectedOpenShellGit>
>;

async function configureProtectedOpenShellGit(
  t: TestContext,
  mode: "legacy" | "service" = "legacy",
  reserveAuthorityPort = true,
) {
  const tls = await harnessTlsFixture(t);
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPath = join(tls.directory, "gateway-public.pem");
  await writeFile(publicKeyPath, keys.publicKey.export({ type: "spki", format: "pem" }));
  const example: unknown = loadYaml(
    await readFile(
      new URL(
        "../../deploy/examples/repository-credentials/openshell.fragment.yaml",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const fragment = object(example, "repository credentials example");
  const repository = object(fragment.repository, "repository");
  const openShell = object(repository.openShell, "repository.openShell");
  const authority = object(openShell.authority, "repository.openShell.authority");
  const base = buildSandboxInstallation();
  const [openShellBackend] = base.backend;
  assert.ok(openShellBackend);
  const sandboxConfiguration = base.drivers.sandbox.configuration;
  sandboxConfiguration.integrationMode = mode;
  const workspaceMountPath = mode === "service" ? "/sandbox/oce/workspace" : "/sandbox/repository";
  sandboxConfiguration.kubernetes.sandboxDataMount.mountPath = workspaceMountPath;
  const providerHarness = {
    namespace: "openshell-system",
    podLabels: { app: "openshell-gateway" },
    address: "10.43.0.50",
    port: 8080,
  } satisfies NonNullable<KubernetesComputeDriverOptions["network"]["providerHarness"]>;
  const registry: Omit<GitHubRepositoryRegistry, "repositories"> & {
    repositories: GitHubRepositoryRegistry["repositories"][number][];
  } = {
    version: 1,
    backendId: "github-primary",
    providerInstanceId: "github-primary",
    appId: "123",
    githubInstallationId: "456",
    maximumDurationSeconds: 3600,
    allowStandingApprovals: true,
    repositories: [
      {
        repositoryRef: "source",
        repositoryId: "42",
        repository: "example/project",
        namespaces: [
          {
            namespaceId: namespaceContext().namespace.id,
            profiles: ["git-write"],
            transport: "git-and-draft-pr",
            pullRequestBase: "main",
            pushRefAllowlist: ["refs/heads/review/task"],
          },
        ],
      },
    ],
  };
  // Separate approved scopes let replacement exercise repository and permission changes
  // through the real registry resolver, without mutating an admitted revision.
  for (const [repositoryRef, repositoryId, contents] of [
    ["read-source", "43", "read"],
    ["other-read-source", "44", "read"],
    ["write-source", "45", "write"],
  ] as const) {
    registry.repositories.push({
      repositoryRef,
      repositoryId,
      repository: `example/${repositoryRef}`,
      namespaces: [
        {
          namespaceId: namespaceContext().namespace.id,
          profiles: ["github-repository"],
          ...(repositoryRef === "read-source" && { allowStandingApproval: true }),
          permissions: { contents, metadata: "read" },
        },
      ],
    });
  }

  const registryPath = join(tls.directory, "registry.json");
  await writeFile(registryPath, JSON.stringify(registry), { mode: 0o600 });
  // The Git worker binds its authority on this port in-process, well after the configuration
  // names it. Hold the port until then, so a test running in parallel cannot take it.
  const authorityPort = reserveAuthorityPort ? await reservePort() : undefined;
  if (authorityPort !== undefined) {
    t.after(() => authorityPort.release());
    await bindReservedPortInProcess(authorityPort);
  }
  const port = authorityPort?.port ?? 49_152;

  // Select the same driver through both typed capabilities with the extended gateway mock.
  // This does not establish stock signed-send or live-reduction support. No broker configuration,
  // generic exchange service, issuer call or second Git lifecycle is needed to load it.
  const gitId = base.drivers.sandbox.id;
  const gatewayBackend = {
    ...openShellBackend,
    configuration: {
      endpoint: "https://gateway.example.test:8443",
      auth: { mode: "bearerTokenFile", path: "/unused/operator-token" },
    } satisfies OpenShellBackendConfiguration,
    drivers: { ...openShellBackend.drivers, credential_proxy: gitId },
  };
  const repositoryBackend = (path: string) => ({
    id: registry.backendId,
    type: "github",
    configuration: { registryPath: path },
    drivers: { repo: "repository-credentials" },
  });
  const { gatewayClients: _gatewayClients, ...networkDefaults } =
    base.drivers.compute.configuration.network;
  const network: typeof networkDefaults &
    Pick<
      KubernetesComputeDriverOptions["network"],
      "providerHarness" | "repositoryCredentials" | "pluginStatusProxySourceCidrs"
    > = {
    ...networkDefaults,
    pluginStatusProxySourceCidrs: ["10.0.0.1/32"],
    providerHarness,
  };
  const configuration = {
    ...base,
    backend: [gatewayBackend, repositoryBackend(registryPath)],
    drivers: {
      ...base.drivers,
      compute: {
        ...base.drivers.compute,
        configuration: {
          ...base.drivers.compute.configuration,
          images: {
            gateway: "registry.example.test/runtime/gateway@sha256:" + "a".repeat(64),
            agent: "registry.example.test/runtime/agent@sha256:" + "b".repeat(64),
            requireImmutableDigest: true,
          },
          gatewayRouting: {
            hostname: "workspace.example.test",
            gatewayName: "oce-agent-gateways",
            gatewayNamespace: "openclaw-system",
            envoyNamespace: "envoy-gateway-system",
          },
          network,
        },
      },
      credential_proxy: { id: gitId, configuration: {} },
    },
    repository: {
      ...repository,
      preparedGitHub: repository.preparedGitHub,
      id: "repository-credentials",
      configuration: { sessionDurationSeconds: 600 },
      openShell: {
        ...openShell,
        authority: {
          ...authority,
          host: "127.0.0.1",
          port,
          certificatePath: tls.certPath,
          privateKeyPath: tls.keyPath,
          issuerPublicKeyPath: publicKeyPath,
          issuer: "https://gateway.example.test",
          audience: "online-authorizer",
          keyId: "gateway-key",
        },
      },
    },
  };

  const gateway = workspaceGatewayClient();
  let repositoryGatewayVersion = "0.1.5";
  gateway.getGatewayInfo = async () => ({
    gateway_version: repositoryGatewayVersion,
    extensions: [{ configured_name: "oce-prepared-git", kind: 4, protocol_major: 1 }],
  });
  const originalGetWorkspace = gateway.getWorkspace;
  gateway.getWorkspace = async (name, signal) => {
    const workspace = await originalGetWorkspace(name, signal);
    // Preserve absence after deletion; adding fixture identity must not resurrect a Workspace.
    return workspace === undefined ? undefined : { ...workspace, name, id: "workspace-id" };
  };
  const originalImportProfile = gateway.importProviderProfile;
  gateway.importProviderProfile = async (workspace, profile, signal) => {
    await originalImportProfile(workspace, profile, signal);
    const stored = gateway.profiles.get(profile.id);
    assert.ok(stored);
    const definition = {
      inference_capable: false,
      credentials: profile.credentials?.map((c) => ({
        name: c.name,
        env_vars: c.envVars,
        required: c.required,
        stable_placeholder: c.stablePlaceholder,
        auth_style: c.authStyle,
        header_name: c.headerName,
      })),
      binaries: profile.binaries?.map((path) => ({ path })),
      endpoints: profile.endpoints?.map((endpoint) => ({
        ...endpoint,
        enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
        ...(endpoint.rules
          ? {}
          : { access: endpoint.access ?? "NETWORK_ACCESS_PRESET_READ_WRITE" }),
      })),
    };
    gateway.profiles.set(profile.id, { ...stored, definition });
  };
  const originalCreateProvider = gateway.createProvider;
  gateway.createProvider = async (request, signal) => {
    const provider = await originalCreateProvider(request, signal);
    Object.assign(provider, {
      id: request.name + "-id",
      workspace: request.workspace,
      profileWorkspace: request.workspace,
    });
    return provider;
  };
  const specCodec = loader.loadSync(
    fileURLToPath(
      new URL(
        "../../apps/controller/src/drivers/sandbox/proto/openshell-gateway.proto",
        import.meta.url,
      ),
    ),
    { keepCase: true, longs: String, enums: String, defaults: false, oneofs: true },
  )["openshell.v1.SandboxSpec"];
  assert.ok(specCodec && "serialize" in specCodec && "deserialize" in specCodec);
  const { serialize, deserialize } = specCodec;
  assert.ok(
    typeof serialize === "function" && typeof deserialize === "function",
    "OpenShell SandboxSpec must be a protobuf message",
  );
  let created: OpenShellSandboxCreateRequest | undefined;
  gateway.createSandbox = async (request) => {
    created = request;
    const decoded: unknown = deserialize(serialize(request.spec));
    const sandbox = storedSandbox(request, {
      spec: object(decoded, "OpenShell SandboxSpec"),
      id: "sandbox-id",
      resourceVersion: "1",
      phase: "SANDBOX_PHASE_READY",
      restartCount: 0,
      mainProcessInstanceId: randomUUID(),
      mainProcessStartedAt: new Date().toISOString(),
    });
    gateway.sandboxes.set(request.name, sandbox);
    return sandbox;
  };
  gateway.getService = async (_workspace, sandbox, service) =>
    harnessService(sandbox, service, gateway.sandboxes.get(sandbox)?.serviceUrls[""]);
  gateway.getSandboxProviderStatus = async (workspace, sandbox, provider, _signal, requested) => {
    const now = new Date(Date.now()).toISOString();
    const box = gateway.sandboxes.get(sandbox);
    const attached = gateway.providers.get(provider);
    assert.ok(attached?.id && box?.id && box.mainProcessInstanceId);
    const updated =
      requested !== undefined && requested === attached.targetReceipts?.[0]?.receipt_id;
    const receiptId = updated ? requested : provider + "-observe";
    assert.ok(requested === undefined || requested === receiptId);
    const desired = {
      sandboxId: box.id,
      sandbox,
      providerId: attached.id,
      providerResourceVersion: attached.resourceVersion,
      attachmentEpoch: "epoch-one",
      providerEnvRevision: String(box.configurationAdmission?.provider_env_revision ?? "1"),
      configRevision: "1",
      policyHash: "policy-one",
    };
    return {
      state: "PROVIDER_READINESS_STATE_READY",
      evaluatedTime: now,
      observedTime: now,
      networkInstanceId: box.mainProcessInstanceId,
      completedOperationId: receiptId,
      receipt: {
        workspace,
        provider,
        desired,
        receiptId,
        kind: updated ? "PROVIDER_MUTATION_KIND_UPDATE" : "PROVIDER_MUTATION_KIND_OBSERVE",
      },
      observed: {
        ...desired,
        sessionId: "supervisor-one",
        sequence: "1",
        credentialsInstalled: true,
        policyActive: true,
        launchEnvironmentInstalled: true,
        processInstanceId: "process-one",
        reason: "PROVIDER_READINESS_REASON_UNSPECIFIED",
      },
    };
  };
  const backend = backendFor(gateway);
  const options = { createOpenShellBackend: () => backend };
  // A native broker peer left in Compute after a switch to protected Git would make every
  // stop, retire and delete list repository material Secrets the chart no longer lets the
  // worker list (finding 2212). Startup, and so the chart's upgrade check, refuses it.
  await verifyProtectedStartupRefusals(
    configuration,
    (candidate) => loadInstallationFile(t, candidate, options),
    formatStartupConfigurationFailure,
  );
  // The chart routes openshellGit.port to the worker Pod's address, so a worker listener on
  // loopback, on another port, or without the chart listener is refused at startup and in the
  // upgrade check, not at the first Git request (finding 2213). This test binds the listener
  // on loopback itself, so its own load declares no chart listener.
  await verifyProtectedChartListenerRefusals(port, (declared) =>
    loadInstallationFile(t, configuration, {
      ...options,
      environment: { OCC_OPENSHELL_GIT_PORT: declared, OCC_EGRESS_AUTHORITY_PORT: "disabled" },
    }),
  );
  const drivers = await loadInstallationFile(t, configuration, options);
  assert.ok(drivers);
  const { computeDriver, protectedDriver: owner, proxyDriver, sandboxDriver: sandbox } = drivers;
  assert.ok(owner && proxyDriver);
  assert.ok(sandbox instanceof OpenShellSandboxDriver);
  assert.ok(computeDriver instanceof KubernetesComputeDriver);
  assert.equal(owner.require("sandbox"), sandbox);
  assert.equal(owner.require("credential_proxy"), proxyDriver);
  assert.ok(drivers.repositoryOwner);
  assert.equal(drivers.repositoryOwner.controlSocket, undefined);
  assert.equal(drivers.nativeRepositorySender, undefined);
  assert.ok(owner.allowsOrdinaryCredentialGateway());
  assert.ok(drivers.repositoryTransport);
  const protectedGit = { ...drivers, computeDriver, proxyDriver, sandboxDriver: sandbox };
  // Release labels do not qualify the sender; runtime proof still gates material.
  await verifyProtectedGatewayAdmission({
    signal: t.signal,
    setGatewayVersion: (version) => {
      repositoryGatewayVersion = version;
    },
    sourceControl: proxyDriver.sourceControl,
    validateRepositoryCredentials: (harness) =>
      computeDriver.validateRepositoryCredentials({ ...harness, version: "1.0.0" }, sandbox.id),
  });
  const { context, revision: fixtureRevision, requirements } = runtimeSandboxFixture(sandbox);
  // Revision execution starts in an existing, owned Workspace. Its deletion must remain observable.
  gateway.workspaces.set(openShellWorkspaceName(context.namespace), {
    ...ownedWorkspace(openShellWorkspaceName(context.namespace), context.namespace.id),
    id: "workspace-id",
  });
  assert.ok(drivers.credentialGatewayDriver);
  const loginMode = requirements.loginMode;
  assert.equal(loginMode, "api_key");
  const auth = {
    method: "credential_source",
    sourceId: "cs_test",
    sourceType: "openai",
    credentialGatewayId: drivers.credentialGatewayDriver.id,
    loginMode,
  } satisfies Extract<HarnessAuthSnapshot, { method: "credential_source" }>;
  const inferenceProvider = openShellProviderName(auth.sourceId);
  requirements.credentialAttachments = [{ sourceId: auth.sourceId, ref: inferenceProvider }];
  gateway.providers.set(inferenceProvider, {
    name: inferenceProvider,
    id: "inference-provider-id",
    type: "inference-profile",
    workspace: openShellWorkspaceName(context.namespace),
    profileWorkspace: openShellWorkspaceName(context.namespace),
    config: {},
    labels: {},
    resourceVersion: "1",
  });
  gateway.profiles.set("inference-profile", {
    id: "inference-profile",
    resourceVersion: "1",
    annotations: {},
    definition: {
      credentials: [{ env_vars: ["MODEL_API_KEY"] }],
      endpoints: [{ host: "api.openai.com", port: 443, protocol: "rest" }],
    },
  });
  const repositoryCredentials = {
    driver: { id: "repository-credentials", implementation: "github" },
    deadlineWallMs: Date.now() + 600000,
    bindings: [
      resolveGitHubRepositoryBinding(registry, {
        namespaceId: fixtureRevision.namespaceId,
        repositoryRef: "source",
        profile: "git-write",
      }),
    ],
  } satisfies NonNullable<AgentRevision["repositoryCredentials"]>;
  const revision = { ...completeSandboxRevision(fixtureRevision, auth), repositoryCredentials };

  async function loadSandbox(candidate: unknown): Promise<OpenShellSandboxDriver> {
    const result = await loadInstallationFile(t, candidate, options);
    assert.ok(result?.sandboxDriver instanceof OpenShellSandboxDriver);
    return result.sandboxDriver;
  }

  return {
    protectedGit,
    owner,
    sandbox,
    context,
    revision,
    requirements,
    auth,
    inferenceProvider,
    gateway,
    getCreated: () => created,
    restoreCreated: (request: OpenShellSandboxCreateRequest | undefined) => {
      created = request;
    },
    registry,
    workspaceMountPath,
    sandboxConfiguration,
    backend,
    authorityPort,
    tlsDirectory: tls.directory,
    loadSandbox: (candidate: OpenShellSandboxDriverOptions) =>
      loadSandbox({
        ...configuration,
        drivers: {
          ...configuration.drivers,
          sandbox: { ...base.drivers.sandbox, configuration: candidate },
        },
      }),
    reloadWithRegistry: (path: string) =>
      loadSandbox({ ...configuration, backend: [gatewayBackend, repositoryBackend(path)] }),
  };
}

// Production configuration and Sandbox provisioning, with controlled gateway observations.
// This proves the join and fail-closed lifecycle, not an installed stock supervisor or GitHub.
export function registerProtectedOpenShellGitCases() {
  test("protected repository policy pins the actual Compute runtime images", async (t) => {
    const connect = t.mock.method(Socket.prototype, "connect", () =>
      assert.fail("no network connections"),
    );
    const listen = t.mock.method(Server.prototype, "listen", () =>
      assert.fail("no runtime listeners"),
    );
    await verifyProtectedRepositoryRuntimeImages(
      await configureProtectedOpenShellGit(t, "legacy", false),
    );
    assert.equal(connect.mock.callCount(), 0);
    assert.equal(listen.mock.callCount(), 0);
  });

  test("managed Codex requires the exact inspected release and route before Workspace provisioning", async (t) => {
    const connect = t.mock.method(Socket.prototype, "connect", () => assert.fail("no connections"));
    const listen = t.mock.method(Server.prototype, "listen", () => assert.fail("no listeners"));
    const fixture = await configureProtectedOpenShellGit(t, "service", false);
    const { protectedGit, sandbox, context } = fixture;
    assert.ok(sandbox instanceof ManagedOpenShellSandbox);
    const compute = protectedGit.computeDriver;
    const unqualified = capturedWorkspaceRevision(fixture, compute);
    assert.throws(
      () => compute.validateProtectedRepositoryNetworkPolicy(unqualified),
      /cannot share Workspace node enrollment over WSS/,
    );
    const selection = selectFixtureRelease(t);
    assert.throws(
      () => compute.validateProtectedRepositoryNetworkPolicy(unqualified),
      /images or policy no longer match/,
    );
    const revision = capturedWorkspaceRevision(fixture, compute);
    const worker = new ControllerWorker({
      computeDriver: compute,
      sandboxDriver: sandbox,
      pool: {
        async connect() {
          assert.fail("no database transactions");
        },
        async end() {
          assert.fail("no database pool shutdown");
        },
        async query() {
          assert.fail("no database queries");
        },
      },
    });
    // OCC owns the Sandbox check at admission. The worker and direct Compute
    // callers must still refuse a Sandbox that no longer accepts this revision.
    const refusal = new Error("Sandbox refuses the saved policy");
    const sandboxValidator = t.mock.method(
      sandbox,
      "validateProtectedRepositoryNetworkPolicy",
      () => {
        throw refusal;
      },
    );
    compute.validateProtectedRepositoryNetworkPolicy(revision);
    assert.equal(sandboxValidator.mock.callCount(), 0);
    await assert.rejects(worker["validateExecutionAdmission"](revision, "reconcile"), refusal);
    await worker["validateExecutionAdmission"](revision, "withdraw");
    assert.equal(sandboxValidator.mock.callCount(), 1);
    await assert.rejects(compute.prepareRevision(revision), refusal);
    assert.equal(sandboxValidator.mock.callCount(), 2);
    assert.equal(fixture.getCreated(), undefined);
    sandboxValidator.mock.restore();
    // Promote the same two content digests into a different registry and
    // installation. The new route must be captured by its own revision.
    const options = compute["options"];
    const nodeEnrollment = compute["nodeEnrollment"];
    const { credentialGatewayDriver } = protectedGit;
    assert.ok(options.gatewayRouting && nodeEnrollment && credentialGatewayDriver);
    const promoted = new KubernetesComputeDriver(
      {
        ...options,
        images: {
          ...options.images,
          gateway: options.images.gateway.replace(
            "registry.example.test",
            "production.example.test",
          ),
          agent: options.images.agent.replace("registry.example.test", "production.example.test"),
        },
        gatewayRouting: { ...options.gatewayRouting, hostname: "agents.example.test" },
      },
      {
        id: compute.id,
        implementation: compute.implementation,
        protectedDriver: fixture.owner,
        credentialGatewayDriver,
        nodeEnrollment,
      },
    );
    const promotedRevision = capturedWorkspaceRevision(fixture, promoted);
    assert.ok(promotedRevision.compute.runtimeInputs.includes("wss://agents.example.test/"));
    promoted.validateProtectedRepositoryNetworkPolicy(promotedRevision);
    assert.throws(
      () => promoted.validateProtectedRepositoryNetworkPolicy(revision),
      /images or policy no longer match/,
    );
    assert.throws(
      () =>
        compute.validateProtectedRepositoryNetworkPolicy({
          ...revision,
          compute: {
            ...revision.compute,
            runtimeInputs: revision.compute.runtimeInputs.replace(
              "workspace.example.test",
              "agents.example.test",
            ),
          },
        }),
      /images or policy no longer match/,
    );
    const plan = revision.egressPlan;
    const ownership = {
      namespaceId: revision.namespaceId,
      agentId: revision.agentId,
      revisionId: revision.id,
      servicePrincipalId: revision.servicePrincipalId,
    };
    const deployment = compute["deployment"](
      "fixture-gateway",
      ownership,
      { name: "fixture-namespace", plane: "control" },
      compute["workloadImages"](revision, "gateway"),
      "fixture-gateway",
      "gateway",
      { APP_SERVER_URL: "https://harness.example.test" },
      "info",
      compute["gatewayConfiguration"](revision, undefined, {
        name: "fixture-namespace",
        plane: "control",
      }),
    );
    const pod = asRecord(asRecord(deployment.spec?.template)?.spec);
    const containers = pod?.containers;
    assert.ok(Array.isArray(containers));
    const gatewayContainer = asRecord(containers[0]);
    const bindingPath = "/run/openclaw-workspace-node/workspace-node.json";
    const expectedProgram = gatewayRuntimeEntrypoint(true, {
      kind: "inspected-dedicated-codex",
      revisionId: revision.id,
      bindingPath,
    });
    assert.ok(expectedProgram.includes("boundedReplies = true"));
    assert.deepEqual(gatewayContainer?.args, nodeProgramArguments(expectedProgram));
    const gatewayEnv = gatewayContainer?.env;
    assert.ok(Array.isArray(gatewayEnv));
    assert.deepEqual(
      gatewayEnv.find((v) => asRecord(v)?.name === "OPENCLAW_WORKSPACE_NODE_PATH"),
      { name: "OPENCLAW_WORKSPACE_NODE_PATH", value: bindingPath },
    );
    const launch = compute["harnessLaunch"]({
      name: "fixture-harness",
      ownership,
      image: compute["workloadImages"](revision, "agent").runtime,
      serviceAccountName: "fixture-harness",
      environment: {},
      loggingLevel: "info",
      auth: {
        loginMode: "api_key",
        environment: [{ name: "APP_TOKEN_SHA", value: "a".repeat(64) }],
      },
      provider: true,
      codexLaunch: compute["codexLaunch"](revision, sandbox),
    });
    const setupName = "fixture-node";
    const withWorkspace = compute["harnessLaunchWithNode"](launch, {
      name: setupName,
      native: false,
      revision,
      provider: true,
      setupFile: false,
      codexLaunch: compute["codexLaunch"](revision, sandbox),
    });
    const requirements: HarnessWorkloadRequirements = compute["sandboxRequirements"](
      withWorkspace,
      revision.agentId,
      fixture.requirements.credentialAttachments,
    );
    const expectedUrl = compute.getGatewayEndpoint(revision) + "/node";
    const marker = "OCE_INSPECTED_WORKSPACE_NODE_URL";
    assert.deepEqual(
      requirements.environment.find(({ name }) => name === marker),
      { name: marker, value: expectedUrl },
    );
    assert.deepEqual(requirements.workspaceMounts, []);
    const proxyWiring = await protectedGit.proxyDriver.configureRevision({
      ...context,
      revision,
      plan,
    });
    const harness = { ...context, revision, requirements: { ...requirements, proxyWiring } };
    type SetupLookup = Readonly<{ metadata: Parameters<typeof workspaceNodeSetupSecret>[0] }>;
    const read = t.mock.method(context.kubernetes, "read", async ({ metadata }: SetupLookup) =>
      workspaceNodeSetupSecret(
        metadata,
        revision.namespaceId,
        revision.agentId,
        workspaceNodeSetupSecretData({
          url: expectedUrl,
          bootstrapToken: "fixture-setup",
          expiresAtMs: Date.now() + 60_000,
        }),
      ),
    );
    selection.mock.restore();
    await assert.rejects(sandbox.provisionHarness(harness), /inspected transport is qualified/);
    assert.equal(read.mock.callCount(), 0);

    selectFixtureRelease(t);
    compute.validateProtectedRepositoryNetworkPolicy(revision);
    await assert.rejects(
      sandbox.provisionHarness({
        ...harness,
        requirements: { ...harness.requirements, image: "unknown:latest" },
      }),
      /inspected transport is qualified/,
    );
    assert.equal(read.mock.callCount(), 0);
    // Consume the exact generated requirement and the independently verified Secret.
    const material = await harnessRuntimeCredentials(harness);
    assert.equal(material.binding?.inspected, true);
    const spec = sandbox["harnessSpec"](
      harness,
      "runtime-files",
      new Set(["OPENCLAW_NODE_SETUP_CODE"]),
      material.binding,
    );
    assert.equal(Object.hasOwn(spec.environment, marker), false);
    const path = new URL(expectedUrl).pathname;
    const policy = asRecord(spec.policy.network_policies)?.["workspace-node-enrollment"];
    assert.deepEqual(policy, {
      name: "workspace-node-enrollment",
      binaries: [{ path: "/usr/local/bin/node" }],
      endpoints: [
        {
          host: new URL(expectedUrl).hostname,
          ports: [443],
          protocol: "websocket",
          path,
          enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
          rules: [
            { allow: { method: "GET", path } },
            { allow: { method: "WEBSOCKET_TEXT", path } },
          ],
          deny_rules: [{ method: "HEAD", path }],
        },
        {
          host: new URL(expectedUrl).hostname,
          ports: [443],
          protocol: "rest",
          path: path + "/__openclaw__/native-hook/codex-" + "[0123456789abcdef]".repeat(40),
          enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
          rules: [
            {
              allow: {
                method: "POST",
                path: path + "/__openclaw__/native-hook/codex-" + "[0123456789abcdef]".repeat(40),
              },
            },
          ],
        },
      ],
    });
    for (const setup of [
      { url: expectedUrl.replace("workspace.example.test", "alias.example.test") },
      { url: expectedUrl.replace("wss:", "ws:") },
      { url: expectedUrl + "/other" },
      { url: expectedUrl, tlsFingerprint: "a".repeat(64) },
    ]) {
      read.mock.mockImplementation(async ({ metadata }: SetupLookup) =>
        workspaceNodeSetupSecret(
          metadata,
          revision.namespaceId,
          revision.agentId,
          workspaceNodeSetupSecretData({
            ...setup,
            bootstrapToken: "fixture-setup",
            expiresAtMs: Date.now() + 60_000,
          }),
        ),
      );
      await assert.rejects(
        harnessRuntimeCredentials(harness),
        /exact WSS route without a leaf pin/,
      );
    }
    for (const host of ["github.com", "api.github.com", "127.0.0.1", "[::1]", "*.example.test"]) {
      const url = "wss://" + host + path;
      read.mock.mockImplementation(async ({ metadata }: SetupLookup) =>
        workspaceNodeSetupSecret(
          metadata,
          revision.namespaceId,
          revision.agentId,
          workspaceNodeSetupSecretData({
            url,
            bootstrapToken: "fixture-setup",
            expiresAtMs: Date.now() + 60_000,
          }),
        ),
      );
      await assert.rejects(
        harnessRuntimeCredentials({
          ...harness,
          requirements: {
            ...harness.requirements,
            environment: requirements.environment.map((entry) =>
              entry.name === marker ? { name: marker, value: url } : entry,
            ),
          },
        }),
        /exact non-Git Gateway route|setup URL is invalid/,
      );
    }

    assert.deepEqual(spec.command.slice(0, 7), [
      "/usr/bin/tini",
      "-s",
      "-e",
      "143",
      "--",
      "node",
      "-e",
    ]);
    const [loader, ...pieces] = spec.command.slice(7);
    assert.ok(loader);
    const decode = loader.includes("brotliDecompressSync") ? brotliDecompressSync : inflateRawSync;
    const program = loader + decode(Buffer.from(pieces.join(""), "base64")).toString("utf8");
    const trustOffset = program.indexOf(inspectedWorkspaceNodeTrustPrelude);
    assert.ok(trustOffset >= 0, "the rendered Managed Harness carries the inspected trust prelude");
    const trustProgram = program.slice(
      trustOffset,
      trustOffset + inspectedWorkspaceNodeTrustPrelude.length,
    );
    const interception = await harnessTlsFixture(t);
    const gateway = await harnessTlsFixture(t);
    const env = {
      NODE_EXTRA_CA_CERTS: interception.rootCertificatePath,
      OPENCLAW_NODE_CA_PATH: gateway.rootCertificatePath,
      OPENCLAW_NODE_CA_PEM: "",
    };
    const execute = (values: Record<string, string>) =>
      runInNewContext(trustProgram, {
        process: { env: values },
        require: createRequire(import.meta.url),
      });
    execute(env);
    assert.equal(
      env.OPENCLAW_NODE_CA_PEM,
      interception.caBundle.trim() + "\n" + gateway.caBundle.trim(),
    );
    assert.equal(env.NODE_EXTRA_CA_CERTS, interception.rootCertificatePath);
    assert.throws(() => execute({ ...env, NODE_EXTRA_CA_CERTS: "" }), /requires the Sandbox CA/);
    assert.throws(
      () => execute({ ...env, NODE_TLS_REJECT_UNAUTHORIZED: "0" }),
      /certificate verification/,
    );
    assert.throws(
      () => execute({ ...env, OPENCLAW_NODE_CA_PATH: gateway.certPath }),
      /only CA certificates/,
    );
    assert.equal(connect.mock.callCount(), 0);
    assert.equal(listen.mock.callCount(), 0);
  });

  test(
    "configured protected OpenShell Git admits only the selected execution and network policy",
    { timeout: 30000 },
    async (t) => {
      const fixture = await configureProtectedOpenShellGit(t);
      // Exercise production composition through the admitted v5 online Sandbox spec. Only the selected
      // model source survives Git; the runtime-files provider cannot stand in for that source.
      await t.test(
        "protected Sandbox accepts only the separately admitted model alongside Git",
        (subtest) => verifyProtectedOpenShellGitExecution(subtest, fixture),
      );
    },
  );
  test(
    "managed Sandbox releases scoped Git after verifying inspected Workspace policy",
    { timeout: 30000 },
    async (t) =>
      verifyManagedScopedGitExecution(t, await configureProtectedOpenShellGit(t, "service"), true),
  );
  test(
    "managed Sandbox releases scoped Git for a successor of a Git-free revision",
    { timeout: 30000 },
    async (t) =>
      verifyManagedScopedGitExecution(t, await configureProtectedOpenShellGit(t, "service")),
  );
}
