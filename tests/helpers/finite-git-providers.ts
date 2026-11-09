import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";

import type { OpenShellSandboxProviderStatus } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { observeUntil, type deployFiniteAgent } from "./finite-git-agent.ts";
import type { createOpenShellGitInstallation } from "./openshell-git-installation.mjs";

type StatusCheck = "budget" | "status request" | "receipt identity" | "readiness state";
type GenerationCheck =
  | "generation presence"
  | "attachmentEpoch"
  | "providerEnvRevision"
  | "configRevision"
  | "policyHash"
  | "installation flags"
  | "execution fields"
  | "readiness reasons"
  | "observation time";
type ReducedCheck =
  | "budget"
  | "execution identity"
  | "sandbox read"
  | "provider attachment set"
  | `${"Git" | "model"} ${StatusCheck | GenerationCheck | "provider identity"}`
  | "shared generation"
  | "detached epoch"
  | `original ${"sessionId" | "processInstanceId" | "networkInstanceId"}`;

// Read the supplier's real receipt without printing private provider material.
function generation(
  status: OpenShellSandboxProviderStatus,
  check?: (stage: GenerationCheck) => void,
) {
  const desired = status.receipt?.desired;
  const observed = status.observed;
  check?.("generation presence");
  assert.ok(desired && observed);
  for (const key of [
    "attachmentEpoch",
    "providerEnvRevision",
    "configRevision",
    "policyHash",
  ] as const) {
    check?.(key);
    assert.ok(desired[key]);
    assert.equal(observed[key] === desired[key], true, "supplier generation mismatch");
  }
  check?.("installation flags");
  assert.equal(observed.credentialsInstalled, true);
  assert.equal(observed.policyActive, true);
  assert.equal(observed.launchEnvironmentInstalled, true);
  check?.("execution fields");
  assert.ok(observed.sessionId && observed.processInstanceId && status.networkInstanceId);
  assert.match(observed.sequence, /^[1-9][0-9]*$/);
  check?.("readiness reasons");
  assert.ok(!status.reason || status.reason === "PROVIDER_READINESS_REASON_UNSPECIFIED");
  assert.ok(!observed.reason || observed.reason === "PROVIDER_READINESS_REASON_UNSPECIFIED");
  check?.("observation time");
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
  const readStatus = async (name: string, state: string, check?: (stage: StatusCheck) => void) => {
    let receipt: string | undefined;
    check?.("budget");
    return observeUntil(
      "supplier provider receipt",
      signal,
      async () => {
        check?.("budget");
        remaining();
        check?.("status request");
        const status = await gatewayClient.getSandboxProviderStatus(
          workspace,
          a.original.sandbox.name,
          name,
          signal,
          receipt,
        );
        check?.("receipt identity");
        assert.ok(status.receipt?.receiptId);
        receipt ??= status.receipt.receiptId;
        assert.equal(status.receipt.receiptId, receipt);
        assert.equal(status.receipt.kind, "PROVIDER_MUTATION_KIND_OBSERVE");
        assert.equal(status.receipt.provider, name);
        assert.equal(status.receipt.workspace, workspace);
        assert.equal(status.receipt.desired?.sandboxId, a.target.sandboxId);
        assert.equal(status.receipt.desired?.sandbox, a.original.sandbox.name);
        check?.("readiness state");
        if (
          ["PROVIDER_READINESS_STATE_PENDING", "PROVIDER_READINESS_STATE_PERSISTED"].includes(
            status.state,
          )
        ) {
          check?.("budget");
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
  // Only fixed check names leave this helper; supplier values and assertion errors stay private.
  const reduced = async (onCheck?: (stage: ReducedCheck) => void) => {
    const check = (stage: ReducedCheck) => {
      try {
        onCheck?.(stage);
      } catch {
        // Diagnostic reporting must not replace the supplier's verification outcome.
      }
    };
    check("budget");
    remaining();
    check("execution identity");
    assert.deepEqual((await a.readExecution()).identity, a.original.identity);
    check("sandbox read");
    const box = await gatewayClient.getSandbox(
      { workspace, name: a.original.sandbox.name },
      signal,
    );
    assert.ok(box);
    check("provider attachment set");
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
    const revoked = await readStatus(
      gitProvider.name,
      "PROVIDER_READINESS_STATE_REVOKED",
      (stage) => check(`Git ${stage}`),
    );
    const ready = await readStatus(model.name, "PROVIDER_READINESS_STATE_READY", (stage) =>
      check(`model ${stage}`),
    );
    check("Git provider identity");
    assert.equal(revoked.receipt?.desired?.providerId, "");
    check("model provider identity");
    assert.equal(ready.receipt?.desired?.providerId, model.provider.id);
    const current = generation(revoked, (stage) => check(`Git ${stage}`));
    const readyGeneration = generation(ready, (stage) => check(`model ${stage}`));
    check("shared generation");
    assert.equal(
      isDeepStrictEqual(current, readyGeneration),
      true,
      "Git revocation and model readiness must share one generation",
    );
    check("detached epoch");
    assert.notEqual(current.attachmentEpoch, originalGeneration.attachmentEpoch);
    for (const key of ["sessionId", "processInstanceId", "networkInstanceId"] as const) {
      check(`original ${key}`);
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
