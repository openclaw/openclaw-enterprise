import assert from "node:assert/strict";

import type {
  ComputeDriver,
  RepositoryBindingRequest,
} from "../../packages/contracts/src/index.ts";
import type { PostgresPlatformState } from "../../packages/occ/src/index.ts";
import { createTestKubernetesComputeDriver } from "./kubernetes-compute.mjs";
import { repositoryBoundary } from "./postgres-worker-revision-support.mjs";
import { SAVED_REPOSITORY_SELECTION_NOT_APPROVED } from "./refusal-text.mjs";

type Target = {
  fixture: {
    state: PostgresPlatformState;
    request: (
      method: string,
      path: string,
    ) => Promise<{
      status: number;
      body: unknown;
      data: unknown;
      error?: { message: string };
    }>;
    revokeCurrentPrincipal: () => Promise<unknown>;
    cancelProvisioningAtTeardown: (namespaceId: string, agentId: string) => void;
  };
  namespace: { id: string };
  admitted: { data: { provisioning: { workId: string; url: string } } };
  failed: { agentId: string };
};

export async function assertProvisioningRepositoryStatus(
  computeDriver: ComputeDriver,
  setup: (
    options: {
      computeDriver: ComputeDriver;
      repoDriver: ReturnType<typeof repositoryBoundary>["driver"];
    },
    overrides: { repositoryBindings: RepositoryBindingRequest[]; pluginApprovers: [] },
  ) => Promise<Target>,
) {
  const boundary = repositoryBoundary({ backendId: "provisioning-repositories" });
  const {
    driver: repoDriver,
    snapshot: {
      bindings: [binding],
    },
  } = boundary;
  assert.ok(binding);
  const topology = createTestKubernetesComputeDriver("gateway", { repositoryCredentials: true });
  computeDriver.validateRepositoryCredentials =
    topology.validateRepositoryCredentials.bind(topology);
  const { fixture, namespace, admitted, failed } = await setup(
    { computeDriver, repoDriver },
    {
      repositoryBindings: [{ repositoryRef: binding.repositoryRef, profile: binding.profile }],
      pluginApprovers: [],
    },
  );
  fixture.cancelProvisioningAtTeardown(namespace.id, failed.agentId);
  const { workId, url } = admitted.data.provisioning;
  const snapshot = () => fixture.state.read((state) => state.provisioning.findWithWork(workId));
  const stored = await snapshot();
  assert.equal(stored?.record.agentId, failed.agentId);
  assert.ok(stored?.work);

  const calls: string[] = [];
  repoDriver.resolve = () => {
    calls.push("resolve");
    throw new Error("withdrawn repository access");
  };
  repoDriver.listOptions = async () => {
    calls.push("listOptions");
    throw new Error("withdrawn repository access");
  };
  const status = await fixture.request("GET", url);
  assert.equal(status.status, 200, JSON.stringify(status.body));
  assert.deepEqual(status.data, failed);
  assert.deepEqual(calls, []);
  assert.deepEqual(boundary.calls, []);
  assert.deepEqual(await snapshot(), stored);

  // Cancellation independently forbids retry; repository refusal must still take precedence.
  const stopped = await fixture.request(
    "POST",
    `/namespaces/${namespace.id}/agents/${failed.agentId}/stop`,
  );
  assert.equal(stopped.status, 202, JSON.stringify(stopped.body));
  const cancelled = await snapshot();
  assert.equal(cancelled?.record.status, "cancelled");
  const retry = await fixture.request("POST", `${url}/retry`);
  assert.equal(retry.status, 409, JSON.stringify(retry.body));
  assert.equal(retry.error?.message, SAVED_REPOSITORY_SELECTION_NOT_APPROVED);
  assert.deepEqual(calls, ["resolve"]);
  assert.deepEqual(await snapshot(), cancelled, "refused retry must not requeue work");

  await fixture.revokeCurrentPrincipal();
  const denied = await fixture.request("GET", url);
  assert.equal(denied.status, 403, JSON.stringify(denied.body));
  assert.deepEqual(calls, ["resolve"]);
}
