import assert from "node:assert/strict";
import type { TestContext } from "node:test";

import { waitFor } from "./wait-for.mjs";

import type { CredentialGatewayDriver } from "../../packages/contracts/src/index.ts";
import type { PostgresPlatformState } from "../../packages/occ/src/index.ts";

type Fixture = {
  state: PostgresPlatformState;
  startWorker: () => Promise<void>;
  stopWorker: () => Promise<void>;
  request: (
    method: string,
    path: string,
    options?: { body: unknown },
  ) => Promise<{
    status: number;
    body: unknown;
    data: unknown;
  }>;
  secretDriver: { calls: unknown[] };
  computeDriver: { calls: unknown[] };
};

// Used at both queued admission and a worker-created Agent: status must keep the
// saved result observable without changing the requirements for another write.
export async function assertProvisioningSourceStatus(
  context: TestContext,
  fixture: Fixture,
  gateway: CredentialGatewayDriver,
  target: { workId: string; url: string; admissionPath: string; body: unknown },
) {
  const saved = await fixture.request("GET", target.url);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const snapshot = () =>
    fixture.state.read((state) => state.provisioning.findWithWork(target.workId));
  const stored = await snapshot();
  const secretCalls = structuredClone(fixture.secretDriver.calls);
  const computeCalls = structuredClone(fixture.computeDriver.calls);
  const providerCalls = (
    [
      "registerSource",
      "updateSource",
      "sourceStatus",
      "removeSource",
      "attachForRevision",
      "attachmentStatus",
      "withdraw",
    ] as const
  ).map((method) => context.mock.method(gateway, method));
  const catalog = gateway.listSourceTypes;
  let calls = 0;
  try {
    for (const failure of ["outage", "withdrawn"] as const) {
      gateway.listSourceTypes = async () => {
        calls++;
        if (failure === "outage") {
          throw new Error("catalog unavailable");
        }
        return [];
      };
      calls = 0;
      const status = await fixture.request("GET", target.url);
      assert.equal(status.status, 200, JSON.stringify(status.body));
      assert.deepEqual(status.data, saved.data);
      assert.equal(calls, 0, "status must not consult the admission catalog");
      assert.ok(providerCalls.every((method) => method.mock.callCount() === 0));
      assert.deepEqual(await snapshot(), stored);
      assert.deepEqual(fixture.secretDriver.calls, secretCalls);
      assert.deepEqual(fixture.computeDriver.calls, computeCalls);

      // Retry's preliminary authorization still precedes lifecycle refusal.
      const retry = await fixture.request("POST", `${target.url}/retry`);
      assert.equal(retry.status, failure === "outage" ? 503 : 409, JSON.stringify(retry.body));
      assert.equal(calls, 1);
      const replay = await fixture.request("POST", target.admissionPath, { body: target.body });
      assert.equal(replay.status, failure === "outage" ? 503 : 409, JSON.stringify(replay.body));
      assert.ok(calls > 1, "accepted-request replay still performs admission");
      assert.deepEqual(await snapshot(), stored, "refused writes must not change saved work");
    }
  } finally {
    gateway.listSourceTypes = catalog;
    for (const method of providerCalls) {
      method.mock.restore();
    }
  }
}

export async function assertProvisioningSourceWithdrawal(
  fixture: Fixture,
  gateway: CredentialGatewayDriver,
  target: { workId: string; url: string },
) {
  const catalog = gateway.listSourceTypes;
  let calls = 0;
  gateway.listSourceTypes = async () => {
    calls++;
    return [];
  };
  try {
    // The worker must refuse the withdrawn type before creating an Agent or granting access.
    await fixture.startWorker();
    await waitFor("the worker to refuse the withdrawn source type", async () => {
      const stored = await fixture.state.read((state) =>
        state.provisioning.findWithWork(target.workId),
      );
      return stored?.record.status === "failed" ? stored : undefined;
    });
    await fixture.stopWorker();
    assert.ok(calls > 0);
    const stored = await fixture.state.read((state) =>
      state.provisioning.findWithWork(target.workId),
    );
    assert.equal(stored?.record.agentId, undefined);
    const observed = await fixture.request("GET", target.url);
    assert.equal(observed.status, 200, JSON.stringify(observed.body));
  } finally {
    gateway.listSourceTypes = catalog;
    await fixture.stopWorker();
  }
}
