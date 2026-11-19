import assert from "node:assert/strict";
import test from "node:test";
import type { Static } from "typebox";
import { Check } from "typebox/value";
import { FilesystemConfigurationDriver } from "../../apps/controller/src/drivers/configuration/filesystem/index.ts";
import {
  AgentResponse,
  AgentRevisionListResponse,
  ConfigurationResponse,
  ErrorResponse,
  JsonValue,
  NamespaceSchema,
  PluginApproversSchema,
  PluginDesiredSelectionSchema,
  PluginDesiredStateSchema,
  PluginDriverIdentitySchema,
  PluginToolDefaultsSchema,
  PluginToolPolicySchema,
  PresetResponse,
  type ComputeDriver,
  type Configuration,
  type ConfigurationDriver,
  type ConfigurationReference,
  type CreateAgentBody,
  type OpenClawConfigurationDocument,
  type OpenClawConfigurationValue,
  type PresetDraftTemplate,
  type SecretBinding,
  type SecretBindings,
  type UpdateAgentBody,
  type ValidateAgentCreateBody,
} from "../../packages/contracts/src/index.ts";
import { OpenClawController } from "../../packages/occ/src/index.ts";
import { createReadyComputeDriver } from "../helpers/development.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

const schemaContext = {
  SafeJsonValue: JsonValue,
  PluginDriverIdentity: PluginDriverIdentitySchema,
  PluginApprovers: PluginApproversSchema,
  PluginToolPolicy: PluginToolPolicySchema,
  PluginToolDefaults: PluginToolDefaultsSchema,
  PluginDesiredSelection: PluginDesiredSelectionSchema,
  PluginDesiredState: PluginDesiredStateSchema,
};

type FixtureConfigurationDriver = Omit<ConfigurationDriver, "read"> & {
  read(reference: ConfigurationReference): Promise<Configuration | undefined>;
};

interface ConfigurationBackend extends FixtureConfigurationDriver {
  storedConfigurations(): Configuration[];
}

interface FixtureOptions {
  configurationDriver?: FixtureConfigurationDriver;
  computeDriver: ComputeDriver;
  computeImplementation?: string;
}

type DraftConfiguration = {
  values: OpenClawConfigurationDocument;
  secretBindings?: SecretBindings;
};

type RequestBody =
  | ({ kind: "agent" } & DraftConfiguration)
  | DraftConfiguration
  | CreateAgentBody
  | UpdateAgentBody
  | Static<typeof ValidateAgentCreateBody>
  | { name: string; template: PresetDraftTemplate };

interface HttpResponse {
  status: number;
  body: unknown;
}

interface ConfigurationChannelCredentialFixtures {
  createConfigurationBackend(): ConfigurationBackend;
  fixture(options: FixtureOptions): Promise<{
    context: unknown;
    request(
      method: "GET" | "POST" | "PATCH",
      pathname: string,
      body?: RequestBody,
    ): Promise<unknown>;
    readyAgent(agentId: string, configurationId: string, secretName: string): Promise<void>;
  }>;
  runtimeSelected: OpenClawConfigurationDocument;
  setting(path: string, requirement: string): string;
  assertRefused(
    response: { status: number; body: ErrorResponse },
    message: string,
    options?: { label?: string; sentinel?: string },
  ): void;
  unsupportedChannelRefusal(setting: string): string;
  unboundReferenceRefusal(setting: string, name: string): string;
  unreadableSlackReference(setting: string): string;
  unreadableSlackTokenRefusal(setting: string, held: "secretRef" | "object"): string;
  unsubstitutedReferenceRefusal(setting: string, shown?: string): string;
  unsubstitutedFallbackRefusal(setting: string, name: string): string;
}

function kubernetesRules(id: string): ComputeDriver {
  const kubernetes = createTestKubernetesComputeDriver(id);
  return createReadyComputeDriver(id, {
    implementation: "integration-compute-substrate",
    validateConfiguration: kubernetes.validateConfiguration.bind(kubernetes),
    validateHarnessAuth: kubernetes.validateHarnessAuth.bind(kubernetes),
    validateGatewaySettings: kubernetes.validateGatewaySettings.bind(kubernetes),
  } satisfies Partial<ComputeDriver>);
}

