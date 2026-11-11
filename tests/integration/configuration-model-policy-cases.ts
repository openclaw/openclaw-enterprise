import assert from "node:assert/strict";
import test from "node:test";
import type {
  ErrorResponse,
  OpenClawConfigurationDocument,
  PresetDraftTemplate,
} from "../../packages/contracts/src/index.ts";
import {
  catalogRowNoModel,
  catalogRowUnselected,
  codexRuntimeOffProvider,
  keepRuntime,
  OPENCLAW_ONLY,
  runtimeIdRequired,
  runtimeIdUnsupported,
  runtimePoliciesConflict,
  selectableModelOffProvider,
} from "../helpers/refusal-text.mjs";

type HttpResponse = { readonly status: number; readonly body: unknown };
type RefusalMessage = ErrorResponse["error"]["message"];
type DeployRefusal = { readonly status?: number; readonly message?: RefusalMessage };

type StoredRowAgent = {
  updateSaved(values: OpenClawConfigurationDocument, label: string): Promise<HttpResponse>;
  refusedAtSaveAndDeploy(
    values: OpenClawConfigurationDocument,
    message: RefusalMessage,
    deploy?: DeployRefusal,
  ): Promise<void>;
  deploy(): Promise<HttpResponse>;
  restore(): Promise<void>;
};

type ModelPolicyFixture = {
  create(values: OpenClawConfigurationDocument): Promise<HttpResponse>;
  savePreset(template: PresetDraftTemplate, name: string): Promise<HttpResponse>;
  storedRowAgent(
    valid: OpenClawConfigurationDocument,
    options: { readonly name: string; readonly secretName: string },
  ): Promise<StoredRowAgent>;
};

type ConflictCase = readonly [
  name: string,
  values: OpenClawConfigurationDocument,
  message: RefusalMessage,
  deploy?: DeployRefusal,
];

type IncompleteDraftCase = readonly [
  name: string,
  values: OpenClawConfigurationDocument,
  deployMessage: RefusalMessage,
];

// A model and runtime selection, so deployment reaches the Configuration rules.
export const runtimeDefaults = {
  model: "openai/gpt-4.1",
  models: { "openai/gpt-4.1": { agentRuntime: { id: "openclaw" } } },
} satisfies OpenClawConfigurationDocument;
export const runtimeSelected = {
  agents: { defaults: runtimeDefaults },
} satisfies OpenClawConfigurationDocument;

// The refusal texts the save rules name a field or setting with.
export const setting = (path: string, requirement: string) =>
  `Configuration setting ${path} ${requirement}.`;

// A 400 that names `message` and never echoes `sentinel`.
export function assertRefused(
  response: HttpResponse,
  message: RefusalMessage,
  { label = "", sentinel }: { label?: string; sentinel?: string } = {},
): void {
  assert.equal(response.status, 400, `${label}: ${JSON.stringify(response.body)}`);
  const { body } = response;
  assert.ok(typeof body === "object" && body !== null && "error" in body, label);
  const { error } = body;
  assert.ok(
    typeof error === "object" && error !== null && "code" in error && "message" in error,
    label,
  );
  assert.equal(error.code, "INVALID_REQUEST" satisfies ErrorResponse["error"]["code"], label);
  assert.equal(error.message, message, label);
  if (sentinel !== undefined) {
    assert.equal(JSON.stringify(response.body).includes(sentinel), false, label);
  }
}

