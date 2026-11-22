import test from "node:test";
import type { ControllerApp } from "../../apps/controller/src/index.ts";
import type {
  Configuration,
  ConfigurationDriver,
  OpenClawConfigurationDocument,
} from "../../packages/contracts/src/index.ts";
import {
  catalogRowUnselected,
  codexRuntimeOffProvider,
  keepRuntime,
  OPENCLAW_ONLY,
  runtimeIdRequired,
  runtimeIdUnsupported,
  runtimePoliciesConflict,
  selectableModelOffProvider,
} from "../helpers/refusal-text.mjs";

interface HttpResponse {
  status: number;
  body: unknown;
}

interface ConfigurationStore extends Pick<ConfigurationDriver, "update"> {
  storedConfigurations(): Configuration[];
}

interface ModelPolicyContext {
  app: ControllerApp;
  collection: string;
  configurationDriver: ConfigurationStore;
}

interface ModelPolicyAgent {
  configurationDriver: ConfigurationStore;
  configurationId: string;
  created: HttpResponse;
  item: string;
  agentPath: string;
  valid: OpenClawConfigurationDocument;
}

type RuntimeDefaults = {
  model: string;
  models: Record<string, { agentRuntime: { id: string } }>;
};
type DeployRefusal = { message: string };
type ModelPolicyRefusal = [
  name: string,
  values: OpenClawConfigurationDocument,
  message: string,
  deploy?: DeployRefusal,
];
type IncompleteDraft = [name: string, values: OpenClawConfigurationDocument, deployMessage: string];

interface ModelPolicyFixtures {
  runtimeDefaults: RuntimeDefaults;
  runtimeSelected: OpenClawConfigurationDocument;
  kubernetesRuleFixture(computeId: string, rule: string): Promise<ModelPolicyContext>;
  storedRowAgent(
    context: ModelPolicyContext,
    values: OpenClawConfigurationDocument,
    options: { name: string; secretName: string },
  ): Promise<ModelPolicyAgent>;
  setting(path: string, requirement: string): string;
  refusedAtSaveAndDeploy(
    context: ModelPolicyContext,
    agent: ModelPolicyAgent,
    values: OpenClawConfigurationDocument,
    message: string,
    deploy?: DeployRefusal,
  ): Promise<void>;
  createAgentConfiguration(
    context: ModelPolicyContext,
    values: OpenClawConfigurationDocument,
    label?: string,
  ): Promise<HttpResponse>;
  updateSaved(
    context: ModelPolicyContext,
    item: string,
    values: OpenClawConfigurationDocument,
    label?: string,
  ): Promise<HttpResponse>;
  request(app: ControllerApp, method: string, pathname: string): Promise<HttpResponse>;
  assertRefused(response: HttpResponse, message: string, options?: { label?: string }): void;
  writePastOcc(
    store: ConfigurationStore,
    configurationId: string,
    values: OpenClawConfigurationDocument,
  ): Promise<void>;
}