async function channelFixture(
  fixture: ConfigurationChannelCredentialFixtures["fixture"],
  options: FixtureOptions,
) {
  const { context, request, readyAgent } = await fixture(options);
  assert.ok(typeof context === "object" && context !== null);
  assert.ok("controller" in context && context.controller instanceof OpenClawController);
  assert.ok("namespace" in context && Check(NamespaceSchema, context.namespace));
  assert.ok("collection" in context && typeof context.collection === "string");
  assert.ok("presets" in context && typeof context.presets === "string");
  assert.ok(
    "principal" in context && typeof context.principal === "object" && context.principal !== null,
  );
  assert.ok("id" in context.principal && typeof context.principal.id === "string");

  return {
    controller: context.controller,
    namespace: context.namespace,
    collection: context.collection,
    presets: context.presets,
    principalId: context.principal.id,
    readyAgent,
    async request(
      method: "GET" | "POST" | "PATCH",
      pathname: string,
      body?: RequestBody,
    ): Promise<HttpResponse> {
      const result = await request(method, pathname, body);
      assert.ok(typeof result === "object" && result !== null);
      assert.ok("status" in result && typeof result.status === "number" && "body" in result);
      return { status: result.status, body: result.body };
    },
  };
}

async function createEnvSecretBinding(
  context: Pick<
    Awaited<ReturnType<typeof channelFixture>>,
    "controller" | "namespace" | "principalId"
  >,
  name: string,
): Promise<SecretBinding> {
  const secret = await context.controller.createSecret(context.principalId, {
    namespaceId: context.namespace.id,
    name,
    value: `synthetic-${name}`,
  });
  return { source: secret.ref, delivery: { type: "env" } };
}

async function writePastOcc(
  backend: ConfigurationBackend,
  id: string,
  values: OpenClawConfigurationDocument,
): Promise<void> {
  const stored = backend.storedConfigurations().find((configuration) => configuration.id === id);
  assert.ok(stored, `Expected a stored Configuration for ${id}`);
  await backend.update({ ...stored, values });
}

async function deployableAgent(
  { collection, namespace, request, readyAgent }: Awaited<ReturnType<typeof channelFixture>>,
  {
    values,
    name,
    secretName,
  }: { values: OpenClawConfigurationDocument; name: string; secretName: string },
) {
  const created = await request("POST", collection, { kind: "agent", values });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.ok(Check(schemaContext, ConfigurationResponse, created.body));
  const configurationId = created.body.data.id;
  const agentPath = `/namespaces/${namespace.id}/agents`;
  const agent = await request("POST", agentPath, {
    name,
    configurationId,
  } satisfies CreateAgentBody);
  assert.equal(agent.status, 201, JSON.stringify(agent.body));
  assert.ok(Check(schemaContext, AgentResponse, agent.body));
  await readyAgent(agent.body.data.id, configurationId, secretName);
  return {
    created: created.body.data,
    configurationId,
    item: `${collection}/${configurationId}`,
    agentPath: `${agentPath}/${agent.body.data.id}`,
  };
}

async function updateSaved(
  request: Awaited<ReturnType<typeof channelFixture>>["request"],
  item: string,
  values: OpenClawConfigurationDocument,
  label?: string,
) {
  const saved = await request("PATCH", item, { values });
  assert.equal(saved.status, 200, label ?? JSON.stringify(saved.body));
  assert.ok(Check(schemaContext, ConfigurationResponse, saved.body));
  assert.deepEqual(saved.body.data.values, values, label ?? "stored Configuration values");
  return saved.body.data;
}

