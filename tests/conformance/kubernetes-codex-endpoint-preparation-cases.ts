import assert from "node:assert/strict";
import type { KubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import {
  admitLoggingConfiguration,
  type AgentRevision,
  type SecretReference,
} from "../../packages/contracts/src/index.ts";
import { resolveConfiguredHarnessId } from "../../packages/occ/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { apiKeyAuth } from "../helpers/kubernetes-routed-scenarios.mjs";
import type { createDedicatedDeployKubernetesFixture } from "./kubernetes-dedicated-deploy-fixture.ts";
import { renderedRecord } from "./kubernetes-workspace-node-delivery-cases.ts";

type DeployTransport = ReturnType<typeof createDedicatedDeployKubernetesFixture>;
type EndpointPreparationFixture = Pick<DeployTransport, "objects" | "read"> & {
  revision: Omit<AgentRevision, "configuration"> & {
    configuration: AgentRevision["configuration"];
  };
  prepare: () => ReturnType<KubernetesComputeDriver["prepareRevision"]>;
};
type EndpointPreparationFixtureFactory = (options: {
  modelEndpoint: string;
  standaloneWebSearch?: boolean | undefined;
  revision?: {
    harnessAuth: Extract<
      AgentRevision["harnessAuth"],
      {
        method: "codex_pat";
        source: SecretReference;
      }
    >;
  };
}) => EndpointPreparationFixture;

function writtenConfigMap(objects: DeployTransport["objects"], field: string) {
  for (const object of objects.values()) {
    if (object.kind === "ConfigMap") {
      const data = asRecord(object.data);
      if (data !== undefined && data[field] !== undefined) {
        const decoded: unknown = JSON.parse(configMapText(data, field));
        return { name: object.metadata.name, data, document: renderedRecord(decoded, field) };
      }
    }
  }
  assert.fail(`expected a written ConfigMap with ${field}`);
}

function configMapText(data: Record<string, unknown>, field: string) {
  const text = data[field];
  assert.ok(typeof text === "string", `expected ConfigMap field ${field} to contain text`);
  return text;
}

function codexBridgePlugins(model: string) {
  const { plugins } = createHarnessConfiguration("codex", model);
  assert.ok(plugins, "expected the Codex WebSocket bridge");
  return plugins;
}

function renderedAgentSettings(objects: DeployTransport["objects"]) {
  const { document } = writtenConfigMap(objects, "openclaw.json");
  const agents = renderedRecord(document.agents, "rendered agents");
  const defaults = renderedRecord(agents.defaults, "rendered agent defaults");
  const entries = renderedRecord(agents.entries, "rendered agent entries");
  const main = renderedRecord(entries.main, "main agent entry");
  return { document, defaults, entries, main };
}

function renderedModels(provider: unknown) {
  const { models } = renderedRecord(provider, "Codex provider");
  assert.ok(Array.isArray(models), "expected a Codex model catalog");
  const rows: readonly unknown[] = models;
  return rows.map((value) => {
    const row = renderedRecord(value, "Codex model row");
    const { id } = row;
    assert.ok(typeof id === "string", "expected a string Codex model ID");
    return { ...row, id };
  });
}

function sortByModelId<T extends { id: string }>(models: readonly T[]) {
  return models.toSorted((left, right) => left.id.localeCompare(right.id));
}

export async function checkExplicitCodexProviderProjection(
  createFixture: EndpointPreparationFixtureFactory,
) {
  for (const sourceProvider of ["codex", "openai"]) {
    const fixture = createFixture({
      modelEndpoint: "https://MODELS.example.test:443/api/v1/",
    });
    const primary = `${sourceProvider}/vendor/organization/model`;
    const fallback = `${sourceProvider}/codex/native`;
    const plain = `${sourceProvider}/plain-model`;
    const child = `${sourceProvider}/vendor/organization/child`;
    const childFallback = `${sourceProvider}/codex/child-fallback`;
    const childSelection = { primary: child, fallbacks: [childFallback, "primary"] };
    const settings = {
      model: { primary, fallbacks: [fallback, plain] },
      models: {
        [primary]: { agentRuntime: { id: "codex" }, alias: "primary" },
        [fallback]: { agentRuntime: { id: "codex" }, alias: sourceProvider },
        [plain]: { agentRuntime: { id: "codex" } },
        [`${sourceProvider}/*`]: { agentRuntime: { id: "codex" } },
      },
    };
    fixture.revision.configuration = admitLoggingConfiguration(
      {
        ...fixture.revision.configuration,
        // OpenAI-prefixed native selections require the explicit Codex WebSocket bridge.
        plugins: codexBridgePlugins("vendor/organization/model"),
        agents: {
          ownership: "explicit",
          defaults: {
            ...structuredClone(settings),
            model: sourceProvider === "openai" ? primary : structuredClone(settings.model),
            subagents: {
              model: sourceProvider === "codex" ? child : structuredClone(childSelection),
            },
          },
          entries: {
            main: {
              ...structuredClone(settings),
              subagents: {
                model: sourceProvider === "codex" ? structuredClone(childSelection) : child,
              },
            },
            alias: { subagents: { model: "primary" } },
            providerAlias: { subagents: { model: sourceProvider } },
            inherited: {},
          },
        },
        models: {
          providers: {
            [sourceProvider]: {
              agentRuntime: { id: "codex" },
              api: "openai-responses",
              baseUrl: "http://127.0.0.1:9",
              models: [
                { id: "vendor/organization/model", name: "Primary model", contextWindow: 32000 },
                // Full OCE catalog refs must not strip the native "codex/" namespace.
                { id: fallback, name: "Fallback model" },
                { id: "plain-model", name: "Plain model" },
              ],
            },
          },
        },
      },
      "info",
    );
    const admitted = structuredClone(fixture.revision.configuration);
    assert.equal(resolveConfiguredHarnessId(admitted), "codex");
    await fixture.prepare();
    const { document, defaults, entries, main } = renderedAgentSettings(fixture.objects);
    const qualified = "codex/openai-compatible/";
    const expectedSelection = {
      primary: `${qualified}vendor/organization/model`,
      fallbacks: [`${qualified}codex/native`, `${qualified}plain-model`],
    };
    assert.deepEqual(
      defaults.model,
      sourceProvider === "openai" ? expectedSelection.primary : expectedSelection,
    );
    assert.deepEqual(main.model, expectedSelection);
    const expectedChild = `${qualified}vendor/organization/child`;
    const expectedChildSelection = {
      primary: expectedChild,
      fallbacks: [`${qualified}codex/child-fallback`, "primary"],
    };
    assert.deepEqual(
      renderedRecord(defaults.subagents, "default subagents").model,
      sourceProvider === "codex" ? expectedChild : expectedChildSelection,
    );
    assert.deepEqual(
      renderedRecord(main.subagents, "main subagents").model,
      sourceProvider === "codex" ? expectedChildSelection : expectedChild,
    );
    const alias = renderedRecord(entries.alias, "alias agent entry");
    const providerAlias = renderedRecord(entries.providerAlias, "provider alias agent entry");
    assert.equal(renderedRecord(alias.subagents, "alias subagents").model, "primary");
    assert.equal(
      renderedRecord(providerAlias.subagents, "provider alias subagents").model,
      sourceProvider,
    );
    assert.equal(renderedRecord(entries.inherited, "inherited agent entry").subagents, undefined);
    for (const actual of [defaults, main]) {
      const models = renderedRecord(actual.models, "rendered agent model settings");
      assert.deepEqual(Object.keys(models), [
        `${qualified}vendor/organization/model`,
        `${qualified}codex/native`,
        `${qualified}plain-model`,
        `${qualified}*`,
      ]);
      assert.equal(
        renderedRecord(models[`${qualified}vendor/organization/model`], "primary model settings")
          .alias,
        "primary",
      );
    }
    const models = renderedRecord(document.models, "rendered model settings");
    const providers = renderedRecord(models.providers, "rendered model providers");
    assert.deepEqual(
      sortByModelId(renderedModels(providers.codex)),
      sortByModelId([
        {
          id: "openai-compatible/vendor/organization/model",
          name: "Primary model",
          contextWindow: 32000,
        },
        { id: "openai-compatible/codex/native", name: "Fallback model" },
        { id: "openai-compatible/plain-model", name: "Plain model" },
        {
          id: "openai-compatible/vendor/organization/child",
          name: "vendor/organization/child",
        },
        { id: "openai-compatible/codex/child-fallback", name: "codex/child-fallback" },
      ]),
    );
    assert.deepEqual(fixture.revision.configuration, admitted);
    const runtime = writtenConfigMap(fixture.objects, "runtime.json");
    assert.deepEqual(runtime.document.modelEndpoint, {
      baseUrl: "https://models.example.test/api/v1",
      modelProvider: "openai-compatible",
    });
  }
}

export async function checkStandaloneSearchOptIn(createFixture: EndpointPreparationFixtureFactory) {
  for (const standaloneWebSearch of [undefined, false, true]) {
    const fixture = createFixture({
      modelEndpoint: "https://models.example.test/v1",
      standaloneWebSearch,
    });
    await fixture.prepare();
    const runtime = writtenConfigMap(fixture.objects, "runtime.json");
    assert.deepEqual(runtime.document.modelEndpoint, {
      baseUrl: "https://models.example.test/v1",
      modelProvider: "openai-compatible",
      ...(standaloneWebSearch === true ? { supportsStandaloneWebSearch: true } : {}),
    });
    const config = configMapText(runtime.data, "config.toml");
    assert.match(config, /model_provider = "openai-compatible"/);
    assert.match(config, /\[model_providers\.openai-compatible\]/);
    assert.match(config, /requires_openai_auth = true/);
    assert.equal(
      config.includes("supports_standalone_web_search = true"),
      standaloneWebSearch === true,
    );
    assert.equal(config.includes('web_search = "disabled"'), false);
    const admitted = structuredClone(fixture.revision.configuration);
    await fixture.prepare();
    assert.deepEqual(fixture.revision.configuration, admitted);
    const retried = fixture.read("ConfigMap", runtime.name);
    assert.deepEqual(retried.data, runtime.data);
  }
}

export async function checkAccountLoginProviderIsolation(
  createFixture: EndpointPreparationFixtureFactory,
) {
  const { kind, ...source } = apiKeyAuth.source;
  assert.ok(kind === "secret", "expected the shared credential fixture to use a Secret");
  const fixture = createFixture({
    modelEndpoint: "https://models.example.test/v1",
    standaloneWebSearch: true,
    revision: { harnessAuth: { ...apiKeyAuth, method: "codex_pat", source: { ...source, kind } } },
  });
  await fixture.prepare();
  const runtime = writtenConfigMap(fixture.objects, "runtime.json");
  assert.equal(runtime.document.modelEndpoint, undefined);
  const config = configMapText(runtime.data, "config.toml");
  assert.equal(config.includes("supports_standalone_web_search"), false);
  assert.equal(config.includes("model_provider"), false);
}

// Finding 1297: the projection covers every setting the Harness model rule checks, not only
// model and subagents.model. An openai source's provider block is dropped, so no selection
// may be left on it.
export async function checkNonPrimaryModelQualification(
  createFixture: EndpointPreparationFixtureFactory,
) {
  for (const sourceProvider of ["codex", "openai"]) {
    const fixture = createFixture({
      modelEndpoint: "https://models.example.test/v1",
    });
    const ref = (id: string) => `${sourceProvider}/${id}`;
    const nonPrimary = {
      imageModel: { primary: ref("image"), fallbacks: [ref("image-fallback"), "small"] },
      pdfModel: ref("pdf"),
      utilityModel: ref("utility"),
      heartbeat: { model: ref("small") },
      compaction: { model: ref("small") },
      tts: { summaryModel: ref("summary") },
      // Finding 1306: the /model allowlist, which OpenClaw honors over the models keys.
      modelPolicy: { allow: [ref("gpt-5"), ref("small"), ref("allow-only")] },
    };
    fixture.revision.configuration = admitLoggingConfiguration(
      {
        ...fixture.revision.configuration,
        plugins: codexBridgePlugins("gpt-5"),
        agents: {
          ownership: "explicit",
          defaults: {
            model: ref("gpt-5"),
            models: { [ref("small")]: { alias: "small" } },
            ...structuredClone(nonPrimary),
          },
          entries: {
            main: {
              heartbeat: { model: ref("entry-heartbeat") },
              models: { [ref("entry-policy")]: {}, [ref("small")]: { alias: "entry-small" } },
              modelPolicy: { allow: [ref("gpt-5"), ref("entry-allow/*")] },
            },
            // An entry whose only model setting is its policy map.
            helper: { models: { [ref("helper-policy")]: {} } },
          },
        },
        tools: { exec: { reviewer: { model: ref("reviewer") } } },
        hooks: { gmail: { model: ref("gmail") }, mappings: [{ model: ref("hook") }] },
        channels: { modelByChannel: { slack: { C1: ref("channel") } } },
        models: {
          providers: {
            [sourceProvider]: {
              agentRuntime: { id: "codex" },
              api: "openai-responses",
              baseUrl: "http://127.0.0.1:9",
              models: [
                { id: "gpt-5", name: "Primary model" },
                { id: "small", name: "Small model", contextWindow: 16000 },
              ],
            },
          },
        },
      },
      "info",
    );
    const admitted = structuredClone(fixture.revision.configuration);
    await fixture.prepare();
    const { document, defaults, entries, main } = renderedAgentSettings(fixture.objects);
    const qualified = (id: string) => `codex/openai-compatible/${id}`;
    assert.equal(defaults.model, qualified("gpt-5"));
    assert.deepEqual(defaults.imageModel, {
      primary: qualified("image"),
      fallbacks: [qualified("image-fallback"), "small"],
    });
    assert.equal(defaults.pdfModel, qualified("pdf"));
    assert.equal(defaults.utilityModel, qualified("utility"));
    assert.deepEqual(defaults.heartbeat, { model: qualified("small") });
    assert.deepEqual(defaults.compaction, { model: qualified("small") });
    assert.deepEqual(defaults.tts, { summaryModel: qualified("summary") });
    // An allowlist entry is qualified like a policy key, so /model back to the projected
    // primary is allowed; one with no catalog row adds none.
    assert.deepEqual(defaults.modelPolicy, {
      allow: [qualified("gpt-5"), qualified("small"), qualified("allow-only")],
    });
    assert.deepEqual(main.modelPolicy, {
      allow: [qualified("gpt-5"), qualified("entry-allow/*")],
    });
    assert.deepEqual(Object.keys(renderedRecord(defaults.models, "default model settings")), [
      qualified("small"),
    ]);
    assert.deepEqual(main.heartbeat, {
      model: qualified("entry-heartbeat"),
    });
    assert.deepEqual(main.models, {
      [qualified("entry-policy")]: {},
      [qualified("small")]: { alias: "entry-small" },
    });
    assert.deepEqual(renderedRecord(entries.helper, "helper agent entry").models, {
      [qualified("helper-policy")]: {},
    });
    const tools = renderedRecord(document.tools, "rendered tools");
    const exec = renderedRecord(tools.exec, "exec tool settings");
    assert.equal(renderedRecord(exec.reviewer, "exec reviewer").model, qualified("reviewer"));
    const hooks = renderedRecord(document.hooks, "rendered hooks");
    assert.equal(renderedRecord(hooks.gmail, "Gmail hook").model, qualified("gmail"));
    assert.ok(Array.isArray(hooks.mappings), "expected hook mappings");
    const mappings: readonly unknown[] = hooks.mappings;
    assert.equal(renderedRecord(mappings[0], "first hook mapping").model, qualified("hook"));
    const channels = renderedRecord(document.channels, "rendered channels");
    assert.deepEqual(channels.modelByChannel, { slack: { C1: qualified("channel") } });
    const models = renderedRecord(document.models, "rendered model settings");
    const providers = renderedRecord(models.providers, "rendered model providers");
    assert.deepEqual(Object.keys(providers), ["codex"]);
    assert.deepEqual(
      sortByModelId(renderedModels(providers.codex)),
      sortByModelId([
        { id: "openai-compatible/gpt-5", name: "Primary model" },
        { id: "openai-compatible/small", name: "Small model", contextWindow: 16000 },
        ...["image", "image-fallback", "pdf", "utility", "summary", "gmail", "hook", "channel"].map(
          (id) => ({
            id: `openai-compatible/${id}`,
            name: id,
          }),
        ),
        { id: "openai-compatible/entry-heartbeat", name: "entry-heartbeat" },
        { id: "openai-compatible/reviewer", name: "reviewer" },
      ]),
    );
    assert.deepEqual(fixture.revision.configuration, admitted);
  }
}
