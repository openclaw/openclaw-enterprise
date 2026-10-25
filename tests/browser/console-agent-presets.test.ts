/// <reference lib="es2024.promise" />

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import type { Dialog, Locator, Page, Request, Response as BrowserResponse } from "playwright";

import type {
  HarnessAuthBinding,
  Preset,
  PresetTemplate,
  PresetVariable,
} from "../../packages/contracts/src/index.ts";
import type { CreateAgentBody, CreateSecretBody } from "../../packages/contracts/src/api/common.ts";
import type {
  AgentWire,
  ConfigurationResponse,
  SecretResponse,
  ConfigurationWire,
  IAMAccessBindingWire,
  IAMRoleWire,
  PresetSummaryWire,
  SecretWire,
} from "../../packages/contracts/src/api/resources.ts";
import type { PlatformUnitOfWork } from "../../packages/occ/src/state/platform-state.ts";

import {
  CodexPluginDriver,
  OCCPluginDriver,
} from "../../apps/controller/src/drivers/plugin/index.ts";
import {
  WORKSPACE_DEFAULTS,
  WORKSPACE_DEFAULTS_ID,
} from "../../packages/contracts/src/workspace-defaults.mjs";
import {
  createConsoleAppFixture as createBaseConsoleAppFixture,
  backendFixtures,
} from "../helpers/console-app.mjs";
import { authenticatedHeaders } from "../helpers/auth-session.mjs";
import { consoleStorage } from "../helpers/console-storage.mjs";
import {
  apiRequests,
  detailUrl,
  holdRequests,
  login,
  nativeValues,
  newPage,
  nonAuthWriteRequests,
  pathRequests,
  secretOptionLabel,
  secretPostRequests,
  selectSecret,
  settlePageRequests,
  trackSettledFetches,
  waitForEnabled,
  waitForInputValue,
  waitForSettledFetches,
} from "./console-agents-browser-helpers.mjs";
import { resolveConfiguredHarnessId } from "../../packages/occ/src/index.ts";
import { createRuntimeAuthFixture } from "./console-agents-runtime-auth-fixture.mjs";
import {
  createModelCredentialSecret,
  enterManualModel,
  openAdvancedSettings,
  configurationPostRequests,
  routeInstallationWithoutProvisioning,
  agentPostRequests,
  optionValues,
  waitForCreateFormReads,
} from "./console-agents-test-support.mjs";

type ConsoleFixture = Awaited<ReturnType<typeof createBaseConsoleAppFixture>>;
type FixtureResponse<Data> = Omit<Awaited<ReturnType<ConsoleFixture["request"]>>, "data"> & {
  data: Data;
};
type ModelConfiguration = ConfigurationWire & { values: ReturnType<typeof nativeValues> };

async function defaultPresetSummary(fixture: ConsoleFixture, namespaceId: string) {
  const presets: FixtureResponse<PresetSummaryWire[]> = await fixture.request(
    "GET",
    `/namespaces/${namespaceId}/presets`,
  );
  assert.equal(presets.status, 200);
  const starter = presets.data.find((preset) => preset.name === "default-codex");
  assert.ok(starter, "the installed default Preset must be listed");
  return starter;
}

// The Preset list returns summaries; the template comes from the exact Preset (finding 1323).
async function presetTemplate(fixture: ConsoleFixture, namespaceId: string, presetId: string) {
  const preset: FixtureResponse<Preset> = await fixture.request(
    "GET",
    `/namespaces/${namespaceId}/presets/${presetId}`,
  );
  assert.equal(preset.status, 200);
  return preset.data.template;
}

async function createdAgent(response: Promise<BrowserResponse>): Promise<AgentWire> {
  const result = await response;
  assert.equal(result.status(), 201);
  return (await result.json()).data;
}

const defaultCodexPreset: Pick<Preset, "name" | "template"> = JSON.parse(
  await readFile(new URL("../../deploy/presets/default-codex.json", import.meta.url), "utf8"),
);
// The shipped standard template is the input. Each case can edit only its own copy.
const standardCodexPreset: {
  name: string;
  template: {
    variables: Record<string, PresetVariable>;
    agent: {
      harnessAuth:
        | Extract<HarnessAuthBinding, { method: "api_key" | "codex_pat" }>
        | { method: "api_key" | "codex_pat"; secret?: string };
      initialWorkspaceFiles?: Record<string, string>;
    };
  };
} = JSON.parse(
  await readFile(new URL("../../deploy/presets/standard-codex.json", import.meta.url), "utf8"),
);

// Default Presets also select the filesystem Configuration Driver (native value validation).
const createConsoleAppFixture = (
  t: TestContext,
  options: {
    defaultPresets?: (typeof defaultCodexPreset)[];
    filesystemConfiguration?: boolean;
  } = {},
) => createBaseConsoleAppFixture(t, { defaultPresets: [defaultCodexPreset], ...options });

test("Preset string variables preserve multiline defaults, edits and restored drafts", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Multiline Preset strings", { ready: true });
  const lf = "# Notes\n- First instruction\n- Second instruction\n";
  const crlf = lf.replaceAll("\n", "\r\n");
  const scenarios = [
    { name: "LF default", value: lf, expected: lf },
    { name: "CRLF default", value: crlf, expected: crlf },
    {
      name: "LF edit",
      value: lf,
      edit: "Edited first\nEdited second\n",
      expected: "Edited first\nEdited second\n",
    },
    {
      name: "CRLF edit",
      value: crlf,
      edit: "Edited first\r\nEdited second\r\n",
      expected: "Edited first\nEdited second\n",
    },
    { name: "Empty override", value: lf, edit: "", expected: "" },
    { name: "Single-line default", value: "One ordinary line", expected: "One ordinary line" },
    { name: "Unedited restored default", value: crlf, restore: true, expected: crlf },
    {
      name: "Edited restored string",
      value: lf,
      edit: "Retained first\nRetained second\n",
      restore: true,
      expected: "Retained first\nRetained second\n",
    },
  ];
  for (const scenario of scenarios) {
    const template = {
      variables: {
        notes: { type: "string", default: scenario.value },
        debounce: { type: "number", default: 0 },
        controlUi: { type: "boolean", default: false },
        unusedPassword: { type: "password" },
      },
      agent: { initialWorkspaceFiles: { "USER.md": "{{ vars.notes }}" } },
      configuration: {
        values: {
          messages: { responsePrefix: "{{ vars.notes }}" },
          gateway: {
            reload: { debounceMs: "{{ vars.debounce }}" },
            controlUi: { enabled: "{{ vars.controlUi }}" },
          },
        },
      },
    };
    const preset: FixtureResponse<Preset> = await fixture.request(
      "POST",
      `/namespaces/${namespace.id}/presets`,
      {
        body: { name: scenario.name, template },
      },
    );
    assert.equal(preset.status, 201, JSON.stringify(preset.body));
    const { page } = await newPage(t, fixture);
    await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
    const requests = apiRequests(page, fixture.origin);
    await page.getByRole("button", { name: "Create Agent", exact: true }).click();
    await page.getByLabel("Preset template", { exact: true }).selectOption(preset.data.id);
    const notes = page.getByLabel("Notes", { exact: true });
    await notes.waitFor();
    if (scenario.edit !== undefined) {
      await notes.fill(scenario.edit);
      await notes.press("Tab");
    }
    if (scenario.restore) {
      await page.goBack();
      await page.getByRole("button", { name: "Create Agent", exact: true }).waitFor();
      await page.goForward();
      await notes.waitFor();
    }
    // A permitted unreferenced password has no bound Secret selector or saved draft value.
    // Use only a synthetic placeholder; applying the ordinary template creates no credential.
    await page.getByLabel("Unused Password", { exact: true }).fill("synthetic-unused-placeholder");
    await page.getByRole("button", { name: "Use Preset", exact: true }).click();
    await openAdvancedSettings(page);
    const values = JSON.parse(
      await page.getByLabel("Configuration JSON", { exact: true }).inputValue(),
    );
    assert.equal(values.messages.responsePrefix, scenario.expected, scenario.name);
    assert.equal(values.gateway.reload.debounceMs, 0, scenario.name);
    assert.equal(values.gateway.controlUi.enabled, false, scenario.name);
    // Workspace textarea edits follow the existing browser LF contract.
    assert.equal(
      await page.getByLabel("USER.md", { exact: true }).inputValue(),
      scenario.expected.replaceAll("\r\n", "\n").replaceAll("\r", "\n"),
      scenario.name,
    );
    assert.deepEqual(nonAuthWriteRequests(requests), [], scenario.name);
    const stored: FixtureResponse<Preset> = await fixture.request(
      "GET",
      `/namespaces/${namespace.id}/presets/${preset.data.id}`,
    );
    const notesVariable = stored.data.template.variables?.notes;
    assert.equal(notesVariable?.type, "string");
    assert.equal(notesVariable.default, scenario.value, scenario.name);
  }
});

