import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Check } from "typebox/value";

import { SlackChannelDriver } from "../../apps/controller/src/drivers/channel/slack.ts";
import {
  CodexPluginDriver,
  OCCPluginDriver,
} from "../../apps/controller/src/drivers/plugin/index.ts";
import {
  AgentResponse,
  ConfigurationResponse,
  ErrorResponse,
  PresetResponse,
  SecretResponse,
  SecretSchema,
  type ComputeDriver,
  type SecretReference,
} from "../../packages/contracts/src/index.ts";
import { DependencyUnavailableError } from "../../packages/occ/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { assertApiError } from "../helpers/api-error.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { requireLogRecord } from "../helpers/json-lines.ts";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.ts";
import {
  referenceFormRefusal,
  SERVICE_ACCOUNT_CROSS_NAMESPACE,
  unboundReferenceRefusal,
  unsubstitutedReferenceRefusal,
  unsupportedChannelRefusal,
} from "../helpers/refusal-text.mjs";
import {
  bindHarnessKey,
  bootstrapInstallation as bootstrap,
  checkedInjectedBody,
  createReadyNamespace,
  slackValidationConfiguration,
} from "./occ-api-injected-fixture.ts";
import type { ConfigurationDriver, Controller, Reply } from "./occ-api-plugin-policy-support.ts";

interface InvalidPlan {
  description: string;
  body: unknown;
  message: string;
  details?: readonly { path: string; code: string }[];
}

type ProvisioningOverrides = Record<string, unknown> & { configuration?: object | undefined };
type ProvisioningBody = Record<string, unknown> & { configuration: Record<string, unknown> };
type Fixture = Controller["fixture"];
type NoAgents = (fixture: Fixture, namespaceId: string, message?: string) => Promise<void>;
type CheckedErrorReply = ReturnType<typeof checkedErrorReply>;

interface InlineProvisioningState {
  fixture: Fixture;
  controller: Controller;
  namespace: Awaited<ReturnType<typeof createReadyNamespace>>;
  computeDriver: ComputeDriver;
  configurationDriver: ConfigurationDriver;
  logLines: unknown[];
  configurationsCreated: string[];
  provisionPath: string;
  provision: (body: unknown) => Promise<Reply>;
  requestBody: (overrides?: ProvisioningOverrides) => ProvisioningBody;
  invalidPlans: readonly InvalidPlan[];
  foreignNamespaceId: string;
  linearPluginId: string;
  diffsPluginId: string;
  pluginPolicy: () => Record<string, unknown>;
  assertNoAgentsInNamespace: NoAgents;
}

function checkedErrorReply(response: Reply) {
  return { ...response, body: checkedInjectedBody(response, response.status, ErrorResponse) };
}

function checkedProvision(state: Pick<InlineProvisioningState, "provision">) {
  return async (body: unknown) => checkedErrorReply(await state.provision(body));
}

function exactSecretRef(namespaceId: string, id: string): SecretReference {
  const ref = { kind: "secret", namespaceId, id };
  assert(Check(SecretSchema.properties.ref, ref), "Expected an exact Secret reference.");
  return ref;
}

export function provisioningRequestBody(
  namespaceId: string,
  secrets: { modelApiKey: unknown; toolApiKey: unknown },
  { configuration, ...overrides }: ProvisioningOverrides = {},
): ProvisioningBody {
  assert(Check(SecretSchema, secrets.modelApiKey), "Expected the model Secret response data.");
  assert(Check(SecretSchema, secrets.toolApiKey), "Expected the tool Secret response data.");
  return {
    requestId: `req_${randomUUID()}`,
    name: `Provisioned Agent ${randomUUID().slice(0, 8)}`,
    executionMode: "dedicated",
    configuration: {
      kind: "agent",
      values: { agents: { defaults: { model: "codex/gpt-6-astra" } } },
      secretBindings: {
        TOOL_API_KEY: { source: exactSecretRef(namespaceId, secrets.toolApiKey.id) },
      },
      ...configuration,
    },
    harnessAuth: { method: "api_key", source: exactSecretRef(namespaceId, secrets.modelApiKey.id) },
    ...overrides,
  };
}

