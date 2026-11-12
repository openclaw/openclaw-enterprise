import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  presetTemplateDefaultsWithPlaceholders,
  renderPresetTemplate,
  validatePresetTemplate,
  type Configuration,
  type ConfigurationDriver,
  type OpenClawConfigurationDocument,
  type OpenClawConfigurationValue,
  type PresetDraftTemplate,
  type PresetVariable,
} from "../../packages/contracts/src/index.ts";
import { GatewayPasswordValueError } from "../../packages/occ/src/index.ts";
import { FilesystemConfigurationDriver } from "../../apps/controller/src/drivers/configuration/filesystem/index.ts";
import { KubernetesConfigurationDriver } from "../../apps/controller/src/drivers/configuration/kubernetes/index.ts";
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import { databaseUrl, requiresPostgres, testPool } from "../helpers/postgres-database.mjs";
import {
  defaultAgentConfigurationValues,
  request,
  startController,
} from "../helpers/postgres-platform-state.mjs";

type Controller = Awaited<ReturnType<typeof startController>>;
interface Response {
  readonly status: number;
  readonly data: unknown;
  readonly error: unknown;
}
const identifier = (kind: string): string => kind + "_" + randomUUID();
const environmentReference = "$" + "{OPENCLAW_GATEWAY_PASSWORD}";
const placeholder = "{{ vars.gatewayPasswordRef }}";
const literalPassword = "preset-fixture-" + randomUUID();

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function response(value: unknown): Response {
  const body = record(value);
  assert.equal(typeof body.status, "number");
  return { status: body.status as number, data: body.data, error: body.error };
}
async function http(
  api: Controller,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return response(await request(api, method, path, body));
}
function resourceId(value: Response): string {
  const id = record(value.data).id;
  assert.equal(typeof id, "string");
  return id as string;
}
function assertInvalid(value: Response, message: string): void {
  assert.equal(value.status, 400);
  const error = record(value.error);
  assert.equal(error.code, "INVALID_REQUEST");
  assert.equal(typeof error.message, "string");
  assert.ok((error.message as string).includes(message));
}
function passwordValues(password: OpenClawConfigurationValue): OpenClawConfigurationDocument {
  return {
    ...defaultAgentConfigurationValues,
    gateway: { ...defaultAgentConfigurationValues.gateway, auth: { password } },
  };
}
function passwordTemplate(
  password: OpenClawConfigurationValue = placeholder,
  variable: PresetVariable = { type: "string" },
): PresetDraftTemplate {
  return {
    variables: { gatewayPasswordRef: variable },
    configuration: { values: passwordValues(password) },
  };
}
function partial(template: PresetDraftTemplate) {
  const result = presetTemplateDefaultsWithPlaceholders(validatePresetTemplate(template));
  assert.ok(result.settings.configuration?.values);
  return { values: result.settings.configuration.values, options: result };
}
function configuration(values: OpenClawConfigurationDocument): Configuration {
  return {
    id: identifier("cfg"),
    namespaceId: identifier("ns"),
    kind: "agent",
    generation: 1,
    createdAt: new Date().toISOString(),
    values,
  };
}
async function fixture(context: TestContext) {
  assert.ok(databaseUrl, "The selected PostgreSQL lane must supply its owned database.");
  const api = await startController(context);
  const state = new PostgresPlatformState(testPool(context, { connectionString: databaseUrl }));
  const namespace = {
    id: identifier("ns"),
    name: "Preset validation " + randomUUID(),
    status: "ready" as const,
    createdAt: new Date().toISOString(),
  };
  await state.transact((store) => store.namespaces.createNamespace(namespace));
  return { api, state, namespaceId: namespace.id, path: "/namespaces/" + namespace.id };
}
async function successfulMutations(
  state: PostgresPlatformState,
  namespaceId: string,
  kind: "preset" | "configuration" | "agent",
): Promise<readonly string[]> {
  return state.transact(async (store) =>
    (await store.audit.list())
      .filter(
        (event) =>
          event.namespaceId === namespaceId &&
          event.kind === "mutation" &&
          event.outcome === "success" &&
          event.resource.kind === kind,
      )
      .map((event) => event.id),
  );
}
function presetTemplate(value: Response): PresetDraftTemplate {
  return validatePresetTemplate(record(value.data).template);
}
async function driverCases(driver: ConfigurationDriver): Promise<void> {
  assert.ok(driver.validateValues);
  const required = passwordTemplate();
  const rendered = partial(required);
  const original = structuredClone(rendered.values);
  // The real partial renderer identifies this exact location and its declared scalar type.
  await driver.validateValues(rendered.values, rendered.options);
  assert.deepEqual(rendered.values, original);
  await driver.validateValues(passwordValues(environmentReference));
  await driver.validate(configuration(passwordValues(environmentReference)));
  const defaultReference = partial(
    passwordTemplate(placeholder, {
      type: "string",
      default: environmentReference,
    }),
  );
  await driver.validateValues(defaultReference.values, defaultReference.options);

  const otherPath: PresetDraftTemplate = {
    variables: { gatewayPasswordRef: { type: "string" } },
    configuration: {
      values: {
        ...passwordValues("\\" + placeholder),
        fixture: { other: placeholder },
      },
    },
  };
  const refused: readonly PresetDraftTemplate[] = [
    passwordTemplate(literalPassword),
    passwordTemplate("\\" + placeholder),
    otherPath,
    passwordTemplate(placeholder, { type: "number" }),
    passwordTemplate(placeholder, { type: "boolean" }),
    passwordTemplate(placeholder, { type: "string", default: literalPassword }),
    passwordTemplate(placeholder, { type: "string", default: "{{ vars.other }}" }),
    passwordTemplate("prefix-" + placeholder),
  ];
  const fieldError = (error: unknown): boolean =>
    error instanceof GatewayPasswordValueError && error.path === "/gateway/auth/password";
  for (const candidate of refused) {
    const renderedCandidate = partial(candidate);
    await assert.rejects(
      driver.validateValues(renderedCandidate.values, renderedCandidate.options),
      fieldError,
    );
  }
  // Text alone cannot manufacture renderer-owned metadata.
  await assert.rejects(driver.validateValues(rendered.values), fieldError);
  await assert.rejects(driver.validate(configuration(passwordValues(literalPassword))), fieldError);
}

