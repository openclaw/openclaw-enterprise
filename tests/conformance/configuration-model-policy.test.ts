import assert from "node:assert/strict";
import test from "node:test";
import type { OpenClawConfigurationDocument } from "../../packages/contracts/src/index.ts";
import {
  ConfigurationHarnessError,
  resolveConfiguredHarnessId,
} from "../../packages/occ/src/index.ts";
import {
  catalogRowNoModel,
  catalogRowUnselected,
  codexRuntimeOffProvider,
  BOTH_RUNTIMES,
  keepRuntime,
  runtimeIdRequired,
  runtimeOfEntries,
  runtimeOfListedModels,
  runtimeOfOtherModels,
  runtimeOfPrimaryElsewhere,
  runtimeIdUnsupported,
  runtimePoliciesConflict,
  selectableModelOffProvider,
  selectableModelRuntimeMismatch,
  selectableModelsNotObject,
  selectablePrimaryRuntimeRequired,
} from "../helpers/refusal-text.mjs";

type RefusalCase = readonly [values: OpenClawConfigurationDocument, message: string];
type RepairCase = readonly [...RefusalCase, fixed: OpenClawConfigurationDocument];
type RosterCase = readonly [entries: OpenClawConfigurationDocument, path: string];

// A model policy that selects runtime `id`.
const runtime = (id: string) => ({ agentRuntime: { id } });

// Returns the refusal message after checking that every refusal is a ConfigurationHarnessError
// within the 256-character cap.
function configurationRefusal(values: OpenClawConfigurationDocument): string {
  try {
    resolveConfiguredHarnessId(values);
  } catch (error) {
    assert.ok(error instanceof ConfigurationHarnessError, String(error));
    assert.ok(Array.from(error.message).length <= 256, error.message);
    return error.message;
  }
  assert.fail(`${JSON.stringify(values)} was admitted`);
}