export function invalidInlinePlans(
  requestBody: (overrides?: ProvisioningOverrides) => ProvisioningBody,
  modelRef: unknown,
  toolRef: unknown,
  foreignNamespaceId: string,
): readonly InvalidPlan[] {
  assert(Check(SecretSchema.properties.ref, modelRef), "Expected the model Secret reference.");
  assert(Check(SecretSchema.properties.ref, toolRef), "Expected the tool Secret reference.");
  const foreignSecretId = `sec_${randomUUID()}`;
  const oversizedBindings = Object.fromEntries(
    Array.from({ length: 65 }, (_, index) => [`TOOL_${index}`, { source: toolRef }]),
  );
  return [
    {
      description: "submitted Secret values",
      body: {
        ...requestBody(),
        secrets: [{ name: "tool-api-key", value: `tool-key-${randomUUID()}` }],
      },
      message:
        "The request does not match the operation contract: body /secrets is not an accepted field.",
    },
    {
      description: "request-local Secret binding sources",
      body: requestBody({
        configuration: {
          secretBindings: {
            TOOL_API_KEY: {
              source: { kind: "provisioning-secret", name: "tool-api-key" },
            },
          },
        },
      }),
      message:
        "The request does not match the operation contract: body /configuration/secretBindings/TOOL_API_KEY/source/namespaceId is required.",
    },
    {
      description: "request-local Harness Secret source",
      body: requestBody({
        harnessAuth: {
          method: "api_key",
          source: { kind: "provisioning-secret", name: "model-api-key" },
        },
      }),
      message:
        "The request does not match the operation contract: body /harnessAuth/source/namespaceId is required.",
    },
    {
      // Only the source kind is wrong, so the api_key shape fits and the other Harness
      // authentication shapes' fields are not listed.
      description: "Harness Secret source of another kind",
      body: requestBody({
        harnessAuth: {
          method: "api_key",
          source: {
            ...modelRef,
            kind: "provisioning-secret",
          },
        },
      }),
      message:
        'The request does not match the operation contract: body /harnessAuth/source/kind has an unsupported value (expected "secret").',
    },
    {
      // A string fits neither a Harness authentication shape nor null: one wrong-type problem
      // names both, not one per union level.
      description: "Harness authentication of the wrong type",
      body: requestBody({ harnessAuth: "api_key" }),
      message:
        "The request does not match the operation contract: body /harnessAuth has the wrong type (expected one of object, null).",
      details: [{ path: "/harnessAuth", code: "INVALID_TYPE" }],
    },
    {
      // The method selects the api_key shape, so only its missing source is reported, not
      // the fields of the other methods' shapes or the runtime method's literal.
      description: "Harness authentication method without its source",
      body: requestBody({ harnessAuth: { method: "api_key" } }),
      message:
        "The request does not match the operation contract: body /harnessAuth/source is required.",
      details: [{ path: "/harnessAuth/source", code: "REQUIRED" }],
    },
    {
      description: "too many binding destinations",
      body: requestBody({
        configuration: { secretBindings: oversizedBindings },
      }),
      message:
        "The request does not match the operation contract: body /configuration/secretBindings has an unsupported value (expected at most 64 fields).",
    },
    {
      description: "non-env delivery",
      body: requestBody({
        configuration: {
          secretBindings: {
            TOOL_API_KEY: {
              source: toolRef,
              delivery: { type: "file" },
            },
          },
        },
      }),
      message:
        'The request does not match the operation contract: body /configuration/secretBindings/TOOL_API_KEY/delivery/type has an unsupported value (expected "env").',
    },
    {
      description: "cross-Namespace Secret references",
      body: requestBody({
        configuration: {
          secretBindings: {
            TOOL_API_KEY: {
              source: { kind: "secret", namespaceId: foreignNamespaceId, id: foreignSecretId },
            },
          },
        },
      }),
      message: "Secret references cannot cross Namespaces.",
    },
    {
      // executionMode is optional and defaults to embedded; the Compute Driver provisions only
      // dedicated Agents, so the request is refused naming the field to set.
      description: "omitted execution mode",
      body: requestBody({ executionMode: undefined }),
      message:
        "Agent provisioning needs dedicated execution; this request uses embedded execution. Set executionMode.",
    },
    {
      description: "embedded execution mode",
      body: requestBody({ executionMode: "embedded" }),
      message:
        "Agent provisioning needs dedicated execution; this request uses embedded execution. Set executionMode.",
    },
    {
      description: "reserved environment destinations",
      body: requestBody({
        configuration: {
          secretBindings: {
            OPENCLAW_TOKEN: {
              source: toolRef,
            },
          },
        },
      }),
      message: "A secret binding destination uses the reserved prefix OPENCLAW_*: OPENCLAW_TOKEN.",
      // The reserved destination is named by its pointer under the inline Configuration.
      details: [{ path: "/configuration/secretBindings/OPENCLAW_TOKEN", code: "INVALID_VALUE" }],
    },
  ];
}