test(
  "shipped Preset API distinguishes literal launch text from variable tokens through PostgreSQL",
  requiresPostgres,
  async (context) => {
    const { api, state, namespaceId, path } = await fixture(context);
    const collection = path + "/presets";
    const oldTemplate = { agent: { executionMode: "embedded" } };
    const replacement = await http(api, "POST", collection, {
      name: "Replacement",
      template: oldTemplate,
    });
    assert.equal(replacement.status, 201);
    const replacementId = resourceId(replacement);
    const before = await state.read((store) => store.presets.listPresets(namespaceId));
    const beforeAudit = await successfulMutations(state, namespaceId, "preset");
    const badTemplate = { agent: { executionMode: "{{" } };
    const created = await http(api, "POST", collection, {
      name: "Literal opening braces",
      template: badTemplate,
    });
    const patched = await http(api, "PATCH", collection + "/" + replacementId, {
      template: badTemplate,
    });
    const after = await state.read((store) => store.presets.listPresets(namespaceId));
    const stored = await state.read((store) =>
      store.presets.findPreset(namespaceId, replacementId),
    );
    context.diagnostic(
      JSON.stringify({
        oracle: "launch-literal",
        postStatus: created.status,
        patchStatus: patched.status,
        beforeCount: before.length,
        afterCount: after.length,
        patchPreserved: JSON.stringify(stored?.template) === JSON.stringify(oldTemplate),
      }),
    );
    const message = 'Preset agent.executionMode: must be "embedded" or "dedicated".';
    assertInvalid(created, message);
    assertInvalid(patched, message);
    assert.deepEqual(after, before);
    assert.deepEqual(await successfulMutations(state, namespaceId, "preset"), beforeAudit);
    assert.deepEqual(stored?.template, oldTemplate);
    assert.deepEqual(
      presetTemplate(await http(api, "GET", collection + "/" + replacementId)),
      oldTemplate,
    );

    for (const mode of ["turbo", "{{ other }}", "\\" + "{{ vars.mode }}"]) {
      const beforeRefusal = await state.read((store) => store.presets.listPresets(namespaceId));
      const refused = await http(api, "POST", collection, {
        name: "Refused " + randomUUID(),
        template: { variables: { mode: { type: "string" } }, agent: { executionMode: mode } },
      });
      assertInvalid(refused, message);
      assert.deepEqual(
        await state.read((store) => store.presets.listPresets(namespaceId)),
        beforeRefusal,
      );
    }
    for (const expression of ["{{ vars.missing }}", "{{ vars.mode", "{{ vars.mode | upper }}"]) {
      const refused = await http(api, "POST", collection, {
        name: "Invalid variable syntax " + randomUUID(),
        template: {
          variables: { mode: { type: "string" } },
          agent: { executionMode: expression },
        },
      });
      assertInvalid(refused, "Preset agent.executionMode:");
    }
    for (const mode of ["embedded", "dedicated"]) {
      assert.equal(
        (
          await http(api, "POST", collection, {
            name: "Literal " + mode,
            template: {
              agent: { name: "Valid launch name", executionMode: mode, backendId: null },
            },
          })
        ).status,
        201,
      );
    }
    for (const definition of [
      { type: "string" as const },
      { type: "string" as const, default: "turbo" },
    ]) {
      const saved = await http(api, "POST", collection, {
        name: "Variable " + randomUUID(),
        template: {
          variables: { mode: definition },
          agent: { executionMode: "{{ vars.mode }}" },
        },
      });
      assert.equal(saved.status, 201);
      const draft = presetTemplate(await http(api, "GET", collection + "/" + resourceId(saved)));
      const config = await http(api, "POST", path + "/configurations", {
        kind: "agent",
        values: defaultAgentConfigurationValues,
      });
      assert.equal(config.status, 201);
      const configurationId = resourceId(config);
      const beforeAgents = await state.read((store) => store.agents.listAgents(namespaceId));
      const invalid = renderPresetTemplate(draft, { mode: "turbo" });
      assert.equal(invalid.agent?.executionMode, "turbo");
      const refused = await http(api, "POST", path + "/agents", {
        ...invalid.agent,
        name: "Rejected concrete Agent",
        configurationId,
      });
      assert.equal(refused.status, 400);
      assert.deepEqual(
        await state.read((store) => store.agents.listAgents(namespaceId)),
        beforeAgents,
      );
      const valid = renderPresetTemplate(draft, { mode: "embedded" });
      const agent = await http(api, "POST", path + "/agents", {
        ...valid.agent,
        name: "Accepted concrete Agent " + randomUUID(),
        configurationId,
      });
      assert.equal(agent.status, 201);
      const storedAgent = await state.read((store) =>
        store.agents.findAgent(namespaceId, resourceId(agent)),
      );
      assert.equal(storedAgent?.configurationId, configurationId);
      assert.equal(storedAgent?.executionMode, "embedded");
    }
  },
);

