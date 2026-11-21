import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { openShellProviderName } from "../../apps/controller/src/backends/openshell.ts";
import { RUNTIME_WRAPPER_COMMAND } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import type { AgentRevision } from "../../packages/contracts/src/index.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";
import { waitFor } from "../helpers/qa-wait.ts";
import { storedSandbox } from "./sandbox-driver-gateway-response-fixture.ts";
import { openShellDriver } from "./sandbox-driver-openshell-fixture.ts";
import { openShellWorkspaceHarnessConfiguration } from "./sandbox-driver-installation-fixture.ts";
import { completeSandboxRevision } from "./sandbox-driver-revision-fixture.ts";
import { workspaceNodeSetupSecret } from "./sandbox-driver-workspace-node-setup-fixture.ts";
import {
  harnessRuntimeCommand,
  runtimeSandboxFixture,
} from "./sandbox-driver-startup-orchestration.ts";
import { workspaceGatewayClient } from "./sandbox-workspace-gateway-fixture.ts";

export async function verifyStagedHarnessActivation(t: TestContext): Promise<void> {
  const directory = await temporaryDirectory(t, "staged-harness-");
  const marker = join(directory, "harness.json");
  const fresh = "openshell:resolve:env:v2_OPENAI_API_KEY";
  const gateway = workspaceGatewayClient();
  const configuration = openShellWorkspaceHarnessConfiguration();
  const driver = openShellDriver(gateway, {
    ...configuration,
    policy: {
      ...configuration.policy,
      networkPolicies: [
        ...configuration.policy.networkPolicies.map((rule) => ({
          ...rule,
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
  const fixture = runtimeSandboxFixture(driver);
  fixture.requirements.credentialAttachments = [];
  fixture.requirements.environment.push(
    { name: "CODEX_SESSIONS_DIR", value: "/home/node/.codex/sessions" },
    { name: "MARKER", value: marker },
  );
  fixture.requirements.command = harnessRuntimeCommand(
    'require("node:fs").writeFileSync(process.env.MARKER, JSON.stringify({ credential: process.env.OPENAI_API_KEY })); setInterval(() => {}, 1000);',
  );
  const base = completeSandboxRevision(fixture.revision);
  const grant = {
    id: "model",
    binary: "/app/bin/model-client",
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
      id: "cs_fixture",
    },
    consumer: { kind: "model" as const, providerId: "openai" },
    projection: { environment: "OPENAI_API_KEY", presentation: "bearer" as const },
  };
  const revision: AgentRevision = {
    ...base,
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
    validateBindings(request.spec.policy, (request.spec.providers ?? []) as string[]);
    events.push("create-idle");
    const command = request.spec.command as readonly string[];
    const environment = request.spec.environment as Record<string, string>;
    const launch = JSON.parse(environment.OPENCLAW_STAGED_HARNESS_COMMAND!) as string[];
    const local = localNodeCommand(command);
    supervisor = spawn(local[0]!, local.slice(1), {
      env: {
        ...process.env,
        ...environment,
        HOME: directory,
        OPENCLAW_WORKSPACE_DIR: directory,
        OPENCLAW_STAGED_HARNESS_COMMAND: JSON.stringify(localNodeCommand(launch)),
      },
      stdio: "ignore",
    });
    exited = once(supervisor, "exit");
    const record = storedSandbox(request, {
      id: "sandbox-fixture",
      resourceVersion: "1",
      phase: "SANDBOX_PHASE_PROVISIONING",
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
      env: { ...process.env, ...request.environment, HOME: directory, OPENAI_API_KEY: fresh },
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
  assert.equal((await driver.provisionStagedHarness(context)).sandboxId, "sandbox-fixture");
  assert.equal(
    [...gateway.sandboxes.values()][0]!.annotations["openclaw.dev/configuration-id"],
    revision.configurationId,
    "the native Credential Proxy must be able to verify the staged target's configuration",
  );
  const sourcePolicy = [...gateway.sandboxes.values()][0]!.spec!.policy as {
    network_policies: Record<string, { endpoints: Record<string, unknown>[] }>;
  };
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
  const sandbox = [...gateway.sandboxes.values()][0]!;
  gateway.sandboxes.set(sandbox.name, {
    ...sandbox,
    spec: { ...sandbox.spec!, providers: [provider] },
    resourceVersion: "2",
  });
  events.push("attach-provider");
  gateway.updatePolicy = async (request) => {
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
    protocol: "rest",
    enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
    rules: [{ allow: { method: "POST", path: "/v1/responses" } }],
    credential_binding: { provider },
  });
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
  assert.deepEqual(JSON.parse(readFileSync(marker, "utf8")), { credential: fresh });
  delete fixture.requirements.workspaceSetup;
  await driver.prepareStagedHarness(context, projections);
  await driver.activateStagedHarness(context);
  await driver.cleanup({ ...fixture.context, revision });
  assert.equal(gateway.sandboxes.size, 0);
  assert.equal(
    supervisor?.exitCode,
    0,
    "Sandbox stop must stop its canonical supervisor and Harness child",
  );
}