async function assertInvalidInlinePlan(
  provision: (body: unknown) => Promise<CheckedErrorReply>,
  { body, message, details, description }: InvalidPlan,
) {
  const result = await provision(body);
  assertApiError(result, 400, "INVALID_REQUEST", description);
  assert.equal(result.body.error.message, message, description);
  if (details !== undefined) {
    assert.deepEqual(result.body.error.details, details, description);
  }
}

export async function verifyInlineConfigurationRefusals(state: InlineProvisioningState) {
  const {
    controller,
    fixture,
    namespace,
    computeDriver,
    configurationDriver,
    configurationsCreated,
    invalidPlans,
    requestBody,
    assertNoAgentsInNamespace,
  } = state;
  const provision = checkedProvision(state);
  for (const plan of invalidPlans) {
    await assertInvalidInlinePlan(provision, plan);
  }
  // A plan the Kubernetes Compute Driver refuses is a conflict (its error classes are private,
  // so it used to be a 500). A gateway setting in the caller's own Configuration is named,
  // without its value, so the caller can fix it.
  const kubernetes = createTestKubernetesComputeDriver("compute-provisioning-validation");
  computeDriver.validateAgentProvisioning = (input) => kubernetes.validateAgentProvisioning(input);
  const model = { agents: { defaults: { model: "codex/gpt-6-astra" } } };
  for (const [gateway, message] of [
    [
      { auth: { mode: "token" } },
      "Configuration setting gateway.auth.mode must be trusted-proxy: Kubernetes Compute supports only native trusted-proxy gateway authentication.",
    ],
    [
      { trustedProxies: ["10.99.0.0/16"] },
      "Configuration setting gateway.trustedProxies must be omitted or match the Installation's network.gatewayTrustedProxyCidrs.",
    ],
  ] satisfies [Record<string, unknown>, string][]) {
    const refused = await provision(
      requestBody({
        configuration: { values: { ...model, gateway } },
      }),
    );
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.deepEqual(
      { code: refused.body.error.code, message: refused.body.error.message },
      { code: "RESOURCE_CONFLICT", message },
    );
    assert.doesNotMatch(JSON.stringify(refused.body), /10\.99\./);
  }
  // The retired Codex untrusted approval policy is one of those gateway settings (finding 987).
  const untrustedPolicy = await provision(
    requestBody({
      configuration: {
        values: {
          ...model,
          plugins: {
            entries: { codex: { config: { appServer: { approvalPolicy: "untrusted" } } } },
          },
        },
      },
    }),
  );
  assert.equal(untrustedPolicy.status, 409, JSON.stringify(untrustedPolicy.body));
  assert.deepEqual(
    { code: untrustedPolicy.body.error.code, message: untrustedPolicy.body.error.message },
    {
      code: "RESOURCE_CONFLICT",
      message:
        'Configuration setting plugins.entries.codex.config.appServer.approvalPolicy must not be "untrusted", which the OpenClaw runtime retired: use "on-request".',
    },
  );
  // Topology-independent Kubernetes rules give the same refusal as Configuration save.
  computeDriver.validateConfiguration = (...args) => kubernetes.validateConfiguration(...args);
  // Saving a Preset accepts a header name that waits on a variable without a default.
  configurationDriver.validateValues = async () => {};
  const placeholder = "{{ vars.header }}";
  const preset = await controller.request("POST", `/namespaces/${namespace.id}/presets`, {
    body: {
      name: "Header variable",
      template: {
        variables: { header: { type: "string" } },
        configuration: {
          values: {
            ...model,
            models: {
              providers: {
                openai: {
                  headers: { [placeholder]: "v" },
                  request: { headers: { [placeholder]: "v" } },
                  models: [{ id: "m", headers: { [placeholder]: "v" } }],
                },
              },
            },
          },
        },
      },
    },
  });
  checkedInjectedBody(preset, 201, PresetResponse);
  delete configurationDriver.validateValues;
  await assertNoAgentsInNamespace(fixture, namespace.id);
  for (const [values, message] of [
    [
      { ...model, channels: { discord: { enabled: true } } },
      unsupportedChannelRefusal("channels.discord"),
    ],
    [
      { ...model, env: { OPENAI_API_KEY: "${OPENAI_API_KEY}" } },
      "Configuration setting env.OPENAI_API_KEY must not be set: the Agent's Harness authentication binding owns model provider environment.",
    ],
    [
      {
        ...model,
        models: {
          providers: { openai: { request: { headers: { Authorization: "Bearer ${TOKEN}" } } } },
        },
      },
      'Configuration setting models.providers.openai.request.headers must not set the credential header "Authorization" (its name marks a credential): model credentials come from the Agent\'s Harness authentication binding.',
    ],
    // Finding 1311: provisioning runs the agents roster rules Configuration save runs, with the
    // same text, so a roster every deployment refuses is refused before anything is stored.
    [
      { agents: { ...model.agents, entries: { "main!": {} } } },
      'The OpenClaw Gateway rejects the Agent ID in agents.entries["main!"]: use up to 64 letters, digits, _ or -, not starting with -.',
    ],
    [
      { agents: { ...model.agents, entries: { main: {}, helper: {} } } },
      'The OpenClaw Gateway needs agents.ownership "explicit" for more than one agents.entries entry: set it, or keep one entry.',
    ],
  ] satisfies [Record<string, unknown>, string][]) {
    const refused = await provision(requestBody({ configuration: { values } }));
    assert.equal(refused.status, 400, JSON.stringify(refused.body));
    assert.deepEqual(
      { code: refused.body.error.code, message: refused.body.error.message },
      { code: "INVALID_REQUEST", message },
    );
  }
  // Provisioning with an inline header names the forbidden header but never echoes its value.
  const sentinel = `synthetic-filled-header-${randomUUID()}`;
  for (const name of ["X-Upstream-Pwd", "X-Signature-Sha256"]) {
    const filled = await provision(
      requestBody({
        configuration: {
          values: {
            ...model,
            models: { providers: { openai: { headers: { [name]: sentinel } } } },
          },
        },
      }),
    );
    assert.equal(filled.status, 400, JSON.stringify(filled.body));
    assert.deepEqual(
      { code: filled.body.error.code, message: filled.body.error.message },
      {
        code: "INVALID_REQUEST",
        message: `Configuration setting models.providers.openai.headers must not set the credential header "${name}" (its name marks a credential): model credentials come from the Agent's Harness authentication binding.`,
      },
    );
    assert.equal(JSON.stringify(filled.body).includes(sentinel), false);
  }
  await assertNoAgentsInNamespace(fixture, namespace.id);
  assert.deepEqual(configurationsCreated, [], "Kubernetes refusals must not store Configurations");
  delete computeDriver.validateConfiguration;
}

