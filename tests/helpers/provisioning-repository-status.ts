import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import type { PostgresPlatformState } from "../../packages/occ/src/index.ts";
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
    restartApi: () => Promise<void>;
    revokeCurrentPrincipal: () => Promise<unknown>;
    cancelProvisioningAtTeardown: (namespaceId: string, agentId: string) => void;
  };
  repository: { setApprovedNamespace: (namespaceId: string) => Promise<void> };
  namespace: { id: string };
  admitted: { data: { provisioning: { workId: string; url: string } } };
  failed: { agentId: string };
};

export async function assertProvisioningRepositoryStatus({
  fixture,
  repository,
  namespace,
  admitted,
  failed,
}: Target) {
  fixture.cancelProvisioningAtTeardown(namespace.id, failed.agentId);
  const { workId, url } = admitted.data.provisioning;
  const snapshot = () => fixture.state.read((state) => state.provisioning.findWithWork(workId));
  const stored = await snapshot();
  assert.equal(stored?.record.agentId, failed.agentId);
  assert.ok(stored?.work);

  await repository.setApprovedNamespace(`ns_${randomUUID()}`);
  await fixture.restartApi();
  const status = await fixture.request("GET", url);
  assert.equal(status.status, 200, JSON.stringify(status.body));
  assert.deepEqual(status.data, failed);
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
  assert.deepEqual(await snapshot(), cancelled, "refused retry must not requeue work");

  await fixture.revokeCurrentPrincipal();
  const denied = await fixture.request("GET", url);
  assert.equal(denied.status, 403, JSON.stringify(denied.body));
}