export function registerConfigurationModelPolicyCases(
  createFixture: (id: string) => Promise<ModelPolicyFixture>,
): void {
  test("Configuration save refuses a provider catalog row that no model selection names, with deployment's text", async () => {
    // Finding 3019. Every deployment resolves the Harness from the model policy and first refuses a
    // models.providers.<p>.models row whose id names no primary or fallback model. Save accepted
    // such a row, so the draft looked ready until Deploy answered 400.
    const fixture = await createFixture("compute-catalog-integration");
    const withCatalog = (
      rows: readonly (OpenClawConfigurationDocument & { readonly id: string })[],
      agents: OpenClawConfigurationDocument = { defaults: runtimeDefaults },
    ): OpenClawConfigurationDocument => ({
      agents,
      models: { providers: { openai: { models: rows } } },
    });
    const selected = withCatalog([{ id: "gpt-4.1" }]);
    const agent = await fixture.storedRowAgent(selected, {
      name: "Catalog consumer",
      secretName: "catalog-key",
    });
    const catalogRule = catalogRowUnselected("models.providers.openai");
    // Create and update refuse the row. A row an older release stored still reads, deployment
    // refuses it with the same text, and an update that keeps it is refused.
    await agent.refusedAtSaveAndDeploy(
      withCatalog([{ id: "gpt-4.1" }, { id: "gpt-unselected" }]),
      catalogRule,
    );
    // With no model selected at all, the row refusal names the model setting instead: save and
    // deploy share the text (dogfood-member-r67 catalog row 7).
    await agent.refusedAtSaveAndDeploy(
      withCatalog([{ id: "gpt-4.1" }], {}),
      catalogRowNoModel("models.providers.openai"),
    );

    // Rows that name a selected model save: the primary by its id or its complete ref, a fallback,
    // and an Agent entry's own model.
    const fallback = { primary: "openai/gpt-4.1", fallbacks: ["openai/gpt-4.1-mini"] };
    for (const values of [
      withCatalog([{ id: "openai/gpt-4.1" }]),
      withCatalog([{ id: "gpt-4.1" }, { id: "gpt-4.1-mini" }], {
        defaults: { ...runtimeDefaults, model: fallback },
      }),
      withCatalog([{ id: "gpt-4.1" }], { entries: { main: { model: "openai/gpt-4.1" } } }),
    ]) {
      await agent.updateSaved(values, JSON.stringify(values));
    }

    // A Preset whose model or catalog row waits on a variable names no model yet: a launch can fill
    // both with one model. It saves; the Configuration a launch creates gets Configuration save's
    // check.
    for (const [index, model] of ["openai/{{ vars.model }}", "{{ vars.model }}"].entries()) {
      const waiting = await fixture.savePreset(
        {
          variables: { model: { type: "string" }, row: { type: "string" } },
          configuration: {
            values: withCatalog([{ id: "{{ vars.row }}" }], {
              defaults: { model, models: { [model]: { agentRuntime: { id: "openclaw" } } } },
            }),
          },
        },
        `Catalog-deferred-${index}`,
      );
      assert.equal(waiting.status, 201, `${model}: ${JSON.stringify(waiting.body)}`);
    }
  });

  test("Configuration save refuses a model policy whose settings conflict, with deployment's text and order", async (t) => {
    // Finding 3020. Every deployment resolves the Harness from the model policy first and refuses
    // a document whose settings conflict. Save accepted these, so the draft looked ready until
    // Deploy answered 400. A draft that still misses a model or a runtime saves (below).
    const fixture = await createFixture("compute-model-policy-integration");
    const agent = await fixture.storedRowAgent(runtimeSelected, {
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
    const conflicts: readonly ConflictCase[] = [
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
    ];
    for (const [name, values, message, deploy] of conflicts) {
      await t.test(`refuses ${name}`, () => agent.refusedAtSaveAndDeploy(values, message, deploy));
    }

    // Save checks these rules in deployment's order, so a document that breaks two names the same
    // one at save and deploy: each entry's rules come before the next entry's, the entries' before
    // the catalog rule, and the catalog rule before the runtime policies.
    await t.test("names the entry primary before an unselected catalog row", () =>
      agent.refusedAtSaveAndDeploy(
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
      agent.refusedAtSaveAndDeploy(
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
      agent.refusedAtSaveAndDeploy(
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
    const incompleteDrafts: readonly IncompleteDraftCase[] = [
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
    ];
    for (const [name, values, deployMessage] of incompleteDrafts) {
      await t.test(`saves ${name}`, async () => {
        const label = JSON.stringify(values);
        const created = await fixture.create(values);
        assert.equal(created.status, 201, `${label}: ${JSON.stringify(created.body)}`);
        await agent.updateSaved(values, label);
        const deployed = await agent.deploy();
        assertRefused(deployed, deployMessage, { label });
        await agent.restore();
      });
    }
  });
}
