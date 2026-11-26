import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, type TestContext } from "node:test";
import { revisionCredentialSourceSnapshot } from "../../packages/contracts/src/index.ts";
import type {
  AgentRevision,
  ComputeDriver,
  CredentialProxyDriver,
  DeploymentCredentialBinding,
  Namespace,
  ResolvedCredential,
} from "../../packages/contracts/src/index.ts";
import {
  ActivationPendingError,
  OpenClawController,
  CredentialDeploymentFailedError,
  PersistedStateInvalidError,
  PostgresPlatformState,
  ResourceStateConflictError,
  type PlatformReadView,
} from "../../packages/occ/src/index.ts";
import { installationControllerOptions } from "../../apps/controller/src/composition/installation-config.ts";
import { installSelectedSandboxDrivers } from "../../apps/controller/src/composition/sandbox-drivers.ts";
import {
  gatewayStartupSourceDelivery,
  installTokenServiceDriver,
} from "../../apps/controller/src/composition/token-service.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import {
  MANAGED_BY,
  MANAGED_BY_LABEL,
  createOpenShellBackend,
  openShellProviderName,
} from "../../apps/controller/src/backends/openshell.ts";
import { BUILTIN_CODEX_OAUTH_PRESET } from "../../apps/controller/src/backends/token-service/codex-oauth-preset.ts";
import { SlackChannelDriver } from "../../apps/controller/src/drivers/channel/slack.ts";
import { OpenShellCredentialProxyDriver } from "../../apps/controller/src/drivers/credential-proxy/openshell.ts";
import { prepareOccTokenServiceProviderCopy } from "../../apps/controller/src/drivers/credential-proxy/openshell-pushed-provider.ts";
import { OPEN_SHELL_CODEX_BINARIES } from "../../apps/controller/src/drivers/sandbox/openshell-codex-artifacts.ts";
import type {
  OpenShellGatewayClient,
  OpenShellProviderCreateRequest,
  OpenShellProviderResponse,
  OpenShellSandboxProviderStatus,
  OpenShellStoredProviderProfile,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { OCCTokenServiceDriver } from "../../apps/controller/src/drivers/token-service/occ.ts";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import { createOccLogger } from "../../apps/controller/src/logging.ts";
import { authenticatedHeaders, signInToControllerApp } from "../helpers/auth-session.ts";
import { channelEgressOptions } from "../helpers/channel-egress.ts";
import { completeOpenShellGatewayClient } from "../helpers/openshell-gateway-client.ts";
import { createPostgresControllerAuth } from "../helpers/password-hasher.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import type { RevisionFixture } from "../helpers/postgres-worker-refused-candidate.ts";
import { requiresPostgres } from "../helpers/postgres-backend-state.mjs";
import { loadInstallationFile } from "../helpers/installation-file.ts";
import { jsonLineDestination } from "../helpers/json-lines.ts";
import { useInstallationSecretDriver } from "../helpers/kubernetes-secret-core.mjs";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.ts";
import type { FixtureDriver } from "../helpers/kubernetes-workspace-setup.ts";
import { createInstallationDriverConfiguration } from "../helpers/installation-driver-configuration.ts";
import { createDedicatedDeployKubernetesFixture } from "../conformance/kubernetes-dedicated-deploy-fixture.ts";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.ts";
import { waitFor } from "../helpers/wait-for.ts";
import { auditEvent } from "./postgres-namespace-iam-fixture.ts";
import { buildSandboxInstallation } from "./sandbox-driver-installation-fixture.ts";
import { createRuntimeComputeDriver } from "./postgres-agent-provisioning-transport-fixture.ts";
import {
  createCredentialSourceRevisionCases,
  removeSourceGrant,
} from "./postgres-worker-credential-scenarios.ts";

// The lane prepares one migrated template for this entry. Every case clones it
// through the shared fixture and the process owns its teardown backstop.
const cases = createCredentialSourceRevisionCases(import.meta.url);
after(cases.cleanup);

async function gatewaySourceWorkerFixture(
  fixture: RevisionFixture,
  context: TestContext,
  options: { channelRuntime?: boolean } = {},
) {
  const compute = createTestKubernetesComputeDriver(fixture.compute.id, {
    gatewayRuntime: true,
    ...(options.channelRuntime === undefined ? {} : { channelRuntime: options.channelRuntime }),
    privateStatus: true,
  });
  const installation = createInstallationDriverConfiguration();
  installation.drivers.compute.id = compute.id;
  Object.assign(installation.drivers, {
    token_service: { id: "occ", configuration: {} },
  });
  const loaded = await loadInstallationFile(context, installation);
  assert.ok(loaded);
  const { core, driver: secretDriver } = useInstallationSecretDriver(fixture.controller);
  core.secretUid = randomUUID();
  const runtime = {
    ...loaded,
    computeDriver: compute,
    secretDriver,
    installation: {
      ...loaded.installation,
      drivers: {
        ...loaded.installation.drivers,
        secret: { ...loaded.installation.drivers.secret, id: secretDriver.id },
      },
    },
  };
  const controller = new OpenClawController(fixture.installation, {
    state: fixture.state,
    ...installationControllerOptions(runtime.installation),
    gatewayStartupSourceDelivery: gatewayStartupSourceDelivery(runtime),
    recordOperations: true,
  });
  for (const capability of ["iam", "configuration"] as const) {
    const driver = fixture.controller.selectedDriver(capability);
    controller.registerDriver(driver);
    controller.selectDriver(capability, driver.id);
  }
  for (const driver of [compute, secretDriver]) {
    controller.registerDriver(driver);
    controller.selectDriver(driver.capability, driver.id);
  }
  await installTokenServiceDriver(controller, runtime, fixture.state);
  assert.ok(controller.selectedDriver("token_service") instanceof OCCTokenServiceDriver);

  const namespaceId = fixture.namespace.id;
  const namespace = core.addNamespace(namespaceId);
  const namespaceObject = core.namespaces.get(namespace);
  assert.ok(namespaceObject);
  const placeholder = { id: "pending" };
  const transport = createDedicatedDeployKubernetesFixture(
    {
      namespace,
      gatewayName: "pending",
      state: { gatewayAppliesBinding: false },
      revision: placeholder,
      sandboxDriver: undefined,
      clock: undefined,
    },
    (save) => {
      save({ apiVersion: "v1", kind: "Namespace", ...namespaceObject });
      for (const policy of (compute as unknown as FixtureDriver).networkPolicies(
        { namespaceId },
        { name: namespace, plane: "control" },
      )) {
        save(policy);
      }
    },
  );
  const stagedWrites: string[] = [];
  const createSecret = transport.clients.core.createNamespacedSecret!;
  Reflect.set(
    compute,
    "apiClients",
    Promise.resolve({
      ...transport.clients,
      core: {
        ...transport.clients.core,
        listNamespace: core.listNamespace.bind(core),
        async createNamespacedSecret(request: Parameters<typeof createSecret>[0]) {
          if (request.body.metadata.name.startsWith("gateway-secrets-")) {
            stagedWrites.push(request.body.metadata.name);
          }
          return createSecret(request);
        },
        async listNamespacedPod() {
          return { items: [] };
        },
      },
      apps: {
        ...transport.clients.apps,
        async listNamespacedDeployment() {
          return { items: [] };
        },
      },
      version: {
        async getCode() {
          return { gitVersion: "v1.35.0" };
        },
      },
    }),
  );

  const beforeEnrollment = new Set(core.secrets.keys());
  const enroll = (secret: string = randomUUID(), providerPreset: "openai" | null = "openai") =>
    controller.createManagedCredentialSource(
      fixture.actor.id,
      namespaceId,
      {
        type: "static",
        name: `Gateway startup ${randomUUID()}`,
        lifecycleConfig: { settings: {} },
        ...(providerPreset === null ? {} : { providerPreset }),
        secret,
      },
      (ref, phase) => ({
        ...auditEvent(
          fixture.installation.id,
          namespaceId,
          fixture.actor.id,
          "openclaw.credential_sources.create",
          ref,
        ),
        ...(phase ? { details: { phase } } : {}),
      }),
    );
  return {
    compute,
    controller,
    core,
    runtime,
    transport,
    namespaceId,
    namespace,
    placeholder,
    stagedWrites,
    enroll,
    beforeEnrollment,
  };
}

async function slackChannelSourceFixture(fixture: RevisionFixture, context: TestContext) {
  const { controller, compute, core, enroll, namespaceId, beforeEnrollment } =
    await gatewaySourceWorkerFixture(fixture, context, { channelRuntime: true });
  const configurationDriver = createTestConfigurationDriver({
    id: `slack-configuration-${randomUUID()}`,
    exact: true,
  });
  controller.registerDriver(configurationDriver);
  controller.selectDriver("configuration", configurationDriver.id);
  const effects = { providerCalls: 0, botCustodyReads: 0, appCustodyReads: 0 };
  const channel = new SlackChannelDriver((async (url, init) => {
    assert.equal(String(url), "https://slack.com/api/auth.test");
    assert.match((init?.headers as Record<string, string>).authorization!, /^Bearer xoxb-/);
    effects.providerCalls += 1;
    return Response.json({ ok: true, bot_id: "B0123456789", team_id: "T0123456789" });
  }) satisfies typeof fetch);
  controller.registerDriver(channel);
  controller.selectDriver("channel", channel.id);

  const bot = await enroll(`xoxb-${randomUUID()}`, null);
  const app = await enroll(`xapp-${randomUUID()}`, null);
  const custodyKeys = [...core.secrets.keys()].filter((key) => !beforeEnrollment.has(key));
  assert.equal(custodyKeys.length, 2);
  const model = await controller.createSecret(fixture.actor.id, {
    namespaceId,
    name: `Harness PAT ${randomUUID()}`,
    value: randomUUID(),
  });
  const configuration = {
    kind: "agent" as const,
    values: {
      ...createHarnessConfiguration("codex", "gpt-5"),
      channels: {
        slack: {
          enabled: true,
          appToken: "${SLACK_APP_TOKEN}",
          botToken: "${SLACK_BOT_TOKEN}",
        },
      },
    },
    secretBindings: {
      SLACK_APP_TOKEN: { source: app.ref },
      SLACK_BOT_TOKEN: { source: bot.ref },
    },
  };
  const harnessAuth = { method: "codex_pat" as const, source: model.ref };
  const callerId = `slack-source-caller-${randomUUID()}`;
  await fixture.copyActorGrants(callerId, { withoutActions: ["operate", "create"] });
  const targetGrants = {} as Record<"agent" | "configuration", { id: string; roleId: string }>;
  for (const resourceKind of ["agent", "configuration"] as const) {
    // Collection create grants are Installation policy, not Namespace AccessBindings.
    const roleId = `role-slack-target-${randomUUID()}`;
    const bindingId = `binding-slack-target-${randomUUID()}`;
    await fixture.observerPool.query(
      "INSERT INTO occ.iam_roles (id, namespace_id, name, permissions) VALUES ($1, NULL, $2, $3::jsonb)",
      [
        roleId,
        `Slack target ${randomUUID()}`,
        JSON.stringify([{ action: "create", resourceKind }]),
      ],
    );
    await fixture.observerPool.query(
      "INSERT INTO occ.iam_access_bindings (id, namespace_id, identity_subject_id, role_id) VALUES ($1, NULL, $2, $3)",
      [bindingId, callerId, roleId],
    );
    targetGrants[resourceKind] = { id: bindingId, roleId };
  }
  const credentialRole = await controller.createIAMRole(fixture.actor.id, {
    namespaceId,
    permissions: [
      { action: "operate", resourceKind: "secret" },
      { action: "operate", resourceKind: "credential_source" },
    ],
  });
  const grant = (resourceKind: "secret" | "credential_source", resourceId: string) =>
    controller.createIAMAccessBinding(fixture.actor.id, {
      namespaceId,
      subjectKind: "identity",
      subjectId: callerId,
      roleId: credentialRole.id,
      resourceKind,
      resourceId,
    });
  await grant("secret", model.id);
  await grant("credential_source", app.id);
  const botGrant = await grant("credential_source", bot.id);
  const request = () => ({
    namespaceId,
    requestId: `req_${randomUUID()}`,
    name: `Slack Gateway Source ${randomUUID()}`,
    configuration,
    executionMode: "dedicated" as const,
    harnessAuth,
  });

  let paused:
    { entered: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> } | undefined;
  const pauseBot = () => {
    paused = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
    return paused;
  };
  const read = core.readNamespacedSecret.bind(core);
  context.mock.method(
    core,
    "readNamespacedSecret",
    async (input: { namespace: string; name: string }) => {
      const value = await read(input);
      const key = `${input.namespace}/${input.name}`;
      if (key === custodyKeys[1]) {
        effects.appCustodyReads += 1;
      }
      if (key === custodyKeys[0]) {
        effects.botCustodyReads += 1;
        if (paused !== undefined) {
          const gate = paused;
          paused = undefined;
          gate.entered.resolve();
          await gate.release.promise;
        }
      }
      return value;
    },
  );
  return {
    controller,
    compute,
    namespaceId,
    bot,
    model,
    configuration,
    harnessAuth,
    callerId,
    botGrant,
    targetGrants,
    configurationDriver,
    request,
    effects,
    pauseBot,
  };
}

cases.revisionTest(
  "Slack Sources validate app and bot and bind Gateway-only fields during provisioning and deployment",
  async (fixture, context) => {
    const { controller, namespaceId, bot, configuration, harnessAuth, callerId, request, effects } =
      await slackChannelSourceFixture(fixture, context);
    // Gateway-only Slack fields use the same binding contract as app/bot. Explicit Source reuse
    // is allowed by IAM; this fixture proves admission and delivery metadata, not Slack semantics.
    const allFields = {
      ...configuration,
      values: {
        ...configuration.values,
        channels: {
          slack: {
            ...configuration.values.channels.slack,
            signingSecret: "${SLACK_SIGNING_SECRET}",
            userToken: "${SLACK_USER_TOKEN}",
            relay: { authToken: "${SLACK_RELAY_AUTH_TOKEN}" },
          },
        },
      },
      secretBindings: {
        ...configuration.secretBindings,
        SLACK_SIGNING_SECRET: { source: bot.ref },
        SLACK_USER_TOKEN: { source: bot.ref },
        SLACK_RELAY_AUTH_TOKEN: { source: bot.ref },
      },
    };
    // Preflight and Configuration save check structure and exact bindings without provider IO.
    await controller.validateAgentCreate(
      fixture.actor.id,
      { namespaceId, configuration: allFields, executionMode: "dedicated", harnessAuth },
      resolveApprovedHarness,
    );
    const saved = await controller.createConfiguration(fixture.actor.id, {
      namespaceId,
      ...allFields,
    });
    assert.equal(effects.providerCalls, 0);
    const provisioningRequest = {
      ...request(),
      configuration: allFields,
    };
    const accepted = await controller.provisionAgent(callerId, provisioningRequest);
    assert.ok(accepted.provisioning.workId);
    assert.equal(effects.providerCalls, 1);
    assert.ok(effects.appCustodyReads > 0, "the xapp Source is resolved and validated locally");
    // An accepted replay reuses the original work rather than authenticating with Slack again.
    const replay = await controller.provisionAgent(callerId, provisioningRequest);
    assert.equal(replay.provisioning.workId, accepted.provisioning.workId);
    assert.equal(effects.providerCalls, 1, "accepted replay does not repeat Slack provider I/O");
    const agent = await controller.createAgent(
      fixture.actor.id,
      {
        namespaceId,
        name: `Slack Source deploy ${randomUUID()}`,
        configurationId: saved.id,
        executionMode: "dedicated",
        harnessAuth,
      },
      resolveApprovedHarness,
    );
    const revision = await controller.deployAgent(
      fixture.actor.id,
      { namespaceId, agentId: agent.id },
      resolveApprovedHarness,
    );
    assert.equal(revision.secretBindings?.SLACK_BOT_TOKEN?.source.id, bot.id);
    for (const key of ["SLACK_SIGNING_SECRET", "SLACK_USER_TOKEN", "SLACK_RELAY_AUTH_TOKEN"]) {
      assert.equal(revision.secretBindings?.[key]?.source.id, bot.id);
    }
    assert.equal(effects.providerCalls, 2, "ordinary deployment runs Slack bot authentication");
  },
);

cases.revisionTest(
  "Slack Source provisioning refuses unsupported Harness topology and delivery before custody",
  async (fixture, context) => {
    const {
      controller,
      compute,
      namespaceId,
      bot,
      model,
      configuration,
      callerId,
      request,
      effects,
    } = await slackChannelSourceFixture(fixture, context);
    // The authenticated HTTP caller receives the existing 409 before either Slack Source is read.
    const {
      app: api,
      principalId: apiCallerId,
      headers,
    } = await authenticatedSourceOperator(fixture, controller);
    try {
      await copyProvisioningActorBindings(fixture, apiCallerId);
      // Old public Secret bindings must fail at provisioning admission before custody or Slack.
      const legacyBinding = await api.inject({
        method: "POST",
        url: `/namespaces/${namespaceId}/agents/provision`,
        headers,
        payload: {
          requestId: `req_${randomUUID()}`,
          name: `Legacy Slack binding ${randomUUID()}`,
          executionMode: "dedicated",
          harnessAuth: { method: "codex_pat", source: model.ref },
          configuration: {
            ...configuration,
            secretBindings: {
              ...configuration.secretBindings,
              SLACK_BOT_TOKEN: { source: model.ref },
            },
          },
        },
      });
      assert.equal(legacyBinding.statusCode, 400, legacyBinding.body);
      assert.equal(
        legacyBinding.json().error.message,
        "Configuration setting channels.slack.botToken references SLACK_BOT_TOKEN without a Credential Source binding: bind SLACK_BOT_TOKEN to a Credential Source in secretBindings, or remove the reference.",
      );
      assert.deepEqual(effects, { providerCalls: 0, botCustodyReads: 0, appCustodyReads: 0 });
      const refused = await api.inject({
        method: "POST",
        url: `/namespaces/${namespaceId}/agents/provision`,
        headers,
        payload: {
          requestId: `req_${randomUUID()}`,
          name: `Unsupported managed Harness ${randomUUID()}`,
          configuration,
          executionMode: "dedicated",
          harnessAuth: { method: "credential_source", sourceId: bot.id },
        },
      });
      assert.equal(refused.statusCode, 409, refused.body);
      assert.equal(refused.json().error.code, "RESOURCE_CONFLICT");
      assert.equal(
        refused.json().error.message,
        "The Harness credential source has no permitted model provider preset.",
      );
      assert.deepEqual(effects, { providerCalls: 0, botCustodyReads: 0, appCustodyReads: 0 });
      // Dedicated OpenClaw without a provisioning Sandbox is already known to be impossible.
      // Refuse it before resolving either Slack Source or contacting Slack.
      const unsupportedNative = await api.inject({
        method: "POST",
        url: `/namespaces/${namespaceId}/agents/provision`,
        headers,
        payload: {
          requestId: `req_${randomUUID()}`,
          name: `Unsupported native Harness ${randomUUID()}`,
          configuration: {
            ...configuration,
            values: {
              ...createHarnessConfiguration("openclaw", "gpt-4.1"),
              channels: configuration.values.channels,
            },
          },
          executionMode: "dedicated",
          harnessAuth: { method: "api_key", source: model.ref },
        },
      });
      assert.equal(unsupportedNative.statusCode, 409, unsupportedNative.body);
      assert.equal(unsupportedNative.json().error.code, "RESOURCE_CONFLICT");
      assert.match(
        unsupportedNative.json().error.message,
        /^Dedicated OpenClaw requires a provisioning SandboxDriver with networking, filesystem, and process containment\./,
      );
      assert.deepEqual(effects, { providerCalls: 0, botCustodyReads: 0, appCustodyReads: 0 });
    } finally {
      await api.close();
    }
    const otherCompute = createTestKubernetesComputeDriver(`other-${randomUUID()}`, {
      gatewayRuntime: true,
      channelRuntime: true,
      privateStatus: true,
    });
    controller.registerDriver(otherCompute);
    controller.selectDriver("compute", otherCompute.id);
    try {
      await assert.rejects(controller.provisionAgent(callerId, request()), {
        message: "The selected Compute and TokenService do not support Gateway Source delivery.",
      });
      assert.deepEqual(effects, { providerCalls: 0, botCustodyReads: 0, appCustodyReads: 0 });
    } finally {
      controller.selectDriver("compute", compute.id);
    }
  },
);

cases.revisionTest(
  "Slack Source provisioning rechecks exact grants after custody",
  async (fixture, context) => {
    const { controller, namespaceId, botGrant, callerId, request, effects, pauseBot } =
      await slackChannelSourceFixture(fixture, context);
    const gate = pauseBot();
    const denied = controller.provisionAgent(callerId, request());
    try {
      await Promise.race([
        gate.entered.promise,
        denied.then(
          () => assert.fail("provisioning completed before custody read"),
          (error: unknown) => Promise.reject(error),
        ),
      ]);
      // Revocation commits while TokenService awaits the actual Kubernetes custody read.
      await controller.deleteIAMAccessBinding(fixture.actor.id, namespaceId, botGrant.id);
      gate.release.resolve();
      await assert.rejects(denied, (error: Error) => error.name === "AuthorizationDeniedError");
      assert.equal(effects.providerCalls, 0);
      await assert.rejects(
        controller.provisionAgent(callerId, request()),
        (error: Error) => error.name === "AuthorizationDeniedError",
      );
      assert.equal(
        effects.botCustodyReads,
        1,
        "a denied Source must not reach TokenService custody",
      );
      const work = await fixture.observerPool.query(
        "SELECT count(*)::int AS count FROM occ.agent_provisioning_work WHERE namespace_id=$1",
        [namespaceId],
      );
      assert.equal(work.rows[0].count, 0);
    } finally {
      gate.release.resolve();
      await denied.catch(() => undefined);
    }
  },
);

cases.revisionTest(
  "Slack Source provisioning rechecks target authority before custody and provider use",
  async (fixture, context) => {
    const {
      controller,
      namespaceId,
      callerId,
      targetGrants,
      configurationDriver,
      request,
      effects,
      pauseBot,
    } = await slackChannelSourceFixture(fixture, context);
    const configurationEntered = Promise.withResolvers<void>();
    const configurationRelease = Promise.withResolvers<void>();
    const validate = configurationDriver.validate.bind(configurationDriver);
    let holdConfiguration = true;
    context.mock.method(
      configurationDriver,
      "validate",
      async (configuration: Parameters<typeof configurationDriver.validate>[0]) => {
        await validate(configuration);
        if (holdConfiguration) {
          holdConfiguration = false;
          configurationEntered.resolve();
          await configurationRelease.promise;
        }
      },
    );

    // The Agent create grant can disappear while Configuration validation is outside the transaction.
    const beforeCustody = controller.provisionAgent(callerId, request());
    try {
      await Promise.race([configurationEntered.promise, beforeCustody]);
      const revokedAgent = await fixture.observerPool.query(
        "DELETE FROM occ.iam_access_bindings WHERE id=$1",
        [targetGrants.agent.id],
      );
      assert.equal(revokedAgent.rowCount, 1);
      configurationRelease.resolve();
      await assert.rejects(
        beforeCustody,
        (error: Error) => error.name === "AuthorizationDeniedError",
      );
      assert.deepEqual(effects, { providerCalls: 0, botCustodyReads: 0, appCustodyReads: 0 });
      await fixture.observerPool.query(
        "INSERT INTO occ.iam_access_bindings (id, namespace_id, identity_subject_id, role_id) VALUES ($1, NULL, $2, $3)",
        [targetGrants.agent.id, callerId, targetGrants.agent.roleId],
      );

      // A Configuration create grant revoked during the actual custody read must fence Slack dispatch.
      const gate = pauseBot();
      const beforeProvider = controller.provisionAgent(callerId, request());
      try {
        await Promise.race([gate.entered.promise, beforeProvider]);
        const revokedConfiguration = await fixture.observerPool.query(
          "DELETE FROM occ.iam_access_bindings WHERE id=$1",
          [targetGrants.configuration.id],
        );
        assert.equal(revokedConfiguration.rowCount, 1);
        gate.release.resolve();
        await assert.rejects(
          beforeProvider,
          (error: Error) => error.name === "AuthorizationDeniedError",
        );
        assert.equal(effects.providerCalls, 0);
      } finally {
        gate.release.resolve();
        await beforeProvider.catch(() => undefined);
      }
      const work = await fixture.observerPool.query(
        "SELECT count(*)::int AS count FROM occ.agent_provisioning_work WHERE namespace_id=$1",
        [namespaceId],
      );
      assert.equal(work.rows[0].count, 0);
    } finally {
      configurationRelease.resolve();
      await beforeCustody.catch(() => undefined);
    }
  },
);

cases.revisionTest(
  "Slack Source provisioning refuses a Source deleted during custody before provider use",
  async (fixture, context) => {
    const { controller, namespaceId, bot, request, effects, pauseBot } =
      await slackChannelSourceFixture(fixture, context);
    const gate = pauseBot();
    // The administrator keeps broad Source authority after deletion, so this checks Source
    // currentness itself rather than the removal of the caller's exact Source grant.
    const pending = controller.provisionAgent(fixture.actor.id, request());
    try {
      await Promise.race([gate.entered.promise, pending]);
      await controller.deleteCredentialSource(
        fixture.actor.id,
        namespaceId,
        bot.id,
        (_removed, phase) => ({
          ...auditEvent(
            fixture.installation.id,
            namespaceId,
            fixture.actor.id,
            "openclaw.credential_sources.delete",
            bot.ref,
          ),
          ...(phase === undefined ? {} : { details: { phase } }),
        }),
      );
      gate.release.resolve();
      await assert.rejects(pending, {
        message: "Channel credentials require a ready static TokenService Credential Source.",
      });
      assert.equal(effects.providerCalls, 0);
      const work = await fixture.observerPool.query(
        "SELECT count(*)::int AS count FROM occ.agent_provisioning_work WHERE namespace_id=$1",
        [namespaceId],
      );
      assert.equal(work.rows[0].count, 0);
    } finally {
      gate.release.resolve();
      await pending.catch(() => undefined);
    }
  },
);

cases.revisionTest(
  "Slack Source deployment fences embedded topology and changed Configuration",
  async (fixture, context) => {
    const { controller, namespaceId, model, configuration, harnessAuth, effects, pauseBot } =
      await slackChannelSourceFixture(fixture, context);
    // This Agent exists before its Configuration gains Slack Source bindings; deployment must
    // refuse the unsupported embedded topology before Source custody or Slack HTTP.
    const embeddedValues = createHarnessConfiguration("openclaw", "gpt-4.1");
    const embeddedConfiguration = await controller.createConfiguration(fixture.actor.id, {
      namespaceId,
      kind: "agent",
      values: embeddedValues,
    });
    const embeddedAgent = await controller.createAgent(
      fixture.actor.id,
      {
        namespaceId,
        name: `Embedded OpenClaw ${randomUUID()}`,
        configurationId: embeddedConfiguration.id,
        executionMode: "embedded",
        harnessAuth: { method: "api_key", source: model.ref },
      },
      resolveApprovedHarness,
    );
    await controller.updateConfiguration(fixture.actor.id, {
      namespaceId,
      configurationId: embeddedConfiguration.id,
      values: { ...embeddedValues, channels: configuration.values.channels },
      secretBindings: configuration.secretBindings,
    });
    await assert.rejects(
      controller.deployAgent(
        fixture.actor.id,
        { namespaceId, agentId: embeddedAgent.id },
        resolveApprovedHarness,
      ),
      { message: "Gateway Credential Source bindings require dedicated execution." },
    );
    assert.deepEqual(effects, { providerCalls: 0, botCustodyReads: 0, appCustodyReads: 0 });

    const saved = await controller.createConfiguration(fixture.actor.id, {
      namespaceId,
      ...configuration,
    });
    const agent = await controller.createAgent(
      fixture.actor.id,
      {
        namespaceId,
        name: `Slack Source deploy ${randomUUID()}`,
        configurationId: saved.id,
        executionMode: "dedicated",
        harnessAuth,
      },
      resolveApprovedHarness,
    );
    const gate = pauseBot();
    const changedDeploy = controller.deployAgent(
      fixture.actor.id,
      { namespaceId, agentId: agent.id },
      resolveApprovedHarness,
    );
    try {
      await Promise.race([
        gate.entered.promise,
        changedDeploy.then(
          () => assert.fail("deployment completed before custody read"),
          (error: unknown) => Promise.reject(error),
        ),
      ]);
      // Configuration update commits while owner I/O waits. The stale prepared binding must not reach Slack.
      await controller.updateConfiguration(fixture.actor.id, {
        namespaceId,
        configurationId: saved.id,
        values: createHarnessConfiguration("codex", "gpt-5"),
        secretBindings: {},
      });
      gate.release.resolve();
      await assert.rejects(changedDeploy, {
        message: "The Agent or Configuration changed after Channel validation was prepared.",
      });
      assert.equal(effects.providerCalls, 0);
    } finally {
      gate.release.resolve();
      await changedDeploy.catch(() => undefined);
    }
  },
);

cases.revisionTest(
  "the Worker rechecks the exact Source grant after OCC TokenService reads custody and before Gateway launch",
  async (fixture, context) => {
    const {
      compute,
      controller,
      core,
      runtime,
      transport,
      namespaceId,
      namespace,
      placeholder,
      stagedWrites,
      enroll,
      beforeEnrollment,
    } = await gatewaySourceWorkerFixture(fixture, context);
    const source = await enroll();
    const secondSource = await enroll();
    const custodyKeys = [...core.secrets.keys()].filter((key) => !beforeEnrollment.has(key));
    assert.equal(custodyKeys.length, 2);
    const modelSecret = await controller.createSecret(fixture.actor.id, {
      namespaceId,
      name: `Harness PAT ${randomUUID()}`,
      value: randomUUID(),
    });
    for (const secret of core.secrets.values()) {
      if (secret.metadata.namespace === namespace) {
        transport.save({ kind: "Secret", ...secret });
      }
    }
    const configuration = await controller.createConfiguration(fixture.actor.id, {
      namespaceId,
      kind: "agent",
      values: {
        ...createHarnessConfiguration("codex", "gpt-5"),
        cron: { webhookToken: "${GW_HOOK_TOKEN}" },
      },
      secretBindings: {
        GW_HOOK_ALIAS: { source: source.ref },
        GW_HOOK_TOKEN: { source: source.ref },
        GW_SECOND_TOKEN: { source: secondSource.ref },
      },
    });
    const agent = await controller.createAgent(
      fixture.actor.id,
      {
        namespaceId,
        name: `Gateway grant race ${randomUUID()}`,
        configurationId: configuration.id,
        executionMode: "dedicated",
        harnessAuth: { method: "codex_pat", source: modelSecret.ref },
      },
      resolveApprovedHarness,
    );
    const revision = await controller.deployAgent(
      fixture.actor.id,
      { namespaceId, agentId: agent.id },
      resolveApprovedHarness,
    );
    placeholder.id = revision.id;
    const grant = await fixture.observerPool.query<{ id: string }>(
      `SELECT id FROM occ.iam_access_bindings WHERE identity_subject_id = $1
       AND resource_kind = 'credential_source' AND resource_id = $2`,
      [agent.servicePrincipalId, secondSource.id],
    );
    assert.equal(grant.rowCount, 1);

    // Pause the real Kubernetes Secret Driver's custody read after the API supplied bytes.
    // PostgreSQL IAM remains live, so revocation can commit during owner I/O.
    let reached = false;
    let firstSourceReads = 0;
    const release = Promise.withResolvers<void>();
    const read = core.readNamespacedSecret.bind(core);
    context.mock.method(
      core,
      "readNamespacedSecret",
      async (request: { namespace: string; name: string }) => {
        const secret = await read(request);
        const key = `${request.namespace}/${request.name}`;
        if (key === custodyKeys[0]) {
          firstSourceReads += 1;
        }
        if (key === custodyKeys[1]) {
          reached = true;
          await release.promise;
        }
        return secret;
      },
    );
    const events: unknown[] = [];
    try {
      await fixture.start(compute, {
        transformDrivers: () => runtime,
        emit: (event) => events.push(event),
      });
      await waitFor("the OCC TokenService custody read", async () => {
        if (reached) {
          return true;
        }
        const result = await fixture.workResult({
          id: revision.id,
          idempotencyKey: `agent_revision:${revision.id}:reconcile`,
        });
        assert.equal(
          result.rows[0]?.reason_code,
          null,
          `Worker failed before reading custody: ${JSON.stringify(events.slice(-2))}`,
        );
        return undefined;
      });
      await controller.deleteIAMAccessBinding(fixture.actor.id, namespaceId, grant.rows[0]!.id);
    } finally {
      release.resolve();
    }
    const work = { id: revision.id, idempotencyKey: `agent_revision:${revision.id}:reconcile` };
    await fixture.work(work, "failed_permanent");
    assert.equal((await fixture.workResult(work)).rows[0]?.reason_code, "AUTHORIZATION_DENIED");
    const audit = await fixture.observerPool.query(
      `SELECT actor_id, details->'__occAuditMetadata'->'authorization' AS authorization,
              details - '__occAuditMetadata' AS details
       FROM occ.audit_events
       WHERE namespace_id=$1 AND resource_id=$2 AND kind='authorization_denial'`,
      [namespaceId, agent.id],
    );
    assert.deepEqual(audit.rows, [
      {
        actor_id: fixture.actor.id,
        authorization: {
          principalId: agent.servicePrincipalId,
          action: "operate",
          resource: { kind: "credential_source", namespaceId, id: secondSource.id },
        },
        details: { revisionId: revision.id },
      },
    ]);
    assert.equal(firstSourceReads, 1, "the first Source's alias must not cause another owner read");
    assert.deepEqual(
      stagedWrites,
      [],
      "revoked material must never be written, even if cleanup runs",
    );
    assert.equal(
      transport.templates.some(({ name }) => name.startsWith("gateway-")),
      false,
    );
  },
);

cases.revisionTest(
  "the Worker permanently refuses Gateway credentials that exceed one Kubernetes Secret",
  async (fixture, context) => {
    const {
      compute,
      controller,
      core,
      runtime,
      transport,
      namespaceId,
      namespace,
      placeholder,
      stagedWrites,
      enroll,
      beforeEnrollment,
    } = await gatewaySourceWorkerFixture(fixture, context);
    const source = await enroll("x".repeat(65_000));
    const custodyKeys = [...core.secrets.keys()].filter((key) => !beforeEnrollment.has(key));
    assert.equal(custodyKeys.length, 1);
    const modelSecret = await controller.createSecret(fixture.actor.id, {
      namespaceId,
      name: `Harness PAT ${randomUUID()}`,
      value: randomUUID(),
    });
    for (const secret of core.secrets.values()) {
      if (secret.metadata.namespace === namespace) {
        transport.save({ kind: "Secret", ...secret });
      }
    }
    // Each alias is legal; their combined decoded values exceed the one-Secret limit.
    const secretBindings = Object.fromEntries(
      Array.from({ length: 17 }, (_, index) => [`GW_LARGE_${index}`, { source: source.ref }]),
    );
    const configuration = await controller.createConfiguration(fixture.actor.id, {
      namespaceId,
      kind: "agent",
      values: createHarnessConfiguration("codex", "gpt-5"),
      secretBindings,
    });
    const agent = await controller.createAgent(
      fixture.actor.id,
      {
        namespaceId,
        name: `Gateway size refusal ${randomUUID()}`,
        configurationId: configuration.id,
        executionMode: "dedicated",
        harnessAuth: { method: "codex_pat", source: modelSecret.ref },
      },
      resolveApprovedHarness,
    );
    const revision = await controller.deployAgent(
      fixture.actor.id,
      { namespaceId, agentId: agent.id },
      resolveApprovedHarness,
    );
    placeholder.id = revision.id;
    await fixture.start(compute, { transformDrivers: () => runtime });
    const work = { id: revision.id, idempotencyKey: `agent_revision:${revision.id}:reconcile` };
    assert.equal((await fixture.work(work, "failed_permanent")).attempt_count, 1);
    assert.equal(
      (await fixture.workResult(work)).rows[0]?.reason_code,
      "GATEWAY_CREDENTIAL_DELIVERY_REFUSED",
    );
    assert.deepEqual(stagedWrites, [], "oversized values must never be staged");
    assert.equal(
      transport.templates.some(({ name }) => name.startsWith("gateway-")),
      false,
    );
    assert.ok(core.secrets.has(custodyKeys[0]!), "refusal must preserve owner custody");
  },
);

async function gatewaySourceCandidate(
  fixture: RevisionFixture,
  scenario: Awaited<ReturnType<typeof gatewaySourceWorkerFixture>>,
) {
  const { controller, core, namespaceId, namespace, transport } = scenario;
  const source = await scenario.enroll();
  const custodyKey = [...core.secrets.keys()].find((key) => !scenario.beforeEnrollment.has(key));
  assert.ok(custodyKey);
  const custody = structuredClone(core.secrets.get(custodyKey));
  const modelSecret = await controller.createSecret(fixture.actor.id, {
    namespaceId,
    name: `Harness PAT ${randomUUID()}`,
    value: randomUUID(),
  });
  for (const secret of core.secrets.values()) {
    if (secret.metadata.namespace === namespace) {
      transport.save({ kind: "Secret", ...secret });
    }
  }
  const configuration = await controller.createConfiguration(fixture.actor.id, {
    namespaceId,
    kind: "agent",
    values: createHarnessConfiguration("codex", "gpt-5"),
    secretBindings: { GW_HOOK_TOKEN: { source: source.ref } },
  });
  const agent = await controller.createAgent(
    fixture.actor.id,
    {
      namespaceId,
      name: `Gateway abandonment ${randomUUID()}`,
      configurationId: configuration.id,
      executionMode: "dedicated",
      harnessAuth: { method: "codex_pat", source: modelSecret.ref },
    },
    resolveApprovedHarness,
  );
  const revision = await controller.deployAgent(
    fixture.actor.id,
    { namespaceId, agentId: agent.id },
    resolveApprovedHarness,
  );
  scenario.placeholder.id = revision.id;
  return { source, custodyKey, custody, agent, revision };
}

cases.revisionTest(
  "the Worker denies reuse of a staged Gateway credential after Source authority is revoked",
  async (fixture, context) => {
    const scenario = await gatewaySourceWorkerFixture(fixture, context);
    const { compute, controller, core, runtime, transport, namespaceId, namespace, stagedWrites } =
      scenario;
    const { source, custodyKey, custody, agent, revision } = await gatewaySourceCandidate(
      fixture,
      scenario,
    );
    const grant = await fixture.observerPool.query<{ id: string }>(
      `SELECT id FROM occ.iam_access_bindings WHERE identity_subject_id = $1
       AND resource_kind = 'credential_source' AND resource_id = $2`,
      [agent.servicePrincipalId, source.id],
    );
    assert.equal(grant.rowCount, 1);

    const clients = (await Reflect.get(compute, "apiClients")) as typeof transport.clients;
    const patchDeployment = clients.apps.patchNamespacedDeployment!;
    const readSecret = clients.core.readNamespacedSecret!;
    let applies = 0;
    let gatewayDeploymentName: string | undefined;
    let reuseReads = 0;
    clients.apps.patchNamespacedDeployment = async (request) => {
      if (!request.body.metadata.name.startsWith("gateway-")) {
        return patchDeployment(request);
      }
      applies += 1;
      gatewayDeploymentName = request.body.metadata.name;
      const applied = await patchDeployment(request);
      if (applies === 1) {
        assert.ok(
          transport.objects.has(transport.key("Deployment", gatewayDeploymentName, namespace)),
        );
        // An uncertain apply creates the real candidate Deployment and stage, then causes a retry.
        throw new Error("controlled Gateway Deployment apply failure");
      }
      return applied;
    };
    clients.core.readNamespacedSecret = async (request) => {
      const secret = await readSecret(request);
      if (applies === 1 && request.name === stagedWrites[0] && reuseReads === 0) {
        reuseReads += 1;
        assert.ok(transport.objects.has(transport.key("Secret", request.name, namespace)));
        // The retry passed earlier IAM checks. Revoke only after Compute finds the existing stage,
        // so denial now depends on the authorization callback immediately before Deployment apply.
        await controller.deleteIAMAccessBinding(fixture.actor.id, namespaceId, grant.rows[0]!.id);
      }
      return secret;
    };

    await fixture.start(compute, { transformDrivers: () => runtime });
    const work = { id: revision.id, idempotencyKey: `agent_revision:${revision.id}:reconcile` };
    await fixture.work(work, "failed_permanent");
    assert.equal((await fixture.workResult(work)).rows[0]?.reason_code, "AUTHORIZATION_DENIED");
    assert.equal(reuseReads, 1, "the denial must follow the existing stage read");
    assert.equal(applies, 1, "revocation must prevent the retry's Gateway Deployment mutation");
    assert.equal(stagedWrites.length, 1, "the retry must reuse the already staged revision copy");
    assert.ok(gatewayDeploymentName);
    assert.equal(
      transport.objects.has(transport.key("Deployment", gatewayDeploymentName, namespace)),
      false,
      "the refused candidate Gateway Deployment must be removed",
    );
    assert.equal(
      transport.objects.has(transport.key("Secret", stagedWrites[0]!, namespace)),
      false,
      "the refused candidate's staged credential must be removed",
    );
    assert.deepEqual(core.secrets.get(custodyKey), custody, "the Source owner retains custody");
    const denial = await fixture.observerPool.query(
      `SELECT actor_id, details->'__occAuditMetadata'->'authorization' AS authorization,
              details - '__occAuditMetadata' AS details
       FROM occ.audit_events
       WHERE namespace_id=$1 AND resource_id=$2 AND kind='authorization_denial'`,
      [namespaceId, agent.id],
    );
    assert.deepEqual(denial.rows, [
      {
        actor_id: fixture.actor.id,
        authorization: {
          principalId: agent.servicePrincipalId,
          action: "operate",
          resource: { kind: "credential_source", namespaceId, id: source.id },
        },
        details: { revisionId: revision.id },
      },
    ]);
  },
);

cases.revisionTest(
  "the Worker reports a withdrawn Gateway Source before resolving or staging credentials",
  async (fixture, context) => {
    const scenario = await gatewaySourceWorkerFixture(fixture, context);
    const { source, revision } = await gatewaySourceCandidate(fixture, scenario);
    // A concurrent withdrawal can be recorded for an admitted queued companion revision
    // before its reconcile work is claimed. Use the production PostgreSQL repository.
    await fixture.state.transact(async (unit) => {
      await unit.credentialSources.requestCredentialWithdrawal({
        namespaceId: revision.namespaceId,
        agentId: revision.agentId,
        revisionId: revision.id,
        credentialSourceId: source.id,
        state: "pending",
        requestedBy: fixture.actor.id,
        requestedAt: new Date().toISOString(),
      });
    });
    await fixture.start(scenario.compute, { transformDrivers: () => scenario.runtime });
    const work = { id: revision.id, idempotencyKey: `agent_revision:${revision.id}:reconcile` };
    assert.equal((await fixture.work(work, "failed_permanent")).attempt_count, 1);
    assert.equal(
      (await fixture.workResult(work)).rows[0]?.reason_code,
      "CREDENTIAL_SOURCE_UNAVAILABLE",
    );
    assert.deepEqual(scenario.stagedWrites, [], "a withdrawn Source must never be staged");
    assert.equal(
      scenario.transport.templates.some(({ name }) => name.startsWith("gateway-")),
      false,
    );
  },
);

test(
  "the Worker removes an abandoned Gateway Source copy after Deployment retries and Pod termination",
  requiresPostgres,
  async (context) => {
    const fixture = await cases.setup(context, { maxAttempts: 2 });
    const scenario = await gatewaySourceWorkerFixture(fixture, context);
    const { compute, core, runtime, transport, namespaceId, namespace, stagedWrites } = scenario;
    const { custodyKey, custody, agent, revision } = await gatewaySourceCandidate(
      fixture,
      scenario,
    );
    const clients = (await Reflect.get(compute, "apiClients")) as typeof transport.clients;
    const patchDeployment = clients.apps.patchNamespacedDeployment!;
    const deleteDeployment = clients.apps.deleteNamespacedDeployment!;
    const deleteSecret = clients.core.deleteNamespacedSecret!;
    const order: string[] = [];
    let applies = 0;
    let gatewayDeleted = false;
    let podObserved = false;
    clients.apps.patchNamespacedDeployment = async (request) => {
      if (!request.body.metadata.name.startsWith("gateway-")) {
        return patchDeployment(request);
      }
      applies += 1;
      // An uncertain apply can create the Deployment even though the client receives an error.
      await patchDeployment(request);
      throw new Error("controlled Gateway Deployment apply failure");
    };
    clients.apps.deleteNamespacedDeployment = async (request) => {
      if (request.name.startsWith("gateway-")) {
        gatewayDeleted = true;
        order.push("deployment-deleted");
      }
      await deleteDeployment(request);
    };
    clients.core.listNamespacedPod = async (request) => {
      if (
        gatewayDeleted &&
        request.labelSelector?.includes(`openclaw.dev/revision=${revision.id}`) &&
        request.labelSelector.includes("openclaw.dev/workload-role=gateway")
      ) {
        if (!podObserved) {
          podObserved = true;
          assert.ok(transport.objects.has(transport.key("Secret", stagedWrites[0]!, namespace)));
          order.push("pod-present");
          return {
            items: [
              {
                apiVersion: "v1" as const,
                kind: "Pod" as const,
                metadata: {
                  name: "terminating-gateway",
                  namespace,
                  labels: {
                    "openclaw.dev/namespace": namespaceId,
                    "openclaw.dev/agent": agent.id,
                    "openclaw.dev/revision": revision.id,
                    "openclaw.dev/workload-role": "gateway",
                  },
                },
                status: {},
              },
            ],
          };
        }
        order.push("pods-absent");
      }
      return { items: [] };
    };
    clients.core.deleteNamespacedSecret = async (request) => {
      if (request.name.startsWith("gateway-secrets-")) {
        order.push("staged-secret-deleted");
      }
      await deleteSecret(request);
    };
    await fixture.start(compute, { transformDrivers: () => runtime });
    const work = { id: revision.id, idempotencyKey: `agent_revision:${revision.id}:reconcile` };
    await fixture.work(work, "failed_permanent");
    assert.equal((await fixture.workResult(work)).rows[0]?.reason_code, "DEPENDENCY_UNAVAILABLE");
    assert.equal(applies, 2);
    assert.equal(stagedWrites.length, 1);
    assert.equal(
      transport.objects.has(transport.key("Secret", stagedWrites[0]!, namespace)),
      false,
    );
    assert.deepEqual(order, [
      "deployment-deleted",
      "pod-present",
      "pods-absent",
      "staged-secret-deleted",
    ]);
    assert.deepEqual(core.secrets.get(custodyKey), custody, "owner custody survives abandonment");
  },
);

test(
  "the Worker retains failed-preparation cleanup while an abandoned Gateway Source revision cannot be read",
  requiresPostgres,
  async (context) => {
    const fixture = await cases.setup(context, { maxAttempts: 1 });
    const scenario = await gatewaySourceWorkerFixture(fixture, context);
    const { compute, core, runtime, transport, namespace, stagedWrites } = scenario;
    const { custodyKey, custody, revision } = await gatewaySourceCandidate(fixture, scenario);

    // Admitted revisions are immutable. Inject the established reader refusal only after
    // staging and uncertain apply, rather than manufacturing invalid persisted state.
    let invalid = false;
    const read = PostgresPlatformState.prototype.read;
    PostgresPlatformState.prototype.read = function <T>(
      work: (view: PlatformReadView) => Promise<T>,
    ): Promise<T> {
      return (read<T>).call(this, (view) =>
        work({
          ...view,
          revisions: {
            ...view.revisions,
            async findRevision(ns, owner, id) {
              if (invalid && id === revision.id) {
                throw new PersistedStateInvalidError("Persisted AgentRevision summary is invalid.");
              }
              return view.revisions.findRevision(ns, owner, id);
            },
          },
        }),
      );
    };
    try {
      const clients = (await Reflect.get(compute, "apiClients")) as typeof transport.clients;
      const patchDeployment = clients.apps.patchNamespacedDeployment!;
      let gatewayName: string | undefined;
      clients.apps.patchNamespacedDeployment = async (request) => {
        if (!request.body.metadata.name.startsWith("gateway-")) {
          return patchDeployment(request);
        }
        gatewayName = request.body.metadata.name;
        await patchDeployment(request);
        invalid = true;
        throw new Error("controlled Gateway Deployment apply failure");
      };
      await fixture.start(compute, { transformDrivers: () => runtime });
      const deployment = {
        id: revision.id,
        idempotencyKey: `agent_revision:${revision.id}:reconcile`,
      };
      await fixture.work(deployment, "failed_permanent");
      assert.equal(
        (await fixture.workResult(deployment)).rows[0]?.reason_code,
        "DEPENDENCY_UNAVAILABLE",
      );

      // The terminal deployment and cleanup ownership are committed together. The cleanup
      // must defer, preserving the staged copy, until the exact immutable revision is readable.
      const cleanupKey = await waitFor("failed-preparation cleanup deferral", async () => {
        const result = await fixture.observerPool.query<{ idempotency_key: string; state: string }>(
          `SELECT idempotency_key, state FROM occ.controller_work
           WHERE revision_id = $1 AND idempotency_key <> $2`,
          [revision.id, deployment.idempotencyKey],
        );
        const cleanup = result.rows[0];
        if (result.rows.length !== 1 || cleanup?.state !== "queued") {
          return undefined;
        }
        const attempt = await fixture.state.read((view) =>
          view.operations.findWorkAttempt(cleanup.idempotency_key),
        );
        return attempt?.code === "REPOSITORY_CLEANUP_PENDING" ? cleanup.idempotency_key : undefined;
      });
      assert.equal(stagedWrites.length, 1);
      assert.ok(transport.objects.has(transport.key("Secret", stagedWrites[0]!, namespace)));
      assert.ok(gatewayName);
      assert.ok(transport.objects.has(transport.key("Deployment", gatewayName, namespace)));

      invalid = false;
      // Advance only this deferred cleanup; do not wait on the production backoff clock.
      await fixture.observerPool.query(
        `UPDATE occ.controller_work SET available_at = clock_timestamp()
         WHERE idempotency_key = $1 AND state = 'queued'`,
        [cleanupKey],
      );
      await fixture.work({ id: revision.id, idempotencyKey: cleanupKey }, "succeeded");
      assert.equal(
        transport.objects.has(transport.key("Deployment", gatewayName, namespace)),
        false,
      );
      assert.equal(
        transport.objects.has(transport.key("Secret", stagedWrites[0]!, namespace)),
        false,
      );
      assert.deepEqual(core.secrets.get(custodyKey), custody, "owner custody survives cleanup");
    } finally {
      PostgresPlatformState.prototype.read = read;
    }
  },
);

function recordingActiveGateway(
  namespaceId: string,
  workspace: string,
  sandboxId: string,
  sourceId: string,
) {
  const sandboxName = "active-source-sandbox";
  const providerName = openShellProviderName(sourceId);
  const workspaceId = randomUUID();
  const attachmentEpoch = randomUUID();
  const networkInstanceId = randomUUID();
  const policyHash = "a".repeat(64);
  const updates: OpenShellProviderCreateRequest[] = [];
  const receiptReads: (string | undefined)[] = [];
  let profile: OpenShellStoredProviderProfile | undefined;
  let provider: OpenShellProviderResponse | undefined;
  let status: OpenShellSandboxProviderStatus | undefined;
  let stale = false;
  const sandbox = {
    id: sandboxId,
    name: sandboxName,
    workspace,
    labels: {},
    annotations: {},
    serviceUrls: {},
    spec: { providers: [] as string[], provider_attachment_epoch: attachmentEpoch },
    configurationActivated: true,
    configurationAdmission: {
      state: 2,
      provider_env_revision: "2",
      config_revision: "2",
      policy_hash: policyHash,
    },
    mainProcessInstanceId: networkInstanceId,
  };
  const client = {
    async getWorkspace(name) {
      assert.equal(name, workspace);
      return {
        id: workspaceId,
        name: workspace,
        labels: { [MANAGED_BY_LABEL]: MANAGED_BY, "openclaw.dev/namespace-id": namespaceId },
      };
    },
    async getProviderProfile(requestWorkspace, id) {
      assert.equal(requestWorkspace, workspace);
      assert.equal(id, providerName);
      return profile;
    },
    async importProviderProfile(requestWorkspace, supplied) {
      assert.equal(requestWorkspace, workspace);
      assert.equal(supplied.id, providerName);
      profile = {
        id: supplied.id,
        resourceVersion: "1",
        annotations: supplied.annotations,
        definition: {
          credentials: supplied.credentials.map((credential) => ({
            name: credential.name,
            env_vars: credential.envVars,
            required: credential.required,
            auth_style: credential.authStyle,
            header_name: credential.headerName,
            stable_placeholder: credential.stablePlaceholder,
          })),
        },
      };
    },
    async getProvider(requestWorkspace, name) {
      assert.equal(requestWorkspace, workspace);
      assert.equal(name, providerName);
      return provider;
    },
    async listProviders(requestWorkspace) {
      assert.equal(requestWorkspace, workspace);
      return provider ? [provider] : [];
    },
    async createProvider(request) {
      assert.equal(request.workspace, workspace);
      assert.equal(request.name, providerName);
      assert.equal(request.type, providerName);
      provider = {
        id: randomUUID(),
        workspace,
        profileWorkspace: workspace,
        name: request.name,
        type: request.type,
        labels: request.labels,
        config: request.config ?? {},
        resourceVersion: "1",
      };
      return provider;
    },
    async updateProviderCredentialsConditionally(request, expectedVersion) {
      assert.ok(provider);
      assert.equal(request.workspace, workspace);
      assert.equal(request.name, providerName);
      assert.deepEqual(sandbox.spec.providers, [providerName]);
      assert.equal(expectedVersion, provider.resourceVersion);
      updates.push(request);
      const resourceVersion = String(BigInt(provider.resourceVersion!) + 1n);
      provider = { ...provider, config: request.config ?? {}, resourceVersion };
      sandbox.configurationAdmission.provider_env_revision = resourceVersion;
      const mutationId = randomUUID();
      const receiptId = randomUUID();
      const desired = {
        sandboxId,
        sandbox: sandboxName,
        attachmentEpoch,
        providerId: provider.id!,
        providerResourceVersion: provider.resourceVersion,
        providerEnvRevision: resourceVersion,
        configRevision: "2",
        policyHash,
      };
      const time = new Date().toISOString();
      status = {
        state: "PROVIDER_READINESS_STATE_READY",
        completedOperationId: receiptId,
        receipt: {
          receiptId,
          kind: "PROVIDER_MUTATION_KIND_UPDATE",
          workspace,
          provider: provider.name,
          desired,
        },
        observed: {
          sessionId: randomUUID(),
          sequence: "1",
          attachmentEpoch,
          providerEnvRevision: stale ? String(BigInt(resourceVersion) - 1n) : resourceVersion,
          configRevision: "2",
          policyHash,
          credentialsInstalled: true,
          policyActive: true,
          launchEnvironmentInstalled: true,
          processInstanceId: randomUUID(),
          reason: "",
        },
        networkInstanceId,
        observedTime: time,
        evaluatedTime: time,
      };
      return {
        ...provider,
        mutationId,
        targetReceipts: [
          {
            receipt_id: receiptId,
            mutation_id: mutationId,
            kind: "PROVIDER_MUTATION_KIND_UPDATE",
            workspace,
            provider: provider.name,
            desired: {
              sandbox_id: sandboxId,
              sandbox: sandboxName,
              provider_id: provider.id,
              provider_resource_version: provider.resourceVersion,
            },
          },
        ],
      };
    },
    async getSandbox(request) {
      assert.equal(request.workspace, workspace);
      assert.equal(request.name, sandboxName);
      return sandbox;
    },
    async listSandboxes(requestWorkspace) {
      assert.equal(requestWorkspace, workspace);
      return [sandbox];
    },
    async getSandboxProviderStatus(
      requestWorkspace,
      requestedSandbox,
      requestedProvider,
      _signal,
      receiptId,
    ) {
      assert.equal(requestWorkspace, workspace);
      assert.equal(requestedSandbox, sandboxName);
      assert.equal(requestedProvider, providerName);
      assert.ok(status?.receipt);
      receiptReads.push(receiptId);
      if (receiptId === undefined) {
        const observationId = randomUUID();
        status = {
          ...status,
          completedOperationId: observationId,
          receipt: {
            ...status.receipt,
            receiptId: observationId,
            kind: "PROVIDER_MUTATION_KIND_OBSERVE",
          },
        };
      } else {
        assert.equal(receiptId, status.receipt.receiptId);
      }
      return status;
    },
  } satisfies Partial<OpenShellGatewayClient>;
  return {
    client,
    updates,
    receiptReads,
    sandbox,
    provider: () => provider,
    status: () => status,
    setStale: (value: boolean) => {
      stale = value;
    },
    observeCurrentEnvironment: () => {
      assert.ok(status?.observed);
      status = {
        ...status,
        observed: {
          ...status.observed,
          providerEnvRevision: sandbox.configurationAdmission.provider_env_revision,
        },
      };
    },
  };
}

async function stagedCredentialScenario(
  fixture: RevisionFixture,
  context: TestContext,
  extendCompute: (compute: ComputeDriver) => ComputeDriver,
  credential: "static" | "builtin_codex" | "codex-pat" = "static",
) {
  const provisioning = credential === "codex-pat";
  const grant = {
    id: "model-egress",
    binary: credential === "static" ? "/app/bin/model-client" : OPEN_SHELL_CODEX_BINARIES[0],
    host: credential === "static" ? "api.openai.com" : "chatgpt.com",
    ports: [{ from: 443, to: 443 }],
  };
  const networkCeiling = provisioning
    ? [grant, { ...grant, id: "account-egress", host: "auth.openai.com" }]
    : [grant];
  const installation = buildSandboxInstallation();
  Reflect.deleteProperty(installation.drivers, "credential_gateway");
  Reflect.deleteProperty(installation.backend[0]!.drivers, "credential_gateway");
  Object.assign(installation.drivers, { token_service: { id: "occ", configuration: {} } });
  installation.drivers.compute.id = fixture.compute.id;
  if (provisioning) {
    const configuration = installation.drivers.compute.configuration;
    Reflect.deleteProperty(configuration.network, "gatewayClients");
    Object.assign(configuration, {
      gatewayRouting: {
        hostname: "agents.example.test",
        gatewayName: "gateways",
        gatewayNamespace: "occ-system",
        envoyNamespace: "envoy",
      },
    });
    Object.assign(configuration.runtime, { channelEgress: channelEgressOptions });
  }
  const baseline = installation.drivers.sandbox.configuration.policy.networkPolicies[0]!;
  baseline.name = "baseline";
  baseline.endpoints[0]!.host = "baseline.example.test";
  const gatewayTransport: Partial<OpenShellGatewayClient> = {};
  const runtime = await loadInstallationFile(context, installation, {
    createOpenShellBackend: (definition) =>
      createOpenShellBackend(definition, {
        gatewayClient: completeOpenShellGatewayClient(gatewayTransport),
      }),
  });
  assert.ok(runtime?.credentialDeliveryRegistration && runtime.sandboxDriver);
  const registration = runtime.credentialDeliveryRegistration;
  const sandbox = registration.require("sandbox");
  // Control Compute and deployment configuration only. The API and Worker share the exact
  // selected native Proxy; its Source notification and Gateway receipt handling remain real.
  const deliveries: {
    namespace: Readonly<Namespace>;
    targetRef: Parameters<CredentialProxyDriver["configureDeployment"]>[1]["targetRef"];
    configurationId: string;
    binding: DeploymentCredentialBinding;
    credential: ResolvedCredential;
  }[] = [];
  let configureCalls = 0;
  const proxy = registration.require("credential_proxy_delivery");
  proxy.configureDeployment = async (deploymentContext, input) => {
    configureCalls += 1;
    const supplied = input.bindings[0];
    assert.ok(supplied && input.bindings.length === 1);
    deliveries.push({
      namespace: deploymentContext.namespace,
      targetRef: input.targetRef,
      configurationId: input.configurationId,
      binding: supplied.binding,
      credential: await supplied.resolveCredential(),
    });
    return {
      credentialProjections: [
        {
          bindingRef: supplied.binding.bindingRef,
          environment: supplied.binding.projection.environment,
          placeholder: { kind: "runtime" },
        },
      ],
    };
  };
  const placedName = `placed-${randomUUID().slice(0, 8)}`;
  const controlledCompute = {
    resolveHarnessConfiguration: () =>
      credential !== "static"
        ? {}
        : { modelProvider: { protocol: "openai-responses", baseUrl: "https://api.openai.com/v1" } },
    validateExecutionAdmission() {},
    async resolveSandboxNamespace(namespace: Readonly<Namespace>) {
      return { ...namespace, name: placedName };
    },
    async prepareRevision(revision: Readonly<AgentRevision>) {
      return {
        ...(await fixture.compute.prepareRevision(revision)),
        ready: false,
        pendingReason: "CREDENTIAL_ACTIVATION_PENDING" as const,
        ...(!provisioning && { preparedForCredentialActivation: true as const }),
      };
    },
  };
  const runtimeCredentials = createRuntimeComputeDriver();
  const compute = extendCompute(
    provisioning
      ? Object.assign(runtime.computeDriver, {
          // Keep Kubernetes admission and snapshots in use. Control only prerequisite I/O
          // and readiness because this test ends at the persisted revision handoff.
          preflight: async () => ({ warnings: [] }),
          resolveSandboxNamespace: controlledCompute.resolveSandboxNamespace,
          prepareRevision: controlledCompute.prepareRevision,
          getAgentRuntimeCredentialStatus: runtimeCredentials.getAgentRuntimeCredentialStatus,
          provisionAgentRuntimeCredentials: runtimeCredentials.provisionAgentRuntimeCredentials,
        })
      : { ...fixture.compute, ...controlledCompute },
  );
  let slackCalls = 0;
  const channel = new SlackChannelDriver((async (url) => {
    assert.equal(String(url), "https://slack.com/api/auth.test");
    slackCalls += 1;
    return Response.json({ ok: true, bot_id: "B0123456789", team_id: "T0123456789" });
  }) satisfies typeof fetch);
  const controller = new OpenClawController(fixture.installation, {
    state: fixture.state,
    ...installationControllerOptions(runtime.installation),
    ...(provisioning && { gatewayStartupSourceDelivery: gatewayStartupSourceDelivery(runtime) }),
    nativeWorkerSupport: "custom-image",
    sandboxNetworkPolicyCeiling: networkCeiling,
    namespaceLifecycleBindings: runtime.namespaceLifecycleBindings,
    backends: runtime.installation.backend,
    recordOperations: true,
  });
  const iam = fixture.controller.selectedDriver("iam");
  const savedConfiguration = fixture.controller.selectedDriver("configuration");
  const configurationDriver = provisioning
    ? createTestConfigurationDriver({ id: savedConfiguration.id, exact: true })
    : savedConfiguration;
  for (const selected of [iam, configurationDriver]) {
    controller.registerDriver(selected);
    controller.selectDriver(selected.capability, selected.id);
  }
  controller.registerDriver(compute);
  controller.selectDriver("compute", compute.id);
  if (provisioning) {
    controller.registerDriver(channel);
    controller.selectDriver("channel", channel.id);
  }
  installSelectedSandboxDrivers(controller, runtime);
  const { core, driver: secretDriver } = useInstallationSecretDriver(controller);
  await installTokenServiceDriver(controller, { ...runtime, secretDriver }, fixture.state);
  const namespaceId = fixture.namespace.id;
  const actorId = fixture.actor.id;
  const enrolledCredential = randomUUID();
  const beforeModelEnrollment = new Set(core.secrets.keys());
  const source =
    credential === "builtin_codex"
      ? await (async () => {
          // The selected TokenService receives this synthetic grant at the same trusted
          // post-exchange boundary used by the built-in device authorization flow.
          const registered = await controller.selectedDriver("token_service").createSource(
            {
              type: "oauth2-refresh-token",
              namespaceId,
              name: `Activation source ${randomUUID()}`,
              consent: {
                kind: "builtin_codex",
                ownerPrincipalId: actorId,
                account: { accountId: "fixture-account", planType: "plus", isFedramp: false },
              },
              grant: {
                accessToken: enrolledCredential,
                refreshToken: randomUUID(),
                expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
                requestedScopes: ["openid"],
                grantedScopes: ["openid"],
              },
            },
            context.signal,
          );
          return controller.readCredentialSource(actorId, namespaceId, registered.id);
        })()
      : await controller.createManagedCredentialSource(
          actorId,
          namespaceId,
          {
            type: "static",
            name: `Activation source ${randomUUID()}`,
            lifecycleConfig: { settings: {} },
            secret: enrolledCredential,
            providerPreset: credential === "codex-pat" ? "codex-pat" : "openai",
          },
          (ref, phase) => ({
            ...auditEvent(
              fixture.installation.id,
              namespaceId,
              actorId,
              phase
                ? "openclaw.credential_sources.create.started"
                : "openclaw.credential_sources.create",
              ref,
            ),
            ...(phase ? { details: { phase } } : {}),
          }),
        );
  const modelCustodyKeys = [...core.secrets.keys()].filter(
    (key) => !beforeModelEnrollment.has(key),
  );
  const configuration = await controller.createConfiguration(actorId, {
    namespaceId,
    kind: "agent",
    values: createHarnessConfiguration(credential === "static" ? "openclaw" : "codex", "gpt-4.1"),
  });
  const owner = await controller.createAgent(
    actorId,
    {
      namespaceId,
      name: `Activation race ${randomUUID()}`,
      configurationId: configuration.id,
      executionMode: "dedicated",
      harnessAuth: { method: "credential_source", sourceId: source.id },
      credentialSources: [{ sourceId: source.id }],
    },
    resolveApprovedHarness,
  );
  await controller.TEMPORARY_API_WILL_BREAK_IN_FUTURE_setAgentSandboxPolicyEditing(
    actorId,
    namespaceId,
    owner.id,
    "networking",
    true,
  );
  await controller.updateAgentSandboxPolicy(actorId, namespaceId, owner.id, "networking", 1, [
    grant,
  ]);

  const workerOptions = {
    transformDrivers: (drivers) => ({
      ...drivers,
      installation: {
        ...runtime.installation,
        ...(provisioning ? { sandboxNetworkPolicyCeiling: networkCeiling } : {}),
        drivers: {
          ...runtime.installation.drivers,
          secret: { ...runtime.installation.drivers.secret, id: secretDriver.id },
        },
      },
      secretDriver,
      ...(provisioning ? { configurationDriver } : {}),
      ...(provisioning ? { channelDrivers: [{ provider: "slack", driver: channel }] } : {}),
      namespaceLifecycleBindings: runtime.namespaceLifecycleBindings,
      credentialDeliveryRegistration: registration,
      sandboxDriver: sandbox,
    }),
  } satisfies NonNullable<Parameters<RevisionFixture["start"]>[1]>;
  await fixture.start(compute, workerOptions);
  return {
    controller,
    owner,
    source,
    namespaceId,
    actorId,
    enrolledCredential,
    deliveries,
    placedName,
    gatewayTransport,
    secretDriver,
    core,
    modelCustodyKeys,
    slackCalls: () => slackCalls,
    configureCalls: () => configureCalls,
    currentAgent: () => fixture.currentAgent(owner),
  };
}

type StagedCredentialScenario = Awaited<ReturnType<typeof stagedCredentialScenario>>;

async function attachActiveSource(
  scenario: Pick<
    StagedCredentialScenario,
    "controller" | "source" | "namespaceId" | "placedName" | "gatewayTransport"
  >,
  revision: Readonly<AgentRevision>,
  sandboxId: string,
  signal: AbortSignal,
) {
  const { controller, source, namespaceId, placedName, gatewayTransport } = scenario;
  const nativeProxy = controller.selectedDriver("credential_proxy_delivery");
  assert.ok(nativeProxy instanceof OpenShellCredentialProxyDriver);
  const tokenService = controller.selectedDriver("token_service");
  const sourceInstance = {
    sourceRef: source.ref,
    tokenServiceInstanceId: controller.currentTokenServiceInstanceId(),
  };
  const gateway = recordingActiveGateway(namespaceId, placedName, sandboxId, source.id);
  Object.assign(gatewayTransport, gateway.client);
  const preparedProvider = await prepareOccTokenServiceProviderCopy({
    client: gateway.client,
    workspace: placedName,
    namespaceId,
    binding: revision.credentialDeployment!.bindings[0]!,
    requireCurrentVersion:
      revisionCredentialSourceSnapshot(revision, source.id)?.sourceType === "oauth2-refresh-token",
    resolveCredential: () => tokenService.resolveCredential(sourceInstance, signal),
    signal,
  });
  // Worker deployment is controlled in this fixture; explicitly model its existing attachment.
  gateway.sandbox.spec.providers.push(preparedProvider.name);
  return { nativeProxy, tokenService, sourceInstance, gateway, preparedProvider };
}

async function authenticatedSourceOperator(
  fixture: RevisionFixture,
  controller: OpenClawController,
  logs?: unknown[],
) {
  const origin = "https://console.oce.localhost";
  const auth = await createPostgresControllerAuth({
    mode: "development",
    installationId: fixture.installation.id,
    baseURL: origin,
    agentDomain: "agents.oce.localhost",
    secret: "active-source-update-integration-session-secret",
    pool: fixture.observerPool,
  });
  const credentials = {
    email: `source-updater-${randomUUID()}@example.test`,
    password: randomUUID(),
  };
  const iam = await fixture.state.loadNativeIAMState(fixture.installation.id);
  const roleId = iam.bindings.find((binding) => binding.subjectId === fixture.actor.id)?.roleId;
  assert.ok(roleId);
  const account = await auth.createAccount({ ...credentials, name: "Source updater" });
  const seed = auth.principalSeed(account, { roleId });
  await fixture.state.appendNativeIAMPrincipal(seed);
  const app = createFastifyApp({
    controller,
    iamDriver: controller.selectedDriver("iam"),
    resolveHarness: resolveApprovedHarness,
    auditSink: fixture.state.auditSink,
    auth,
    development: { enabled: false },
    ...(logs && {
      logger: createOccLogger({
        component: "credential-push-test",
        destination: jsonLineDestination(logs),
      }),
    }),
  });
  const session = await signInToControllerApp(app, credentials, { origin });
  return {
    app,
    principalId: seed.principal.id,
    headers: {
      host: new URL(origin).host,
      ...authenticatedHeaders(session),
      "content-type": "application/json",
    },
  };
}

async function grantOperator(
  controller: OpenClawController,
  actorId: string,
  namespaceId: string,
  principalId: string,
  action: "operate" | "update",
  resourceKind: "agent" | "credential_source",
  resourceId: string,
) {
  const role = await controller.createIAMRole(actorId, {
    namespaceId,
    permissions: [{ action, resourceKind }],
  });
  await controller.createIAMAccessBinding(actorId, {
    namespaceId,
    subjectKind: "identity",
    subjectId: principalId,
    roleId: role.id,
    resourceKind,
    resourceId,
  });
}

async function copyProvisioningActorBindings(fixture: RevisionFixture, principalId: string) {
  await fixture.observerPool.query(
    `INSERT INTO occ.iam_access_bindings
       (id, namespace_id, identity_subject_id, role_id, resource_kind, resource_id)
     SELECT 'binding-' || gen_random_uuid(), namespace_id, $1, role_id,
            resource_kind, resource_id FROM occ.iam_access_bindings WHERE identity_subject_id = $2`,
    [principalId, fixture.actor.id],
  );
}

cases.revisionTest(
  "guided provisioning admits a dedicated model Source through the Worker handoff",
  async (fixture, context) => {
    const { controller, namespaceId, source, actorId, core, modelCustodyKeys, slackCalls } =
      await stagedCredentialScenario(fixture, context, (compute) => compute, "codex-pat");
    const { app, headers, principalId } = await authenticatedSourceOperator(fixture, controller);
    context.after(() => app.close());
    const enrollSlack = (name: string, secret: string) =>
      controller.createManagedCredentialSource(
        actorId,
        namespaceId,
        {
          type: "static",
          name,
          lifecycleConfig: { settings: {} },
          secret,
        },
        (ref) =>
          auditEvent(
            fixture.installation.id,
            namespaceId,
            actorId,
            "openclaw.credential_sources.create",
            ref,
          ),
      );
    const bot = await enrollSlack("Slack bot", `xoxb-${randomUUID()}`);
    const slackApp = await enrollSlack("Slack app", `xapp-${randomUUID()}`);
    await copyProvisioningActorBindings(fixture, principalId);
    assert.equal(modelCustodyKeys.length, 1);
    let modelCustodyReads = 0;
    const readCustody = core.readNamespacedSecret.bind(core);
    context.mock.method(
      core,
      "readNamespacedSecret",
      (input: { namespace: string; name: string }) => {
        if (modelCustodyKeys[0] === `${input.namespace}/${input.name}`) {
          modelCustodyReads += 1;
        }
        return readCustody(input);
      },
    );
    const harnessAuth = { method: "credential_source", sourceId: source.id };
    const accepted = await app.inject({
      method: "POST",
      url: `/namespaces/${namespaceId}/agents/provision`,
      headers,
      payload: {
        requestId: `req_${randomUUID()}`,
        name: `Guided model Source ${randomUUID()}`,
        executionMode: "dedicated",
        harnessAuth,
        configuration: {
          kind: "agent",
          values: {
            ...createHarnessConfiguration("codex", "gpt-4.1"),
            channels: {
              slack: {
                enabled: true,
                botToken: "${SLACK_BOT_TOKEN}",
                appToken: "${SLACK_APP_TOKEN}",
              },
            },
          },
          secretBindings: {
            SLACK_BOT_TOKEN: { source: bot.ref },
            SLACK_APP_TOKEN: { source: slackApp.ref },
          },
        },
      },
    });
    assert.equal(accepted.statusCode, 202, accepted.body);
    const { workId } = accepted.json().data.provisioning;
    assert.ok(workId);

    // The regular Worker must use ordinary deployment admission to save the first revision.
    const revision = await waitFor("guided Source deployment admission", () =>
      fixture.state.read(async (view) => {
        const record = await view.provisioning.findByWorkId(workId);
        assert.notEqual(record?.status, "failed", JSON.stringify(record?.progress));
        return record?.agentId && record.revisionId
          ? view.revisions.findRevision(namespaceId, record.agentId, record.revisionId)
          : undefined;
      }),
    );
    assert.deepEqual(revision.executionAdmission, { mode: "standalone", version: 8 });
    assert.deepEqual(revision.credentialDeployment?.bindings, [
      {
        bindingRef: "model",
        sourceRef: source.ref,
        consumer: { kind: "model", providerId: "codex" },
        projection: { environment: "CODEX_ACCESS_TOKEN", presentation: "bearer" },
      },
    ]);
    assert.deepEqual(revision.harnessAuth, {
      ...harnessAuth,
      sourceType: "static",
      tokenServiceInstanceId: controller.currentTokenServiceInstanceId(),
    });
    assert.deepEqual(revision.secretBindings?.SLACK_BOT_TOKEN?.source, bot.ref);
    assert.deepEqual(revision.secretBindings?.SLACK_APP_TOKEN?.source, slackApp.ref);
    assert.ok(slackCalls() > 0, "the approved Slack bot reaches controlled auth.test");
    assert.equal(
      modelCustodyReads,
      0,
      "provisioning and revision admission use only model Source metadata",
    );
  },
);

cases.revisionTest(
  "the Worker activates an eligible OAuth grant but refuses expired custody without renewing it",
  async (fixture, context) => {
    const sandboxId = randomUUID();
    let activations = 0;
    // A forbidden issuer request must fail locally instead of sending synthetic grant material.
    const issuer = context.mock.method(globalThis, "fetch", async () => {
      throw new Error("The Worker must not contact the OAuth issuer.");
    });
    const scenario = await stagedCredentialScenario(
      fixture,
      context,
      (compute) => ({
        ...compute,
        maintenanceIntervalMs: 3_600_000,
        async prepareRevision(revision, revisionContext) {
          assert.ok(revisionContext?.configureCredentialDeployment);
          try {
            await revisionContext.configureCredentialDeployment(
              {
                targetRef: {
                  namespaceId: revision.namespaceId,
                  agentId: revision.agentId,
                  revisionId: revision.id,
                  sandboxId,
                },
                configurationId: revision.configurationId,
              },
              context.signal,
            );
          } catch (error) {
            if (
              !(error instanceof ActivationPendingError) ||
              error.code !== "CREDENTIAL_ACTIVATION_PENDING"
            ) {
              throw error;
            }
            // Kubernetes reports incomplete readiness without the preparation marker when
            // credential configuration is pending; the Worker must not release activation.
            return {
              namespaceId: revision.namespaceId,
              agentId: revision.agentId,
              revisionId: revision.id,
              ready: false,
              pendingReason: error.code,
            };
          }
          return compute.prepareRevision(revision, revisionContext);
        },
        async activateRevision() {
          activations += 1;
        },
      }),
      "builtin_codex",
    );
    const { controller, source, owner, namespaceId, actorId, secretDriver, core } = scenario;
    const compareAndSwap = context.mock.method(
      secretDriver.privateSecrets,
      "compareAndSwap",
      secretDriver.privateSecrets.compareAndSwap.bind(secretDriver.privateSecrets),
    );
    assert.equal(source.type, "oauth2-refresh-token");
    const custody = await fixture.state.read((view) =>
      view.oauthCredentials.findTokenCustody(namespaceId, source.id),
    );
    assert.ok(custody);
    assert.deepEqual(custody.secret, {
      installationId: fixture.installation.id,
      id: JSON.stringify([
        "token_service",
        controller.currentTokenServiceInstanceId(),
        "credential_source",
        namespaceId,
        source.id,
      ]),
    });
    const registeredGrant = await secretDriver.privateSecrets.withValue(
      custody.secret,
      async (value) => JSON.parse(value) as Record<string, unknown>,
    );
    assert.equal(registeredGrant.accessToken, scenario.enrolledCredential);
    // Renewal is due in both custody and PostgreSQL, but the access grant is still
    // eligible. Worker activation must read it without claiming API-owned renewal.
    await secretDriver.privateSecrets.update(
      custody.secret,
      JSON.stringify({ ...registeredGrant, renewAt: new Date(Date.now() - 1_000).toISOString() }),
    );
    await fixture.state.transact((unit) =>
      unit.oauthCredentials.recordTokenSchedule(namespaceId, source.id, "due"),
    );
    const writesAfterEnrollment = core.calls.replaceNamespacedSecret;

    const first = await controller.deployAgent(
      actorId,
      { namespaceId, agentId: owner.id },
      resolveApprovedHarness,
    );
    await fixture.work(
      { id: first.id, idempotencyKey: `agent_revision:${first.id}:reconcile` },
      "succeeded",
    );
    assert.equal((await scenario.currentAgent())?.activeRevisionId, first.id);
    assert.equal(activations, 1);
    assert.equal(scenario.configureCalls(), 1);
    assert.equal(scenario.deliveries[0]?.credential.credential, scenario.enrolledCredential);
    assert.equal(core.calls.replaceNamespacedSecret, writesAfterEnrollment);
    assert.equal(compareAndSwap.mock.callCount(), 0);
    assert.equal(issuer.mock.callCount(), 0);
    assert.equal(
      (
        await fixture.state.read((view) =>
          view.oauthCredentials.findTokenCustody(namespaceId, source.id),
        )
      )?.due,
      true,
    );

    const expiredOwner = await controller.createAgent(
      actorId,
      {
        namespaceId,
        name: `Expired OAuth activation ${randomUUID()}`,
        configurationId: owner.configurationId,
        executionMode: "dedicated",
        harnessAuth: { method: "credential_source", sourceId: source.id },
        credentialSources: [{ sourceId: source.id }],
      },
      resolveApprovedHarness,
    );
    await controller.TEMPORARY_API_WILL_BREAK_IN_FUTURE_setAgentSandboxPolicyEditing(
      actorId,
      namespaceId,
      expiredOwner.id,
      "networking",
      true,
    );
    await controller.updateAgentSandboxPolicy(
      actorId,
      namespaceId,
      expiredOwner.id,
      "networking",
      1,
      [
        {
          id: "model-egress",
          binary: OPEN_SHELL_CODEX_BINARIES[0],
          host: "chatgpt.com",
          ports: [{ from: 443, to: 443 }],
        },
      ],
    );
    // Move only the already-registered private grant's clock state; the API scheduler is
    // absent, so the queued Worker must refuse rather than claim or renew it.
    const expiredGrant = JSON.stringify({
      ...registeredGrant,
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
      renewAt: new Date(Date.now() - 2_000).toISOString(),
    });
    await secretDriver.privateSecrets.update(custody.secret, expiredGrant);
    const writesAfterExpiry = core.calls.replaceNamespacedSecret;
    const waitForPending = (key: string) =>
      waitFor("expired OAuth Work to be refused", async () => {
        const { rows } = await fixture.observerPool.query<{ state: string; reason_code: string }>(
          `SELECT work.state, event.details->>'reasonCode' AS reason_code
           FROM occ.controller_work work JOIN occ.audit_events event
             ON event.details->>'workId'=work.idempotency_key
           WHERE work.idempotency_key=$1 AND event.action='reconcile'
             AND event.details->>'reasonCode'='CREDENTIAL_ACTIVATION_PENDING'`,
          [key],
        );
        const row = rows[0];
        return row?.state === "claimed" ? undefined : row;
      });
    const maintenance = (await fixture.advanceMaintenance(first)).rows[0];
    assert.ok(maintenance, "activation scheduled ordinary revision maintenance");
    assert.equal((await waitForPending(maintenance.idempotency_key)).state, "failed_permanent");
    const continued = await fixture.observerPool.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM occ.controller_work
       WHERE revision_id=$1 AND state='queued' AND idempotency_key LIKE $2 AND idempotency_key<>$3`,
      [first.id, `agent_revision:${first.id}:maintenance:%`, maintenance.idempotency_key],
    );
    assert.equal(continued.rows[0]?.count, 1);
    assert.equal((await scenario.currentAgent())?.activeRevisionId, first.id);
    assert.equal(activations, 1, "active repair cannot reactivate expired OAuth custody");
    const refused = await controller.deployAgent(
      actorId,
      { namespaceId, agentId: expiredOwner.id },
      resolveApprovedHarness,
    );
    const key = `agent_revision:${refused.id}:reconcile`;
    const attempted = await waitForPending(key);
    assert.equal(attempted.state, "queued");
    assert.equal(attempted.reason_code, "CREDENTIAL_ACTIVATION_PENDING");
    assert.equal((await fixture.currentAgent(expiredOwner))?.activeRevisionId, undefined);
    assert.equal(activations, 1);
    assert.equal(scenario.configureCalls(), 1);
    assert.equal(core.calls.replaceNamespacedSecret, writesAfterExpiry);
    assert.equal(compareAndSwap.mock.callCount(), 0);
    assert.equal(issuer.mock.callCount(), 0);
    assert.equal(
      await secretDriver.privateSecrets.withValue(custody.secret, async (value) => value),
      expiredGrant,
    );
  },
);

cases.revisionTest(
  "a terminal Credential Proxy failure permanently fails Work with its exact code",
  async (fixture, context) => {
    const code = "NATIVE_CREDENTIAL_DEPLOYMENT_REFUSED";
    let preparations = 0;
    let activations = 0;
    const { controller, owner, namespaceId, actorId, currentAgent } =
      await stagedCredentialScenario(fixture, context, (compute) => ({
        ...compute,
        async prepareRevision() {
          preparations += 1;
          throw new CredentialDeploymentFailedError(code);
        },
        async activateRevision() {
          activations += 1;
        },
      }));
    const revision = await controller.deployAgent(
      actorId,
      { namespaceId, agentId: owner.id },
      resolveApprovedHarness,
    );
    const work = { id: revision.id, idempotencyKey: `agent_revision:${revision.id}:reconcile` };
    await fixture.work(work, "failed_permanent");
    assert.equal((await fixture.workResult(work)).rows[0]?.reason_code, code);
    assert.equal(preparations, 1);
    assert.equal(activations, 0);
    assert.equal((await currentAgent())?.activeRevisionId, undefined);
  },
);

cases.revisionTest(
  "manual Agent push fully preflights deployed Source authority and recovers a stale serving copy",
  async (fixture, context) => {
    const sandboxId = randomUUID();
    const scenario = await stagedCredentialScenario(
      fixture,
      context,
      (compute) => ({
        ...compute,
        async prepareRevision(revision, revisionContext) {
          assert.ok(revisionContext?.configureCredentialDeployment);
          await revisionContext.configureCredentialDeployment(
            {
              targetRef: {
                namespaceId: revision.namespaceId,
                agentId: revision.agentId,
                revisionId: revision.id,
                sandboxId,
              },
              configurationId: revision.configurationId,
            },
            context.signal,
          );
          return compute.prepareRevision(revision, revisionContext);
        },
        async activateRevision() {},
      }),
      "builtin_codex",
    );
    const { controller, owner, source, namespaceId, actorId } = scenario;
    const revision = await controller.deployAgent(
      actorId,
      { namespaceId, agentId: owner.id },
      resolveApprovedHarness,
    );
    await fixture.work(
      { id: revision.id, idempotencyKey: `agent_revision:${revision.id}:reconcile` },
      "succeeded",
    );
    assert.equal((await scenario.currentAgent())?.activeRevisionId, revision.id);
    await fixture.stop();
    const { nativeProxy, tokenService, sourceInstance, gateway, preparedProvider } =
      await attachActiveSource(scenario, revision, sandboxId, context.signal);
    assert.ok(tokenService instanceof OCCTokenServiceDriver);
    const initial = await tokenService.resolveCredential(sourceInstance, context.signal);
    const unbound = await controller.createManagedCredentialSource(
      actorId,
      namespaceId,
      {
        type: "static",
        name: `Unbound source ${randomUUID()}`,
        lifecycleConfig: { settings: {} },
        secret: randomUUID(),
        providerPreset: "openai",
      },
      (ref, phase) => ({
        ...auditEvent(
          fixture.installation.id,
          namespaceId,
          actorId,
          phase
            ? "openclaw.credential_sources.create.started"
            : "openclaw.credential_sources.create",
          ref,
        ),
        ...(phase ? { details: { phase } } : {}),
      }),
    );
    const logs: unknown[] = [];
    const { app, principalId, headers } = await authenticatedSourceOperator(
      fixture,
      controller,
      logs,
    );
    const pushPath = `/namespaces/${namespaceId}/agents/${owner.id}/credentials/push`;
    const push = (sources: "all" | string[]) =>
      app.inject({ method: "POST", url: pushPath, headers, payload: { sources } });
    let notifications = 0;
    let resolutions = 0;
    let resolutionFailure: Error | undefined;
    const notify = nativeProxy.notifyCredentialUpdated.bind(nativeProxy);
    const resolve = tokenService.resolveCredential.bind(tokenService);
    nativeProxy.notifyCredentialUpdated = (...args) => {
      notifications += 1;
      return notify(...args);
    };
    tokenService.resolveCredential = (...args) => {
      resolutions += 1;
      if (resolutionFailure) {
        return Promise.reject(resolutionFailure);
      }
      return resolve(...args);
    };
    const assertNoDelivery = () => {
      assert.equal(notifications, 0, "authorization preflight must precede every notification");
      assert.equal(resolutions, 0, "authorization preflight must precede every resolution");
      assert.equal(gateway.updates.length, 0);
    };
    const expectResult = (response: Awaited<ReturnType<typeof push>>, outcome: string) => {
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(response.json().data, { results: [{ sourceId: source.id, outcome }] });
      assert.equal(response.json().meta.requestId, response.headers["x-request-id"]);
    };
    try {
      // Installation access does not grant operation of this deployed Agent.
      assert.equal((await push([source.id])).statusCode, 403);
      assertNoDelivery();
      await grantOperator(
        controller,
        actorId,
        namespaceId,
        principalId,
        "operate",
        "agent",
        owner.id,
      );
      await grantOperator(
        controller,
        actorId,
        namespaceId,
        principalId,
        "operate",
        "credential_source",
        source.id,
      );
      // Source operate is not Source update, even when the caller can operate the Agent.
      const callerDenied = await push([source.id]);
      assert.equal(callerDenied.statusCode, 403);
      assert.equal(callerDenied.json().error.code, "FORBIDDEN");
      assert.equal(callerDenied.json().error.message.includes(source.id), true);
      assertNoDelivery();
      await grantOperator(
        controller,
        actorId,
        namespaceId,
        principalId,
        "update",
        "credential_source",
        source.id,
      );
      await grantOperator(
        controller,
        actorId,
        namespaceId,
        principalId,
        "update",
        "credential_source",
        unbound.id,
      );
      // The first Source is valid, but the entire batch must fail before it is delivered.
      assert.equal((await push([source.id, unbound.id])).statusCode, 409);
      assertNoDelivery();

      const privateFailure = randomUUID();
      resolutionFailure = new Error(`Controlled resolver failure ${privateFailure}`);
      const failedResolution = await push([source.id]);
      expectResult(failedResolution, "resolution_failed");
      resolutionFailure = undefined;
      assert.equal(gateway.updates.length, 0);

      // The API maintenance pass commits the replacement grant before Proxy delivery.
      // The controlled issuer and supervisor let it persist without a live readiness receipt.
      const expiry = { exp: Math.floor(Date.now() / 1_000) + 3_600 };
      const replacement = `e30.${Buffer.from(JSON.stringify(expiry)).toString("base64url")}.${randomUUID()}`;
      const issuer = context.mock.method(
        globalThis,
        "fetch",
        async (...[url, request]: Parameters<typeof fetch>) => {
          assert.equal(String(url), BUILTIN_CODEX_OAUTH_PRESET.tokenUrl);
          assert.equal(request?.method, "POST");
          return Response.json({ access_token: replacement, refresh_token: randomUUID() });
        },
      );
      const schedule = () =>
        fixture.state.read((view) =>
          view.oauthCredentials.findTokenCustody(namespaceId, source.id),
        );
      await fixture.state.transact((unit) =>
        unit.oauthCredentials.recordTokenSchedule(namespaceId, source.id, "due"),
      );
      gateway.setStale(true);
      const failedRenewal = await tokenService.maintainOAuthSources(4);
      assert.equal(failedRenewal.deliveryFailed, true);
      const committed = await resolve(sourceInstance, context.signal);
      assert.equal(committed.credential, replacement);
      assert.notEqual(committed.version, initial.version);
      assert.equal(gateway.provider()?.id, preparedProvider.id);
      assert.equal(gateway.provider()?.config.oce_source_version, committed.version);
      const providerVersion = gateway.provider()?.resourceVersion;
      assert.notEqual(
        gateway.status()?.observed?.providerEnvRevision,
        gateway.status()?.receipt?.desired?.providerEnvRevision,
      );
      assert.equal(gateway.updates.length, 1);

      // The next pass must keep stale delivery due without rewriting the already-current Provider.
      assert.deepEqual(await tokenService.maintainOAuthSources(4), failedRenewal);
      assert.equal((await schedule())?.due, true);
      assert.equal(gateway.updates.length, 1);
      gateway.observeCurrentEnvironment();
      assert.equal((await tokenService.maintainOAuthSources(4)).deliveryFailed, false);
      const observedSchedule = await schedule();
      assert.equal(observedSchedule?.due, false);
      assert.equal(observedSchedule?.scheduledVersion, committed.version);
      assert.equal(issuer.mock.callCount(), 1);
      assert.equal(gateway.updates.length, 1);
      assert.equal(gateway.provider()?.resourceVersion, providerVersion);
      assert.equal(gateway.status()?.receipt?.kind, "PROVIDER_MUTATION_KIND_OBSERVE");

      const failedDelivery = await push([source.id]);
      expectResult(failedDelivery, "delivery_failed");
      assert.equal(gateway.updates.length, 2);
      // An editable draft may differ from the deployed revision. Retry still uses the
      // committed active binding and must not rewrite the already committed Source secret.
      await controller.updateAgent(
        actorId,
        {
          namespaceId,
          agentId: owner.id,
          configurationId: owner.configurationId,
          harnessAuth: { method: "runtime" },
          credentialSources: [],
        },
        resolveApprovedHarness,
      );
      gateway.setStale(false);
      const recovered = await push("all");
      expectResult(recovered, "succeeded");
      assert.equal(gateway.updates.length, 3);
      assert.equal(gateway.provider()?.id, preparedProvider.id);
      assert.equal(gateway.provider()?.config.oce_source_version, committed.version);
      assert.equal(
        gateway.status()?.observed?.providerEnvRevision,
        gateway.status()?.receipt?.desired?.providerEnvRevision,
      );
      assert.equal((await resolve(sourceInstance, context.signal)).version, committed.version);
      assert.equal((await scenario.currentAgent())?.activeRevisionId, revision.id);

      for (const [response, event, code] of [
        [failedResolution, "credential.resolution_failed", "CREDENTIAL_RESOLUTION_FAILED"],
        [failedDelivery, "credential.delivery_failed", "CREDENTIAL_DELIVERY_FAILED"],
      ] as const) {
        const warning = logs.find((entry) => {
          const record = entry as Record<string, unknown>;
          return record.event === event && record.requestId === response.headers["x-request-id"];
        }) as Record<string, unknown> | undefined;
        assert.ok(warning);
        assert.deepEqual(
          {
            namespaceId: warning.namespaceId,
            credentialSourceId: warning.credentialSourceId,
            code: warning.code,
          },
          { namespaceId, credentialSourceId: source.id, code },
        );
        const audit = await fixture.observerPool.query(
          `SELECT outcome,details->>'agentId' AS agent_id,
                  details->'__occAuditMetadata'->>'reasonCode' AS reason_code,
                  to_jsonb(a)::text AS event
           FROM occ.audit_events AS a WHERE namespace_id=$1 AND resource_kind='credential_source'
             AND resource_id=$2 AND action='openclaw.agents.credentials.push'
             AND details->'__occAuditMetadata'->>'requestId'=$3`,
          [namespaceId, source.id, response.headers["x-request-id"]],
        );
        assert.equal(audit.rows.length, 1);
        assert.deepEqual(
          {
            outcome: audit.rows[0].outcome,
            agent_id: audit.rows[0].agent_id,
            reason_code: audit.rows[0].reason_code,
          },
          { outcome: "failure", agent_id: owner.id, reason_code: code },
        );
        assert.equal(audit.rows[0].event.includes(privateFailure), false);
        assert.equal(audit.rows[0].event.includes(replacement), false);
        assert.equal(response.body.includes(privateFailure), false);
        assert.equal(response.body.includes(replacement), false);
      }
      assert.equal(JSON.stringify(logs).includes(privateFailure), false);
      assert.equal(JSON.stringify(logs).includes(replacement), false);

      // A deployed binding is no longer eligible once the Agent principal loses Source use.
      await removeSourceGrant(fixture, owner, source.id);
      notifications = 0;
      resolutions = 0;
      const explicitlyDenied = await push([source.id]);
      assert.equal(explicitlyDenied.statusCode, 403);
      assert.deepEqual(explicitlyDenied.json().error, {
        code: "FORBIDDEN",
        message: `Agent ${owner.id} cannot use CredentialSource ${source.id}. Ask an Installation administrator to grant its service principal credential_source:operate, then retry credential delivery.`,
      });
      // The caller can operate this Agent and update its Source, but cannot read either.
      // Selecting all must not disclose the stored binding's Source ID in the denial.
      const allDenied = await push("all");
      assert.equal(allDenied.statusCode, 403);
      assert.deepEqual(allDenied.json().error, {
        code: "FORBIDDEN",
        message: `Agent ${owner.id} cannot use one of its bound CredentialSources. Ask an Installation administrator to grant its service principal credential_source:operate, then retry credential delivery.`,
      });
      assert.equal(allDenied.body.includes(source.id), false);
      const denialAudit = await fixture.observerPool.query(
        `SELECT details->'__occAuditMetadata'->>'decisionReason' AS decision_reason
         FROM occ.audit_events WHERE namespace_id=$1 AND action='openclaw.agents.credentials.push'
           AND kind='authorization_denial' AND details->'__occAuditMetadata'->>'requestId'=$2`,
        [namespaceId, explicitlyDenied.headers["x-request-id"]],
      );
      assert.deepEqual(denialAudit.rows, [
        {
          decision_reason:
            "Grant the Agent service principal credential_source:operate on the Source, then retry credential delivery.",
        },
      ]);
      assert.equal(notifications, 0);
      assert.equal(resolutions, 0);

      // Once withdrawal is recorded for the deployed revision, even pending work must
      // prevent a manual retry from delivering the Source back to that Agent.
      const { "content-type": _contentType, ...withdrawalHeaders } = headers;
      const withdrawal = await app.inject({
        method: "POST",
        url: `/namespaces/${namespaceId}/agents/${owner.id}/credential-sources/${source.id}/withdraw`,
        headers: withdrawalHeaders,
      });
      assert.equal(withdrawal.statusCode, 202, withdrawal.body);
      assert.equal(withdrawal.json().data.state, "pending");
      assert.equal((await push([source.id])).statusCode, 409);
      const remaining = await push("all");
      assert.equal(remaining.statusCode, 200, remaining.body);
      assert.deepEqual(remaining.json().data.results, []);
      assert.equal(notifications, 0);
      assert.equal(resolutions, 0);
    } finally {
      nativeProxy.notifyCredentialUpdated = notify;
      tokenService.resolveCredential = resolve;
      await app.close();
    }
  },
);

cases.revisionTest(
  "standalone activation commits the prepared revision and delivers an active Source PATCH",
  async (fixture, context) => {
    let preparations = 0;
    let activations = 0;
    let configurationError: unknown;
    const sandboxId = randomUUID();
    const {
      controller,
      owner,
      source,
      namespaceId,
      actorId,
      enrolledCredential,
      deliveries,
      placedName,
      currentAgent,
      gatewayTransport,
    } = await stagedCredentialScenario(fixture, context, (compute) => ({
      ...compute,
      async prepareRevision(revision, revisionContext) {
        preparations += 1;
        assert.equal(activations, 0, "activation succeeds without another preparation");
        assert.deepEqual(revisionContext?.harnessAuth, revision.harnessAuth);
        assert.deepEqual(revisionContext?.secretEnvironment, []);
        assert.ok(revisionContext?.configureCredentialDeployment);
        const configured = await revisionContext
          .configureCredentialDeployment(
            {
              targetRef: { namespaceId, agentId: owner.id, revisionId: revision.id, sandboxId },
              configurationId: revision.configurationId,
            },
            AbortSignal.timeout(5_000),
          )
          .catch((error: unknown) => {
            configurationError = error;
            throw error;
          });
        assert.deepEqual(configured, {
          credentialProjections: [
            {
              bindingRef: "model",
              environment: "OPENAI_API_KEY",
              placeholder: { kind: "runtime" },
            },
          ],
        });
        return compute.prepareRevision(revision, revisionContext);
      },
      async activateRevision(revision) {
        assert.equal((await currentAgent())?.activeRevisionId, revision.id);
        activations += 1;
      },
    }));
    const tokenService = controller.selectedDriver("token_service");
    const sourceInstance = {
      sourceRef: source.ref,
      tokenServiceInstanceId: controller.currentTokenServiceInstanceId(),
    };
    const canonical = await tokenService.resolveCredential(
      sourceInstance,
      AbortSignal.timeout(5_000),
    );
    assert.equal(canonical.credential, enrolledCredential);
    assert.ok(canonical.version);
    const revision = await controller.deployAgent(
      actorId,
      { namespaceId, agentId: owner.id },
      resolveApprovedHarness,
    );
    assert.equal(revision.executionAdmission.version, 8);
    const work = { id: revision.id, idempotencyKey: `agent_revision:${revision.id}:reconcile` };
    await fixture.work(work, "succeeded").catch((error: unknown) => {
      throw configurationError ?? error;
    });
    assert.equal((await currentAgent())?.activeRevisionId, revision.id);
    assert.equal(preparations, 1);
    assert.equal(activations, 1);
    assert.deepEqual(revision.credentialDeployment?.bindings, [
      {
        bindingRef: "model",
        sourceRef: source.ref,
        consumer: { kind: "model", providerId: "openai" },
        projection: { environment: "OPENAI_API_KEY", presentation: "bearer" },
      },
    ]);
    assert.deepEqual(deliveries, [
      {
        namespace: { ...fixture.namespace, name: placedName },
        targetRef: { namespaceId, agentId: owner.id, revisionId: revision.id, sandboxId },
        configurationId: revision.configurationId,
        binding: revision.credentialDeployment!.bindings[0],
        credential: { credential: enrolledCredential, version: canonical.version },
      },
    ]);
    // Worker shutdown closes its database pool. Source PATCH must retain the API-bound placement
    // resolver instead of depending on a resolver installed by the Worker.
    await fixture.stop();

    // The Worker has committed a real active v8 binding. Control only the Gateway transport:
    // the selected native Proxy must push the committed Source version and acknowledge the
    // attached target's UPDATE receipt before the authenticated Source PATCH succeeds.
    const { gateway, preparedProvider } = await attachActiveSource(
      { controller, source, namespaceId, placedName, gatewayTransport },
      revision,
      sandboxId,
      context.signal,
    );
    const { app, principalId, headers } = await authenticatedSourceOperator(fixture, controller);
    // Additional password accounts receive an Installation-only grant; update is exact to the Source.
    await grantOperator(
      controller,
      actorId,
      namespaceId,
      principalId,
      "update",
      "credential_source",
      source.id,
    );
    const replacement = randomUUID();
    try {
      const updated = await app.inject({
        method: "PATCH",
        url: `/namespaces/${namespaceId}/credential-sources/${source.id}`,
        headers,
        payload: { secret: replacement },
      });
      assert.equal(updated.statusCode, 200, updated.body);
      assert.equal(updated.body.includes(replacement), false);
    } finally {
      await app.close();
    }
    const current = await tokenService.resolveCredential(sourceInstance, context.signal);
    assert.equal(current.credential, replacement);
    assert.notEqual(current.version, canonical.version);
    assert.equal(gateway.updates.length, 1);
    const { workspace, name, credentials: delivered, config } = gateway.updates[0]!;
    assert.deepEqual(
      { workspace, name, credentials: delivered, config },
      {
        workspace: placedName,
        name: preparedProvider.name,
        credentials: { OPENAI_API_KEY: replacement },
        config: { oce_source_version: current.version },
      },
    );
    assert.equal(gateway.provider()?.config.oce_source_version, current.version);
    assert.deepEqual(gateway.receiptReads, [gateway.status()?.receipt?.receiptId]);
    assert.equal((await currentAgent())?.activeRevisionId, revision.id);
    assert.deepEqual(
      (
        await fixture.observerPool.query(
          "SELECT state,config FROM occ.credential_sources WHERE id=$1",
          [source.id],
        )
      ).rows,
      [{ state: "ready", config: { provider_preset: "openai" } }],
    );

    // An active staged revision cannot be replaced, including by a non-staged draft.
    await controller.updateAgent(
      actorId,
      {
        namespaceId,
        agentId: owner.id,
        configurationId: owner.configurationId,
        harnessAuth: { method: "runtime" },
        credentialSources: [],
      },
      resolveApprovedHarness,
    );
    await assert.rejects(
      controller.deployAgent(actorId, { namespaceId, agentId: owner.id }, resolveApprovedHarness),
      (error: unknown) =>
        error instanceof ResourceStateConflictError &&
        /active staged managed-credential revision/.test(error.message),
    );
    assert.equal((await currentAgent())?.activeRevisionId, revision.id);
    assert.equal(preparations, 1);
    assert.equal(activations, 1);
    const successorRevisions = await fixture.observerPool.query(
      `SELECT id FROM occ.agent_revisions WHERE namespace_id=$1 AND agent_id=$2 AND id<>$3`,
      [namespaceId, owner.id, revision.id],
    );
    const successorWork = await fixture.observerPool.query(
      `SELECT idempotency_key FROM occ.controller_work
       WHERE namespace_id=$1 AND agent_id=$2 AND revision_id<>$3`,
      [namespaceId, owner.id, revision.id],
    );
    assert.deepEqual(successorRevisions.rows, []);
    assert.deepEqual(successorWork.rows, []);

    // A new Agent can save repository restrictions before its first deployment, but
    // standalone credential admission cannot claim it can enforce those restrictions.
    const scopedConfiguration = await controller.createConfiguration(actorId, {
      namespaceId,
      kind: "agent",
      values: createHarnessConfiguration("openclaw", "gpt-4.1"),
    });
    const scopedOwner = await controller.createAgent(
      actorId,
      {
        namespaceId,
        name: `Scoped activation ${randomUUID()}`,
        configurationId: scopedConfiguration.id,
        executionMode: "dedicated",
        harnessAuth: { method: "credential_source", sourceId: source.id },
        credentialSources: [{ sourceId: source.id }],
      },
      resolveApprovedHarness,
    );
    await fixture.state.transact(async (unit) => {
      await unit.namespaces.lockNamespace(namespaceId);
      await unit.agents.lockAgent(namespaceId, scopedOwner.id);
      const current = await unit.sandboxPolicies.find(namespaceId, scopedOwner.id);
      assert.ok(current);
      assert.ok(
        await unit.sandboxPolicies.save(
          { ...current, version: current.version + 1, repositoryNetworkPolicy: [] },
          current.version,
        ),
      );
    });
    await assert.rejects(
      controller.deployAgent(
        actorId,
        { namespaceId, agentId: scopedOwner.id },
        resolveApprovedHarness,
      ),
      (error: unknown) =>
        error instanceof ResourceStateConflictError &&
        /saved repository network policy/.test(error.message),
    );
    const scopedRevisions = await fixture.observerPool.query(
      "SELECT id FROM occ.agent_revisions WHERE namespace_id=$1 AND agent_id=$2",
      [namespaceId, scopedOwner.id],
    );
    const scopedWork = await fixture.observerPool.query(
      "SELECT idempotency_key FROM occ.controller_work WHERE namespace_id=$1 AND agent_id=$2",
      [namespaceId, scopedOwner.id],
    );
    assert.deepEqual(scopedRevisions.rows, []);
    assert.deepEqual(scopedWork.rows, []);
  },
);

cases.revisionTest(
  "standalone activation refuses a source grant removed during preparation",
  async (fixture, context) => {
    let activations = 0;
    const { controller, owner, source, namespaceId, actorId, currentAgent } =
      await stagedCredentialScenario(fixture, context, (compute) => ({
        ...compute,
        async prepareRevision(revision) {
          const observation = await compute.prepareRevision(revision);
          // Preparation was authorized. Remove the exact Agent grant before it returns so
          // only the ordinary release authorization can prevent activation.
          await removeSourceGrant(fixture, owner, source.id);
          return observation;
        },
        async activateRevision() {
          activations += 1;
        },
      }));
    const revision = await controller.deployAgent(
      actorId,
      { namespaceId, agentId: owner.id },
      resolveApprovedHarness,
    );
    const work = { id: revision.id, idempotencyKey: `agent_revision:${revision.id}:reconcile` };
    await fixture.work(work, "failed_permanent");
    assert.equal((await currentAgent())?.activeRevisionId, revision.id);
    assert.equal(activations, 0);
    assert.equal((await fixture.workResult(work)).rows[0]?.reason_code, "AUTHORIZATION_DENIED");
    const audit = await fixture.observerPool.query(
      `SELECT details->'__occAuditMetadata'->'authorization' AS authorization
       FROM occ.audit_events WHERE namespace_id=$1 AND resource_id=$2 AND kind='authorization_denial'`,
      [namespaceId, owner.id],
    );
    assert.deepEqual(audit.rows, [
      {
        authorization: {
          principalId: owner.servicePrincipalId,
          action: "operate",
          resource: { kind: "credential_source", namespaceId, id: source.id },
        },
      },
    ]);
  },
);