test("Selecting an existing fallback keeps the referenced model catalog deployable", async (t) => {
  for (const fullReferenceIds of [false, true]) {
    const fixture = await createConsoleAppFixture(t);
    await fixture.bootstrap("Model selection");
    const namespace = await fixture.createNamespace("Fallback choices", { ready: true });
    const ids = ["primary-model", "fallback-one", "fallback-two"] as const;
    const reference = (id: string) => `openai/${id}`;
    const values = {
      agents: {
        defaults: {
          model: { primary: reference(ids[0]), fallbacks: ids.slice(1).map(reference) },
          models: Object.fromEntries(
            ids.map((id) => [
              reference(id),
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
              id: fullReferenceIds ? reference(id) : id,
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
    const preset: FixtureResponse<Preset> = await fixture.request(
      "POST",
      `/namespaces/${namespace.id}/presets`,
      {
        body: {
          name: "Fallback models",
          template: { configuration: { values }, agent: { executionMode: "embedded" } },
        },
      },
    );
    assert.equal(preset.status, 201, JSON.stringify(preset.body));
    const { page } = await newPage(t, fixture);
    await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
    await page.getByLabel("Preset template").selectOption(preset.data.id);
    await page.getByRole("button", { name: "Use Preset", exact: true }).click();
    const editor = page.locator("#configuration-json");
    const model = page.getByLabel("Model ID", { exact: true });
    const checkSelection = async (id: string, retained: string[]) => {
      await model.fill(id);
      await model.press("Tab");
      const selected: typeof values = JSON.parse(await editor.inputValue());
      assert.equal(resolveConfiguredHarnessId(selected), "openclaw");
      assert.equal(selected.agents.defaults.model.primary, reference(id));
      assert.deepEqual(selected.agents.defaults.model.fallbacks, ids.slice(1).map(reference));
      assert.deepEqual(
        selected.models.providers.openai.models.map((entry) =>
          entry.id.includes("/") ? entry.id.split("/").slice(1).join("/") : entry.id,
        ),
        retained,
      );
      for (const fallback of ids.slice(1)) {
        assert.deepEqual(
          selected.agents.defaults.models[reference(fallback)],
          values.agents.defaults.models[reference(fallback)],
        );
        assert.deepEqual(
          selected.models.providers.openai.models.find(
            (entry) => entry.id === fallback || entry.id === reference(fallback),
          ),
          values.models.providers.openai.models.find(
            (entry) => entry.id === fallback || entry.id === reference(fallback),
          ),
        );
      }
      const configuration = await fixture.createConfiguration(namespace.id, selected);
      const reread: FixtureResponse<ConfigurationWire> = await fixture.request(
        "GET",
        `/namespaces/${namespace.id}/configurations/${configuration.id}`,
      );
      assert.equal(reread.status, 200);
      assert.deepEqual(reread.data.values, selected);
      assert.equal(resolveConfiguredHarnessId(reread.data.values), "openclaw");
      return selected;
    };
    const selected = await checkSelection(ids[1], ids.slice(1));
    assert.equal(selected.agents.defaults.models[reference(ids[0])], undefined);
    await checkSelection(ids[2], ids.slice(1));
    // Clearing a text input is a temporary editor state, not permission to drop a fallback.
    await model.fill("");
    await model.press("Tab");
    await checkSelection("another-model", [...ids.slice(1), "another-model"]);
    // An unrelated JSON edit during a temporary clear must not orphan the previous primary.
    await model.fill("");
    await model.press("Tab");
    await openAdvancedSettings(page);
    const pending: typeof values = JSON.parse(await editor.inputValue());
    pending.models.providers.openai.baseUrl = "https://edited-models.example.test/v1";
    await editor.fill(JSON.stringify(pending));
    const edited = await checkSelection("json-replacement", [...ids.slice(1), "json-replacement"]);
    assert.equal(edited.models.providers.openai.baseUrl, "https://edited-models.example.test/v1");
  }
});

test("Changing a Preset model keeps explicit and inherited roster selections deployable", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap("Roster model selection");
  const namespace = await fixture.createNamespace("Roster model choices", { ready: true });
  const reference = (id: string) => `openai/${id}`;
  const original = "primary-model";
  const fallback = "fallback-model";
  const replacement = "replacement-model";
  const policy = (alias: string, temperature: number) => ({
    agentRuntime: { id: "openclaw" },
    alias,
    params: { temperature },
  });
  const initialValues = {
    agents: {
      ownership: "explicit",
      defaults: {
        model: { primary: reference(original), fallbacks: [reference(fallback)] },
        models: {
          [reference(original)]: policy("Default primary", 0.2),
          [reference(fallback)]: policy("Default fallback", 0.3),
        },
      },
      entries: {
        main: {
          model: reference(original),
          models: {
            [reference(original)]: policy("Main primary", 0.4),
            [reference(replacement)]: policy("Main replacement", 0.7),
          },
        },
        assistant: {
          model: { primary: reference(original), fallbacks: [reference(fallback)] },
          models: {
            [reference(original)]: policy("Assistant primary", 0.5),
            [reference(fallback)]: policy("Assistant fallback", 0.6),
            [reference(replacement)]: policy("Assistant replacement", 0.8),
          },
          workspace: "/workspace/synthetic-assistant",
        },
        inherited: {
          models: {
            [reference(original)]: policy("Inherited primary", 0.9),
            [reference(fallback)]: policy("Inherited fallback", 1),
          },
        },
      },
    },
    models: {
      providers: {
        openai: {
          baseUrl: "https://models.example.test/v1",
          api: "openai-responses",
          models: [original, fallback].map((id) => ({
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
  const { model: originalModel, ...defaultSettings } = initialValues.agents.defaults;
  for (const shape of ["default-object", "default-string", "no-default"] as const) {
    const values = {
      ...initialValues,
      agents: {
        ...initialValues.agents,
        defaults: {
          ...defaultSettings,
          ...(shape === "no-default"
            ? {}
            : { model: shape === "default-object" ? originalModel : reference(original) }),
        },
        entries: {
          main: initialValues.agents.entries.main,
          assistant: initialValues.agents.entries.assistant,
          // Without a default model, every entry must explicitly select its primary.
          ...(shape === "no-default"
            ? {}
            : {
                inherited: initialValues.agents.entries.inherited,
                inheritedEmpty: { models: {} },
              }),
        },
      },
    };
    // All explicit entries share the primary; an entry without a model inherits it.
    const baseline = await fixture.createConfiguration(namespace.id, values);
    assert.equal(resolveConfiguredHarnessId(baseline.values), "openclaw");
    const preset: FixtureResponse<Preset> = await fixture.request(
      "POST",
      `/namespaces/${namespace.id}/presets`,
      {
        body: {
          name: `Roster models ${shape}`,
          template: { configuration: { values }, agent: { executionMode: "embedded" } },
        },
      },
    );
    assert.equal(preset.status, 201, JSON.stringify(preset.body));
    const { page } = await newPage(t, fixture);
    await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
    await page.getByLabel("Preset template").selectOption(preset.data.id);
    await page.getByRole("button", { name: "Use Preset", exact: true }).click();
    const model = page.getByLabel("Model ID", { exact: true });
    const editor = page.locator("#configuration-json");
    for (const id of [replacement, "another-model"]) {
      t.diagnostic(`Selecting ${shape} roster primary ${id}`);
      if (id !== replacement) {
        // Clearing is a temporary edit: it must not discard explicit or inherited local policy.
        await model.fill("");
        await model.press("Tab");
        const cleared: typeof values = JSON.parse(await editor.inputValue());
        assert.equal(cleared.agents.entries.main.model, reference(replacement));
        // An edit that leaves every selection unchanged keeps the clear pending: the control must
        // not refill from a roster entry while the defaults select no primary (finding 2342).
        await openAdvancedSettings(page);
        await editor.fill(JSON.stringify(cleared));
        assert.equal(await model.inputValue(), "");
        // The kept draft keeps the clear pending: after navigation, the same edit leaves the
        // control empty too. The marker proves the form was rebuilt from the draft.
        await page.locator("#create-agent-form").evaluate((form: HTMLElement) => {
          form.dataset.kept = "";
        });
        // A read that answers differently on return makes the console rebuild the form from the
        // kept draft instead of mounting the retained view again. Repository discovery's fixed
        // composition 503 is one such answer.
        await page.route(`**/namespaces/${namespace.id}/agents/repository-options`, (route) =>
          route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({
              error: {
                code: "REPOSITORY_OPTIONS_UNAVAILABLE",
                message: "Repository options are unavailable.",
              },
            }),
          }),
        );
        await page.getByRole("link", { name: "← Agents" }).click();
        await page.waitForURL(/\/console\/agents(\?|$)/);
        await page.getByRole("button", { name: "Create Agent", exact: true }).click();
        await page.getByLabel("Agent name", { exact: true }).waitFor();
        assert.equal(await page.locator("#create-agent-form[data-kept]").count(), 0);
        await openAdvancedSettings(page);
        await editor.fill(JSON.stringify(cleared));
        assert.equal(await model.inputValue(), "");
        if (values.agents.entries.inherited) {
          assert.deepEqual(cleared.agents.entries.inherited?.models, {
            [reference(replacement)]: values.agents.entries.inherited.models[reference(original)],
            [reference(fallback)]: values.agents.entries.inherited.models[reference(fallback)],
          });
        }
      }
      await model.fill(id);
      await model.press("Tab");
      const selected: typeof values = JSON.parse(await editor.inputValue());
      const configuration = await fixture.createConfiguration(namespace.id, selected);
      const reread: FixtureResponse<ConfigurationWire> = await fixture.request(
        "GET",
        `/namespaces/${namespace.id}/configurations/${configuration.id}`,
      );
      assert.equal(reread.status, 200);
      assert.deepEqual(reread.data.values, selected);
      // Saving the form's output must retain the common primary required by deployment admission.
      assert.equal(resolveConfiguredHarnessId(reread.data.values), "openclaw");
      assert.deepEqual(
        selected.agents.defaults.model,
        shape === "default-object"
          ? { primary: reference(id), fallbacks: [reference(fallback)] }
          : reference(id),
      );
      assert.equal(selected.agents.entries.main.model, reference(id));
      assert.deepEqual(selected.agents.entries.main.models, {
        [reference(id)]: values.agents.entries.main.models[reference(replacement)],
      });
      assert.deepEqual(selected.agents.entries.assistant, {
        ...values.agents.entries.assistant,
        model: { primary: reference(id), fallbacks: [reference(fallback)] },
        models: {
          [reference(id)]: values.agents.entries.assistant.models[reference(replacement)],
          [reference(fallback)]: values.agents.entries.assistant.models[reference(fallback)],
        },
      });
      assert.deepEqual(
        selected.agents.entries.inherited,
        values.agents.entries.inherited
          ? {
              models: {
                [reference(id)]: values.agents.entries.inherited.models[reference(original)],
                [reference(fallback)]: values.agents.entries.inherited.models[reference(fallback)],
              },
            }
          : undefined,
      );
      assert.deepEqual(
        selected.agents.entries.inheritedEmpty,
        shape === "no-default" ? undefined : { models: {} },
      );
      assert.deepEqual(selected.agents.defaults.models, {
        [reference(id)]: values.agents.defaults.models[reference(original)],
        [reference(fallback)]: values.agents.defaults.models[reference(fallback)],
      });
      const provider = selected.models.providers.openai;
      assert.deepEqual(
        provider.models.map((entry) => entry.id),
        [id, fallback],
      );
      assert.deepEqual(provider.models[1], values.models.providers.openai.models[1]);
      assert.equal(provider.baseUrl, values.models.providers.openai.baseUrl);
      assert.equal(provider.api, values.models.providers.openai.api);
    }
  }
});

test("Main-only Preset models create drafts through the regular Agent APIs", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap("Main-only roster creation");
  const namespace = await fixture.createNamespace("Main-only roster", { ready: true });
  const original = "openai/primary-model";
  const replacement = "openai/replacement-model";
  const base = nativeValues("main-only-model", { providerModel: "primary-model" });
  const localPolicy = {
    agentRuntime: { id: "openclaw" },
    alias: "Main model",
    params: { temperature: 0.4 },
  };
  for (const scenario of ["edited-default", "unchanged-entry", "advanced-entry"] as const) {
    const expected = scenario === "unchanged-entry" ? original : replacement;
    t.diagnostic(`Creating ${scenario} main-only draft`);
    const values = {
      ...base,
      agents: {
        ...base.agents,
        defaults:
          scenario !== "edited-default"
            ? { models: base.agents.defaults.models }
            : base.agents.defaults,
        entries: { main: { model: original, models: { [original]: localPolicy } } },
      },
    };
    assert.equal(resolveConfiguredHarnessId(values), "openclaw");
    const template = {
      agent: { name: `Main-only ${scenario}`, executionMode: "embedded" },
      configuration: { values },
    };
    const preset: FixtureResponse<Preset> = await fixture.request(
      "POST",
      `/namespaces/${namespace.id}/presets`,
      { body: { name: `Main-only ${scenario}`, template } },
    );
    assert.equal(preset.status, 201, JSON.stringify(preset.body));
    const { page } = await newPage(t, fixture);
    const requests = apiRequests(page, fixture.origin);
    await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
    await page.getByLabel("Preset template").selectOption(preset.data.id);
    await page.getByRole("button", { name: "Use Preset", exact: true }).click();
    const model = page.getByLabel("Model ID", { exact: true });
    assert.equal(await model.inputValue(), "primary-model");
    if (scenario === "edited-default") {
      await model.fill("replacement-model");
      await model.press("Tab");
    }
    if (scenario === "advanced-entry") {
      await openAdvancedSettings(page);
      // This is a valid entry-only edit: change both the primary and its catalog references.
      await page
        .getByLabel("Configuration JSON", { exact: true })
        .fill(JSON.stringify(values).replaceAll("primary-model", "replacement-model"));
    }
    await createModelCredentialSecret(page, "synthetic-main-only-model-key");
    await waitForCreateFormReads(page);
    const preflight = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents/validate`,
      { timeout: 15_000 },
    );
    const createdResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents`,
      { timeout: 15_000 },
    );
    const outcomes = Promise.all([preflight, createdResponse]);
    await page.getByRole("button", { name: "Create Agent", exact: true }).click();
    const [validation, agentResponse] = await outcomes.catch(async (error) => {
      t.diagnostic(
        `${scenario} visible alerts: ${await page.getByRole("alert").allTextContents()}`,
      );
      t.diagnostic(
        `${scenario} create requests: preflight=${pathRequests(requests, "POST", `/namespaces/${namespace.id}/agents/validate`).length}, configuration=${configurationPostRequests(requests, namespace.id).length}, agent=${agentPostRequests(requests, namespace.id).length}`,
      );
      throw error;
    });
    assert.equal(validation.status(), 204);
    const created = await createdAgent(Promise.resolve(agentResponse));
    assert.equal(created.executionMode, "embedded");
    assert.equal(created.activeRevisionId ?? null, null);
    const saved: FixtureResponse<ConfigurationWire> = await fixture.request(
      "GET",
      `/namespaces/${namespace.id}/configurations/${created.configurationId}`,
    );
    assert.equal(saved.status, 200);
    const persisted = saved.data.values as typeof values;
    assert.equal(
      "model" in persisted.agents.defaults ? persisted.agents.defaults.model : undefined,
      scenario === "edited-default" ? expected : undefined,
    );
    assert.equal(persisted.agents.entries.main.model, expected);
    assert.deepEqual(persisted.agents.entries.main.models, { [expected]: localPolicy });
    assert.equal(resolveConfiguredHarnessId(persisted), "openclaw");
    assert.equal(
      pathRequests(requests, "POST", `/namespaces/${namespace.id}/agents/validate`).length,
      1,
    );
    assert.equal(configurationPostRequests(requests, namespace.id).length, 1);
    assert.equal(agentPostRequests(requests, namespace.id).length, 1);
    // This workflow saves a draft; it does not dispatch a deployment or provisioning job.
    assert.equal(
      pathRequests(requests, "POST", `/namespaces/${namespace.id}/agents/provision`).length,
      0,
    );
    assert.equal(
      pathRequests(requests, "POST", `/namespaces/${namespace.id}/agents/${created.id}/deploy`)
        .length,
      0,
    );
    const unchanged = await presetTemplate(fixture, namespace.id, preset.data.id);
    assert.deepEqual(unchanged, template);
  }
});

test("Model edits preserve refusals for invalid Advanced JSON rosters", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap("Invalid roster editing");
  const namespace = await fixture.createNamespace("Invalid roster drafts", { ready: true });
  const original = "openai/primary-model";
  const replacement = "openai/replacement-model";
  const base = nativeValues("invalid-roster", { providerModel: "primary-model" });
  const values = {
    ...base,
    agents: {
      ...base.agents,
      ownership: "explicit",
      entries: { writer: { model: original }, editor: { model: original } },
    },
  };
  assert.equal(resolveConfiguredHarnessId(values), "openclaw");
  const preset: FixtureResponse<Preset> = await fixture.request(
    "POST",
    `/namespaces/${namespace.id}/presets`,
    {
      body: {
        name: "Invalid roster editing control",
        template: { agent: { executionMode: "embedded" }, configuration: { values } },
      },
    },
  );
  assert.equal(preset.status, 201);
  // Each roster is one the resolver refuses, and the control must leave it that way: divergent
  // primaries, an unqualified primary, one with an empty provider or model, a default that names
  // fallbacks but no primary, and an entry that inherits while no default selects a model.
  const scenarios = [
    "divergent",
    "unqualified",
    "empty provider",
    "empty model",
    "fallbacks without a primary",
    "inherited without a default",
  ] as const;
  for (const scenario of scenarios) {
    for (const clearFirst of [false, true]) {
      await t.test(
        `${scenario}: ${clearFirst ? "clear then select" : "direct select"}`,
        async (subtest) => {
          const { page } = await newPage(subtest, fixture);
          await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
          await page.getByLabel("Preset template").selectOption(preset.data.id);
          await page.getByRole("button", { name: "Use Preset", exact: true }).click();
          await openAdvancedSettings(page);
          const invalid = structuredClone(values);
          if (scenario === "divergent") {
            invalid.agents.entries.editor.model = replacement;
            const provider = invalid.models.providers.openai;
            assert.ok(provider);
            const first = provider.models[0];
            assert.ok(first);
            provider.models.push({ ...first, id: "replacement-model", name: "replacement-model" });
          } else if (scenario === "fallbacks without a primary") {
            (invalid.agents.defaults as { model: unknown }).model = { fallbacks: [original] };
          } else if (scenario === "inherited without a default") {
            delete (invalid.agents.defaults as { model?: unknown }).model;
            delete (invalid.agents.entries.editor as { model?: string }).model;
          } else {
            const primary = {
              unqualified: "bare",
              "empty provider": "/bare",
              "empty model": "bare/",
            }[scenario];
            invalid.agents.defaults.model = primary;
            invalid.agents.entries.writer.model = primary;
            invalid.agents.entries.editor.model = primary;
          }
          const refusal = /same primary model|must name each model as|is required when/;
          assert.throws(() => resolveConfiguredHarnessId(invalid), refusal);
          const editor = page.getByLabel("Configuration JSON", { exact: true });
          await editor.fill(JSON.stringify(invalid));
          const model = page.getByLabel("Model ID", { exact: true });
          if (clearFirst) {
            await model.fill("");
            await model.press("Tab");
          }
          await model.fill("replacement-model");
          await model.press("Tab");
          // A convenience control must not silently repair an invalid roster's explicit selections.
          const edited = JSON.parse(await editor.inputValue());
          assert.throws(() => resolveConfiguredHarnessId(edited), refusal);
        },
      );
    }
  }
});

test("Runtime-auth Presets retain OpenClaw when changing from Anthropic to OpenAI", async (t) => {
  const { fixture, namespace } = await createRuntimeAuthFixture(t, "Runtime Preset providers", {
    defaultPresets: [defaultCodexPreset],
  });
  const primary = "anthropic/claude-runtime-model";
  const base = nativeValues("runtime-preset");
  base.agents.defaults.model = primary;
  base.agents.defaults.models = { [primary]: { agentRuntime: { id: "openclaw" } } };
  const providers = {
    anthropic: {
      baseUrl: "https://api.anthropic.com",
      api: "anthropic-messages",
      models: [{ id: "claude-runtime-model", name: "claude-runtime-model" }],
    },
  };
  const values = { ...base, models: { ...base.models, providers } };
  const preset: FixtureResponse<Preset> = await fixture.request(
    "POST",
    `/namespaces/${namespace.id}/presets`,
    {
      body: {
        name: "Operator-managed credentials",
        template: {
          agent: {
            name: "Runtime provider Agent",
            executionMode: "embedded",
            harnessAuth: { method: "runtime" },
          },
          configuration: { values },
        },
      },
    },
  );
  assert.equal(preset.status, 201);
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByLabel("Preset template").selectOption(preset.data.id);
  await page.getByRole("button", { name: "Use Preset" }).click();
  assert.equal(await page.getByLabel("Provider", { exact: true }).inputValue(), "anthropic");
  await page.getByLabel("Provider", { exact: true }).selectOption("openai");
  // SSH's fixed runtime credential binding requires embedded OpenClaw for either provider.
  assert.equal(await page.getByLabel("Harness", { exact: true }).isDisabled(), true);
  assert.equal(await page.getByLabel("Harness", { exact: true }).inputValue(), "openclaw");
  assert.equal(await page.getByLabel("Execution mode").inputValue(), "embedded");
  await page.getByLabel("Model ID", { exact: true }).fill("gpt-4.1");
  await page.getByLabel("Model ID", { exact: true }).press("Tab");
  const createdResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/namespaces/${namespace.id}/agents`) &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  const created = await createdAgent(createdResponse);
  assert.equal(created.executionMode, "embedded");
  assert.deepEqual(created.harnessAuth, { method: "runtime" });
  const saved: FixtureResponse<ModelConfiguration> = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${created.configurationId}`,
  );
  assert.equal(saved.data.values.agents.defaults.model, "openai/gpt-4.1");
  assert.deepEqual(saved.data.values.agents.defaults.models["openai/gpt-4.1"]?.agentRuntime, {
    id: "openclaw",
  });
  assert.equal(pathRequests(requests, "POST", `/namespaces/${namespace.id}/secrets`).length, 0);
  assert.equal(
    pathRequests(requests, "POST", `/namespaces/${namespace.id}/agents/models`).length,
    0,
  );
});

// The same operator-managed binding on Kubernetes Compute, which takes only an API key for
// embedded OpenClaw. The Installation's capabilities do not say so, so Create Agent asks Agent
// save's preflight with the Preset's runtime binding once they are read, and refuses the Preset
// up front, naming what an operator changes: the form can change neither the binding nor the
// execution mode the refusal names (finding 2427). Without the binding in the preflight, the form
// saved a Configuration that Agent create then refused, and could no longer edit it.
test("Runtime-auth Presets are refused before anything is saved where Compute refuses them", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Runtime Preset refused", { ready: true });
  const preset: FixtureResponse<Preset> = await fixture.request(
    "POST",
    `/namespaces/${namespace.id}/presets`,
    {
      body: {
        name: "Operator-managed credentials",
        template: {
          agent: {
            name: "Runtime Agent",
            executionMode: "embedded",
            harnessAuth: { method: "runtime" },
          },
          configuration: { values: nativeValues("runtime-refused") },
        },
      },
    },
  );
  assert.equal(preset.status, 201);
  const refusal =
    "This Preset's operator-managed credentials need a Compute Driver that supplies them. Agent setting harnessAuth.method must be api_key for embedded OpenClaw on Kubernetes Compute. Ask an administrator to change the Preset's harnessAuth or the Compute Driver, or start without a Preset.";
  const validatePath = `/namespaces/${namespace.id}/agents/validate`;
  const createButton = (page: Page) =>
    page.getByRole("button", { name: "Create Agent", exact: true });
  await t.test("up front", async (t) => {
    const { page } = await newPage(t, fixture);
    const requests = apiRequests(page, fixture.origin);
    await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
    await page.getByLabel("Preset template").selectOption(preset.data.id);
    await page.getByRole("button", { name: "Use Preset" }).click();
    const alert = page.getByRole("alert").filter({ hasText: "operator-managed credentials" });
    await alert.waitFor();
    assert.equal(await alert.textContent(), refusal);
    assert.equal(await createButton(page).isDisabled(), true);
    // The only request is the preflight with the Preset's binding; nothing was saved.
    const checks = pathRequests(requests, "POST", validatePath);
    assert.equal(checks.length, 1);
    assert.deepEqual((checks[0]?.body as { harnessAuth?: unknown }).harnessAuth, {
      method: "runtime",
    });
    assert.equal(configurationPostRequests(requests, namespace.id).length, 0);
    assert.equal(agentPostRequests(requests, namespace.id).length, 0);
  });
  // Create Agent pressed before that answer arrives: its own preflight refuses with the same copy,
  // before any write.
  await t.test("at Create Agent", async (t) => {
    const { page } = await newPage(t, fixture);
    const requests = apiRequests(page, fixture.origin);
    const early = await holdRequests(t, page, `${fixture.origin}${validatePath}`, {
      once: true,
      method: "POST",
    });
    await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
    await page.getByLabel("Preset template").selectOption(preset.data.id);
    await page.getByRole("button", { name: "Use Preset" }).click();
    await early.requested;
    const preflight = page.waitForResponse(
      (response) =>
        response.url() === `${fixture.origin}${validatePath}` &&
        response.request().method() === "POST",
    );
    await createButton(page).click();
    const response = await preflight;
    assert.equal(response.status(), 400);
    assert.deepEqual(response.request().postDataJSON().harnessAuth, { method: "runtime" });
    const { meta } = await response.json();
    const feedback = page.getByRole("alert").filter({ hasText: meta.requestId });
    await feedback.waitFor();
    assert.equal(await feedback.textContent(), `${refusal} Request ID: ${meta.requestId}`);
    assert.equal(configurationPostRequests(requests, namespace.id).length, 0);
    assert.equal(agentPostRequests(requests, namespace.id).length, 0);
    early.release();
    await page.getByRole("button", { name: "Create Agent", disabled: true }).waitFor();
  });
});

test("Create Agent browses the curated plugin catalog without a discovery credential", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const driver = new CodexPluginDriver({ catalogSource: "openai-curated" });
  fixture.controller.registerDriver(driver);
  fixture.controller.selectDriver("plugin", driver.id);
  const namespace = await fixture.createNamespace("Curated plugin browsing", { ready: true });
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);

  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start with default Preset" }).click();
  await page.getByLabel("Harness", { exact: true }).selectOption("codex");
  // Codex serves curated plugins only to ChatGPT logins: the API-key default cannot browse them.
  assert.equal(await page.getByLabel("Authentication method").inputValue(), "api_key");
  await page.getByRole("button", { name: "Configure plugins", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Configure plugins", exact: true });
  await dialog
    .getByText("Codex plugins need a ChatGPT login. With an OpenAI API key", { exact: false })
    .waitFor();
  assert.equal(await dialog.getByRole("button", { name: "Load plugins" }).isDisabled(), true);
  const catalogPath = `/namespaces/${namespace.id}/agents/plugins`;
  assert.deepEqual(pathRequests(requests, "POST", catalogPath), []);
  await dialog.getByRole("button", { name: "Done", exact: true }).click();

  await page.getByLabel("Authentication method").selectOption("codex_pat");
  await page.getByRole("button", { name: "Configure plugins", exact: true }).click();
  const linear = dialog.getByRole("button", { name: "Linear", exact: true });
  await linear.waitFor();
  assert.deepEqual(
    pathRequests(requests, "POST", catalogPath).map(({ body }) => body),
    [{}],
  );
  await linear.click();
  await dialog.getByRole("button", { name: "Add Linear", exact: true }).click();
  assert.deepEqual(JSON.parse(await page.locator("#agent-plugins").inputValue()), {
    "codex-plugin:linear@openai-curated-remote": { enabled: true },
  });
  assert.deepEqual(
    pathRequests(requests, "POST", `${catalogPath}/details`).map(({ body }) => body),
    [{ pluginId: "plugin_asdk_app_69a089a326dc8191b32a3f2553f5be2c" }],
  );
});

test("Create Agent discovers hosted plugins with a transient PAT through the selected Driver", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const driver = new CodexPluginDriver();
  fixture.controller.registerDriver(driver);
  fixture.controller.selectDriver("plugin", driver.id);
  const namespace = await fixture.createNamespace("Hosted plugin discovery", { ready: true });
  const firstSecret = await fixture.createSecret(
    namespace.id,
    "First PAT",
    "at-browser-plugin-one",
  );
  const secondSecret = await fixture.createSecret(
    namespace.id,
    "Second PAT",
    "at-browser-plugin-two",
  );
  const { page } = await newPage(t, fixture);
  const originalFetch = globalThis.fetch;
  const logoUrl = "https://plugin-images.example.test/calendar.png";
  const brokenLogoUrl = "https://plugin-images.example.test/missing.png";
  const imageRequests: { url: string; headers: Record<string, string> }[] = [];
  // The public image host is the only browser request substituted; the real CSP and image loader run.
  await page.route("https://plugin-images.example.test/**", async (route) => {
    imageRequests.push({ url: route.request().url(), headers: await route.request().allHeaders() });
    await route.fulfill(
      route.request().url() === logoUrl
        ? {
            contentType: "image/png",
            body: Buffer.from(
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9foAAAAASUVORK5CYII=",
              "base64",
            ),
          }
        : { status: 404, body: "Image unavailable" },
    );
  });
  let failTools = true;
  const listRelease = Promise.withResolvers<void>();
  const listStarted = Promise.withResolvers<void>();
  let holdList = false;
  let holdPrefetch = true;
  const prefetchRelease = Promise.withResolvers<void>();
  const detailStarted = Promise.withResolvers<void>();
  const detailRelease = Promise.withResolvers<void>();
  const searchStarted = Promise.withResolvers<void>();
  const searchRelease = Promise.withResolvers<void>();
  const hosted = (name: string, overrides: { status?: string; disabled_reason?: string } = {}) => ({
    id: `remote-${name}`,
    name,
    scope: "GLOBAL",
    status: "ENABLED",
    installation_policy: "AVAILABLE",
    release: {
      display_name: name === "calendar" ? "Calendar" : name,
      description: "Hosted plugin",
      interface: {
        short_description: "Hosted tools",
        ...(name === "calendar"
          ? {
              logo_url: logoUrl,
              website_url: "https://calendar.example/",
              privacy_policy_url: "https://calendar.example/privacy",
              terms_of_service_url: "https://calendar.example/terms",
            }
          : {}),
        ...(name === "plugin-0" ? { composer_icon_url: brokenLogoUrl } : {}),
      },
      requires_local_executor: false,
      app_ids: ["app_calendar", "app_shared"],
      skills: [],
      mcp_servers: [],
    },
    ...overrides,
  });
  const upstreamCalls: { path: string; token: string | null }[] = [];
  // Only external HTTP is simulated. Browser, OCC auth/routes, and the selected Driver are real.
  t.mock.method(globalThis, "fetch", async (...[input, options]: Parameters<typeof fetch>) => {
    const url = new URL(input instanceof globalThis.Request ? input.url : input);
    if (!["auth.openai.com", "chatgpt.com"].includes(url.hostname)) {
      return originalFetch(input, options);
    }
    const headers = new Headers(options?.headers);
    const token = headers.get("authorization");
    upstreamCalls.push({ path: url.pathname, token });
    if (url.hostname === "auth.openai.com") {
      return Response.json({
        chatgpt_account_id: "account-plugin-test",
        chatgpt_account_is_fedramp: false,
      });
    }
    assert.equal(headers.get("ChatGPT-Account-ID"), "account-plugin-test");
    assert.equal(headers.get("OAI-Product-Sku"), "codex");
    if (url.pathname.endsWith("/plugins/search")) {
      assert.equal(url.searchParams.get("scope"), "GLOBAL");
      assert.equal(url.searchParams.get("limit"), "20");
      const q = url.searchParams.get("q");
      if (q === "slow") {
        searchStarted.resolve();
        await searchRelease.promise;
        return Response.json({
          plugins: [hosted("Stale-result")],
          pagination: { next_page_token: null },
        });
      }
      assert.equal(q, "linear");
      const cursor = url.searchParams.get("pageToken");
      assert.ok(cursor === null || cursor === "linear-page-two");
      return Response.json({
        plugins: [hosted(cursor ? "Linear-tools" : "Linear")],
        pagination: { next_page_token: cursor ? null : "linear-page-two" },
      });
    }
    if (url.pathname.endsWith("/plugins/list")) {
      assert.equal(url.searchParams.get("scope"), "GLOBAL");
      if (holdPrefetch) {
        holdPrefetch = false;
        await prefetchRelease.promise;
      }
      if (holdList && token === "Bearer at-browser-plugin-one") {
        listStarted.resolve();
        await listRelease.promise;
      }
      if (token === "Bearer at-browser-plugin-two") {
        return Response.json({
          plugins: [hosted("New-account-plugin")],
          pagination: { next_page_token: null },
        });
      }
      return Response.json({
        plugins: url.searchParams.has("pageToken")
          ? [hosted("Documents")]
          : [
              hosted("Admin-disabled", {
                status: "DISABLED_BY_ADMIN",
                disabled_reason: "disabled_by_admin",
              }),
              hosted("calendar"),
              ...Array.from({ length: 18 }, (_, index) => hosted(`plugin-${index}`)),
            ],
        pagination: { next_page_token: url.searchParams.has("pageToken") ? null : "page-two" },
      });
    }
    if (url.pathname.endsWith("/plugins/remote-Admin-disabled")) {
      return Response.json(
        hosted("Admin-disabled", {
          status: "DISABLED_BY_ADMIN",
          disabled_reason: "disabled_by_admin",
        }),
      );
    }
    if (url.pathname.endsWith("/plugins/remote-calendar")) {
      if (failTools) {
        detailStarted.resolve();
        await detailRelease.promise;
      }
      return Response.json(hosted("calendar"));
    }
    assert.equal(url.pathname, "/backend-api/ps/apps/batch");
    assert.ok(
      typeof options?.body === "string",
      "the batch body must contain the requested app IDs",
    );
    assert.deepEqual(JSON.parse(options.body), {
      app_ids: ["app_calendar", "app_shared"],
      include_tools: true,
    });
    if (failTools) {
      return new Response("private upstream response and token must not reach browser", {
        status: 403,
      });
    }
    return Response.json({
      apps: ["app_calendar", "app_shared"].map((id) => ({
        id,
        status: "ENABLED",
        tools: [
          {
            name: "events/list",
            title: "List events",
            description: "Read events",
            is_enabled: true,
            is_read_only: true,
          },
        ],
      })),
    });
  });
  t.after(() => prefetchRelease.resolve());
  t.after(() => listRelease.resolve());
  t.after(() => detailRelease.resolve());
  t.after(() => searchRelease.resolve());
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start with default Preset" }).click();
  await page.getByLabel("Authentication method", { exact: true }).selectOption("codex_pat");
  await page.locator("#plugin-discovery-token > summary").click();
  const token = page.getByLabel("Token for plugin discovery", { exact: true });
  const prefetched = page.waitForRequest(
    (request) =>
      request.url().endsWith("/agents/plugins") &&
      request.postDataJSON()?.accessToken === "at-browser-plugin-one",
  );
  await token.fill("at-browser-plugin-one");
  await prefetched;
  const dialog = page.getByRole("dialog", { name: "Configure plugins", exact: true });
  assert.equal(await dialog.isVisible(), false);
  const brokenImageRequest = page.waitForRequest(brokenLogoUrl);
  await page.getByRole("button", { name: "Configure plugins", exact: true }).click();
  await dialog.getByRole("status").filter({ hasText: "Loading available plugins…" }).waitFor();
  prefetchRelease.resolve();
  async function closePluginDialog() {
    // The close handler restores focus; wait for it before using another credential control.
    const closed = dialog.evaluate(
      (node) => new Promise((resolve) => node.addEventListener("close", resolve, { once: true })),
    );
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    await closed;
  }
  const calendar = dialog.getByRole("button", { name: "Calendar", exact: true });
  await calendar.waitFor();
  // Opening during prefetch shares its request instead of starting another first-page read.
  assert.deepEqual(
    pathRequests(requests, "POST", `/namespaces/${namespace.id}/agents/plugins`).map(
      ({ body }) => body,
    ),
    [{ accessToken: "at-browser-plugin-one" }],
  );
  const setup = dialog.locator(".plugin-access-help");
  // Mobile browsing keeps pagination reachable while full setup guidance remains available by keyboard.
  const nextPage = dialog.getByRole("button", { name: "Next page", exact: true });
  for (const height of [844, 640]) {
    await page.setViewportSize({ width: 390, height });
    assert.equal(
      await nextPage.evaluate((node) => {
        const bounds = node.getBoundingClientRect();
        const target = node.ownerDocument.elementFromPoint(
          bounds.x + bounds.width / 2,
          bounds.y + bounds.height / 2,
        );
        return node.contains(target);
      }),
      true,
      "Catalog pagination must be reachable without scrolling the whole dialog",
    );
  }
  const boundary = setup.getByText(
    "Catalog availability does not verify app connections or grant access. Configure credentials and app access before deployment.",
    { exact: true },
  );
  await boundary.waitFor();
  assert.equal(await setup.getByText(/Service accounts/).isVisible(), false);
  const setupDisclosure = setup.locator("summary");
  await setupDisclosure.focus();
  await setupDisclosure.press("Enter");
  await setup.getByText(/Service accounts/).waitFor();
  assert.match(await setup.innerText(), /App connection status is not verified/);
  for (const [name, href] of [
    ["Manage workspace plugins", "https://chatgpt.com/admin/plugins?catalog=GLOBAL"],
    ["Service account credentials", "https://admin.openai.com/"],
    [
      "OCE plugin setup",
      "https://github.com/openclaw/openclaw-enterprise/blob/main/docs/reference/drivers/plugin-bundled.md#selection-and-catalogs",
    ],
  ] as const) {
    const link = setup.getByRole("link", { name, exact: true });
    assert.equal(await link.getAttribute("href"), href);
    assert.equal(await link.getAttribute("target"), "_blank");
    assert.equal(await link.getAttribute("rel"), "noopener noreferrer");
  }
  // Expanded instructions leave a short browser region; wheel scrolling still reaches its actions.
  const pluginBrowser = dialog.locator(".plugin-browser");
  await pluginBrowser.hover();
  await page.mouse.wheel(0, 320);
  await page.waitForFunction((node) => node.scrollTop > 0, await pluginBrowser.elementHandle());
  assert.equal(
    await nextPage.evaluate((node) => {
      const bounds = node.getBoundingClientRect();
      const target = node.ownerDocument.elementFromPoint(
        bounds.x + bounds.width / 2,
        bounds.y + bounds.height / 2,
      );
      return node.contains(target);
    }),
    true,
    "Catalog pagination must remain reachable with setup instructions expanded",
  );
  await setupDisclosure.press("Enter");
  await setup.getByRole("link", { name: "Service account credentials", exact: true }).waitFor({
    state: "hidden",
  });
  await boundary.waitFor();
  await page.setViewportSize({ width: 1280, height: 720 });
  // Unavailable guidance stays out of the row layout and is reachable without opening details.
  const unavailableRow = dialog.locator(".plugin-list-row").filter({
    has: page.getByRole("button", { name: "Admin-disabled", exact: true }),
  });
  const rowReason = unavailableRow.locator(".plugin-unavailable");
  assert.equal(await rowReason.isVisible(), false);
  const rowPopover = unavailableRow.locator(".plugin-unavailable-popover");
  const unavailableHelp = unavailableRow.getByRole("button", {
    name: "Why Admin-disabled is unavailable",
    exact: true,
  });
  const rowHeight = await unavailableRow.evaluate((node) => node.getBoundingClientRect().height);
  await unavailableHelp.focus();
  await unavailableHelp.press("Enter");
  await rowPopover.waitFor({ state: "visible" });
  assert.equal(
    await unavailableRow.evaluate((node) => node.getBoundingClientRect().height),
    rowHeight,
  );
  assert.match(await rowReason.innerText(), /Disabled by a ChatGPT workspace administrator/);
  const rowHelp = unavailableRow.getByRole("link", {
    name: "Manage workspace plugins",
    exact: true,
  });
  assert.equal(
    await rowHelp.getAttribute("href"),
    "https://chatgpt.com/admin/plugins?catalog=GLOBAL",
  );
  assert.equal(await rowHelp.getAttribute("target"), "_blank");
  assert.equal(await rowHelp.getAttribute("rel"), "noopener noreferrer");
  assert.equal(await rowHelp.evaluate((node) => node.closest("button") === null), true);
  await page.keyboard.press("Tab");
  assert.equal(await rowHelp.evaluate((node) => node === node.ownerDocument.activeElement), true);
  await page.keyboard.press("Escape");
  await rowPopover.waitFor({ state: "hidden" });
  assert.equal(await dialog.isVisible(), true);
  assert.equal(
    await unavailableHelp.evaluate((node) => node === node.ownerDocument.activeElement),
    true,
  );
  await unavailableHelp.click();
  await rowPopover.waitFor({ state: "visible" });
  await dialog.getByRole("heading", { name: "Configure plugins", exact: true }).click();
  await rowPopover.waitFor({ state: "hidden" });
  assert.equal(await dialog.isVisible(), true);
  const listLogo = calendar.locator(".plugin-logo img");
  await listLogo.evaluate((image: HTMLImageElement) => image.decode());
  assert.ok(await listLogo.evaluate((image: HTMLImageElement) => image.naturalWidth > 0));
  assert.equal(await listLogo.getAttribute("alt"), "");
  assert.equal(await listLogo.getAttribute("referrerpolicy"), "no-referrer");
  const missingLogo = dialog
    .getByRole("button", { name: "plugin-1", exact: true })
    .locator(".plugin-logo");
  assert.equal(await missingLogo.locator("img").count(), 0);
  assert.equal(await missingLogo.textContent(), "P");
  const brokenLogo = dialog
    .getByRole("button", { name: "plugin-0", exact: true })
    .locator(".plugin-logo");
  await brokenLogo.scrollIntoViewIfNeeded();
  await brokenImageRequest;
  await brokenLogo.locator("img").waitFor({ state: "detached" });
  assert.equal(await brokenLogo.textContent(), "P");
  assert.equal(
    await calendar.evaluate(
      (node, unavailable) =>
        Boolean(
          node.compareDocumentPosition(unavailable) & globalThis.Node.DOCUMENT_POSITION_FOLLOWING,
        ),
      await dialog.getByRole("button", { name: "Admin-disabled", exact: true }).elementHandle(),
    ),
    true,
  );

  const unavailableDetails = page.waitForResponse((response) =>
    response.url().endsWith("/agents/plugins/details"),
  );
  await unavailableRow.getByRole("button", { name: "Admin-disabled", exact: true }).click();
  await unavailableDetails;
  const disabledDetail = dialog.locator(".plugin-detail");
  assert.match(
    await disabledDetail.locator(".plugin-unavailable").innerText(),
    /Disabled by a ChatGPT workspace administrator/,
  );
  assert.equal(
    await disabledDetail
      .getByRole("link", { name: "Manage workspace plugins", exact: true })
      .getAttribute("href"),
    "https://chatgpt.com/admin/plugins?catalog=GLOBAL",
  );

  // Each navigation fetches a server page and replaces the available list.
  await dialog.getByRole("button", { name: "Next page", exact: true }).click();
  await dialog.getByRole("button", { name: "Documents", exact: true }).waitFor();
  assert.equal(await calendar.count(), 0);
  const search = dialog.getByLabel("Search plugins", { exact: true });
  await page.clock.install({ time: new Date("2026-09-27T12:00:00Z") });
  await page.clock.pauseAt(new Date("2026-09-27T12:00:01Z"));
  const catalogRequests = () =>
    requests.filter((request) => request.path.endsWith("/agents/plugins"));
  const beforeTyping = catalogRequests().length;
  // Typing coalesces into one catalog search 300 ms after the last edit, without the old cursor.
  await search.fill("lin");
  await dialog.getByRole("status").filter({ hasText: "Searching plugins…" }).waitFor();
  assert.equal(
    await dialog
      .getByText(
        /^(No plugins were returned\.|Load plugins to browse available choices\.|To add a plugin by ID, choose Done and edit Plugin selections JSON\.)$/,
      )
      .count(),
    0,
  );
  await page.clock.runFor(200);
  await search.fill("linear");
  await page.clock.runFor(299);
  assert.equal(catalogRequests().length, beforeTyping);
  await page.clock.runFor(1);
  await dialog.getByRole("button", { name: "Linear", exact: true }).waitFor();
  assert.deepEqual(
    catalogRequests()
      .slice(beforeTyping)
      .map((request) => request.body),
    [{ accessToken: "at-browser-plugin-one", q: "linear" }],
  );
  assert.equal(
    await dialog.getByRole("button", { name: "Previous page", exact: true }).isDisabled(),
    true,
  );
  await dialog.getByRole("button", { name: "Next page", exact: true }).click();
  await dialog.getByRole("button", { name: "Linear-tools", exact: true }).waitFor();
  assert.equal(await search.inputValue(), "linear");
  await dialog.getByRole("button", { name: "Previous page", exact: true }).click();
  await dialog.getByRole("button", { name: "Linear", exact: true }).waitFor();
  // An older request is canceled as soon as input changes, including during the debounce window.
  const staleSearchCanceled = page.waitForEvent("requestfailed", {
    predicate: (request) =>
      request.url().endsWith("/agents/plugins") && request.postDataJSON()?.q === "slow",
  });
  await search.fill("slow");
  await page.clock.runFor(300);
  await searchStarted.promise;
  await dialog.getByRole("status").filter({ hasText: "Searching plugins…" }).waitFor();
  assert.equal(
    await dialog
      .getByText(
        /^(No plugins were returned\.|Load plugins to browse available choices\.|To add a plugin by ID, choose Done and edit Plugin selections JSON\.)$/,
      )
      .count(),
    0,
  );
  await search.fill("linear");
  await staleSearchCanceled;
  searchRelease.resolve();
  const beforeReplacement = catalogRequests().length;
  await page.clock.runFor(299);
  assert.equal(catalogRequests().length, beforeReplacement);
  assert.equal(await dialog.getByRole("button", { name: "Stale-result", exact: true }).count(), 0);
  await page.clock.runFor(1);
  await dialog.getByRole("button", { name: "Linear", exact: true }).waitFor();
  // Enter bypasses the delay; it also cancels the scheduled request instead of duplicating it.
  await search.fill("");
  await search.press("Enter");
  await calendar.waitFor();
  const afterEnter = catalogRequests().length;
  await page.clock.runFor(300);
  assert.equal(catalogRequests().length, afterEnter);
  assert.equal(
    await dialog.getByRole("button", { name: "Previous page", exact: true }).isDisabled(),
    true,
  );

  // Selecting a plugin loads its tools; a rejected upstream body stays private and is retryable.
  await calendar.click();
  await detailStarted.promise;
  await dialog.getByRole("status").filter({ hasText: "Loading tools…" }).waitFor();
  assert.equal(await dialog.getByText(/^Tool list unavailable\./).count(), 0);
  assert.equal(
    await dialog.getByText("Load tools to check this plugin before selecting it.").count(),
    0,
  );
  const heading = dialog.getByRole("heading", { name: "Calendar", exact: true });
  // Loading and completion replace the detail pane without losing the keyboard entry point.
  try {
    assert.equal(await heading.evaluate((node) => node === node.ownerDocument.activeElement), true);
  } finally {
    detailRelease.resolve();
  }
  await dialog.getByText(/credential was rejected or cannot access plugins/).waitFor();
  assert.equal(await heading.evaluate((node) => node === node.ownerDocument.activeElement), true);
  assert.equal((await dialog.textContent())?.includes("private upstream response"), false);
  failTools = false;
  await dialog.getByRole("button", { name: "Retry tools for Calendar", exact: true }).click();
  await dialog.locator('details.plugin-tool-row[data-tool="app_calendar/events%2Flist"]').waitFor();
  assert.equal(
    await dialog.locator('details.plugin-tool-row[data-tool="app_shared/events%2Flist"]').count(),
    1,
  );
  assert.equal(
    await dialog.getByText(/credential was rejected or cannot access plugins/).count(),
    0,
  );
  const detailLogo = dialog.locator(".plugin-detail-header .plugin-logo img");
  await detailLogo.evaluate((image: HTMLImageElement) => image.decode());
  assert.ok(await detailLogo.evaluate((image: HTMLImageElement) => image.naturalWidth > 0));
  assert.equal(await detailLogo.getAttribute("alt"), "");
  assert.equal(await detailLogo.getAttribute("referrerpolicy"), "no-referrer");
  for (const [name, href] of [
    ["Website", "https://calendar.example/"],
    ["Privacy policy", "https://calendar.example/privacy"],
    ["Terms of service", "https://calendar.example/terms"],
  ] as const) {
    const link = dialog.getByRole("link", { name, exact: true });
    assert.equal(await link.getAttribute("href"), href);
    assert.equal(await link.getAttribute("target"), "_blank");
    assert.equal(await link.getAttribute("rel"), "noopener noreferrer");
  }
  await dialog.getByRole("button", { name: "Add Calendar", exact: true }).click();
  const selected = { "codex-plugin:calendar@openai-curated-remote": { enabled: true } };
  assert.deepEqual(JSON.parse(await page.locator("#agent-plugins").inputValue()), selected);
  await dialog.getByRole("button", { name: "Configured plugins", exact: true }).click();
  await dialog.getByRole("button", { name: "Calendar", exact: true }).waitFor();
  const beforeLocalFilter = catalogRequests().length;
  const configuredSearch = dialog.getByLabel("Filter configured plugins", { exact: true });
  await configuredSearch.fill("missing");
  assert.equal(await calendar.count(), 0);
  await configuredSearch.fill("cal");
  await calendar.waitFor();
  await page.clock.runFor(300);
  assert.equal(catalogRequests().length, beforeLocalFilter);
  await dialog.getByRole("button", { name: "Available plugins", exact: true }).click();
  // Closing the picker drops a scheduled search; reopening explicitly loads the retained query.
  await search.fill("linear");
  await closePluginDialog();
  await page.clock.runFor(300);
  assert.equal(catalogRequests().length, beforeLocalFilter);
  const reminder = page.locator(".plugin-setup-reminder");
  assert.equal(await reminder.isVisible(), true);
  await reminder
    .getByText("Check plugin access and credentials before deployment", { exact: true })
    .click();
  await reminder.getByText(/App connection status is not verified/).waitFor();
  assert.equal(
    await reminder
      .getByRole("link", { name: "Service account credentials", exact: true })
      .getAttribute("href"),
    "https://admin.openai.com/",
  );
  assert.deepEqual(JSON.parse(await page.locator("#agent-plugins").inputValue()), selected);
  await page.getByRole("button", { name: "Configure plugins", exact: true }).click();
  await dialog.getByRole("button", { name: "Linear", exact: true }).waitFor();
  await search.fill("");
  await search.press("Enter");
  await calendar.waitFor();

  // A credential edit cancels background discovery; explicit plugin selections survive.
  await closePluginDialog();
  await token.fill("");
  const clearedSetup = page.locator(".plugin-access-help");
  await clearedSetup.locator("a").first().waitFor({ state: "detached" });
  assert.equal(await clearedSetup.locator("a").count(), 0);
  assert.equal(await clearedSetup.isVisible(), false);
  assert.equal(
    (await clearedSetup.locator(".plugin-access-instructions").textContent())?.trim(),
    "",
  );
  assert.equal(await reminder.isVisible(), false);
  assert.equal(await reminder.locator("a").count(), 0);
  assert.deepEqual(JSON.parse(await page.locator("#agent-plugins").inputValue()), selected);
  holdList = true;
  const stalePrefetchCanceled = page.waitForEvent("requestfailed", {
    predicate: (request) =>
      request.url().endsWith("/agents/plugins") &&
      request.postDataJSON()?.accessToken === "at-browser-plugin-one",
  });
  await token.fill("at-browser-plugin-one");
  await page.clock.runFor(300);
  await listStarted.promise;
  assert.equal(await dialog.isVisible(), false);
  await token.fill("at-browser-plugin-two");
  await stalePrefetchCanceled;
  await page.getByRole("button", { name: "Configure plugins", exact: true }).click();
  await page.clock.runFor(300);
  await dialog.getByRole("button", { name: "New-account-plugin", exact: true }).waitFor();
  listRelease.resolve();
  await dialog.getByRole("button", { name: "New-account-plugin", exact: true }).waitFor();
  assert.equal(await calendar.count(), 0);
  assert.deepEqual(JSON.parse(await page.locator("#agent-plugins").inputValue()), selected);
  await closePluginDialog();
  assert.equal(await dialog.isVisible(), false);
  // Selecting a saved PAT sends only its reference to OCC for both list and detail reads.
  holdList = false;
  await token.fill("");
  const selectedPrefetch = page.waitForResponse(
    (response) =>
      response.url().endsWith("/agents/plugins") &&
      response.request().postDataJSON()?.secretRef?.id === firstSecret.ref.id,
  );
  await selectSecret(page, "Service account token Secret", firstSecret);
  await page.clock.runFor(300);
  assert.equal((await selectedPrefetch).status(), 200);
  assert.equal(await dialog.isVisible(), false);
  await page.getByRole("button", { name: "Configure plugins", exact: true }).click();
  await calendar.waitFor();
  await calendar.click();
  await dialog.locator('details.plugin-tool-row[data-tool="app_calendar/events%2Flist"]').waitFor();
  const selectedRequests = requests.filter(
    (request) =>
      request.path.endsWith("/agents/plugins") || request.path.endsWith("/agents/plugins/details"),
  );
  assert.deepEqual(selectedRequests.at(-2)?.body, { secretRef: firstSecret.ref });
  assert.deepEqual(selectedRequests.at(-1)?.body, {
    secretRef: firstSecret.ref,
    pluginId: "remote-calendar",
  });
  assert.doesNotMatch(JSON.stringify(selectedRequests.at(-2)?.body), /at-browser-plugin/);
  await closePluginDialog();

  // Switching the saved Secret discards the previous account's catalog and reloads with the new one.
  await selectSecret(page, "Service account token Secret", secondSecret);
  await page.getByRole("button", { name: "Configure plugins", exact: true }).click();
  await page.clock.runFor(300);
  await dialog.getByRole("button", { name: "New-account-plugin", exact: true }).waitFor();
  assert.equal(await calendar.count(), 0);
  assert.deepEqual(
    requests.filter((request) => request.path.endsWith("/agents/plugins")).at(-1)?.body,
    { secretRef: secondSecret.ref },
  );
  await closePluginDialog();
  assert.equal(
    upstreamCalls.some((call) => call.token === "Bearer at-browser-plugin-two"),
    true,
  );
  assert.equal(
    requests.some((request) => /at-browser-plugin/.test(request.path)),
    false,
  );
  assert.ok(imageRequests.some((request) => request.url === logoUrl));
  assert.ok(imageRequests.some((request) => request.url === brokenLogoUrl));
  for (const { headers } of imageRequests) {
    for (const name of ["authorization", "referer", "chatgpt-account-id", "oai-product-sku"]) {
      assert.equal(headers[name], undefined);
    }
  }
  assert.doesNotMatch(JSON.stringify(imageRequests), /at-browser-plugin|account-plugin-test/);
  assert.equal(secretPostRequests(requests, namespace.id).length, 0);
  assert.equal(configurationPostRequests(requests, namespace.id).length, 0);
  assert.equal(agentPostRequests(requests, namespace.id).length, 0);
  assert.equal(
    await page.evaluate(() =>
      JSON.stringify({ ...localStorage, ...sessionStorage }).includes("at-browser-plugin"),
    ),
    false,
  );
});

test("Agent creation edits Preset plugin policies through the modal and persists inherited fields independently", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const pluginDriver = new CodexPluginDriver();
  fixture.controller.registerDriver(pluginDriver);
  fixture.controller.selectDriver("plugin", pluginDriver.id);
  const namespace = await fixture.createNamespace("Plugin policy authoring", { ready: true });
  const secret = await fixture.createSecret(namespace.id, "Model key", "preset-plugin-model-key");
  const pluginId = "codex-plugin:knowledge@openai-curated-remote";
  const removedPluginId = "codex-plugin:diffs@openai-curated-remote";
  const plugins = {
    [pluginId]: {
      enabled: false,
      toolDefaults: { enabled: true, approval: "provider_default", reviewer: "human" },
      tools: {
        "app_knowledge/search": { enabled: false, approval: "provider_default" },
        "app_knowledge/summarize": { enabled: true, approval: "none" },
        "app_knowledge/unknown-tool": { approval: "provider_default" },
      },
    },
    [removedPluginId]: { enabled: true },
  };
  const preset: FixtureResponse<Preset> = await fixture.request(
    "POST",
    `/namespaces/${namespace.id}/presets`,
    {
      body: {
        name: "Plugin policies",
        template: {
          agent: {
            name: "Plugin policy Agent",
            executionMode: "dedicated",
            harnessAuth: { method: "api_key", source: secret.ref },
            plugins,
          },
          configuration: { values: nativeValues("plugin-policies", { harnessId: "codex" }) },
        },
      },
    },
  );
  assert.equal(preset.status, 201, JSON.stringify(preset.body));
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByLabel("Preset template").selectOption(preset.data.id);
  await page.getByRole("button", { name: "Use Preset" }).click();
  await page.locator("summary").filter({ hasText: "Plugin selections JSON" }).click();
  const json = page.getByLabel("Plugin selections JSON", { exact: true });
  assert.deepEqual(JSON.parse(await json.inputValue()), plugins);

  // Invalid manual input remains recoverable and cannot submit a different policy.
  requests.length = 0;
  await json.fill("{");
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  assert.equal(await json.inputValue(), "{");
  assert.notEqual(await json.evaluate((node: HTMLTextAreaElement) => node.validationMessage), "");
  assert.deepEqual(nonAuthWriteRequests(requests), []);
  await json.fill(JSON.stringify(plugins));
  await page.getByRole("button", { name: "Configure plugins", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Configure plugins", exact: true });
  await dialog.getByRole("button", { name: "Configured plugins", exact: true }).click();
  await dialog.getByRole("button", { name: pluginId, exact: true }).click();
  const searchTool = dialog.locator('details.plugin-tool-row[data-tool="app_knowledge/search"]');
  await searchTool.locator("summary").click();
  const pluginEnabled = dialog.getByLabel(`Enable ${pluginId}`, { exact: true });
  const toolEnabled = dialog.getByLabel("Enable app_knowledge/search", { exact: true });
  const toolApproval = dialog.getByLabel("app_knowledge/search require approval for", {
    exact: true,
  });
  const toolToggle = dialog.getByLabel("app_knowledge/search enabled override", { exact: true });
  assert.equal(await toolToggle.isDisabled(), true);
  assert.equal(await toolEnabled.isDisabled(), true);
  assert.equal(await toolApproval.isDisabled(), true);
  await pluginEnabled.check();
  await dialog.getByLabel(`${pluginId} tools enabled by default`, { exact: true }).selectOption("");
  assert.deepEqual(JSON.parse(await json.inputValue())[pluginId].toolDefaults, {
    approval: "provider_default",
    reviewer: "human",
  });
  const reviewer = dialog.getByLabel(`${pluginId} default reviewer`, { exact: true });
  assert.deepEqual(
    (await optionValues(reviewer)).map(({ value }) => value),
    ["", "human", "auto"],
  );
  await reviewer.selectOption("");
  assert.deepEqual(JSON.parse(await json.inputValue())[pluginId].toolDefaults, {
    approval: "provider_default",
  });
  await reviewer.selectOption("auto");
  const defaultApproval = dialog.getByLabel(`${pluginId} require approval for`, { exact: true });
  assert.deepEqual(
    (await optionValues(defaultApproval)).map(({ value }) => value),
    ["", "provider_default", "all_actions", "write_actions", "none"],
  );
  await defaultApproval.selectOption("write_actions");

  // Codex advertises plugin-wide reviewers only; tool approval still inherits independently.
  const toolReviewer = dialog.getByLabel("app_knowledge/search reviewer", { exact: true });
  assert.equal(await toolReviewer.count(), 0);
  await searchTool.getByRole("button", { name: "Set reviewer for all tools" }).click();
  assert.equal(await reviewer.evaluate((node) => node === node.ownerDocument.activeElement), true);
  await toolApproval.selectOption("none");
  await toolEnabled.selectOption("");
  assert.deepEqual(JSON.parse(await json.inputValue())[pluginId].tools["app_knowledge/search"], {
    approval: "none",
  });
  // The summary toggle edits only enablement; an omitted override remains visibly inherited.
  await searchTool.locator("summary").click();
  assert.equal(await toolToggle.evaluate((node: HTMLInputElement) => node.indeterminate), true);
  await toolToggle.click();
  assert.deepEqual(JSON.parse(await json.inputValue())[pluginId].tools["app_knowledge/search"], {
    approval: "none",
    enabled: true,
  });
  assert.equal(await searchTool.evaluate((node: HTMLDetailsElement) => node.open), false);
  await toolToggle.click();
  assert.deepEqual(JSON.parse(await json.inputValue())[pluginId].tools["app_knowledge/search"], {
    approval: "none",
    enabled: false,
  });
  await searchTool.locator("summary").click();
  await toolEnabled.selectOption("");
  assert.equal(await toolToggle.evaluate((node: HTMLInputElement) => node.indeterminate), true);
  await toolToggle.click();
  await toolApproval.selectOption("");
  await dialog
    .locator('details.plugin-tool-row[data-tool="app_knowledge/summarize"] > summary')
    .click();
  await dialog.getByLabel("Enable app_knowledge/summarize", { exact: true }).selectOption("");
  await dialog
    .getByLabel("app_knowledge/summarize require approval for", { exact: true })
    .selectOption("");
  const expected = {
    [pluginId]: {
      enabled: true,
      toolDefaults: { approval: "write_actions", reviewer: "auto" },
      tools: {
        "app_knowledge/search": { enabled: true },
        "app_knowledge/unknown-tool": { approval: "provider_default" },
      },
    },
  };
  await pluginEnabled.uncheck();
  assert.equal(await toolToggle.isDisabled(), true);
  assert.equal(await toolEnabled.isDisabled(), true);
  assert.equal(await toolApproval.isDisabled(), true);
  assert.deepEqual(JSON.parse(await json.inputValue())[pluginId], {
    ...expected[pluginId],
    enabled: false,
  });
  await pluginEnabled.check();
  await dialog.getByRole("button", { name: removedPluginId, exact: true }).click();
  await dialog.getByRole("button", { name: `Remove ${removedPluginId}`, exact: true }).click();
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  assert.equal(await dialog.isVisible(), false);
  assert.deepEqual(JSON.parse(await json.inputValue()), expected);

  const createdResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  const created = await createdAgent(createdResponse);
  const saved: FixtureResponse<AgentWire> = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${created.id}`,
  );
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.data.plugins, expected);
});

test("Plugin approval choices explain unsupported provider modes and preserve the draft until corrected", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const driver = new OCCPluginDriver();
  fixture.controller.registerDriver(driver);
  fixture.controller.selectDriver("plugin", driver.id);
  const namespace = await fixture.createNamespace("Unsupported plugin approvals", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Native plugin Agent",
    nativeValues("policy"),
  );
  const { page } = await newPage(t, fixture);
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "plugins");
  await login(page, fixture, url);
  const json = page.locator("#agent-plugins");
  await page.locator("summary").filter({ hasText: "Plugin selections JSON" }).click();
  // A copied policy from another provider remains visible so the operator can correct it.
  const plugins = {
    "occ-plugin:diffs": { enabled: true, toolDefaults: { approval: "write_actions" } },
  };
  await json.fill(JSON.stringify(plugins));
  await page.getByRole("button", { name: "Configure plugins", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Configure plugins", exact: true });
  await dialog.getByRole("button", { name: "Configured plugins", exact: true }).click();
  await dialog.getByRole("button", { name: "occ-plugin:diffs", exact: true }).click();
  const approval = dialog.getByLabel("occ-plugin:diffs require approval for", { exact: true });
  // Every mode stays disabled until the provider's capabilities load; the hint shows they have.
  await dialog
    .getByText("This plugin provider does not support: Every action, Write actions.", {
      exact: true,
    })
    .waitFor();
  assert.equal(await approval.inputValue(), "write_actions");
  assert.deepEqual(
    await approval
      .locator("option")
      .evaluateAll((options: HTMLOptionElement[]) =>
        options.map(({ value, disabled }) => [value, disabled]),
      ),
    [
      ["", false],
      ["provider_default", false],
      ["all_actions", true],
      ["write_actions", true],
      ["none", false],
    ],
  );
  assert.equal(
    await approval.locator("option:checked").textContent(),
    "Write actions (unsupported)",
  );
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  assert.deepEqual(JSON.parse(await json.inputValue()), plugins);
  await page.getByRole("button", { name: "Configure plugins", exact: true }).click();
  await approval.selectOption("provider_default");
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  const savedResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" && response.url().endsWith(`/agents/${agent.id}`),
  );
  await page.getByRole("button", { name: "Save plugin selections", exact: true }).click();
  assert.equal((await savedResponse).status(), 200);
  const saved: FixtureResponse<AgentWire> = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${agent.id}`,
  );
  assert.deepEqual(saved.data.plugins, {
    "occ-plugin:diffs": { enabled: true, toolDefaults: { approval: "provider_default" } },
  });
});

test("API-key Presets keep their credential provider fixed while allowing model and runtime changes", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Bound provider Preset", { ready: true });
  const secret = await fixture.createSecret(namespace.id, "OpenAI model key", "preset-model-key");
  const harnessAuth = { method: "api_key", source: secret.ref };
  const preset: FixtureResponse<Preset> = await fixture.request(
    "POST",
    `/namespaces/${namespace.id}/presets`,
    {
      body: {
        name: "Saved OpenAI credential",
        template: {
          agent: { name: "Bound provider Agent", executionMode: "embedded", harnessAuth },
          configuration: { values: nativeValues("bound-provider") },
        },
      },
    },
  );
  assert.equal(preset.status, 201);
  const { page } = await newPage(t, fixture);
  // Exercise the supported draft path; dedicated provisioning has separate workflow coverage.
  await routeInstallationWithoutProvisioning(page, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByLabel("Preset template").selectOption(preset.data.id);
  await page.getByRole("button", { name: "Use Preset" }).click();
  await openAdvancedSettings(page);
  const configuration = page.getByLabel("Configuration JSON", { exact: true });
  const original = JSON.parse(await configuration.inputValue());
  assert.equal(await page.getByLabel("Harness", { exact: true }).inputValue(), "openclaw");
  assert.equal(await page.getByLabel("Harness", { exact: true }).isEnabled(), true);
  // Editing JSON must not silently retarget the saved OpenAI Secret to Anthropic.
  const changed = structuredClone(original);
  changed.agents.defaults.model = "anthropic/claude-account-model";
  await configuration.fill(JSON.stringify(changed));
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Configuration must use the selected provider" })
    .waitFor();
  // The JSON is what to fix, so it takes focus (finding 1903).
  assert.equal(
    await page.evaluate(() => globalThis.document.activeElement?.id),
    "configuration-json",
  );
  assert.deepEqual(nonAuthWriteRequests(requests), []);
  const provider = page.getByLabel("Provider", { exact: true });
  assert.equal(await provider.inputValue(), "openai");
  assert.equal(await provider.isDisabled(), true);

  // Same-provider model and embedded-to-dedicated edits retain the original credential binding.
  await configuration.fill(JSON.stringify(original));
  await page.getByLabel("Model ID", { exact: true }).fill("gpt-5.1");
  await page.getByLabel("Model ID", { exact: true }).press("Tab");
  await page.getByLabel("Harness", { exact: true }).selectOption("codex");
  const dedicated = JSON.parse(await configuration.inputValue());
  assert.equal(dedicated.agents.defaults.model, "codex/gpt-5.1");
  // Existing dedicated Presets may also use the supported OpenAI model prefix.
  dedicated.agents.defaults.model = "openai/gpt-5.1";
  await configuration.fill(JSON.stringify(dedicated));
  const createdResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/namespaces/${namespace.id}/agents`) &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  const created = await createdAgent(createdResponse);
  assert.deepEqual(created.harnessAuth, harnessAuth);
  assert.equal(created.executionMode, "dedicated");
  const saved: FixtureResponse<ModelConfiguration> = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${created.configurationId}`,
  );
  assert.equal(saved.data.values.agents.defaults.model, "openai/gpt-5.1");
  assert.equal(pathRequests(requests, "POST", `/namespaces/${namespace.id}/secrets`).length, 0);
});

test("Dedicated OpenClaw Presets preserve custom provider transport across execution mode changes", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Dedicated OpenClaw Preset", { ready: true });
  const secret = await fixture.createSecret(namespace.id, "OpenAI model key", "dedicated-key");
  const harnessAuth = { method: "api_key", source: secret.ref };
  const base = nativeValues("dedicated-openclaw");
  const provider = base.models.providers.openai;
  assert.ok(provider, "the native fixture must supply the OpenAI provider");
  const openai = {
    ...provider,
    baseUrl: "https://models.example.test/v1",
    api: "openai-completions",
    headers: { "X-Model-Route": "enterprise" },
  };
  const [model] = openai.models;
  assert.ok(model);
  model.id = "openai/gpt-4.1";
  const values = { ...base, models: { ...base.models, providers: { openai } } };
  const preset: FixtureResponse<Preset> = await fixture.request(
    "POST",
    `/namespaces/${namespace.id}/presets`,
    {
      body: {
        name: "Dedicated OpenClaw",
        template: {
          agent: { name: "Dedicated OpenClaw Agent", executionMode: "dedicated", harnessAuth },
          configuration: { values },
        },
      },
    },
  );
  assert.equal(preset.status, 201, JSON.stringify(preset.body));
  const unavailable =
    /Dedicated OpenClaw is unavailable: this installation has no Sandbox Driver that can provision it, or its OpenClaw runtime lacks native worker support/;
  {
    // Without native worker support, the Preset opens as it was saved but cannot be created.
    const { page } = await newPage(t, fixture);
    await routeInstallationWithoutProvisioning(page, fixture);
    await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
    await page.getByLabel("Preset template").selectOption(preset.data.id);
    await page.getByRole("button", { name: "Use Preset" }).click();
    await page.getByRole("alert").filter({ hasText: unavailable }).waitFor();
    assert.equal(await page.getByLabel("Execution mode").inputValue(), "dedicated");
    assert.equal(
      await page.getByRole("button", { name: "Create Agent", exact: true }).isDisabled(),
      true,
    );
  }
  const { page } = await newPage(t, fixture);
  await routeInstallationWithoutProvisioning(page, fixture, {
    nativeWorkers: { support: "custom-image" },
  });
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByLabel("Preset template").selectOption(preset.data.id);
  await page.getByRole("button", { name: "Use Preset" }).click();
  // The Preset's own agentRuntime, not its execution mode, selects the harness.
  assert.equal(await page.getByLabel("Harness", { exact: true }).inputValue(), "openclaw");
  assert.equal(await page.getByLabel("Execution mode").inputValue(), "dedicated");
  assert.equal(await page.getByText(unavailable).isHidden(), true);
  await openAdvancedSettings(page);
  const configuration = page.getByLabel("Configuration JSON", { exact: true });
  assert.deepEqual(JSON.parse(await configuration.inputValue()), values);
  await page.locator(".launch-runtime:not([open]) > summary").click();
  // Changing only topology must not redirect inference or discard provider settings.
  for (const mode of ["dedicated", "embedded"]) {
    await page.getByLabel("Execution mode").selectOption(mode);
    assert.equal(await page.getByLabel("Harness", { exact: true }).inputValue(), "openclaw");
    assert.deepEqual(JSON.parse(await configuration.inputValue()), values);
  }
  // Dedicated OpenClaw needs the native model catalog's endpoint, which Agent save checks, so
  // this custom transport is created embedded.
  const createdResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/namespaces/${namespace.id}/agents`) &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  const created = await createdAgent(createdResponse);
  assert.equal(created.executionMode, "embedded");
  assert.deepEqual(created.harnessAuth, harnessAuth);
  const saved: FixtureResponse<ModelConfiguration> = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${created.configurationId}`,
  );
  assert.equal(saved.data.values.agents.defaults.model, "openai/gpt-4.1");
  assert.deepEqual(saved.data.values.agents.defaults.models["openai/gpt-4.1"]?.agentRuntime, {
    id: "openclaw",
  });
  assert.deepEqual(saved.data.values.models.providers, values.models.providers);
});

test("Partial Presets without a model policy retain the default Codex harness", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Partial model Preset", { ready: true });
  const preset: FixtureResponse<Preset> = await fixture.request(
    "POST",
    `/namespaces/${namespace.id}/presets`,
    {
      body: {
        name: "Gateway settings only",
        template: {
          agent: { name: "Partial Preset Agent" },
          configuration: { values: { gateway: { mode: "local", bind: "lan" } } },
        },
      },
    },
  );
  assert.equal(preset.status, 201, JSON.stringify(preset.body));
  const { page } = await newPage(t, fixture);
  await routeInstallationWithoutProvisioning(page, fixture);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByLabel("Preset template").selectOption(preset.data.id);
  await page.getByRole("button", { name: "Use Preset" }).click();
  assert.equal(await page.getByLabel("Harness", { exact: true }).inputValue(), "codex");
  assert.equal(await page.getByLabel("Execution mode").inputValue(), "dedicated");
  assert.equal(await page.getByLabel("Execution mode").isDisabled(), true);
  await page.getByLabel("Model", { exact: true }).selectOption("gpt-6-astra");
  await createModelCredentialSecret(page, "partial-preset-model-key");
  const createdResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  const created = await createdAgent(createdResponse);
  assert.equal(created.executionMode, "dedicated");
  const saved: FixtureResponse<ModelConfiguration> = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${created.configurationId}`,
  );
  assert.equal(saved.data.values.agents.defaults.model, "codex/gpt-6-astra");
  assert.deepEqual(saved.data.values.agents.defaults.models["codex/gpt-6-astra"]?.agentRuntime, {
    id: "codex",
  });
  assert.deepEqual(saved.data.values.gateway, { mode: "local", bind: "lan" });
});

test("Presets render variables into independent Agent drafts and keep partial-save retries fixed", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const pluginDriver = new CodexPluginDriver();
  fixture.controller.registerDriver(pluginDriver);
  fixture.controller.selectDriver("plugin", pluginDriver.id);
  const namespace = await fixture.createNamespace("Preset authoring", { ready: true });
  const secret = await fixture.createSecret(
    namespace.id,
    "Preset channel token",
    "test-channel-token",
  );
  await fixture.createAgent(namespace.id, "Existing Agent");
  const values = nativeValues("{{ vars.marker }}", {
    harnessId: "codex",
    providerModel: "gpt-5.1",
  });
  values.plugins.entries.knowledge.config.enabled = "{{ vars.enabled }}";
  values.plugins.entries.knowledge.config.count = "{{ vars.count }}";
  const plugins = {
    "codex-plugin:linear@openai-curated-remote": {
      enabled: true,
      toolDefaults: { approval: "none" },
    },
  };
  const secretBindings = { CHANNEL_TOKEN: { source: secret.ref, delivery: { type: "env" } } };
  const preset: FixtureResponse<Preset> = await fixture.request(
    "POST",
    `/namespaces/${namespace.id}/presets`,
    {
      body: {
        name: "Reusable Agent",
        template: {
          variables: {
            name: { type: "string" },
            execution: { type: "string", default: "dedicated" },
            marker: { type: "string", default: "initial" },
            enabled: { type: "boolean", default: false },
            count: { type: "number", default: 0 },
          },
          agent: {
            name: "{{ vars.name }}",
            executionMode: "{{ vars.execution }}",
            backendId: backendFixtures[0]!.id,
            harnessAuth: { method: "codex_pat", source: secret.ref },
            plugins,
            initialWorkspaceFiles: {
              "AGENTS.md": "# {{ vars.name }} workspace\n",
              "IDENTITY.md": "",
              "USER.md": "marker {{ vars.marker }}",
            },
          },
          configuration: { values, secretBindings },
        },
      },
    },
  );
  assert.equal(preset.status, 201, JSON.stringify(preset.body));
  const { page } = await newPage(t, fixture);
  // Exercise the supported draft path; dedicated provisioning has separate workflow coverage.
  await routeInstallationWithoutProvisioning(page, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByLabel("Preset template").selectOption(preset.data.id);
  await page.getByLabel("Name", { exact: true }).waitFor();
  const save = page.getByRole("button", { name: "Create Agent", exact: true });
  assert.equal(await save.count(), 0, "choose a starting point before editing the Agent draft");
  const apply = page.getByRole("button", { name: "Use Preset" });
  await apply.click();
  assert.equal(
    await page
      .getByLabel("Name", { exact: true })
      .evaluate((input: HTMLInputElement) => input.validity.valueMissing),
    true,
  );
  assert.equal(configurationPostRequests(requests, namespace.id).length, 0);
  await page.getByLabel("Name", { exact: true }).fill("Existing Agent");
  await page.getByLabel("Execution", { exact: true }).fill("invalid");
  await apply.click();
  await page
    .getByText(
      'Rendered Preset contains invalid Agent fields or Secret bindings: agent.executionMode must be "embedded" or "dedicated". Check the variables you entered, or ask a Preset editor to fix the template.',
    )
    .waitFor();
  assert.equal(await save.count(), 0);
  assert.equal(configurationPostRequests(requests, namespace.id).length, 0);
  await page.getByLabel("Execution", { exact: true }).fill("dedicated");
  await page.getByLabel("Marker", { exact: true }).fill("changed");
  await apply.click();
  await page.getByLabel("Agent name", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Preset template").count(), 0);
  assert.equal(await page.getByLabel("Marker", { exact: true }).count(), 0);
  await page
    .getByText("Preset authentication: Service Accounts · Secret configured", { exact: true })
    .waitFor();
  assert.equal(await page.getByLabel("Service account token", { exact: true }).count(), 0);
  assert.equal(await page.getByLabel("Execution mode").isDisabled(), true);
  assert.equal(await page.getByLabel("Harness", { exact: true }).inputValue(), "codex");
  assert.equal(await page.getByLabel("Harness", { exact: true }).isDisabled(), true);
  assert.equal(
    (await page.getByLabel("Configuration JSON", { exact: true }).inputValue()).includes(
      "test-channel-token",
    ),
    false,
  );
  await waitForCreateFormReads(page);
  await waitForEnabled(save);
  assert.equal(
    await page.getByLabel("AGENTS.md", { exact: true }).inputValue(),
    "# Existing Agent workspace\n",
  );
  assert.equal(await page.getByLabel("IDENTITY.md", { exact: true }).inputValue(), "");
  assert.equal(await page.getByLabel("USER.md", { exact: true }).inputValue(), "marker changed");
  const rendered = JSON.parse(
    await page.getByLabel("Configuration JSON", { exact: true }).inputValue(),
  );
  assert.deepEqual(rendered.plugins.entries.knowledge.config, {
    marker: "changed",
    thresholds: [1, 2, 3],
    enabled: false,
    count: 0,
  });
  assert.deepEqual(rendered.gateway.controlUi, { enabled: false });
  assert.deepEqual(
    JSON.parse(await page.getByLabel("Plugin selections JSON").inputValue()),
    plugins,
  );
  // Deletion after selection must not invalidate this independent local copy.
  assert.equal(
    (
      await fixture.rawRequest("DELETE", `/namespaces/${namespace.id}/presets/${preset.data.id}`, {
        headers: authenticatedHeaders(await fixture.signIn()),
      })
    ).response.status,
    204,
  );
  await page.getByLabel("Agent name", { exact: true }).fill("Edited name");
  const edited = JSON.parse(
    await page.getByLabel("Configuration JSON", { exact: true }).inputValue(),
  );
  edited.plugins.entries.knowledge.config.thresholds = [5, 6];
  await openAdvancedSettings(page);
  await page.getByLabel("Configuration JSON", { exact: true }).fill(JSON.stringify(edited));
  await page.getByLabel("AGENTS.md", { exact: true }).fill("# Edited workspace\n");
  // Route reconstruction must retain the rendered copy even after its source Preset was deleted.
  await page.getByRole("link", { name: "Namespaces", exact: true }).click();
  await page.getByRole("heading", { name: "Namespaces", exact: true }).waitFor();
  await page.goBack();
  await page.getByLabel("Agent name", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Agent name", { exact: true }).inputValue(), "Edited name");
  assert.deepEqual(
    JSON.parse(await page.getByLabel("Configuration JSON", { exact: true }).inputValue()),
    edited,
  );
  assert.equal(
    await page.getByLabel("AGENTS.md", { exact: true }).inputValue(),
    "# Edited workspace\n",
  );
  assert.equal(await page.getByLabel("IDENTITY.md", { exact: true }).inputValue(), "");
  assert.deepEqual(
    JSON.parse(await page.getByLabel("Plugin selections JSON").inputValue()),
    plugins,
  );
  await page.goForward();
  await page.getByRole("heading", { name: "Namespaces", exact: true }).waitFor();
  await page.getByRole("link", { name: "Agents", exact: true }).click();
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  await page.getByLabel("Agent name", { exact: true }).waitFor();
  // Returning to the draft restores or remounts it; wait for the live form's reads.
  await waitForCreateFormReads(page);
  assert.equal(await page.getByLabel("Agent name", { exact: true }).inputValue(), "Edited name");
  // Plugin catalog discovery is a read sent as POST. A mounted draft with the rendered codex_pat
  // Secret prefetches it after a 300 ms debounce, so it may or may not have been sent yet.
  const pluginCatalogPath = `/namespaces/${namespace.id}/agents/plugins`;
  assert.deepEqual(
    nonAuthWriteRequests(requests).filter((request) => request.path !== pluginCatalogPath),
    [],
    "navigation must not save the local draft",
  );
  // A retained draft revalidates the Preset read on return; saving never reads it again.
  const presetPath = `/namespaces/${namespace.id}/presets/${preset.data.id}`;
  const presetReads = pathRequests(requests, "GET", presetPath).length;
  assert.ok(presetReads >= 1);
  // Canceling Start over keeps the ordinary draft and its ability to save.
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Start over" }).click();
  assert.equal(await save.isEnabled(), true);
  assert.deepEqual(
    JSON.parse(await page.getByLabel("Configuration JSON", { exact: true }).inputValue()),
    edited,
  );
  await page.getByLabel("Agent name", { exact: true }).fill("Existing Agent");
  const conflict = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/namespaces/${namespace.id}/agents`) &&
      response.request().method() === "POST",
  );
  await save.click();
  assert.equal((await conflict).status(), 409);
  await page
    .getByText("An Agent with this name already exists in this Namespace. Choose a different name.")
    .waitFor();
  assert.equal(await page.getByRole("button", { name: "Start over" }).isDisabled(), true);
  assert.equal(configurationPostRequests(requests, namespace.id).length, 1);
  await page.getByLabel("Agent name", { exact: true }).fill("Preset Agent");
  const createdResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/namespaces/${namespace.id}/agents`) &&
      response.request().method() === "POST",
  );
  await save.click();
  const created = await createdAgent(createdResponse);
  assert.equal(
    pathRequests(requests, "POST", `/namespaces/${namespace.id}/agents/models`).length,
    0,
  );
  assert.equal(created.name, "Preset Agent");
  const expectedWorkspaceFiles = {
    ...WORKSPACE_DEFAULTS,
    "AGENTS.md": "# Edited workspace\n",
    "IDENTITY.md": "",
    "USER.md": "marker changed",
  };
  const agentWrites = agentPostRequests(requests, namespace.id);
  assert.equal(agentWrites.length, 2);
  for (const { body } of agentWrites) {
    assert.ok(
      typeof body === "object" &&
        body !== null &&
        "initialWorkspaceFiles" in body &&
        "workspaceDefaultsId" in body,
    );
    assert.deepEqual(body.initialWorkspaceFiles, expectedWorkspaceFiles);
    assert.equal(body.workspaceDefaultsId, WORKSPACE_DEFAULTS_ID);
  }
  assert.deepEqual(created.plugins, plugins);
  assert.equal(created.backendId, backendFixtures[0]!.id);
  assert.deepEqual(created.harnessAuth, { method: "codex_pat", source: secret.ref });
  const saved: FixtureResponse<ModelConfiguration> = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${created.configurationId}`,
  );
  assert.deepEqual(saved.data.secretBindings, secretBindings);
  assert.deepEqual(saved.data.values.gateway.controlUi, { enabled: false });
  assert.equal(saved.data.values.plugins.entries.knowledge.config.marker, "changed");
  assert.deepEqual(saved.data.values.plugins.entries.knowledge.config.thresholds, [5, 6]);
  assert.equal(configurationPostRequests(requests, namespace.id).length, 1);
  assert.equal(pathRequests(requests, "GET", presetPath).length, presetReads);

  await page.waitForURL((url) => url.pathname === `/console/agents/${created.id}`);
  await page.getByRole("tab", { name: "Credentials", exact: true }).click();
  await page.getByLabel("Service account token Secret").waitFor();
  assert.equal(await page.getByLabel("Authentication source").inputValue(), "codex_pat");
  await waitForInputValue(page.getByLabel("Service account token Secret"), secret.name);
  const patched = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/agents/${created.id}`) && response.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save authentication source", exact: true }).click();
  assert.deepEqual((await (await patched).json()).data.harnessAuth, {
    method: "codex_pat",
    source: secret.ref,
  });

  // A Preset can supply an explicit model while requiring the operator to select its model Secret.
  await page.waitForURL((url) => url.pathname === `/console/agents/${created.id}`);
  const keyEntryPreset: FixtureResponse<Preset> = await fixture.request(
    "POST",
    `/namespaces/${namespace.id}/presets`,
    {
      body: {
        name: "Preset requiring an API key",
        template: {
          agent: { name: "Preset key entry", executionMode: "embedded" },
          configuration: { values: nativeValues("preset-key-entry") },
        },
      },
    },
  );
  assert.equal(keyEntryPreset.status, 201);
  const presetKeySecrets = await Promise.all(
    ["preset-openai-key", "preset-anthropic-key", "preset-dedicated-openai-key"].map((value) =>
      fixture.createSecret(namespace.id, value, value),
    ),
  );
  await page.goto(`${fixture.origin}/console/agents/new?namespace=${namespace.id}`);
  await page.getByLabel("Preset template").selectOption(keyEntryPreset.data.id);
  await page.getByRole("button", { name: "Use Preset" }).click();
  const presetKey = page.locator("#provider-credential-secret");
  assert.equal(await page.getByLabel("Model ID", { exact: true }).inputValue(), "gpt-4.1");
  await selectSecret(page, "API key Secret", presetKeySecrets[0]);
  await page.getByLabel("Provider", { exact: true }).selectOption("anthropic");
  assert.equal(await presetKey.inputValue(), "");
  await selectSecret(page, "API key Secret", presetKeySecrets[1]);
  await openAdvancedSettings(page);
  const native = page.getByLabel("Configuration JSON");
  const changedProvider = JSON.parse(await native.inputValue());
  changedProvider.agents.defaults.model = "openai/gpt-4.1";
  await native.fill(JSON.stringify(changedProvider));
  assert.equal(await page.getByLabel("Provider", { exact: true }).inputValue(), "openai");
  assert.equal(await presetKey.inputValue(), "");
  const mode = page.getByLabel("Execution mode");
  await page.getByLabel("Harness", { exact: true }).selectOption("codex");
  await selectSecret(page, "API key Secret", presetKeySecrets[2]);
  const anthropicConfiguration = JSON.parse(await native.inputValue());
  anthropicConfiguration.agents.defaults.model = "anthropic/claude-account-model";
  await native.fill(JSON.stringify(anthropicConfiguration));
  assert.equal(await page.getByLabel("Provider", { exact: true }).inputValue(), "anthropic");
  assert.equal(await mode.inputValue(), "embedded");
  assert.equal(await mode.isDisabled(), true);
  assert.equal(await presetKey.inputValue(), "");
  assert.equal(
    pathRequests(requests, "POST", `/namespaces/${namespace.id}/agents/models`).length,
    0,
  );
});

test("standard Codex password Preset creates one scoped Secret and reuses it after an Agent conflict", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Password Preset", { ready: true });
  await fixture.createAgent(namespace.id, "Existing Agent");
  const artifact = structuredClone(standardCodexPreset);
  const preset: FixtureResponse<Preset> = await fixture.request(
    "POST",
    `/namespaces/${namespace.id}/presets`,
    {
      body: artifact,
    },
  );
  assert.equal(preset.status, 201, JSON.stringify(preset.body));
  const { page } = await newPage(t, fixture);
  await routeInstallationWithoutProvisioning(page, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByLabel("Preset template").selectOption(preset.data.id);
  await page.getByLabel("Name", { exact: true }).fill("Existing Agent");
  await page.getByLabel("Model", { exact: true }).fill("gpt-5.1");
  const password = page.getByLabel("Model Secret", { exact: true });
  assert.equal(await password.getAttribute("type"), "password");
  await page.getByRole("button", { name: "Use Preset" }).click();
  assert.equal(
    await password.evaluate((input: HTMLInputElement) => input.validity.valueMissing),
    true,
  );
  const key = "synthetic-password-key-{{ vars.name }}";
  await password.fill(key);
  await page.getByRole("button", { name: "Use Preset" }).click();
  const apiKey = page.getByLabel("API key", { exact: true });
  assert.equal(await apiKey.getAttribute("type"), "password");
  assert.equal(await apiKey.inputValue(), key);
  assert.equal(
    (await page.getByLabel("Configuration JSON", { exact: true }).inputValue()).includes(key),
    false,
  );
  assert.equal(nonAuthWriteRequests(requests).length, 0);
  const save = page.getByRole("button", { name: "Create Agent", exact: true });
  const conflict = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/namespaces/${namespace.id}/agents`) &&
      response.request().method() === "POST",
  );
  await save.click();
  assert.equal((await conflict).status(), 409);
  await page
    .getByText("An Agent with this name already exists in this Namespace. Choose a different name.")
    .waitFor();
  assert.equal(await apiKey.inputValue(), "");
  assert.equal(await page.getByRole("button", { name: "Start over" }).isDisabled(), true);
  await page.getByLabel("Agent name", { exact: true }).fill("Password Agent");
  const createdResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/namespaces/${namespace.id}/agents`) &&
      response.request().method() === "POST",
  );
  await save.click();
  const created = await createdAgent(createdResponse);
  await page.waitForURL((url) => url.pathname === `/console/agents/${created.id}`);
  const secretWrites = secretPostRequests(requests, namespace.id);
  assert.equal(secretWrites.length, 1);
  assert.partialDeepStrictEqual(secretWrites[0]?.body, {
    value: key,
  } satisfies Pick<CreateSecretBody, "value">);
  assert.equal(configurationPostRequests(requests, namespace.id).length, 1);
  assert.equal(
    JSON.stringify(requests.filter((request) => !request.path.endsWith("/secrets"))).includes(key),
    false,
  );
  assert.equal(created.executionMode, "dedicated");
  const auth = created.harnessAuth;
  assert.ok(auth?.method === "api_key" && auth.source.kind === "secret");
  const source = auth.source;
  assert.equal(source.namespaceId, namespace.id);
  const secrets: FixtureResponse<SecretWire[]> = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/secrets`,
  );
  assert.ok(secrets.data.some((secret) => secret.id === source.id));
  assert.equal(JSON.stringify(secrets.body).includes(key), false);
  const retained: FixtureResponse<Preset> = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/presets/${preset.data.id}`,
  );
  assert.deepEqual(retained.data.template, artifact.template);
  const access: FixtureResponse<IAMAccessBindingWire[]> = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/iam/access-bindings`,
  );
  assert.ok(
    access.data.some(
      (binding) =>
        binding.subjectId === created.servicePrincipalId &&
        "resourceId" in binding &&
        binding.resourceId === source.id,
    ),
  );
});