// Each case is [values, refusal, values with the refusal's offer applied]. The offer names only a
// value and a setting that the next deployment accepts: codex only where Codex runs the model, the
// runtime another policy, an entry or an earlier selected model already selects, and a setting
// where the runtime keeps the selectable rule.
test("model policy refusals offer only what the next deployment accepts", () => {
  for (const [values, message, fixed] of [
    // The listed models use codex: openclaw for the primary would refuse them next.
    [
      {
        agents: {
          defaults: {
            model: "codex/gpt-5.1",
            models: { "codex/gpt-5.1": {}, "codex/gpt-5.1-mini": runtime("codex") },
          },
        },
      },
      selectablePrimaryRuntimeRequired(
        'agents.defaults.models["codex/gpt-5.1"]',
        runtimeOfListedModels("codex"),
      ),
      {
        agents: {
          defaults: {
            model: "codex/gpt-5.1",
            models: { "codex/gpt-5.1": runtime("codex"), "codex/gpt-5.1-mini": runtime("codex") },
          },
        },
      },
    ],
    // The defaults' policy already sets the primary's runtime: another value in the entry's
    // policy would conflict with it.
    [
      {
        agents: {
          defaults: { model: "codex/gpt-5.1", models: { "codex/gpt-5.1": runtime("codex") } },
          entries: {
            main: { models: { "codex/gpt-5.1": {}, "codex/gpt-5.1-mini": runtime("codex") } },
          },
        },
      },
      selectablePrimaryRuntimeRequired(
        'agents.entries.main.models["codex/gpt-5.1"]',
        runtimeOfPrimaryElsewhere("codex"),
      ),
      {
        agents: {
          defaults: { model: "codex/gpt-5.1", models: { "codex/gpt-5.1": runtime("codex") } },
          entries: {
            main: {
              models: { "codex/gpt-5.1": runtime("codex"), "codex/gpt-5.1-mini": runtime("codex") },
            },
          },
        },
      },
    ],
    // The primary selected codex first, so both policies of its fallback must too.
    [
      {
        agents: {
          defaults: {
            model: { primary: "codex/gpt-5.1", fallbacks: ["codex/gpt-5.1-mini"] },
            models: { "codex/gpt-5.1": runtime("codex"), "codex/gpt-5.1-mini": runtime("codex") },
          },
        },
        models: {
          providers: { codex: { models: [{ id: "gpt-5.1-mini", ...runtime("openclaw") }] } },
        },
      },
      runtimePoliciesConflict(
        'agents.defaults.models["codex/gpt-5.1-mini"]',
        "codex",
        "models.providers.codex.models[0]",
        "openclaw",
        keepRuntime("codex", "openclaw"),
      ),
      {
        agents: {
          defaults: {
            model: { primary: "codex/gpt-5.1", fallbacks: ["codex/gpt-5.1-mini"] },
            models: { "codex/gpt-5.1": runtime("codex"), "codex/gpt-5.1-mini": runtime("codex") },
          },
        },
        models: { providers: { codex: { models: [{ id: "gpt-5.1-mini", ...runtime("codex") }] } } },
      },
    ],
    // Codex runs a codex model and nothing else selects a runtime: either value is accepted.
    [
      {
        agents: {
          defaults: { model: "codex/gpt-5.1", models: { "codex/gpt-5.1": runtime("openclaw") } },
        },
        models: { providers: { codex: runtime("codex") } },
      },
      runtimePoliciesConflict(
        'agents.defaults.models["codex/gpt-5.1"]',
        "openclaw",
        "models.providers.codex",
        "codex",
        BOTH_RUNTIMES,
      ),
      {
        agents: {
          defaults: { model: "codex/gpt-5.1", models: { "codex/gpt-5.1": runtime("codex") } },
        },
        models: { providers: { codex: runtime("codex") } },
      },
    ],
    // An entry's policy selects codex for the model, so the defaults' must too.
    [
      {
        agents: {
          defaults: { model: "codex/gpt-5.1", models: { "codex/gpt-5.1": runtime("openclaw") } },
          entries: { main: { models: { "codex/gpt-5.1": runtime("codex") } } },
        },
        models: { providers: { codex: runtime("codex") } },
      },
      runtimePoliciesConflict(
        'agents.defaults.models["codex/gpt-5.1"]',
        "openclaw",
        "models.providers.codex",
        "codex",
        keepRuntime("codex", "openclaw"),
      ),
      {
        agents: {
          defaults: { model: "codex/gpt-5.1", models: { "codex/gpt-5.1": runtime("codex") } },
          entries: { main: { models: { "codex/gpt-5.1": runtime("codex") } } },
        },
        models: { providers: { codex: runtime("codex") } },
      },
    ],
    // A third policy the refusal does not name, the provider's, selects codex.
    [
      {
        agents: {
          defaults: { model: "codex/gpt-5.1", models: { "codex/gpt-5.1": runtime("openclaw") } },
        },
        models: {
          providers: {
            codex: { ...runtime("codex"), models: [{ id: "gpt-5.1", ...runtime("codex") }] },
          },
        },
      },
      runtimePoliciesConflict(
        'agents.defaults.models["codex/gpt-5.1"]',
        "openclaw",
        "models.providers.codex.models[0]",
        "codex",
        keepRuntime("codex", "openclaw"),
      ),
      {
        agents: {
          defaults: { model: "codex/gpt-5.1", models: { "codex/gpt-5.1": runtime("codex") } },
        },
        models: {
          providers: {
            codex: { ...runtime("codex"), models: [{ id: "gpt-5.1", ...runtime("codex") }] },
          },
        },
      },
    ],
    // The primary's runtime comes from its catalog row, so its fallback's goes in its own row: in
    // agents.defaults.models it would need the primary listed there too.
    [
      {
        agents: {
          defaults: { model: { primary: "openai/gpt-4.1", fallbacks: ["openai/gpt-4.1-mini"] } },
        },
        models: {
          providers: {
            openai: { models: [{ id: "gpt-4.1", ...runtime("openclaw") }, { id: "gpt-4.1-mini" }] },
          },
        },
      },
      runtimeIdRequired("models.providers.openai.models[1]", runtimeOfOtherModels("openclaw")),
      {
        agents: {
          defaults: { model: { primary: "openai/gpt-4.1", fallbacks: ["openai/gpt-4.1-mini"] } },
        },
        models: {
          providers: {
            openai: {
              models: [
                { id: "gpt-4.1", ...runtime("openclaw") },
                { id: "gpt-4.1-mini", ...runtime("openclaw") },
              ],
            },
          },
        },
      },
    ],
    // Without a catalog row of its own, the fallback's runtime goes on the provider.
    [
      {
        agents: {
          defaults: { model: { primary: "openai/gpt-4.1", fallbacks: ["openai/gpt-4.1-mini"] } },
        },
        models: { providers: { openai: { models: [{ id: "gpt-4.1", ...runtime("openclaw") }] } } },
      },
      runtimeIdRequired("models.providers.openai", runtimeOfOtherModels("openclaw")),
      {
        agents: {
          defaults: { model: { primary: "openai/gpt-4.1", fallbacks: ["openai/gpt-4.1-mini"] } },
        },
        models: {
          providers: {
            openai: { ...runtime("openclaw"), models: [{ id: "gpt-4.1", ...runtime("openclaw") }] },
          },
        },
      },
    ],
    // An entry's policy selects codex for the primary: openclaw in the defaults' would conflict.
    [
      {
        agents: {
          defaults: { model: "codex/gpt-5.1" },
          entries: { main: { models: { "codex/gpt-5.1": runtime("codex") } } },
        },
      },
      runtimeIdRequired('agents.defaults.models["codex/gpt-5.1"]', runtimeOfEntries("codex")),
      {
        agents: {
          defaults: { model: "codex/gpt-5.1", models: { "codex/gpt-5.1": runtime("codex") } },
          entries: { main: { models: { "codex/gpt-5.1": runtime("codex") } } },
        },
      },
    ],
    // The entry lists its primary without a runtime, so its fallback's goes beside the primary's
    // runtime in agents.defaults.models; in the entry's policy it would break the selectable rule.
    [
      {
        agents: {
          defaults: { models: { "openai/gpt-4.1": runtime("openclaw") } },
          entries: {
            main: {
              model: { primary: "openai/gpt-4.1", fallbacks: ["openai/gpt-4.1-mini"] },
              models: { "openai/gpt-4.1": {} },
            },
          },
        },
      },
      runtimeIdRequired(
        'agents.defaults.models["openai/gpt-4.1-mini"]',
        runtimeOfOtherModels("openclaw"),
      ),
      {
        agents: {
          defaults: {
            models: {
              "openai/gpt-4.1": runtime("openclaw"),
              "openai/gpt-4.1-mini": runtime("openclaw"),
            },
          },
          entries: {
            main: {
              model: { primary: "openai/gpt-4.1", fallbacks: ["openai/gpt-4.1-mini"] },
              models: { "openai/gpt-4.1": {} },
            },
          },
        },
      },
    ],
  ] satisfies readonly RepairCase[]) {
    assert.equal(configurationRefusal(values), message, JSON.stringify(values));
    assert.doesNotThrow(() => resolveConfiguredHarnessId(fixed), JSON.stringify(fixed));
  }
});

