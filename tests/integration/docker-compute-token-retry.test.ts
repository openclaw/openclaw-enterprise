import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Check } from "typebox/value";
import { DockerComputeDriver } from "../../apps/controller/src/drivers/compute/docker/index.ts";
import { GATEWAY_TOOL_POLICY_SOURCE_COMMIT } from "../../apps/controller/src/drivers/compute/gateway-tool-policy.ts";
import { ConfigurationValues, JsonValue } from "../../packages/contracts/src/api/common.ts";
import {
  admitLoggingConfiguration,
  type AgentRevision,
  type Namespace,
  type OpenClawConfigurationDocument,
} from "../../packages/contracts/src/index.ts";
import { setEnvironment } from "../helpers/environment.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import {
  assertGatewayCanReachAgent,
  assertVolumeRemoved,
  cleanUp,
  containerEnv,
  containerIds,
  docker,
  inspectContainer,
  labelAgent,
  labelRevision,
  labelRole,
  namespaceLabels,
  networkIds,
  removeFixtureImage,
  replaceWithForeignOwner,
  waitForRuntime,
  workspaceVolumes,
} from "./docker-compute-token-retry-engine.ts";

const selected = process.env.OCC_TEST_DOCKER_TOKEN_RETRY === "1";
const requiresDockerTokenRetry = {
  skip: selected
    ? false
    : "Set OCC_TEST_DOCKER_TOKEN_RETRY=1 to run the disposable Docker token retry proof.",
};
const fixtureDirectory = fileURLToPath(new URL("../fixtures/docker-token-retry", import.meta.url));

async function buildFixtureImage(tag: string) {
  const baseImage = process.env.NODE_BASE_IMAGE ?? "node:24-bookworm";
  const context = await mkdtemp(join(tmpdir(), "oce-token-retry-"));
  try {
    // Use the installed production WebSocket dependency without installing or
    // changing the workspace graph. The fixture runs the actual readiness script.
    const require = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
    const kubernetesRequire = createRequire(require.resolve("@kubernetes/client-node"));
    const wsDirectory = dirname(kubernetesRequire.resolve("ws/package.json"));
    await cp(fixtureDirectory, context, { recursive: true });
    await cp(wsDirectory, join(context, "ws"), { recursive: true });
    await writeFile(
      join(context, "provenance.json"),
      JSON.stringify({
        source: "https://github.com/openclaw/openclaw",
        commit: GATEWAY_TOOL_POLICY_SOURCE_COMMIT,
      }),
    );
    await docker(
      [
        "build",
        "--pull=false",
        "--build-arg",
        `NODE_BASE_IMAGE=${baseImage}`,
        "--tag",
        tag,
        context,
      ],
      { timeoutMs: 180_000 },
    );
  } finally {
    await rm(context, { recursive: true, force: true });
  }
}

function namespace(label: string): Namespace {
  return {
    id: `ns_${randomUUID()}`,
    name: label,
    status: "ready",
    createdAt: new Date().toISOString(),
  };
}

function isConfigurationDocument(value: unknown): value is OpenClawConfigurationDocument {
  return Check({ SafeJsonValue: JsonValue }, ConfigurationValues, value);
}

type DirectDockerRevision = Omit<AgentRevision, "harnessAuth"> & { readonly harnessAuth?: never };

function revision(driver: DockerComputeDriver, owner: Namespace): DirectDockerRevision {
  const agentId = `agt_${randomUUID()}`;
  const nativeConfiguration: unknown = createHarnessConfiguration("codex", "gpt-4.1");
  assert.ok(
    isConfigurationDocument(nativeConfiguration),
    "expected a native configuration document",
  );
  return {
    id: `rev_${randomUUID()}`,
    namespaceId: owner.id,
    agentId,
    revision: 1,
    backendId: null,
    gatewayManagedMode: false,
    configurationId: `cfg_${randomUUID()}`,
    configurationKind: "agent",
    configurationGeneration: 1,
    executionAdmission: { version: 2, mode: "unprotected" },
    configuration: admitLoggingConfiguration(nativeConfiguration, "info"),
    harness: { id: "codex", version: "1.0.0", mode: "dedicated", overrides: {}, configuration: {} },
    compute: { id: driver.id, implementation: driver.implementation },
    servicePrincipalId: `service-agent-${agentId}`,
    createdAt: new Date().toISOString(),
  };
}

function prepareRevision(driver: DockerComputeDriver, candidate: DirectDockerRevision) {
  // The public revision requires Harness auth. The Docker Driver rejects every
  // binding and accepts its absence only when called directly as in this fixture.
  return driver.prepareRevision(candidate as AgentRevision);
}