test(
  "shipped Preset API preserves gateway password reference placeholders through PostgreSQL",
  requiresPostgres,
  async (context) => {
    const { api, state, namespaceId, path } = await fixture(context);
    const collection = path + "/presets";
    const template = passwordTemplate();
    const replacement = await http(api, "POST", collection, {
      name: "Replacement",
      template: {},
    });
    assert.equal(replacement.status, 201);
    const replacementId = resourceId(replacement);
    const created = await http(api, "POST", collection, { name: "Required reference", template });
    const patched = await http(api, "PATCH", collection + "/" + replacementId, { template });
    context.diagnostic(
      JSON.stringify({
        oracle: "password-placeholder",
        postStatus: created.status,
        patchStatus: patched.status,
        postErrorCode: created.status === 400 ? record(created.error).code : undefined,
        patchErrorCode: patched.status === 400 ? record(patched.error).code : undefined,
      }),
    );
    assert.equal(created.status, 201);
    assert.equal(patched.status, 200);
    for (const id of [resourceId(created), replacementId]) {
      assert.deepEqual(presetTemplate(await http(api, "GET", collection + "/" + id)), template);
      assert.deepEqual(
        (await state.read((store) => store.presets.findPreset(namespaceId, id)))?.template,
        template,
      );
    }

    const refusedTemplates: readonly PresetDraftTemplate[] = [
      passwordTemplate(literalPassword),
      passwordTemplate(placeholder, { type: "number" }),
      passwordTemplate(placeholder, { type: "boolean" }),
      passwordTemplate(placeholder, { type: "string", default: literalPassword }),
      passwordTemplate(placeholder, { type: "string", default: "{{ vars.other }}" }),
      passwordTemplate("\\" + placeholder),
      {
        variables: { gatewayPasswordRef: { type: "string" } },
        configuration: {
          values: { ...passwordValues("\\" + placeholder), fixture: { other: placeholder } },
        },
      },
    ];
    for (const refusedTemplate of refusedTemplates) {
      const before = await state.read((store) => store.presets.listPresets(namespaceId));
      const refused = await http(api, "POST", collection, {
        name: "Refused reference " + randomUUID(),
        template: refusedTemplate,
      });
      assertInvalid(refused, "/gateway/auth/password");
      assertInvalid(
        await http(api, "PATCH", collection + "/" + replacementId, {
          template: refusedTemplate,
        }),
        "/gateway/auth/password",
      );
      assert.deepEqual(await state.read((store) => store.presets.listPresets(namespaceId)), before);
    }
    const passwordVariable = await http(api, "POST", collection, {
      name: "Wrong variable type",
      template: passwordTemplate(placeholder, { type: "password" }),
    });
    assertInvalid(passwordVariable, "password variables require");
    const referenceDefault = await http(api, "POST", collection, {
      name: "Reference default",
      template: passwordTemplate(placeholder, { type: "string", default: environmentReference }),
    });
    assert.equal(referenceDefault.status, 201);

    // A saved Preset is an editable draft. Its real render enters ordinary Configuration admission.
    const draft = presetTemplate(await http(api, "GET", collection + "/" + resourceId(created)));
    const good = renderPresetTemplate(draft, { gatewayPasswordRef: environmentReference });
    assert.deepEqual(good.configuration?.values, passwordValues(environmentReference));
    const configurationResponse = await http(api, "POST", path + "/configurations", {
      kind: "agent",
      values: good.configuration?.values,
    });
    assert.equal(configurationResponse.status, 201);
    const readback = await http(
      api,
      "GET",
      path + "/configurations/" + resourceId(configurationResponse),
    );
    assert.deepEqual(record(readback.data).values, good.configuration?.values);
    const before = await state.transact(async (store) => ({
      configurations: await store.namespaces.listConfigurationIds(namespaceId),
      agents: await store.agents.listAgents(namespaceId),
    }));
    const beforeAudit = await successfulMutations(state, namespaceId, "configuration");
    const bad = renderPresetTemplate(draft, { gatewayPasswordRef: literalPassword });
    assert.deepEqual(bad.configuration?.values, passwordValues(literalPassword));
    for (const values of [bad.configuration?.values, passwordValues(literalPassword)]) {
      assertInvalid(
        await http(api, "POST", path + "/configurations", { kind: "agent", values }),
        "/gateway/auth/password",
      );
      assert.deepEqual(
        await state.transact(async (store) => ({
          configurations: await store.namespaces.listConfigurationIds(namespaceId),
          agents: await store.agents.listAgents(namespaceId),
        })),
        before,
      );
      assert.deepEqual(await successfulMutations(state, namespaceId, "configuration"), beforeAudit);
    }
  },
);

test("filesystem Configuration Driver validates gateway password reference placeholders", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "oce-preset-validation-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const driver = new FilesystemConfigurationDriver(directory);
  await driverCases(driver);
  const before = await readdir(directory, { recursive: true });
  await assert.rejects(driver.create(configuration(passwordValues(literalPassword))), {
    name: "GatewayPasswordValueError",
    path: "/gateway/auth/password",
  });
  assert.deepEqual(await readdir(directory, { recursive: true }), before);
});

test("Kubernetes Configuration Driver validates gateway password reference placeholders", async () => {
  // validateValues and validate are local admission; neither initializes a Kubernetes client.
  const driver = new KubernetesConfigurationDriver({ authentication: { mode: "inCluster" } });
  await driverCases(driver);
});