export async function verifyInlineProvisioningRecovery(state: InlineProvisioningState) {
  const {
    fixture,
    controller,
    namespace,
    computeDriver,
    logLines,
    configurationsCreated,
    provisionPath,
    requestBody,
    invalidPlans,
    foreignNamespaceId,
    linearPluginId,
    diffsPluginId,
    pluginPolicy,
    assertNoAgentsInNamespace,
  } = state;
  assert(fixture.controller, "Bootstrap must create the controller.");
  const provision = checkedProvision(state);
  // The logged reason keeps at most 512 characters, and a thrown non-Error's value is not logged.
  for (const [thrown, reason] of [
    [new Error("r".repeat(600)), "r".repeat(512)],
    ["internal driver detail", "The Compute Driver refused the plan."],
  ] satisfies [Error | string, string][]) {
    computeDriver.validateAgentProvisioning = () => {
      throw thrown;
    };
    const logged = logLines.length;
    const refused = await provision(requestBody());
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.doesNotMatch(JSON.stringify(refused.body), /internal driver detail|r{512}/);
    assert.deepEqual(
      logLines
        .slice(logged)
        .map(requireLogRecord)
        .filter((line) => line.event === "agent_provisioning.compute_refused")
        .map((line) => ({ requestId: line.requestId, reason: line.reason })),
      [{ requestId: refused.body.meta.requestId, reason }],
    );
  }
  // A dependency the Compute Driver reports as unavailable stays retryable.
  computeDriver.validateAgentProvisioning = () => {
    throw new DependencyUnavailableError("The Compute Driver is unavailable.");
  };
  const computeUnavailable = await provision(requestBody());
  computeDriver.validateAgentProvisioning = () => {};
  assert.equal(computeUnavailable.status, 503, JSON.stringify(computeUnavailable.body));
  assert.equal(computeUnavailable.body.error.code, "DEPENDENCY_UNAVAILABLE");
  // Restoring a healthy Compute Driver must not change which field the API rejects.
  for (const plan of invalidPlans.filter((plan) => plan.details !== undefined)) {
    await assertInvalidInlinePlan(provision, plan);
  }

  // A model provider baseUrl the runtime cannot use is refused at admission with the field
  // named, instead of surfacing later as an unexplained startup model check failure.
  const badBaseUrl = requestBody();
  const badBaseValues = asRecord(badBaseUrl.configuration.values);
  assert(badBaseValues, "Expected inline Configuration values to be an object.");
  badBaseUrl.configuration.values = {
    ...badBaseValues,
    models: { providers: { codex: { baseUrl: "not a url", api: "openai-responses" } } },
  };
  const refusedBaseUrl = await provision(badBaseUrl);
  assert.equal(refusedBaseUrl.status, 400, JSON.stringify(refusedBaseUrl.body));
  assert.equal(
    refusedBaseUrl.body.error.message,
    "Configuration field /models/providers/codex/baseUrl must be an absolute http or https URL.",
  );
  await assertNoAgentsInNamespace(fixture, namespace.id);

  const pluginDriver = new CodexPluginDriver();
  fixture.controller.registerDriver(pluginDriver);
  fixture.controller.selectDriver("plugin", pluginDriver.id);
  // Driver-specific validation must precede durable provisioning and resource creation.
  const invalidPolicy = await provision(
    requestBody({
      configuration: { values: createHarnessConfiguration("codex", "gpt-6-astra") },
      plugins: {
        [linearPluginId]: { enabled: true, tools: { "app/search": { reviewer: "auto" } } },
      },
    }),
  );
  assertApiError(invalidPolicy, 400, "INVALID_REQUEST");
  assert.equal(
    invalidPolicy.body.error.message,
    "This Plugin Driver does not support tools[id].reviewer. Use toolDefaults.reviewer when supported, or omit the reviewer.",
  );
  await assertNoAgentsInNamespace(fixture, namespace.id);
  // The Codex Plugin Driver's automatic reviewer rule (finding 988) also refuses a
  // provisioning request before anything durable is written.
  const automaticReviewer = requestBody({
    plugins: { [linearPluginId]: { enabled: true, toolDefaults: { reviewer: "auto" } } },
  });
  automaticReviewer.configuration.values = {
    ...createHarnessConfiguration("codex", "gpt-6-astra"),
    plugins: { entries: { codex: { config: { appServer: { approvalPolicy: "never" } } } } },
  };
  const refusedReviewer = await provision(automaticReviewer);
  assertApiError(refusedReviewer, 400, "INVALID_REQUEST");
  assert.equal(
    refusedReviewer.body.error.message,
    'An automatic plugin reviewer requires Configuration setting plugins.entries.codex.config.appServer.approvalPolicy "on-request"; change it or choose the human reviewer.',
  );
  await assertNoAgentsInNamespace(fixture, namespace.id);
  // The OpenClaw Plugin Driver refuses a selection whose every tool the inline Configuration
  // denies (finding 508) before anything durable is written.
  const openClawDriver = new OCCPluginDriver();
  fixture.controller.registerDriver(openClawDriver);
  fixture.controller.selectDriver("plugin", openClawDriver.id);
  const deniedTools = requestBody({
    plugins: { [diffsPluginId]: pluginPolicy() },
  });
  deniedTools.configuration.values = {
    ...createHarnessConfiguration("openclaw", "gpt-5.1"),
    tools: { deny: ["*"] },
  };
  const refusedDenial = await provision(deniedTools);
  assertApiError(refusedDenial, 400, "INVALID_REQUEST");
  assert.equal(
    refusedDenial.body.error.message,
    `Configuration setting tools.deny blocks every tool of plugin ${diffsPluginId}; remove the matching deny entry or deselect the plugin.`,
  );
  await assertNoAgentsInNamespace(fixture, namespace.id);
  // Its plugins run only in an OpenClaw Harness, and this request provisions dedicated Codex
  // (finding 2348).
  const codexPlugins = await provision(
    requestBody({
      configuration: { values: createHarnessConfiguration("codex", "gpt-6-astra") },
      plugins: { [diffsPluginId]: pluginPolicy() },
    }),
  );
  assert.equal(codexPlugins.status, 400, JSON.stringify(codexPlugins.body));
  assert.deepEqual(
    { code: codexPlugins.body.error.code, message: codexPlugins.body.error.message },
    {
      code: "INVALID_REQUEST",
      message:
        "No Plugin Driver is enabled for the codex Harness. Remove the Agent's plugins or enable its catalog.",
    },
  );
  await assertNoAgentsInNamespace(fixture, namespace.id);
  fixture.controller.selectDriver("plugin", pluginDriver.id);

  const assertNeedsDurableStorage = (response: CheckedErrorReply) => {
    assertApiError(response, 503, "DEPENDENCY_UNAVAILABLE");
    assert.equal(response.body.error.message, "A required platform dependency is unavailable.");
    // Only the operator log says which dependency failed. Match this request to exclude earlier 503s.
    assert.deepEqual(
      logLines
        .map(requireLogRecord)
        .filter(
          (line) =>
            line.event === "http.dependency_unavailable" &&
            line.requestId === response.body.meta.requestId,
        )
        .map((line) => line.message),
      ["Agent provisioning requires durable PostgreSQL state for checkpoints."],
    );
  };
  assertNeedsDurableStorage(await provision(requestBody()));
  await assertNoAgentsInNamespace(
    fixture,
    namespace.id,
    "in-memory admission must stop before creating an Agent",
  );

  // A managed ServiceAccount PAT source is admitted only for the exact account in the route
  // Namespace that the caller may read. Every refusal comes before the durable-state step,
  // which an accepted plan reaches (503 here).
  assert(fixture.platformState, "Bootstrap must create the platform state.");
  const account = await fixture.platformState.transact((unit) =>
    unit.serviceAccounts.createServiceAccount({
      id: `sa_${randomUUID()}`,
      namespaceId: namespace.id,
      name: `provisioning-account-${randomUUID().slice(0, 8)}`,
    }),
  );
  const managedSource = { kind: "service_account", namespaceId: namespace.id, id: account.id };
  const provisionWithAccount = (source: typeof managedSource) =>
    provision(
      requestBody({
        harnessAuth: { method: "codex_pat", source },
      }),
    );
  fixture.state.restrictions.push({
    id: "deny-provisioning-account-read",
    namespaceId: namespace.id,
    resourceKind: "service_account",
    resourceId: account.id,
    action: "read",
    effect: "deny",
  });
  const unreadableAccount = await provisionWithAccount(managedSource);
  fixture.state.restrictions.pop();
  assertApiError(unreadableAccount, 403, "FORBIDDEN");
  // Another Namespace is a rule about the request, named before any lookup (finding 2536); a
  // missing account in the route Namespace stays a 404.
  const foreignAccount = await provisionWithAccount({
    ...managedSource,
    namespaceId: foreignNamespaceId,
  });
  assertApiError(foreignAccount, 400, "INVALID_REQUEST", "another Namespace");
  assert.equal(foreignAccount.body.error.message, SERVICE_ACCOUNT_CROSS_NAMESPACE);
  const missingAccount = await provisionWithAccount({ ...managedSource, id: `sa_${randomUUID()}` });
  assertApiError(missingAccount, 404, "NOT_FOUND", "a missing account");
  assertNeedsDurableStorage(await provisionWithAccount(managedSource));

  const rawBody = JSON.stringify(
    requestBody({
      configuration: { values: { payload: "x".repeat(448 * 1024) } },
    }),
  );
  const oversized = await controller.request("POST", provisionPath, { rawBody });
  assertApiError(oversized, 413, "PAYLOAD_TOO_LARGE");
  await assertNoAgentsInNamespace(fixture, namespace.id);
  assert.deepEqual(
    configurationsCreated,
    [],
    "no provisioning request should store a Configuration",
  );
}

