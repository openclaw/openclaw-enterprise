import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import type { CredentialSource, Installation, Namespace } from "@openclaw-enterprise/contracts";

import { OpenShellGateway } from "../../apps/controller/src/backends/openshell.ts";
import {
  assertConnectedResponse,
  sendConnectedRequest,
  serializeConnectedRequest,
} from "./egress-connected-inputs.mjs";
import { createRealKubernetesFixture } from "./kubernetes-real.mjs";
import type { RunWindow } from "./public-egress-deadline.ts";
import type { PublicEgressInputs } from "./public-egress-inputs.ts";
import {
  onlyReadyPod,
  publicEgressKubernetes,
  runningContainer,
} from "./public-egress-kubernetes.ts";
import type { PublicEgressRequest } from "./public-egress-resources.ts";

const sourceFiles = [
  "apps/controller/src/drivers/sandbox/openshell.ts",
  "apps/controller/src/drivers/sandbox/proto/openshell-gateway.proto",
  "apps/controller/src/drivers/egress-proxy/openshell.ts",
  "packages/occ/src/index.ts",
  "apps/controller/src/drivers/credential-gateway/openshell.ts",
  "tests/integration/public-egress-connected.test.ts",
  "tests/helpers/public-egress-deadline.ts",
  "tests/helpers/normal-agent-tools.mjs",
  "tests/helpers/public-egress-inputs.ts",
  "tests/helpers/public-egress-kubernetes.ts",
  "tests/helpers/public-egress-probes.ts",
  "tests/helpers/public-egress-programs.ts",
  "tests/helpers/public-egress-qa.ts",
  "tests/helpers/public-egress-resources.ts",
  "tests/helpers/public-egress-runtime.ts",
  "tests/helpers/public-egress-stack.ts",
  "tests/helpers/public-egress-workflow.ts",
  "tests/helpers/refusal-text.mjs",
  "tests/helpers/egress-connected-inputs.mjs",
];