test("Preset marks referenced variables without defaults as required before rendering", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Required Preset variables", { ready: true });
  const artifact = structuredClone(standardCodexPreset);
  // Defaulted and unreferenced variables cannot fail rendering, so they stay optional.
  artifact.template.variables.marker = { type: "string", default: "initial" };
  artifact.template.variables.unused = { type: "boolean" };
  artifact.template.agent.initialWorkspaceFiles = { "USER.md": "marker {{ vars.marker }}" };
  const preset: FixtureResponse<Preset> = await fixture.request(
    "POST",
    `/namespaces/${namespace.id}/presets`,
    {
      body: artifact,
    },
  );
  assert.equal(preset.status, 201, JSON.stringify(preset.body));
  const { page } = await newPage(t, fixture);
  await routeInstallationWithoutProvisioning(page, fixture);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByLabel("Preset template").selectOption(preset.data.id);
  await page.getByLabel("Name", { exact: true }).fill("Required Agent");
  await page.getByLabel("Model Secret", { exact: true }).fill("synthetic-required-key");
  const model = page.getByLabel("Model", { exact: true });
  const marker = page.getByLabel("Marker", { exact: true });
  const unused = page.getByLabel("Unused", { exact: true });
  await marker.fill("");
  await page.getByRole("button", { name: "Use Preset" }).click();
  // The browser points at the empty Model field instead of a raw template path.
  assert.equal(
    await model.evaluate((input: HTMLInputElement) => input.validity.valueMissing),
    true,
  );
  assert.equal(await marker.evaluate((input: HTMLTextAreaElement) => input.validity.valid), true);
  assert.equal(await unused.evaluate((input: HTMLSelectElement) => input.validity.valid), true);
  assert.equal(
    await page.getByRole("group", { name: "Preset" }).getByRole("alert").textContent(),
    "",
  );
  assert.equal(await page.getByLabel("Agent name", { exact: true }).count(), 0);
  await model.fill("gpt-5.1");
  await page.getByRole("button", { name: "Use Preset" }).click();
  await page.getByLabel("Agent name", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Agent name", { exact: true }).inputValue(), "Required Agent");
});

