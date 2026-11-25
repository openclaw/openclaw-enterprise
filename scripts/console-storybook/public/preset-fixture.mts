import type {
  HarnessAuthBinding,
  PresetVariable,
  OpenClawConfigurationDocument,
  OpenClawConfigurationValue,
} from "@openclaw-enterprise/contracts";
import { configurationValues } from "./configuration-fixture.mts";
import defaultCodexPreset from "/console/default-codex-preset.mjs";
import standardCodexPreset from "/console/standard-codex-preset.mjs";
import standardOpenclawPreset from "/console/standard-openclaw-preset.mjs";
import swePreset from "/console/swe-preset.mjs";

type PresetScenario = {
  presetAuth?: string;
  presetAgent?: FixturePresetAgent;
  presetWorkspaceFiles?: Readonly<Record<string, string>>;
  presetVariables?: Readonly<Record<string, PresetVariable>>;
  swePreset?: boolean;
  standardCodexPreset?: boolean;
  standardOpenclawPreset?: boolean;
  modelFallbackSelection?: boolean;
  modelRosterSelection?: boolean;
  presetTrustedProxyVariable?: boolean;
  presetModelKeyVariable?: boolean;
  noDefaultPreset?: boolean;
  nativePluginSettings?: OpenClawConfigurationDocument;
};