export function registerConfigurationModelPolicyCases(fixtures: ModelPolicyFixtures): void {
  const {
    runtimeDefaults,
    runtimeSelected,
    kubernetesRuleFixture,
    storedRowAgent,
    setting,
    refusedAtSaveAndDeploy,
    createAgentConfiguration,
    updateSaved,
    request,
    assertRefused,
    writePastOcc,
  } = fixtures;

  test("Configuration save refuses a model policy whose settings conflict, with deployment's text and order", async (t) => {
    // Finding 3020. Every deployment resolves the Harness from the model policy first and refuses
    // a document whose settings conflict. Save accepted these, so the draft looked ready until
    // Deploy answered 400. A draft that still misses a model or a runtime saves (below).
    const context = await kubernetesRuleFixture(
      "compute-model-policy-integration",
      "validateHarnessAuth",
    );
    const { configurationDriver } = context;
    const agent = await storedRowAgent(context, runtimeSelected, {
      name: "Model policy consumer",
      secretName: "model-policy-key",
    });
    const runtime = (model: string, id = "openclaw") => ({ [model]: { agentRuntime: { id } } });
    const entryPrimary = setting(
      "agents.entries.main.model",
      "must select the same primary model as agents.defaults.model and the other agents.entries",
    );
    const catalogRule = catalogRowUnselected("models.providers.openai");
    const defaultPolicy = 'agents.defaults.models["openai/gpt-4.1"]';
    const unselectedRow = { providers: { openai: { models: [{ id: "gpt-unselected" }] } } };
    // Each document sets two values that cannot both hold. Create and update refuse it; a row an
    // older release stored still reads, and deployment refuses it with the same text unless the row
    // names another deployment text.
    for (const [name, values, message, deploy] of [
      [
        "an Agent entry's primary that differs from the defaults'",
        {
          agents: {
            defaults: runtimeDefaults,
            entries: { main: { model: "openai/gpt-4.1-mini" } },
          },
        },
        entryPrimary,
      ],
      [
        "an entry's selectable models on another provider than its primary's",
        {
          agents: {
            defaults: runtimeDefaults,
            entries: {
              main: {
                model: "openai/gpt-4.1",
                models: { ...runtime("openai/gpt-4.1"), ...runtime("gateway/model-x") },
              },
            },
          },
        },
        selectableModelOffProvider('agents.entries.main.models["gateway/model-x"]', "openai"),
      ],
      [
        "the defaults' selectable models on another provider than the primary's",
        {
          agents: {
            defaults: {
              ...runtimeDefaults,
              models: { ...runtimeDefaults.models, ...runtime("gateway/model-x") },
            },
          },
        },
        selectableModelOffProvider('agents.defaults.models["gateway/model-x"]', "openai"),
      ],
      [
        "a selected model policy and a provider policy that name different runtimes",
        {
          ...runtimeSelected,
          models: { providers: { openai: { agentRuntime: { id: "codex" } } } },
        },
        runtimePoliciesConflict(
          defaultPolicy,
          "openclaw",
          "models.providers.openai",
          "codex",
          keepRuntime("openclaw", "codex"),
        ),
      ],
      // The openai provider takes Codex only with the Codex plugin's WebSocket app server. Save
      // serves any Agent and offers both steps; this embedded Agent's deploy, where Codex runs only
      // dedicated, offers only openclaw (finding 3058).
      [
        "a Codex runtime on the openai provider",
        {
          agents: {
            defaults: { model: "openai/gpt-4.1", models: runtime("openai/gpt-4.1", "codex") },
          },
        },
        codexRuntimeOffProvider(defaultPolicy),
        { message: codexRuntimeOffProvider(defaultPolicy, OPENCLAW_ONLY) },
      ],
      [
        "a runtime id that no Harness implements",
        {
          agents: {
            defaults: { model: "openai/gpt-4.1", models: runtime("openai/gpt-4.1", "pi") },
          },
        },
        runtimeIdUnsupported(defaultPolicy),
      ],
      [
        "a provider runtime id that no Harness implements",
        { ...runtimeSelected, models: { providers: { openai: { agentRuntime: { id: "pi" } } } } },
        runtimeIdUnsupported("models.providers.openai"),
      ],
      // Each policy names one runtime, so no single model conflicts: the primary and its fallback
      // together select two Harnesses.
      [
        "a primary and a fallback whose catalog rows name different runtimes",
        {
          agents: {
            defaults: { model: { primary: "codex/gpt-5", fallbacks: ["codex/gpt-5-mini"] } },
          },
          models: {
            providers: {
              codex: {
                models: [
                  { id: "gpt-5", agentRuntime: { id: "openclaw" } },
                  { id: "gpt-5-mini", agentRuntime: { id: "codex" } },
                ],
              },
            },
          },
        },
        "The configured Agent models select conflicting Harness runtimes.",
      ],
      // Both rows name the selected model, one by its id and one by its complete ref.
      [
        "a catalog that lists the selected model twice",
        {
          ...runtimeSelected,
          models: {
            providers: { openai: { models: [{ id: "gpt-4.1" }, { id: "openai/gpt-4.1" }] } },
          },
        },
        setting(
          "models.providers.openai.models",
          "lists the selected model more than once: keep one entry",
        ),
      ],
      // A draft skips the entry without a model and still checks the entries after it. Deployment
      // names the missing model first.
      [
        "an entry primary that differs from an earlier entry's, after an entry without a model",
        {
          agents: {
            ownership: "explicit",
            entries: {
              pending: {},
              other: { model: "openai/gpt-4.1" },
              main: { model: "openai/gpt-4.1-mini" },
            },
          },
        },
        entryPrimary,
        {
          message: setting(
            "agents.entries.pending.model",
            "is required when agents.defaults.model is unset: set either one",
          ),
        },
      ],
    ] satisfies ModelPolicyRefusal[]) {
      await t.test(`refuses ${name}`, () =>
        refusedAtSaveAndDeploy(context, agent, values, message, deploy),
      );
    }

    // Save checks these rules in deployment's order, so a document that breaks two names the same
    // one at save and deploy: each entry's rules come before the next entry's, the entries' before
    // the catalog rule, and the catalog rule before the runtime policies.
    await t.test("names the entry primary before an unselected catalog row", () =>
      refusedAtSaveAndDeploy(
        context,
        agent,
        {
          agents: {
            defaults: runtimeDefaults,
            entries: { main: { model: "openai/gpt-4.1-mini" } },
          },
          models: unselectedRow,
        },
        entryPrimary,
      ),
    );
    await t.test("names an entry primary before a later entry's fallback on another provider", () =>
      refusedAtSaveAndDeploy(
        context,
        agent,
        {
          agents: {
            ownership: "explicit",
            defaults: runtimeDefaults,
            entries: {
              main: { model: "openai/gpt-4.1-mini" },
              other: { model: { primary: "openai/gpt-4.1", fallbacks: ["gateway/model-x"] } },
            },
          },
        },
        entryPrimary,
      ),
    );
    await t.test("names an unselected catalog row before conflicting runtime policies", () =>
      refusedAtSaveAndDeploy(
        context,
        agent,
        {
          ...runtimeSelected,
          models: {
            providers: {
              openai: { ...unselectedRow.providers.openai, agentRuntime: { id: "codex" } },
            },
          },
        },
        catalogRule,
      ),
    );

    // An incomplete draft saves: no model at all, selectable models before any primary, an entry
    // without a model while the defaults set none, or a model without the runtime its provider
    // needs. Deployment still refuses it, naming the setting that is missing (finding 3022).
    for (const [name, values, deployMessage] of [
      [
        "no model",
        {},
        setting(
          "agents.defaults.model",
          "is required to deploy on Kubernetes: set it, or each agents.entries model, to a model such as openai/gpt-5.1",
        ),
      ],
      [
        "selectable models with no primary model",
        { agents: { defaults: { models: runtimeDefaults.models } } },
        setting(
          "agents.defaults.models",
          "needs a primary model: set agents.defaults.model or an agents.entries model",
        ),
      ],
      [
        "an entry without a model while the defaults set none",
        { agents: { entries: { main: {} } } },
        setting(
          "agents.entries.main.model",
          "is required when agents.defaults.model is unset: set either one",
        ),
      ],
      [
        "an openai model without a runtime",
        { agents: { defaults: { model: "openai/gpt-4.1" } } },
        runtimeIdRequired(defaultPolicy, "openclaw"),
      ],
      // The entry's own models policy lists the model, so deployment names that policy, not the
      // defaults'.
      [
        "an entry model whose own models policy sets no runtime",
        {
          agents: {
            entries: { main: { model: "openai/gpt-4.1", models: { "openai/gpt-4.1": {} } } },
          },
        },
        runtimeIdRequired('agents.entries.main.models["openai/gpt-4.1"]', "openclaw"),
      ],
    ] satisfies IncompleteDraft[]) {
      await t.test(`saves ${name}`, async () => {
        const label = JSON.stringify(values);
        await createAgentConfiguration(context, values, label);
        await updateSaved(context, agent.item, values, label);
        const deployed = await request(context.app, "POST", `${agent.agentPath}/deploy`);
        assertRefused(deployed, deployMessage, { label });
        await writePastOcc(configurationDriver, agent.configurationId, runtimeSelected);
      });
    }
  });
}