test("Preset with a prebound model Secret grants the created draft access", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Bound Secret Preset", { ready: true });
  const modelSecret = await fixture.createSecret(namespace.id, "Model token", "hidden-model-token");
  const artifact = structuredClone(standardCodexPreset);
  delete artifact.template.variables.modelSecret;
  artifact.template.agent.harnessAuth = { method: "api_key", source: modelSecret.ref };
  const preset: FixtureResponse<Preset> = await fixture.request(
    "POST",
    `/namespaces/${namespace.id}/presets`,
    {
      body: artifact,
    },
  );
  assert.equal(preset.status, 201, JSON.stringify(preset.body));
  const { page } = await newPage(t, fixture);
  await routeInstallationWithoutProvisioning(page, fixture);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByLabel("Preset template").selectOption(preset.data.id);
  await page.getByLabel("Name", { exact: true }).fill("Bound Secret Agent");
  await page.getByLabel("Model", { exact: true }).fill("gpt-5.1");
  await page.getByRole("button", { name: "Use Preset" }).click();
  const createdResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/namespaces/${namespace.id}/agents`) &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  const created = await createdAgent(createdResponse);
  await page.waitForURL((url) => url.pathname === `/console/agents/${created.id}`);
  const bindings: FixtureResponse<IAMAccessBindingWire[]> = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/iam/access-bindings`,
  );
  const roles: FixtureResponse<IAMRoleWire[]> = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/iam/roles`,
  );
  const secretOperateRole = roles.data.find(
    (role) =>
      role.permissions.length === 1 &&
      role.permissions[0]?.resourceKind === "secret" &&
      role.permissions[0].action === "operate",
  );
  assert.ok(secretOperateRole);
  assert.ok(
    bindings.data.some(
      (binding) =>
        binding.subjectKind === "identity" &&
        binding.subjectId === created.servicePrincipalId &&
        binding.roleId === secretOperateRole.id &&
        "resourceKind" in binding &&
        binding.resourceKind === "secret" &&
        binding.resourceId === modelSecret.id,
    ),
  );
});

for (const collection of ["secrets", "configurations"]) {
  test(`password Preset does not adopt a different ${collection} create response`, async (t) => {
    const fixture = await createConsoleAppFixture(t);
    await fixture.bootstrap();
    const namespace = await fixture.createNamespace("Preset creation receipts", { ready: true });
    const root = `/namespaces/${namespace.id}`;
    const other: SecretWire | ConfigurationWire =
      collection === "secrets"
        ? await fixture.createSecret(namespace.id, "Other model credential", "other-test-value")
        : await fixture.createConfiguration(namespace.id, nativeValues("other"));
    const preset: FixtureResponse<Preset> = await fixture.request("POST", `${root}/presets`, {
      body: standardCodexPreset,
    });
    assert.equal(preset.status, 201);
    const { page } = await newPage(t, fixture);
    await routeInstallationWithoutProvisioning(page, fixture);
    const requests = apiRequests(page, fixture.origin);
    const path = `${root}/${collection}`;
    await page.route(`**${path}`, async (route) => {
      if (route.request().method() !== "POST") {
        return route.fallback();
      }
      // The requested write commits. Return a genuine record from this same Namespace in its place.
      const response = await route.fetch();
      assert.equal(response.status(), 201);
      const { data, meta }: SecretResponse | ConfigurationResponse = await response.json();
      assert.notEqual(data.id, other.id);
      assert.equal(data.namespaceId, other.namespaceId);
      await route.fulfill({ status: 201, json: { data: other, meta } });
    });

    await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
    await page.getByLabel("Preset template").selectOption(preset.data.id);
    await page.getByLabel("Name", { exact: true }).fill("Requested model");
    await page.getByLabel("Model", { exact: true }).fill("gpt-5.1");
    await page.getByLabel("Model Secret", { exact: true }).fill("test-preset-value");
    await page.getByRole("button", { name: "Use Preset" }).click();
    const create = page.getByRole("button", { name: "Create Agent", exact: true });
    await create.click();
    await page
      .getByRole("alert")
      .filter({ hasText: /Outcome unknown/ })
      .waitFor();
    assert.equal(await page.getByLabel("API key", { exact: true }).inputValue(), "");
    assert.equal(await create.isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "Start over" }).isDisabled(), true);
    await page
      .locator("#create-agent-form")
      .evaluate((form: HTMLFormElement) => form.requestSubmit());
    await settlePageRequests(page);
    const bindings = `${root}/iam/access-bindings`;
    assert.equal(
      pathRequests(requests, "POST", bindings).length,
      0,
      "do not grant a Secret after an unconfirmed create",
    );
    assert.equal(agentPostRequests(requests, namespace.id).length, 0);
    assert.equal(pathRequests(requests, "POST", `${root}/secrets`).length, 1);
    assert.equal(
      configurationPostRequests(requests, namespace.id).length,
      collection === "secrets" ? 0 : 1,
    );
  });
}

test("password Preset can reuse an existing Secret and retry an uncertain grant without duplicate writes", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Existing Secret Preset", { ready: true });
  const modelSecret = await fixture.createSecret(
    namespace.id,
    "Existing model token",
    "hidden-model-token",
  );
  const artifact = structuredClone(standardCodexPreset);
  const preset: FixtureResponse<Preset> = await fixture.request(
    "POST",
    `/namespaces/${namespace.id}/presets`,
    {
      body: artifact,
    },
  );
  assert.equal(preset.status, 201, JSON.stringify(preset.body));
  const { page } = await newPage(t, fixture);
  await routeInstallationWithoutProvisioning(page, fixture);
  const requests = apiRequests(page, fixture.origin);
  const bindingPath = `/namespaces/${namespace.id}/iam/access-bindings`;
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByLabel("Preset template").selectOption(preset.data.id);
  await page.getByLabel("Name", { exact: true }).fill("Existing Secret Agent");
  await page.getByLabel("Model", { exact: true }).fill("gpt-5.1");
  await page.getByLabel("Secret source for Model Secret", { exact: true }).selectOption("existing");
  const existingSecret = page.getByLabel("Existing Secret for Model Secret", { exact: true });
  await existingSecret.selectOption(modelSecret.id);
  assert.equal(await existingSecret.locator("option:checked").textContent(), modelSecret.name);
  await page.getByRole("button", { name: "Use Preset" }).click();
  await page
    .getByText("Preset authentication: API key · Secret configured", { exact: true })
    .waitFor();
  assert.equal(await page.getByLabel("API key", { exact: true }).count(), 0);

  await page.route(`**${bindingPath}`, async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    assert.equal(response.status(), 201);
    await route.abort("failed");
  });
  const createdResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/namespaces/${namespace.id}/agents`) &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  const created = await createdAgent(createdResponse);
  await page
    .getByRole("alert")
    .filter({ hasText: /credential access is not confirmed.*interrupted/ })
    .waitFor();
  await page.unroute(`**${bindingPath}`);
  await page.getByRole("button", { name: "Retry credential access" }).click();
  await page.waitForURL((url) => url.pathname === `/console/agents/${created.id}`);

  assert.equal(pathRequests(requests, "POST", `/namespaces/${namespace.id}/secrets`).length, 0);
  const agentWrites = agentPostRequests(requests, namespace.id);
  assert.equal(agentWrites.length, 1);
  const body = agentWrites[0]?.body;
  assert.ok(typeof body === "object" && body !== null && "harnessAuth" in body);
  assert.deepEqual(body.harnessAuth, {
    method: "api_key",
    source: modelSecret.ref,
  } satisfies CreateAgentBody["harnessAuth"]);
  const bindings: FixtureResponse<IAMAccessBindingWire[]> = await fixture.request(
    "GET",
    bindingPath,
  );
  assert.equal(bindings.status, 200);
  assert.equal(bindings.data.length, 1);
  const [binding] = bindings.data;
  assert.ok(binding && "resourceId" in binding, "the committed grant must name the Secret");
  assert.equal(binding.subjectId, created.servicePrincipalId);
  assert.equal(binding.resourceId, modelSecret.id);
  const retained: FixtureResponse<Preset> = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/presets/${preset.data.id}`,
  );
  assert.deepEqual(retained.data.template, artifact.template);
});

test("codex_pat password Preset creates one Secret and reuses it after an Agent conflict", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Codex PAT Preset", { ready: true });
  await fixture.createAgent(namespace.id, "Existing Codex Agent");
  const artifact = structuredClone(standardCodexPreset);
  artifact.name = "standard-codex-pat";
  const auth = artifact.template.agent.harnessAuth;
  assert.ok("secret" in auth, "the shipped template must request the password variable");
  artifact.template.agent.harnessAuth = { ...auth, method: "codex_pat" };
  const preset: FixtureResponse<Preset> = await fixture.request(
    "POST",
    `/namespaces/${namespace.id}/presets`,
    {
      body: artifact,
    },
  );
  assert.equal(preset.status, 201, JSON.stringify(preset.body));
  const { page } = await newPage(t, fixture);
  await routeInstallationWithoutProvisioning(page, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByLabel("Preset template").selectOption(preset.data.id);
  await page.getByLabel("Name", { exact: true }).fill("Existing Codex Agent");
  await page.getByLabel("Model", { exact: true }).fill("gpt-6-astra");
  await page.getByLabel("Secret source for Model Secret", { exact: true }).selectOption("new");
  const password = page.getByLabel("Model Secret", { exact: true });
  await password.fill("at-codex-pat-preset-token");
  await page.getByRole("button", { name: "Use Preset" }).click();
  const token = page.getByLabel("Service account token", { exact: true });
  assert.equal(await token.inputValue(), "at-codex-pat-preset-token");
  const save = page.getByRole("button", { name: "Create Agent", exact: true });
  const conflict = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/namespaces/${namespace.id}/agents`) &&
      response.request().method() === "POST",
  );
  await save.click();
  assert.equal((await conflict).status(), 409);
  await page
    .getByText("An Agent with this name already exists in this Namespace. Choose a different name.")
    .waitFor();
  assert.equal(await token.inputValue(), "");
  await page.getByLabel("Agent name", { exact: true }).fill("Codex PAT Agent");
  const createdResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/namespaces/${namespace.id}/agents`) &&
      response.request().method() === "POST",
  );
  await save.click();
  const created = await createdAgent(createdResponse);
  await page.waitForURL((url) => url.pathname === `/console/agents/${created.id}`);
  const secretWrites = secretPostRequests(requests, namespace.id);
  assert.equal(secretWrites.length, 1);
  assert.partialDeepStrictEqual(secretWrites[0]?.body, {
    value: "at-codex-pat-preset-token",
  } satisfies Pick<CreateSecretBody, "value">);
  assert.equal(agentPostRequests(requests, namespace.id).length, 2);
  assert.equal(created.harnessAuth?.method, "codex_pat");
});

test("password Preset names the taken Secret when an earlier Agent left one with the same name", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Secret name conflict", { ready: true });
  // Deleting an Agent keeps its model Secret, which is named after the Agent.
  await fixture.createSecret(namespace.id, "Recreated Agent", "earlier-model-key");
  const artifact = structuredClone(standardCodexPreset);
  const preset: FixtureResponse<Preset> = await fixture.request(
    "POST",
    `/namespaces/${namespace.id}/presets`,
    {
      body: artifact,
    },
  );
  assert.equal(preset.status, 201, JSON.stringify(preset.body));
  const { page } = await newPage(t, fixture);
  await routeInstallationWithoutProvisioning(page, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByLabel("Preset template").selectOption(preset.data.id);
  await page.getByLabel("Name", { exact: true }).fill("Recreated Agent");
  await page.getByLabel("Model", { exact: true }).fill("gpt-5.1");
  await page.getByLabel("Model Secret", { exact: true }).fill("replacement-model-key");
  await page.getByRole("button", { name: "Use Preset" }).click();
  const apiKey = page.getByLabel("API key", { exact: true });
  const save = page.getByRole("button", { name: "Create Agent", exact: true });
  const conflict = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/namespaces/${namespace.id}/secrets`) &&
      response.request().method() === "POST",
  );
  await save.click();
  assert.equal((await conflict).status(), 409);
  await page
    .getByText(
      'A Secret named "Recreated Agent" already exists in this Namespace, possibly from an earlier Agent with this name. Choose another Agent name, delete that Secret, or select Start over, choose the Preset again, and set its Secret source to Use existing Secret.',
    )
    .waitFor();
  assert.equal(configurationPostRequests(requests, namespace.id).length, 0);
  assert.equal(agentPostRequests(requests, namespace.id).length, 0);
  assert.equal(await apiKey.inputValue(), "replacement-model-key");
  await waitForEnabled(page.getByRole("button", { name: "Start over" }));
  await page.getByLabel("Agent name", { exact: true }).fill("Recreated Agent 2");
  const createdResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/namespaces/${namespace.id}/agents`) &&
      response.request().method() === "POST",
  );
  await save.click();
  const created = await createdAgent(createdResponse);
  await page.waitForURL((url) => url.pathname === `/console/agents/${created.id}`);
  const secretWrites = secretPostRequests(requests, namespace.id);
  assert.deepEqual(
    secretWrites.map(({ body }) => body),
    ["Recreated Agent", "Recreated Agent 2"].map(
      (name) => ({ name, value: "replacement-model-key" }) satisfies CreateSecretBody,
    ),
  );
});

test("method-only codex_pat Preset requires credential entry in the create form", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Method-only preset", { ready: true });
  const modelSecret = await fixture.createSecret(
    namespace.id,
    "Existing service account token",
    "hidden-existing-token",
  );
  const artifact = structuredClone(standardCodexPreset);
  artifact.name = "method-only-codex-pat";
  delete artifact.template.variables.modelSecret;
  artifact.template.agent.harnessAuth = { method: "codex_pat" };
  const preset: FixtureResponse<Preset> = await fixture.request(
    "POST",
    `/namespaces/${namespace.id}/presets`,
    {
      body: artifact,
    },
  );
  assert.equal(preset.status, 201, JSON.stringify(preset.body));
  const { page } = await newPage(t, fixture);
  await routeInstallationWithoutProvisioning(page, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByLabel("Preset template").selectOption(preset.data.id);
  await page.getByLabel("Name", { exact: true }).fill("Method-only Codex Agent");
  await page.getByLabel("Model", { exact: true }).fill("gpt-6-astra");
  assert.equal(await page.getByLabel("Model Secret", { exact: true }).count(), 0);
  await page.getByRole("button", { name: "Use Preset" }).click();
  const credential = page.getByLabel("Service account token Secret", { exact: true });
  await credential.waitFor();
  assert.equal(await credential.inputValue(), "");
  await page.getByRole("link", { name: "← Agents" }).click();
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  await page.getByLabel("Agent name", { exact: true }).waitFor();
  await page.waitForFunction(
    () =>
      globalThis.document.querySelector<HTMLSelectElement>("#agent-auth-method")?.disabled ===
      false,
  );
  assert.equal(
    await page.getByLabel("Agent name", { exact: true }).inputValue(),
    "Method-only Codex Agent",
  );
  assert.equal(
    await page.getByLabel("Authentication method", { exact: true }).inputValue(),
    "codex_pat",
  );
  assert.equal(await page.getByLabel("Model Secret", { exact: true }).count(), 0);
  assert.equal(
    await page.getByLabel("Service account token Secret", { exact: true }).inputValue(),
    "",
  );
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  assert.equal(
    await credential.evaluate((input: HTMLInputElement) => input.validity.valueMissing),
    true,
  );
  assert.equal(nonAuthWriteRequests(requests).length, 0);

  await selectSecret(page, "Service account token Secret", modelSecret);
  assert.equal(await credential.inputValue(), secretOptionLabel(modelSecret));
  assert.deepEqual(await consoleStorage(page), { local: {}, session: {} });
  await page.getByLabel("Authentication method", { exact: true }).selectOption("api_key");
  assert.equal(await page.getByLabel("API key Secret", { exact: true }).inputValue(), "");
  await page.getByLabel("Authentication method", { exact: true }).selectOption("codex_pat");
  await selectSecret(page, "Service account token Secret", modelSecret);
  await page.getByLabel("Model ID", { exact: true }).fill("gpt-6-astra");
  const createdResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/namespaces/${namespace.id}/agents`) &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  const created = await createdAgent(createdResponse);
  await page.waitForURL((url) => url.pathname === `/console/agents/${created.id}`);
  const secretWrites = secretPostRequests(requests, namespace.id);
  assert.equal(secretWrites.length, 0);
  const agentWrites = agentPostRequests(requests, namespace.id);
  assert.equal(agentWrites.length, 1);
  const body = agentWrites[0]?.body;
  assert.ok(typeof body === "object" && body !== null && "harnessAuth" in body);
  assert.deepEqual(body.harnessAuth, {
    method: "codex_pat",
    source: modelSecret.ref,
  } satisfies CreateAgentBody["harnessAuth"]);
  assert.deepEqual(created.harnessAuth, { method: "codex_pat", source: modelSecret.ref });
});