test("Agent roster refusals name the setting and the fix", () => {
  const listRefusal =
    "Configuration setting agents.list is unsupported: remove it and configure each Agent under agents.entries, keyed by its Agent ID.";
  for (const list of [[{ id: "main" }], {}, null]) {
    assert.equal(configurationRefusal({ agents: { list } }), listRefusal, JSON.stringify(list));
  }
  for (const [entries, path] of [
    [{ main: "not-an-object" }, "agents.entries.main"],
    [{ main: {}, helper: null }, "agents.entries.helper"],
    [{ "a.b": [] }, 'agents.entries["a.b"]'],
    [{ "a\u0007b": 1 }, 'agents.entries["a?b"]'],
  ] satisfies readonly RosterCase[]) {
    assert.equal(
      configurationRefusal({ agents: { defaults: { model: "codex/gpt-4.1" }, entries } }),
      `Configuration setting ${path} must be an object.`,
      path,
    );
  }
  // Shape refusals precede model policy, even for an earlier entry's model.
  assert.equal(
    configurationRefusal({ agents: { entries: { main: { model: "unqualified" }, helper: null } } }),
    "Configuration setting agents.entries.helper must be an object.",
  );
  const long = "x.".repeat(200);
  const message = configurationRefusal({ agents: { entries: { [long]: false } } });
  assert.equal(Array.from(message).length, 256, message);
  assert.ok(message.endsWith("… must be an object."), message);
  // A path that exactly fills the cap is kept whole.
  const fits = "x".repeat(256 - "Configuration setting agents.entries. must be an object.".length);
  assert.equal(
    configurationRefusal({ agents: { entries: { [fits]: false } } }),
    `Configuration setting agents.entries.${fits} must be an object.`,
  );
});

