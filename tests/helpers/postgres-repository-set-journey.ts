import { createHarnessConfiguration } from "./harness-configuration.mjs";
import { createTestKubernetesComputeDriver } from "./kubernetes-compute.mjs";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { AgentRevision, ProxyRevisionContext } from "../../packages/contracts/src/index.ts";
import { InstalledDriver } from "../../packages/occ/src/index.ts";
import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import { OpenShellLegacyEgressProxyDriver } from "../../apps/controller/src/drivers/egress-proxy/openshell.ts";
import { OpenShellGitRuntime } from "../../apps/controller/src/drivers/egress-proxy/openshell-git-runtime.ts";
import { ProtectedExecutionDriver } from "../../apps/controller/src/drivers/compute/protected-execution-driver.ts";
import { createGitHubRepositoryDeliveryResolver } from "../../apps/controller/src/drivers/repo/github/access/registry.ts";
import { standingExecutionPlatform } from "./postgres-standing-execution.ts";
import { GitHubRepositoryPolicy } from "../../apps/controller/src/drivers/repo/github/policy.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { preparedStandingGitPeer } from "./prepared-standing-git-peer.ts";

import { gitExpiryGateway } from "./openshell-online-git-journey.mjs";
import { harnessTlsFixture } from "./harness-tls.ts";
import { bindReservedPortInProcess, reservePort } from "./available-port.ts";

type NarrowPreparation = {
  runtime: OpenShellGitRuntime;
  revision: AgentRevision;
  client: Parameters<OpenShellGitRuntime["prepare"]>[1];
  workspace: string;
  sandbox: string;
  pool: Awaited<ReturnType<typeof standingExecutionPlatform>>["observerPool"];
  peer: Awaited<ReturnType<typeof preparedStandingGitPeer>>;
  writes: () => number;
};