export async function createSlackValidationFixture(controller: Controller, namespaceName: string) {
  const { fixture } = controller;
  await bootstrap(controller);
  const namespace = await createReadyNamespace(controller, namespaceName);
  const base = `/namespaces/${namespace.id}`;
  const makeSecret = async (name: string, value: string) => {
    const result = await controller.request("POST", `${base}/secrets`, { body: { name, value } });
    return checkedInjectedBody(result, 201, SecretResponse).data;
  };
  const app = await makeSecret("app", "xapp-synthetic-app");
  const bot = await makeSecret("bot", "xoxb-synthetic-bot");
  const model = await makeSecret("model", "synthetic-model");
  const secrets = { modelApiKey: model, toolApiKey: model };
  return {
    fixture,
    namespace,
    base,
    app,
    bot,
    async saveConfiguration(configuration: unknown) {
      const result = await controller.request("POST", `${base}/configurations`, {
        body: configuration,
      });
      const { data } = checkedInjectedBody(result, 201, ConfigurationResponse);
      const savedValues = asRecord(data.values);
      assert(savedValues, "Expected saved Configuration values to be an object.");
      const channels = asRecord(savedValues.channels);
      const slack = asRecord(channels?.slack);
      assert(
        slack && Object.hasOwn(slack, "botToken"),
        "Expected saved Slack Configuration values.",
      );
      return data;
    },
    async createAgent(name: string, configurationId: string) {
      const result = await controller.request("POST", `${base}/agents`, {
        body: { name, configurationId },
      });
      return checkedInjectedBody(result, 201, AgentResponse).data;
    },
    provision(configuration: object) {
      return controller.request("POST", `${base}/agents/provision`, {
        body: provisioningRequestBody(namespace.id, secrets, { configuration }),
      });
    },
  };
}