// These fields are mutable draft projections, not an admitted Agent or a
// complete OpenClaw configuration. In particular executionMode includes the
// deliberately invalid "turbo" scenario and model maps retain JSON settings.
type FixturePresetAgent = {
  name?: string;
  executionMode?: string;
  backendId?: string | null;
  harnessAuth?: {
    method: string;
    source?: Extract<HarnessAuthBinding, { source: object }>["source"];
    secret?: string;
    sourceId?: string;
  };
  plugins?: OpenClawConfigurationDocument;
  initialWorkspaceFiles?: Readonly<Record<string, string>>;
};
type ModelSelection = { primary: string; fallbacks?: readonly string[] };
type FixturePresetValues = {
  agents?: {
    defaults: {
      model: string | ModelSelection;
      models?: Record<string, OpenClawConfigurationDocument>;
    };
    ownership?: string;
    entries?: Record<string, OpenClawConfigurationDocument>;
  };
  gateway?: OpenClawConfigurationDocument;
} & Record<string, OpenClawConfigurationValue>;
type FixtureDefinition = {
  name: string;
  template: {
    variables?: Record<string, PresetVariable>;
    agent: FixturePresetAgent;
    configuration: {
      values: FixturePresetValues;
      secretBindings?: OpenClawConfigurationDocument;
    };
  };
};
type FixturePreset = FixtureDefinition & {
  id: string;
  namespaceId: string;
  createdAt?: string;
};
// JSON imports widen variable tags to string. All other imported fields already
// satisfy the draft projection; check the tags and their matching defaults only.
type ImportedVariable = { type: string; description?: string; default?: string | number | boolean };
type ImportedDefinition = Omit<FixtureDefinition, "template"> & {
  template: Omit<FixtureDefinition["template"], "variables"> & {
    variables?: Record<string, ImportedVariable>;
  };
};
function typedDefinition(definition: ImportedDefinition): definition is FixtureDefinition {
  return Object.values(definition.template.variables ?? {}).every((variable) => {
    switch (variable.type) {
      case "password":
        return variable.default === undefined;
      case "string":
        return variable.default === undefined || typeof variable.default === "string";
      case "number":
        return variable.default === undefined || typeof variable.default === "number";
      case "boolean":
        return variable.default === undefined || typeof variable.default === "boolean";
      default:
        return false;
    }
  });
}
function copyDefinition(definition: ImportedDefinition): FixtureDefinition {
  if (!typedDefinition(definition)) {
    throw new TypeError("Invalid imported Preset variable definition");
  }
  return structuredClone(definition);
}
function variables(preset: FixturePreset): Record<string, PresetVariable> {
  if (preset.template.variables === undefined) {
    throw new TypeError("Missing preview Preset variables");
  }
  return preset.template.variables;
}
export function createPresetFixtures(
  scenario: PresetScenario,
  namespaceId: string,
  auth: HarnessAuthBinding,
) {
  const preset: FixturePreset = {
    id: scenario.swePreset ? "pre_swe_codex" : "pre_00000000-0000-4000-8000-000000000001",
    namespaceId,
    name: "Research assistant",
    template: {
      variables: {
        name: { type: "string", description: "Name for this Agent." },
        model: {
          type: "string",
          default: "codex/gpt-4.1",
          description: "Model reference copied into the draft.",
        },
      },
      agent: {
        name: "{{ vars.name }}",
        executionMode: "dedicated",
        harnessAuth: { ...auth, method: scenario.presetAuth ?? auth.method },
      },
      configuration: {
        values: { ...configurationValues({}), agents: { defaults: { model: "{{ vars.model }}" } } },
      },
    },
  };
  if (scenario.standardCodexPreset || scenario.standardOpenclawPreset || scenario.swePreset) {
    Object.assign(
      preset,
      copyDefinition(
        scenario.swePreset
          ? swePreset
          : scenario.standardOpenclawPreset
            ? standardOpenclawPreset
            : standardCodexPreset,
      ),
    );
  }
  if (scenario.nativePluginSettings) {
    preset.template.configuration.values.plugins = structuredClone(scenario.nativePluginSettings);
  }
  if (scenario.modelFallbackSelection) {
    const ids = ["primary-model", "fallback-one", "fallback-two"];
    preset.name = "Models with ordered fallbacks";
    delete preset.template.variables;
    preset.template.agent.executionMode = "embedded";
    preset.template.agent.name = "Model selection example";
    preset.template.configuration.values = {
      agents: {
        defaults: {
          model: {
            primary: `openai/${ids[0]}`,
            fallbacks: ids.slice(1).map((id) => `openai/${id}`),
          },
          models: Object.fromEntries(
            ids.map((id) => [
              `openai/${id}`,
              {
                agentRuntime: { id: "openclaw" },
                alias: `Saved ${id}`,
                params: { temperature: 0.3 },
              },
            ]),
          ),
        },
      },
      models: {
        providers: {
          openai: {
            baseUrl: "https://models.example.test/v1",
            api: "openai-responses",
            models: ids.map((id) => ({
              id,
              name: id,
              contextWindow: 128000,
              maxTokens: 8192,
              reasoning: true,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            })),
          },
        },
      },
    };
  }
  if (scenario.modelRosterSelection) {
    const values = preset.template.configuration.values;
    const agents = values.agents;
    if (
      agents === undefined ||
      typeof agents.defaults.model === "string" ||
      agents.defaults.models === undefined
    ) {
      throw new TypeError("Missing preview roster model selection");
    }
    const defaults = agents.defaults;
    const primary = agents.defaults.model.primary;
    const policy = agents.defaults.models;
    agents.ownership = "explicit";
    agents.entries = {
      main: {
        model: primary,
        models: { [primary]: { ...policy[primary], alias: "Main policy" } },
      },
      assistant: {
        model: structuredClone(defaults.model),
        models: structuredClone(policy),
      },
      inherited: {},
    };
    preset.name = "Roster with a shared primary";
  }
  if (scenario.presetAgent) {
    Object.assign(preset.template.agent, structuredClone(scenario.presetAgent));
  }
  if (scenario.presetWorkspaceFiles) {
    preset.template.agent.initialWorkspaceFiles = structuredClone(scenario.presetWorkspaceFiles);
  }
  if (scenario.presetVariables) {
    Object.assign(variables(preset), structuredClone(scenario.presetVariables));
  }
  if (scenario.presetTrustedProxyVariable) {
    // A trusted-proxy allowlist that a Preset variable fills (finding 3122).
    variables(preset).human = {
      type: "string",
      description: "Identity of the person who runs this Agent",
    };
    const { values } = preset.template.configuration;
    values.gateway = {
      ...values.gateway,
      auth: {
        mode: "trusted-proxy",
        trustedProxy: {
          userHeader: "x-occ-identity",
          allowUsers: ["occ-workspace-files", "{{ vars.human }}"],
        },
      },
    };
  }
  if (scenario.presetModelKeyVariable) {
    // A model policy keyed by a Preset variable; the API quotes a key that is not a plain ID.
    variables(preset).fallback = {
      type: "string",
      description: "Another model ref",
    };
    const { values } = preset.template.configuration;
    if (values.agents === undefined) {
      throw new TypeError("Missing preview model defaults");
    }
    const defaults = values.agents.defaults;
    defaults.models = {
      ...defaults.models,
      "{{ vars.fallback }}": { agentRuntime: { id: "codex" } },
    };
  }
  const presets: FixturePreset[] = [
    preset,
    ...(scenario.noDefaultPreset
      ? []
      : [
          {
            ...copyDefinition(defaultCodexPreset),
            id: "pre_default_codex",
            namespaceId,
          },
        ]),
  ];
  if (scenario.swePreset) {
    for (const [name, definition] of [
      ["standard-codex", standardCodexPreset],
      ["standard-openclaw", standardOpenclawPreset],
    ] satisfies [string, typeof standardCodexPreset | typeof standardOpenclawPreset][]) {
      presets.push({
        ...copyDefinition(definition),
        id: `pre_${name.replaceAll("-", "_")}`,
        namespaceId,
      });
    }
  }
  return presets;
}