// These disposable binaries implement token authentication, WebSocket ping/pong,
// and an empty plugin catalog for startup. This exercises Docker reconciliation,
// not genuine Codex, plugin installation, or model turns.
test(
  "Docker driver keeps dedicated transport coherent and rejects foreign owners across retries",
  { ...requiresDockerTokenRetry, timeout: 360_000 },
  async (context) => {
    await docker(["version"], { timeoutMs: 30_000 });
    const image = `oce-docker-token-retry:${randomUUID()}`;
    const foreignOwners = new Map<string, string | undefined>();
    const driver = new DockerComputeDriver({ images: { gateway: image, agent: image } });
    const owner = namespace("token-retry");
    // The fixture login consumes this inert value; no model endpoint is called.
    setEnvironment(context, { OPENAI_API_KEY: "docker-token-retry-fixture-key" });
    context.after(() =>
      cleanUp(
        ...[...foreignOwners].map(([agentId, expectedId]) => async () => {
          const ids = await containerIds(owner.id, { [labelAgent]: agentId });
          assert.ok(ids.length <= 1, "only one container may use the foreign fixture identity");
          const [id] = ids;
          if (id !== undefined) {
            assert.ok(
              expectedId === undefined || id === expectedId,
              "foreign container ID changed",
            );
            await docker(["rm", "-f", id]);
          }
          assert.equal((await containerIds(owner.id, { [labelAgent]: agentId })).length, 0);
        }),
        async () => {
          assert.equal((await driver.deleteNamespace(owner)).namespaceDeleted, true);
        },
        () => assertNamespaceEmpty(owner.id),
        () => cleanUpNamespace(owner.id),
        () => removeFixtureImage(image),
      ),
    );
    await buildFixtureImage(image);
    await driver.preflight();
    const candidate = revision(driver, owner);
    const expected = {
      namespaceId: owner.id,
      agentId: candidate.agentId,
      revisionId: candidate.id,
      ready: true,
    };
    assert.deepEqual(await driver.ensureNamespace(owner), {
      namespaceId: owner.id,
      namespaceReady: true,
    });
    assert.deepEqual(await prepareRevision(driver, candidate), expected);
    const first = await waitForRuntime(owner.id, candidate.agentId, candidate.id);
    const originalToken = containerEnv(first.agent, "APP_SERVER_TOKEN");
    assert.ok(
      typeof originalToken === "string" && originalToken.length > 0,
      "app server owns a nonempty transport token",
    );
    assert.ok(
      originalToken === containerEnv(first.gateway, "APP_SERVER_TOKEN"),
      "initial gateway uses the app-server token",
    );
    await assertGatewayCanReachAgent(first.gateway);

    // Losing only the gateway preserves the healthy owned app server and its
    // credential; a fresh per-attempt token must not reach the replacement gateway.
    await docker(["rm", "-f", first.gateway.Id]);
    assert.deepEqual(await prepareRevision(driver, candidate), expected);
    const afterGatewayRetry = await waitForRuntime(owner.id, candidate.agentId, candidate.id);
    await assertGatewayCanReachAgent(afterGatewayRetry.gateway);
    assert.equal(afterGatewayRetry.agent.Id, first.agent.Id);
    assert.notEqual(afterGatewayRetry.gateway.Id, first.gateway.Id);
    assert.ok(
      containerEnv(afterGatewayRetry.agent, "APP_SERVER_TOKEN") === originalToken,
      "retained app-server token is unchanged",
    );
    assert.ok(
      containerEnv(afterGatewayRetry.gateway, "APP_SERVER_TOKEN") === originalToken,
      "replacement gateway uses retained app-server token",
    );

    // Losing the app server rotates its credential. The still-healthy gateway
    // must be replaced because the app server, not the gateway, owns the token.
    await docker(["kill", afterGatewayRetry.agent.Id]);
    assert.deepEqual(await prepareRevision(driver, candidate), expected);
    const afterAgentRetry = await waitForRuntime(owner.id, candidate.agentId, candidate.id);
    await assertGatewayCanReachAgent(afterAgentRetry.gateway);
    assert.notEqual(afterAgentRetry.agent.Id, afterGatewayRetry.agent.Id);
    assert.notEqual(afterAgentRetry.gateway.Id, afterGatewayRetry.gateway.Id);
    const replacementToken = containerEnv(afterAgentRetry.agent, "APP_SERVER_TOKEN");
    assert.ok(
      typeof replacementToken === "string" &&
        replacementToken.length > 0 &&
        replacementToken !== originalToken,
      "replacement app server rotates its transport token",
    );
    assert.ok(
      containerEnv(afterAgentRetry.gateway, "APP_SERVER_TOKEN") === replacementToken,
      "gateway follows the replacement app-server token",
    );

    for (const role of ["agent", "gateway"] as const) {
      const before = await waitForRuntime(owner.id, candidate.agentId, candidate.id);
      const foreignId = await replaceWithForeignOwner(before[role], role, foreignOwners);
      // Same-name, same-revision collisions must be refused before reading a
      // token, reusing the container, or deleting another Agent's workload.
      await assert.rejects(prepareRevision(driver, candidate), /Refusing unowned Docker container/);
      const preserved = await inspectContainer(foreignId);
      assert.equal(preserved.Id, foreignId);
      assert.equal(preserved.State.Running, true);
      const sibling = role === "agent" ? before.gateway : before.agent;
      const retainedSibling = await inspectContainer(sibling.Id);
      assert.equal(retainedSibling.Id, sibling.Id);
      assert.equal(retainedSibling.State.Running, true);
      await docker(["rm", "-f", foreignId]);
      assert.deepEqual(await prepareRevision(driver, candidate), expected);
      const recovered = await waitForRuntime(owner.id, candidate.agentId, candidate.id);
      await assertGatewayCanReachAgent(recovered.gateway);
    }
  },
);

