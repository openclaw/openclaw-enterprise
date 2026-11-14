import assert from "node:assert/strict";
import test from "node:test";
import { dedicatedSandboxRefusal } from "./configuration-occ-sandbox-cases.ts";
import { administrator, fixture } from "./configuration-occ-fixture.ts";
import type {
  HarnessExecutionMode,
  OpenClawConfigurationDocument,
} from "@openclaw-enterprise/contracts";
import {
  resolveApprovedHarness as resolveApprovedDevelopmentHarness,
  resolveApprovedProductionHarness,
  DEVELOPMENT_HARNESS_DESCRIPTOR,
} from "../../apps/controller/src/composition/production-harness.ts";
import {
  ConfigurationHarnessError,
  ScopeViolationError,
  resolveConfiguredHarnessId,
} from "../../packages/occ/src/index.ts";
import { admittedConfiguration } from "../helpers/admitted-configuration.mjs";

import {
  catalogRowUnselected,
  codexRuntimeOffProvider,
  CODEX_NEEDS_DEDICATED,
  keepRuntime,
  runtimePoliciesConflict,
  selectableModelOffProvider,
  selectableModelRuntimeMismatch,
} from "../helpers/refusal-text.mjs";

export function registerRuntimeAdmissionCases(): void {
  test("deployment names a non-object agents setting before model policy", async () => {
    const { agent, configuration, replaceStoredValues, saveConfiguration, controller, namespace } =
      await fixture();
    const values = {
      agents: "x",
      models: { providers: { openai: { models: [{ id: "gpt-4.1" }] } } },
    };
    const refusal = (error: unknown) =>
      error instanceof ConfigurationHarnessError &&
      error.message === "Configuration setting agents must be an object.";
    // Save refuses it with the same text (finding 874), so store it as an older release would have.
    await assert.rejects(saveConfiguration(values), refusal);
    await replaceStoredValues(configuration, values);
    await assert.rejects(
      controller.deployAgent(
        administrator,
        { namespaceId: namespace.id, agentId: agent.id },
        resolveApprovedDevelopmentHarness,
      ),
      refusal,
    );
    assert.deepEqual(
      (await controller.listRevisions(administrator, namespace.id, agent.id)).revisions,
      [],
    );
  });

  test("one installation admits embedded and dedicated revisions without rewriting historical placement", async () => {
    const { agent, bindHarnessAuth, configuration, controller, namespace } = await fixture();
    const embedded = await controller.deployAgent(
      administrator,
      { namespaceId: namespace.id, agentId: agent.id },
      resolveApprovedDevelopmentHarness,
    );
    const codexConfiguration = await controller.createConfiguration(administrator, {
      namespaceId: namespace.id,
      kind: "agent",
      values: {
        agents: {
          defaults: {
            model: { primary: "codex/gpt-4.1" },
            models: { "codex/gpt-4.1": { agentRuntime: { id: "codex" } } },
          },
        },
      },
    });
    const dedicatedAgent = await controller.createAgent(administrator, {
      namespaceId: namespace.id,
      name: "Dedicated configuration conformance agent",
      configurationId: codexConfiguration.id,
      executionMode: "dedicated",
    });
    await bindHarnessAuth(dedicatedAgent);
    const dedicatedNeighbor = await controller.deployAgent(
      administrator,
      { namespaceId: namespace.id, agentId: dedicatedAgent.id },
      resolveApprovedDevelopmentHarness,
    );
    assert.deepEqual(dedicatedNeighbor.harness, {
      id: "codex",
      version: "1.0.0",
      mode: "dedicated",
      overrides: {},
      configuration: {},
    });
    const updated = await controller.updateAgent(administrator, {
      namespaceId: namespace.id,
      agentId: agent.id,
      configurationId: codexConfiguration.id,
      executionMode: "dedicated",
    });
    assert.equal(updated.executionMode, "dedicated");

    const dedicated = await controller.deployAgent(
      administrator,
      { namespaceId: namespace.id, agentId: agent.id },
      resolveApprovedDevelopmentHarness,
    );
    assert.deepEqual(embedded.harness, {
      id: "openclaw",
      version: "1.0.0",
      mode: "embedded",
      overrides: {},
      configuration: {},
    });
    assert.deepEqual(dedicated.harness, {
      id: "codex",
      version: "1.0.0",
      mode: "dedicated",
      overrides: {},
      configuration: {},
    });
    assert.equal(embedded.configurationId, configuration.id);
    assert.equal(dedicated.configurationId, codexConfiguration.id);

    // Omitting placement during a later edit cannot silently reset the explicit dedicated choice.
    const preserved = await controller.updateAgent(administrator, {
      namespaceId: namespace.id,
      agentId: agent.id,
      configurationId: codexConfiguration.id,
    });
    assert.equal(preserved.executionMode, "dedicated");
    assert.equal(embedded.harness.mode, "embedded");
  });

  for (const scope of [
    "primary",
    "default-fallback",
    "entry-fallback",
    "provider-policy-fallback",
  ]) {
    test(`actual OCC admission accepts a same-Harness OpenAI Codex ${scope} selection`, async () => {
      const { bindHarnessAuth, controller, namespace, saveConfiguration } = await fixture();
      const selection = {
        primary: "openai/gpt-4.1",
        fallbacks: ["openai/gpt-4.1-mini", "openai/gpt-4.1-nano"],
      };
      const values = {
        agents: {
          defaults: {
            model:
              scope === "default-fallback" || scope === "provider-policy-fallback"
                ? selection
                : selection.primary,
            ...(scope === "provider-policy-fallback"
              ? {}
              : {
                  models: {
                    "openai/gpt-4.1": { agentRuntime: { id: "codex" } },
                    "openai/gpt-4.1-mini": { agentRuntime: { id: "codex" } },
                    "openai/gpt-4.1-nano": { agentRuntime: { id: "codex" } },
                  },
                }),
          },
          entries: {
            main: scope === "entry-fallback" ? { model: selection } : {},
          },
        },
        channels: { slack: { enabled: true, allowBots: false } },
        plugins: {
          entries: {
            codex: {
              enabled: true,
              config: { appServer: { transport: "websocket" } },
            },
          },
        },
        // Resolve provider-catalog policies without duplicate Agent-default policies.
        ...(scope === "provider-policy-fallback"
          ? {
              models: {
                providers: {
                  openai: {
                    models: [selection.primary, ...selection.fallbacks].map((model) => ({
                      id: model.slice("openai/".length),
                      agentRuntime: { id: "codex" },
                    })),
                  },
                },
              },
            }
          : {}),
      };
      const configuration = await saveConfiguration(values);
      const dedicated = await controller.createAgent(administrator, {
        namespaceId: namespace.id,
        name: "OpenAI Codex Runtime",
        configurationId: configuration.id,
        executionMode: "dedicated",
      });

      await bindHarnessAuth(dedicated);
      const admitted = await controller.deployAgent(
        administrator,
        { namespaceId: namespace.id, agentId: dedicated.id },
        resolveApprovedProductionHarness,
      );

      assert.deepEqual(configuration.values, values);
      // Admission freezes the original fallback order for the runtime to execute, and names the
      // sole roster entry after the OCC Agent.
      assert.deepEqual(
        admitted.configuration,
        admittedConfiguration(
          {
            ...values,
            agents: {
              ...values.agents,
              entries: {
                main: { ...values.agents.entries.main, identity: { name: dedicated.name } },
              },
            },
          },
          "info",
        ),
      );
      assert.deepEqual(admitted.harness, {
        id: "codex",
        version: "1.0.0",
        mode: "dedicated",
        overrides: {},
        configuration: {},
      });
      assert.equal(admitted.compute.id, "configuration-occ-compute");
    });
  }

  test("OCC rejects alternate selectable runtimes and unsupported Codex providers before admitting work", async () => {
    const defaultFallbackRefusal =
      "Configuration setting agents.defaults.model.fallbacks must use the primary model's provider.";
    const selectedModelDefaults = (model: string, runtimeId: "openclaw" | "codex") => ({
      model,
      models: { [model]: { agentRuntime: { id: runtimeId } } },
    });
    const defaultPolicy = 'agents.defaults.models["openai/gpt-4.1"]';
    const scenarios: {
      name: string;
      executionMode: HarnessExecutionMode;
      saveRefusal?: string | undefined;
      values: OpenClawConfigurationDocument;
    }[] = [
      // Every deployment refuses these too, so save refuses them first with its text (finding 1828).
      ...[null, "openai/gpt-4.1-mini", [42], ["/missing-provider"]].map((fallbacks) => ({
        name: `malformed fallback selection ${JSON.stringify(fallbacks)} cannot be admitted`,
        executionMode: "embedded" as const,
        saveRefusal: Array.isArray(fallbacks)
          ? "Configuration setting agents.defaults.model must name each model as <provider>/<model>, such as openai/gpt-5.1 or codex/gpt-5.1."
          : "Configuration setting agents.defaults.model.fallbacks must be an array.",
        values: {
          agents: {
            defaults: {
              model: { primary: "openai/gpt-4.1", fallbacks },
              models: { "openai/gpt-4.1": { agentRuntime: { id: "openclaw" } } },
            },
          },
        },
      })),
      {
        name: "fallback cannot change provider even when both models select the same Harness",
        executionMode: "dedicated",
        saveRefusal: defaultFallbackRefusal,
        values: {
          agents: {
            defaults: {
              model: { primary: "openai/gpt-4.1", fallbacks: ["codex/gpt-4.1"] },
              models: { "openai/gpt-4.1": { agentRuntime: { id: "codex" } } },
            },
          },
          models: { providers: { codex: { agentRuntime: { id: "codex" } } } },
          plugins: {
            entries: {
              codex: { enabled: true, config: { appServer: { transport: "websocket" } } },
            },
          },
        },
      },
      ...(
        [
          [
            "same-provider fallback cannot select a different Harness",
            { id: "openclaw" },
            selectableModelRuntimeMismatch(
              'agents.defaults.models["openai/gpt-4.1-mini"]',
              "codex",
            ),
          ],
          // A draft without a required runtime policy saves; deployment refuses it.
          ["same-provider fallback cannot omit its required runtime policy", undefined, undefined],
        ] as const
      ).map(([name, fallbackRuntime, saveRefusal]) => ({
        name,
        executionMode: "dedicated" as const,
        saveRefusal,
        values: {
          agents: {
            defaults: {
              model: { primary: "openai/gpt-4.1", fallbacks: ["openai/gpt-4.1-mini"] },
              models: {
                "openai/gpt-4.1": { agentRuntime: { id: "codex" } },
                ...(fallbackRuntime === undefined
                  ? {}
                  : {
                      "openai/gpt-4.1-mini": { agentRuntime: fallbackRuntime },
                    }),
              },
            },
          },
          plugins: {
            entries: {
              codex: { enabled: true, config: { appServer: { transport: "websocket" } } },
            },
          },
        },
      })),
      {
        name: "embedded OpenClaw cannot fall back to dedicated Codex",
        executionMode: "embedded",
        saveRefusal: defaultFallbackRefusal,
        values: {
          agents: {
            defaults: {
              model: { primary: "openai/gpt-4.1", fallbacks: ["codex/gpt-4.1"] },
              models: { "openai/gpt-4.1": { agentRuntime: { id: "openclaw" } } },
            },
          },
        },
      },
      {
        name: "dedicated Codex cannot fall back to embedded OpenClaw",
        executionMode: "dedicated",
        saveRefusal: defaultFallbackRefusal,
        values: {
          agents: {
            defaults: {
              model: { primary: "codex/gpt-4.1", fallbacks: ["openai/gpt-4.1"] },
              models: { "codex/gpt-4.1": { agentRuntime: { id: "codex" } } },
            },
          },
        },
      },
      {
        name: "the selectable model catalog cannot offer a conflicting runtime",
        executionMode: "embedded",
        saveRefusal: selectableModelOffProvider(
          'agents.defaults.models["codex/gpt-4.1"]',
          "openai",
        ),
        values: {
          agents: {
            defaults: {
              model: "openai/gpt-4.1",
              models: {
                "openai/gpt-4.1": { agentRuntime: { id: "openclaw" } },
                "codex/gpt-4.1": { agentRuntime: { id: "codex" } },
              },
            },
          },
        },
      },
      {
        name: "per-agent primary model fallbacks cannot select dedicated Codex",
        executionMode: "embedded",
        saveRefusal:
          "Configuration setting agents.entries.primary.model.fallbacks must use the primary model's provider.",
        values: {
          agents: {
            defaults: selectedModelDefaults("openai/gpt-4.1", "openclaw"),
            entries: {
              primary: {
                model: { primary: "openai/gpt-4.1", fallbacks: ["codex/gpt-4.1"] },
              },
            },
          },
        },
      },
      {
        name: "per-agent selectable models cannot offer a conflicting runtime",
        executionMode: "embedded",
        saveRefusal: selectableModelOffProvider(
          'agents.entries.primary.models["codex/gpt-4.1"]',
          "openai",
        ),
        values: {
          agents: {
            defaults: selectedModelDefaults("openai/gpt-4.1", "openclaw"),
            entries: {
              primary: {
                models: {
                  "openai/gpt-4.1": { agentRuntime: { id: "openclaw" } },
                  "codex/gpt-4.1": { agentRuntime: { id: "codex" } },
                },
              },
            },
          },
        },
      },
      {
        name: "provider model catalogs cannot expose alternate runtime overrides",
        executionMode: "embedded",
        saveRefusal: catalogRowUnselected("models.providers.openai"),
        values: {
          agents: {
            defaults: selectedModelDefaults("openai/gpt-4.1", "openclaw"),
          },
          models: {
            providers: {
              openai: {
                models: [
                  { id: "gpt-4.1", agentRuntime: { id: "openclaw" } },
                  { id: "gpt-5.6-luna", agentRuntime: { id: "codex" } },
                ],
              },
            },
          },
        },
      },
      {
        name: "selected model policy cannot mask a conflicting provider runtime",
        executionMode: "embedded",
        saveRefusal: runtimePoliciesConflict(
          defaultPolicy,
          "openclaw",
          "models.providers.openai",
          "codex",
          keepRuntime("openclaw", "codex"),
        ),
        values: {
          agents: {
            defaults: selectedModelDefaults("openai/gpt-4.1", "openclaw"),
          },
          models: { providers: { openai: { agentRuntime: { id: "codex" } } } },
        },
      },
      {
        name: "selected model policy cannot mask a conflicting provider-model runtime",
        executionMode: "embedded",
        saveRefusal: runtimePoliciesConflict(
          defaultPolicy,
          "openclaw",
          "models.providers.openai.models[0]",
          "codex",
          keepRuntime("openclaw", "codex"),
        ),
        values: {
          agents: {
            defaults: selectedModelDefaults("openai/gpt-4.1", "openclaw"),
          },
          models: {
            providers: {
              openai: { models: [{ id: "gpt-4.1", agentRuntime: { id: "codex" } }] },
            },
          },
        },
      },
      {
        // The nested catalog entry must still be found, or its conflicting runtime would go unseen.
        name: "selected model policy cannot mask a conflicting nested-slash provider-model runtime",
        executionMode: "embedded",
        saveRefusal: runtimePoliciesConflict(
          'agents.defaults.models["openai/vendor/model"]',
          "openclaw",
          "models.providers.openai.models[0]",
          "codex",
          keepRuntime("openclaw", "codex"),
        ),
        values: {
          agents: {
            defaults: selectedModelDefaults("openai/vendor/model", "openclaw"),
          },
          models: {
            providers: {
              openai: { models: [{ id: "vendor/model", agentRuntime: { id: "codex" } }] },
            },
          },
        },
      },
      {
        name: "per-agent model policy cannot mask a conflicting default runtime",
        executionMode: "embedded",
        saveRefusal: runtimePoliciesConflict(
          'agents.entries.primary.models["openai/gpt-4.1"]',
          "codex",
          defaultPolicy,
          "openclaw",
          keepRuntime("openclaw", "codex"),
        ),
        values: {
          agents: {
            defaults: selectedModelDefaults("openai/gpt-4.1", "openclaw"),
            entries: {
              primary: {
                models: { "openai/gpt-4.1": { agentRuntime: { id: "codex" } } },
              },
            },
          },
        },
      },
      {
        name: "dedicated Codex cannot use the OpenAI gateway provider",
        executionMode: "dedicated",
        saveRefusal: codexRuntimeOffProvider(defaultPolicy),
        values: {
          agents: {
            defaults: selectedModelDefaults("openai/gpt-4.1", "codex"),
          },
        },
      },
    ];

    for (const { name, executionMode, values, saveRefusal } of scenarios) {
      const { agent, controller, namespace, saveConfiguration } = await fixture();
      if (saveRefusal !== undefined) {
        // Every deployment refuses a fallback on another provider, a malformed selection, a
        // provider catalog row no selection names or settings that conflict, so Configuration save
        // refuses it first, with deployment's text (findings 1298, 1828, 3019 and 3020).
        await assert.rejects(
          saveConfiguration(values),
          { name: "ConfigurationHarnessError", message: saveRefusal },
          name,
        );
        continue;
      }
      const configuration = await saveConfiguration(values);
      await controller.updateAgent(administrator, {
        namespaceId: namespace.id,
        agentId: agent.id,
        configurationId: configuration.id,
        executionMode,
      });
      const operations = controller.pendingOperations();

      // Admission must fail before creating an immutable revision or enqueuing runtime work.
      await assert.rejects(
        controller.deployAgent(
          administrator,
          { namespaceId: namespace.id, agentId: agent.id },
          resolveApprovedDevelopmentHarness,
        ),
        ScopeViolationError,
        name,
      );
      assert.deepEqual(
        (await controller.listRevisions(administrator, namespace.id, agent.id)).revisions,
        [],
        name,
      );
      assert.deepEqual(controller.pendingOperations(), operations, name);
    }
  });

  test("Harness admission rejects conflicting selections, mode mismatches, and unapproved routes", async () => {
    const { agent, controller, namespace } = await fixture();
    const codexConfiguration = await controller.createConfiguration(administrator, {
      namespaceId: namespace.id,
      kind: "agent",
      values: {
        agents: {
          defaults: {
            model: "codex/gpt-4.1",
            models: { "codex/gpt-4.1": { agentRuntime: { id: "codex" } } },
          },
        },
      },
    });
    await controller.updateAgent(administrator, {
      namespaceId: namespace.id,
      agentId: agent.id,
      configurationId: codexConfiguration.id,
    });
    const mismatch = (error: unknown) =>
      error instanceof ConfigurationHarnessError && error.message === CODEX_NEEDS_DEDICATED;
    // Agent save given the deploy route's Harness resolver refuses the same pair with the same
    // message (finding 1117). The update above, without it, stands in for an Agent stored earlier.
    await assert.rejects(
      controller.updateAgent(
        administrator,
        { namespaceId: namespace.id, agentId: agent.id, configurationId: codexConfiguration.id },
        resolveApprovedDevelopmentHarness,
      ),
      mismatch,
    );
    await assert.rejects(
      controller.createAgent(
        administrator,
        { namespaceId: namespace.id, name: "Mismatched", configurationId: codexConfiguration.id },
        resolveApprovedDevelopmentHarness,
      ),
      mismatch,
    );

    // An explicit Codex selection cannot run in an embedded Agent or use OpenClaw's approval.
    // The mismatch is the caller's to fix, so it is named rather than reported as a missing dependency.
    await assert.rejects(
      controller.deployAgent(
        administrator,
        { namespaceId: namespace.id, agentId: agent.id },
        resolveApprovedDevelopmentHarness,
      ),
      mismatch,
    );
    await assert.rejects(
      controller.deployAgent(
        administrator,
        { namespaceId: namespace.id, agentId: agent.id },
        () => DEVELOPMENT_HARNESS_DESCRIPTOR,
      ),
      ScopeViolationError,
    );

    // Production accepts the same explicitly approved embedded OpenClaw placement as development.
    const openclawConfiguration = await controller.createConfiguration(administrator, {
      namespaceId: namespace.id,
      kind: "agent",
      values: {},
    });
    await controller.updateAgent(administrator, {
      namespaceId: namespace.id,
      agentId: agent.id,
      configurationId: openclawConfiguration.id,
    });
    assert.deepEqual(
      (await controller.listRevisions(administrator, namespace.id, agent.id)).revisions,
      [],
    );
    const embedded = await controller.deployAgent(
      administrator,
      { namespaceId: namespace.id, agentId: agent.id },
      resolveApprovedProductionHarness,
    );
    assert.deepEqual(embedded.harness, {
      ...DEVELOPMENT_HARNESS_DESCRIPTOR,
      mode: "embedded",
      overrides: {},
      configuration: {},
    });
    await controller.updateAgent(administrator, {
      namespaceId: namespace.id,
      agentId: agent.id,
      configurationId: openclawConfiguration.id,
      executionMode: "dedicated",
    });
    // Native runtime support does not waive the required Sandbox containment.
    // Refusal leaves the existing embedded revision unchanged.
    await assert.rejects(
      controller.deployAgent(
        administrator,
        { namespaceId: namespace.id, agentId: agent.id },
        resolveApprovedProductionHarness,
      ),
      dedicatedSandboxRefusal,
    );
    // Without that Sandbox Driver the Installation cannot admit dedicated OpenClaw (finding 1608).
    assert.deepEqual((await controller.getInstallation(administrator)).capabilities, {
      openclaw: { executionModes: ["embedded"] },
    });
    // Listing returns the revision's summary: no saved settings.
    assert.deepEqual(
      (await controller.listRevisions(administrator, namespace.id, agent.id)).revisions,
      [
        {
          id: embedded.id,
          namespaceId: embedded.namespaceId,
          agentId: embedded.agentId,
          revision: embedded.revision,
          backendId: embedded.backendId,
          configurationId: embedded.configurationId,
          configurationGeneration: embedded.configurationGeneration,
          harness: embedded.harness,
          createdAt: embedded.createdAt,
          // The deployment the listing names: the one admitted above, still queued.
          deploymentStatus: "queued",
          deploymentErrorCode: null,
        },
      ],
    );

    assert.throws(
      () =>
        resolveConfiguredHarnessId({
          agents: {
            defaults: {
              model: "codex/gpt-4.1",
              models: { "codex/gpt-4.1": { agentRuntime: { id: "codex" } } },
            },
            entries: { secondary: { model: "anthropic/claude" } },
          },
        }),
      ScopeViolationError,
    );
    assert.throws(
      () =>
        resolveConfiguredHarnessId({
          agents: {
            defaults: {
              model: "openai/gpt-4.1",
              models: { "openai/gpt-4.1": { agentRuntime: "openclaw" } },
            },
          },
        }),
      ScopeViolationError,
    );
  });
}
