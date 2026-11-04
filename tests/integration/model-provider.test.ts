import assert from "node:assert/strict";
import test from "node:test";
import type { PlatformUnitOfWork } from "../../packages/occ/src/index.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";

// Real HTTP, IAM, OCC and Compute admission. The Console fixture simulates Namespace and
// runtime-credential provisioning; these cases make no cluster or model-execution claim.
for (const harness of ["codex", "openclaw"] as const) {
  for (const configured of [false, true]) {
    test(`${harness} deployment ${configured ? "binds the shared provider" : "retains native defaults"} and refuses destination changes on recovery`, async (t) => {
      const modelProvider = {
        protocol: "openai-responses" as const,
        baseUrl: "https://models.example.test/v1",
      };
      const f = await createConsoleAppFixture(t, { ...(configured ? { modelProvider } : {}) });
      await f.bootstrap();
      const namespace = await f.createNamespace("shared-provider", { ready: true });
      const computeDriver = f.controller.selectedDriver("compute");
      const authored = createHarnessConfiguration(harness, "gpt-5");
      // Retain the Gateway password reference needed for private workspace-node status.
      const configuration = {
        ...authored,
        gateway: {
          ...authored.gateway,
          auth: {
            ...authored.gateway.auth,
            mode: "trusted-proxy",
            trustedProxy: {
              userHeader: "x-occ-identity",
              allowUsers: ["occ-workspace-files"],
            },
          },
        },
      };
      // A configured Installation routes Embedded OpenClaw through its own endpoint, so the
      // Configuration names that endpoint rather than the native default.
      const sharedConfiguration =
        configured && harness === "openclaw"
          ? {
              ...configuration,
              models: {
                ...configuration.models,
                providers: {
                  ...configuration.models.providers,
                  openai: {
                    ...configuration.models.providers.openai,
                    baseUrl: modelProvider.baseUrl,
                  },
                },
              },
            }
          : configuration;
      const agent = await f.createAgent(
        namespace.id,
        "shared-provider-agent",
        sharedConfiguration,
        {
          executionMode: harness === "codex" ? "dedicated" : "embedded",
          // A custom Installation endpoint requires the model Secret to authorize that exact
          // destination, for Codex and Embedded OpenClaw alike.
          ...(configured
            ? {
                harnessAuth: {
                  method: "api_key" as const,
                  source: (
                    await f.createSecret(
                      namespace.id,
                      `shared-provider-${harness}`,
                      "test-api-key",
                      {
                        authorizedEndpoint: modelProvider.baseUrl,
                      },
                    )
                  ).ref,
                  // The binding carries the same authorization as the Secret it names.
                  authorizedEndpoint: modelProvider.baseUrl,
                },
              }
            : {}),
        },
      );
      const deployed = await f.deployAgent(namespace.id, agent.id);
      const revision = await f.controller.transact((unit: PlatformUnitOfWork) =>
        unit.revisions.findRevision(namespace.id, agent.id, deployed.id),
      );
      assert.ok(revision);
      if (configured) {
        assert.match(revision.compute.admission ?? "", /^model-provider:v1:[a-f0-9]{64}:/);
      } else {
        assert.equal(revision.compute.admission, undefined);
      }
      assert.equal(revision.harness.id, harness);
      // An operator change must fail before a replay can contact Kubernetes or deliver a key.
      for (const replacement of [
        ...(configured ? [undefined] : []),
        { ...modelProvider, baseUrl: "https://other.example.test/v1" },
      ]) {
        const changed = createTestKubernetesComputeDriver(computeDriver.id, {
          gatewayRuntime: true,
          ...(replacement === undefined ? {} : { modelProvider: replacement }),
        });
        await assert.rejects(
          changed.prepareRevision(revision),
          /model provider (?:changed|admission)/,
        );
      }
      assert.equal(revision.compute.admission, computeDriver.admitRevision?.(revision));
    });
  }
}