test(
  "Docker Namespace deletion cleans up owned containers after its network is removed",
  { ...requiresDockerTokenRetry, timeout: 60_000 },
  async (context) => {
    const image = process.env.NODE_BASE_IMAGE ?? "node:24-bookworm";
    const driver = new DockerComputeDriver({ images: { gateway: image, agent: image } });
    const owner = namespace("namespace-cleanup");
    const sibling = namespace("namespace-cleanup-sibling");
    const volume = `oce-namespace-cleanup-${randomUUID()}`;
    context.after(() =>
      cleanUp(
        () => cleanUpNamespace(owner.id),
        () => cleanUpNamespace(sibling.id),
      ),
    );
    await driver.preflight();
    const orphan = await createNamespaceContainer(driver, owner, image);
    const retained = await createNamespaceContainer(driver, sibling, image);
    await docker([
      "volume",
      "create",
      ...namespaceLabels(owner.id),
      "--label",
      `${labelRole}=workspace`,
      volume,
    ]);
    assert.deepEqual(await workspaceVolumes(owner.id), [volume]);
    // External network cleanup can leave an owned container disconnected. The
    // worker must not settle deletion solely because the network is absent.
    await docker(["network", "disconnect", "--force", orphan.network, orphan.container]);
    await docker(["network", "rm", orphan.network]);
    assert.deepEqual(await driver.deleteNamespace(owner), {
      namespaceId: owner.id,
      namespaceDeleted: true,
    });
    await assertNamespaceEmpty(owner.id);
    await assertVolumeRemoved(volume);
    // A sibling's exact container and network remain under the same ownership.
    assert.deepEqual(await containerIds(sibling.id), [retained.container]);
    assert.deepEqual(await networkIds(sibling.id), [retained.network]);
    // Normal deletion and repeated deletion retain the same cleanup contract.
    assert.equal((await driver.deleteNamespace(sibling)).namespaceDeleted, true);
    await assertNamespaceEmpty(sibling.id);
    assert.equal((await driver.deleteNamespace(owner)).namespaceDeleted, true);
  },
);

async function createNamespaceContainer(
  driver: DockerComputeDriver,
  owner: Namespace,
  image: string,
) {
  assert.equal((await driver.ensureNamespace(owner)).namespaceReady, true);
  const networks = await networkIds(owner.id);
  const [network] = networks;
  assert.ok(networks.length === 1 && network, "expected one owned namespace network");
  const { stdout } = await docker([
    "create",
    "--network",
    network,
    ...namespaceLabels(owner.id),
    "--label",
    `${labelAgent}=agt_${randomUUID()}`,
    "--label",
    `${labelRevision}=rev_${randomUUID()}`,
    "--label",
    `${labelRole}=gateway`,
    image,
    "node",
    "-e",
    "setInterval(() => {}, 1000)",
  ]);
  const container = stdout.trim();
  assert.ok(/^[0-9a-f]{64}$/.test(container), "Docker create must return a full container ID");
  return { network, container };
}

async function assertNamespaceEmpty(namespaceId: string) {
  await cleanUp(
    async () =>
      assert.equal((await containerIds(namespaceId)).length, 0, "owned containers remain"),
    async () => assert.equal((await networkIds(namespaceId)).length, 0, "owned networks remain"),
    async () =>
      assert.equal(
        (await workspaceVolumes(namespaceId)).length,
        0,
        "owned workspace volumes remain",
      ),
  );
}

async function cleanUpNamespace(namespaceId: string) {
  // Use the fixture's UUID and ownership labels to remove resources even if
  // the Driver leaves the container behind when the network is missing.
  await cleanUp(
    async () =>
      cleanUp(
        ...(await containerIds(namespaceId)).map((id) => async () => {
          await docker(["rm", "-f", id]);
        }),
      ),
    async () =>
      cleanUp(
        ...(await networkIds(namespaceId)).map((id) => async () => {
          await docker(["network", "rm", id]);
        }),
      ),
    async () =>
      cleanUp(
        ...(await workspaceVolumes(namespaceId)).map((name) => async () => {
          await docker(["volume", "rm", name]);
        }),
      ),
    () => assertNamespaceEmpty(namespaceId),
  );
}
