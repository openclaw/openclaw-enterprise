import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";

import type { OpenShellSandboxProviderStatus } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { observeUntil, type deployFiniteAgent } from "./finite-git-agent.ts";
import type { createOpenShellGitInstallation } from "./openshell-git-installation.mjs";

// Read the supplier's real receipt without printing private provider material.
function generation(status: OpenShellSandboxProviderStatus) {
  const desired = status.receipt?.desired;
  const observed = status.observed;
  assert.ok(desired && observed);
  for (const key of [
    "attachmentEpoch",
    "providerEnvRevision",
    "configRevision",
    "policyHash",
  ] as const) {
    assert.ok(desired[key]);
    assert.equal(observed[key] === desired[key], true, "supplier generation mismatch");
  }
  assert.equal(observed.credentialsInstalled, true);
  assert.equal(observed.policyActive, true);
  assert.equal(observed.launchEnvironmentInstalled, true);
  assert.ok(observed.sessionId && observed.processInstanceId && status.networkInstanceId);
  assert.match(observed.sequence, /^[1-9][0-9]*$/);
  assert.ok(!status.reason || status.reason === "PROVIDER_READINESS_REASON_UNSPECIFIED");
  assert.ok(!observed.reason || observed.reason === "PROVIDER_READINESS_REASON_UNSPECIFIED");
  const evaluated = Date.parse(status.evaluatedTime ?? "");
  const at = Date.parse(status.observedTime ?? "");
  assert.ok(Number.isFinite(at) && at <= evaluated && Math.abs(Date.now() - evaluated) < 30_000);
  return {
    attachmentEpoch: desired.attachmentEpoch,
    providerEnvRevision: desired.providerEnvRevision,
    configRevision: desired.configRevision,
    policyHash: desired.policyHash,
    sessionId: observed.sessionId,
    processInstanceId: observed.processInstanceId,
    networkInstanceId: status.networkInstanceId,
  };
}

/** Observe Git-only subtraction without replacing the original finite execution. */
export async function createFiniteGitProviderObservation({
  fixture,
  agent: a,
  signal,
  remaining,
}: {
  fixture: Awaited<ReturnType<typeof createOpenShellGitInstallation>>;
  agent: Awaited<ReturnType<typeof deployFiniteAgent>>;
  signal: AbortSignal;
  remaining: () => number;
}) {
  const { gatewayClient, workspace } = fixture;
  const providers = a.original.sandbox.spec?.providers;
  assert.ok(Array.isArray(providers));
  const named = await Promise.all(
    providers.map(async (name: string) => {
      const provider = await gatewayClient.getProvider(workspace, name, signal);
      assert.ok(provider);
      const profile = await gatewayClient.getProviderProfile(
        provider.profileWorkspace || null,
        provider.type,
        signal,
      );
      assert.ok(profile?.definition);
      return { name, provider, model: profile.definition.inference_capable === true };
    }),
  );
  const model = named.find((entry) => entry.model);
  const gitProviders = named.filter(
    (entry) => !entry.model && entry.provider.type !== "oce-codex-runtime",
  );
  assert.ok(model);
  assert.equal(model.provider.labels["openclaw.dev/credential-source-id"], fixture.modelSource.id);
  assert.equal(gitProviders.length, 1);
  const gitProvider = gitProviders[0]!;
  const readStatus = async (name: string, state: string) => {
    let receipt: string | undefined;
    return observeUntil(
      "supplier provider receipt",
      signal,
      async () => {
        remaining();
        const status = await gatewayClient.getSandboxProviderStatus(
          workspace,
          a.original.sandbox.name,
          name,
          signal,
          receipt,
        );
        assert.ok(status.receipt?.receiptId);
        receipt ??= status.receipt.receiptId;
        assert.equal(status.receipt.receiptId, receipt);
        assert.equal(status.receipt.kind, "PROVIDER_MUTATION_KIND_OBSERVE");
        assert.equal(status.receipt.provider, name);
        assert.equal(status.receipt.workspace, workspace);
        assert.equal(status.receipt.desired?.sandboxId, a.target.sandboxId);
        assert.equal(status.receipt.desired?.sandbox, a.original.sandbox.name);
        if (
          ["PROVIDER_READINESS_STATE_PENDING", "PROVIDER_READINESS_STATE_PERSISTED"].includes(
            status.state,
          )
        ) {
          return undefined;
        }
        assert.equal(status.state, state);
        return status;
      },
      Math.min(30_000, remaining()),
    );
  };
  const originalStatus = await readStatus(gitProvider.name, "PROVIDER_READINESS_STATE_READY");
  const originalGeneration = generation(originalStatus);
  assert.equal(originalStatus.receipt?.desired?.providerId, gitProvider.provider.id);
  const reduced = async () => {
    remaining();
    assert.deepEqual((await a.readExecution()).identity, a.original.identity);
    const box = await gatewayClient.getSandbox(
      { workspace, name: a.original.sandbox.name },
      signal,
    );
    assert.ok(box);
    const attached = box.spec?.providers;
    assert.ok(Array.isArray(attached));
    assert.equal(
      isDeepStrictEqual(
        [...attached].sort(),
        providers.filter((name: string) => name !== gitProvider.name).sort(),
      ),
      true,
      "only the Git provider may detach",
    );
    const revoked = await readStatus(gitProvider.name, "PROVIDER_READINESS_STATE_REVOKED");
    const ready = await readStatus(model.name, "PROVIDER_READINESS_STATE_READY");
    assert.equal(revoked.receipt?.desired?.providerId, "");
    assert.equal(ready.receipt?.desired?.providerId, model.provider.id);
    const current = generation(revoked);
    assert.equal(
      isDeepStrictEqual(current, generation(ready)),
      true,
      "Git revocation and model readiness must share one generation",
    );
    assert.notEqual(current.attachmentEpoch, originalGeneration.attachmentEpoch);
    for (const key of ["sessionId", "processInstanceId", "networkInstanceId"] as const) {
      assert.equal(current[key] === originalGeneration[key], true, "supplier execution changed");
    }
    return current;
  };
  return {
    readReduced: reduced,
    async waitForRemoval() {
      await observeUntil(
        "Git provider detached",
        signal,
        async () => {
          remaining();
          assert.deepEqual((await a.readExecution()).identity, a.original.identity);
          const box = await gatewayClient.getSandbox(
            { workspace, name: a.original.sandbox.name },
            signal,
          );
          const attached = box?.spec?.providers;
          assert.ok(Array.isArray(attached));
          return !attached.includes(gitProvider.name) ? true : undefined;
        },
        Math.min(180_000, remaining()),
      );
      return reduced();
    },
  };
}