test("Create Agent reuses its PAT Secret and resumes plugin prefetch after an Agent conflict", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const driver = new CodexPluginDriver({ catalogSource: "openai-curated" });
  fixture.controller.registerDriver(driver);
  fixture.controller.selectDriver("plugin", driver.id);
  const namespace = await fixture.createNamespace("Create credential picker", { ready: true });
  await fixture.createAgent(namespace.id, "Existing picker Agent");
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start with default Preset" }).click();
  await page.getByLabel("Agent name", { exact: true }).fill("Existing picker Agent");
  await page.getByLabel("Authentication method", { exact: true }).selectOption("codex_pat");
  await page.clock.install({ time: new Date("2026-09-27T12:00:00Z") });
  await page.clock.pauseAt(new Date("2026-09-27T12:00:01Z"));
  const secretValue = "picker-created-model-token";
  const modelSecret: SecretWire | null = await createModelCredentialSecret(page, secretValue);
  assert.ok(modelSecret);
  assert.equal(
    await page.getByLabel("Service account token Secret", { exact: true }).inputValue(),
    secretOptionLabel(modelSecret),
  );
  assert.equal(
    JSON.stringify(
      await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } })),
    ).includes(secretValue),
    false,
  );
  const model = page.getByLabel("Model ID", { exact: true });
  if (!(await model.isVisible())) {
    await page.getByRole("button", { name: "Enter model ID manually", exact: true }).click();
  }
  await model.fill("gpt-5.1");
  await model.press("Tab");

  const submitStarted = Promise.withResolvers<void>();
  const submitRelease = Promise.withResolvers<void>();
  t.after(() => submitRelease.resolve());
  await page.route(`${fixture.origin}/namespaces/${namespace.id}/agents`, async (route) => {
    if (route.request().method() === "POST") {
      submitStarted.resolve();
      await submitRelease.promise;
    }
    await route.continue();
  });
  const save = page.getByRole("button", { name: "Create Agent", exact: true });
  const conflict = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/namespaces/${namespace.id}/agents`) &&
      response.request().method() === "POST",
  );
  await save.click();
  await submitStarted.promise;
  // A prefetch due during submission must resume after the real duplicate-name rejection.
  await page.clock.runFor(300);
  const catalogPath = `/namespaces/${namespace.id}/agents/plugins`;
  assert.equal(pathRequests(requests, "POST", catalogPath).length, 0);
  submitRelease.resolve();
  assert.equal((await conflict).status(), 409);
  await page
    .getByText("An Agent with this name already exists in this Namespace. Choose a different name.")
    .waitFor();
  assert.equal(secretPostRequests(requests, namespace.id).length, 1);
  const prefetched = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}${catalogPath}` &&
      response.request().method() === "POST",
  );
  await page.clock.runFor(300);
  assert.equal((await prefetched).status(), 200);
  const plugins = page.getByRole("dialog", { name: "Configure plugins", exact: true });
  assert.equal(await plugins.isVisible(), false);
  await page.getByRole("button", { name: "Configure plugins", exact: true }).click();
  await plugins.getByRole("button", { name: "Linear", exact: true }).waitFor();
  await plugins.getByRole("button", { name: "Done", exact: true }).click();

  await page.getByLabel("Agent name", { exact: true }).fill("Picker credential Agent");
  const createdResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/namespaces/${namespace.id}/agents`) &&
      response.request().method() === "POST",
  );
  await save.click();
  const created = await createdAgent(createdResponse);
  await page.waitForURL((url) => url.pathname === `/console/agents/${created.id}`);
  assert.equal(secretPostRequests(requests, namespace.id).length, 1);
  assert.deepEqual(secretPostRequests(requests, namespace.id)[0]?.body, {
    name: "Existing picker Agent model credential",
    value: secretValue,
  } satisfies CreateSecretBody);
  assert.deepEqual(created.harnessAuth, { method: "codex_pat", source: modelSecret.ref });
  assert.equal(agentPostRequests(requests, namespace.id).length, 2);
});

test("Preset Secret picker preserves existing mode on catalog failure and can switch to new", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Preset secret catalog failure", { ready: true });
  const artifact = structuredClone(standardCodexPreset);
  const preset: FixtureResponse<Preset> = await fixture.request(
    "POST",
    `/namespaces/${namespace.id}/presets`,
    {
      body: artifact,
    },
  );
  assert.equal(preset.status, 201, JSON.stringify(preset.body));
  const { page } = await newPage(t, fixture);
  await routeInstallationWithoutProvisioning(page, fixture);
  await page.route(`**/namespaces/${namespace.id}/secrets`, async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "DEPENDENCY_UNAVAILABLE", message: "Secret catalog unavailable." },
          meta: { requestId: "req_secret_catalog_unavailable" },
        }),
      });
      return;
    }
    await route.fallback();
  });
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByLabel("Preset template").selectOption(preset.data.id);
  const source = page.getByLabel("Secret source for Model Secret", { exact: true });
  await source.selectOption("existing");
  await page.getByText(/Choose create-new mode to enter a new token/).waitFor();
  assert.equal(await source.inputValue(), "existing");
  await page.getByLabel("Name", { exact: true }).fill("Catalog fallback Agent");
  await page.getByLabel("Model", { exact: true }).fill("gpt-5.1");
  await source.selectOption("new");
  await page.getByLabel("Model Secret", { exact: true }).fill("new-token-after-catalog-error");
  await page.getByRole("button", { name: "Use Preset" }).click();
  await page.getByLabel("Agent name", { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel("API key", { exact: true }).inputValue(),
    "new-token-after-catalog-error",
  );
});

test("Preset picker ignores stale Preset responses after switching selection", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Preset picker race", { ready: true });
  const first: FixtureResponse<Preset> = await fixture.request(
    "POST",
    `/namespaces/${namespace.id}/presets`,
    {
      body: {
        name: "First delayed Preset",
        template: {
          variables: { firstName: { type: "string" } },
          agent: { name: "{{ vars.firstName }}", executionMode: "embedded" },
        },
      },
    },
  );
  const second: FixtureResponse<Preset> = await fixture.request(
    "POST",
    `/namespaces/${namespace.id}/presets`,
    {
      body: {
        name: "Second current Preset",
        template: {
          variables: { secondName: { type: "string" } },
          agent: { name: "{{ vars.secondName }}", executionMode: "embedded" },
        },
      },
    },
  );
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(second.status, 201, JSON.stringify(second.body));
  const { page } = await newPage(t, fixture);
  await trackSettledFetches(page);
  await routeInstallationWithoutProvisioning(page, fixture);
  const { resolve: releaseFirst, promise: firstBlocked } = Promise.withResolvers<void>();
  await page.route(`**/namespaces/${namespace.id}/presets/${first.data.id}`, async (route) => {
    await firstBlocked;
    await route.fallback();
  });
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByLabel("Preset template").selectOption(first.data.id);
  await page.getByLabel("Preset template").selectOption(second.data.id);
  await page.getByLabel("Second Name", { exact: true }).waitFor();
  releaseFirst();
  // The page has read the stale response and run its handler.
  await waitForSettledFetches(page, `/namespaces/${namespace.id}/presets/${first.data.id}`, 1);
  assert.equal(await page.getByLabel("First Name", { exact: true }).count(), 0);
  await page.getByLabel("Second Name", { exact: true }).fill("Current Agent");
  await page.getByRole("button", { name: "Use Preset" }).click();
  await page.getByLabel("Agent name", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Agent name", { exact: true }).inputValue(), "Current Agent");
});

test("a default starter creation form survives every exit but a confirmed Cancel", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Creation exit", { ready: true });
  const otherNamespace = await fixture.createNamespace("Other Namespace", { ready: true });
  const savedAgent = await fixture.createAgent(namespace.id, "Saved Agent");
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const dialogs: string[] = [];
  let acceptDialogs = false;
  page.on("dialog", async (dialog) => {
    dialogs.push(`${dialog.type()}: ${dialog.message()}`);
    await (acceptDialogs ? dialog.accept() : dialog.dismiss());
  });
  await login(page, fixture, `/console/agents?namespace=${namespace.id}`);

  for (const exit of ["breadcrumb", "sidebar", "history", "namespace"]) {
    await page.getByRole("button", { name: "Create Agent", exact: true }).click();
    await page.getByRole("button", { name: "Start with default Preset", exact: true }).click();
    await page.getByLabel("Agent name", { exact: true }).fill(`Kept ${exit}`);
    await openAdvancedSettings(page);
    await page.getByLabel("USER.md", { exact: true }).fill(`Kept workspace ${exit}`);

    if (exit === "breadcrumb") {
      await page.getByRole("link", { name: "← Agents" }).click();
    } else if (exit === "sidebar") {
      await page
        .getByRole("navigation", { name: "Main navigation" })
        .getByRole("link", { name: "Agents", exact: true })
        .click();
    } else if (exit === "history") {
      await page.goBack();
    } else {
      await page.getByLabel("Namespace", { exact: true }).selectOption(otherNamespace.id);
      await page.getByRole("button", { name: "Create Agent", exact: true }).click();
      // Drafts belong to their Namespace: the other one starts from the choices.
      await page.getByRole("button", { name: "Start with default Preset", exact: true }).waitFor();
      assert.equal(await page.getByLabel("Agent name", { exact: true }).count(), 0);
      await page.getByLabel("Namespace", { exact: true }).selectOption(namespace.id);
    }

    // History re-entry and the normal Create button both return to the kept form.
    if (exit === "history") {
      await page.goForward();
    } else {
      await page.getByRole("button", { name: "Create Agent", exact: true }).click();
    }
    const name = page.getByLabel("Agent name", { exact: true });
    await name.waitFor();
    assert.equal(await name.inputValue(), `Kept ${exit}`, exit);
    await openAdvancedSettings(page);
    assert.equal(
      await page.getByLabel("USER.md", { exact: true }).inputValue(),
      `Kept workspace ${exit}`,
      exit,
    );

    // Cancel is the explicit discard, and it asks first.
    acceptDialogs = false;
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.deepEqual(dialogs.splice(0), ["confirm: Discard this draft?"], exit);
    assert.equal(await name.inputValue(), `Kept ${exit}`, exit);
    acceptDialogs = true;
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("button", { name: "Create Agent", exact: true }).click();
    assert.deepEqual(dialogs.splice(0), ["confirm: Discard this draft?"], exit);
    await page.getByRole("button", { name: "Start with default Preset", exact: true }).waitFor();
    await page.getByLabel("Preset template").waitFor();
    assert.equal(await name.count(), 0, exit);
    await page.getByRole("link", { name: "← Agents" }).click();
  }

  // An untouched form has nothing to lose: Start over and Cancel leave without asking.
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  await page.getByRole("button", { name: "Start with default Preset", exact: true }).click();
  await page.getByLabel("Agent name", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Start over", exact: true }).click();
  await page.getByLabel("Preset template").waitFor();
  await page.getByRole("button", { name: "Start with default Preset", exact: true }).click();
  await page.getByLabel("Agent name", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Create Agent", exact: true }).waitFor();
  assert.deepEqual(dialogs, []);

  // Exiting an unsaved form must not mutate or delete an Agent already saved by the user.
  assert.deepEqual(nonAuthWriteRequests(requests), []);
  const result: FixtureResponse<AgentWire> = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${savedAgent.id}`,
  );
  assert.equal(result.status, 200);
  assert.equal(result.data.name, "Saved Agent");
});

