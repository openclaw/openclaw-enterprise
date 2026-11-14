import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
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
  OpenShellSandboxDriver,
  type OpenShellSandboxDriverOptions,
} from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import type { OpenShellSandboxCreateRequest } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { formatStartupConfigurationFailure } from "../../apps/controller/src/startup-failure.ts";
import type {
  AgentRevision,
  HarnessAuthSnapshot,
  OpenShellBackendConfiguration,
} from "../../packages/contracts/src/index.ts";
import { bindReservedPortInProcess, reservePort } from "../helpers/available-port.ts";
import { harnessTlsFixture } from "../helpers/harness-tls.mjs";
import { loadInstallationFile } from "../helpers/installation-file.ts";
import { loader } from "../helpers/openshell-grpc-sdk.ts";
import { storedSandbox } from "./sandbox-driver-gateway-response-fixture.ts";
import { backendFor } from "./sandbox-driver-openshell-fixture.ts";
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
import { workspaceGatewayClient } from "./sandbox-workspace-gateway-fixture.ts";

export type ProtectedOpenShellGitFixture = Awaited<
  ReturnType<typeof configureProtectedOpenShellGit>
>;
export type ProtectedOpenShellGitExecution = (
  subtest: TestContext,
  fixture: ProtectedOpenShellGitFixture,
) => Promise<void>;

async function configureProtectedOpenShellGit(t: TestContext) {
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
  const workspaceMountPath = "/sandbox/repository";
  sandboxConfiguration.kubernetes.sandboxDataMount.mountPath = workspaceMountPath;
  const providerHarness = {
    namespace: "openshell-system",
    podLabels: { app: "openshell-gateway" },
    address: "10.43.0.50",
    port: 8080,
  } satisfies NonNullable<KubernetesComputeDriverOptions["network"]["providerHarness"]>;
  const registry = {
    version: 1,
    backendId: "github-primary",
    providerInstanceId: "github-primary",
    appId: "123",
    githubInstallationId: "456",
    maximumDurationSeconds: 3600,
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
  } satisfies GitHubRepositoryRegistry;
  const registryPath = join(tls.directory, "registry.json");
  await writeFile(registryPath, JSON.stringify(registry), { mode: 0o600 });
  // The Git worker binds its authority on this port in-process, well after the configuration
  // names it. Hold the port until then, so a test running in parallel cannot take it.
  const authorityPort = await reservePort();
  t.after(() => authorityPort.release());
  await bindReservedPortInProcess(authorityPort);
  const { port } = authorityPort;

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
  const network: typeof base.drivers.compute.configuration.network &
    Pick<KubernetesComputeDriverOptions["network"], "providerHarness" | "repositoryCredentials"> = {
    ...base.drivers.compute.configuration.network,
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
        access: "NETWORK_ACCESS_PRESET_READ_WRITE",
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
      phase: "SANDBOX_PHASE_READY",
      restartCount: 0,
    });
    gateway.sandboxes.set(request.name, sandbox);
    return sandbox;
  };
  gateway.getService = async (_workspace, sandbox, service) =>
    harnessService(sandbox, service, gateway.sandboxes.get(sandbox)?.serviceUrls[""]);
  gateway.getSandboxProviderStatus = async (workspace, sandbox, provider) => {
    const now = new Date().toISOString();
    const desired = {
      sandboxId: "sandbox-id",
      sandbox,
      providerId: provider + "-id",
      providerResourceVersion: "1",
      attachmentEpoch: "epoch-one",
      providerEnvRevision: "1",
      configRevision: "1",
      policyHash: "policy-one",
    };
    return {
      state: "PROVIDER_READINESS_STATE_READY",
      evaluatedTime: now,
      observedTime: now,
      networkInstanceId: "network-one",
      receipt: { workspace, provider, desired },
      observed: {
        ...desired,
        sessionId: "supervisor-one",
        sequence: "1",
        credentialsInstalled: true,
        policyActive: true,
        launchEnvironmentInstalled: true,
        processInstanceId: "process-one",
        reason: "",
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
      endpoints: [{ host: "api.openai.com", port: 443 }],
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
export function registerProtectedOpenShellGitCases(runExecution: ProtectedOpenShellGitExecution) {
  test(
    "configured protected OpenShell Git admits only the selected execution and network policy",
    { timeout: 30000 },
    async (t) => {
      const fixture = await configureProtectedOpenShellGit(t);
      // Exercise production composition through the admitted v5 online Sandbox spec. Only the selected
      // model source survives Git; the runtime-files provider cannot stand in for that source.
      await t.test(
        "protected Sandbox accepts only the separately admitted model alongside Git",
        (subtest) => runExecution(subtest, fixture),
      );
    },
  );
}