export function registerConfigurationChannelCredentialCases(
  fixtures: ConfigurationChannelCredentialFixtures,
): void {
  const {
    createConfigurationBackend,
    runtimeSelected,
    setting,
    unsupportedChannelRefusal,
    unboundReferenceRefusal,
    unreadableSlackReference,
    unreadableSlackTokenRefusal,
    unsubstitutedReferenceRefusal,
    unsubstitutedFallbackRefusal,
  } = fixtures;

  const fixture = (options: FixtureOptions) => channelFixture(fixtures.fixture, options);
  const assertRefused = (
    response: HttpResponse,
    message: string,
    options?: { label?: string; sentinel?: string },
  ) => {
    assert.equal(response.status, 400, `${options?.label ?? ""}: ${JSON.stringify(response.body)}`);
    assert.ok(Check(ErrorResponse, response.body));
    fixtures.assertRefused({ status: response.status, body: response.body }, message, options);
  };

  test("Configuration save and Kubernetes deployment refuse caller-owned credentials and channels with one named message", async () => {
    // Finding 1116: deployment refused these with an unnamed 409; Configuration save accepted them.
    // Both now run the Kubernetes Compute rule module and name the setting.
    const configurationDriver = createConfigurationBackend();
    const context = await fixture({
      configurationDriver,
      computeDriver: kubernetesRules("compute-caller-settings"),
    });
    const valid = runtimeSelected;
    const { created, configurationId, item, agentPath } = await deployableAgent(context, {
      values: valid,
      name: "Caller settings consumer",
      secretName: "caller-key",
    });
    const storeAsOlderRelease = (values: OpenClawConfigurationDocument) =>
      writePastOcc(configurationDriver, configurationId, values);
    const binding = "model credentials come from the Agent's Harness authentication binding";
    const credentialHeader = (name: string) =>
      `must not set the credential header "${name}" (its name marks a credential)`;

    for (const [values, message] of [
      [
        { ...valid, channels: { discord: { enabled: true } } },
        unsupportedChannelRefusal("channels.discord"),
      ],
      [
        { ...valid, channels: { msteams: { enabled: true } } },
        unsupportedChannelRefusal("channels.msteams"),
      ],
      [
        {
          ...valid,
          auth: { profiles: { "openai:default": { provider: "openai", mode: "api_key" } } },
        },
        setting("auth", `must be empty: ${binding}`),
      ],
      [
        { ...valid, env: { vars: { OPENAI_BASE_URL: "https://example.invalid/v1" } } },
        setting(
          "env.vars.OPENAI_BASE_URL",
          `must not be set: the Agent's Harness authentication binding owns model provider environment`,
        ),
      ],
      [
        {
          ...valid,
          models: {
            providers: { openai: { headers: { "X-Api-Key": "${OPENAI_API_KEY}" }, models: [] } },
          },
        },
        setting("models.providers.openai.headers", `${credentialHeader("X-Api-Key")}: ${binding}`),
      ],
      // OpenClaw's request transport overrides carry credentials too (finding 1142).
      [
        {
          ...valid,
          models: {
            providers: {
              openai: { request: { headers: { Authorization: "Bearer ${MODEL_TOKEN}" } } },
            },
          },
        },
        setting(
          "models.providers.openai.request.headers",
          `${credentialHeader("Authorization")}: ${binding}`,
        ),
      ],
      [
        {
          ...valid,
          models: {
            providers: {
              openai: {
                request: { auth: { mode: "authorization-bearer", token: "${MODEL_TOKEN}" } },
              },
            },
          },
        },
        setting(
          "models.providers.openai.request.auth",
          `must be unset or {mode: "provider-default"}: ${binding}`,
        ),
      ],
      // A provider the primary model does not select is still reachable (imageModel, /model).
      [
        {
          ...valid,
          models: {
            providers: { google: { headers: { "x-goog-api-key": "${GOOGLE_API_KEY}" } } },
          },
        },
        setting(
          "models.providers.google.headers",
          `${credentialHeader("x-goog-api-key")}: ${binding}`,
        ),
      ],
    ] satisfies readonly (readonly [OpenClawConfigurationDocument, string])[]) {
      const label = JSON.stringify(values);
      const rejected = await context.request("POST", context.collection, { kind: "agent", values });
      assert.equal(rejected.status, 400, `${label}: ${JSON.stringify(rejected.body)}`);
      assert.ok(Check(ErrorResponse, rejected.body));
      assert.equal(rejected.body.error.message, message, label);
      const replaced = await context.request("PATCH", item, { values });
      assert.equal(replaced.status, 400, label);
      assert.ok(Check(ErrorResponse, replaced.body));
      assert.equal(replaced.body.error.message, message, label);
      const unchanged = await context.request("GET", item);
      assert.ok(Check(schemaContext, ConfigurationResponse, unchanged.body));
      assert.deepEqual(unchanged.body.data, created, label);

      // A row an older release stored still reads; deployment refuses it with the same text.
      await storeAsOlderRelease(values);
      const read = await context.request("GET", item);
      assert.equal(read.status, 200, label);
      assert.ok(Check(schemaContext, ConfigurationResponse, read.body));
      assert.deepEqual(read.body.data.values, values, label);
      const deployed = await context.request("POST", `${agentPath}/deploy`);
      assert.equal(deployed.status, 400, `${label}: ${JSON.stringify(deployed.body)}`);
      assert.ok(Check(ErrorResponse, deployed.body));
      assert.equal(deployed.body.error.message, message, label);
      // Agent save checks the same rule on the stored row.
      const agentSaved = await context.request("PATCH", agentPath, { configurationId });
      assert.equal(agentSaved.status, 400, `${label}: ${JSON.stringify(agentSaved.body)}`);
      assert.ok(Check(ErrorResponse, agentSaved.body));
      assert.equal(agentSaved.body.error.message, message, label);
      await storeAsOlderRelease(valid);
    }
    assert.equal(configurationDriver.storedConfigurations().length, 1);

    // The provider apiKey rule depends only on the Configuration's primary model and Harness, so
    // save refuses it too (finding 1299), and deployment names it on a row stored earlier.
    const apiKey = {
      ...valid,
      models: {
        providers: {
          openai: { apiKey: { source: "env", provider: "default", id: "OTHER_MODEL_KEY" } },
        },
      },
    };
    const apiKeyRefusal = setting(
      "models.providers.openai.apiKey",
      "must be ${OPENAI_API_KEY} or an env SecretRef to OPENAI_API_KEY, which the Agent's Harness authentication binding supplies",
    );
    const saved = await context.request("PATCH", item, { values: apiKey });
    assert.equal(saved.status, 400, JSON.stringify(saved.body));
    assert.ok(Check(ErrorResponse, saved.body));
    assert.equal(saved.body.error.message, apiKeyRefusal);
    await storeAsOlderRelease(apiKey);
    const deployed = await context.request("POST", `${agentPath}/deploy`);
    assert.equal(deployed.status, 400, JSON.stringify(deployed.body));
    assert.ok(Check(ErrorResponse, deployed.body));
    assert.equal(deployed.body.error.message, apiKeyRefusal);
    await storeAsOlderRelease(valid);
    // Agent save checks what depends on the Agent: an embedded Agent cannot serve a channel. The
    // Installation's channel runtime and the channel's Secret bindings wait for deployment.
    const slack = {
      ...valid,
      channels: {
        slack: {
          enabled: true,
          mode: "socket",
          appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
        },
      },
    };
    await updateSaved(context.request, item, slack);
    const embeddedSlack = setting(
      "channels.slack",
      "is enabled, but channels require a dedicated Agent workload",
    );
    const agentUpdate = await context.request("PATCH", agentPath, { configurationId });
    assert.equal(agentUpdate.status, 400, JSON.stringify(agentUpdate.body));
    assert.ok(Check(ErrorResponse, agentUpdate.body));
    assert.equal(agentUpdate.body.error.message, embeddedSlack);
    const slackDeploy = await context.request("POST", `${agentPath}/deploy`);
    assert.equal(slackDeploy.status, 400);
    assert.ok(Check(ErrorResponse, slackDeploy.body));
    assert.equal(slackDeploy.body.error.message, embeddedSlack);
    const revisions = await context.request("GET", `${agentPath}/revisions`);
    assert.equal(revisions.status, 200, JSON.stringify(revisions.body));
    assert.ok(Check(schemaContext, AgentRevisionListResponse, revisions.body));
    assert.deepEqual(revisions.body.data, []);

    // A disabled unsupported channel and a non-credential env name still save.
    for (const values of [
      { ...valid, channels: { discord: { enabled: false } } },
      { ...valid, env: { vars: { HTTP_PROXY: "http://proxy:3128" } } },
    ] satisfies readonly OpenClawConfigurationDocument[]) {
      await updateSaved(context.request, item, values, JSON.stringify(values));
    }
  });

  test("Configuration create, update and Agent create's check refuse a channel credential reference without a Secret binding (finding 2319)", async () => {
    // The bundled Kubernetes Compute delivers channel credentials only from Configuration Secret
    // bindings. Deployment refused an unbound reference; create and update carry values and
    // bindings in one request, so OCC refuses it where it is written, with the setting and the
    // missing name.
    const configurationDriver = createConfigurationBackend();
    const context = await fixture({
      configurationDriver,
      computeDriver: kubernetesRules("compute-channel-bindings"),
      computeImplementation: "kubernetes-local",
    });
    const valid = runtimeSelected;
    const { created, configurationId, item } = await deployableAgent(context, {
      values: valid,
      name: "Channel bindings consumer",
      secretName: "channel-bindings-key",
    });
    const bothBindings = {
      SLACK_APP_TOKEN: await createEnvSecretBinding(context, "slack-app"),
      SLACK_BOT_TOKEN: await createEnvSecretBinding(context, "slack-bot"),
    };
    const slackWith = (slack: OpenClawConfigurationDocument) => ({
      ...valid,
      channels: {
        slack: {
          enabled: true,
          mode: "socket",
          appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
          botToken: "${SLACK_BOT_TOKEN}",
          ...slack,
        },
      },
    });
    const slack = slackWith({});
    const botRefusal = unboundReferenceRefusal("channels.slack.botToken", "SLACK_BOT_TOKEN");
    const appRefusal = unboundReferenceRefusal("channels.slack.appToken", "SLACK_APP_TOKEN");
    const unchanged = async (label: string) => {
      const result = await context.request("GET", item);
      assert.ok(Check(schemaContext, ConfigurationResponse, result.body));
      assert.deepEqual(result.body.data, created, label);
    };

    // Create: one binding of two is refused, naming the other; both save.
    assertRefused(
      await context.request("POST", context.collection, {
        kind: "agent",
        values: slack,
        secretBindings: { SLACK_APP_TOKEN: bothBindings.SLACK_APP_TOKEN },
      }),
      botRefusal,
      { label: "create with one binding" },
    );
    const saved = await context.request("POST", context.collection, {
      kind: "agent",
      values: slack,
      secretBindings: bothBindings,
    });
    assert.equal(saved.status, 201, JSON.stringify(saved.body));

    // Update that adds the references and keeps the Configuration's bindings (none).
    assertRefused(await context.request("PATCH", item, { values: slack }), appRefusal, {
      label: "update adds references",
    });
    await unchanged("update adds references");
    // Values and bindings in one update save; then an update that drops one binding is refused.
    const bound = await context.request("PATCH", item, {
      values: slack,
      secretBindings: bothBindings,
    });
    assert.equal(bound.status, 200, JSON.stringify(bound.body));
    // An update of values only, as the Console's Configuration JSON editor sends, keeps and checks
    // against the stored bindings.
    const valuesOnly = await updateSaved(context.request, item, slack);
    assert.deepEqual(valuesOnly.secretBindings, bothBindings);
    assertRefused(
      await context.request("PATCH", item, {
        values: slack,
        secretBindings: { SLACK_BOT_TOKEN: bothBindings.SLACK_BOT_TOKEN },
      }),
      appRefusal,
      { label: "update removes a binding" },
    );
    const unchangedAfterRemoval = await context.request("GET", item);
    assert.ok(Check(schemaContext, ConfigurationResponse, unchangedAfterRemoval.body));
    assert.deepEqual(unchangedAfterRemoval.body.data, valuesOnly, "update removes a binding");

    // A reference under a named account names its own setting; a disabled channel is not checked.
    assertRefused(
      await context.request("PATCH", item, {
        values: slackWith({ accounts: { work: { botToken: "${WORK_BOT_TOKEN}" } } }),
        secretBindings: bothBindings,
      }),
      unboundReferenceRefusal("channels.slack.accounts.work.botToken", "WORK_BOT_TOKEN"),
      { label: "named account" },
    );
    // A binding is an own key: an inherited name such as `constructor` binds nothing.
    assertRefused(
      await context.request("PATCH", item, {
        values: slackWith({ botToken: { source: "env", provider: "default", id: "constructor" } }),
        secretBindings: bothBindings,
      }),
      unboundReferenceRefusal("channels.slack.botToken", "constructor"),
      { label: "inherited name" },
    );
    // The runtime does not substitute a lowercase name, so it would send `${constructor}` itself as
    // the token: a secret-input field refuses it, whatever the bindings hold (finding 2477).
    assertRefused(
      await context.request("PATCH", item, {
        values: slackWith({ botToken: "${constructor}" }),
        secretBindings: bothBindings,
      }),
      unsubstitutedReferenceRefusal("channels.slack.botToken", "${constructor}"),
      { label: "lowercase name" },
    );
    const disabled = await context.request("PATCH", item, {
      values: slackWith({ enabled: false }),
      secretBindings: {},
    });
    assert.equal(disabled.status, 200, JSON.stringify(disabled.body));

    // A row an older release stored without bindings still reads. As for every save rule, an
    // update that keeps the reference unbound is refused even when it changes something else, and
    // one that adds the bindings repairs it.
    await writePastOcc(configurationDriver, configurationId, slack);
    const stored = await context.request("GET", item);
    assert.equal(stored.status, 200, JSON.stringify(stored.body));
    assert.ok(Check(schemaContext, ConfigurationResponse, stored.body));
    assert.deepEqual(stored.body.data.values, slack);
    assertRefused(
      await context.request("PATCH", item, {
        values: { ...slack, env: { vars: { HTTP_PROXY: "http://proxy:3128" } } },
      }),
      appRefusal,
      { label: "unrelated update of a stored row" },
    );
    const repaired = await context.request("PATCH", item, {
      values: slack,
      secretBindings: bothBindings,
    });
    assert.equal(repaired.status, 200, JSON.stringify(repaired.body));
    assert.ok(Check(schemaContext, ConfigurationResponse, repaired.body));
    assert.deepEqual(repaired.body.data.secretBindings, bothBindings);

    // Agent create's check refuses the reference when the caller sends the bindings it will save,
    // before any Secret or Configuration is saved; without them, that check is skipped.
    const validate = (configuration: DraftConfiguration) =>
      context.request("POST", `/namespaces/${context.namespace.id}/agents/validate`, {
        configuration: { kind: "agent", ...configuration },
        executionMode: "dedicated",
      });
    assertRefused(
      await validate({
        values: slack,
        secretBindings: { SLACK_APP_TOKEN: bothBindings.SLACK_APP_TOKEN },
      }),
      botRefusal,
      { label: "validate" },
    );
    for (const configuration of [
      { values: slack, secretBindings: bothBindings },
      { values: slack },
    ]) {
      const checked = await validate(configuration);
      assert.equal(checked.status, 204, JSON.stringify(checked.body));
      assert.equal(checked.body, undefined);
    }
  });

  // The Slack Channel Driver reads a token only from an env SecretRef with the default provider or
  // one whole `${NAME}`, and refuses any other SecretRef with binding_required at provisioning and
  // deployment. Save refuses those where the binding rule runs, for exactly the tokens the Driver
  // checks, naming the setting and never the value (finding 2514).
  test("Configuration save and Agent create's check refuse a Slack token SecretRef the Slack Channel Driver cannot read", async (t) => {
    // The real Filesystem Configuration Driver, whose credential slot rule runs after OCC's.
    const root = await temporaryDirectory(t, "occ-slack-token-refs-");
    const context = await fixture({
      configurationDriver: new FilesystemConfigurationDriver(root),
      computeDriver: kubernetesRules("compute-slack-token-refs"),
      computeImplementation: "kubernetes-local",
    });
    await context.controller.transact((state) =>
      state.namespaces.transitionNamespaceStatus(context.namespace.id, "provisioning", "ready"),
    );
    const secretBindings = {
      SLACK_APP_TOKEN: await createEnvSecretBinding(context, "slack-app"),
      SLACK_BOT_TOKEN: await createEnvSecretBinding(context, "slack-bot"),
    };
    const appToken = { source: "env", provider: "default", id: "SLACK_APP_TOKEN" };
    const fileRef = { source: "file", provider: "default", id: "/run/slack/bot" };
    const slackWith = (slack: OpenClawConfigurationDocument) => ({
      ...runtimeSelected,
      channels: {
        slack: {
          enabled: true,
          mode: "socket",
          appToken,
          botToken: "${SLACK_BOT_TOKEN}",
          ...slack,
        },
      },
    });
    const save = (values: OpenClawConfigurationDocument) =>
      context.request("POST", context.collection, { kind: "agent", values, secretBindings });
    const validate = (values: OpenClawConfigurationDocument) =>
      context.request("POST", `/namespaces/${context.namespace.id}/agents/validate`, {
        configuration: { kind: "agent", values, secretBindings },
        executionMode: "dedicated",
      });

    for (const [slack, path] of [
      [{ botToken: fileRef }, "channels.slack.botToken"],
      [
        { appToken: { source: "exec", provider: "default", id: "slack" } },
        "channels.slack.appToken",
      ],
      [
        { botToken: { source: "env", provider: "vault", id: "SLACK_BOT_TOKEN" } },
        "channels.slack.botToken",
      ],
      [{ accounts: { work: { botToken: fileRef } } }, "channels.slack.accounts.work.botToken"],
      // An account named "default" replaces the implicit one, and inherits the channel's token.
      [{ botToken: fileRef, accounts: { default: { appToken } } }, "channels.slack.botToken"],
    ] satisfies readonly (readonly [OpenClawConfigurationDocument, string])[]) {
      const values = slackWith(slack);
      const label = JSON.stringify(slack);
      assertRefused(await save(values), unreadableSlackReference(path), {
        label,
        sentinel: "/run/slack/bot",
      });
      assertRefused(await validate(values), unreadableSlackReference(path), { label });
    }
    // The Driver reads no other object either, and the Configuration Driver accepts one there, so
    // it is refused without being called a SecretRef, never echoing the value (finding 2518).
    for (const botToken of [
      { value: "xoxb-not-a-reference" },
      {},
    ] satisfies readonly OpenClawConfigurationValue[]) {
      assertRefused(
        await save(slackWith({ botToken })),
        unreadableSlackTokenRefusal("channels.slack.botToken", "object"),
        { label: JSON.stringify(botToken), sentinel: "xoxb-not-a-reference" },
      );
    }
    // The Driver skips the app token in HTTP mode, a disabled account and fields it does not read,
    // and the channel's token when an account called "default" sets its own (finding 2519).
    for (const slack of [
      { mode: "http", appToken: fileRef },
      { accounts: { work: { enabled: false, botToken: fileRef } } },
      { signingSecret: fileRef },
      { botToken: fileRef, accounts: { default: { appToken, botToken: "${SLACK_BOT_TOKEN}" } } },
      // The Driver reads an env SecretRef without a provider as the default one.
      { botToken: { source: "env", id: "SLACK_BOT_TOKEN" } },
    ] satisfies readonly OpenClawConfigurationDocument[]) {
      const saved = await save(slackWith(slack));
      assert.equal(saved.status, 201, `${JSON.stringify(slack)}: ${JSON.stringify(saved.body)}`);
    }
  });

  // Another Compute may resolve channel credentials without OCC Secret bindings (SSH Compute reads
  // the host's operator-owned environment file), so OCC applies the binding rule only on the
  // bundled Kubernetes Compute (finding 2319).
  test("Configuration save keeps an unbound channel credential reference on a Compute other than the bundled Kubernetes one", async () => {
    const context = await fixture({
      computeDriver: kubernetesRules("compute-other-channel-bindings"),
    });
    const slack = {
      ...runtimeSelected,
      channels: {
        slack: {
          enabled: true,
          mode: "socket",
          appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
          botToken: "${SLACK_BOT_TOKEN}",
        },
      },
    };
    const saved = await context.request("POST", context.collection, {
      kind: "agent",
      values: slack,
    });
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
  });

  // The bundled Kubernetes Compute has two implementations: the Installation default
  // (`occ/kubernetes`) and the Driver's own default (`kubernetes-local`). Under either, OCC checks
  // every enabled channel account, not only the default, and Agent provisioning checks the bindings it
  // creates the Configuration with, none when the request sends none (finding 2319).
  for (const computeImplementation of ["occ/kubernetes", "kubernetes-local"]) {
    test(`Configuration create and Agent provisioning check every Slack account's credential references on ${computeImplementation}`, async () => {
      const backend = createConfigurationBackend();
      const context = await fixture({
        // Agent provisioning requires exact create and inspect; the refusal comes first.
        configurationDriver: {
          ...backend,
          createExact: (configuration) => backend.create(configuration),
          inspectExact: async () => undefined,
        },
        computeDriver: {
          ...kubernetesRules(`compute-channels-${computeImplementation}`),
          agentProvisioning: { executionModes: ["dedicated"] },
          validateAgentProvisioning() {},
          async provisionAgentRuntimeCredentials() {
            return { transportConfigured: true };
          },
          async getAgentRuntimeCredentialStatus() {
            return { transportConfigured: false };
          },
        },
        computeImplementation,
      });
      await context.controller.transact((state) =>
        state.namespaces.transitionNamespaceStatus(context.namespace.id, "provisioning", "ready"),
      );
      const slackBindings = {
        SLACK_APP_TOKEN: await createEnvSecretBinding(context, "slack-app"),
        SLACK_BOT_TOKEN: await createEnvSecretBinding(context, "slack-bot"),
      };
      const values = {
        ...runtimeSelected,
        channels: {
          slack: {
            enabled: true,
            mode: "socket",
            appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
            botToken: "${SLACK_BOT_TOKEN}",
            accounts: {
              alt: {
                enabled: true,
                appToken: "${SLACK_ALT_APP}",
                botToken: "${SLACK_BOT_TOKEN}",
              },
            },
          },
        },
      };
      const create = (secretBindings: SecretBindings) =>
        context.request("POST", context.collection, { kind: "agent", values, secretBindings });

      // The default account's references are bound; the secondary account's is not.
      assertRefused(
        await create(slackBindings),
        unboundReferenceRefusal("channels.slack.accounts.alt.appToken", "SLACK_ALT_APP"),
      );
      const allBindings = {
        ...slackBindings,
        SLACK_ALT_APP: await createEnvSecretBinding(context, "slack-alt-app"),
      };
      const saved = await create(allBindings);
      assert.equal(saved.status, 201, JSON.stringify(saved.body));
      assert.ok(Check(schemaContext, ConfigurationResponse, saved.body));
      const savedId = saved.body.data.id;
      // The runtime substitutes a reference anywhere in a value, and with a `:-fallback` too: an
      // unbound name is never set, so the fallback (here empty) would replace it. Each needs a
      // binding, and the first unbound one is named (finding 2475). `$${NAME}` is the runtime's
      // escape for literal text, not a reference.
      const withAppToken = (appToken: string) => ({
        ...values,
        channels: {
          slack: {
            ...values.channels.slack,
            accounts: { alt: { ...values.channels.slack.accounts.alt, appToken } },
          },
        },
      });
      // In this secret-input field the runtime also reads a whole `$NAME` as an environment
      // SecretRef (finding 2476).
      for (const appToken of [
        "secret-${SLACK_ALT_SECRET}",
        "${SLACK_ALT_SECRET:-}",
        "${SLACK_ALT_APP}-${SLACK_ALT_SECRET:-fallback}",
        "$SLACK_ALT_SECRET",
      ]) {
        assertRefused(
          await context.request("PATCH", `${context.collection}/${savedId}`, {
            values: withAppToken(appToken),
            secretBindings: allBindings,
          }),
          unboundReferenceRefusal("channels.slack.accounts.alt.appToken", "SLACK_ALT_SECRET"),
          { label: appToken },
        );
      }
      // A `${` the runtime does not substitute (a lowercase name, `-` without `:`) would reach
      // Slack as written, so it is refused even with every binding (finding 2477). That text may be
      // the token itself: the message shows only a lowercase `${name}` or the name before `-`,
      // and never the rest of the value.
      const secretText = "9f3c2a7b1d8e4f60a5b6c7d8e9f01234";
      for (const [appToken, message] of [
        [
          "${slack_token}",
          unsubstitutedReferenceRefusal("channels.slack.accounts.alt.appToken", "${slack_token}"),
        ],
        [
          `\${${secretText}}`,
          unsubstitutedReferenceRefusal("channels.slack.accounts.alt.appToken"),
        ],
        [
          `${secretText}\${SLACK_ALT_APP-${secretText}}`,
          unsubstitutedFallbackRefusal("channels.slack.accounts.alt.appToken", "SLACK_ALT_APP"),
        ],
      ] as const) {
        assertRefused(
          await context.request("PATCH", `${context.collection}/${savedId}`, {
            values: withAppToken(appToken),
            secretBindings: allBindings,
          }),
          message,
          { label: appToken, sentinel: secretText },
        );
      }
      // A token shaped like a name is shown only when it is lowercase, as a mistyped name is: a
      // mixed-case one may be the token (finding 2485).
      const identifierToken = "Zr9kq2LmP4xT7vB1nW3c";
      assertRefused(
        await context.request("PATCH", `${context.collection}/${savedId}`, {
          values: withAppToken(`\${${identifierToken}}`),
          secretBindings: allBindings,
        }),
        unsubstitutedReferenceRefusal("channels.slack.accounts.alt.appToken"),
        { label: identifierToken, sentinel: identifierToken },
      );
      for (const appToken of ["${SLACK_ALT_APP}$${SLACK_ALT_SECRET}", "$SLACK_ALT_APP"]) {
        const accepted = await context.request("PATCH", `${context.collection}/${savedId}`, {
          values: withAppToken(appToken),
          secretBindings: allBindings,
        });
        assert.equal(accepted.status, 200, `${appToken}: ${JSON.stringify(accepted.body)}`);
      }
      // A Preset carries no Secret bindings, so its defaults are not checked against any: the
      // Configuration created from it is checked with its own bindings.
      const preset = await context.request("POST", context.presets, {
        name: "Channels",
        template: { configuration: { values } },
      });
      assert.equal(preset.status, 201, JSON.stringify(preset.body));
      assert.ok(Check(schemaContext, PresetResponse, preset.body));

      // Provisioning without bindings is checked against none: the first reference is refused
      // before the Configuration is created.
      const harnessSecret = await context.controller.createSecret(context.principalId, {
        namespaceId: context.namespace.id,
        name: "channels-agent-key",
        value: "synthetic-configuration-key",
      });
      await assert.rejects(
        context.controller.provisionAgent(context.principalId, {
          namespaceId: context.namespace.id,
          requestId: "channels-agent",
          name: "Channels",
          executionMode: "dedicated",
          // Channels need a dedicated OpenClaw, which lists its native model catalog.
          configuration: {
            kind: "agent",
            values: {
              ...createHarnessConfiguration("openclaw", "gpt-4.1"),
              channels: values.channels,
            },
          },
          harnessAuth: { method: "api_key", source: harnessSecret.ref },
        }),
        {
          name: "ConfigurationHarnessError",
          message: unboundReferenceRefusal("channels.slack.appToken", "SLACK_APP_TOKEN"),
        },
      );
      assert.deepEqual(
        backend.storedConfigurations().map(({ id }) => id),
        [savedId],
      );
    });
  }
}
