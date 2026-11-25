import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import {
  openShellProviderName,
  openShellSourceCredentialEnvironment,
} from "../../apps/controller/src/backends/openshell.ts";
import {
  stagedHarnessSupervisor,
  STAGED_HARNESS_ACTIVATE,
  STAGED_HARNESS_PREPARE,
} from "../../apps/controller/src/drivers/sandbox/openshell-staged-harness.ts";
import {
  MANAGED_PLUGIN_CREDENTIAL_HELPER,
  managedCredentialAliasesEnvironment,
} from "../../apps/controller/src/drivers/sandbox/openshell-plugin-runtime.ts";
import { supportsOpenShellCredentialDeployment } from "../../apps/controller/src/composition/openshell-credential-admission.ts";
import { OpenShellCredentialProxyDriver } from "../../apps/controller/src/drivers/credential-proxy/openshell.ts";
import {
  narrowOpenShellRepositoryRoutes,
  openShellRepositoryCredentialRequests,
  openShellRepositoryDeploymentPolicy,
} from "../../apps/controller/src/drivers/credential-proxy/openshell-repository-policy.ts";
import { OCCPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import { managedGoogleInstall } from "../../apps/controller/src/drivers/plugin/google-workspace/install.ts";
import { managedMcpInstalls } from "../../apps/controller/src/drivers/plugin/managed-catalog.ts";
import {
  compileOpenShellCredentialPolicy,
  openShellCredentialProviderName,
} from "../../apps/controller/src/drivers/sandbox/openshell-credential-policy.ts";
import {
  NATIVE_WORKER_ENTRYPOINT,
  RUNTIME_WRAPPER_COMMAND,
} from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { encodeReplacementRuntime } from "../../apps/controller/src/drivers/compute/kubernetes/replacement-runtime.ts";
import { inspectedWorkspaceBuild } from "../../apps/controller/src/drivers/sandbox/inspected-workspace-release.ts";
import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import { ManagedOpenShellSandbox } from "../../apps/controller/src/drivers/sandbox/openshell/managed.ts";
import { workspaceNodePathFor } from "../../apps/controller/src/drivers/sandbox/openshell-workspace-node-policy.ts";
import {
  admitRepositoryNetworkPolicy,
  type AgentRevision,
  type DeploymentCredentialBinding,
} from "../../packages/contracts/src/index.ts";
import { SandboxRevisionUnsupportedError } from "../../packages/occ/src/index.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";
import { waitFor } from "../helpers/qa-wait.ts";
import { storedSandbox } from "./sandbox-driver-gateway-response-fixture.ts";
import { backendFor, openShellDriver } from "./sandbox-driver-openshell-fixture.ts";
import { openShellWorkspaceHarnessConfiguration } from "./sandbox-driver-installation-fixture.ts";
import { completeSandboxRevision } from "./sandbox-driver-revision-fixture.ts";
import {
  workspaceNodeSetupSecret,
  workspaceNodeSetupSecretData,
} from "./sandbox-driver-workspace-node-setup-fixture.ts";
import {
  harnessService,
  harnessRuntimeCommand,
  runtimeSandboxFixture,
} from "./sandbox-driver-startup-orchestration.ts";
import { workspaceGatewayClient } from "./sandbox-workspace-gateway-fixture.ts";

export async function verifyStagedModelPolicyObservation(
  t: TestContext,
  mode: "service" | "legacy",
): Promise<void> {
  const gateway = workspaceGatewayClient();
  const configuration = openShellWorkspaceHarnessConfiguration();
  configuration.integrationMode = mode;
  if (mode === "service") {
    configuration.kubernetes.sandboxDataMount.mountPath = "/sandbox/oce/workspace";
  }
  const selection = {
    id: "openshell-sandbox",
    backend: backendFor(gateway),
    stagedRepositoryPolicy: true,
  };
  const driver =
    mode === "service"
      ? new ManagedOpenShellSandbox(configuration, selection)
      : new OpenShellSandboxDriver(configuration, selection);
  const fixture = runtimeSandboxFixture(driver);
  if (mode === "service") {
    fixture.requirements.workspaceMounts = [];
  }
  fixture.requirements.credentialAttachments = [];
  const grant = {
    id: "model",
    binary: "/app/bin/model-client",
    host: "api.openai.com",
    ports: [{ from: 443, to: 443 }],
  };
  const request = {
    binary: grant.binary,
    host: grant.host,
    ports: grant.ports,
    requestPolicy: { type: "http" as const, method: "POST", path: "/v1/responses" },
  };
  const binding = {
    bindingRef: "model",
    sourceRef: {
      kind: "credential_source" as const,
      namespaceId: fixture.revision.namespaceId,
      id: "cs_fixture",
    },
    consumer: { kind: "model" as const, providerId: "openai" },
    projection: { environment: "OPENAI_API_KEY", presentation: "bearer" as const },
  };
  const revision: AgentRevision = {
    ...completeSandboxRevision(fixture.revision, {
      method: "credential_source",
      sourceId: binding.sourceRef.id,
      sourceType: "static",
      tokenServiceInstanceId: "tokens-fixture",
    }),
    credentialSources: [
      {
        sourceId: binding.sourceRef.id,
        sourceType: "static",
        tokenServiceInstanceId: "tokens-fixture",
      },
    ],
    executionAdmission: { version: 8, mode: "standalone" },
    sandboxPolicy: driver.admitNetworkPolicy([grant], 1),
    credentialDeployment: {
      driver: {
        id: driver.id,
        implementation: driver.implementation,
        configurationId: "a".repeat(64),
      },
      proxyDriverId: driver.id,
      networkAccessPolicy: {
        allowed: [{ binary: grant.binary, host: grant.host, ports: grant.ports }],
      },
      bindings: [binding],
      injectionPolicies: [{ bindingRef: binding.bindingRef, allowedRequests: [request] }],
    },
  };
  const context = { ...fixture.context, revision, requirements: fixture.requirements };
  let loaded: Record<string, unknown> = {};
  gateway.createSandbox = async (request) => {
    const sandbox = storedSandbox(request, {
      id: "sandbox-fixture",
      resourceVersion: "1",
      phase: "SANDBOX_PHASE_READY",
    });
    loaded = structuredClone(request.spec.policy as Record<string, unknown>);
    gateway.sandboxes.set(sandbox.name, sandbox);
    return sandbox;
  };
  gateway.getService = async (_workspace, name) =>
    harnessService(name, "", "http://codex.example.test:8080/");
  await driver.ensureNamespace(context);
  await driver.provisionStagedHarness(context);
  const sandbox = [...gateway.sandboxes.values()][0]!;
  const idle = sandbox.spec!.policy as Record<string, unknown> & {
    network_policies: Record<string, unknown>;
  };
  const provider = openShellProviderName(binding.sourceRef.id);
  gateway.sandboxes.set(sandbox.name, {
    ...sandbox,
    spec: { ...sandbox.spec!, providers: [provider] },
  });

  // A serving model Sandbox created by main stores the request path in its REST rule,
  // with no endpoint selector. Recovery must observe that exact policy as already applied.
  const retained = {
    ...idle,
    network_policies: {
      ...idle.network_policies,
      "oce-agent-model": {
        name: "oce-agent-model",
        binaries: [{ path: grant.binary }],
        endpoints: [
          {
            host: grant.host,
            ports: [443],
            protocol: "rest",
            enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
            rules: [{ allow: { method: "POST", path: "/v1/responses" } }],
            credential_binding: { provider },
          },
        ],
      },
    },
  };
  loaded = retained;
  gateway.getPolicyStatus = async () => ({
    policy: loaded,
    version: 1,
    activeVersion: 1,
    state: "POLICY_STATUS_LOADED",
  });
  async function assertBaselineMismatch(
    target: typeof context,
    snapshot: NonNullable<AgentRevision["sandboxPolicy"]>,
  ): Promise<void> {
    if (mode === "service") {
      await assert.rejects(
        driver.observeNetworkPolicy(target, snapshot),
        /Live Sandbox policy differs from its admitted baseline/,
      );
    } else {
      assert.equal((await driver.observeNetworkPolicy(target, snapshot)).matches, false);
    }
  }
  assert.equal((await driver.observeNetworkPolicy(context, revision.sandboxPolicy!)).matches, true);
  for (const name of ["oce-proxy-credential-unadmitted", "oce-staged-http-unadmitted"]) {
    loaded = {
      ...retained,
      network_policies: {
        ...retained.network_policies,
        [name]: retained.network_policies["oce-agent-model"],
      },
    };
    await assertBaselineMismatch(context, revision.sandboxPolicy!);
  }
  loaded = retained;

  gateway.updatePolicy = async ({ policy }) => {
    loaded = structuredClone(policy);
  };
  await driver.applyNetworkPolicy(context, {
    snapshot: revision.sandboxPolicy!,
    expectedProviderVersion: "1",
    operationId: revision.id,
  });
  assert.deepEqual(loaded, retained, "new model-only policy keeps the same canonical shape");
  assert.equal((await driver.observeNetworkPolicy(context, revision.sandboxPolicy!)).matches, true);

  // A new revision combines the model with native Git. The Proxy, rather than the
  // generic Sandbox compiler, owns Git's exact service-query authorization.
  const repositoryGrants = [{ repository: "fixture/repository", access: "read" }] as const;
  const repositoryRequests = openShellRepositoryCredentialRequests(repositoryGrants);
  const repositoryBinding = {
    bindingRef: "repository",
    sourceRef: {
      kind: "credential_source",
      namespaceId: revision.namespaceId,
      id: "cs_repository",
    },
    consumer: { kind: "repository" },
    projection: { environment: "GITHUB_TOKEN", presentation: "github_repository" },
  } as const;
  // Simulate the trusted build-time release selection; this does not qualify a live image.
  const gatewayDigest = "sha256:" + "a".repeat(64);
  const agentDigest = "sha256:" + "b".repeat(64);
  t.mock.getter(inspectedWorkspaceBuild, "release", () => ({ gatewayDigest, agentDigest }));
  const gatewayImage = `docker.io/example/gateway@${gatewayDigest}`;
  const agentImage = `docker.io/example/agent@${agentDigest}`;
  const workspaceUrl = `wss://gateway.example.test${workspaceNodePathFor(revision.namespaceId, revision.agentId)}`;
  const repositoryRevision: AgentRevision = {
    ...revision,
    id: "rev_00000000-0000-4000-8000-000000000002",
    gatewayManagedMode: true,
    compute: {
      ...revision.compute,
      runtimeInputs: encodeReplacementRuntime({
        scope: "repository-policy",
        gateway: gatewayImage,
        agent: agentImage,
        compatibility: "a".repeat(64),
        workspace: { url: workspaceUrl, mode },
      }),
    },
    credentialSources: [
      ...revision.credentialSources!,
      {
        sourceId: repositoryBinding.sourceRef.id,
        sourceType: "github-app-installation",
        tokenServiceInstanceId: "tokens-fixture",
      },
    ],
    repositoryCredentials: {
      authorization: "credential_source",
      driver: { id: "repository", implementation: "github" },
      bindings: [
        {
          repositoryRef: "repository",
          profile: "github-repository",
          backendId: "github-primary",
          grant: { providerInstanceId: "github", repositoryId: "42", grantId: "repository" },
        },
      ],
    },
    sandboxPolicy: {
      ...revision.sandboxPolicy!,
      repositoryNetworkPolicy: admitRepositoryNetworkPolicy(repositoryGrants, repositoryGrants)!,
    },
    credentialDeployment: {
      ...revision.credentialDeployment!,
      bindings: [binding, repositoryBinding],
      networkAccessPolicy: {
        allowed: [
          ...revision.credentialDeployment!.networkAccessPolicy.allowed,
          ...repositoryRequests,
        ],
      },
      injectionPolicies: [
        {
          ...revision.credentialDeployment!.injectionPolicies[0]!,
          allowedRequests: [
            request,
            {
              ...request,
              requestPolicy: { type: "http", method: "POST", path: "/v1/chat/completions" },
            },
          ],
        },
        { bindingRef: repositoryBinding.bindingRef, allowedRequests: repositoryRequests },
      ],
    },
  };
  const repositoryContext = {
    ...context,
    revision: repositoryRevision,
    requirements: {
      ...context.requirements,
      image: agentImage,
      environment: [
        ...context.requirements.environment,
        { name: "OCE_INSPECTED_WORKSPACE_NODE_URL", value: workspaceUrl },
      ],
      labels: { ...context.requirements.labels, "openclaw.dev/revision": repositoryRevision.id },
    },
  };
  const readSecret = repositoryContext.kubernetes.read;
  repositoryContext.kubernetes.read = async (request) =>
    request.metadata.name === "workspace-node"
      ? workspaceNodeSetupSecret(
          request.metadata,
          repositoryRevision.namespaceId,
          repositoryRevision.agentId,
          workspaceNodeSetupSecretData({
            url: workspaceUrl,
            bootstrapToken: fixture.nodeSetup.bootstrapToken,
            expiresAtMs: fixture.nodeSetup.expiresAtMs,
          }),
        )
      : readSecret(request);
  // Exercise native Repository composition on a fresh target; the staged recipient must not
  // enter the old prepared Git broker or attach its Provider before Proxy configuration.
  gateway.sandboxes.clear();
  await driver.provisionStagedHarness(repositoryContext);
  const repositorySandboxName = driver.harnessResource(repositoryContext).resourceName;
  const repositorySandbox = gateway.sandboxes.get(repositorySandboxName)!;
  const repositoryProvider = openShellCredentialProviderName(repositoryBinding);
  const idleProviders = repositorySandbox.spec!.providers;
  assert.ok(Array.isArray(idleProviders));
  assert.equal(idleProviders.includes(repositoryProvider), false);
  assert.equal(Object.hasOwn(repositorySandbox.spec!.environment ?? {}, "GITHUB_TOKEN"), false);
  // Use the Sandbox's actual startup settings with stock Git. Its credential lookup must
  // receive only the projected marker for the saved HTTPS repository and no other origin/path.
  const marker = `openshell:resolve:env:s${"a".repeat(64)}_GITHUB_TOKEN`;
  const repositoryEnvironment = repositorySandbox.spec!.environment;
  assert.ok(
    typeof repositoryEnvironment === "object" &&
      repositoryEnvironment !== null &&
      !Array.isArray(repositoryEnvironment),
  );
  const gitEnvironment: NodeJS.ProcessEnv = {
    PATH: "/usr/bin:/bin",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    HOME: "/tmp",
    GITHUB_TOKEN: marker,
  };
  for (const [name, value] of Object.entries(repositoryEnvironment)) {
    if (name.startsWith("GIT_")) {
      assert.ok(typeof value === "string");
      gitEnvironment[name] = value;
    }
  }
  const credential = (host: string, path: string, protocol = "https") =>
    spawnSync("/usr/bin/git", ["credential", "fill"], {
      cwd: "/tmp",
      env: gitEnvironment,
      encoding: "utf8",
      input: `protocol=${protocol}\nhost=${host}\npath=${path}\n\n`,
    });
  const allowedCredential = credential("github.com", `${repositoryGrants[0]!.repository}.git`);
  assert.equal(allowedCredential.status, 0);
  assert.match(allowedCredential.stdout, /^username=x-access-token$/m);
  assert.ok(allowedCredential.stdout.includes(`password=${marker}\n`));
  for (const denied of [
    credential("github.com", "fixture/unapproved.git"),
    credential("github.com", `${repositoryGrants[0]!.repository}.git/unapproved`),
    credential("github.com.evil.test", `${repositoryGrants[0]!.repository}.git`),
    credential("github.com", `${repositoryGrants[0]!.repository}.git`, "http"),
  ]) {
    assert.notEqual(denied.status, 0);
    assert.equal(denied.stdout.includes(marker), false);
  }
  const repositoryIdle = repositorySandbox.spec!.policy as Record<string, unknown>;
  const repositoryRoutes = narrowOpenShellRepositoryRoutes(
    repositoryRevision,
    compileOpenShellCredentialPolicy(
      repositoryRevision.credentialDeployment!,
      repositoryRevision.sandboxPolicy!.defaults,
    ).credentialRoutes,
  );
  const combined = openShellRepositoryDeploymentPolicy(
    repositoryRevision,
    repositoryIdle,
    repositoryRoutes,
  ).combined as Record<string, unknown> & {
    network_policies: Record<string, Record<string, unknown>>;
  };
  gateway.sandboxes.set(repositorySandboxName, {
    ...repositorySandbox,
    spec: {
      ...repositorySandbox.spec!,
      providers: [provider, repositoryProvider],
      policy: combined,
    },
  });
  loaded = combined;
  const discoveryEntry = Object.entries(combined.network_policies).find(([, rule]) =>
    (rule.endpoints as Record<string, unknown>[]).some(
      (endpoint) => endpoint.path === "/fixture/repository.git/info/refs",
    ),
  );
  assert.ok(discoveryEntry);
  const discovery = (discoveryEntry[1].endpoints as Record<string, unknown>[])[0]!;
  const allowed = (discovery.rules as { allow: Record<string, unknown> }[])[0]!.allow;
  assert.deepEqual(allowed, {
    method: "GET",
    path: "/fixture/repository.git/info/refs",
    query: { service: { glob: "git-upload-pack" } },
  });
  assert.equal(
    (await driver.observeNetworkPolicy(repositoryContext, repositoryRevision.sandboxPolicy!))
      .matches,
    true,
  );

  const stagedEntry = Object.entries(combined.network_policies).find(([name]) =>
    name.startsWith("oce-staged-http-"),
  );
  assert.ok(stagedEntry, "multiple model requests require staged HTTP policy rules");
  const extraStaged = structuredClone(combined);
  extraStaged.network_policies["oce-staged-http-unadmitted"] = structuredClone(stagedEntry[1]);
  loaded = extraStaged;
  assert.equal(
    (await driver.observeNetworkPolicy(repositoryContext, repositoryRevision.sandboxPolicy!))
      .matches,
    false,
  );
  const alteredStaged = structuredClone(combined);
  const alteredEndpoint = (
    alteredStaged.network_policies[stagedEntry[0]]!.endpoints as Record<string, unknown>[]
  )[0]!;
  (alteredEndpoint.rules as { allow: Record<string, unknown> }[])[0]!.allow.path = "/v1/unadmitted";
  loaded = alteredStaged;
  assert.equal(
    (await driver.observeNetworkPolicy(repositoryContext, repositoryRevision.sandboxPolicy!))
      .matches,
    false,
  );

  // Prefixes partition reconciliation ownership; they do not authorize extra routes.
  const unadmittedRoute = structuredClone(combined);
  unadmittedRoute.network_policies["oce-proxy-credential-unadmitted"] = structuredClone(
    discoveryEntry[1],
  );
  loaded = unadmittedRoute;
  assert.equal(
    (await driver.observeNetworkPolicy(repositoryContext, repositoryRevision.sandboxPolicy!))
      .matches,
    false,
  );

  // The creation annotation still binds fixed Sandbox policy independently of dynamic rules.
  const changedBaseline = structuredClone(combined);
  changedBaseline.network_policies["unadmitted-fixed"] = structuredClone(discoveryEntry[1]);
  loaded = changedBaseline;
  await assertBaselineMismatch(repositoryContext, repositoryRevision.sandboxPolicy!);

  // A broad discovery query or a missing Git rule must not be accepted as ready.
  const queryless = structuredClone(combined);
  const querylessEndpoint = (
    queryless.network_policies[discoveryEntry[0]]!.endpoints as Record<string, unknown>[]
  )[0]!;
  delete (querylessEndpoint.rules as { allow: Record<string, unknown> }[])[0]!.allow.query;
  loaded = queryless;
  assert.equal(
    (await driver.observeNetworkPolicy(repositoryContext, repositoryRevision.sandboxPolicy!))
      .matches,
    false,
  );
  const missing = structuredClone(combined);
  delete missing.network_policies[discoveryEntry[0]];
  loaded = missing;
  assert.equal(
    (await driver.observeNetworkPolicy(repositoryContext, repositoryRevision.sandboxPolicy!))
      .matches,
    false,
  );
}

export async function verifyStagedCodexAccountProjection(t: TestContext): Promise<void> {
  const home = await temporaryDirectory(t, "staged-codex-account-");
  const marker = join(home, "launch.json");
  const placeholder = `openshell:resolve:env:s${"a".repeat(64)}_CODEX_ACCESS_TOKEN`;
  const account = { accountId: "account-fixture", planType: "business", isFedramp: false };
  const launcher = stagedHarnessSupervisor([
    process.execPath,
    "-e",
    `require("node:fs").writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ placeholder: process.env.CODEX_ACCESS_TOKEN, account: JSON.parse(process.env.OCE_CODEX_CHATGPT_ACCOUNT) }))`,
  ]);
  const supervisor = spawn(process.execPath, ["-e", launcher], {
    env: { ...process.env, HOME: home },
    stdio: "ignore",
  });
  t.after(() => supervisor.kill());
  await waitFor(
    "Codex staged supervisor",
    () => existsSync(join(home, ".oce-staged-harness.sock")),
    5000,
  );
  const projection = {
    bindingRef: "model",
    environment: "CODEX_ACCESS_TOKEN",
    placeholder: { kind: "runtime" },
    account,
  };
  const prepare = spawnSync(process.execPath, ["-e", STAGED_HARNESS_PREPARE], {
    env: { ...process.env, HOME: home },
    input: JSON.stringify([projection]),
  });
  assert.equal(prepare.status, 0);
  const activate = spawnSync(process.execPath, ["-e", STAGED_HARNESS_ACTIVATE], {
    env: { ...process.env, HOME: home, CODEX_ACCESS_TOKEN: placeholder },
  });
  assert.equal(activate.status, 0);
  await waitFor("Codex staged launch", () => existsSync(marker), 5000);
  assert.deepEqual(JSON.parse(readFileSync(marker, "utf8")), { placeholder, account });
}

export async function verifyStagedNativeSourceProjection(t: TestContext): Promise<void> {
  const home = await temporaryDirectory(t, "staged-native-source-");
  const marker = join(home, "launch.json");
  const modelAlias = openShellSourceCredentialEnvironment("cs_model_fixture");
  const pluginAlias = openShellSourceCredentialEnvironment("cs_plugin_fixture");
  const modelPlaceholder = `openshell:resolve:env:s${"a".repeat(64)}_${modelAlias}`;
  const pluginPlaceholder = `openshell:resolve:env:s${"b".repeat(64)}_${pluginAlias}`;
  const launcher = stagedHarnessSupervisor([
    process.execPath,
    "-e",
    `${MANAGED_PLUGIN_CREDENTIAL_HELPER}
require("node:fs").writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
  model: process.env.OPENAI_API_KEY,
  plugin: process.env.GOOGLE_TOKEN,
  pluginAccepted: isManagedPluginPlaceholder("GOOGLE_TOKEN", process.env.GOOGLE_TOKEN, "cli"),
  wrongSourceAccepted: isManagedPluginPlaceholder("GOOGLE_TOKEN", process.env.OPENAI_API_KEY, "cli"),
  modelAliasPresent: Object.hasOwn(process.env, ${JSON.stringify(modelAlias)}),
  pluginAliasPresent: Object.hasOwn(process.env, ${JSON.stringify(pluginAlias)}),
  aliasMapPresent: Object.hasOwn(process.env, ${JSON.stringify(managedCredentialAliasesEnvironment)})
}));`,
  ]);
  const supervisor = spawn(process.execPath, ["-e", launcher], {
    env: {
      ...process.env,
      HOME: home,
      [modelAlias]: "inherited-model-value",
      [pluginAlias]: "inherited-plugin-value",
      [managedCredentialAliasesEnvironment]: JSON.stringify({ GOOGLE_TOKEN: modelAlias }),
    },
    stdio: "ignore",
  });
  t.after(() => supervisor.kill());
  await waitFor(
    "native Source staged supervisor",
    () => existsSync(join(home, ".oce-staged-harness.sock")),
    5000,
  );
  const projections = [
    {
      bindingRef: "model",
      environment: "OPENAI_API_KEY",
      placeholder: { kind: "runtime" },
      runtimeEnvironment: modelAlias,
    },
    {
      bindingRef: "plugin",
      environment: "GOOGLE_TOKEN",
      placeholder: { kind: "runtime" },
      runtimeEnvironment: pluginAlias,
      plugin: true,
    },
  ];
  const prepare = spawnSync(process.execPath, ["-e", STAGED_HARNESS_PREPARE], {
    env: { ...process.env, HOME: home },
    input: JSON.stringify(projections),
  });
  assert.equal(prepare.status, 0);

  // Activation must refuse a Provider placeholder for the wrong Source, before launching the Harness.
  const wrong = spawnSync(process.execPath, ["-e", STAGED_HARNESS_ACTIVATE], {
    env: {
      ...process.env,
      HOME: home,
      [modelAlias]: modelPlaceholder,
      [pluginAlias]: modelPlaceholder,
    },
  });
  assert.notEqual(wrong.status, 0);
  assert.equal(existsSync(marker), false);
  const activate = spawnSync(process.execPath, ["-e", STAGED_HARNESS_ACTIVATE], {
    env: {
      ...process.env,
      HOME: home,
      [modelAlias]: modelPlaceholder,
      [pluginAlias]: pluginPlaceholder,
    },
  });
  assert.equal(activate.status, 0);
  await waitFor("native Source staged launch", () => existsSync(marker), 5000);

  // Only the requested consumer projections survive; the native aliases and private mapping do not.
  assert.deepEqual(JSON.parse(readFileSync(marker, "utf8")), {
    model: modelPlaceholder,
    plugin: pluginPlaceholder,
    pluginAccepted: true,
    wrongSourceAccepted: false,
    modelAliasPresent: false,
    pluginAliasPresent: false,
    aliasMapPresent: false,
  });
}

export async function stagedManagedMcpPolicy(): Promise<Record<string, unknown>> {
  const gateway = workspaceGatewayClient();
  const configuration = openShellWorkspaceHarnessConfiguration();
  const occBackend = backendFor(gateway);
  const driver = new OpenShellSandboxDriver(configuration, {
    id: "openshell-sandbox",
    implementation: "openshell",
    backend: occBackend,
  });
  const fixture = runtimeSandboxFixture(driver, { harnessId: "openclaw" });
  fixture.requirements.credentialAttachments = [];
  const modelGrant = {
    id: "model",
    binary: "/usr/local/bin/node",
    host: "api.openai.com",
    ports: [{ from: 443, to: 443 }],
  };
  const { binary, host, ports } = modelGrant;
  const modelRequest = {
    binary,
    host,
    ports,
    requestPolicy: { type: "http" as const, method: "POST", path: "/v1/responses" },
  };
  const model: DeploymentCredentialBinding = {
    bindingRef: "model",
    sourceRef: {
      kind: "credential_source",
      namespaceId: fixture.revision.namespaceId,
      id: "cs_model",
    },
    consumer: { kind: "model", providerId: "openai" },
    projection: { environment: "OPENAI_API_KEY", presentation: "bearer" },
  };
  const install = managedMcpInstalls.find(({ id }) => id === "occ-plugin:slack@1.0.0");
  assert.ok(install);
  const slot = install.slotId;
  const slackSource = { ...model.sourceRef, id: "cs_slack" };
  const selection = {
    enabled: true,
    driverPolicy: {
      releaseSha256: install.releaseSha256,
      credentials: { [slot]: slackSource.id },
      toolNames: ["slack_search_messages"],
    },
  };
  const description = await new OCCPluginDriver().describeDeployment({
    plugin: { catalog: "driver", pluginId: install.id },
    selection,
    connections: { [slot]: { default: slackSource } },
  });
  const account = description.credentials[slot]?.default;
  assert.ok(account);
  // Feed the qualifier the session and invocation requirements from the selected Plugin release.
  const requests = description.networkRequirements
    .filter(({ id }) => account.networkRequirementIds.includes(id))
    .map(({ match }) => match);
  const slack: DeploymentCredentialBinding = {
    bindingRef: JSON.stringify(["plugin", install.id, slot, "default"]),
    sourceRef: account.sourceRef,
    consumer: {
      kind: "plugin",
      pluginId: install.id,
      requirement: slot,
      connection: "default",
    },
    projection: account.projection,
  };
  const credentialDeployment: NonNullable<AgentRevision["credentialDeployment"]> = {
    driver: {
      id: driver.id,
      implementation: driver.implementation,
      configurationId: "a".repeat(64),
    },
    proxyDriverId: driver.id,
    networkAccessPolicy: { allowed: [{ binary, host, ports }, ...requests] },
    bindings: [model, slack],
    injectionPolicies: [
      { bindingRef: model.bindingRef, allowedRequests: [modelRequest] },
      { bindingRef: slack.bindingRef, allowedRequests: requests },
    ],
  };
  const revision: AgentRevision = {
    ...completeSandboxRevision(fixture.revision, {
      method: "credential_source",
      sourceId: model.sourceRef.id,
      sourceType: "static",
      tokenServiceInstanceId: "tokens",
    }),
    credentialSources: [model, slack].map(({ sourceRef }) => ({
      sourceId: sourceRef.id,
      sourceType: "static",
      tokenServiceInstanceId: "tokens",
    })),
    plugins: {
      driver: { id: "occ-plugin", implementation: "occ/openclaw-plugin" },
      plugins: { [install.id]: selection },
    },
    sandboxPolicy: driver.admitNetworkPolicy([modelGrant], 1),
    executionAdmission: { version: 8, mode: "standalone" },
    credentialDeployment,
  };
  const proxy = new OpenShellCredentialProxyDriver({
    id: driver.id,
    implementation: driver.implementation,
    tokenServiceImplementation: "occ/token-service",
    backend: occBackend,
    sandbox: driver,
  });
  assert.equal(
    supportsOpenShellCredentialDeployment({ sandbox: driver, proxy, policy: credentialDeployment }),
    true,
  );
  const nativeBackend = {
    ...occBackend,
    drivers: { sandbox: driver.id, token_service: "openshell-token-service" },
  };
  const nativeDriver = new OpenShellSandboxDriver(configuration, {
    id: driver.id,
    implementation: driver.implementation,
    backend: nativeBackend,
  });
  const nativeProxy = new OpenShellCredentialProxyDriver({
    id: driver.id,
    implementation: driver.implementation,
    tokenServiceImplementation: "openshell/token-service",
    backend: nativeBackend,
    sandbox: nativeDriver,
  });
  assert.equal(
    supportsOpenShellCredentialDeployment({
      sandbox: nativeDriver,
      proxy: nativeProxy,
      policy: credentialDeployment,
    }),
    true,
  );
  // Structural Driver-contract backstop: a Plugin Driver can describe two static-bearer
  // consumers whose Template permits both routes. The bundled catalog cannot currently
  // produce this pairing, so this does not claim a reachable bundled Plugin scenario.
  const sharedPluginSource = { ...slack.sourceRef, id: "cs_shared_plugin" };
  const pluginRequests = ["one", "two"].map((name) => ({
    binary: "/usr/local/bin/node",
    host: `${name}.example.test`,
    ports: [{ from: 443, to: 443 }],
    requestPolicy: { type: "http" as const, method: "GET", path: "/api" },
  }));
  const pluginBindings = ["one", "two"].map((name): DeploymentCredentialBinding => ({
    bindingRef: JSON.stringify(["plugin", `fixture-plugin:${name}`, "token", "default"]),
    sourceRef: sharedPluginSource,
    consumer: {
      kind: "plugin",
      pluginId: `fixture-plugin:${name}`,
      requirement: "token",
      connection: "default",
    },
    projection: { environment: `PLUGIN_${name.toUpperCase()}_TOKEN`, presentation: "bearer" },
  }));
  const duplicateSource = {
    ...credentialDeployment,
    networkAccessPolicy: { allowed: pluginRequests },
    bindings: pluginBindings,
    injectionPolicies: pluginBindings.map(({ bindingRef }, index) => ({
      bindingRef,
      allowedRequests: [pluginRequests[index]!],
    })),
  };
  assert.equal(gateway.sandboxes.size, 0);
  assert.equal(
    supportsOpenShellCredentialDeployment({
      sandbox: nativeDriver,
      proxy: nativeProxy,
      policy: duplicateSource,
    }),
    false,
  );
  assert.equal(
    supportsOpenShellCredentialDeployment({ sandbox: driver, proxy, policy: duplicateSource }),
    true,
  );
  assert.equal(gateway.sandboxes.size, 0);

  // Matching network and injection rules cannot move a managed credential off its reviewed endpoint.
  const movedRequests = requests.map((request) => ({ ...request, host: "mcp.example.test" }));
  const movedPolicy = {
    ...credentialDeployment,
    networkAccessPolicy: { allowed: [{ binary, host, ports }, ...movedRequests] },
    injectionPolicies: [
      credentialDeployment.injectionPolicies[0]!,
      { bindingRef: slack.bindingRef, allowedRequests: movedRequests },
    ],
  };
  assert.equal(
    supportsOpenShellCredentialDeployment({ sandbox: driver, proxy, policy: movedPolicy }),
    false,
  );

  const context = { ...fixture.context, revision, requirements: fixture.requirements };
  gateway.createSandbox = async (request) => {
    const sandbox = storedSandbox(request, {
      id: "sandbox-fixture",
      resourceVersion: "1",
      serviceUrls: {},
    });
    gateway.sandboxes.set(sandbox.name, sandbox);
    return sandbox;
  };
  await driver.ensureNamespace(context);
  const target = await driver.provisionStagedHarness(context);
  const sandbox = [...gateway.sandboxes.values()].find(({ id }) => id === target.sandboxId);
  assert.ok(sandbox);
  // The controlled Gateway represents attachments made by the Proxy before policy apply.
  const modelProvider = openShellCredentialProviderName(model);
  const slackProvider = openShellCredentialProviderName(slack);
  gateway.sandboxes.set(sandbox.name, {
    ...sandbox,
    spec: { ...sandbox.spec!, providers: [modelProvider, slackProvider] },
    resourceVersion: "2",
  });
  gateway.updatePolicy = async ({ policy, expectedResourceVersion }) => {
    const current = gateway.sandboxes.get(sandbox.name)!;
    assert.equal(expectedResourceVersion, current.resourceVersion);
    gateway.sandboxes.set(sandbox.name, { ...current, spec: { ...current.spec!, policy } });
  };
  const snapshot = revision.sandboxPolicy!;
  await driver.applyNetworkPolicy(context, {
    snapshot,
    expectedProviderVersion: "2",
    operationId: revision.id,
  });
  assert.equal((await driver.observeNetworkPolicy(context, snapshot)).matches, true);
  const loaded = gateway.sandboxes.get(sandbox.name)!.spec!.policy as {
    network_policies: Record<string, { endpoints: Record<string, unknown>[] }>;
  };
  const endpoint = Object.values(loaded.network_policies)
    .flatMap(({ endpoints }) => endpoints)
    .find(({ host }) => host === install.endpoint.host);
  // The native policy permits the session methods and exactly the selected tool.
  assert.deepEqual(endpoint, {
    host: "mcp.slack.com",
    ports: [443],
    path: "/mcp",
    protocol: "mcp",
    mcp: { strict_tool_names: true, versions: ["2025-03-26", "2025-06-18", "2025-11-25"] },
    enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
    rules: [
      { allow: { method: "ping" } },
      { allow: { method: "initialize" } },
      { allow: { method: "notifications/initialized" } },
      { allow: { method: "tools/list" } },
      { allow: { method: "tools/call", params: { name: { glob: "slack_search_messages" } } } },
    ],
    credential_binding: { provider: slackProvider },
  });
  return loaded;
}

export async function verifyStagedHarnessActivation(t: TestContext): Promise<void> {
  const directory = await temporaryDirectory(t, "staged-harness-");
  const marker = join(directory, "harness.json");
  const fresh = "openshell:resolve:env:v2_OPENAI_API_KEY";
  const freshPlugin = "openshell:resolve:env:v2_GOG_ACCESS_TOKEN";
  const gateway = workspaceGatewayClient();
  const configuration = openShellWorkspaceHarnessConfiguration();
  const driver = openShellDriver(gateway, {
    ...configuration,
    policy: {
      ...configuration.policy,
      networkPolicies: [
        ...configuration.policy.networkPolicies.map((rule) => ({
          ...rule,
          binaries: [{ path: "/usr/local/bin/node" }],
          endpoints: [
            { host: "api.openai.com", ports: [443, 9443] },
            { host: "status.example.test", ports: [443] },
          ],
        })),
        {
          name: "docs-egress",
          endpoints: [{ host: "docs.example.test", ports: [443] }],
          binaries: [{ path: "/usr/bin/curl" }],
        },
      ],
    },
  });
  const fixture = runtimeSandboxFixture(driver, { harnessId: "openclaw" });
  fixture.requirements.credentialAttachments = [];
  fixture.requirements.environment.push({ name: "MARKER", value: marker });
  // Keep the real native worker program in the rendered launch command. The controlled
  // entrypoint records activation first, instead of requiring a complete OpenClaw runtime.
  fixture.requirements.command = harnessRuntimeCommand(`(() => {
require("node:fs").writeFileSync(process.env.MARKER, JSON.stringify({ credential: process.env.OPENAI_API_KEY, pluginCredential: process.env.GOG_ACCESS_TOKEN }));
setInterval(() => {}, 1000);
return;
${NATIVE_WORKER_ENTRYPOINT}
})();`);
  const modelSourceId = "cs_fixture";
  const base = completeSandboxRevision(fixture.revision, {
    method: "credential_source",
    sourceId: modelSourceId,
    sourceType: "static",
    tokenServiceInstanceId: "tokens",
  });
  const grant = {
    id: "model",
    binary: "/usr/local/bin/node",
    host: "api.openai.com",
    ports: [
      { from: 443, to: 443 },
      { from: 8443, to: 8443 },
    ],
  };
  const request = {
    binary: grant.binary,
    host: grant.host,
    ports: [{ from: 443, to: 443 }],
    requestPolicy: { type: "http" as const, method: "POST", path: "/v1/responses" },
  };
  const binding = {
    bindingRef: "model",
    sourceRef: {
      kind: "credential_source" as const,
      namespaceId: base.namespaceId,
      id: modelSourceId,
    },
    consumer: { kind: "model" as const, providerId: "openai" },
    projection: { environment: "OPENAI_API_KEY", presentation: "bearer" as const },
  };
  const google = managedGoogleInstall;
  const googleSource = { ...binding.sourceRef, id: "cs_google" };
  const selection = {
    enabled: true,
    driverPolicy: {
      releaseSha256: google.releaseSha256,
      credentials: { account: googleSource.id },
    },
  };
  const description = await new OCCPluginDriver().describeDeployment({
    plugin: { catalog: "driver", pluginId: google.id },
    selection,
    connections: { account: { default: googleSource } },
  });
  const account = description.credentials.account?.default;
  assert.ok(account);
  // Use an exact reviewed request permitted by the account's Template, as frozen by admission.
  const googleRequest = description.networkRequirements.find(
    ({ id, match }) =>
      account.networkRequirementIds.includes(id) &&
      match.host === "www.googleapis.com" &&
      match.requestPolicy?.type === "http" &&
      match.requestPolicy.method === "GET" &&
      match.requestPolicy.path === "/calendar/v3/colors",
  )?.match;
  assert.ok(googleRequest);
  const discovery = description.networkRequirements
    .filter(({ id }) => !account.networkRequirementIds.includes(id))
    .map(({ match }) => match);
  const pluginBinding: DeploymentCredentialBinding = {
    bindingRef: JSON.stringify(["plugin", google.id, "account", "default"]),
    sourceRef: account.sourceRef,
    consumer: {
      kind: "plugin",
      pluginId: google.id,
      requirement: "account",
      connection: "default",
    },
    projection: account.projection,
  };
  const pluginSource = {
    sourceId: pluginBinding.sourceRef.id,
    sourceType: "oauth2-refresh-token" as const,
    tokenServiceInstanceId: "tokens",
  };
  const revision: AgentRevision = {
    ...base,
    plugins: {
      driver: { id: "occ-plugin", implementation: "occ/openclaw-plugin" },
      plugins: { [google.id]: selection },
    },
    credentialSources: [
      { sourceId: modelSourceId, sourceType: "static", tokenServiceInstanceId: "tokens" },
      pluginSource,
    ],
    executionAdmission: { version: 8, mode: "standalone" },
    sandboxPolicy: driver.admitNetworkPolicy([grant], 1),
    credentialDeployment: {
      driver: {
        id: driver.id,
        implementation: driver.implementation,
        configurationId: "a".repeat(64),
      },
      proxyDriverId: driver.id,
      networkAccessPolicy: {
        allowed: [
          { binary: grant.binary, host: grant.host, ports: grant.ports },
          googleRequest,
          ...discovery,
        ],
      },
      bindings: [binding, pluginBinding],
      injectionPolicies: [
        { bindingRef: binding.bindingRef, allowedRequests: [request] },
        { bindingRef: pluginBinding.bindingRef, allowedRequests: [googleRequest] },
      ],
    },
  };
  const context = { ...fixture.context, revision, requirements: fixture.requirements };
  const setup = {
    id: "staged-initial-workspace",
    namespaceId: revision.namespaceId,
    agentId: revision.agentId,
    defaultsId: "staged-defaults",
    completed: false,
    files: { "AGENTS.md": "Initial workspace" },
  };
  fixture.requirements.workspaceSetup = {
    id: setup.id,
    defaultsId: setup.defaultsId,
    secretKeyRef: { name: "workspace-setup", key: "setup.json" },
  };
  const readSecret = context.kubernetes.read;
  context.kubernetes.read = async (request) =>
    request.metadata.name === "workspace-setup"
      ? workspaceNodeSetupSecret(request.metadata, revision.namespaceId, revision.agentId, {
          "setup.json": Buffer.from(JSON.stringify(setup)).toString("base64"),
        })
      : readSecret(request);
  let supervisor: ChildProcess | undefined;
  let exited: Promise<unknown[]> | undefined;
  const nodeIndex = RUNTIME_WRAPPER_COMMAND.indexOf("node");
  const localNodeCommand = (command: readonly string[]) => [
    process.execPath,
    ...command.slice(nodeIndex + 1),
  ];
  const events: string[] = [];
  const validateBindings = (policy: unknown, providers: readonly string[]) => {
    const networks =
      (
        policy as {
          network_policies?: Record<
            string,
            { endpoints?: { credential_binding?: { provider?: string } }[] }
          >;
        }
      )?.network_policies ?? {};
    for (const rule of Object.values(networks)) {
      for (const endpoint of rule.endpoints ?? []) {
        const provider = endpoint.credential_binding?.provider;
        if (provider && (!providers.includes(provider) || !gateway.providers.has(provider))) {
          throw new Error("FAILED_PRECONDITION: credential policy names an unattached Provider");
        }
      }
    }
  };

  // The controlled gateway runs the exact rendered programs as local subprocesses. It adapts
  // the unavailable container init binary and Sandbox HOME; it does not emulate their logic.
  gateway.createSandbox = async (request) => {
    const command = request.spec.command as readonly string[];
    const environment = request.spec.environment as Record<string, string>;
    // The pinned OpenShell server validates these limits before it creates a Sandbox.
    assert.ok(Object.values(environment).every((value) => Buffer.byteLength(value) <= 8192));
    assert.ok(command.length <= 256 && command[0] !== "");
    assert.ok(
      command.every((argument) => Buffer.byteLength(argument) <= 32768 && !argument.includes("\0")),
    );
    assert.ok(command.reduce((size, argument) => size + Buffer.byteLength(argument), 0) <= 262144);
    validateBindings(request.spec.policy, (request.spec.providers ?? []) as string[]);
    events.push("create-idle");
    const local = localNodeCommand(command);
    supervisor = spawn(local[0]!, local.slice(1), {
      env: {
        ...process.env,
        ...environment,
        HOME: directory,
        OPENCLAW_WORKSPACE_DIR: directory,
      },
      stdio: "ignore",
    });
    exited = once(supervisor, "exit");
    const record = storedSandbox(request, {
      id: "sandbox-fixture",
      resourceVersion: "1",
      phase: "SANDBOX_PHASE_PROVISIONING",
      serviceUrls: {},
    });
    gateway.sandboxes.set(request.name, record);
    await waitFor(
      "staged supervisor socket",
      () => existsSync(join(directory, ".oce-staged-harness.sock")),
      5000,
      {
        interval: 10,
      },
    );
    const planPath = join(directory, ".oce-staged-harness.json");
    const plan = JSON.parse(readFileSync(planPath, "utf8")) as {
      state: string;
      command: string[];
    };
    assert.equal(plan.state, "idle");
    assert.ok(Buffer.byteLength(JSON.stringify(plan.command)) > 8192);
    // Adapt only the container's unavailable tini binary for the local Harness child.
    writeFileSync(planPath, JSON.stringify({ ...plan, command: localNodeCommand(plan.command) }));
    return record;
  };
  gateway.execSandbox = async (request) => {
    if (request.environment.OPENCLAW_EXECUTABLE !== undefined) {
      assert.deepEqual(JSON.parse(request.stdin), setup);
      // The controlled setup Exec receipt stands in for the container's native setup output.
      writeFileSync(join(directory, ".oce-workspace-setup.json"), "{}");
      events.push("workspace-setup");
      return 0;
    }
    const result = spawnSync(process.execPath, request.command.slice(1), {
      env: {
        ...process.env,
        ...request.environment,
        HOME: directory,
        OPENAI_API_KEY: fresh,
        GOG_ACCESS_TOKEN: freshPlugin,
      },
      input: request.stdin,
      stdio: ["pipe", "ignore", "ignore"],
    });
    return result.status ?? 1;
  };
  gateway.deleteSandbox = async ({ name }) => {
    supervisor?.kill("SIGTERM");
    await exited;
    gateway.sandboxes.delete(name);
  };
  t.after(async () => {
    if (supervisor?.exitCode === null && supervisor.signalCode === null) {
      supervisor.kill("SIGTERM");
      await exited;
    }
  });

  await driver.ensureNamespace(context);
  const proxy = new OpenShellCredentialProxyDriver({
    id: driver.id,
    implementation: driver.implementation,
    tokenServiceImplementation: "occ/token-service",
    backend: backendFor(gateway),
    sandbox: driver,
  });
  const broadPluginGrant = {
    id: "plugin-broad",
    binary: googleRequest.binary,
    host: googleRequest.host,
    ports: googleRequest.ports,
  };
  const sameTuplePluginRequest = { ...googleRequest, binary: grant.binary, host: grant.host };
  const conflictingRequest = {
    ...googleRequest,
    host: grant.host,
    requestPolicy: { type: "http" as const, method: "GET", path: "/v1/responses" },
  };
  const installedDefaultPluginRequest = { ...googleRequest, host: "docs.example.test" };
  const duplicateModelGrant = { ...grant, id: "model-duplicate" };
  const unsafeRevisions: readonly { readonly reason: string; readonly revision: AgentRevision }[] =
    [
      {
        reason: "two consumers cannot share one credential environment",
        revision: {
          ...revision,
          credentialDeployment: {
            ...revision.credentialDeployment!,
            bindings: [binding, { ...pluginBinding, projection: binding.projection }],
          },
        },
      },
      {
        reason: "the native Source resolver cannot separate HTTP methods on the same path",
        revision: {
          ...revision,
          credentialDeployment: {
            ...revision.credentialDeployment!,
            networkAccessPolicy: { allowed: [request, conflictingRequest] },
            injectionPolicies: [
              revision.credentialDeployment!.injectionPolicies[0]!,
              { bindingRef: pluginBinding.bindingRef, allowedRequests: [conflictingRequest] },
            ],
          },
        },
      },
      {
        reason: "a Plugin route cannot narrow installed network access for another executable",
        revision: {
          ...revision,
          credentialDeployment: {
            ...revision.credentialDeployment!,
            networkAccessPolicy: {
              allowed: [
                { binary: grant.binary, host: grant.host, ports: grant.ports },
                installedDefaultPluginRequest,
              ],
            },
            injectionPolicies: [
              revision.credentialDeployment!.injectionPolicies[0]!,
              {
                bindingRef: pluginBinding.bindingRef,
                allowedRequests: [installedDefaultPluginRequest],
              },
            ],
          },
        },
      },
      {
        reason:
          "a broad credential-free Plugin grant cannot be silently replaced by narrow injection routes",
        revision: {
          ...revision,
          sandboxPolicy: driver.admitNetworkPolicy([grant, broadPluginGrant], 1),
          credentialDeployment: {
            ...revision.credentialDeployment!,
            networkAccessPolicy: {
              allowed: [
                ...revision.credentialDeployment!.networkAccessPolicy.allowed,
                broadPluginGrant,
              ],
            },
          },
        },
      },
      {
        reason:
          "the model grant exemption must not narrow a Plugin route on the same executable and destination",
        revision: {
          ...revision,
          credentialDeployment: {
            ...revision.credentialDeployment!,
            networkAccessPolicy: {
              allowed: [
                { binary: grant.binary, host: grant.host, ports: grant.ports },
                sameTuplePluginRequest,
              ],
            },
            injectionPolicies: [
              revision.credentialDeployment!.injectionPolicies[0]!,
              {
                bindingRef: pluginBinding.bindingRef,
                allowedRequests: [sameTuplePluginRequest],
              },
            ],
          },
        },
      },
      {
        reason:
          "only the canonical broad model grant may cover the model executable and destination",
        revision: {
          ...revision,
          sandboxPolicy: driver.admitNetworkPolicy([grant, duplicateModelGrant], 1),
          credentialDeployment: {
            ...revision.credentialDeployment!,
            networkAccessPolicy: {
              allowed: [
                ...revision.credentialDeployment!.networkAccessPolicy.allowed,
                duplicateModelGrant,
              ],
            },
          },
        },
      },
    ];
  for (const unsafe of unsafeRevisions) {
    assert.equal(
      supportsOpenShellCredentialDeployment({
        sandbox: driver,
        proxy,
        policy: unsafe.revision.credentialDeployment!,
      }),
      false,
      unsafe.reason,
    );
    await assert.rejects(
      driver.provisionStagedHarness({ ...context, revision: unsafe.revision }),
      /staged native credential policy is unsupported/,
      unsafe.reason,
    );
    assert.equal(
      gateway.sandboxes.size,
      0,
      "unsupported policy must fail before native Sandbox creation",
    );
    assert.deepEqual(events, [], "unsupported policy must not mutate the native runtime");
  }
  // The delivery pair qualifies policies independently of the launcher's Secret support.
  const pluginOnly = {
    ...revision.credentialDeployment!,
    networkAccessPolicy: { allowed: [googleRequest] },
    bindings: [pluginBinding],
    injectionPolicies: [{ bindingRef: pluginBinding.bindingRef, allowedRequests: [googleRequest] }],
  };
  assert.equal(
    supportsOpenShellCredentialDeployment({ sandbox: driver, proxy, policy: pluginOnly }),
    true,
  );
  await assert.rejects(
    driver.provisionStagedHarness({
      ...context,
      revision: {
        ...revision,
        harnessAuth: {
          method: "api_key",
          source: { kind: "secret", namespaceId: revision.namespaceId, id: "sec_model" },
          secretDriverId: "secrets",
        },
        credentialSources: [pluginSource],
        credentialDeployment: pluginOnly,
      },
      requirements: {
        ...context.requirements,
        environment: [
          ...context.requirements.environment,
          {
            name: "OPENAI_API_KEY",
            valueFrom: { secretKeyRef: { name: "model-key", key: "value" } },
          },
        ],
      },
    }),
    (error) => {
      assert.ok(error instanceof SandboxRevisionUnsupportedError);
      assert.equal(error.code, "SANDBOX_SECRET_ENVIRONMENT_UNSUPPORTED");
      return true;
    },
  );
  assert.equal(gateway.sandboxes.size, 0, "unsupported model Secret must not create a Sandbox");
  assert.equal(
    supportsOpenShellCredentialDeployment({
      sandbox: driver,
      proxy,
      policy: revision.credentialDeployment!,
    }),
    true,
  );
  const target = await driver.provisionStagedHarness(context);
  assert.equal(target.sandboxId, "sandbox-fixture");
  // The next worker may find the idle Sandbox if creation succeeded before Compute
  // recorded its identity. It must adopt that exact Sandbox before any Provider attachment.
  const recovered = await driver.provisionStagedHarness(context);
  assert.deepEqual(recovered, target);
  assert.deepEqual(events, ["create-idle"]);
  assert.equal(
    [...gateway.sandboxes.values()][0]!.annotations["openclaw.dev/configuration-id"],
    revision.configurationId,
    "the native Credential Proxy must be able to verify the staged target's configuration",
  );
  const sourcePolicy = [...gateway.sandboxes.values()][0]!.spec!.policy as {
    network_policies: Record<string, { endpoints: Record<string, unknown>[] }>;
    network_middlewares?: Record<string, unknown>;
  };
  assert.deepEqual(sourcePolicy.network_middlewares ?? {}, {});
  assert.equal(sourcePolicy.network_policies["oce-agent-model"], undefined);
  assert.deepEqual(
    sourcePolicy.network_policies["model-egress"]!.endpoints.map(({ host, ports }) => ({
      host,
      ports,
    })),
    [
      { host: "api.openai.com", ports: [9443] },
      { host: "status.example.test", ports: [443] },
    ],
    "staged policy must preserve unaffected endpoints and ports in an overlapping default",
  );
  assert.ok(
    Object.entries(sourcePolicy.network_policies).some(
      ([name, rule]) =>
        name.startsWith("oce-staged-extra-") &&
        rule.endpoints.some(
          ({ host, ports }) =>
            host === grant.host && Array.isArray(ports) && ports.length === 1 && ports[0] === 8443,
        ),
    ),
    "staged policy must preserve the Agent grant's other port",
  );
  assert.ok(
    sourcePolicy.network_policies["docs-egress"],
    "staged policy must retain unrelated default network grants",
  );
  let policyRevision = structuredClone(sourcePolicy);
  let policyVersion = 1;
  gateway.getPolicyStatus = async () => ({
    policy: policyRevision,
    version: policyVersion,
    activeVersion: policyVersion,
    state: "POLICY_STATUS_LOADED",
  });
  gateway.getSandboxConfig = async (workspace) => {
    const effective = structuredClone(policyRevision);
    // OpenShell marks the retained model endpoint when composing effective withdrawal evidence.
    effective.network_policies["oce-agent-model"]!.endpoints[0]!.provider_credentialed = true;
    return { workspace, policy: effective, version: policyVersion, configuration_admitted: true };
  };
  assert.equal(
    (await driver.observeNetworkPolicy(context, revision.sandboxPolicy!)).matches,
    false,
  );

  // The separate Credential Proxy owner creates and attaches the Provider before UpdateConfig.
  const provider = openShellProviderName(binding.sourceRef.id);
  gateway.providers.set(provider, {
    name: provider,
    type: "openai",
    labels: {},
    config: {},
    resourceVersion: "1",
  });
  const pluginProvider = openShellCredentialProviderName(pluginBinding);
  assert.notEqual(pluginProvider, provider);
  gateway.providers.set(pluginProvider, {
    name: pluginProvider,
    type: "openai",
    labels: {},
    config: {},
    resourceVersion: "1",
  });
  const sandbox = [...gateway.sandboxes.values()][0]!;
  gateway.sandboxes.set(sandbox.name, {
    ...sandbox,
    spec: { ...sandbox.spec!, providers: [provider, pluginProvider] },
    resourceVersion: "2",
  });
  events.push("attach-provider");
  gateway.updatePolicy = async (request) => {
    // Native UpdateConfig admits only a nonzero, hyphenated UUID for replay.
    assert.match(request.requestId, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i);
    assert.notEqual(request.requestId, "00000000-0000-0000-0000-000000000000");
    const current = gateway.sandboxes.get(request.sandbox)!;
    validateBindings(request.policy, current.spec!.providers as string[]);
    assert.equal(request.expectedResourceVersion, current.resourceVersion);
    policyRevision = structuredClone(request.policy) as typeof sourcePolicy;
    policyVersion++;
    events.push("update-policy");
  };
  await driver.applyNetworkPolicy(context, {
    snapshot: revision.sandboxPolicy!,
    expectedProviderVersion: "2",
    operationId: revision.id,
  });
  assert.deepEqual(policyRevision.network_policies["oce-agent-model"]!.endpoints[0], {
    host: grant.host,
    ports: [443],
    path: "/v1/responses",
    protocol: "rest",
    enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
    rules: [{ allow: { method: "POST", path: "/v1/responses" } }],
    credential_binding: { provider },
  });
  const compiledEndpoints = Object.values(policyRevision.network_policies).flatMap(
    ({ endpoints }) => endpoints,
  );
  assert.deepEqual(
    compiledEndpoints.find((endpoint) => endpoint.path === "/calendar/v3/colors"),
    {
      host: googleRequest.host,
      ports: [443],
      path: "/calendar/v3/colors",
      protocol: "rest",
      enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
      rules: [{ allow: { method: "GET", path: "/calendar/v3/colors" } }],
      credential_binding: { provider: pluginProvider },
    },
  );
  assert.deepEqual(
    compiledEndpoints.find((endpoint) => endpoint.path === "/discovery/v1/apis/calendar/v3/rest"),
    {
      host: "www.googleapis.com",
      ports: [443],
      path: "/discovery/v1/apis/calendar/v3/rest",
      protocol: "rest",
      enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
      rules: [{ allow: { method: "GET", path: "/discovery/v1/apis/calendar/v3/rest" } }],
    },
    "public discovery must not receive a Source binding",
  );
  assert.deepEqual(events, ["create-idle", "attach-provider", "update-policy"]);
  assert.deepEqual(await driver.observeNetworkPolicy(context, revision.sandboxPolicy!), {
    resourceVersion: "2",
    policyVersion: "2",
    state: "applied",
    matches: true,
  });
  assert.equal(existsSync(marker), false, "provisioning must not run the Harness");
  const projections = [
    {
      bindingRef: "model",
      environment: "OPENAI_API_KEY",
      placeholder: { kind: "runtime" as const },
    },
    {
      bindingRef: pluginBinding.bindingRef,
      environment: pluginBinding.projection.environment,
      placeholder: { kind: "runtime" as const },
    },
  ];
  await assert.rejects(driver.prepareStagedHarness(context, projections), {
    name: "ActivationPendingError",
    code: "CREDENTIAL_ACTIVATION_PENDING",
  });
  assert.equal(events.includes("workspace-setup"), false);
  gateway.sandboxes.set(sandbox.name, {
    ...gateway.sandboxes.get(sandbox.name)!,
    phase: "SANDBOX_PHASE_READY",
  });
  await driver.prepareStagedHarness(context, projections);
  assert.equal(events.at(-1), "workspace-setup");
  assert.equal(existsSync(marker), false, "preparation must not run the Harness");
  await driver.activateStagedHarness(context);
  await waitFor("Harness marker", () => existsSync(marker), 5000, { interval: 10 });
  assert.deepEqual(JSON.parse(readFileSync(marker, "utf8")), {
    credential: fresh,
    pluginCredential: freshPlugin,
  });
  delete fixture.requirements.workspaceSetup;
  await driver.prepareStagedHarness(context, projections);
  await driver.activateStagedHarness(context);

  // Revocation leaves the model and credential-free discovery routes active. Replay
  // must avoid another UpdateConfig.
  const activePolicy = structuredClone(policyRevision);
  const retainedNetworks = Object.fromEntries(
    Object.entries(activePolicy.network_policies).filter(([, { endpoints }]) =>
      endpoints.every(({ path }) => path !== "/calendar/v3/colors"),
    ),
  );
  const activeVersion = policyVersion;
  await driver.withdrawStagedCredentialRoute(context, target.sandboxId, pluginBinding.bindingRef);
  assert.deepEqual(policyRevision, { ...activePolicy, network_policies: retainedNetworks });
  assert.equal(policyVersion, activeVersion + 1);
  await driver.withdrawStagedCredentialRoute(context, target.sandboxId, pluginBinding.bindingRef);
  assert.equal(policyVersion, activeVersion + 1, "a retry must observe the already reduced policy");

  // The selected Proxy removes the withdrawn Provider. Recovery must keep the model and
  // independent public discovery without recreating the Plugin's injection or exclusive route.
  gateway.sandboxes.set(sandbox.name, {
    ...gateway.sandboxes.get(sandbox.name)!,
    spec: { ...gateway.sandboxes.get(sandbox.name)!.spec!, providers: [provider] },
    resourceVersion: "3",
  });
  assert.equal((await driver.observeNetworkPolicy(context, revision.sandboxPolicy!)).matches, true);
  await driver.applyNetworkPolicy(context, {
    snapshot: revision.sandboxPolicy!,
    expectedProviderVersion: "3",
    operationId: revision.id,
  });
  assert.deepEqual(policyRevision.network_policies, retainedNetworks);
  await driver.prepareStagedHarness(context, [projections[0]!]);

  // An absent required model blocks policy application even when optional Plugins were removed.
  gateway.sandboxes.set(sandbox.name, {
    ...gateway.sandboxes.get(sandbox.name)!,
    spec: { ...gateway.sandboxes.get(sandbox.name)!.spec!, providers: [] },
  });
  assert.equal(
    (await driver.observeNetworkPolicy(context, revision.sandboxPolicy!)).matches,
    false,
  );
  await assert.rejects(
    driver.applyNetworkPolicy(context, {
      snapshot: revision.sandboxPolicy!,
      expectedProviderVersion: "3",
      operationId: revision.id,
    }),
    /required staged model Provider is absent/,
  );

  await driver.cleanup({ ...fixture.context, revision });
  assert.equal(gateway.sandboxes.size, 0);
  assert.equal(
    supervisor?.exitCode,
    0,
    "Sandbox stop must stop its canonical supervisor and Harness child",
  );
}