export async function publicEgressEvidence(input: PublicEgressInputs["input"], window: RunWindow) {
  const runId = randomUUID();
  await mkdir(input.evidenceDirectory, { recursive: true, mode: 0o700 });
  const save = (name: string, value: object) =>
    writeFile(
      join(input.evidenceDirectory, name + ".json"),
      JSON.stringify({ runId, ...value }, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
  const sourceHashes = Object.fromEntries(
    await Promise.all(
      sourceFiles.map(async (path) => [
        path,
        createHash("sha256")
          .update(
            await readFile(new URL("../../" + path, import.meta.url), { signal: window.signal }),
          )
          .digest("hex"),
      ]),
    ),
  );
  await save("run", {
    oceCommit: input.oceCommit,
    sourceHashes,
    clusterUID: input.clusterUID,
    workDeadline: window.endsAt,
  });
  return { runId, save };
}

export function publicEgressController(apiOrigin: string, serviceKey: string, window: RunWindow) {
  const request: PublicEgressRequest = async (method, path, body, phase) => {
    const signal = phase ?? window.limit(20_000);
    signal.throwIfAborted();
    const response = await sendConnectedRequest(
      { apiOrigin, serviceKey },
      serializeConnectedRequest(method, path, body),
      AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    );
    const text = await response.text();
    assert.equal(text.includes(serviceKey), false, "the controller must not echo its credential");
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  };
  async function api<T>(
    method: Parameters<PublicEgressRequest>[0],
    path: string,
    body?: object,
    expected = 200,
    signal?: AbortSignal,
  ): Promise<T> {
    return assertConnectedResponse(await request(method, path, body, signal), expected);
  }
  return { request, api };
}

export async function observePublicEgressStack(
  { input, serviceKey, supplierEndpoint, databaseUrl }: PublicEgressInputs,
  evidence: Awaited<ReturnType<typeof publicEgressEvidence>>,
  window: RunWindow,
  after: (cleanup: (window: RunWindow) => unknown) => void,
) {
  const f = createRealKubernetesFixture({
    kubeconfigPath: input.kubeconfigPath,
    kubernetesContext: input.kubernetesContext,
    gatewayImage: input.images.gateway,
    codexImage: input.images.agent,
    databaseUrl,
  });
  // The shared fixture's prerequisites and forward startup have their own
  // time limits. Leave room for them before starting either operation.
  window.require(30_000);
  await f.validatePrerequisites();
  const kube = publicEgressKubernetes(input, window);
  const checkCluster = async (during: RunWindow) =>
    assert.equal(
      (await publicEgressKubernetes(input, during).namespace("kube-system")).metadata.uid,
      input.clusterUID,
    );
  await checkCluster(window);

  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 2,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
    query_timeout: 15_000,
  });
  after(() => pool.end());
  const { api } = publicEgressController(input.apiOrigin, serviceKey, window);
  const namespacePath = "/namespaces/" + input.namespaceId;
  assert.equal((await api<Installation>("GET", "/installation")).id, input.installationId);
  assert.equal((await api<Namespace>("GET", namespacePath)).status, "ready");
  const source = await api<CredentialSource>(
    "GET",
    namespacePath + "/credential-sources/" + input.modelSourceId,
  );
  assert.equal(source.state, "ready");
  assert.equal(source.ownerCapability, "credential_gateway");
  assert.equal(source.egress, undefined, "retain the existing Gateway-owned model source");
  window.require(30_000);
  assert.deepEqual((await pool.query("SELECT current_user AS role")).rows, [{ role: "occ_app" }]);
  assert.deepEqual((await pool.query("SELECT id FROM occ.installation")).rows, [
    { id: input.installationId },
  ]);

  const placements = await kube.namespaces("-l", "openclaw.dev/namespace=" + input.namespaceId);
  assert.equal(placements.length, 1);
  const placement = placements[0]!.metadata.name;
  const observeSupplier = async () => {
    const pod = onlyReadyPod(
      await kube.pods(input.openShellGatewayNamespace, input.openShellGatewaySelector),
      "selected OpenShell Gateway",
    );
    const supplier = runningContainer(pod, "openshell-gateway", input.images.openShellGateway);
    assert.ok(
      pod.spec.containers
        .find(({ name }) => name === "openshell-gateway")
        ?.ports?.some((port) => port.protocol === "TCP" && port.containerPort === 8080),
      "the selected Gateway container must declare its forwarded TCP listener",
    );
    const owner = pod.metadata.ownerReferences?.find(
      (ref) => ref.controller === true && ref.kind === "StatefulSet",
    );
    assert.ok(owner?.uid);
    const statefulSet = await kube.statefulSet(supplier.namespace, owner.name);
    assert.equal(statefulSet.metadata.uid, owner.uid);
    assert.equal(statefulSet.apiVersion, owner.apiVersion);
    assert.equal(
      statefulSet.spec.template.spec.containers.find(({ name }) => name === "openshell-gateway")
        ?.image,
      input.images.openShellGateway,
    );
    return { ...supplier, owner };
  };
  const supplier = await observeSupplier();
  // Forward to the exact Pod. Changing only the port preserves CA, IP and
  // client identity validation for the operator's loopback profile.
  window.require(45_000);
  const forwarding = await f.startPortForwardTarget(
    supplier.namespace,
    "pod/" + supplier.pod,
    "0:8080",
  );
  after(() => forwarding.stop());
  const checkSupplier = async () =>
    assert.deepEqual(
      await observeSupplier(),
      supplier,
      "the forwarded Gateway must remain current",
    );
  await checkSupplier();
  const endpoint = new URL(supplierEndpoint);
  endpoint.port = new URL(forwarding.url).port;
  const backend = new OpenShellGateway({ ...input.openShellBackend, endpoint: endpoint.origin });
  after(() => backend.close());
  const transport = { ...supplier, endpoint: endpoint.origin };
  await evidence.save("supplier-transport", transport);
  return {
    api,
    pool,
    kube,
    namespacePath,
    placement,
    gateway: backend.clientForNamespace(placement),
    checkCluster,
    checkSupplier,
    transport,
  };
}

export type PublicEgressStack = Awaited<ReturnType<typeof observePublicEgressStack>>;
export type PublicEgressEvidence = Awaited<ReturnType<typeof publicEgressEvidence>>;