test("a restored default starter chooser keeps its applied form across navigation", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Customized starter", { ready: true });
  const starter = await defaultPresetSummary(fixture, namespace.id);
  const defaults = await presetTemplate(fixture, namespace.id, starter.id);
  const template: PresetTemplate = {
    ...defaults,
    variables: { name: { type: "string" } },
    agent: { ...defaults.agent, name: "{{ vars.name }}" },
  };
  const updated = await fixture.request(
    "PATCH",
    `/namespaces/${namespace.id}/presets/${starter.id}`,
    { body: { template } },
  );
  assert.equal(updated.status, 200);

  const { page } = await newPage(t, fixture);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start with default Preset", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Restored starter");
  await page.getByRole("link", { name: "← Agents" }).click();
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  assert.equal(await page.getByLabel("Name", { exact: true }).inputValue(), "Restored starter");
  await page.getByRole("button", { name: "Use Preset", exact: true }).click();
  assert.equal(
    await page.getByLabel("Agent name", { exact: true }).inputValue(),
    "Restored starter",
  );
  await page.getByRole("link", { name: "← Agents" }).click();
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  assert.equal(
    await page.getByLabel("Agent name", { exact: true }).inputValue(),
    "Restored starter",
  );
});

test("a default shortcut restored after a pending Preset read keeps its form", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Pending starter", { ready: true });
  const starter = await defaultPresetSummary(fixture, namespace.id);
  const { page } = await newPage(t, fixture);
  const { resolve: releaseRead, promise: blocked } = Promise.withResolvers<void>();
  const { resolve: markRead, promise: observed } = Promise.withResolvers<void>();
  t.after(() => releaseRead());
  const presetPath = `**/namespaces/${namespace.id}/presets/${starter.id}`;
  await page.route(presetPath, async (route) => {
    markRead();
    await blocked;
    await route.fallback();
  });
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start with default Preset", exact: true }).click();
  await observed;
  await page.getByRole("link", { name: "← Agents" }).click();
  releaseRead();
  await page.unroute(presetPath);
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  await page.getByRole("button", { name: "Use Preset", exact: true }).click();
  await page.getByLabel("Agent name", { exact: true }).fill("Pending read draft");
  await page.getByRole("link", { name: "← Agents" }).click();
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  assert.equal(
    await page.getByLabel("Agent name", { exact: true }).inputValue(),
    "Pending read draft",
  );
});

