import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { join } from "node:path";
import test from "node:test";
import { OpenShellGitRuntime } from "../../apps/controller/src/drivers/egress-proxy/openshell-git-runtime.ts";
import {
  createGitHubRepositoryDeliveryResolver,
  resolveGitHubRepositoryBinding,
  type GitHubRepositoryRegistry,
} from "../../apps/controller/src/drivers/repo/github/access/registry.ts";
import {
  GrpcOpenShellGatewayClient,
  type OpenShellGatewayClient,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import type {
  AgentRevision,
  EgressInstallation,
  ProxyPlan,
  RepositoryRevisionState,
  SandboxHarnessStatusContext,
} from "../../packages/contracts/src/index.ts";
import { TransientDependencyError } from "../../packages/occ/src/index.ts";
import { loadInstallationFile } from "../helpers/installation-file.ts";
import { labelSelectorLabels } from "../helpers/kubernetes-routed-scenarios.mjs";
import { listen } from "../helpers/listen.ts";
import { loader } from "../helpers/openshell-grpc-sdk.ts";
import { storedSandbox } from "./sandbox-driver-gateway-response-fixture.ts";
import { verifySandboxDriverHarnessObservation } from "./sandbox-driver-harness-observation-cases.ts";
import { registerSandboxDriverNativePreparationCases } from "./sandbox-driver-native-preparation-cases.ts";
import { backendFor, openShellDriver } from "./sandbox-driver-openshell-fixture.ts";
import { registerSandboxDriverOperatorKubernetesCases } from "./sandbox-driver-operator-kubernetes-cases.ts";
import { createOrphanedNativePreparation } from "./sandbox-driver-preparation-cases.ts";
import { registerSandboxDriverPreparerCleanupCases } from "./sandbox-driver-preparer-cleanup-cases.ts";
import { completeWorkspaceRevision } from "./sandbox-driver-revision-fixture.ts";
import { buildSandboxInstallation as sandboxInstallation } from "./sandbox-driver-startup-installation-fixture.ts";
import {
  V1Deployment,
  harnessService,
  ownedWorkspace,
  runtimeSandboxFixture,
} from "./sandbox-driver-startup-orchestration.ts";
import {
  verifyStockExtensionRoundTrips,
  verifyStockReadinessEvidence,
} from "./sandbox-driver-stock-readiness-cases.ts";
import { workspaceGatewayClient } from "./sandbox-workspace-gateway-fixture.ts";

export function registerSandboxDriverHookProbeCases(): void {
  test("OpenShell observes the Codex Harness through its exact bearer-passthrough service", async () => {
    await verifySandboxDriverHarnessObservation({
      openShellDriver,
      runtimeSandboxFixture,
      sandboxInstallation,
      TransientDependencyError,
    });
  });

  // These codecs test the stock/product boundary, not installed supervisor capabilities.
  test("stock OpenShell v0.1.5 cannot carry OCE readiness-extension evidence", async () => {
    const options = { keepCase: true, longs: String, enums: String, defaults: false };
    const stock = await loader.load(
      join(import.meta.dirname, "../fixtures/openshell-v0.1.5-wire.proto"),
      options,
    );
    const product = await loader.load(
      join(
        import.meta.dirname,
        "../../apps/controller/src/drivers/sandbox/proto/openshell-gateway.proto",
      ),
      options,
    );
    verifyStockReadinessEvidence(product, stock);
    verifyStockExtensionRoundTrips(product, stock);
  });

  test("installation refuses OpenShell repository credentials before reading session or provider inputs", async (t) => {
    const configuration = sandboxInstallation();
    const id = "repository-credentials";
    await assert.rejects(
      loadInstallationFile(t, {
        ...configuration,
        backend: [
          ...configuration.backend,
          {
            id: "github-primary",
            type: "github",
            configuration: { registryPath: "/absent/repositories.json" },
            drivers: { repo: id },
          },
        ],
        repository: {
          id,
          configuration: { sessionDurationSeconds: 600 },
          preparedGitHub: {
            custodyKeyPath: "/absent/custody",
            privateKeyPath: "/absent/app-key.pem",
          },
        },
      }),
      /repository requires explicitly selected protected Git delivery/,
    );
  });

  test("observed-hook preview recognizes a released Codex through its authenticated WebSocket", async (t) => {
    const token = "fixture-preview-transport";
    let acknowledged = false;
    let serving = true;
    let status = 400;
    let upgrades = 0;
    // Native Codex answers ordinary HTTP with 400 after its launch endpoint closes.
    // Real HTTP/WebSocket transport proves this Driver check; the recorded release is its input.
    const server = createServer((_request, response) => {
      response.writeHead(status);
      response.end("WebSocket upgrade required");
    });
    server.on("upgrade", (request, socket) => {
      upgrades++;
      socket.on("error", () => {});
      if (!serving || request.headers.authorization !== `Bearer ${token}`) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      const key = request.headers["sec-websocket-key"];
      assert.ok(typeof key === "string");
      const accept = createHash("sha1")
        .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
        .digest("base64");
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
    });
    // listen() closes the server when the test ends, after destroying every connection,
    // including the upgraded sockets the HTTP server no longer tracks.
    const port = await listen(t, server);
    const transport = new GrpcOpenShellGatewayClient({ endpoint: `http://127.0.0.1:${port}` });
    t.after(() => transport.close());
    const sandboxId = "preview-sandbox";
    const driverId = "openshell-sandbox";
    const {
      context,
      revision: fixtureRevision,
      requirements,
    } = runtimeSandboxFixture({
      id: driverId,
    });
    const registry: GitHubRepositoryRegistry = {
      version: 1,
      backendId: "github-primary",
      providerInstanceId: "github-com-primary",
      appId: "12345",
      githubInstallationId: "67890",
      maximumDurationSeconds: 600,
      repositories: [],
      installationAccess: {
        repositoryRef: "installation",
        namespaces: [{ namespaceId: fixtureRevision.namespaceId, accessMode: "installation" }],
      },
    };
    const git = new OpenShellGitRuntime(
      {
        registrationName: "oce-prepared-git",
        observedHookPreviewWorkspace: context.namespace.name,
        authority: {
          host: "127.0.0.1",
          port: 0,
          certificatePath: "/absent/cert.pem",
          privateKeyPath: "/absent/key.pem",
          issuerPublicKeyPath: "/absent/issuer.pem",
          issuer: "fixture-issuer",
          audience: "fixture-audience",
          keyId: "fixture-key",
        },
      },
      createGitHubRepositoryDeliveryResolver(registry),
    );
    // The acknowledgment is a recorded input. The real Driver must still authenticate
    // the serving socket and must never replay the release.
    git.previewReleased = (revisionId) => {
      assert.equal(revisionId, fixtureRevision.id);
      return acknowledged;
    };
    const gateway = {
      ...workspaceGatewayClient(),
      getServiceDocument: transport.getServiceDocument.bind(transport),
      serviceWebSocketHandshake: transport.serviceWebSocketHandshake.bind(transport),
      getService: async (_workspace, sandbox, name) =>
        harnessService(sandbox, name, "http://preview--codex.openshell.test/"),
      getSandbox: async ({ name, workspace }) =>
        storedSandbox(
          { name, workspace, labels: {}, annotations: {}, spec: {} },
          {
            id: sandboxId,
            serviceUrls: {},
          },
        ),
    } satisfies OpenShellGatewayClient;
    const driver = new OpenShellSandboxDriver(sandboxInstallation().drivers.sandbox.configuration, {
      id: driverId,
      backend: backendFor(gateway),
      openShellGit: git,
    });
    const admitted = completeWorkspaceRevision(fixtureRevision, requirements);
    const repositoryCredentials: RepositoryRevisionState = {
      driver: { id: "repository", implementation: "github" },
      deadlineWallMs: Date.now() + 600000,
      bindings: [
        resolveGitHubRepositoryBinding(registry, {
          namespaceId: admitted.namespaceId,
          repositoryRef: "installation",
          profile: "github-installation",
        }),
      ],
    };
    const configurationId = "a".repeat(64);
    const plan: ProxyPlan = {
      id: randomUUID(),
      generation: 1,
      routes: [],
      sandboxDriverId: driver.id,
      egressDriverId: driver.id,
      driver: { id: driver.id, implementation: "openshell", configurationId },
      execution: {
        installationId: "ins_fixture",
        namespaceId: admitted.namespaceId,
        agentId: admitted.agentId,
        servicePrincipalId: admitted.servicePrincipalId,
        revisionId: admitted.id,
        executionId: randomUUID(),
      },
      repositoryGit: repositoryCredentials,
      repositoryGitAuthorization: "request-hook-observed",
    };
    const revision: AgentRevision = {
      ...admitted,
      executionAdmission: { version: 6, mode: "protected" },
      repositoryCredentials,
      egressPlan: plan,
    };
    const input: SandboxHarnessStatusContext = {
      ...context,
      revision,
      requirements,
      transportToken: token,
    };
    const installation: EgressInstallation = {
      plan,
      sandboxId,
      sender: { id: plan.egressDriverId, generation: 1 },
      installedAt: new Date().toISOString(),
      enforcement: {
        instanceId: randomUUID(),
        configurationId,
        policyHash: "b".repeat(64),
        authorityScope: "execution",
        repositoryGitRecipient: {
          providerId: "preview-provider",
          attachmentEpoch: "preview-epoch",
          processInstanceId: "preview-process",
          networkInstanceId: "preview-network",
          deliveryProfile: "github_installation",
          authorization: "request-hook-observed",
          observedHook: { startupId: randomUUID(), observationId: "c".repeat(64) },
        },
      },
    };
    const release = () => assert.fail("an acknowledged release must never be sent again");
    // A serving socket without a receipt, or a receipt without an authenticated socket, stays pending.
    assert.equal(await driver.observeHeldRepositoryGitPreview(input), undefined);
    await assert.rejects(driver.enrollHarness(input, installation, release), /Cannot verify/);
    acknowledged = true;
    serving = false;
    assert.equal(await driver.observeHeldRepositoryGitPreview(input), undefined);
    await assert.rejects(driver.enrollHarness(input, installation, release), /Cannot verify/);
    serving = true;
    // Only a closed launch endpoint may fall back to the acknowledged serving socket.
    for (status of [400, 404, 403, 503, 204]) {
      const allowed = status === 400 || status === 404;
      let before = upgrades;
      assert.equal(
        await driver.observeHeldRepositoryGitPreview(input),
        allowed ? "installed" : undefined,
        `observation status ${status}`,
      );
      assert.equal(upgrades - before, allowed ? 1 : 0, `observation upgrades for ${status}`);
      before = upgrades;
      if (allowed) {
        await driver.enrollHarness(input, installation, release);
      } else {
        await assert.rejects(driver.enrollHarness(input, installation, release), /Cannot verify/);
      }
      assert.equal(upgrades - before, allowed ? 1 : 0, `enrollment upgrades for ${status}`);
    }
  });

  test("OpenShell refuses repository provision and enrollment before any gateway or release call", async () => {
    const gateway = workspaceGatewayClient();
    const driver = openShellDriver(gateway);
    const refusal = { code: "SANDBOX_REPOSITORY_RECIPIENT_UNVERIFIED" };
    let releases = 0;
    const malformedInputs: Array<
      (input: SandboxHarnessStatusContext) => SandboxHarnessStatusContext
    > = [
      (input) => ({
        ...input,
        revision: {
          ...input.revision,
          // @ts-expect-error Exercise malformed persisted repository credentials.
          repositoryCredentials: {},
        },
      }),
      (input) => ({
        ...input,
        requirements: {
          ...input.requirements,
          // Exercise the obsolete session field at the runtime boundary.
          repositorySession: {},
        },
      }),
      (input) => ({
        ...input,
        requirements: {
          ...input.requirements,
          environment: [
            ...input.requirements.environment,
            { name: "OPENCLAW_REPOSITORY_ENROLLMENT", value: "{}" },
          ],
        },
      }),
    ];
    const release = async () => {
      releases++;
      return {};
    };
    for (const malformed of malformedInputs) {
      const { context, revision: fixtureRevision, requirements } = runtimeSandboxFixture(driver);
      const revision = completeWorkspaceRevision(fixtureRevision, requirements);
      const attempt = malformed({
        ...context,
        revision,
        requirements,
        transportToken: "fixture-transport",
      });
      await assert.rejects(driver.provisionHarness(attempt), refusal);
      // The repository refusal must precede even validation of the installation.
      // @ts-expect-error Deliberately omit installation evidence.
      await assert.rejects(driver.enrollHarness(attempt, {}, release), refusal);
      assert.equal(releases, 0);
      assert.deepEqual(gateway.calls, []);
    }
  });

  const orphanedNativePreparation = createOrphanedNativePreparation({
    V1Deployment,
    openShellDriver,
    runtimeSandboxFixture,
    ownedWorkspace,
  });

  registerSandboxDriverNativePreparationCases(orphanedNativePreparation);

  registerSandboxDriverPreparerCleanupCases({
    orphanedNativePreparation,
    labelSelectorLabels,
  });

  registerSandboxDriverOperatorKubernetesCases();
}
