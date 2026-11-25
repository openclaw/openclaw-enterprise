import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import type { SandboxHarnessContext } from "../../packages/contracts/src/index.ts";
import { TransientDependencyError } from "../../packages/occ/src/index.ts";
import { loadInstallationFile } from "../helpers/installation-file.ts";
import { labelSelectorLabels } from "../helpers/kubernetes-routed-scenarios.mjs";
import { loader } from "../helpers/openshell-grpc-sdk.ts";
import { verifySandboxDriverHarnessObservation } from "./sandbox-driver-harness-observation-cases.ts";
import { registerSandboxDriverNativePreparationCases } from "./sandbox-driver-native-preparation-cases.ts";
import { openShellDriver } from "./sandbox-driver-openshell-fixture.ts";
import { registerSandboxDriverOperatorKubernetesCases } from "./sandbox-driver-operator-kubernetes-cases.ts";
import { createOrphanedNativePreparation } from "./sandbox-driver-preparation-cases.ts";
import { registerSandboxDriverPreparerCleanupCases } from "./sandbox-driver-preparer-cleanup-cases.ts";
import { registerSandboxDriverPreparerQuotaCases } from "./sandbox-driver-preparer-quota-cases.ts";
import { completeWorkspaceRevision } from "./sandbox-driver-revision-fixture.ts";
import { buildSandboxInstallation as sandboxInstallation } from "./sandbox-driver-startup-installation-fixture.ts";
import {
  V1Deployment,
  ownedWorkspace,
  runtimeSandboxFixture,
} from "./sandbox-driver-startup-orchestration.ts";
import {
  verifyStockExtensionRoundTrips,
  verifyStockReadinessEvidence,
} from "./sandbox-driver-stock-readiness-cases.ts";
import { workspaceGatewayClient } from "./sandbox-workspace-gateway-fixture.ts";

export function registerSandboxDriverHookProbeCases(): void {
  test("OpenShell observes the Codex Harness through its exact bearer-passthrough service", async () => {
    await verifySandboxDriverHarnessObservation({
      openShellDriver,
      runtimeSandboxFixture,
      sandboxInstallation,
      TransientDependencyError,
    });
  });

  // These codecs test the stock/product boundary, not installed supervisor capabilities.
  test("stock OpenShell v0.1.5 cannot carry OCE readiness-extension evidence", async () => {
    const options = { keepCase: true, longs: String, enums: String, defaults: false };
    const stock = await loader.load(
      join(import.meta.dirname, "../fixtures/openshell-v0.1.5-wire.proto"),
      options,
    );
    const product = await loader.load(
      join(
        import.meta.dirname,
        "../../apps/controller/src/drivers/sandbox/proto/openshell-gateway.proto",
      ),
      options,
    );
    verifyStockReadinessEvidence(product, stock);
    verifyStockExtensionRoundTrips(product, stock);
  });

  test("installation refuses OpenShell repository credentials before reading session or provider inputs", async (t) => {
    const configuration = sandboxInstallation();
    const id = "repository-credentials";
    await assert.rejects(
      loadInstallationFile(t, {
        ...configuration,
        backend: [
          ...configuration.backend,
          {
            id: "github-primary",
            type: "github",
            configuration: { registryPath: "/absent/repositories.json" },
            drivers: { repo: id },
          },
        ],
        repository: {
          id,
          configuration: { sessionDurationSeconds: 600 },
          openShell: {},
        },
      }),
      /repository\.openShell is retired/,
    );
  });

  test("OpenShell refuses obsolete Repository enrollment before contacting the Gateway", async () => {
    const gateway = workspaceGatewayClient();
    const driver = openShellDriver(gateway);
    const refusal = { code: "SANDBOX_REPOSITORY_RECIPIENT_UNVERIFIED" };
    const malformedInputs: Array<(input: SandboxHarnessContext) => SandboxHarnessContext> = [
      (input) => ({
        ...input,
        revision: {
          ...input.revision,
          // @ts-expect-error Exercise malformed persisted repository credentials.
          repositoryCredentials: {},
        },
      }),
      (input) => ({
        ...input,
        requirements: {
          ...input.requirements,
          // Exercise the obsolete session field at the runtime boundary.
          repositorySession: {},
        },
      }),
      (input) => ({
        ...input,
        requirements: {
          ...input.requirements,
          environment: [
            ...input.requirements.environment,
            { name: "OPENCLAW_REPOSITORY_ENROLLMENT", value: "{}" },
          ],
        },
      }),
    ];
    for (const malformed of malformedInputs) {
      const { context, revision: fixtureRevision, requirements } = runtimeSandboxFixture(driver);
      const revision = completeWorkspaceRevision(fixtureRevision, requirements);
      const attempt = malformed({
        ...context,
        revision,
        requirements,
      });
      await assert.rejects(driver.provisionHarness(attempt), refusal);
      assert.deepEqual(gateway.calls, []);
    }
  });

  const orphanedNativePreparation = createOrphanedNativePreparation({
    V1Deployment,
    openShellDriver,
    runtimeSandboxFixture,
    ownedWorkspace,
  });

  registerSandboxDriverNativePreparationCases(orphanedNativePreparation);

  registerSandboxDriverPreparerCleanupCases({
    orphanedNativePreparation,
    labelSelectorLabels,
  });

  registerSandboxDriverPreparerQuotaCases(orphanedNativePreparation);

  registerSandboxDriverOperatorKubernetesCases();
}
