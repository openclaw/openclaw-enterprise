import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { openShellProviderName } from "../../apps/controller/src/backends/openshell.ts";
import { supportsOpenShellCredentialDeployment } from "../../apps/controller/src/composition/openshell-credential-admission.ts";
import { OpenShellCredentialProxyDriver } from "../../apps/controller/src/drivers/credential-proxy/openshell.ts";
import { OCCPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import { managedGoogleInstall } from "../../apps/controller/src/drivers/plugin/google-workspace/install.ts";
import { openShellCredentialProviderName } from "../../apps/controller/src/drivers/sandbox/openshell-credential-policy.ts";
import {
  NATIVE_WORKER_ENTRYPOINT,
  RUNTIME_WRAPPER_COMMAND,
} from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import type {
  AgentRevision,
  DeploymentCredentialBinding,
} from "../../packages/contracts/src/index.ts";
import { SandboxRevisionUnsupportedError } from "../../packages/occ/src/index.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";
import { waitFor } from "../helpers/qa-wait.ts";
import { storedSandbox } from "./sandbox-driver-gateway-response-fixture.ts";
import { backendFor, openShellDriver } from "./sandbox-driver-openshell-fixture.ts";
import { openShellWorkspaceHarnessConfiguration } from "./sandbox-driver-installation-fixture.ts";
import { completeSandboxRevision } from "./sandbox-driver-revision-fixture.ts";
import { workspaceNodeSetupSecret } from "./sandbox-driver-workspace-node-setup-fixture.ts";
import {
  harnessRuntimeCommand,
  runtimeSandboxFixture,
} from "./sandbox-driver-startup-orchestration.ts";
import { workspaceGatewayClient } from "./sandbox-workspace-gateway-fixture.ts";

export async function verifyStagedModelPolicyObservation(): Promise<void> {
  const gateway = workspaceGatewayClient();
  const driver = openShellDriver(gateway, openShellWorkspaceHarnessConfiguration());
  const fixture = runtimeSandboxFixture(driver);
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
    ...completeSandboxRevision(fixture.revision),
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
  gateway.createSandbox = async (request) => {
    const sandbox = storedSandbox(request, { id: "sandbox-fixture", resourceVersion: "1" });
    gateway.sandboxes.set(sandbox.name, sandbox);
    return sandbox;
  };
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
  let loaded: Record<string, unknown> = retained;
  gateway.getPolicyStatus = async () => ({
    policy: loaded,
    version: 1,
    activeVersion: 1,
    state: "POLICY_STATUS_LOADED",
  });
  assert.equal((await driver.observeNetworkPolicy(context, revision.sandboxPolicy!)).matches, true);

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
  gateway.getSandboxConfig = async (workspace) => ({
    workspace,
    policy: policyRevision,
    version: policyVersion,
    configuration_admitted: true,
  });
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

  await driver.cleanup({ ...fixture.context, revision });
  assert.equal(gateway.sandboxes.size, 0);
  assert.equal(
    supervisor?.exitCode,
    0,
    "Sandbox stop must stop its canonical supervisor and Harness child",
  );
}
