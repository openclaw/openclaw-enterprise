import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import type {
  Agent,
  AgentRevision,
  Configuration,
  HarnessAuthBinding,
} from "@openclaw-enterprise/contracts";
import type {
  OpenShellGatewayClient,
  OpenShellProviderResponse,
  OpenShellStoredProviderProfile,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import type {
  ModelOriginObservation,
  ModelOriginTurn,
} from "../fixtures/openshell-model-origin.ts";
import { mixedGrantDeploymentCode } from "./openshell-mixed-grant-setup.ts";
import { availablePort } from "./available-port.mjs";
import { createHarnessConfiguration } from "./harness-configuration.mjs";
import { stopProcess } from "./stop-process.mjs";

type SelectedProvider = OpenShellProviderResponse & {
  id: string;
  profile: OpenShellStoredProviderProfile;
};

// clientRevision() exposes these fields but not the private admission snapshot.
type PublicAgentRevision = Pick<AgentRevision, "id" | "namespaceId" | "agentId" | "harness"> & {
  harnessAuth: HarnessAuthBinding;
};

interface ModelAdmission {
  namespaceId: string;
  agentId: string;
  revisionId: string;
  execution: {
    namespaceId: string | null;
    agentId: string | null;
    revisionId: string | null;
  };
  authorization: string | null;
  repositoryGitAuthorization: string | null;
  routeCount: number | null;
  route: {
    bindingId: string | null;
    sourceId: string | null;
    grantKind: string | null;
    method: string | null;
    path: string | null;
    origin: string | null;
  };
}

interface MixedGrantFixture {
  request: (method: string, path: string, body?: unknown) => Promise<unknown>;
  namespace: { id: string };
  modelSource: { id: string; config: Readonly<Record<string, string>> };
  repositoryRef: string;
  model: string;
  kube: (args: string[]) => Promise<string>;
  gatewayClient: Pick<OpenShellGatewayClient, "getSandbox">;
  workspace: string;
  stateDirectory: string;
  after: (operation: () => Promise<void>) => void;
  verifySupervisorImage: (target: { sandboxName: string; sandboxId: string }) => Promise<{
    workloadPodUid: string;
    sandboxId: string;
    supervisorPodName: string;
    supervisorPodUid: string;
    image: string;
    imageId: string;
    containerId: string;
    binaryHash: string;
  }>;
  readModelAdmission: (identity: {
    agentId: string;
    revisionId: string;
  }) => Promise<ModelAdmission>;
  registerProviders: (
    revision: Pick<PublicAgentRevision, "id">,
    agent: Agent,
  ) => Promise<{
    modelProvider: SelectedProvider;
    gitProvider: SelectedProvider;
  }>;
  modelTurns: { before: ModelOriginTurn; after: ModelOriginTurn };
  modelOrigin: {
    readOriginTurn: (
      turnId: string,
    ) => Promise<Extract<ModelOriginObservation, { kind: "turn" }> | undefined>;
  };
}

interface RuntimePod {
  metadata: {
    name: string;
    uid: string;
    namespace: string;
    deletionTimestamp?: string;
    labels: Record<string, string>;
    ownerReferences: { kind: string; name: string; uid: string }[];
  };
  spec: {
    containers: {
      name: string;
      env?: {
        name: string;
        valueFrom?: { secretKeyRef?: { name: string; key: string } };
      }[];
    }[];
  };
  status: {
    conditions: { type: string; status: string }[];
    containerStatuses: {
      name: string;
      containerID: string;
      imageID: string;
      restartCount: number;
      state: { running?: { startedAt: string } };
    }[];
  };
}

interface DeploymentObservation {
  namespaceId: string;
  agentId: string;
  deploymentId: string;
  status: string;
  error?: { code?: unknown } | null;
}

async function observeUntil<T>(
  label: string,
  signal: AbortSignal,
  observe: () => Promise<T | undefined>,
  timeout: number,
): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const result = await observe();
    if (result !== undefined) {
      return result;
    }
    await delay(1000, undefined, { signal });
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function gatewayAccess(
  t: TestContext,
  fixture: MixedGrantFixture,
  agent: Agent,
  revision: Pick<PublicAgentRevision, "id">,
) {
  const selector = `openclaw.dev/namespace=${fixture.namespace.id},openclaw.dev/agent=${agent.id},openclaw.dev/revision=${revision.id},openclaw.dev/workload-role=gateway`;
  const pods = JSON.parse(
    await fixture.kube(["get", "pods", "-A", "-l", selector, "-o", "json"]),
  ) as { items: RuntimePod[] };
  const ready = pods.items.filter(
    (pod) =>
      !pod.metadata.deletionTimestamp &&
      pod.status.conditions.some(({ type, status }) => type === "Ready" && status === "True"),
  );
  assert.equal(ready.length, 1, "expected one Ready Gateway Pod for the selected Agent revision");
  const pod = ready[0];
  assert.ok(pod);
  const passwordRef = pod.spec.containers
    .find(({ name }) => name === "gateway")
    ?.env?.find(({ name }) => name === "OPENCLAW_GATEWAY_PASSWORD")?.valueFrom?.secretKeyRef;
  assert.ok(passwordRef, "the selected Gateway must reference its transport Secret");
  const secret = JSON.parse(
    await fixture.kube([
      "get",
      "secret",
      passwordRef.name,
      "-n",
      pod.metadata.namespace,
      "-o",
      "json",
    ]),
  ) as { data: Record<string, string> };
  const encodedPassword = secret.data[passwordRef.key];
  assert.ok(encodedPassword, "the Gateway transport Secret must contain its password");
  const gatewayPassword = Buffer.from(encodedPassword, "base64").toString();
  assert.ok(gatewayPassword, "the Gateway transport password must not be empty");

  const state = JSON.parse(await readFile(join(fixture.stateDirectory, "state.json"), "utf8")) as {
    cluster: string;
  };
  assert.match(state.cluster, /^occ-dev-first-agent-[a-f0-9]{12}$/u);
  const port = await availablePort();
  const environment = Object.fromEntries(
    ["PATH", "HOME", "TMPDIR"].flatMap((name) => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
  const child = spawn(
    "kubectl",
    [
      "--kubeconfig",
      join(fixture.stateDirectory, "kubeconfig"),
      "--context",
      `k3d-${state.cluster}`,
      "-n",
      pod.metadata.namespace,
      "port-forward",
      "--address=127.0.0.1",
      `pod/${pod.metadata.name}`,
      `${port}:http`,
    ],
    { env: environment, stdio: ["ignore", "pipe", "ignore"] },
  );
  let failed = false;
  let output = "";
  child.on("error", () => {
    failed = true;
  });
  child.stdout.on("data", (chunk: Buffer) => {
    output = `${output}${chunk.toString()}`.slice(-1024);
  });
  // The fixture owns this forward even when startup or a later assertion fails.
  fixture.after(async () => {
    if (child.pid !== undefined) {
      await stopProcess(child);
    }
  });
  await observeUntil(
    "selected Agent Gateway forwarding",
    t.signal,
    async () => {
      assert.equal(failed, false, "Agent Gateway forwarding could not start");
      assert.equal(child.exitCode, null, "Agent Gateway forwarding exited");
      assert.equal(child.signalCode, null, "Agent Gateway forwarding was terminated");
      return output.includes(`Forwarding from 127.0.0.1:${port} ->`) ? true : undefined;
    },
    30_000,
  );
  return { gatewayUrl: `http://127.0.0.1:${port}`, gatewayPassword };
}

export async function deployMixedGrantAgent(t: TestContext, fixture: MixedGrantFixture) {
  const { request, namespace, modelSource, repositoryRef, model, gatewayClient, workspace } =
    fixture;
  assert.ok(model, "select the controlled model before provisioning the Agent");
  const base = `/namespaces/${namespace.id}`;
  const suffix = randomUUID();
  const configuration = (await request("POST", `${base}/configurations`, {
    kind: "agent",
    values: createHarnessConfiguration("codex", model),
  })) as Configuration;
  const agent = (await request("POST", `${base}/agents`, {
    name: `mixed-grant-${suffix}`,
    configurationId: configuration.id,
    executionMode: "dedicated",
    harnessAuth: { method: "credential_source", sourceId: modelSource.id },
    credentialSources: [{ sourceId: modelSource.id }],
    repositoryBindings: [{ repositoryRef, profile: "github-repository" }],
  })) as Agent;
  assert.equal(agent.namespaceId, namespace.id);
  const path = `${base}/agents/${agent.id}`;
  const role = (await request("POST", `${base}/iam/roles`, {
    name: `mixed-grant-model-${suffix}`,
    permissions: [{ action: "operate", resourceKind: "credential_source" }],
  })) as { id: string };
  await request("POST", `${base}/iam/access-bindings`, {
    subjectKind: "identity",
    subjectId: agent.servicePrincipalId,
    roleId: role.id,
    resourceKind: "credential_source",
    resourceId: modelSource.id,
  });
  const transport = (await request("POST", `${path}/runtime-credentials`, {})) as {
    transportConfigured: boolean;
  };
  assert.equal(transport.transportConfigured, true);
  const modelBaseUrl = modelSource.config.authorized_base_url;
  assert.ok(modelBaseUrl, "The controlled model source must name its authorized destination");
  // The embedded Codex provider stays fail closed. Its actual model destination
  // is selected independently by the Kubernetes Harness at deployment.
  const selectedModelProvider = {
    protocol: "openai-responses",
    baseUrl: modelBaseUrl,
    supportsStandaloneWebSearch: false,
  };
  const revision = (await request("POST", `${path}/deploy`, {
    harnessOverrides: { modelProvider: selectedModelProvider },
  })) as PublicAgentRevision;
  assert.deepEqual(revision.harness.configuration.modelProvider, selectedModelProvider);
  assert.equal(revision.namespaceId, namespace.id);
  assert.equal(revision.agentId, agent.id);
  assert.equal(revision.harness.id, "codex");
  assert.ok(revision.harnessAuth.method === "credential_source");
  assert.equal(revision.harnessAuth.sourceId, modelSource.id);
  const modelAdmission = await fixture.readModelAdmission({
    agentId: agent.id,
    revisionId: revision.id,
  });
  assert.equal(modelAdmission.namespaceId, namespace.id);
  assert.equal(modelAdmission.agentId, agent.id);
  assert.equal(modelAdmission.revisionId, revision.id);
  assert.deepEqual(modelAdmission.execution, {
    namespaceId: namespace.id,
    agentId: agent.id,
    revisionId: revision.id,
  });
  assert.equal(modelAdmission.authorization, "online-request");
  assert.equal(modelAdmission.repositoryGitAuthorization, "online-request");
  assert.equal(modelAdmission.routeCount, 1);
  assert.equal(modelAdmission.route.grantKind, "inference");
  assert.equal(modelAdmission.route.sourceId, modelSource.id);
  assert.equal(modelAdmission.route.method, "POST");
  assert.equal(modelAdmission.route.path, "/v1/responses");
  assert.equal(modelAdmission.route.origin, new URL(modelBaseUrl).origin);
  assert.ok(modelAdmission.route.bindingId, "the committed route must identify its binding");

  // Registration is required during preparation. Waiting for a successful
  // deployment first would prevent the providers from obtaining assertions.
  const { modelProvider, gitProvider } = await fixture.registerProviders(revision, agent);
  const modelCredentials = modelProvider.profile.definition?.credentials;
  assert.ok(Array.isArray(modelCredentials));
  assert.equal(modelCredentials.length, 1);
  assert.equal(modelCredentials[0]?.name, "access_token");
  assert.equal(
    modelCredentials[0]?.token_grant?.audience,
    modelAdmission.route.bindingId,
    "the selected model provider must use the independently observed committed binding",
  );
  await observeUntil(
    "mixed-grant Agent startup",
    t.signal,
    async () => {
      const deployment = (await request(
        "GET",
        `${path}/deployments/${revision.id}`,
      )) as DeploymentObservation;
      assert.equal(deployment.namespaceId, namespace.id);
      assert.equal(deployment.agentId, agent.id);
      assert.equal(deployment.deploymentId, revision.id);
      // A failed attempt may still retry. Only the selected deployment's terminal
      // status ends this wait; supplier messages are excluded from diagnostics.
      if (deployment.status === "failed") {
        const code = mixedGrantDeploymentCode(deployment.error?.code);
        throw new Error(
          `MIXED_GRANT_DEPLOYMENT_FAILED: ${code}; selected revision failed after provider registration`,
        );
      }
      const current = (await request("GET", path)) as Agent;
      assert.equal(current.namespaceId, namespace.id);
      assert.equal(current.id, agent.id);
      return current.activeRevisionId === revision.id && deployment.status === "succeeded"
        ? current
        : undefined;
    },
    10 * 60_000,
  );

  const selector = `openclaw.dev/namespace=${namespace.id},openclaw.dev/agent=${agent.id},openclaw.dev/revision=${revision.id},openclaw.dev/workload-role=agent`;
  const readExecution = async () => {
    const current = (await request("GET", path)) as Agent;
    assert.equal(current.namespaceId, namespace.id);
    assert.equal(current.id, agent.id);
    assert.equal(current.activeRevisionId, revision.id, "Agent revision changed");
    const pods = JSON.parse(
      await fixture.kube(["get", "pods", "-A", "-l", selector, "-o", "json"]),
    ) as { items: RuntimePod[] };
    assert.equal(pods.items.length, 1, "expected the single original Harness Pod");
    const pod = pods.items[0];
    assert.ok(pod);
    assert.equal(
      pod.metadata.deletionTimestamp,
      undefined,
      "the original Harness Pod is terminating",
    );
    assert.ok(
      pod.status.conditions.some(({ type, status }) => type === "Ready" && status === "True"),
      "the original Harness Pod must remain ready",
    );
    const owner = pod.metadata.ownerReferences.find(({ kind }) => kind === "Sandbox");
    assert.ok(owner?.name && owner.uid, "the supplier must own the Harness Pod");
    const resource = JSON.parse(
      await fixture.kube([
        "get",
        "sandboxes.agents.x-k8s.io",
        owner.name,
        "-n",
        pod.metadata.namespace,
        "-o",
        "json",
      ]),
    ) as { metadata: { uid: string } };
    assert.equal(resource.metadata.uid, owner.uid);
    const sandbox = await gatewayClient.getSandbox({ workspace, name: owner.name }, t.signal);
    assert.ok(sandbox?.id && sandbox.mainProcessInstanceId);
    assert.equal(sandbox.annotations["openclaw.dev/namespace-id"], namespace.id);
    assert.equal(sandbox.annotations["openclaw.dev/agent-id"], agent.id);
    assert.equal(sandbox.annotations["openclaw.dev/revision-id"], revision.id);
    const containers = pod.status.containerStatuses.map((container) => {
      assert.ok(container.containerID && container.imageID && container.state.running?.startedAt);
      assert.match(container.imageID, /sha256:[a-f0-9]{64}/u);
      return {
        name: container.name,
        id: container.containerID,
        imageId: container.imageID,
        startedAt: container.state.running.startedAt,
        restartCount: container.restartCount,
      };
    });
    return {
      sandbox,
      identity: {
        revisionId: current.activeRevisionId,
        sandboxId: sandbox.id,
        sandboxName: sandbox.name,
        sandboxUid: owner.uid,
        podUid: pod.metadata.uid,
        containers,
        mainProcessInstanceId: sandbox.mainProcessInstanceId,
        mainProcessStartedAt: sandbox.mainProcessStartedAt,
      },
    };
  };
  const original = await readExecution();
  const target = {
    sandboxName: original.sandbox.name,
    sandboxId: original.identity.sandboxId,
  };
  const supervisor = await fixture.verifySupervisorImage(target);
  assert.equal(supervisor.workloadPodUid, original.identity.podUid);
  assert.equal(supervisor.sandboxId, original.identity.sandboxId);
  const access = await gatewayAccess(t, fixture, agent, revision);
  return {
    agent,
    revision,
    configuration,
    path,
    target,
    readExecution,
    original,
    supervisor,
    modelProvider,
    gitProvider,
    modelAdmission,
    modelTurns: fixture.modelTurns,
    modelTurnOptions: { ...access, readOriginTurn: fixture.modelOrigin.readOriginTurn },
  };
}