test("invalid Preset application retains chooser edits and the applied form for both origins", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Invalid starter", { ready: true });
  const starter = await defaultPresetSummary(fixture, namespace.id);
  const defaults = await presetTemplate(fixture, namespace.id, starter.id);
  const template: PresetTemplate = {
    ...defaults,
    variables: { mode: { type: "string" } },
    agent: { ...defaults.agent, name: "Preset draft", executionMode: "{{ vars.mode }}" },
  };
  const updated = await fixture.request(
    "PATCH",
    `/namespaces/${namespace.id}/presets/${starter.id}`,
    { body: { template } },
  );
  assert.equal(updated.status, 200);

  const { page } = await newPage(t, fixture);
  await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
  for (const origin of ["shortcut", "explicit"]) {
    await page.getByRole("button", { name: "Create Agent", exact: true }).click();
    if (origin === "shortcut") {
      await page.getByRole("button", { name: "Start with default Preset", exact: true }).click();
    } else {
      await page.getByLabel("Preset template").selectOption(starter.id);
    }
    const mode = page.getByLabel("Mode", { exact: true });
    await mode.fill("invalid");
    await page.getByRole("button", { name: "Use Preset", exact: true }).click();
    await page
      .getByText(
        'Rendered Preset contains invalid Agent fields or Secret bindings: agent.executionMode must be "embedded" or "dedicated". Check the variables you entered, or ask a Preset editor to fix the template.',
      )
      .waitFor();
    await page.getByRole("link", { name: "← Agents" }).click();
    await page.getByRole("button", { name: "Create Agent", exact: true }).click();
    await mode.waitFor();
    assert.equal(await mode.inputValue(), "invalid", origin);

    await mode.fill("dedicated");
    await page.getByRole("button", { name: "Use Preset", exact: true }).click();
    await page.getByLabel("Agent name", { exact: true }).waitFor();
    await page.getByRole("link", { name: "← Agents" }).click();
    await page.getByRole("button", { name: "Create Agent", exact: true }).click();
    assert.equal(
      await page.getByLabel("Agent name", { exact: true }).inputValue(),
      "Preset draft",
      origin,
    );
    // The variables typed in the chooser are the form's changes: Cancel asks before discarding.
    const asked: string[] = [];
    const answer = async (dialog: Dialog) => {
      asked.push(dialog.message());
      await dialog.accept();
    };
    page.once("dialog", answer);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("button", { name: "Create Agent", exact: true }).waitFor();
    page.off("dialog", answer);
    assert.deepEqual(asked, ["Discard this draft?"], origin);
  }
});