export async function runChannelReferenceRefusals(
  controller: Controller,
  configurationDriver: ConfigurationDriver,
  assertNoAgentsInNamespace: NoAgents,
) {
  const { fixture, namespace, base, app, bot, saveConfiguration, createAgent, provision } =
    await createSlackValidationFixture(controller, "slack-reference-forms");
  let calls = 0;
  const channel = new SlackChannelDriver(async () => {
    calls++;
    return new Response(JSON.stringify({ ok: true, bot_id: "B123", team_id: "T123" }));
  });
  assert(fixture.controller, "Bootstrap must create the controller.");
  fixture.controller.registerDriver(channel);
  fixture.controller.selectDriver("channel", channel.id);
  const form = (name: "otherText" | "inline" | "fallback" | "shorthand") =>
    referenceFormRefusal("channels.slack.botToken", name);
  const unbound = unboundReferenceRefusal("channels.slack.botToken", "SLACK_SPARE_TOKEN");
  const forms = [
    ["xoxb-${SLACK_BOT_TOKEN}", form("otherText")],
    // Finding 2517: a token pasted as the value names the setting the same way.
    ["$xoxbSECRET", form("inline")],
    // Finding 2503: trailing space and two references are not "text around" a reference.
    ["${SLACK_BOT_TOKEN} ", form("otherText")],
    ["${SLACK_BOT_TOKEN}${SLACK_APP_TOKEN}", form("otherText")],
    ["${SLACK_BOT_TOKEN:-}", form("fallback")],
    ["$SLACK_BOT_TOKEN", form("shorthand")],
    ["${slack_bot}", unsubstitutedReferenceRefusal("channels.slack.botToken", "${slack_bot}")],
    ["${SLACK_SPARE_TOKEN}", unbound],
    // Finding 2520: the binding rule answers before the form rule, at save and at deploy.
    ["xoxb-${SLACK_SPARE_TOKEN}", unbound],
  ] satisfies [string, string][];
  const configurationWithBotToken = (botToken: string) =>
    slackValidationConfiguration({
      appSource: app.ref,
      botSource: bot.ref,
      botToken,
      model: "codex/gpt-6-astra",
    });
  for (const [botToken, message] of forms) {
    const refused = checkedErrorReply(await provision(configurationWithBotToken(botToken)));
    assertApiError(refused, 400, "INVALID_REQUEST");
    assert.equal(refused.body.error.message, message, botToken);
    assert.doesNotMatch(JSON.stringify(refused.body), /xoxb-synthetic|SECRET/);
  }
  // Each was refused before Slack was asked, and nothing was created.
  assert.equal(calls, 0);
  await assertNoAgentsInNamespace(fixture, namespace.id);

  // Finding 2516: deployment also asked the Slack Channel Driver first. A stored Configuration
  // that predates these rules, written past OCC, now gets the rule's message at deploy, still
  // before Slack is asked.
  const configuration = configurationWithBotToken("${SLACK_BOT_TOKEN}");
  const { values } = configuration;
  const config = await saveConfiguration(configuration);
  const agent = await createAgent("slack-forms", config.id);
  await bindHarnessKey(fixture, namespace.id, agent);
  for (const [botToken, message] of forms) {
    const stored = configurationDriver.stored({ namespaceId: namespace.id, id: config.id });
    assert(stored, "Expected the Agent Configuration to be stored before deployment.");
    await configurationDriver.update({
      ...stored,
      values: { ...values, channels: { slack: { ...values.channels.slack, botToken } } },
    });
    const refused = checkedErrorReply(
      await controller.request("POST", `${base}/agents/${agent.id}/deploy`),
    );
    assertApiError(refused, 400, "INVALID_REQUEST");
    assert.equal(refused.body.error.message, message, botToken);
    assert.doesNotMatch(JSON.stringify(refused.body), /xoxb-synthetic|SECRET/);
  }
  assert.equal(calls, 0);
}