test("model policy refusals name the Configuration setting", () => {
  const catalog = { providers: { openai: { models: [{ id: "gpt-4.1" }] } } };
  const catalogRule = catalogRowUnselected("models.providers.openai");
  for (const [values, message] of [
    // Finding 888: a non-object agents read as an empty roster, so the provider catalog check
    // refused it first with text about selectable provider models.
    ...["x", 1, [], null].map<RefusalCase>((agents) => [
      { agents, models: catalog },
      "Configuration setting agents must be an object.",
    ]),
    ...["x", [], null].map<RefusalCase>((defaults) => [
      { agents: { defaults, entries: { main: {} } }, models: catalog },
      "Configuration setting agents.defaults must be an object.",
    ]),
    ...["x", [], null].map<RefusalCase>((entries) => [
      { agents: { entries }, models: catalog },
      "Configuration setting agents.entries must be an object keyed by Agent ID.",
    ]),
    [
      { agents: { entries: { main: {} } } },
      "Configuration setting agents.entries.main.model is required when agents.defaults.model is unset: set either one.",
    ],
    // With no model selected at all, a catalog row names the model setting to set, not the row
    // rule no row could meet.
    [{ models: catalog }, catalogRowNoModel("models.providers.openai")],
    [{ agents: { defaults: {} }, models: catalog }, catalogRowNoModel("models.providers.openai")],
    [
      {
        agents: {
          defaults: { model: "openai/gpt-4.1" },
          entries: { main: {}, "x.y": { model: "openai/gpt-4.1-mini" } },
        },
      },
      'Configuration setting agents.entries["x.y"].model must select the same primary model as agents.defaults.model and the other agents.entries.',
    ],
    [
      {
        agents: {
          defaults: { model: "openai/gpt-4.1" },
          entries: { main: { models: { "openai/gpt-4.1-mini": {} } } },
        },
      },
      selectablePrimaryRuntimeRequired('agents.entries.main.models["openai/gpt-4.1"]', "openclaw"),
    ],
    [
      { agents: { defaults: { model: "openai/gpt-4.1", models: "x" } } },
      selectableModelsNotObject("agents.defaults.models"),
    ],
    [
      { agents: { defaults: { model: "openai/gpt-4.1" }, entries: { "a.b": { models: [] } } } },
      selectableModelsNotObject('agents.entries["a.b"].models'),
    ],
    // The selectable rule names the first listed model that breaks it, in document order.
    [
      {
        agents: {
          defaults: {
            model: "openai/gpt-4.1",
            models: {
              "openai/gpt-4.1": runtime("openclaw"),
              "openai/gpt-4.1-mini": runtime("codex"),
              "gateway/model-x": runtime("openclaw"),
            },
          },
        },
      },
      selectableModelRuntimeMismatch('agents.defaults.models["openai/gpt-4.1-mini"]', "openclaw"),
    ],
    [
      {
        agents: {
          defaults: {
            model: "openai/gpt-4.1",
            models: {
              "openai/gpt-4.1": runtime("codex"),
              "gateway/model-x": runtime("codex"),
              "openai/gpt-4.1-mini": runtime("openclaw"),
            },
          },
        },
      },
      selectableModelOffProvider('agents.defaults.models["gateway/model-x"]', "openai"),
    ],
    // Each runtime refusal names the policy that sets the runtime: an entry's, the defaults', a
    // provider catalog row or the provider.
    [
      {
        agents: {
          defaults: { model: "openai/gpt-4.1", models: { "openai/gpt-4.1": runtime("pi") } },
        },
      },
      runtimeIdUnsupported('agents.defaults.models["openai/gpt-4.1"]'),
    ],
    [
      {
        agents: { defaults: { model: "openai/gpt-4.1" } },
        models: {
          providers: { openai: { models: [{ id: "gpt-4.1", agentRuntime: "codex" }] } },
        },
      },
      runtimeIdUnsupported("models.providers.openai.models[0]"),
    ],
    [
      {
        agents: {
          defaults: { model: { primary: "openai/gpt-4.1", fallbacks: ["openai/gpt-4.1-mini"] } },
        },
        models: {
          providers: {
            openai: {
              models: [{ id: "gpt-4.1" }, { id: "gpt-4.1-mini", ...runtime("codex") }],
              ...runtime("openclaw"),
            },
          },
        },
      },
      runtimePoliciesConflict(
        "models.providers.openai.models[1]",
        "codex",
        "models.providers.openai",
        "openclaw",
        keepRuntime("openclaw", "codex"),
      ),
    ],
    [
      {
        agents: {
          defaults: { model: "openai/gpt-4.1", models: { "openai/gpt-4.1": runtime("openclaw") } },
          entries: { main: { models: { "openai/gpt-4.1": runtime("codex") } } },
        },
      },
      runtimePoliciesConflict(
        'agents.entries.main.models["openai/gpt-4.1"]',
        "codex",
        'agents.defaults.models["openai/gpt-4.1"]',
        "openclaw",
        keepRuntime("openclaw", "codex"),
      ),
    ],
    [
      {
        agents: { defaults: { model: "custom/model" } },
        models: { providers: { custom: runtime("codex") } },
      },
      codexRuntimeOffProvider("models.providers.custom"),
    ],
    // A missing runtime names the entry's policy when the entry lists the model.
    [
      {
        agents: {
          entries: { main: { model: "openai/gpt-4.1", models: { "openai/gpt-4.1": {} } } },
        },
      },
      runtimeIdRequired('agents.entries.main.models["openai/gpt-4.1"]', "openclaw"),
    ],
    [
      { agents: { entries: { main: { model: "openai/gpt-4.1" } } } },
      runtimeIdRequired('agents.defaults.models["openai/gpt-4.1"]', "openclaw"),
    ],
    // A missing runtime offers only values deployment then accepts. Codex runs a codex model, or
    // an openai model through the Codex plugin's WebSocket app server.
    [
      { agents: { defaults: { model: "codex/gpt-5.1" } } },
      runtimeIdRequired('agents.defaults.models["codex/gpt-5.1"]', "openclaw or codex"),
    ],
    [
      {
        agents: { defaults: { model: "openai/gpt-4.1" } },
        plugins: {
          entries: { codex: { enabled: true, config: { appServer: { transport: "websocket" } } } },
        },
      },
      runtimeIdRequired('agents.defaults.models["openai/gpt-4.1"]', "openclaw or codex"),
    ],
    // A fallback must select its primary's runtime.
    [
      {
        agents: {
          defaults: {
            model: { primary: "codex/gpt-5.1", fallbacks: ["codex/gpt-5.1-mini"] },
            models: { "codex/gpt-5.1": runtime("codex") },
          },
        },
      },
      runtimeIdRequired(
        'agents.defaults.models["codex/gpt-5.1-mini"]',
        runtimeOfOtherModels("codex"),
      ),
    ],
    // An entry whose own policy sets its primary's runtime gets its fallback's there: in the
    // defaults' policy it would need the primary's runtime too.
    [
      {
        agents: {
          entries: {
            main: {
              model: { primary: "openai/gpt-4.1", fallbacks: ["openai/gpt-4.1-mini"] },
              models: { "openai/gpt-4.1": runtime("openclaw") },
            },
          },
        },
      },
      runtimeIdRequired(
        'agents.entries.main.models["openai/gpt-4.1-mini"]',
        runtimeOfOtherModels("openclaw"),
      ),
    ],
    [
      { agents: { defaults: { models: {} } } },
      "Configuration setting agents.defaults.models needs a primary model: set agents.defaults.model or an agents.entries model.",
    ],
    [
      { models: { providers: { openai: "x" } } },
      "Configuration setting models.providers.openai must be an object.",
    ],
    [
      { models: { providers: { "my provider": { models: {} } } } },
      'Configuration setting models.providers["my provider"].models must be an array of model entries.',
    ],
    [
      {
        agents: { defaults: { model: "openai/gpt-4.1" } },
        models: { providers: { openai: { models: [{ id: "gpt-4.1" }, { id: "gpt-4.1-mini" }] } } },
      },
      catalogRule,
    ],
    [
      {
        agents: { defaults: { model: "openai/gpt-4.1" } },
        models: { providers: { openai: { models: ["gpt-4.1"] } } },
      },
      catalogRule,
    ],
    [
      {
        agents: {
          defaults: {
            model: "openai/gpt-4.1",
            models: { "openai/gpt-4.1": { agentRuntime: { id: "openclaw" } } },
          },
        },
        models: {
          providers: { openai: { models: [{ id: "gpt-4.1" }, { id: "openai/gpt-4.1" }] } },
        },
      },
      "Configuration setting models.providers.openai.models lists the selected model more than once: keep one entry.",
    ],
  ] satisfies readonly RefusalCase[]) {
    assert.equal(configurationRefusal(values), message, JSON.stringify(values));
  }
  const long = "p.".repeat(200);
  assert.ok(
    configurationRefusal({ models: { providers: { [long]: false } } }).endsWith(
      "… must be an object.",
    ),
  );
  // A conflict names two settings: a long entry key shortens the longer path only, so the
  // message keeps the cap and the short provider path whole.
  const conflict = configurationRefusal({
    agents: {
      entries: { [long]: { model: "openai/m", models: { "openai/m": runtime("codex") } } },
    },
    models: { providers: { openai: runtime("openclaw") } },
  });
  assert.equal(Array.from(conflict).length, 256, conflict);
  assert.ok(
    conflict.endsWith(
      `… (codex) and models.providers.openai.agentRuntime.id (openclaw) conflict: ${keepRuntime("openclaw", "codex")}.`,
    ),
    conflict,
  );
});