/** Admit the exact legacy Git plan to exercise the pre-bootstrap route reservation. */
export async function beforeNarrowGitPreparation(
  t: TestContext,
  testUrl: string,
  exercise: (journey: NarrowPreparation) => Promise<void>,
) {
  const workspace = "selected-journey";
  const tls = await harnessTlsFixture(t);
  const tokenPath = join(tls.directory, "gateway-token");
  await writeFile(tokenPath, "controlled-gateway");
  const state = {
    providerEnvRevision: "",
    revisionId: "",
    namespaceId: "",
    agentId: "",
    sandbox: "selected",
    policy: {} as object,
    gitRule: {} as { name: string },
    installed: undefined as string | undefined,
    started: { seconds: Math.floor(Date.now() / 1000) },
    runtimeProvider: "oce-runtime-" + "a".repeat(16),
    middleware: [
      {
        name: "oce-prepared-git",
        audience: "repository-set",
        binding_policy: 3,
        bindings: [1],
        request_timeout: { seconds: "5" },
        grpc_endpoint: "https://middleware.example.test",
      },
    ],
  };
  const keys = generateKeyPairSync("ed25519");
  const issuerPublicKeyPath = join(tls.directory, "issuer.pem");
  await writeFile(issuerPublicKeyPath, keys.publicKey.export({ type: "spki", format: "pem" }));
  // The Git runtime binds its authority on this port in-process, well after its configuration
  // names it. Hold the port until then, so a test running in parallel cannot take it.
  const authorityPort = await reservePort();
  t.after(() => authorityPort.release());
  await bindReservedPortInProcess(authorityPort);
  const { port } = authorityPort;
  const id = "selected-stock-openshell";
  const backend = {
    id: "selected-gateway",
    drivers: { sandbox: id },
    client: { placement: () => undefined, clientForNamespace: () => client },
  };
  const opts = {
    middlewareName: "oce-prepared-git",
    repositoryMiddlewareName: "oce-prepared-git",
    authorityScope: "execution" as const,
  };
  const selected = {
    id,
    implementation: "openshell",
    configuration: opts,
    definition: {
      configurationSchema: OpenShellLegacyEgressProxyDriver.configurationSchema,
      validateConfiguration: OpenShellLegacyEgressProxyDriver.validateConfiguration,
      configurationContributions: OpenShellSandboxDriver.configurationContributions,
    },
  };
  const { runtime, sandbox, owner } = (() => {
    const runtime = new OpenShellGitRuntime(
      {
        registrationName: "oce-prepared-git",
        authority: {
          host: "127.0.0.1",
          port,
          issuer: "https://gateway.example.test",
          audience: "repository-set",
          keyId: "gateway-key",
          certificatePath: tls.certPath,
          privateKeyPath: tls.keyPath,
          issuerPublicKeyPath,
        },
      },
      (revision) => createGitHubRepositoryDeliveryResolver(peer.registry)(revision),
    );
    const sandbox = new OpenShellSandboxDriver(
      {
        integrationMode: "legacy",
        gateway: {},
        kubernetes: {
          serviceAccount: { mode: "gatewayConfigured" },
          sandboxDataMount: {
            subPath: "workspace",
            mountPath: "/sandbox/enterprise",
            readOnly: false,
          },
        },
        policy: {
          process: { runAsUser: "1000", runAsGroup: "1000" },
          networkPolicies: [
            {
              name: "model",
              binaries: [{ path: "/usr/bin/codex" }],
              endpoints: [{ host: "api.openai.com", ports: [443] }],
            },
          ],
        },
      },
      { id, implementation: "openshell", backend: backend as never, openShellGit: runtime },
    );
    const proxy = new OpenShellLegacyEgressProxyDriver(opts, {
      id,
      sandbox,
      backend: backend as never,
      bindRepositoryGit: (authority) => runtime.bindRepositoryGit(authority),
      ...{
        mandatoryEnforcement: (ctx: ProxyRevisionContext, box: string) => {
          const observe = Reflect.get(runtime, "mandatoryEnforcement");
          assert.equal(
            typeof observe,
            "function",
            "bundled runtime must own mandatory enforcement",
          );
          return observe.call(runtime, ctx, box);
        },
      },
    });
    const owner = new InstalledDriver(selected, {
      capabilities: { sandbox, credential_proxy: proxy },
      namespaceLifecycleHooks: {
        // This journey starts with a provisioned Namespace and tests Git authorization.
        // Reinitializing it during revision execution would be a regression.
        async ensureNamespace() {
          assert.fail(
            "The pre-provisioned Git journey must not initialize Namespace infrastructure.",
          );
        },
      },
    });
    return { runtime, sandbox, owner };
  })();
  const backends: import("../../packages/contracts/src/index.ts").BackendDefinition[] = [
    {
      id: "prepared-standing",
      type: "github",
      configuration: { registryPath: "/unused/controlled-registry.json" },
      drivers: { repo: "prepared-standing" },
    },
  ];
  const f = await standingExecutionPlatform(t, testUrl, { sandbox: selected }, backends);
  const peer = await preparedStandingGitPeer(t, f.observerPool, f.namespace.id, {
    driver: owner.ref,
    tokenLifetimeMs: 600_000,
    draftPull: true,
    beforeIssue: () => assert.fail("Rejected route preparation cannot issue an installation token"),
  });
  runtime.connectRouteStore(f.observerPool);
  const bound = await owner.requireRepositoryGitTransport()!(peer.prepared.protectedGit!);
  t.after(() => bound.close());
  await authorityPort.release();
  await runtime["running"];
  const driver = new GitHubRepositoryPolicy(
    { driverId: peer.registry.backendId, backendId: peer.registry.backendId },
    peer.registry,
    { sessionDurationSeconds: 600 },
  );
  f.controller.registerDriver(driver);
  f.controller.selectDriver("repo", driver.id);
  f.controller.installDriver(owner, ["sandbox", "credential_proxy"]);
  const kube = createTestKubernetesComputeDriver("repository-set-compute", {
    repositoryCredentials: true,
    protectedDriver: owner,
  });
  // Controlled Compute has the same task-owned launcher transport used below.
  t.mock.method(kube, "getAgentRuntimeCredentialStatus", async () => ({
    transportConfigured: true,
  }));
  f.controller.registerDriver(kube);
  f.controller.selectDriver("compute", kube.id);
  const agent = await f.agent("repository-set", {
    executionMode: "dedicated",
    auth: "runtime",
  });
  const configuration = await f.controller.createConfiguration(f.actor.id, {
    namespaceId: f.namespace.id,
    kind: "agent",
    values: createHarnessConfiguration("codex", "gpt-4.1"),
  });
  await f.controller.updateAgent(f.actor.id, {
    namespaceId: f.namespace.id,
    agentId: agent.id,
    configurationId: configuration.id,
    repositoryAccess: {
      defaultProfile: "git-write",
      repositories: [{ repositoryRef: "source" }],
    },
  });
  const wire = await gitExpiryGateway(t, {
    workspace,
    sandbox: state.sandbox,
    revisionId: "",
    deadline: Date.now() + 600_000,
    platformProfile: false,
    gatewayVersion: "0.1.6",
    gatewayTls: { ...tls, tokenPath },
    ...{ supervisor: state },
    onGitInstall(value: string) {
      state.installed = value;
    },
  });
  const { client } = wire;
  const revision = await f.controller.deployAgent(
    f.actor.id,
    { namespaceId: f.namespace.id, agentId: agent.id },
    resolveApprovedHarness,
  );
  assert.equal(revision.repositoryCredentials!.bindings.length, 1);
  assert.equal(revision.executionAdmission.version, 5);
  assert.equal(revision.executionAdmission.mode, "protected");
  assert.deepEqual(revision.egressPlan!.repositoryGit, revision.repositoryCredentials);
  assert.equal(revision.egressPlan!.repositoryGitAuthorization, "online-request");
  Object.assign(state, {
    revisionId: revision.id,
    namespaceId: revision.namespaceId,
    agentId: revision.agentId,
  });
  const context = {
    revision,
    plan: revision.egressPlan!,
    namespace: { ...f.namespace, name: workspace },
    signal: t.signal,
  } as ProxyRevisionContext;
  state.sandbox = sandbox.harnessResource!(context).resourceName;
  const release = new ProtectedExecutionDriver(owner);
  const wiring = await release.configure(context);
  state.policy = wiring.configuration;
  await exercise({
    runtime,
    revision,
    client,
    workspace,
    sandbox: state.sandbox,
    pool: f.observerPool,
    peer,
    writes: () => wire.world.writes,
  });
}
