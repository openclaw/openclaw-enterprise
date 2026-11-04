import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { GrpcOpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import {
  openShellProviderName,
  openShellWorkspaceName,
} from "../../apps/controller/src/backends/openshell.ts";
import { validateExplicitK3dLoopbackContext } from "./kubernetes-real.mjs";
import { createOpenShellKubernetesFixture } from "./openshell-kubernetes-real.mjs";

/** Real API/worker workflow in an explicitly selected disposable managed installation. */
export async function verifyOpenShellProviderReplacement(context) {
  const path = process.env.OCC_TEST_OPENSHELL_REPLACEMENT_INPUT_FILE;
  assert.ok(path, "Select the prepared managed installation input file");
  const input = JSON.parse(await readFile(path, "utf8"));
  assert.equal(
    input.disposable,
    true,
    "The fixture must explicitly select a disposable installation",
  );
  const selection = {
    kubeconfigPath: process.env.OCC_TEST_KUBERNETES_KUBECONFIG,
    kubernetesContext: process.env.OCC_TEST_KUBERNETES_CONTEXT,
  };
  await validateExplicitK3dLoopbackContext(selection);
  const fixture = createOpenShellKubernetesFixture(selection);
  const serviceKey = (await readFile(input.serviceKeyFile, "utf8")).trim();
  const apiUrl = new URL(input.apiUrl);
  assert.ok(
    apiUrl.protocol === "https:" || ["127.0.0.1", "localhost", "[::1]"].includes(apiUrl.hostname),
  );
  const api = async (method, path, body, allowMissing = false) => {
    const response = await fetch(new URL(path, apiUrl), {
      method,
      headers: {
        "x-api-key": serviceKey,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    });
    if (allowMissing && response.status === 404) {
      return undefined;
    }
    // Do not put credential source bodies or server diagnostics into failure output.
    assert.ok(response.ok, `${method} ${path}: HTTP ${response.status}`);
    return response.status === 204 ? undefined : (await response.json()).data;
  };
  const base = `/namespaces/${input.namespaceId}`;
  const namespace = await api("GET", base);
  assert.equal(namespace.status, "ready");
  // Compute passes the mapped Kubernetes Namespace name to the OpenShell Drivers.
  const workspace = openShellWorkspaceName({ ...namespace, name: input.gatewayNamespace });
  const gateway = new GrpcOpenShellGatewayClient(input.gatewayClient);
  context.after(() => gateway.close());
  const signal = () => AbortSignal.timeout(30_000);
  const wait = async (label, observe) => {
    const deadline = Date.now() + 600_000;
    while (Date.now() < deadline) {
      const result = await observe();
      if (result) {
        return result;
      }
      await delay(1000);
    }
    throw new Error(`Timed out: ${label}`);
  };
  const agents = [];
  const sources = [];
  const bindings = [];
  let role;
  context.after(async () => {
    // Delete only resources created by this run. Wait for Agent cleanup before
    // deleting its credential sources; the prepared source and Namespace survive.
    for (const agent of agents) {
      await api("DELETE", `${base}/agents/${agent.id}`, undefined, true);
      await wait("Agent deletion", async () => {
        const remaining = await api("GET", `${base}/agents`);
        return !remaining.some((entry) => entry.id === agent.id);
      });
    }
    const remainingBindings = await api("GET", `${base}/iam/access-bindings`);
    for (const binding of bindings) {
      if (remainingBindings.some((entry) => entry.id === binding.id)) {
        await api("DELETE", `${base}/iam/access-bindings/${binding.id}`);
      }
    }
    if (role) {
      await api("DELETE", `${base}/iam/roles/${role.id}`, undefined, true);
    }
    for (const source of sources) {
      await api("DELETE", `${base}/credential-sources/${source.id}`, undefined, true);
    }
  });
  // Clone references to an authorized existing Secret, never its value. Distinct
  // source identities produce different Providers with the same credential key.
  const seed = await api("GET", `${base}/credential-sources/${input.modelSourceId}`);
  assert.ok(["openai", "codex-pat"].includes(seed.type));
  for (const suffix of ["a", "b"]) {
    sources.push(
      await api("POST", `${base}/credential-sources`, {
        name: `replacement-${suffix}-${randomUUID()}`,
        type: seed.type,
        config: seed.config,
        secrets: seed.secrets,
      }),
    );
  }
  role = await api("POST", `${base}/iam/roles`, {
    name: `Replacement sources ${randomUUID()}`,
    permissions: [{ action: "operate", resourceKind: "credential_source" }],
  });
  const deploy = async (agent) => {
    const revision = await api("POST", `${base}/agents/${agent.id}/deploy`);
    await wait("revision activation", async () => {
      const status = await api("GET", `${base}/agents/${agent.id}/deployments/${revision.id}`);
      assert.ok(!["failed", "cancelled"].includes(status.status), `Deployment ${status.status}`);
      return status.status === "succeeded";
    });
    return revision;
  };
  const sandbox = (agent) =>
    gateway.getSandbox(
      {
        workspace,
        name: `oc-${createHash("sha256").update(agent.id).digest("hex").slice(0, 16)}`,
      },
      signal(),
    );
  const turn = async (agent, revision) => {
    const pods = await fixture.resources("pods", input.gatewayNamespace);
    const pod = pods.find(
      (entry) =>
        !entry.metadata.deletionTimestamp &&
        entry.metadata.labels?.["openclaw.dev/agent"] === agent.id &&
        entry.metadata.labels?.["openclaw.dev/revision"] === revision.id &&
        entry.metadata.labels?.["openclaw.dev/workload-role"] === "gateway",
    );
    assert.ok(pod, "The active revision must have a Gateway Pod");
    const nonce = `replacement-${randomUUID()}`;
    const result = await fixture.requestCodexTurnFromGatewayPod({
      namespace: input.gatewayNamespace,
      gatewayPod: pod.metadata.name,
      providerModel: input.model,
      prompt: `Reply with exactly ${nonce}.`,
    });
    assert.ok(result.assistant.includes(nonce), "The real model turn must return its nonce");
  };
  for (let index = 0; index < 2; index++) {
    const agent = await api("POST", `${base}/agents`, {
      name: `provider-replacement-${randomUUID()}`,
      configurationId: input.configurationId,
      executionMode: "dedicated",
      harnessAuth: { method: "credential_source", sourceId: sources[0].id },
      credentialSources: [{ sourceId: sources[0].id }],
    });
    agents.push(agent);
    await api("POST", `${base}/agents/${agent.id}/runtime-credentials`, {});
    for (const source of sources) {
      bindings.push(
        await api("POST", `${base}/iam/access-bindings`, {
          subjectKind: "identity",
          subjectId: agent.servicePrincipalId,
          roleId: role.id,
          resourceKind: "credential_source",
          resourceId: source.id,
        }),
      );
    }
  }
  const first = await deploy(agents[0]);
  const peer = await deploy(agents[1]);
  const before = await sandbox(agents[0]);
  assert.ok(before?.id, "The installation must use a stable managed Sandbox per Agent");
  await turn(agents[0], first);
  await turn(agents[1], peer);
  const providerA = openShellProviderName(sources[0].id);
  const providerB = openShellProviderName(sources[1].id);
  await api("PATCH", `${base}/agents/${agents[0].id}`, {
    configurationId: input.configurationId,
    harnessAuth: { method: "credential_source", sourceId: sources[1].id },
    credentialSources: [{ sourceId: sources[1].id }],
  });
  const successor = await deploy(agents[0]);
  const after = await sandbox(agents[0]);
  assert.equal(after.id, before.id, "Source replacement must retain the Sandbox");
  assert.equal(after.spec.providers.includes(providerA), false);
  assert.equal(after.spec.providers.includes(providerB), true);
  await turn(agents[0], successor);
  // The old source belongs to the Namespace, not the replacing Agent. Its
  // Provider and the peer's attachment must remain usable after detachment.
  assert.ok(await gateway.getProvider(workspace, providerA, signal()));
  assert.ok((await sandbox(agents[1])).spec.providers.includes(providerA));
  await turn(agents[1], peer);
  const unchanged = await deploy(agents[0]);
  assert.equal((await sandbox(agents[0])).id, before.id);
  await turn(agents[0], unchanged);
  return {
    outcome:
      "model source replacement, stable Sandbox, unchanged redeploy and shared-source isolation",
  };
}
