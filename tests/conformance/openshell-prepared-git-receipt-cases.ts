import assert from "node:assert/strict";
import test from "node:test";
import { OpenShellPreparedGitProvider } from "../../apps/controller/src/drivers/egress-proxy/openshell-prepared-git-provider.ts";
import type {
  OpenShellProviderReadinessObservation,
  OpenShellSandboxProviderStatus,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { installedStatus, scope, signal, token, wire } from "./openshell-prepared-git-wire.ts";

export function registerPreparedGitReceiptCases(): void {
  test("completed Git receipt can observe a new aggregate environment without replaying its write", async (t) => {
    const { state, client } = await wire(t);
    const provider = new OpenShellPreparedGitProvider(client, {
      ...scope,
      observedHookPreview: true,
    });
    const bootstrap = await provider.bootstrap(signal());
    const update = client.updateProviderCredentialsConditionally.bind(client);
    client.updateProviderCredentialsConditionally = async (...args) => {
      const result = await update(...args);
      return {
        ...result,
        mutationId: "update-one",
        targetReceipts: [
          {
            receipt_id: "original",
            mutation_id: "update-one",
            kind: "PROVIDER_MUTATION_KIND_UPDATE",
            workspace: scope.workspace,
            provider: bootstrap.provider,
            desired: {
              sandbox: scope.sandbox,
              provider_id: result.id,
              provider_resource_version: result.resourceVersion,
            },
          },
        ],
      };
    };
    const active = await provider.rotate(bootstrap, async () => token(), signal());
    assert.ok(active);
    state.status = installedStatus(active);
    const initial = await client.getSandboxProviderStatus(
      scope.workspace,
      scope.sandbox,
      bootstrap.provider,
      signal(),
    );
    const { receipt, observed, completedOperationId, supersededObservationId } = initial;
    assert.equal(completedOperationId, undefined);
    assert.equal(supersededObservationId, undefined);
    assert.ok(receipt?.desired && observed && initial.observedTime);
    const { desired } = receipt;
    const initialObservedTime = initial.observedTime;
    let environment = "101";
    let completed = true;
    let drift: Partial<OpenShellProviderReadinessObservation> = {};
    const reads: (string | undefined)[] = [];
    const targets = new Map([["original", "101"]]);
    const applied = new Set(["original"]);
    const superseded = new Set<string>();
    let loseResponse = false;
    let terminalProof = true;
    let stale = false;
    client.getSandboxProviderStatus = async (
      _workspace,
      _sandbox,
      _provider,
      _signal,
      id,
    ): Promise<OpenShellSandboxProviderStatus> => {
      reads.push(id);
      const receiptId = id ?? (environment === "101" ? "original" : `refreshed-${environment}`);
      const target = targets.get(receiptId) ?? environment;
      targets.set(receiptId, target);
      if (target !== environment && !applied.has(receiptId)) {
        superseded.add(receiptId);
      }
      if (completed && target === environment && !superseded.has(receiptId)) {
        applied.add(receiptId);
      }
      if (!id && loseResponse) {
        throw new Error("lost OBSERVE response after acceptance");
      }
      const currentState = completed
        ? "PROVIDER_READINESS_STATE_READY"
        : "PROVIDER_READINESS_STATE_PENDING";
      return {
        ...initial,
        state: target === environment ? currentState : "PROVIDER_READINESS_STATE_SUPERSEDED",
        reason:
          target === environment
            ? "PROVIDER_READINESS_REASON_UNSPECIFIED"
            : "PROVIDER_READINESS_REASON_DESIRED_STATE_CHANGED",
        receipt: {
          ...receipt,
          receiptId,
          kind:
            receiptId === "original"
              ? "PROVIDER_MUTATION_KIND_UPDATE"
              : "PROVIDER_MUTATION_KIND_OBSERVE",
          desired: { ...desired, providerEnvRevision: target },
        },
        observed: { ...observed, providerEnvRevision: environment, ...drift },
        ...(applied.has(receiptId) && { completedOperationId: receiptId }),
        ...(terminalProof && superseded.has(receiptId) && { supersededObservationId: receiptId }),
        observedTime: stale ? new Date(Date.now() - 60_000).toISOString() : initialObservedTime,
      };
    };
    assert.equal(await provider.settlePreviewReceipt(active, signal()), true);
    const installed101 = await provider.observe(active, "sandbox-id", signal());
    assert.ok(installed101);
    assert.equal(installed101.providerEnvRevision, "101");
    const writes = state.requests.filter(
      ({ method }) => method === "CreateProvider" || method === "UpdateProvider",
    ).length;
    environment = "102";
    assert.equal(await provider.observe(active, "sandbox-id", signal()), undefined);
    assert.equal(reads.at(-1), "original", "request lookup cannot create an observation");
    completed = false;
    assert.equal(await provider.settlePreviewReceipt(active, signal()), false);
    assert.equal(
      await provider.observe(active, "sandbox-id", signal()),
      undefined,
      "incomplete receipt remains denied",
    );
    completed = true;
    assert.equal(await provider.settlePreviewReceipt(active, signal()), true);
    const installed102 = await provider.observe(active, "sandbox-id", signal());
    assert.ok(installed102);
    assert.equal(installed102.providerEnvRevision, "102");
    assert.equal(reads.at(-1), "refreshed-102");
    environment = "103";
    for (const mismatch of [
      { attachmentEpoch: "other" },
      { configRevision: "999" },
      { policyHash: "other" },
    ]) {
      drift = mismatch;
      assert.equal(await provider.settlePreviewReceipt(active, signal()), false);
      assert.equal(await provider.observe(active, "sandbox-id", signal()), undefined);
      assert.equal(
        reads.at(-1),
        "refreshed-102",
        "identity drift does not create a new observation",
      );
    }
    drift = {};
    completed = false;
    loseResponse = true;
    const acceptedBefore = targets.size;
    for (let attempt = 0; attempt < 3; attempt++) {
      await assert.rejects(
        provider.settlePreviewReceipt(active, signal()),
        /lost OBSERVE response/,
      );
      assert.equal(await provider.observe(active, "sandbox-id", signal()), undefined);
    }
    assert.equal(targets.size, acceptedBefore + 1, "same target reuses one accepted OBSERVE");
    loseResponse = false;
    assert.equal(await provider.settlePreviewReceipt(active, signal()), false);
    assert.equal(await provider.settlePreviewReceipt(active, signal()), false);
    assert.equal(reads.at(-1), "refreshed-103");
    environment = "104";
    assert.equal(await provider.settlePreviewReceipt(active, signal()), false);
    assert.equal(
      targets.size,
      acceptedBefore + 2,
      "known superseded pending OBSERVE advances to a new target",
    );
    assert.equal(await provider.observe(active, "sandbox-id", signal()), undefined);
    completed = true;
    assert.equal(await provider.settlePreviewReceipt(active, signal()), true);
    const installed104 = await provider.observe(active, "sandbox-id", signal());
    assert.ok(installed104);
    assert.equal(installed104.providerEnvRevision, "104");
    assert.equal(reads.at(-1), "refreshed-104");
    const countBeforeReturn = targets.size;
    environment = "103";
    assert.equal(await provider.observe(active, "sandbox-id", signal()), undefined);
    assert.equal(await provider.settlePreviewReceipt(active, signal()), true);
    const installed103 = await provider.observe(active, "sandbox-id", signal());
    assert.ok(installed103);
    assert.equal(installed103.providerEnvRevision, "103");
    assert.equal(
      applied.has("refreshed-103"),
      false,
      "ignored-stale history never becomes APPLIED",
    );
    assert.equal(superseded.has("refreshed-103"), true);
    assert.equal(targets.size, countBeforeReturn, "recurrence creates no additional operation");
    terminalProof = false;
    assert.equal(
      await provider.observe(active, "sandbox-id", signal()),
      undefined,
      "READY alone cannot settle an auxiliary receipt",
    );
    terminalProof = true;
    stale = true;
    assert.equal(
      await provider.observe(active, "sandbox-id", signal()),
      undefined,
      "terminal history cannot revive stale evidence",
    );
    stale = false;
    drift = { credentialsInstalled: false };
    assert.equal(
      await provider.observe(active, "sandbox-id", signal()),
      undefined,
      "terminal history is not live proof",
    );
    drift = {};
    // Withdraw original UPDATE completion while retaining the exact refreshed OBSERVE.
    // The public API cannot create that combination of receipt states.
    const custody: object = provider;
    assert.ok("receipt" in custody);
    const originalReceipt = custody.receipt;
    assert.ok(originalReceipt && typeof originalReceipt === "object");
    assert.ok("complete" in originalReceipt && originalReceipt.complete === true);
    assert.equal(Reflect.deleteProperty(originalReceipt, "complete"), true);
    assert.equal(
      await provider.observe(active, "sandbox-id", signal()),
      undefined,
      "original completed UPDATE remains required",
    );
    assert.equal(Reflect.set(originalReceipt, "complete", true), true);
    assert.equal(targets.get("original"), "101", "original UPDATE target remains immutable");
    assert.equal(
      state.requests.filter(
        ({ method }) => method === "CreateProvider" || method === "UpdateProvider",
      ).length,
      writes,
      "no provider write replayed",
    );
  });

  test("stock terminal OBSERVE projection is distinct from APPLIED and bound to receipt kind and ID", async (t) => {
    const { state, binding, client } = await wire(t);
    const bootstrap = await binding.bootstrap(signal());
    const status = installedStatus(bootstrap);
    state.status = status;
    status.receipt.receipt_id = "observation";
    status.receipt.kind = "PROVIDER_MUTATION_KIND_OBSERVE";
    const operation = {
      operation_id: "observation",
      state: 5,
      outcome: 3,
      completed_time: { seconds: "1" },
    };
    status.operation = operation;
    const read = () =>
      client.getSandboxProviderStatus(scope.workspace, scope.sandbox, bootstrap.provider, signal());
    const projected = await read();
    assert.equal(projected.state, "PROVIDER_READINESS_STATE_READY");
    assert.equal(projected.supersededObservationId, "observation");
    assert.equal(projected.completedOperationId, undefined);
    for (const invalid of [
      { operation_id: "other" },
      { state: 1 },
      { outcome: 7 },
      { completed_time: undefined },
      { completed_time: { seconds: "1", nanos: -1 } },
    ]) {
      status.operation = { ...operation, ...invalid };
      assert.equal((await read()).supersededObservationId, undefined);
    }
    status.operation = operation;
    status.receipt.kind = "PROVIDER_MUTATION_KIND_UPDATE";
    assert.equal((await read()).supersededObservationId, undefined);
  });

  test("bootstrap-only OBSERVE cannot complete an ignored historical refresh", async (t) => {
    const { state, client } = await wire(t);
    const provider = new OpenShellPreparedGitProvider(client, {
      ...scope,
      observedHookPreview: true,
    });
    const bootstrap = await provider.bootstrap(signal());
    state.status = installedStatus(bootstrap);
    const initial = await client.getSandboxProviderStatus(
      scope.workspace,
      scope.sandbox,
      bootstrap.provider,
      signal(),
    );
    const { receipt, observed, completedOperationId, supersededObservationId } = initial;
    assert.equal(completedOperationId, undefined);
    assert.equal(supersededObservationId, undefined);
    assert.ok(receipt?.desired && observed);
    const { desired } = receipt;
    let environment = "101";
    client.getSandboxProviderStatus = async (
      _workspace,
      _sandbox,
      _provider,
      _signal,
      id,
    ): Promise<OpenShellSandboxProviderStatus> => {
      const receiptId = id ?? `bootstrap-${environment}`;
      const target = receiptId === "bootstrap-101" ? "101" : "102";
      return {
        ...initial,
        state:
          target === environment
            ? "PROVIDER_READINESS_STATE_READY"
            : "PROVIDER_READINESS_STATE_SUPERSEDED",
        reason:
          target === environment
            ? "PROVIDER_READINESS_REASON_UNSPECIFIED"
            : "PROVIDER_READINESS_REASON_DESIRED_STATE_CHANGED",
        receipt: {
          ...receipt,
          receiptId,
          kind: "PROVIDER_MUTATION_KIND_OBSERVE",
          desired: { ...desired, providerEnvRevision: target },
        },
        observed: { ...observed, providerEnvRevision: environment },
        ...(target === "101" && { completedOperationId: receiptId }),
        ...(target === "102" && { supersededObservationId: receiptId }),
      };
    };
    assert.equal(await provider.settlePreviewReceipt(bootstrap, signal()), true);
    const installed = await provider.observe(bootstrap, "sandbox-id", signal());
    assert.ok(installed);
    assert.equal(installed.credentialState, "bootstrap");
    const writes = state.requests.filter(
      ({ method }) => method === "CreateProvider" || method === "UpdateProvider",
    ).length;
    environment = "102";
    assert.equal(await provider.settlePreviewReceipt(bootstrap, signal()), false);
    assert.equal(await provider.observe(bootstrap, "sandbox-id", signal()), undefined);
    assert.equal(
      state.requests.filter(
        ({ method }) => method === "CreateProvider" || method === "UpdateProvider",
      ).length,
      writes,
    );
  });
}
