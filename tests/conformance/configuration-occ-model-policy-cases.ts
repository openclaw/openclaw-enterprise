import assert from "node:assert/strict";
import test from "node:test";
import type { OpenClawConfigurationDocument } from "@openclaw-enterprise/contracts";
import {
  ConfigurationHarnessError,
  ScopeViolationError,
  resolveConfiguredHarnessId,
} from "../../packages/occ/src/index.ts";
import { keepRuntime, runtimePoliciesConflict } from "../helpers/refusal-text.mjs";

export function registerConfigurationModelPolicyCases(): void {
  test("native selected-model policy explicitly chooses Codex or OpenClaw", () => {
    for (const [model, runtime] of [
      ["codex/gpt-4.1", "codex"],
      ["openai/gpt-4.1", "openclaw"],
    ] as const) {
      assert.equal(
        resolveConfiguredHarnessId({
          agents: { defaults: { model, models: { [model]: { agentRuntime: { id: runtime } } } } },
        }),
        runtime,
      );
    }
    assert.equal(
      resolveConfiguredHarnessId({
        agents: { defaults: { model: "openai/gpt-4.1" } },
        models: {
          providers: {
            openai: {
              agentRuntime: { id: "openclaw" },
              baseUrl: "https://provider.example.test/v1",
            },
          },
        },
      }),
      "openclaw",
    );
    assert.equal(
      resolveConfiguredHarnessId({
        agents: {
          defaults: {
            model: { primary: "codex/gpt-4.1", fallbacks: [] },
            models: { "codex/gpt-4.1": { agentRuntime: { id: "codex" } } },
          },
          list: [],
        },
      }),
      "codex",
    );
    assert.equal(
      resolveConfiguredHarnessId({
        agents: {
          defaults: {
            model: "openai/gpt-4.1",
            models: {
              "openai/gpt-4.1": { agentRuntime: { id: "codex" } },
              "openai/gpt-4.1-mini": { agentRuntime: { id: "codex" } },
              "openai/gpt-4o": { agentRuntime: { id: "codex" } },
            },
          },
          entries: { main: { default: true } },
        },
        plugins: {
          entries: {
            codex: {
              enabled: true,
              config: { appServer: { transport: "websocket" } },
            },
          },
        },
      }),
      "codex",
    );
    assert.equal(
      resolveConfiguredHarnessId({
        agents: {
          defaults: {
            model: "openai/gpt-4.1",
            models: { "openai/gpt-4.1": { agentRuntime: { id: "openclaw" } } },
          },
          entries: {
            primary: {
              models: { "openai/gpt-4.1": { agentRuntime: { id: "openclaw" } } },
            },
          },
        },
        models: {
          providers: {
            openai: {
              agentRuntime: { id: "openclaw" },
              models: [{ id: "gpt-4.1", agentRuntime: { id: "openclaw" } }],
            },
          },
        },
      }),
      "openclaw",
    );
    assert.equal(
      resolveConfiguredHarnessId({
        agents: {
          defaults: { models: { "codex/gpt-4.1": { agentRuntime: { id: "codex" } } } },
          entries: { primary: { model: "codex/gpt-4.1" } },
        },
      }),
      "codex",
    );
    // A model ID may itself contain slashes. The provider ends at the first slash, so the
    // catalog entry `vendor/model` must match `openai/vendor/model` and keep its authored name.
    assert.equal(
      resolveConfiguredHarnessId({
        agents: {
          defaults: {
            model: "openai/vendor/model",
            models: { "openai/vendor/model": { agentRuntime: { id: "openclaw" } } },
          },
        },
        models: {
          providers: {
            openai: {
              baseUrl: "https://gateway.example.test/v1",
              api: "openai-responses",
              models: [{ id: "vendor/model", name: "Team Fast", agentRuntime: { id: "openclaw" } }],
            },
          },
        },
      }),
      "openclaw",
    );
  });

  test("Harness resolution stays in step with the size of the model selections and catalog", () => {
    // Finding 1316: every Configuration and Preset save resolves the Harness synchronously, while
    // holding the Namespace row lock. It matched every catalog row against every selected model,
    // and repeated the defaults' fallbacks for each entry without its own model, so one large
    // valid document held the controller for seconds to minutes.
    const count = 50_000;
    const fallbacks = Array.from({ length: count }, (_, index) => `openai/m${index + 1}`);
    // The bound is relative to a structured clone of the same document, so a slow or busy runner
    // does not fail it (finding 1326). At two CPUs resolution takes 1-6 clones, and up to 20 with
    // four copies of the test sharing them; before, the first shape took about 2 minutes, about
    // 5,800 clones (and about 320 with 2,000 models instead of 50,000). The two are timed in turn
    // up to three times, keeping each one's best, until resolution is under the bound; a miss far
    // past it is not noise and is not timed again.
    const timed = (values: OpenClawConfigurationDocument, expected: "openclaw" | "codex") => {
      const timings = { resolving: Infinity, cloning: Infinity };
      for (let round = 0; round < 3; round += 1) {
        for (const [name, work] of [
          ["resolving", () => assert.equal(resolveConfiguredHarnessId(values), expected)],
          ["cloning", () => structuredClone(values)],
        ] as const) {
          const started = performance.now();
          work();
          timings[name] = Math.min(timings[name], performance.now() - started);
        }
        const { resolving, cloning } = timings;
        if (resolving < 50 * cloning || resolving > 500 * cloning) {
          break;
        }
      }
      const { resolving, cloning } = timings;
      assert.ok(
        resolving < 50 * cloning,
        `resolution took ${resolving.toFixed(0)} ms, a clone ${cloning.toFixed(0)} ms`,
      );
    };
    // 50k fallbacks, each listed in a 50k-row provider catalog that selects its runtime.
    timed(
      {
        agents: { defaults: { model: { primary: "openai/m0", fallbacks } } },
        models: {
          providers: {
            openai: {
              models: [
                { id: "m0", agentRuntime: { id: "openclaw" } },
                ...fallbacks.map((model) => ({ id: model.slice("openai/".length) })),
              ],
              agentRuntime: { id: "openclaw" },
            },
          },
        },
      },
      "openclaw",
    );
    // 50k entries without their own model each select the defaults' 50k fallbacks; the entries'
    // own `models` policies still apply: the last entry's conflicts with the provider's.
    const entries = Object.fromEntries<{ models: OpenClawConfigurationDocument }>(
      Array.from({ length: count }, (_, index) => [`a${index}`, { models: {} }]),
    );
    const values = {
      agents: {
        ownership: "explicit",
        defaults: { model: { primary: "openai/m0", fallbacks } },
        entries,
      },
      models: { providers: { openai: { agentRuntime: { id: "openclaw" } } } },
    };
    timed(values, "openclaw");
    const lastFallback = fallbacks.at(-1);
    assert.ok(lastFallback);
    entries[`a${count - 1}`] = {
      models: {
        "openai/m0": { agentRuntime: { id: "codex" } },
        [lastFallback]: { agentRuntime: { id: "codex" } },
      },
    };
    assert.throws(
      () => resolveConfiguredHarnessId(values),
      new ConfigurationHarnessError(
        runtimePoliciesConflict(
          `agents.entries.a${count - 1}.models["openai/m0"]`,
          "codex",
          "models.providers.openai",
          "openclaw",
          keepRuntime("openclaw", "codex"),
        ),
      ),
    );
  });

  test("an unambiguous built-in model defaults to embedded OpenClaw", () => {
    assert.equal(resolveConfiguredHarnessId({}), "openclaw");
    assert.equal(
      resolveConfiguredHarnessId({ agents: { defaults: { model: "anthropic/claude" } } }),
      "openclaw",
    );
  });

  test("ambiguous and plugin-routed models require supported explicit native policy", () => {
    for (const configuration of [
      { agents: { defaults: { model: "openai/gpt-4.1" } } },
      { agents: { defaults: { model: "codex/gpt-4.1" } } },
      {
        agents: { defaults: { model: "openai/gpt-4.1", agentRuntime: { id: "openclaw" } } },
      },
      {
        agents: { defaults: { model: "anthropic/claude" } },
        models: { providers: { anthropic: { baseUrl: "https://provider.example.test/v1" } } },
      },
      {
        agents: { defaults: { model: "custom/plugin-model" } },
        plugins: { entries: { custom: { enabled: true } } },
      },
      {
        agents: {
          defaults: {
            model: "openai/gpt-4.1",
            models: { "openai/gpt-4.1": { agentRuntime: { id: "unsupported" } } },
          },
        },
      },
    ]) {
      assert.throws(() => resolveConfiguredHarnessId(configuration), ScopeViolationError);
    }
  });
}