test("failed Preset form construction retains chooser edits for both origins", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const { page } = await newPage(t, fixture);
  await login(page, fixture, "/console/agents");

  for (const origin of ["shortcut", "explicit"]) {
    const namespace = await fixture.createNamespace(`Invalid model ${origin}`, { ready: true });
    const starter = await defaultPresetSummary(fixture, namespace.id);
    const validTemplate = await presetTemplate(fixture, namespace.id, starter.id);
    const fallback: FixtureResponse<Preset> = await fixture.request(
      "POST",
      `/namespaces/${namespace.id}/presets`,
      {
        body: { name: "Usable fallback", template: validTemplate },
      },
    );
    assert.equal(fallback.status, 201);
    const configuration = validTemplate.configuration;
    const invalidTemplate: PresetTemplate = {
      ...validTemplate,
      variables: { marker: { type: "string" } },
      configuration: {
        ...configuration,
        values: { ...configuration?.values, agents: { defaults: { model: { primary: 42 } } } },
      },
    };
    // Preset save refuses a model that is not <provider>/<model> (finding 1828), but a Preset an
    // older release stored with one still reaches the form.
    const refused = await fixture.request(
      "PATCH",
      `/namespaces/${namespace.id}/presets/${starter.id}`,
      { body: { template: invalidTemplate } },
    );
    assert.equal(refused.status, 400);
    const stored = await fixture.controller.transact((state: PlatformUnitOfWork) =>
      state.presets.updatePreset(namespace.id, starter.id, { template: invalidTemplate }),
    );
    assert.ok(stored);

    await page.goto(`${fixture.origin}/console/agents/new?namespace=${namespace.id}`);
    if (origin === "shortcut") {
      await page.getByRole("button", { name: "Start with default Preset", exact: true }).click();
    } else {
      await page.getByLabel("Preset template").selectOption(starter.id);
    }
    const marker = page.getByLabel("Marker", { exact: true });
    await marker.fill(`draft ${origin}`);
    await page.getByRole("button", { name: "Use Preset", exact: true }).click();
    await page
      .getByRole("alert")
      .filter({ hasText: /startsWith/ })
      .waitFor();
    await page.getByRole("link", { name: "← Agents" }).click();
    await page.getByRole("button", { name: "Create Agent", exact: true }).click();
    await marker.waitFor();
    assert.equal(await marker.inputValue(), `draft ${origin}`, origin);
    await page.getByLabel("Preset template").selectOption(fallback.data.id);
    await page.getByRole("button", { name: "Use Preset", exact: true }).click();
    await page.getByLabel("Agent name", { exact: true }).waitFor();
  }
});

test("unsaved Preset drafts retain unfinished edits across navigation until explicit discard", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Draft navigation", { ready: true });
  const artifact = structuredClone(standardCodexPreset);
  const preset: FixtureResponse<Preset> = await fixture.request(
    "POST",
    `/namespaces/${namespace.id}/presets`,
    {
      body: artifact,
    },
  );
  assert.equal(preset.status, 201, JSON.stringify(preset.body));
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByLabel("Preset template").selectOption(preset.data.id);
  await page.getByLabel("Name", { exact: true }).fill("Navigation draft");
  await page.getByLabel("Model", { exact: true }).fill("gpt-5.1");
  await page.getByLabel("Model Secret", { exact: true }).fill("synthetic-navigation-key");
  await page.getByRole("link", { name: "← Agents" }).click();
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  assert.equal(await page.getByLabel("Name", { exact: true }).inputValue(), "Navigation draft");
  assert.equal(await page.getByLabel("Model", { exact: true }).inputValue(), "gpt-5.1");
  assert.equal(await page.getByLabel("Model Secret", { exact: true }).inputValue(), "");
  await page.getByLabel("Model Secret", { exact: true }).fill("synthetic-navigation-key");
  await page.getByRole("button", { name: "Use Preset" }).click();
  await openAdvancedSettings(page);
  const unfinished = '{"agents":';
  await page.getByLabel("Configuration JSON", { exact: true }).fill(unfinished);
  await page.getByLabel("USER.md", { exact: true }).fill("");
  await page.getByRole("link", { name: "← Agents" }).click();
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  await page.getByLabel("Agent name", { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel("Agent name", { exact: true }).inputValue(),
    "Navigation draft",
  );
  assert.equal(
    await page.getByLabel("Configuration JSON", { exact: true }).inputValue(),
    unfinished,
  );
  assert.equal(await page.getByLabel("USER.md", { exact: true }).inputValue(), "");
  // Navigation clears the transient password and requires a fresh Secret selection.
  assert.equal(await page.locator("#provider-api-key").inputValue(), "");
  const credentialSecret = page.getByLabel("API key Secret", { exact: true });
  await credentialSecret.waitFor();
  await page.waitForFunction(() => {
    const select = globalThis.document.querySelector<HTMLInputElement>(
      "#provider-credential-secret",
    );
    return select && !select.disabled && select.required;
  });
  assert.equal(await credentialSecret.inputValue(), "");
  assert.equal(
    await credentialSecret.evaluate((input: HTMLInputElement) => input.validity.valueMissing),
    true,
  );
  assert.deepEqual(await consoleStorage(page), { local: {}, session: {} });
  assert.equal(new URL(page.url()).search, `?namespace=${namespace.id}`);
  assert.deepEqual(nonAuthWriteRequests(requests), []);

  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Start over" }).click();
  assert.equal(
    await page.getByLabel("Configuration JSON", { exact: true }).inputValue(),
    unfinished,
  );
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Start over" }).click();
  await page.getByLabel("Preset template").waitFor();
  assert.equal(await page.getByLabel("Preset template").inputValue(), "");
  await page.getByRole("link", { name: "← Agents" }).click();
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  await page.getByLabel("Preset template").waitFor();
  assert.equal(await page.getByLabel("Agent name", { exact: true }).count(), 0);

  // Reload ends the SPA session; a new form must not recover discarded or browser-stored inputs.
  // The browser asks first while the draft holds changes.
  await page.getByRole("button", { name: "Start with default Preset" }).click();
  await page.getByLabel("Agent name", { exact: true }).fill("Reload-only draft");
  const leaving: string[] = [];
  const answer = async (dialog: Dialog) => {
    leaving.push(dialog.type());
    await dialog.accept();
  };
  page.once("dialog", answer);
  await page.reload();
  page.off("dialog", answer);
  assert.deepEqual(leaving, ["beforeunload"]);
  await page.getByLabel("Preset template").waitFor();
  assert.equal(await page.getByLabel("Agent name", { exact: true }).count(), 0);

  // Signing back in without reloading must not recover the previous session's in-memory draft.
  await page.getByRole("button", { name: "Start with default Preset" }).click();
  await page.getByLabel("Agent name", { exact: true }).fill("Private session draft");
  await page.locator(".account-toggle").click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await page.getByLabel("Email", { exact: true }).fill(fixture.credentials.email);
  await page.getByLabel("Password").fill(fixture.credentials.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  await page.getByLabel("Preset template").waitFor();
  assert.equal(await page.getByLabel("Agent name", { exact: true }).count(), 0);
});

test("an empty Namespace can create an Agent without a Preset", async (t) => {
  const fixture = await createConsoleAppFixture(t, {
    defaultPresets: [],
    filesystemConfiguration: true,
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("No Presets", { ready: true });
  const { page } = await newPage(t, fixture);
  await routeInstallationWithoutProvisioning(page, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByText(/^No Presets available to you in this Namespace\./).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Start with default Preset" }).isDisabled(),
    true,
  );
  await page.getByRole("button", { name: "Start without Preset" }).click();
  assert.equal(await page.getByLabel("Agent name", { exact: true }).inputValue(), "");
  await page.getByLabel("Agent name", { exact: true }).fill("Kept draft");
  // A form started without a Preset is kept across navigation, as a Preset form is.
  await page.getByRole("link", { name: "← Agents" }).click();
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  assert.equal(await page.getByLabel("Agent name", { exact: true }).inputValue(), "Kept draft");
  await page.getByLabel("Agent name", { exact: true }).fill("Agent without Preset");
  await enterManualModel(page, "no-preset-model-key", "gpt-4.1");
  const saved = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  assert.equal((await saved).status(), 201);
  assert.equal(
    requests.filter(
      (request) =>
        request.method === "GET" && request.path.startsWith(`/namespaces/${namespace.id}/presets/`),
    ).length,
    0,
  );
});

test("a delayed restored Preset list cannot read a selection after starting without a Preset", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Delayed Preset list", { ready: true });
  const starter = await defaultPresetSummary(fixture, namespace.id);
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  const selectedPresetResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/presets/${starter.id}` &&
      response.request().method() === "GET",
  );
  await page.getByLabel("Preset template").selectOption(starter.id);
  assert.equal((await selectedPresetResponse).status(), 200);
  await page.getByRole("button", { name: "Use Preset", exact: true }).click({ trial: true });
  assert.equal(await page.getByLabel("Preset template").inputValue(), starter.id);
  await page.getByRole("link", { name: "← Agents" }).click();

  // A real catalog change makes the admitted return construct a fresh chooser
  // with the retained selection. Do not hold its outer access revalidation.
  const added: FixtureResponse<Preset> = await fixture.request(
    "POST",
    `/namespaces/${namespace.id}/presets`,
    {
      body: {
        name: "Another Preset",
        template: await presetTemplate(fixture, namespace.id, starter.id),
      },
    },
  );
  assert.equal(added.status, 201, JSON.stringify(added.body));

  const { resolve: releaseList, promise: heldList } = Promise.withResolvers<void>();
  const { resolve: finishList, promise: listHandled } = Promise.withResolvers<void>();
  const listUrl = `${fixture.origin}/namespaces/${namespace.id}/presets`;
  const listPath = `**/namespaces/${namespace.id}/presets`;
  let routedLists = 0;
  let heldRequest: Request | undefined;
  await page.route(listPath, async (route) => {
    if (route.request().method() !== "GET" || ++routedLists !== 2) {
      await route.continue();
      return;
    }
    heldRequest = route.request();
    try {
      await heldList;
      await route.continue();
    } finally {
      finishList();
    }
  });
  let requestedLists = 0;
  const listStarted = page.waitForRequest(
    (request) => request.method() === "GET" && request.url() === listUrl && ++requestedLists === 2,
    { timeout: 10_000 },
  );
  const listResponse = page.waitForResponse(
    (response) => response.request() === heldRequest && response.url() === listUrl,
    { timeout: 10_000 },
  );
  // Observe timeout rejections while an earlier UI action is still pending.
  void listStarted.catch(() => {});
  void listResponse.catch(() => {});
  let exactReadsBeforeRelease;
  let pendingList;
  try {
    await page.getByRole("button", { name: "Create Agent", exact: true }).click();
    pendingList = await listStarted;
    await page.getByRole("button", { name: "Start without Preset" }).click();
    await page.getByLabel("Agent name", { exact: true }).fill("Independent Agent");
    assert.equal(heldRequest, pendingList);
    exactReadsBeforeRelease = requests.filter(
      (request) =>
        request.method === "GET" &&
        request.path === `/namespaces/${namespace.id}/presets/${starter.id}`,
    ).length;
  } finally {
    releaseList();
    if (heldRequest) {
      let timer;
      try {
        await Promise.race([
          listHandled,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("Held Preset route did not finish")), 10_000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
    await page.unroute(listPath);
  }
  const response = await listResponse;
  assert.equal(response.request(), pendingList);
  assert.equal(response.request().method(), "GET");
  assert.equal(response.status(), 200);
  const releasedPresets: PresetSummaryWire[] = (await response.json()).data;
  assert.ok(releasedPresets.some((preset) => preset.id === starter.id));
  assert.ok(releasedPresets.some((preset) => preset.id === added.data.id));
  await response.finished();
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
  assert.equal(
    requests.filter(
      (request) =>
        request.method === "GET" &&
        request.path === `/namespaces/${namespace.id}/presets/${starter.id}`,
    ).length,
    exactReadsBeforeRelease,
  );
  assert.equal(
    await page.getByLabel("Agent name", { exact: true }).inputValue(),
    "Independent Agent",
  );
  await page.getByLabel("Agent name", { exact: true }).fill("Still usable");
  assert.equal(await page.getByLabel("Agent name", { exact: true }).inputValue(), "Still usable");
});

test("denied Preset reads do not automatically start an Agent form", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Denied Preset", { ready: true });
  const starter = await defaultPresetSummary(fixture, namespace.id);
  const { page } = await newPage(t, fixture);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page
    .getByRole("button", { name: "Start with default Preset" })
    .waitFor({ state: "visible" });
  await page.waitForFunction(
    () => globalThis.document.querySelector<HTMLSelectElement>("#agent-preset")?.disabled === false,
  );
  // Deny the exact read after the list is visible to exercise a changed grant.
  fixture.policy.restrictions.push({
    id: "deny-selected-preset",
    namespaceId: namespace.id,
    resourceKind: "preset",
    resourceId: starter.id,
    action: "read",
    effect: "deny",
  });
  const denied = page.waitForResponse((response) =>
    response.url().endsWith(`/namespaces/${namespace.id}/presets/${starter.id}`),
  );
  await page.getByRole("button", { name: "Start with default Preset" }).click();
  assert.equal((await denied).status(), 403);
  await page.getByRole("alert").filter({ hasText: "Access denied" }).waitFor();
  assert.equal(await page.locator("#create-agent-form").count(), 0);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  assert.equal(await page.getByLabel("Agent name", { exact: true }).inputValue(), "");
  // A later list filters the now-unreadable Preset; the independent action remains available.
  // Cancel discards the untouched form without asking.
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  await page.getByText(/^No Presets available to you in this Namespace\./).waitFor();
  await page.getByRole("button", { name: "Start without Preset" }).click();
  assert.equal(await page.getByLabel("Agent name", { exact: true }).inputValue(), "");
});

test("The console requires a readable installed default for quick-start and still allows other Presets", async (t) => {
  const fixture = await createConsoleAppFixture(t, {
    defaultPresets: [],
    filesystemConfiguration: true,
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("No installed starter", { ready: true });
  const alternative: FixtureResponse<Preset> = await fixture.request(
    "POST",
    `/namespaces/${namespace.id}/presets`,
    {
      body: { name: "Custom starter", template: { agent: { name: "Custom Agent" } } },
    },
  );
  assert.equal(alternative.status, 201);
  const { page } = await newPage(t, fixture);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page
    .getByText("Choose a Preset. default-codex is not available to you in this Namespace.", {
      exact: true,
    })
    .waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Start with default Preset" }).isDisabled(),
    true,
  );
  await page.getByLabel("Preset template", { exact: true }).selectOption(alternative.data.id);
  await page.getByRole("button", { name: "Use Preset" }).click();
  assert.equal(await page.getByLabel("Agent name", { exact: true }).inputValue(), "Custom Agent");
});

test("Preset with a managed PAT account creates a draft without a Secret grant", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Managed account Preset", { ready: true });
  // Account issuance is outside this browser test. Association before issuance is
  // supported; this proves Preset rendering and draft creation, not deployment.
  const account = await fixture.controller.transact((state: PlatformUnitOfWork) =>
    state.serviceAccounts.createServiceAccount({
      id: `sa_${crypto.randomUUID()}`,
      namespaceId: namespace.id,
      name: "Preset research account",
    }),
  );
  const harnessAuth = {
    method: "codex_pat",
    source: { kind: "service_account", namespaceId: namespace.id, id: account.id },
  } satisfies HarnessAuthBinding;
  const artifact = structuredClone(standardCodexPreset);
  delete artifact.template.variables.modelSecret;
  artifact.template.agent.harnessAuth = harnessAuth;
  const preset: FixtureResponse<Preset> = await fixture.request(
    "POST",
    `/namespaces/${namespace.id}/presets`,
    {
      body: artifact,
    },
  );
  assert.equal(preset.status, 201, JSON.stringify(preset.body));
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByLabel("Preset template").selectOption(preset.data.id);
  await page.getByLabel("Name", { exact: true }).fill("Managed PAT Preset Agent");
  await page.getByLabel("Model", { exact: true }).fill("gpt-5.1");
  await page.getByRole("button", { name: "Use Preset" }).click();
  const createdResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/namespaces/${namespace.id}/agents`) &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  const created = await createdAgent(createdResponse);
  await page.waitForURL((url) => url.pathname === `/console/agents/${created.id}`);
  assert.deepEqual(created.harnessAuth, harnessAuth);
  assert.equal(
    requests.some(
      (request) => request.method === "POST" && request.path.endsWith("/access-bindings"),
    ),
    false,
  );
  assert.equal(secretPostRequests(requests, namespace.id).length, 0);
});

// The chooser's Start with default Preset named no Preset, and after a Preset was chosen Use
// Preset stayed secondary while the shortcut kept the filled style (finding 2066).
test("the Preset chooser names its default and fills Use Preset once a Preset is chosen", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Preset emphasis", { ready: true });
  const other: FixtureResponse<Preset> = await fixture.request(
    "POST",
    `/namespaces/${namespace.id}/presets`,
    {
      body: {
        name: "Team Preset",
        template: {
          variables: { agentName: { type: "string" } },
          agent: { name: "{{ vars.agentName }}", executionMode: "embedded" },
        },
      },
    },
  );
  assert.equal(other.status, 201, JSON.stringify(other.body));
  const { page } = await newPage(t, fixture);
  await routeInstallationWithoutProvisioning(page, fixture);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  const shortcut = page.getByRole("button", { name: "Start with default Preset" });
  const use = page.getByRole("button", { name: "Use Preset" });
  const filled = (locator: Locator) =>
    locator.evaluate((node) => node.classList.contains("button--primary"));
  await page.getByText("The default Preset is default-codex.", { exact: true }).waitFor();
  assert.equal(await shortcut.getAttribute("aria-describedby"), "agent-preset-default-hint");
  await waitForEnabled(shortcut);
  assert.deepEqual([await filled(shortcut), await filled(use)], [true, false]);

  await page.getByLabel("Preset template").selectOption(other.data.id);
  await page.getByLabel("Agent Name", { exact: true }).waitFor();
  assert.deepEqual([await filled(shortcut), await filled(use)], [false, true]);

  // Clearing the choice gives the filled style back to the shortcut.
  await page.getByLabel("Preset template").selectOption("");
  await page.getByLabel("Agent Name", { exact: true }).waitFor({ state: "detached" });
  assert.deepEqual([await filled(shortcut), await filled(use)], [true, false]);

  // A failed Preset read leaves Use Preset disabled, so the shortcut keeps the filled style.
  await page.route(`**/namespaces/${namespace.id}/presets/${other.data.id}`, (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "DEPENDENCY_UNAVAILABLE", message: "Preset storage is unavailable." },
      }),
    }),
  );
  await page.getByLabel("Preset template").selectOption(other.data.id);
  await page
    .getByText("Service unavailable. The read could not be completed. Try again.")
    .waitFor();
  assert.equal(await use.isDisabled(), true);
  assert.deepEqual([await filled(shortcut), await filled(use)], [true, false]);
});
