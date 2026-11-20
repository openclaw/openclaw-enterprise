import {
  assertInvalidInlinePlan,
  invalidInlinePlans,
} from "./occ-api-inline-provisioning-cases.ts";
import { runBackendAssociations, runBackendIdCharacterRule } from "./occ-api-backend-cases.ts";
import {
  registerAuthorizationDecisionCases,
  registerBootstrapAuthorizationEvidenceCase,
  registerDeploymentAuthorizationEvidenceCase,
} from "./occ-api-authorization-evidence-cases.ts";
import {
  registerGatewayAdmissionCases,
  registerSshAdmissionCases,
} from "./occ-api-compute-admission-cases.ts";
import {
  registerCodexPluginPolicyCases,
  registerOpenClawPluginPolicyCases,
} from "./occ-api-plugin-policy-cases.ts";
import {
  runBodylessRoutes,
  runNamespaceIsolation,
  runResourceRoutes,
} from "./occ-api-resource-route-cases.ts";
import {
  bindHarnessKey,
  bootstrapInstallation as bootstrap,
  createAgent,
  createConfiguration,
  createInjectedControllerFixture,
  createNamespace,
  createProvisioningCapableComputeDriver,
  createReadyNamespace,
  identifier,
  injectedRequest,
  readyNamespaceFixture as bootstrapReadyNamespace,
  slackValidationConfiguration,
} from "./occ-api-injected-fixture.ts";
import { fetchLoopback } from "../helpers/console-fixture-transport.ts";
import { DEDICATED_OPENCLAW_SUPPORT } from "../helpers/sandbox-driver.ts";
import { assertApiError } from "../helpers/api-error.mjs";
import { SlackChannelDriver } from "../../apps/controller/src/drivers/channel/slack.ts";
import { validateModelCredentialReferences } from "../../apps/controller/src/drivers/configuration/model-auth.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { isDeepStrictEqual, promisify } from "node:util";
import { realpathSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CodexPluginDriver,
  OCCPluginDriver,
} from "../../apps/controller/src/drivers/plugin/index.ts";
import { resolveApprovedHarness as resolveApprovedDevelopmentHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import {
  AgentDeletingError,
  AuthorizationDeniedError,
  BOOTSTRAP_DEFAULT_NAMESPACE_NAME,
  DependencyUnavailableError,
  ResourceStateConflictError,
  ScopeViolationError,
} from "../../packages/occ/src/index.ts";
import { authenticatedHeaders } from "../helpers/auth-session.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.ts";
import { createReadyComputeDriver } from "../helpers/development.mjs";
import { jsonLineDestination } from "../helpers/json-lines.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";
import {
  AGENT_DELETING,
  DEDICATED_STORAGE_ROUTING_REQUIRED,
  referenceFormRefusal,
  SERVICE_ACCOUNT_CROSS_NAMESPACE,
  SLACK_ROUTE_NOT_CONFIGURED,
  unboundReferenceRefusal,
  unsubstitutedReferenceRefusal,
  unsupportedChannelRefusal,
} from "../helpers/refusal-text.mjs";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.ts";
import { createOccLogger } from "../../apps/controller/src/logging.ts";
import { availablePort } from "../helpers/available-port.ts";
import { stopProcess } from "../helpers/stop-process.mjs";
import { servedAs } from "../helpers/agent-identity.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";
import { admittedConfiguration } from "../helpers/admitted-configuration.mjs";
import { createInstallationDriverConfiguration } from "../helpers/installation-driver-configuration.ts";

const repository = fileURLToPath(new URL("../..", import.meta.url));
const entrypoint = fileURLToPath(new URL("../../apps/controller/src/server.mjs", import.meta.url));
const missingRevisionId = "rev_3dd29693-ce8b-4b4c-97c4-14b4c68c6e9c";
const missingAgentId = "agt_6f1c9b2d-8e34-4a1f-9c57-2d0b8e4a71c3";

function childEnvironment(port, overrides = {}) {
  const environment = {
    ...process.env,
    NODE_ENV: "development",
    OCC_HOST: "127.0.0.1",
    OCC_PORT: String(port),
    OCC_AUTH_BASE_URL: "https://console.oce.localhost",
    OCC_AGENT_NATIVE_ADMIN_DOMAIN: "agents.oce.localhost",
    OCC_AUTH_SECRET: "openclaw-development-auth-secret-minimum-32-bytes",
    ...overrides,
  };

  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) {
      delete environment[key];
    }
  }

  return environment;
}

function startChild(port, overrides = {}) {
  const child = spawn(process.execPath, [entrypoint], {
    cwd: repository,
    env: childEnvironment(port, overrides),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });

  return { child, output: () => output };
}

// The missing-database case clears any inherited URL. The others use a closed port so
// PERSISTENCE_UNAVAILABLE distinguishes reaching the database from an earlier refusal.
// STARTUP_FAILED is a catch-all, so it cannot identify the exact reason for refusal.
async function assertUnsafeStartupRejected(t) {
  const configuredDatabase = { OCC_DATABASE_URL: "postgresql://127.0.0.1:1/openclaw" };
  const installationPath = join(
    await temporaryDirectory(t, "openclaw-enterprise-startup-refusal-"),
    "installation.json",
  );
  await writeFile(installationPath, JSON.stringify(createInstallationDriverConfiguration()));
  const productionEnvironment = {
    ...configuredDatabase,
    NODE_ENV: "production",
    OCC_HOST: "192.0.2.10",
    OCC_CONFIG_PATH: installationPath,
  };
  for (const [description, overrides, code] of [
    [
      "missing development database",
      { OCC_DATABASE_URL: undefined },
      "DATABASE_CONFIGURATION_INVALID",
    ],
    [
      "production mode",
      { ...configuredDatabase, NODE_ENV: "production", OCC_HOST: "192.0.2.10" },
      "STARTUP_FAILED",
    ],
    [
      "complete production configuration reaches the database",
      productionEnvironment,
      "PERSISTENCE_UNAVAILABLE",
    ],
    [
      "short production auth secret",
      { ...productionEnvironment, OCC_AUTH_SECRET: "insecure" },
      "AUTH_SECRET_INVALID",
    ],
    ["nonloopback bind", { ...configuredDatabase, OCC_HOST: "192.0.2.10" }, "STARTUP_FAILED"],
    ["unsafe container bind", { ...configuredDatabase, OCC_HOST: "0.0.0.0" }, "STARTUP_FAILED"],
    [
      "low-entropy auth secret",
      { ...configuredDatabase, OCC_AUTH_SECRET: "insecure" },
      "AUTH_SECRET_INVALID",
    ],
    [
      "invalid auth base URL",
      { ...configuredDatabase, OCC_AUTH_BASE_URL: "not-a-url" },
      "AUTH_BASE_URL_INVALID",
    ],
    [
      "nonloopback auth base URL",
      { ...configuredDatabase, OCC_AUTH_BASE_URL: "http://192.0.2.10:3000" },
      "AUTH_BASE_URL_INVALID",
    ],
  ]) {
    const port = await availablePort();
    const processState = startChild(port, overrides);
    let deadline;

    try {
      const result = await Promise.race([
        once(processState.child, "exit"),
        new Promise((_, reject) => {
          deadline = setTimeout(
            () => reject(new Error(`${description} did not reject startup within 15 seconds`)),
            15_000,
          );
        }),
      ]);
      const [exitCode] = result;
      assert.notEqual(exitCode, 0, `${description} must fail closed:\n${processState.output()}`);
      assert.match(processState.output(), new RegExp(`"code":"${code}"`), description);
    } finally {
      clearTimeout(deadline);
      await stopProcess(processState.child, { graceMs: 1_000 });
    }
  }
}

async function request(url, method, path, options = {}) {
  const headers = {
    host: "console.oce.localhost",
    ...(options.identity === false ? {} : authenticatedHeaders(options.session)),
    ...options.headers,
  };
  let body;

  if (Object.hasOwn(options, "body")) {
    body = JSON.stringify(options.body);
    headers["content-type"] ??= "application/json";
  } else if (Object.hasOwn(options, "rawBody")) {
    body = options.rawBody;
  }

  const response = await fetchLoopback(`${url}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
    signal: AbortSignal.timeout(5_000),
  });
  assert.match(response.headers.get("content-type") ?? "", /application\/json/i);
  const payload = await response.json();
  assert.match(payload.meta?.requestId ?? "", identifier("req"));
  assert.equal(response.headers.get("x-request-id"), payload.meta.requestId);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");

  if (response.ok) {
    assert.deepEqual(Object.keys(payload).sort(), ["data", "meta"]);
  } else {
    assert.deepEqual(Object.keys(payload).sort(), ["error", "meta"]);
    assert.equal(typeof payload.error.code, "string");
    assert.ok(payload.error.code.length > 0);
    assert.match(payload.error.code, /^[A-Z][A-Z_]*$/);
    assert.equal(typeof payload.error.message, "string");
    assert.ok(payload.error.message.length > 0);
  }

  return {
    status: response.status,
    headers: response.headers,
    body: payload,
    data: payload.data,
  };
}

async function defaultNamespace(controller) {
  const result = await controller.request("GET", "/namespaces");
  assert.equal(result.status, 200);
  const found = result.data.find(
    (namespace) => namespace.name === BOOTSTRAP_DEFAULT_NAMESPACE_NAME,
  );
  assert.ok(found, "fresh bootstrap must create the default Namespace");
  assert.equal(found.status, "provisioning");
  return found;
}

function assertOnlyDefaultNamespace(response) {
  assert.equal(response.status, 200);
  assert.deepEqual(
    response.data.map((namespace) => namespace.name),
    [BOOTSTRAP_DEFAULT_NAMESPACE_NAME],
  );
}

function exactSecretRef(namespaceId, id) {
  return { kind: "secret", namespaceId, id };
}

function provisioningRequestBody(namespaceId, secrets, { configuration, ...overrides } = {}) {
  return {
    requestId: `req_${randomUUID()}`,
    name: `Provisioned Agent ${randomUUID().slice(0, 8)}`,
    executionMode: "dedicated",
    configuration: {
      kind: "agent",
      values: { agents: { defaults: { model: "codex/gpt-6-astra" } } },
      secretBindings: {
        TOOL_API_KEY: {
          source: exactSecretRef(namespaceId, secrets.toolApiKey.id),
        },
      },
      ...configuration,
    },
    harnessAuth: {
      method: "api_key",
      source: exactSecretRef(namespaceId, secrets.modelApiKey.id),
    },
    ...overrides,
  };
}

function createProvisioningCapableConfigurationDriver() {
  return createTestConfigurationDriver({ id: "configuration-provisioning-api", exact: true });
}

const diffsPluginId = "occ-plugin:diffs";
const linearPluginId = "codex-plugin:linear@openai-curated-remote";

function pluginPolicy(overrides = {}) {
  return { enabled: true, toolDefaults: { approval: "none" }, ...overrides };
}

function assertPolicyOnlyPlugin(selection) {
  for (const key of ["id", "nativeId", "name", "driver", "release", "artifacts"]) {
    assert.equal(
      Object.hasOwn(selection, key),
      false,
      `Agent plugin policy must not expose ${key}`,
    );
  }
}

function createInjectedFixture(options = {}) {
  return createInjectedControllerFixture(options, {
    wrapPlatformState(baseState) {
      return baseState;
    },
    invokeApplication(factory, appOptions) {
      return factory(appOptions);
    },
  });
}

async function configuredController(options = {}) {
  const fixture = await createInjectedFixture(options);
  return {
    fixture,
    request: (method, pathname, options) => injectedRequest(fixture.app, method, pathname, options),
  };
}

async function readyNamespaceFixture(namespaceName, controllerOptions, bootstrapName) {
  const controller = await configuredController(controllerOptions);
  return bootstrapReadyNamespace(controller, namespaceName, bootstrapName);
}

async function firstDeploymentFixture({ ready = true, slackFetch } = {}) {
  let providerCalls = 0;
  const channelDriver = new SlackChannelDriver(async (...args) => {
    providerCalls++;
    if (slackFetch) {
      return slackFetch(...args);
    }
    assert.fail("Guarded admission must never contact Slack");
  });
  const secretDriver = createTestSecretDriver();
  const controller = await configuredController({
    recordOperations: true,
    channelDriver,
    secretDriver,
  });
  await bootstrap(controller);
  const namespace = await createNamespace(controller, "first-deployment");
  if (ready) {
    await controller.fixture.controller.handleNamespaceLifecycle(
      controller.fixture.principal.id,
      namespace.id,
      "ready",
    );
  }
  const agent = await createAgent(controller, namespace.id, "first-deployment");
  if (ready) {
    await bindHarnessKey(controller.fixture, namespace.id, agent);
  }
  secretDriver.calls.length = 0;
  const path = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const intent = {
    key: "review-1",
    expectedConfigurationId: agent.configurationId,
    expectedGeneration: 1,
  };
  const recover = (body = intent, options = {}) =>
    controller.request(
      "GET",
      `${path}/deploy-first/${body.key}/${body.expectedConfigurationId}/${body.expectedGeneration}`,
      options,
    );
  const listRevisions = () =>
    controller.fixture.platformState.read((state) =>
      state.revisions.listRevisions(namespace.id, agent.id),
    );
  const listRevisionMetadata = () =>
    controller.fixture.platformState.read((state) =>
      state.revisions.listRevisionMetadata(namespace.id, agent.id),
    );
  const work = () =>
    controller.fixture.platformState
      .pendingOperations()
      .filter((entry) => entry.kind === "agent_revision");
  return {
    controller,
    namespace,
    agent,
    path,
    intent,
    recover,
    listRevisions,
    listRevisionMetadata,
    work,
    secretDriver,
    channelDriver,
    providerCalls: () => providerCalls,
  };
}

test("guarded first deployment returns 409 and audits an unready Namespace without credential or work effects", async () => {
  const { controller, agent, path, intent, work, secretDriver, providerCalls } =
    await firstDeploymentFixture({ ready: false });
  const before = controller.fixture.auditSink.events.length;
  const result = await controller.request("POST", `${path}/deploy-first`, { body: intent });
  assertApiError(result, 409, "NAMESPACE_NOT_READY");
  const events = controller.fixture.auditSink.events.slice(before);
  assert.equal(events.length, 1);
  assert.deepEqual(
    events.map(({ action, kind, outcome, reasonCode, resource }) => [
      action,
      kind,
      outcome,
      reasonCode,
      resource.id,
    ]),
    [["openclaw.agents.deploy", "mutation", "failure", "NAMESPACE_NOT_READY", agent.id]],
  );
  assert.equal(work().length, 0);
  assert.equal(secretDriver.calls.length, 0);
  assert.equal(providerCalls(), 0);
});

test("guarded first deployment with the bundled Slack selection recovers without writes", async () => {
  const deployment = await firstDeploymentFixture();
  const { controller, namespace, agent, path, intent, recover, work, secretDriver, providerCalls } =
    deployment;
  const schemaApp = controller.fixture.createApp(undefined, createFastifyApp);
  let operations;
  try {
    await schemaApp.ready();
    operations = Object.values(schemaApp.swagger().paths).flatMap((path) => Object.values(path));
  } finally {
    await schemaApp.close();
  }
  const permissions = (id) =>
    operations.find((operation) => operation.operationId === id)["x-openclaw-permissions"];
  assert.deepEqual(permissions("recoverAgentFirstDeployment"), [
    { action: "deploy", resourceKind: "agent", scope: "requested" },
    { action: "read", resourceKind: "configuration", scope: "requested" },
  ]);
  const guardedPermissions = permissions("deployAgentFirst");
  assert.deepEqual(
    guardedPermissions.map(({ phase, ...permission }) => permission),
    permissions("deployAgent"),
  );
  assert.deepEqual(
    guardedPermissions.filter((permission) => permission.phase === undefined),
    permissions("recoverAgentFirstDeployment"),
  );
  assert.ok(
    guardedPermissions.some(
      (permission) =>
        permission.phase === "fresh_admission" &&
        permission.condition === "missing_runtime_credentials",
    ),
  );
  const before = controller.fixture.auditSink.events.length;
  const miss = await recover();
  assert.equal(miss.status, 200, JSON.stringify(miss.body));
  assert.equal(miss.data, null);
  assert.equal(miss.headers.get("cache-control"), "no-store");
  assert.equal(work().length, 0);
  assert.equal(secretDriver.calls.length, 0);
  assert.equal(controller.fixture.auditSink.events.length, before);
  // Discard the reply; the observer reads the owning state, just as in the stock control.
  await controller.request("POST", `${path}/deploy-first`, { body: intent });
  const [stored] = await deployment.listRevisions();
  assert.ok(stored);
  const calls = secretDriver.calls.length;
  const events = controller.fixture.auditSink.events.length;
  const found = await recover();
  assert.equal(found.status, 200, JSON.stringify(found.body));
  assert.equal(found.headers.get("cache-control"), "no-store");
  assert.deepEqual(found.data, {
    revisionId: stored.id,
    namespaceId: namespace.id,
    agentId: agent.id,
    configurationId: agent.configurationId,
    configurationGeneration: 1,
    createdAt: stored.createdAt,
  });
  const replay = await controller.request("POST", `${path}/deploy-first`, { body: intent });
  assert.equal(replay.status, 202, JSON.stringify(replay.body));
  assert.deepEqual(replay.data, found.data);
  assert.equal(secretDriver.calls.length, calls);
  assert.equal(controller.fixture.auditSink.events.length, events);
  assert.equal(work().length, 1);
  assert.equal(providerCalls(), 0);
  for (const altered of [
    { ...intent, key: "other" },
    { ...intent, expectedGeneration: 2 },
  ]) {
    assert.equal((await recover(altered)).data, null);
    const conflict = await controller.request("POST", `${path}/deploy-first`, { body: altered });
    assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
    assert.match(conflict.body.error.message, /already has revision history/);
    assert.match(conflict.body.error.message, /Recover the original first-deployment receipt/);
    assert.match(
      conflict.body.error.message,
      /ordinary deploy only for an intentional later revision/,
    );
  }
  const ordinary = await controller.request("POST", `${path}/deploy`);
  assert.equal(ordinary.status, 202, JSON.stringify(ordinary.body));
  assert.equal(ordinary.data.revision, 2);
  const replacement = await createConfiguration(controller, namespace.id);
  assert.equal(
    (await controller.request("PATCH", path, { body: { configurationId: replacement.id } })).status,
    200,
  );
  assert.deepEqual((await recover()).data, found.data);
  assert.equal((await recover({ ...intent, expectedConfigurationId: replacement.id })).data, null);
  assert.equal(work().length, 2);
  assert.equal((await controller.request("POST", `${path}/stop`)).status, 202);
  assert.equal(
    (
      await controller.request("POST", `${path}/deploy-first`, {
        body: { ...intent, key: "new-intent", expectedConfigurationId: replacement.id },
      })
    ).status,
    409,
  );

  for (const revision of await deployment.listRevisions()) {
    for (const field of ["key", "actorId", "firstDeploymentDigest", "first_deployment_digest"]) {
      assert.equal(Object.hasOwn(revision, field), false);
      assert.equal(Object.hasOwn(ordinary.data, field), false);
    }
  }
});

test("guarded first deployment isolates actors and requires current exact authority", async () => {
  const { controller, namespace, agent, path, intent, recover, work } =
    await firstDeploymentFixture();
  const { fixture } = controller;
  const admitted = await controller.request("POST", `${path}/deploy-first`, { body: intent });
  assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
  const actor = await fixture.createAuthPrincipal("another-deployer");
  fixture.state.identities.push(actor.principal);
  const role = {
    id: "exact-deployer",
    namespaceId: namespace.id,
    permissions: [
      { action: "deploy", resourceKind: "agent" },
      { action: "read", resourceKind: "configuration" },
    ],
  };
  fixture.state.roles.push(role);
  for (const [kind, id] of [
    ["agent", agent.id],
    ["configuration", agent.configurationId],
  ]) {
    fixture.state.bindings.push({
      id: `exact-${kind}`,
      namespaceId: namespace.id,
      subjectKind: "identity",
      subjectId: actor.principal.id,
      roleId: role.id,
      resourceKind: kind,
      resourceId: id,
    });
  }
  const otherActor = await recover(intent, { session: actor.session });
  assert.equal(otherActor.status, 200, JSON.stringify(otherActor.body));
  assert.equal(otherActor.data, null);
  assert.equal(otherActor.headers.get("cache-control"), "no-store");
  const collision = await controller.request("POST", `${path}/deploy-first`, {
    body: intent,
    session: actor.session,
  });
  assert.equal(collision.status, 409);
  // Exact revision-read authority admits status polling, but not intent recovery or admission.
  role.permissions = [{ action: "read", resourceKind: "agent_revision" }];
  fixture.state.bindings.push({
    id: "exact-status-revision",
    namespaceId: namespace.id,
    subjectKind: "identity",
    subjectId: actor.principal.id,
    roleId: role.id,
    resourceKind: "agent_revision",
    resourceId: admitted.data.revisionId,
  });
  const revisionsBeforeStatusRead = await fixture.platformState.read((state) =>
    state.revisions.listRevisions(namespace.id, agent.id),
  );
  const workBeforeStatusRead = structuredClone(work());
  const status = await controller.request(
    "GET",
    `${path}/deployments/${admitted.data.revisionId}`,
    { session: actor.session },
  );
  assert.equal(status.status, 200, JSON.stringify(status.body));
  assert.equal(status.data.deploymentId, admitted.data.revisionId);
  assert.equal((await recover(intent, { session: actor.session })).status, 403);
  assert.equal(
    (
      await controller.request("POST", `${path}/deploy-first`, {
        body: intent,
        session: actor.session,
      })
    ).status,
    403,
  );
  assert.deepEqual(
    await fixture.platformState.read((state) =>
      state.revisions.listRevisions(namespace.id, agent.id),
    ),
    revisionsBeforeStatusRead,
  );
  assert.deepEqual(work(), workBeforeStatusRead);
  // Revocation applies to the original actor as well, even though its digest matches.
  const administrator = fixture.state.roles[0];
  const previous = administrator.permissions;
  administrator.permissions = [{ action: "read", resourceKind: "agent" }];
  const revoked = await recover();
  assert.equal(revoked.status, 403);
  assert.equal(revoked.headers.get("cache-control"), "no-store");
  administrator.permissions = [{ action: "deploy", resourceKind: "agent" }];
  assert.equal((await recover()).status, 403);
  administrator.permissions = [
    { action: "deploy", resourceKind: "agent" },
    { action: "read", resourceKind: "configuration" },
  ];
  const minimalRecovery = await recover();
  assert.equal(minimalRecovery.status, 200, JSON.stringify(minimalRecovery.body));
  assert.deepEqual(minimalRecovery.data, admitted.data);
  const minimalReplay = await controller.request("POST", `${path}/deploy-first`, { body: intent });
  assert.equal(minimalReplay.status, 202, JSON.stringify(minimalReplay.body));
  assert.deepEqual(minimalReplay.data, admitted.data);
  administrator.permissions = previous;
  const otherAgent = await createAgent(controller, namespace.id, "another-agent");
  const otherPath = `/namespaces/${namespace.id}/agents/${otherAgent.id}/deploy-first`;
  assert.equal(
    (
      await controller.request(
        "GET",
        `${otherPath}/${intent.key}/${intent.expectedConfigurationId}/${intent.expectedGeneration}`,
      )
    ).data,
    null,
  );
  const foreign = await createNamespace(controller, "foreign-intent");
  const cross = await controller.request(
    "GET",
    `/namespaces/${foreign.id}/agents/${agent.id}/deploy-first/${intent.key}/${intent.expectedConfigurationId}/${intent.expectedGeneration}`,
  );
  assert.equal(cross.status, 404);
  assert.equal(work().length, 1);
});

test("guarded first deployment rejects stale binding and generation before credential work", async () => {
  for (const change of ["binding", "generation"]) {
    const { controller, namespace, path, intent, work, secretDriver } =
      await firstDeploymentFixture();
    if (change === "binding") {
      const replacement = await createConfiguration(controller, namespace.id);
      assert.equal(replacement.generation, intent.expectedGeneration);
      assert.equal(
        (await controller.request("PATCH", path, { body: { configurationId: replacement.id } }))
          .status,
        200,
      );
    } else {
      assert.equal(
        (
          await controller.request(
            "PATCH",
            `/namespaces/${namespace.id}/configurations/${intent.expectedConfigurationId}`,
            { body: { values: {} } },
          )
        ).status,
        200,
      );
    }
    secretDriver.calls.length = 0;
    const iam = controller.fixture.iamDriver;
    const authorize = iam.authorize.bind(iam);
    iam.authorize = async (request) => {
      if (request.resource.kind === "configuration") {
        assert.equal(
          request.resource.id,
          intent.expectedConfigurationId,
          "must not expose a different draft",
        );
      }
      return authorize(request);
    };
    const state = controller.fixture.platformState;
    const transact = state.transact.bind(state);
    let mutations = 0;
    state.transact = (...args) => {
      mutations++;
      return transact(...args);
    };
    const result = await controller.request("POST", `${path}/deploy-first`, { body: intent });
    assert.equal(result.status, 409, JSON.stringify(result.body));
    assert.match(
      result.body.error.message,
      change === "binding" ? /different Configuration/ : /expected Configuration generation/,
    );
    assert.match(result.body.error.message, /Recover the original first-deployment receipt/);
    assert.doesNotMatch(result.body.error.message, /ordinary deploy/);
    assert.equal(secretDriver.calls.length, 0);
    assert.equal(work().length, 0);
    assert.equal(mutations, 0, "a stale snapshot must not enter admission");
  }
});

test("direct first-deployment intent boundary rejects malformed values before I/O", async (t) => {
  const { controller, namespace, agent, intent, listRevisions, work, secretDriver, providerCalls } =
    await firstDeploymentFixture();
  const { fixture } = controller;
  const input = { namespaceId: namespace.id, agentId: agent.id };
  const state = fixture.platformState;
  const beforeAudit = fixture.auditSink.events.length;
  const { key: _key, ...missingKey } = intent;
  const nonPrimitiveIdentity = {
    toJSON() {
      assert.fail("A non-string identity reached digest serialization");
    },
  };
  const invalid = [
    ["absent intent", undefined],
    ["null intent", null],
    ["absent key", missingKey],
    ["null key", { ...intent, key: null }],
    ["numeric key", { ...intent, key: 123 }],
    [
      "non-string Agent",
      intent,
      { ...input, agentId: nonPrimitiveIdentity },
      "The exact Agent identity is missing.",
    ],
    [
      "non-string Namespace",
      intent,
      { ...input, namespaceId: nonPrimitiveIdentity },
      "The exact Namespace identity is missing.",
    ],
    [
      "non-string Configuration",
      { ...intent, expectedConfigurationId: nonPrimitiveIdentity },
      input,
      "The exact Configuration identity is missing.",
    ],
  ];

  // Independent public calls must reject before even opening a state boundary.
  // Keep the real authorized controller; spies guard only downstream I/O.
  for (const method of ["deployAgentFirst", "recoverAgentFirstDeployment"]) {
    for (const [
      label,
      malformed,
      target = input,
      message = "Invalid first-deployment intent.",
    ] of invalid) {
      await t.test(`${method}: ${label}`, async (caseContext) => {
        const boundaries = ["read", "transact"].map((name) =>
          caseContext.mock.method(state, name, () => {
            assert.fail(`Invalid intent reached state.${name}`);
          }),
        );
        const audit = caseContext.mock.fn(() => assert.fail("Invalid intent reached audit"));
        await assert.rejects(
          fixture.controller[method](
            fixture.principal.id,
            target,
            malformed,
            resolveApprovedDevelopmentHarness,
            audit,
          ),
          (error) => {
            assert.ok(error instanceof ScopeViolationError);
            assert.equal(error.message, message);
            return true;
          },
        );
        for (const boundary of boundaries) {
          assert.equal(boundary.mock.callCount(), 0);
        }
        assert.equal(audit.mock.callCount(), 0);
        assert.equal(secretDriver.calls.length, 0);
        assert.equal(providerCalls(), 0);
        assert.equal(fixture.auditSink.events.length, beforeAudit);
        assert.equal(work().length, 0);
      });
    }
  }
  // No revision or queued work can be written without crossing the guarded state
  // boundaries. Inspect the real store too, after the per-call spies are restored.
  assert.deepEqual(await listRevisions(), []);
  assert.equal(work().length, 0);

  await t.test("valid string admits revision one and recovers with real grants", async () => {
    const admitted = await fixture.controller.deployAgentFirst(
      fixture.principal.id,
      input,
      intent,
      resolveApprovedDevelopmentHarness,
    );
    const revisions = await listRevisions();
    assert.equal(revisions.length, 1);
    assert.equal(revisions[0].id, admitted.revisionId);
    assert.equal(work().length, 1);
    assert.deepEqual(
      await fixture.controller.recoverAgentFirstDeployment(fixture.principal.id, input, intent),
      admitted,
    );
    assert.equal(work().length, 1);
  });
});

test("direct first-deployment captures intent for exact current receipt authority", async (t) => {
  const { controller, namespace, agent, path, intent, work, secretDriver } =
    await firstDeploymentFixture();
  const { fixture } = controller;
  const actorId = fixture.principal.id;
  const input = { namespaceId: namespace.id, agentId: agent.id };
  const configurationB = await createConfiguration(controller, namespace.id);
  const admitted = await controller.request("POST", `${path}/deploy-first`, { body: intent });
  assert.equal(admitted.status, 202, JSON.stringify(admitted.body));

  // This actor owns the known A receipt. Replace its broad grant with exact
  // Agent deploy and Configuration A/B read grants, then revoke only A read.
  fixture.state.roles[0].permissions = [];
  const role = {
    id: "receipt-exact-reader",
    namespaceId: namespace.id,
    permissions: [
      { action: "deploy", resourceKind: "agent" },
      { action: "read", resourceKind: "configuration" },
    ],
  };
  fixture.state.roles.push(role);
  for (const [kind, id] of [
    ["agent", agent.id],
    ["configuration", agent.configurationId],
    ["configuration", configurationB.id],
  ]) {
    fixture.state.bindings.push({
      id: `receipt-${id}`,
      namespaceId: namespace.id,
      subjectKind: "identity",
      subjectId: actorId,
      roleId: role.id,
      resourceKind: kind,
      resourceId: id,
    });
  }
  const checks = [];
  const iam = fixture.iamDriver;
  const authorize = iam.authorize.bind(iam);
  t.mock.method(iam, "authorize", async (request) => {
    const decision = await authorize(request);
    checks.push({
      action: request.action,
      resource: { ...request.resource },
      allowed: decision.allowed,
    });
    return decision;
  });
  const invoke = (method, body) =>
    fixture.controller[method](actorId, input, body, resolveApprovedDevelopmentHarness);
  const expectedChecks = (configurationId, allowed) => [
    {
      action: "deploy",
      resource: { kind: "agent", id: agent.id, namespaceId: namespace.id },
      allowed: true,
    },
    {
      action: "read",
      resource: { kind: "configuration", id: configurationId, namespaceId: namespace.id },
      allowed,
    },
  ];
  const methods = ["deployAgentFirst", "recoverAgentFirstDeployment"];
  for (const method of methods) {
    checks.length = 0;
    assert.deepEqual(await invoke(method, { ...intent }), admitted.data);
    assert.deepEqual(checks, expectedChecks(agent.configurationId, true));
  }
  const bindingA = fixture.state.bindings.find(
    (binding) => binding.id === `receipt-${agent.configurationId}`,
  );
  assert.ok(bindingA);
  fixture.state.bindings.splice(fixture.state.bindings.indexOf(bindingA), 1);
  const beforeAudit = fixture.auditSink.events.length;
  const beforeWork = structuredClone(work());
  const beforeSecrets = secretDriver.calls.length;
  const beforeRevisions = await fixture.platformState.read((view) =>
    view.revisions.listRevisions(namespace.id, agent.id),
  );
  for (const method of methods) {
    for (const mutate of [false, true]) {
      const label = mutate ? "immediate A-to-B mutation" : "stable A";
      await t.test(`${method}: ${label} denies the known receipt`, async () => {
        checks.length = 0;
        const body = { ...intent };
        const pending = invoke(method, body);
        if (mutate) {
          body.expectedConfigurationId = configurationB.id;
        }
        // Check the outcome as well as effects: a leaked receipt creates no work.
        const outcome = await pending.then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        assert.deepEqual(
          {
            authorizationTrace: checks,
            denied: outcome.error instanceof AuthorizationDeniedError,
            returnedKnownReceipt: isDeepStrictEqual(outcome.value, admitted.data),
            returnedConfigurationId: outcome.value?.configurationId,
          },
          {
            authorizationTrace: expectedChecks(agent.configurationId, false),
            denied: true,
            returnedKnownReceipt: false,
            returnedConfigurationId: undefined,
          },
        );
      });
    }
    await t.test(`${method}: allowed B has no matching receipt`, async () => {
      checks.length = 0;
      const pending = invoke(method, { ...intent, expectedConfigurationId: configurationB.id });
      if (method === "recoverAgentFirstDeployment") {
        assert.equal(await pending, null);
      } else {
        await assert.rejects(pending, ResourceStateConflictError);
      }
      assert.deepEqual(checks, expectedChecks(configurationB.id, true));
    });
  }
  assert.deepEqual(
    await fixture.platformState.read((view) =>
      view.revisions.listRevisions(namespace.id, agent.id),
    ),
    beforeRevisions,
  );
  assert.deepEqual(work(), beforeWork);
  assert.equal(secretDriver.calls.length, beforeSecrets);
  assert.equal(fixture.auditSink.events.length, beforeAudit);
});

test("direct first-deployment captures scalars once for fresh admission and recovery", async (t) => {
  for (const change of ["stateful key", "immediate target and generation mutation"]) {
    await t.test(change, async (caseContext) => {
      const { controller, namespace, agent, path, intent, listRevisions, work } =
        await firstDeploymentFixture();
      const { fixture } = controller;
      const actorId = fixture.principal.id;
      const deploy = fixture.controller.deployAgentFirst.bind(fixture.controller);
      let keyReads = 0;
      // The authenticated handler supplies its normal audit factory. Forward it
      // unchanged while exercising the genuine controller's mutable JS boundary.
      caseContext.mock.method(
        fixture.controller,
        "deployAgentFirst",
        (actor, input, body, ...rest) => {
          if (change === "stateful key") {
            Object.defineProperty(body, "key", {
              get: () => (++keyReads === 1 ? intent.key : 123),
            });
          }
          const pending = deploy(actor, input, body, ...rest);
          if (change !== "stateful key") {
            input.agentId = missingAgentId;
            input.harnessOverrides = { unsupported: true };
            body.expectedGeneration = 2;
          }
          return pending;
        },
      );
      const beforeAudit = fixture.auditSink.events.length;
      const admitted = await controller.request("POST", `${path}/deploy-first`, { body: intent });
      assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
      if (change === "stateful key") {
        assert.equal(keyReads, 1);
      }
      const revisions = await listRevisions();
      assert.equal(revisions.length, 1);
      const [revision] = revisions;
      assert.equal(revision.revision, 1);
      assert.deepEqual(admitted.data, {
        revisionId: revision.id,
        namespaceId: namespace.id,
        agentId: agent.id,
        configurationId: intent.expectedConfigurationId,
        configurationGeneration: intent.expectedGeneration,
        createdAt: revision.createdAt,
      });
      assert.equal(work().length, 1);
      assert.equal(work()[0].resourceId, revision.id);
      assert.equal(work()[0].namespaceId, namespace.id);
      assert.equal(work()[0].actorId, actorId);
      assert.equal(work()[0].action, "reconcile");
      const events = fixture.auditSink.events.slice(beforeAudit);
      assert.equal(events.length, 1);
      assert.equal(events[0].actorId, actorId);
      assert.equal(events[0].actor.principalId, actorId);
      assert.equal(events[0].outcome, "success");
      assert.deepEqual(events[0].resource, {
        kind: "agent_revision",
        id: revision.id,
        namespaceId: namespace.id,
      });
      assert.deepEqual(events[0].authorization, {
        principalId: actorId,
        action: "deploy",
        resource: { kind: "agent", id: agent.id, namespaceId: namespace.id },
      });
      const input = { namespaceId: namespace.id, agentId: agent.id };
      for (let attempt = 0; attempt < 2; attempt++) {
        assert.deepEqual(
          await fixture.controller.recoverAgentFirstDeployment(actorId, input, intent),
          admitted.data,
        );
      }
      if (change === "stateful key") {
        let recoveryKeyReads = 0;
        const lookup = {
          ...intent,
          get key() {
            return ++recoveryKeyReads === 1 ? intent.key : 123;
          },
        };
        assert.deepEqual(
          await fixture.controller.recoverAgentFirstDeployment(actorId, input, lookup),
          admitted.data,
        );
        assert.equal(recoveryKeyReads, 1);
      }
      assert.deepEqual(await listRevisions(), revisions);
      assert.equal(work().length, 1);
      assert.deepEqual(fixture.auditSink.events.slice(beforeAudit), events);
    });
  }
});

test("guarded first deployment propagates snapshot read failures without entering admission", async () => {
  const { controller, namespace, agent, intent, work, secretDriver } =
    await firstDeploymentFixture();
  const state = controller.fixture.platformState;
  const read = state.read.bind(state);
  state.read = (operation) =>
    read((unit) =>
      operation({
        ...unit,
        configurations: {
          ...unit.configurations,
          findConfiguration: async () => {
            throw new Error("synthetic snapshot read failure");
          },
        },
      }),
    );
  state.transact = async () => assert.fail("a failed read must not enter admission");
  await assert.rejects(
    controller.fixture.controller.deployAgentFirst(
      controller.fixture.principal.id,
      { namespaceId: namespace.id, agentId: agent.id },
      intent,
      resolveApprovedDevelopmentHarness,
    ),
    { message: "synthetic snapshot read failure" },
  );
  assert.equal(secretDriver.calls.length, 0);
  assert.equal(work().length, 0);
});

test(
  "guarded first deployment serializes fresh Slack contenders after concurrent preparation",
  { timeout: 10000 },
  async (t) => {
    for (const matching of [false, true]) {
      let arrivals = 0;
      const both = Promise.withResolvers();
      const { controller, path, intent, work, recover, secretDriver, providerCalls } =
        await slackFirstDeploymentFixture(true, async () => {
          if (++arrivals === 2) {
            both.resolve();
          }
          await both.promise;
        });
      const before = controller.fixture.auditSink.events.length;
      const intents = [intent, matching ? intent : { ...intent, key: "competing" }];
      const results = await Promise.all(
        intents.map((body) => controller.request("POST", `${path}/deploy-first`, { body })),
      );
      assert.deepEqual(
        results.map((result) => result.status).sort(),
        matching ? [202, 202] : [202, 409],
      );
      assert.equal(work().length, 1);
      assert.equal(controller.fixture.auditSink.events.length - before, 1);
      const winner = results.findIndex((result) => result.status === 202);
      const receipt = await recover(intents[winner]);
      assert.deepEqual(receipt.data, results[winner].data);
      if (matching) {
        assert.deepEqual(results[0].data, results[1].data);
      }
      assert.equal(providerCalls(), 2);
      assert.equal(secretDriver.calls.filter((call) => call.operation === "withValue").length, 2);
      assert.equal(secretDriver.calls.filter((call) => call.operation === "resolve").length, 2);
      t.diagnostic(
        JSON.stringify({ matching, sender: 2, withValue: 2, resolve: 2, work: 1, audit: 1 }),
      );
    }
  },
);

async function slackFirstDeploymentFixture(enabled = true, beforeResponse = async () => {}) {
  const fixture = await firstDeploymentFixture({
    slackFetch: async (url, options) => {
      assert.equal(new URL(url).href, "https://slack.com/api/auth.test");
      assert.equal(options.method, "POST");
      assert.equal(options.headers.authorization, "Bearer xoxb-synthetic-bot");
      await beforeResponse();
      return Response.json({ ok: true, bot_id: "B123", team_id: "T123" });
    },
  });
  const { controller, namespace, agent } = fixture;
  const bot = await controller.request("POST", `/namespaces/${namespace.id}/secrets`, {
    body: { name: "slack-bot", value: "xoxb-synthetic-bot" },
  });
  assert.equal(bot.status, 201, JSON.stringify(bot.body));
  const harnessGrant = controller.fixture.state.bindings.find(
    (binding) => binding.id === `harness-key-${agent.id}`,
  );
  controller.fixture.state.bindings.push({
    ...harnessGrant,
    id: `slack-bot-${agent.id}`,
    resourceId: bot.data.id,
  });
  const updated = await controller.request(
    "PATCH",
    `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
    {
      body: {
        values: { channels: { slack: { enabled, mode: "http", botToken: "${SLACK_BOT_TOKEN}" } } },
        secretBindings: { SLACK_BOT_TOKEN: { source: bot.data.ref } },
      },
    },
  );
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  fixture.secretDriver.calls.length = 0;
  return {
    ...fixture,
    bot: bot.data,
    intent: { ...fixture.intent, expectedGeneration: updated.data.generation },
  };
}

test("guarded first deployment admits enabled Slack over real HTTP and recovers without I/O", async (t) => {
  for (const [enabled, route] of [
    [true, "deploy-first"],
    [false, "deploy-first"],
    [true, "deploy"],
  ]) {
    const deployment = await slackFirstDeploymentFixture(enabled);
    const { controller, namespace, path, intent, secretDriver, work, providerCalls } = deployment;
    const app = controller.fixture.createApp(undefined, createFastifyApp);
    try {
      const url = await app.listen({ host: "127.0.0.1", port: 0 });
      const send = (method, suffix, options = {}) =>
        request(url, method, `${path}/${suffix}`, {
          session: app.defaultSession,
          ...options,
        });
      const before = controller.fixture.auditSink.events.length;
      const result = await send("POST", route, route === "deploy-first" ? { body: intent } : {});
      assert.equal(result.status, 202, JSON.stringify(result.body));
      assert.equal(work().length, 1);
      const revisions = await deployment.listRevisionMetadata();
      assert.equal(revisions.length, 1);
      assert.equal(controller.fixture.auditSink.events.length - before, 1);
      assert.equal(providerCalls(), enabled ? 1 : 0);
      assert.equal(
        secretDriver.calls.filter((call) => call.operation === "withValue").length,
        enabled ? 1 : 0,
      );
      assert.equal(secretDriver.calls.filter((call) => call.operation === "resolve").length, 2);
      const calls = structuredClone(secretDriver.calls);
      if (route === "deploy-first") {
        assert.deepEqual(Object.keys(result.data).sort(), [
          "agentId",
          "configurationGeneration",
          "configurationId",
          "createdAt",
          "namespaceId",
          "revisionId",
        ]);
        // Poison the fresh-only dependency after commit. Recovery must not consult it.
        controller.fixture.configurationDriver.read = async () =>
          assert.fail("Recovery read Configuration storage");
        const recovered = await send(
          "GET",
          `deploy-first/${intent.key}/${intent.expectedConfigurationId}/${intent.expectedGeneration}`,
        );
        const replay = await send("POST", "deploy-first", { body: intent });
        assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
        assert.equal(recovered.headers.get("cache-control"), "no-store");
        assert.equal(replay.status, 202, JSON.stringify(replay.body));
        assert.deepEqual(recovered.data, result.data);
        assert.deepEqual(replay.data, result.data);
        assert.deepEqual(secretDriver.calls, calls);
        assert.equal(providerCalls(), enabled ? 1 : 0);
        assert.equal(work().length, 1);
        assert.equal(controller.fixture.auditSink.events.length - before, 1);

        // A receipt is private even to its original actor once current draft-read authority
        // is revoked. Use the real IAM policy for both HTTP recovery and POST replay.
        const restrictions = controller.fixture.state.restrictions;
        const beforeRevocation = controller.fixture.auditSink.events.length;
        restrictions.push({
          id: "revoke-first-deployment-configuration-read",
          namespaceId: namespace.id,
          effect: "deny",
          action: "read",
          resourceKind: "configuration",
          resourceId: intent.expectedConfigurationId,
        });
        const deniedRecovery = await send(
          "GET",
          `deploy-first/${intent.key}/${intent.expectedConfigurationId}/${intent.expectedGeneration}`,
        );
        const deniedReplay = await send("POST", "deploy-first", { body: intent });
        for (const denied of [deniedRecovery, deniedReplay]) {
          assert.equal(denied.status, 403, JSON.stringify(denied.body));
          assert.equal(denied.data, undefined);
          assert.equal(JSON.stringify(denied.body).includes(result.data.revisionId), false);
        }
        const denials = controller.fixture.auditSink.events.slice(beforeRevocation);
        assert.equal(denials.length, 2);
        for (const denial of denials) {
          assert.equal(denial.kind, "authorization_denial");
          assert.equal(denial.actor.principalId, controller.fixture.principal.id);
          assert.deepEqual(denial.authorization, {
            principalId: controller.fixture.principal.id,
            action: "read",
            resource: {
              kind: "configuration",
              id: intent.expectedConfigurationId,
              namespaceId: namespace.id,
            },
          });
        }
        assert.deepEqual(secretDriver.calls, calls);
        assert.equal(providerCalls(), enabled ? 1 : 0);
        assert.equal(work().length, 1);
        assert.deepEqual(await deployment.listRevisionMetadata(), revisions);
        restrictions.pop();
        const restored = await send(
          "GET",
          `deploy-first/${intent.key}/${intent.expectedConfigurationId}/${intent.expectedGeneration}`,
        );
        assert.equal(restored.status, 200, JSON.stringify(restored.body));
        assert.deepEqual(restored.data, result.data);

        // Accepting deletion fences fresh admission, but the original committed receipt
        // remains readable until teardown removes the Agent and its revisions.
        const deletion = await request(url, "DELETE", path, { session: app.defaultSession });
        assert.equal(deletion.status, 202, JSON.stringify(deletion.body));
        assert.equal(deletion.data.status, "deleting");
        const deletionWork = controller.fixture.platformState.pendingOperations();
        const deletionAuditCount = controller.fixture.auditSink.events.length;
        const afterDeletion = await send(
          "GET",
          `deploy-first/${intent.key}/${intent.expectedConfigurationId}/${intent.expectedGeneration}`,
        );
        const afterDeletionReplay = await send("POST", "deploy-first", { body: intent });
        assert.equal(afterDeletion.status, 200, JSON.stringify(afterDeletion.body));
        assert.equal(afterDeletionReplay.status, 202, JSON.stringify(afterDeletionReplay.body));
        assert.deepEqual(afterDeletion.data, result.data);
        assert.deepEqual(afterDeletionReplay.data, result.data);
        assert.deepEqual(controller.fixture.platformState.pendingOperations(), deletionWork);
        assert.equal(controller.fixture.auditSink.events.length, deletionAuditCount);
        assert.deepEqual(secretDriver.calls, calls);
        assert.equal(providerCalls(), enabled ? 1 : 0);
      } else {
        assert.equal(result.data.revision, 1);
      }
      t.diagnostic(
        JSON.stringify({
          enabled,
          route,
          revisions: revisions.length,
          work: work().length,
          audit: controller.fixture.auditSink.events.length - before,
          sender: providerCalls(),
          withValue: calls.filter((call) => call.operation === "withValue").length,
          resolve: calls.filter((call) => call.operation === "resolve").length,
        }),
      );
    } finally {
      await app.close();
    }
  }
});

test("first-deployment CLI recovers a lost committed response with the original caller and intent", async (t) => {
  const directory = await temporaryDirectory(t, "oce-first-deployment-cli-");
  const cli = join(directory, "occ");
  const execute = promisify(execFile);
  await execute("go", ["build", "-trimpath", "-o", cli, "./cmd/occ"]);
  for (const reply of ["dropped", "malformed"]) {
    await t.test(`${reply} committed reply`, async (t) => {
      const deployment = await firstDeploymentFixture();
      const { controller, namespace, agent, path, intent, work, secretDriver, providerCalls } =
        deployment;
      const fixture = controller.fixture;
      // Provision an automation identity in the actual native IAM fixture. The HTTP auth
      // service issues its key; the CLI never impersonates the administrator's session.
      const automation = {
        kind: "service_principal",
        id: `sp_${randomUUID()}`,
        namespaceId: namespace.id,
      };
      fixture.state.identities.push(automation);
      fixture.state.bindings.push({
        id: "first-deployment-cli-automation",
        namespaceId: namespace.id,
        subjectKind: "identity",
        subjectId: automation.id,
        roleId: fixture.state.roles[0].id,
      });
      const app = fixture.createApp(undefined, createFastifyApp);
      let relay;
      try {
        const origin = await app.listen({ host: "127.0.0.1", port: 0 });
        const issued = await request(origin, "POST", "/api/auth/service-keys", {
          session: app.defaultSession,
          body: {
            servicePrincipalId: automation.id,
            namespaceId: namespace.id,
            name: "first-deployment-cli",
          },
        });
        assert.equal(issued.status, 201, JSON.stringify(issued.body));
        const keyFile = join(directory, "caller service-key.json");
        await writeFile(keyFile, JSON.stringify({ data: issued.data }), { mode: 0o600 });
        const forwarded = [];
        const relayErrors = [];
        let committed;
        let recovered;
        relay = createServer(async (incoming, outgoing) => {
          try {
            const chunks = [];
            for await (const chunk of incoming) {
              chunks.push(chunk);
            }
            forwarded.push({ method: incoming.method, path: incoming.url });
            const response = await fetchLoopback(`${origin}${incoming.url}`, {
              method: incoming.method,
              headers: {
                host: "console.oce.localhost",
                "x-api-key": incoming.headers["x-api-key"],
                ...(incoming.headers["content-type"] === undefined
                  ? {}
                  : { "content-type": incoming.headers["content-type"] }),
              },
              ...(chunks.length === 0 ? {} : { body: Buffer.concat(chunks) }),
            });
            const body = await response.text();
            if (incoming.method === "POST" && response.status === 202) {
              // OCC really committed. The relay loses or corrupts only its response; the
              // next GET must recover the true receipt from the unchanged application.
              const envelope = JSON.parse(body);
              committed = envelope.data;
              if (reply === "dropped") {
                outgoing.destroy();
              } else {
                outgoing.writeHead(response.status, { "content-type": "application/json" });
                outgoing.end(JSON.stringify({ ...envelope, data: {} }));
              }
              return;
            }
            if (incoming.method === "GET" && response.status === 200) {
              recovered = JSON.parse(body).data;
            }
            outgoing.writeHead(response.status, { "content-type": "application/json" });
            outgoing.end(body);
          } catch (error) {
            relayErrors.push(error);
            outgoing.destroy();
          }
        });
        relay.listen(0, "127.0.0.1");
        await once(relay, "listening");
        const relayOrigin = `http://127.0.0.1:${relay.address().port}`;
        const args = [
          "--url",
          relayOrigin,
          "--service-key-file",
          keyFile,
          "--ca-bundle",
          "",
          "--timeout-seconds",
          "5",
          "--namespace",
          namespace.id,
          "agent",
          "deploy-first",
          agent.id,
          "--key",
          intent.key,
          "--configuration",
          intent.expectedConfigurationId,
          "--generation",
          String(intent.expectedGeneration),
        ];
        let failure;
        try {
          failure = { code: 0, ...(await execute(cli, args)) };
        } catch (error) {
          failure = error;
        }
        assert.deepEqual(relayErrors, []);
        assert.ok(committed, "the uncertain response must follow a real committed admission");
        assert.deepEqual(
          forwarded,
          [{ method: "POST", path: `${path}/deploy-first` }],
          "the CLI must not automatically replay an uncertain mutation",
        );
        const revisions = await deployment.listRevisionMetadata();
        assert.equal(revisions.length, 1);
        assert.equal(revisions[0].id, committed.revisionId);
        assert.equal(work().length, 1);
        const calls = structuredClone(secretDriver.calls);
        const audit = structuredClone(fixture.auditSink.events);
        const deployments = audit.filter(
          (event) => event.action === "openclaw.agents.deploy" && event.outcome === "success",
        );
        assert.equal(deployments.length, 1);
        assert.equal(deployments[0].actor.principalId, automation.id);
        t.diagnostic(
          JSON.stringify({
            reply,
            cliExit: failure.code,
            posts: forwarded.length,
            revisions: revisions.length,
            work: work().length,
            sender: providerCalls(),
          }),
        );
        assert.equal(failure.code, 1, "an unusable receipt must leave the CLI outcome uncertain");
        assert.equal(failure.stdout, "");
        assert.match(failure.stderr, reply === "dropped" ? /EOF/ : /invalid.*receipt/i);
        assert.match(failure.stderr, /same caller/);
        const recoveryCommand = failure.stderr
          .split("\n")
          .map((line) => line.trim())
          .find((line) => line.startsWith("occ "));
        assert.ok(
          recoveryCommand,
          "the uncertain result must print an executable recovery command",
        );
        for (const expected of [
          relayOrigin,
          keyFile,
          `--namespace ${namespace.id}`,
          `agent recover-first-deployment ${agent.id}`,
          `--key ${intent.key}`,
          `--configuration ${intent.expectedConfigurationId}`,
          `--generation ${intent.expectedGeneration}`,
        ]) {
          assert.ok(recoveryCommand.includes(expected), `recovery command must retain ${expected}`);
        }
        // Execute exactly the printed command, including its quoted path with spaces.
        const recovery = await execute("/bin/sh", ["-c", recoveryCommand], {
          env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
        });
        assert.deepEqual(relayErrors, []);
        assert.deepEqual(recovered, committed);
        assert.ok(recovery.stdout.includes(committed.revisionId));
        assert.deepEqual(forwarded, [
          { method: "POST", path: `${path}/deploy-first` },
          {
            method: "GET",
            path: `${path}/deploy-first/${intent.key}/${intent.expectedConfigurationId}/${intent.expectedGeneration}`,
          },
        ]);
        assert.equal(work().length, 1);
        assert.deepEqual(await deployment.listRevisionMetadata(), revisions);
        assert.deepEqual(secretDriver.calls, calls);
        assert.equal(providerCalls(), 0);
        assert.deepEqual(fixture.auditSink.events, audit);
        t.diagnostic(
          JSON.stringify({
            reply,
            recovered: true,
            posts: 1,
            gets: 1,
            revisions: revisions.length,
            work: work().length,
            deploymentAudits: deployments.length,
          }),
        );
      } finally {
        if (relay?.listening) {
          await new Promise((resolve, reject) =>
            relay.close((error) => (error ? reject(error) : resolve())),
          );
        }
        await app.close();
      }
    });
  }
});

test("guarded first deployment supports trusted registered validators and hides unknown failures", async () => {
  for (const fails of [false, true]) {
    const { controller, path, intent, secretDriver, work } = await firstDeploymentFixture();
    let calls = 0;
    const custom = {
      id: "custom-channel",
      implementation: "test",
      capability: "channel",
      enableRouting: () => [],
      async lookupDirectory() {
        assert.fail("Unexpected directory lookup");
      },
      async validateCredentials() {
        calls++;
        if (fails) {
          throw new Error("synthetic-private-validator-detail");
        }
      },
    };
    controller.fixture.controller.registerDriver(custom);
    controller.fixture.controller.selectDriver("channel", custom.id);
    const result = await controller.request("POST", `${path}/deploy-first`, { body: intent });
    assert.equal(result.status, fails ? 500 : 202, JSON.stringify(result.body));
    assert.equal(calls, 1);
    assert.equal(work().length, fails ? 0 : 1);
    if (fails) {
      assert.equal(secretDriver.calls.length, 0);
      assert.equal(
        JSON.stringify(result.body).includes("synthetic-private-validator-detail"),
        false,
      );
      assert.equal(
        JSON.stringify(controller.fixture.auditSink.events).includes(
          "synthetic-private-validator-detail",
        ),
        false,
      );
    }
  }
});

test("guarded first deployment rechecks configuration after outside-transaction validation", async () => {
  for (const change of [
    "binding",
    "generation",
    "configuration",
    "configuration-driver",
    "channel",
    "late-channel",
    "late-configuration",
  ]) {
    const { controller, namespace, agent, path, intent, secretDriver, work } =
      await firstDeploymentFixture();
    const replacement = await createConfiguration(controller, namespace.id);
    const state = controller.fixture.platformState;
    const transact = state.transact.bind(state);
    const { promise: validated, resolve: reached } = Promise.withResolvers();
    const { promise: released, resolve: release } = Promise.withResolvers();
    let pause = true;
    state.transact = async (operation) => {
      // The real Configuration and Slack validators have returned; admission has not locked.
      if (pause) {
        pause = false;
        reached();
        await released;
      }
      return transact(operation);
    };
    const admission = controller.request("POST", `${path}/deploy-first`, { body: intent });
    await validated;
    if (change === "binding" || change === "generation") {
      const updated =
        change === "binding"
          ? await controller.request("PATCH", path, { body: { configurationId: replacement.id } })
          : await controller.request(
              "PATCH",
              `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
              { body: { values: { temperature: "1" } } },
            );
      assert.equal(updated.status, 200, JSON.stringify(updated.body));
    } else if (change === "late-channel" || change === "late-configuration") {
      const driver =
        change === "late-channel"
          ? new SlackChannelDriver(async () => assert.fail("Unexpected provider"))
          : createTestConfigurationDriver({ id: "late-configuration" });
      if (change === "late-channel") {
        driver.id = "late-channel";
      }
      controller.fixture.controller.registerDriver(driver);
      // The second Configuration validation runs inside admission, after its
      // initial Driver checks. A database lock cannot prevent this selection change.
      controller.fixture.configurationDriver.validate = async () => {
        controller.fixture.controller.selectDriver(driver.capability, driver.id);
      };
    } else if (change === "configuration") {
      const driver = controller.fixture.configurationDriver;
      const saved = driver.stored({ namespaceId: namespace.id, id: agent.configurationId });
      await driver.update({ ...saved, values: { temperature: "1" } });
    } else if (change === "configuration-driver") {
      const driver = createTestConfigurationDriver({ id: "replacement-configuration" });
      controller.fixture.controller.registerDriver(driver);
      controller.fixture.controller.selectDriver("configuration", driver.id);
    } else if (change === "channel") {
      const driver = new SlackChannelDriver(async () => assert.fail("Unexpected provider"));
      driver.id = "replacement-channel";
      controller.fixture.controller.registerDriver(driver);
      controller.fixture.controller.selectDriver("channel", driver.id);
    }
    release();
    const result = await admission;
    assert.equal(result.status, 409, JSON.stringify(result.body));
    if (["binding", "generation", "configuration"].includes(change)) {
      assert.match(result.body.error.message, /Recover the original first-deployment receipt/);
      assert.doesNotMatch(result.body.error.message, /ordinary deploy/);
    }
    assert.equal(secretDriver.calls.length, change.startsWith("late-") ? 1 : 0);
    if (change.startsWith("late-")) {
      assert.equal(secretDriver.calls[0].operation, "resolve");
    }
    assert.equal(work().length, 0);
  }
});

test("guarded first deployment enforces exact Secret operate before backend, provider, and admission", async (t) => {
  for (const stage of [
    "before",
    "before-backend",
    "after-backend",
    "before-admission",
    "cross-namespace",
  ]) {
    const { controller, namespace, agent, bot, path, intent, work, secretDriver, providerCalls } =
      await slackFirstDeploymentFixture();
    const fixture = controller.fixture;
    const deny = () =>
      fixture.state.restrictions.push({
        id: `deny-secret-${stage}`,
        namespaceId: namespace.id,
        resourceKind: "secret",
        resourceId: bot.id,
        action: "operate",
        effect: "deny",
      });
    if (stage === "before") {
      deny();
    }
    if (stage === "before-backend") {
      const read = fixture.platformState.read.bind(fixture.platformState);
      fixture.platformState.read = async (operation) => {
        const result = await read(operation);
        if (result?.id === bot.id) {
          deny();
        }
        return result;
      };
    }
    if (stage === "after-backend") {
      const withValue = secretDriver.withValue.bind(secretDriver);
      secretDriver.withValue = (secret, use) =>
        withValue(secret, (value) => {
          deny();
          return use(value);
        });
    }
    if (stage === "before-admission") {
      const transact = fixture.platformState.transact.bind(fixture.platformState);
      fixture.platformState.transact = (operation) => {
        deny();
        return transact(operation);
      };
    }
    if (stage === "cross-namespace") {
      const read = fixture.platformState.read.bind(fixture.platformState);
      fixture.platformState.read = (operation) =>
        read((unit) =>
          operation({
            ...unit,
            configurations: {
              ...unit.configurations,
              findConfiguration: async (...args) => {
                const saved = await unit.configurations.findConfiguration(...args);
                return {
                  ...saved,
                  secretBindings: {
                    SLACK_BOT_TOKEN: {
                      source: { ...bot.ref, namespaceId: `ns_${randomUUID()}` },
                    },
                  },
                };
              },
            },
          }),
        );
    }
    const app = fixture.createApp(undefined, createFastifyApp);
    let result;
    try {
      const url = await app.listen({ host: "127.0.0.1", port: 0 });
      result = await request(url, "POST", `${path}/deploy-first`, {
        session: app.defaultSession,
        body: intent,
      });
    } finally {
      await app.close();
    }
    assert.equal(
      result.status,
      stage === "cross-namespace" ? 404 : 403,
      JSON.stringify(result.body),
    );
    assert.equal(work().length, 0);
    assert.deepEqual(
      await fixture.platformState.read((unit) =>
        unit.revisions.listRevisionMetadata(namespace.id, agent.id),
      ),
      [],
    );
    assert.equal(providerCalls(), stage === "before-admission" ? 1 : 0);
    const reads = secretDriver.calls.filter((call) => call.operation === "withValue").length;
    assert.equal(reads, ["after-backend", "before-admission"].includes(stage) ? 1 : 0);
    t.diagnostic(
      JSON.stringify({ stage, sender: providerCalls(), withValue: reads, work: work().length }),
    );
  }
});

test("guarded first deployment rechecks Agent and Configuration authority before credential effects", async (t) => {
  for (const authority of ["deploy", "read"]) {
    for (const stage of ["before-backend", "after-backend"]) {
      await t.test(`${authority} revoked ${stage}`, async (t) => {
        const {
          controller,
          namespace,
          agent,
          bot,
          path,
          intent,
          work,
          secretDriver,
          providerCalls,
        } = await slackFirstDeploymentFixture();
        const fixture = controller.fixture;
        const revoke = () =>
          fixture.state.restrictions.push({
            id: `revoke-${authority}-${stage}`,
            namespaceId: namespace.id,
            resourceKind: authority === "deploy" ? "agent" : "configuration",
            resourceId: authority === "deploy" ? agent.id : intent.expectedConfigurationId,
            action: authority,
            effect: "deny",
          });
        if (stage === "before-backend") {
          // The Secret metadata lookup yields to a concurrent policy change. Native IAM
          // still makes every decision; the wrapper only schedules the restriction.
          const read = fixture.platformState.read.bind(fixture.platformState);
          fixture.platformState.read = async (operation) => {
            const result = await read(operation);
            if (result?.id === bot.id) {
              revoke();
            }
            return result;
          };
        } else {
          // Model revocation while the backend was reading, before OCC receives its value.
          const withValue = secretDriver.withValue.bind(secretDriver);
          secretDriver.withValue = (secret, use) =>
            withValue(secret, (value) => {
              revoke();
              return use(value);
            });
        }
        const app = fixture.createApp(undefined, createFastifyApp);
        try {
          const url = await app.listen({ host: "127.0.0.1", port: 0 });
          const result = await request(url, "POST", `${path}/deploy-first`, {
            session: app.defaultSession,
            body: intent,
          });
          const revisions = await fixture.platformState.read((unit) =>
            unit.revisions.listRevisionMetadata(namespace.id, agent.id),
          );
          const reads = secretDriver.calls.filter((call) => call.operation === "withValue").length;
          t.diagnostic(
            JSON.stringify({
              authority,
              stage,
              status: result.status,
              sender: providerCalls(),
              withValue: reads,
              revisions: revisions.length,
              work: work().length,
            }),
          );
          assert.equal(result.status, 403, JSON.stringify(result.body));
          assert.equal(revisions.length, 0);
          assert.equal(work().length, 0);
          assert.equal(
            providerCalls(),
            0,
            "revoked deployment authority must prevent credential dispatch",
          );
          assert.equal(
            reads,
            stage === "after-backend" ? 1 : 0,
            "revocation before backend access must prevent the Secret read",
          );
          assert.equal(secretDriver.calls.filter((call) => call.operation === "resolve").length, 0);
        } finally {
          await app.close();
        }
      });
    }
  }
});

test("guarded first deployment refuses deleting Agents before validation", async (t) => {
  for (const stage of ["before-valid-token", "before-wrong-role-token", "after-validation-error"]) {
    await t.test(stage, async (t) => {
      const deployment = await slackFirstDeploymentFixture();
      const { controller, namespace, bot, path, intent, work, secretDriver, providerCalls } =
        deployment;
      const fixture = controller.fixture;
      const app = fixture.createApp(undefined, createFastifyApp);
      try {
        const url = await app.listen({ host: "127.0.0.1", port: 0 });
        if (stage !== "before-valid-token") {
          // Store a real wrong-role value through the supported Secret mutation route.
          const changed = await request(
            url,
            "PATCH",
            `/namespaces/${namespace.id}/secrets/${bot.id}`,
            {
              session: app.defaultSession,
              body: { value: "xoxp-synthetic-user" },
            },
          );
          assert.equal(changed.status, 200, JSON.stringify(changed.body));
        }
        secretDriver.calls.length = 0;
        let deletionWork;
        const remove = async () => {
          const deleted = await request(url, "DELETE", path, { session: app.defaultSession });
          assert.equal(deleted.status, 202, JSON.stringify(deleted.body));
          assert.equal(deleted.data.status, "deleting");
          assert.equal(deleted.data.desiredRuntimeState, "stopped");
          deletionWork = fixture.platformState.pendingOperations();
        };
        if (stage === "after-validation-error") {
          const withValue = secretDriver.withValue.bind(secretDriver);
          secretDriver.withValue = async (secret, use) => {
            // Let the actual Slack validator reject the stored token, then accept deletion
            // before OCC carries the saved validation error into locked admission.
            const outcome = await withValue(secret, use);
            await remove();
            return outcome;
          };
        } else {
          await remove();
        }
        const result = await request(url, "POST", `${path}/deploy-first`, {
          session: app.defaultSession,
          body: intent,
        });
        const revisions = await deployment.listRevisionMetadata();
        const reads = secretDriver.calls.filter((call) => call.operation === "withValue").length;
        t.diagnostic(
          JSON.stringify({
            stage,
            status: result.status,
            code: result.body.error?.code,
            sender: providerCalls(),
            withValue: reads,
            revisions: revisions.length,
            work: work().length,
          }),
        );
        assertApiError(result, 409, "AGENT_DELETING");
        assert.equal(revisions.length, 0);
        assert.equal(work().length, 0);
        assert.deepEqual(fixture.platformState.pendingOperations(), deletionWork);
        assert.equal(providerCalls(), 0);
        assert.equal(reads, stage === "after-validation-error" ? 1 : 0);
        assert.equal(secretDriver.calls.filter((call) => call.operation === "resolve").length, 0);
      } finally {
        await app.close();
      }
    });
  }
});

test("matching first deployments recover between the initial snapshot and lock despite fresh failures", async () => {
  for (const failure of ["validator", "compute", "deploy", "read", "actor"]) {
    const { controller, namespace, agent, path, intent, work, secretDriver } =
      await firstDeploymentFixture();
    const fixture = controller.fixture;
    const state = fixture.platformState;
    const read = state.read.bind(state);
    const { promise: missed, resolve: sawMiss } = Promise.withResolvers();
    const { promise: resume, resolve: release } = Promise.withResolvers();
    let pause = true;
    let lookups = 0;
    // Count receipt lookups at the storage boundary, including the locked contender.
    const observe = (unit) => ({
      ...unit,
      revisions: {
        ...unit.revisions,
        findFirstDeploymentReceipt: async (...args) => {
          lookups++;
          return unit.revisions.findFirstDeploymentReceipt(...args);
        },
        findRevision: async () => assert.fail("Receipt recovery decoded a full revision"),
      },
    });
    state.read = async (operation) => {
      const result = await read((unit) => operation(observe(unit)));
      if (result?.metadata && pause) {
        pause = false;
        sawMiss();
        await resume;
      }
      return result;
    };
    const transact = state.transact.bind(state);
    state.transact = (operation) => transact((unit) => operation(observe(unit)));
    let session = fixture.session;
    if (failure === "actor") {
      const other = await fixture.createAuthPrincipal("other-first-deployer");
      fixture.state.identities.push(other.principal);
      fixture.state.bindings.push({
        ...fixture.state.bindings[0],
        id: "other-deployer",
        subjectId: other.principal.id,
      });
      session = other.session;
    }
    const late = controller.request("POST", `${path}/deploy-first`, { body: intent, session });
    await missed;
    const winner = await controller.request("POST", `${path}/deploy-first`, { body: intent });
    assert.equal(winner.status, 202, JSON.stringify(winner.body));
    assert.equal(lookups, 3); // contender miss; winner miss and locked lookup
    if (failure === "validator") {
      fixture.configurationDriver.validate = async () => {
        throw new Error("synthetic-private-error");
      };
    }
    if (failure === "compute") {
      fixture.computeDriver.implementation = "changed-after-commit";
    }
    if (["validator", "compute"].includes(failure)) {
      fixture.state.roles[0].permissions = [
        { action: "deploy", resourceKind: "agent" },
        { action: "read", resourceKind: "configuration" },
      ];
    }
    if (failure === "deploy" || failure === "read") {
      fixture.state.restrictions.push({
        id: `revoke-${failure}`,
        namespaceId: namespace.id,
        effect: "deny",
        action: failure,
        resourceKind: failure === "deploy" ? "agent" : "configuration",
        resourceId: failure === "deploy" ? agent.id : intent.expectedConfigurationId,
      });
    }
    release();
    const recovered = await late;
    const denied = failure === "deploy" || failure === "read";
    assert.equal(
      recovered.status,
      denied ? 403 : failure === "actor" ? 409 : 202,
      JSON.stringify(recovered.body),
    );
    if (!denied && failure !== "actor") {
      assert.deepEqual(recovered.data, winner.data);
    }
    assert.equal(lookups, denied ? 3 : 4);
    assert.equal(work().length, 1);
    assert.equal(secretDriver.calls.filter((call) => call.operation === "resolve").length, 1);
  }
});

test("first deployment recovery generation has an exact decimal wire bound over real HTTP", async () => {
  const { controller, path, intent, secretDriver, work } = await firstDeploymentFixture();
  const app = controller.fixture.createApp(undefined, createFastifyApp);
  try {
    const url = await app.listen({ host: "127.0.0.1", port: 0 });
    const operation =
      app.swagger().paths[
        "/namespaces/{namespaceId}/agents/{agentId}/deploy-first/{key}/{expectedConfigurationId}/{expectedGeneration}"
      ].get;
    assert.deepEqual(operation.responses["200"].headers["Cache-Control"].schema, {
      type: "string",
      const: "no-store",
    });
    const schema = operation.parameters.find(
      (parameter) => parameter.name === "expectedGeneration",
    ).schema;
    const pattern = new RegExp(schema.pattern);
    for (const generation of ["1", "9007199254740991", "9007199254740992", "0", "01", "1\n"]) {
      const valid = generation === "1" || generation === "9007199254740991";
      assert.equal(pattern.test(generation), valid, generation);
      const result = await request(
        url,
        "GET",
        `${path}/deploy-first/${intent.key}/${intent.expectedConfigurationId}/${encodeURIComponent(generation)}`,
        { session: app.defaultSession },
      );
      assert.equal(result.status, valid ? 200 : 400, generation);
      if (valid) {
        assert.equal(result.data, null);
      }
      assert.equal(result.headers.get("cache-control"), "no-store");
    }
    // Independent integer comparison checks every decimal prefix boundary of the maximum.
    const maximum = "9007199254740991";
    for (let index = 0; index < maximum.length; index++) {
      for (let digit = 0; digit <= 9; digit++) {
        const candidate = maximum.slice(0, index) + digit + "9".repeat(maximum.length - index - 1);
        assert.equal(
          pattern.test(candidate),
          candidate[0] !== "0" && BigInt(candidate) <= 9007199254740991n,
          candidate,
        );
      }
    }
    assert.equal(secretDriver.calls.length, 0);
    assert.equal(work().length, 0);
  } finally {
    await app.close();
  }
});

test("guarded deployment rejects dot keys and unrecognized intent fields without writes", async () => {
  const { controller, path, intent, work, secretDriver } = await firstDeploymentFixture();
  for (const body of [
    { ...intent, key: "." },
    { ...intent, key: ".." },
    { ...intent, actorId: "other" },
  ]) {
    const result = await controller.request("POST", `${path}/deploy-first`, { body });
    assertApiError(result, 400, "INVALID_REQUEST");
  }
  assert.equal(work().length, 0);
  assert.equal(secretDriver.calls.length, 0);
});

test("stock deploy baseline: a lost reply and re-POST admit independent revisions", async () => {
  const { controller, fixture, namespace } = await readyNamespaceFixture("deploy-retry-baseline", {
    recordOperations: true,
  });
  const agent = await createAgent(controller, namespace.id, "retry-baseline");
  await bindHarnessKey(fixture, namespace.id, agent);
  const agentPath = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const revisions = () =>
    fixture.platformState.read((state) => state.revisions.listRevisions(namespace.id, agent.id));
  const work = () =>
    fixture.platformState
      .pendingOperations()
      .filter(
        (operation) => operation.kind === "agent_revision" && operation.action === "reconcile",
      );

  assert.equal((await revisions()).length, 0);
  // Discard the response. Inspect the owning store as the test observer, not as the client.
  await controller.request("POST", `${agentPath}/deploy`);
  const [first] = await revisions();
  assert.ok(first, "the first request must commit before its reply is discarded");
  assert.equal(first.revision, 1);
  assert.equal(work().length, 1);
  assert.equal(work()[0].resourceId, first.id);

  const retry = await controller.request("POST", `${agentPath}/deploy`);
  assert.equal(retry.status, 202, JSON.stringify(retry.body));
  assert.equal(retry.data.revision, 2);
  assert.notEqual(retry.data.id, first.id);
  assert.deepEqual((await revisions())[0], first);
  assert.deepEqual(
    new Set(work().map((operation) => operation.resourceId)),
    new Set([first.id, retry.data.id]),
  );
  assert.equal(work().length, 2);
});

test("ordinary deploy rejects request bodies and admits the current saved generation", async () => {
  const { controller, fixture, namespace } = await readyNamespaceFixture(
    "deploy-generation-baseline",
    { recordOperations: true },
  );
  const agent = await createAgent(controller, namespace.id, "generation-baseline");
  await bindHarnessKey(fixture, namespace.id, agent);
  const agentPath = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const configurationPath = `/namespaces/${namespace.id}/configurations/${agent.configurationId}`;
  const reviewed = await controller.request("GET", configurationPath);
  assert.equal(reviewed.status, 200);
  const updated = await controller.request("PATCH", configurationPath, {
    body: { values: { temperature: "1" }, expectedGeneration: reviewed.data.generation },
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.data.generation, reviewed.data.generation + 1);

  const rejected = await controller.request("POST", `${agentPath}/deploy`, {
    body: {
      expectedConfigurationId: reviewed.data.id,
      expectedGeneration: reviewed.data.generation,
    },
  });
  assertApiError(rejected, 400, "INVALID_REQUEST");
  assert.equal(
    (
      await fixture.platformState.read((state) =>
        state.revisions.listRevisions(namespace.id, agent.id),
      )
    ).length,
    0,
  );
  assert.equal(
    fixture.platformState
      .pendingOperations()
      .filter((operation) => operation.kind === "agent_revision").length,
    0,
  );

  const deployed = await controller.request("POST", `${agentPath}/deploy`);
  assert.equal(deployed.status, 202, JSON.stringify(deployed.body));
  assert.equal(deployed.data.configurationId, reviewed.data.id);
  assert.equal(deployed.data.configurationGeneration, updated.data.generation);
  assert.equal(deployed.data.revision, 1);
  assert.equal(deployed.data.configuration.temperature, "1");
});

test("OCC Fastify serves singleton, Namespace, Configuration, and Agent resource routes", () =>
  runResourceRoutes({
    configuredController,
    bootstrap,
    defaultNamespace,
    createNamespace,
    createAgent,
    missingRevisionId,
    missingAgentId,
  }));

test("Agent drafts and revisions support up to 64 distinct credential sources and expose only their IDs", async () => {
  const controller = await configuredController({
    computeDriver: createReadyComputeDriver("compute-credential-sources", {
      validateHarnessAuth() {},
      async stopRevision() {},
      // Compute owns runtime placement; the gateway sees the paired Sandbox's Namespace.
      async resolveSandboxNamespace(namespace) {
        return { ...namespace, name: `placed-${namespace.id.slice(-12)}` };
      },
    }),
  });
  const { fixture } = controller;
  await bootstrap(controller);
  const namespace = await createReadyNamespace(controller, "credential-source-binding");
  const gateway = {
    id: "credential-gateway-api",
    capability: "credential_gateway",
    implementation: "test-recording-gateway",
    validateSourceConfig() {},
    async listSourceTypes() {
      return [
        {
          type: "registry",
          config: [{ name: "host", required: true }],
          secrets: [],
          rotation: "none",
        },
      ];
    },
    async registerSource() {
      return { state: "ready" };
    },
    async updateSource() {
      return { state: "ready" };
    },
    async rotateSource() {
      return { state: "ready" };
    },
    async sourceStatus() {
      return { state: "ready" };
    },
    async removeSource() {},
    async attachForRevision(context) {
      return context.sources.map((entry) => ({ sourceId: entry.id, ref: entry.id }));
    },
    async attachmentStatus(context) {
      return context.sources.map((entry) => ({ sourceId: entry.id, state: "ready" }));
    },
    async withdraw() {
      return { state: "revoked" };
    },
  };
  const sandbox = {
    id: "sandbox-api",
    capability: "sandbox",
    implementation: "test-sandbox",
    supportsHarnessExecutionMode: DEDICATED_OPENCLAW_SUPPORT,
    facets: ["networking", "filesystem", "process"],
    async cleanup() {},
  };
  for (const driver of [gateway, sandbox]) {
    fixture.controller.registerDriver(driver);
    fixture.controller.selectDriver(driver.capability, driver.id);
  }
  const sources = [];
  for (let i = 0; i < 65; i++) {
    const registered = await controller.request(
      "POST",
      `/namespaces/${namespace.id}/credential-sources`,
      {
        body: {
          name: `registry-${i}`,
          type: "registry",
          config: { host: `registry-${i}.example.com` },
        },
      },
    );
    assert.equal(registered.status, 201, JSON.stringify(registered.body));
    sources.push({ sourceId: registered.data.id });
  }
  const credentialSources = sources.slice(0, 64);
  const configuration = await createConfiguration(controller, namespace.id, {
    agents: {
      defaults: {
        model: "codex/gpt-5.6-sol",
        models: { "codex/gpt-5.6-sol": { agentRuntime: { id: "codex" } } },
      },
    },
  });
  const created = await controller.request("POST", `/namespaces/${namespace.id}/agents`, {
    body: {
      name: "credential-source-agent",
      configurationId: configuration.id,
      executionMode: "dedicated",
      harnessAuth: { method: "runtime" },
      credentialSources,
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual(created.data.credentialSources, credentialSources);
  // An object array declared uniqueItems: listing one source twice names the rule.
  const repeated = await controller.request("POST", `/namespaces/${namespace.id}/agents`, {
    body: {
      name: "credential-source-agent-repeated",
      configurationId: configuration.id,
      executionMode: "dedicated",
      harnessAuth: { method: "runtime" },
      credentialSources: [sources[0], sources[0]],
    },
  });
  assert.equal(repeated.status, 400, JSON.stringify(repeated.body));
  assert.equal(
    repeated.body.error.message,
    "The request does not match the operation contract: body /credentialSources has an unsupported value (expected no duplicate items).",
  );
  assert.deepEqual(repeated.body.error.details, [
    { path: "/credentialSources", code: "INVALID_VALUE" },
  ]);
  const agentPath = `/namespaces/${namespace.id}/agents/${created.data.id}`;
  const overflow = await controller.request("PATCH", agentPath, {
    body: { configurationId: configuration.id, credentialSources: sources },
  });
  assertApiError(overflow, 400, "INVALID_REQUEST");
  assert.match(overflow.body.error.message, /credentialSources.*at most 64 items/);
  assert.deepEqual(
    (await controller.request("GET", agentPath)).data.credentialSources,
    credentialSources,
  );

  const roleId = `credential-source-operate-${created.data.id}`;
  fixture.state.roles.push({
    id: roleId,
    namespaceId: namespace.id,
    permissions: [{ action: "operate", resourceKind: "credential_source" }],
  });
  for (const { sourceId } of credentialSources) {
    fixture.state.bindings.push({
      id: `${roleId}-${sourceId}`,
      namespaceId: namespace.id,
      subjectKind: "identity",
      subjectId: created.data.servicePrincipalId,
      roleId,
      resourceKind: "credential_source",
      resourceId: sourceId,
    });
  }
  fixture.state.identities.push({
    kind: "service_principal",
    id: created.data.servicePrincipalId,
    namespaceId: namespace.id,
    agentId: created.data.id,
  });
  const deployed = await controller.request("POST", `${agentPath}/deploy`);
  assert.equal(deployed.status, 202, JSON.stringify(deployed.body));
  // The gateway and type frozen at admission are private admission metadata.
  assert.deepEqual(deployed.data.credentialSources, credentialSources);
  const revision = await controller.request("GET", `${agentPath}/revisions/${deployed.data.id}`);
  assert.equal(revision.status, 200, JSON.stringify(revision.body));
  assert.deepEqual(revision.data.credentialSources, credentialSources);
});

test("refresh source PATCH and rotate refuse a stale refresh token and audit a failed gateway effect", async () => {
  const controller = await configuredController({
    computeDriver: createReadyComputeDriver("compute-credential-refresh", {
      async resolveSandboxNamespace(namespace) {
        return { ...namespace, name: `placed-${namespace.id.slice(-12)}` };
      },
    }),
  });
  const { fixture } = controller;
  await bootstrap(controller);
  const namespace = await createReadyNamespace(controller, "credential-source-refresh-audit");
  const gateway = {
    id: "credential-gateway-refresh-api",
    capability: "credential_gateway",
    implementation: "test-recording-gateway",
    validateSourceConfig() {},
    async listSourceTypes() {
      return [
        {
          type: "oauth-user",
          config: [{ name: "client_id", required: true }],
          secrets: [{ name: "refresh_token", required: true, issuerRotated: true }],
          rotation: "refresh",
        },
      ];
    },
    async registerSource() {
      return { state: "ready" };
    },
    async updateSource() {
      throw new Error("not exercised");
    },
    async sourceStatus() {
      return { state: "ready" };
    },
    async removeSource() {},
    async attachForRevision() {
      throw new Error("not exercised");
    },
    async attachmentStatus() {
      throw new Error("not exercised");
    },
    async withdraw() {
      throw new Error("not exercised");
    },
  };
  let mint = { state: "ready" };
  const refresh = {
    id: "credential-refresh-api",
    capability: "credential_refresh",
    implementation: "test-recording-refresh",
    async configureRefresh() {
      return { state: "pending" };
    },
    async rotate() {
      return mint;
    },
    async refreshStatus() {
      return mint;
    },
    async removeRefresh() {},
  };
  const sandbox = {
    id: "sandbox-refresh-api",
    capability: "sandbox",
    implementation: "test-sandbox",
    supportsHarnessExecutionMode: DEDICATED_OPENCLAW_SUPPORT,
    facets: ["networking", "filesystem", "process"],
    async cleanup() {},
  };
  for (const driver of [gateway, refresh, sandbox]) {
    fixture.controller.registerDriver(driver);
    fixture.controller.selectDriver(driver.capability, driver.id);
  }
  const secret = async () => {
    const created = await controller.request("POST", `/namespaces/${namespace.id}/secrets`, {
      body: { name: `refresh-token-${randomUUID()}`, value: "synthetic-refresh-token" },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    return created.data.ref;
  };
  const source = await controller.request(
    "POST",
    `/namespaces/${namespace.id}/credential-sources`,
    {
      body: {
        name: "oauth-user",
        type: "oauth-user",
        config: { client_id: "occ-tools" },
        secrets: { refresh_token: await secret() },
      },
    },
  );
  assert.equal(source.status, 201, JSON.stringify(source.body));
  const sourcePath = `/namespaces/${namespace.id}/credential-sources/${source.data.id}`;

  // Re-sending the recorded refresh token is refused before any gateway effect.
  const stale = await controller.request("PATCH", sourcePath, { body: {} });
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  assert.match(stale.body.error.message, /newer refresh_token.*new sign-in/);

  mint = { state: "failed", failureCode: "oauth_invalid_grant", recoveryAction: "reauthorize" };
  const rotated = await controller.request("POST", `${sourcePath}/rotate`);
  assert.equal(rotated.status, 503, JSON.stringify(rotated.body));
  const updated = await controller.request("PATCH", sourcePath, {
    body: { secrets: { refresh_token: await secret() } },
  });
  assert.equal(updated.status, 503, JSON.stringify(updated.body));

  // Both failures changed the gateway, so each is audited; the refusal changed nothing.
  const events = fixture.auditSink.events.filter(
    (event) => event.kind === "mutation" && event.resource.id === source.data.id,
  );
  assert.deepEqual(
    events.map(({ action, outcome, reasonCode }) => [action, outcome, reasonCode]),
    [
      ["openclaw.credential_sources.create", "success", undefined],
      ["openclaw.credential_sources.rotate", "failure", "CREDENTIAL_REFRESH_ROTATION_FAILED"],
      ["openclaw.credential_sources.update", "failure", "CREDENTIAL_REFRESH_UPDATE_FAILED"],
    ],
  );
  for (const event of events.slice(1)) {
    assert.equal(event.actorId, fixture.principal.id);
    assert.match(event.requestId, identifier("req"));
  }
});

test("Agent deletion closes every synchronous mutation boundary before teardown", async () => {
  const controller = await configuredController({ recordOperations: true });
  await bootstrap(controller);
  const namespace = await createNamespace(controller, "deletion-race");
  const agent = await createAgent(controller, namespace.id, "deletion-race-agent");
  await controller.fixture.controller.handleNamespaceLifecycle(
    controller.fixture.principal.id,
    namespace.id,
    "ready",
  );
  await bindHarnessKey(controller.fixture, namespace.id, agent);
  const deployed = await controller.request(
    "POST",
    `/namespaces/${namespace.id}/agents/${agent.id}/deploy`,
  );
  assert.equal(deployed.status, 202);

  const agentPath = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const deletion = await controller.request("DELETE", agentPath);
  assert.equal(deletion.status, 202);
  assert.equal(deletion.data.status, "deleting");
  assert.equal(deletion.data.desiredRuntimeState, "stopped");

  // Repeated deletion must reuse the existing teardown through the memory work lookup.
  const repeatedDeletion = await controller.request("DELETE", agentPath);
  assert.equal(repeatedDeletion.status, 202);
  assert.equal(repeatedDeletion.data.status, "deleting");
  await controller.fixture.platformState.read(async (view) => {
    const key = `agent:${agent.id}:reconcile:deleted`;
    const work = await view.operations.findWork(key);
    assert.ok(work);
    assert.equal(work.idempotencyKey, key);
    assert.equal(work.agentId, agent.id);
    assert.equal(work.namespaceId, namespace.id);
    assert.equal(work.actorId, controller.fixture.principal.id);
    assert.equal(work.agentTarget, "deleted");
    assert.equal(await view.operations.findWork(`${key}:undefined`), undefined);
    const teardowns = (await view.operations.list()).filter(
      (operation) =>
        operation.kind === "agent" &&
        operation.resourceId === agent.id &&
        operation.namespaceId === namespace.id &&
        operation.action === "reconcile" &&
        operation.target === "deleted",
    );
    assert.equal(teardowns.length, 1);
  });

  for (const mutation of [
    () =>
      controller.request("PATCH", `/namespaces/${namespace.id}/agents/${agent.id}`, {
        body: { configurationId: agent.configurationId },
      }),
    () => controller.request("POST", `/namespaces/${namespace.id}/agents/${agent.id}/deploy`),
  ]) {
    const rejected = await mutation();
    assertApiError(rejected, 409, "AGENT_DELETING");
    assert.equal(rejected.body.error.message, AGENT_DELETING);
  }

  // Credential provisioning and workspace routing are intentionally absent
  // from this API fixture, so prove their admission barriers directly before
  // either unavailable dependency is consulted.
  await assert.rejects(
    controller.fixture.controller.provisionAgentRuntimeCredentials(
      controller.fixture.principal.id,
      namespace.id,
      agent.id,
      {},
    ),
    AgentDeletingError,
  );
  await assert.rejects(
    controller.fixture.controller.getOperableActiveAgentRevision(
      controller.fixture.principal.id,
      namespace.id,
      agent.id,
    ),
    AgentDeletingError,
  );

  const revisions = await controller.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${agent.id}/revisions`,
  );
  assert.equal(revisions.data.length, 1, "no mutation may admit work after deletion starts");
});

test("Agent Backend API preserves nullable drafts and immutable revision associations", async () => {
  await runBackendAssociations(configuredController);
});

test("Installation Backend IDs and Agent backendId share the API schema's character rule", async () => {
  await runBackendIdCharacterRule(configuredController);
});

test("Names follow the Backend ID text rule, so C1 controls are refused", async () => {
  const controller = await configuredController();
  await bootstrap(controller);
  // 200 code points (400 UTF-16 units) with an interior NBSP is a valid Name.
  const namespace = await createNamespace(controller, `name\u00a0${"😀".repeat(195)}`);
  const configuration = await createConfiguration(controller, namespace.id);

  // C0, DEL and C1 controls (PostgreSQL's [[:cntrl:]] name checks refuse all three),
  // line and paragraph separators, edge whitespace, and 201 code points.
  for (const name of [
    "name\u0000x",
    "name\u007fx",
    "name\u0080x",
    "name\u0085x",
    "name\u009fx",
    "name\u2028x",
    "name\u2029x",
    " name",
    "name\u00a0",
    "😀".repeat(201),
  ]) {
    const refusedNamespace = await controller.request("POST", "/namespaces", { body: { name } });
    assertApiError(refusedNamespace, 400, "INVALID_REQUEST");
    const refusedAgent = await controller.request("POST", `/namespaces/${namespace.id}/agents`, {
      body: { name, configurationId: configuration.id },
    });
    assertApiError(refusedAgent, 400, "INVALID_REQUEST");
  }
});

test("Installation API exposes Agent provisioning capabilities without configured Backends", async () => {
  let ensureNamespaceCalls;
  let deleteNamespaceCalls;
  const computeDriver = createReadyComputeDriver("compute-provisioning-capable", {
    agentProvisioning: { executionModes: ["dedicated"] },
    async ensureNamespace(namespace) {
      ensureNamespaceCalls.push(namespace.id);
      return { namespaceId: namespace.id, namespaceReady: true };
    },
    async deleteNamespace(namespace) {
      deleteNamespaceCalls.push(namespace.id);
      return { namespaceId: namespace.id, namespaceDeleted: true };
    },
    validateHarnessAuth() {},
    validateAgentProvisioning() {},
    async stopRevision() {},
  });
  const controller = await configuredController({
    backends: [],
    backendSummaries: [],
    computeDriver,
  });
  const { computeCalls } = controller.fixture;
  ensureNamespaceCalls = computeCalls.ensureNamespace;
  deleteNamespaceCalls = computeCalls.deleteNamespace;
  const bootstrapped = await bootstrap(controller);
  assert.deepEqual(bootstrapped.capabilities, {
    agentProvisioning: { executionModes: ["dedicated"] },
  });

  const installation = await controller.request("GET", "/installation");
  assert.equal(installation.status, 200);
  // Without a provisioning Sandbox Driver, dedicated OpenClaw cannot be admitted (finding 1608);
  // without any Sandbox Driver, Embedded OpenClaw can (#2670). Bootstrap reports neither.
  assert.deepEqual(installation.data.capabilities, {
    ...bootstrapped.capabilities,
    openclaw: { executionModes: ["embedded"] },
  });

  const backends = await controller.request("GET", "/backends");
  assert.equal(backends.status, 200);
  assert.deepEqual(backends.data, []);
});

test("Agent create and update replace policy-only plugin maps and revisions freeze the requested snapshot", async () => {
  const configurationDriver = createTestConfigurationDriver();
  const readConfiguration = configurationDriver.read.bind(configurationDriver);
  let configurationReads = 0;
  configurationDriver.read = (reference) => {
    configurationReads += 1;
    return readConfiguration(reference);
  };
  const controller = await configuredController({ configurationDriver });
  await bootstrap(controller);
  const namespace = await createNamespace(controller, "plugin-api");
  const configuration = await createConfiguration(controller, namespace.id);
  const replacementConfiguration = await createConfiguration(controller, namespace.id, {
    runtime: { revision: "replacement" },
  });
  const pluginDriver = new OCCPluginDriver();
  controller.fixture.controller.registerDriver(pluginDriver);
  controller.fixture.controller.selectDriver("plugin", pluginDriver.id);
  const installation = await controller.request("GET", "/installation");
  assert.equal(installation.status, 200);
  const capabilities = installation.data.capabilities.pluginCatalogs[0].pluginPolicies;
  assert.deepEqual(capabilities.driver, {
    id: "occ-plugin",
    implementation: "occ/openclaw-plugin",
  });
  assert.deepEqual(capabilities.toolDefaults, {
    enabled: true,
    approval: ["provider_default", "none"],
    reviewer: [],
  });
  assert.deepEqual(capabilities.tools, {
    enabled: true,
    approval: ["provider_default", "none"],
    reviewer: [],
  });
  assert.deepEqual(capabilities.approvers, { agent: true, plugin: true, tools: true });
  assert.equal(capabilities.driverPolicySchema.additionalProperties, false);
  assert.deepEqual(capabilities.driverPolicySchema.properties, {});
  const initialPlugins = {
    [diffsPluginId]: pluginPolicy({
      approvers: [{ channel: "slack", id: "team:T123:user:U123" }],
      toolDefaults: { enabled: false, approval: "none" },
      tools: { diffs: { enabled: true, approvers: [] } },
    }),
  };

  const readsBeforeSave = configurationReads;
  const created = await controller.request("POST", `/namespaces/${namespace.id}/agents`, {
    body: {
      name: "plugin-agent",
      configurationId: configuration.id,
      plugins: initialPlugins,
      pluginApprovers: [],
    },
  });
  assert.equal(created.status, 201);
  assert.deepEqual(created.data.plugins, initialPlugins);
  assert.deepEqual(created.data.pluginApprovers, []);
  assertPolicyOnlyPlugin(created.data.plugins[diffsPluginId]);
  // The Plugin Driver's Configuration check and Agent save's check of the Agent against its
  // Configuration as deployment would (the Harness and its execution mode) read the values
  // once, shared by every check.
  assert.equal(configurationReads, readsBeforeSave + 1);

  const saved = await controller.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${created.data.id}`,
  );
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.data.plugins, initialPlugins);
  assert.deepEqual(saved.data.pluginApprovers, []);

  await controller.fixture.markNamespaceReady(namespace.id);
  await bindHarnessKey(controller.fixture, namespace.id, created.data);
  const deployment = await controller.request(
    "POST",
    `/namespaces/${namespace.id}/agents/${created.data.id}/deploy`,
  );
  assert.equal(deployment.status, 202);
  assert.deepEqual(deployment.data.plugins, {
    driver: { id: "occ-plugin", implementation: "occ/openclaw-plugin" },
    plugins: initialPlugins,
  });
  assert.deepEqual(deployment.data.pluginApprovers, []);
  assert.equal(Object.hasOwn(deployment.data.plugins, "artifacts"), false);

  const omittedPlugins = await controller.request(
    "PATCH",
    `/namespaces/${namespace.id}/agents/${created.data.id}`,
    { body: { configurationId: replacementConfiguration.id } },
  );
  assert.equal(omittedPlugins.status, 200);
  assert.equal(omittedPlugins.data.configurationId, replacementConfiguration.id);
  assert.deepEqual(omittedPlugins.data.plugins, initialPlugins);
  assert.deepEqual(omittedPlugins.data.pluginApprovers, []);

  const replacementPlugins = {
    [diffsPluginId]: pluginPolicy({
      toolDefaults: { approval: "provider_default" },
      tools: { diffs: { approval: "none" } },
    }),
  };
  const replacedPlugins = await controller.request(
    "PATCH",
    `/namespaces/${namespace.id}/agents/${created.data.id}`,
    {
      body: {
        configurationId: replacementConfiguration.id,
        plugins: replacementPlugins,
        pluginApprovers: [{ channel: "slack", id: "team:T123:user:U456" }],
      },
    },
  );
  assert.equal(replacedPlugins.status, 200);
  // Replacing policy removes old enablement overrides without inventing new defaults.
  assert.deepEqual(replacedPlugins.data.plugins, replacementPlugins);
  assert.deepEqual(replacedPlugins.data.pluginApprovers, [
    { channel: "slack", id: "team:T123:user:U456" },
  ]);
  assertPolicyOnlyPlugin(replacedPlugins.data.plugins[diffsPluginId]);
  // The nullable approver list is a referenced schema ($id PluginApprovers). Its problems belong
  // to the list's branch, so the null branch adds no wrong-type clause (finding 808).
  const agentPath = `/namespaces/${namespace.id}/agents/${created.data.id}`;
  const approver = { channel: "slack", id: "team:T123:user:U456" };
  for (const [pluginApprovers, problem] of [
    [
      [approver, approver],
      "body /pluginApprovers has an unsupported value (expected no duplicate items)",
    ],
    [
      Array.from({ length: 65 }, (_, index) => ({ channel: "slack", id: `user:${index}` })),
      "body /pluginApprovers has an unsupported value (expected at most 64 items)",
    ],
    [[{ ...approver, role: "admin" }], "body /pluginApprovers/0/role is not an accepted field"],
    [[{ channel: "Slack", id: "user:1" }], "body /pluginApprovers/0/channel has an invalid format"],
    ["slack", "body /pluginApprovers has the wrong type (expected one of array, null)"],
  ]) {
    const rejected = await controller.request("PATCH", agentPath, {
      body: { configurationId: replacementConfiguration.id, pluginApprovers },
    });
    assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
    assert.equal(
      rejected.body.error.message,
      `The request does not match the operation contract: ${problem}.`,
    );
  }

  const clearedPlugins = await controller.request(
    "PATCH",
    `/namespaces/${namespace.id}/agents/${created.data.id}`,
    { body: { configurationId: replacementConfiguration.id, plugins: {} } },
  );
  assert.equal(clearedPlugins.status, 200);
  assert.deepEqual(clearedPlugins.data.plugins, {});
  assert.deepEqual(clearedPlugins.data.pluginApprovers, [
    { channel: "slack", id: "team:T123:user:U456" },
  ]);

  const historical = await controller.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${created.data.id}/revisions/${deployment.data.id}`,
  );
  assert.equal(historical.status, 200);
  assert.deepEqual(historical.data.plugins, deployment.data.plugins);
  assert.deepEqual(historical.data.pluginApprovers, []);

  const pluginFreeRevision = await controller.request(
    "POST",
    `/namespaces/${namespace.id}/agents/${created.data.id}/deploy`,
  );
  assert.equal(pluginFreeRevision.status, 202);
  assert.equal(Object.hasOwn(pluginFreeRevision.data, "plugins"), false);
  assert.deepEqual(pluginFreeRevision.data.pluginApprovers, [
    { channel: "slack", id: "team:T123:user:U456" },
  ]);
  const clearedApprovers = await controller.request(
    "PATCH",
    `/namespaces/${namespace.id}/agents/${created.data.id}`,
    { body: { configurationId: replacementConfiguration.id, pluginApprovers: null } },
  );
  assert.equal(clearedApprovers.status, 200);
  assert.equal(Object.hasOwn(clearedApprovers.data, "pluginApprovers"), false);
  const inheritedRevision = await controller.request(
    "POST",
    `/namespaces/${namespace.id}/agents/${created.data.id}/deploy`,
  );
  assert.equal(inheritedRevision.status, 202);
  assert.equal(Object.hasOwn(inheritedRevision.data, "pluginApprovers"), false);
  assert.deepEqual(pluginFreeRevision.data.pluginApprovers, [
    { channel: "slack", id: "team:T123:user:U456" },
  ]);
});

registerCodexPluginPolicyCases(configuredController);

test("Agent save and deployment refuse plugins the Plugin Driver cannot run in the Agent's Harness", async () => {
  const controller = await configuredController();
  await bootstrap(controller);
  const namespace = await createNamespace(controller, "plugin-harness-pair");
  const codex = await createConfiguration(
    controller,
    namespace.id,
    createHarnessConfiguration("codex", "gpt-6-astra"),
  );
  const openclaw = await createConfiguration(
    controller,
    namespace.id,
    createHarnessConfiguration("openclaw", "gpt-5.1"),
  );
  const pluginDriver = new OCCPluginDriver();
  controller.fixture.controller.registerDriver(pluginDriver);
  controller.fixture.controller.selectDriver("plugin", pluginDriver.id);
  const plugins = { [diffsPluginId]: pluginPolicy() };
  const message = (harness) =>
    `No Plugin Driver is enabled for the ${harness} Harness. Remove the Agent's plugins or enable its catalog.`;
  const assertRefused = (refused, label, harness = "codex") => {
    assertApiError(refused, 400, "INVALID_REQUEST", label);
    assert.equal(refused.body.error.message, message(harness), label);
  };
  // Kubernetes Compute renders OpenClaw plugin artifacts only into an OpenClaw Harness and
  // refused a dedicated Codex Agent's plugins in preparation, after the deployment had stopped
  // the running revision (finding 2348).
  const agents = `/namespaces/${namespace.id}/agents`;
  assertRefused(
    await controller.request("POST", agents, {
      body: {
        name: "codex-plugins",
        executionMode: "dedicated",
        configurationId: codex.id,
        plugins,
      },
    }),
    "create",
  );
  assert.deepEqual((await controller.request("GET", agents)).data, []);
  const embedded = await controller.request("POST", agents, {
    body: { name: "openclaw-plugins", configurationId: openclaw.id, plugins },
  });
  assert.equal(embedded.status, 201, JSON.stringify(embedded.body));
  const created = await controller.request("POST", agents, {
    body: { name: "codex-agent", executionMode: "dedicated", configurationId: codex.id },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const agentPath = `${agents}/${created.data.id}`;
  assertRefused(
    await controller.request("PATCH", agentPath, {
      body: { configurationId: codex.id, plugins },
    }),
    "update",
  );
  await controller.fixture.markNamespaceReady(namespace.id);
  await bindHarnessKey(controller.fixture, namespace.id, embedded.data);
  // Removing an installed catalog prevents another deployment of an Agent that already selected it.
  const openclawPath = `${agents}/${embedded.data.id}`;
  controller.fixture.controller.installPluginDrivers([]);
  const missing = await controller.request("POST", `${openclawPath}/deploy`);
  assertApiError(missing, 501, "NOT_IMPLEMENTED");
  assert.deepEqual((await controller.request("GET", `${openclawPath}/revisions`)).data, []);

  // An Installation offering only Codex plugins refuses both OpenClaw modes at save.
  const codexDriver = new CodexPluginDriver();
  controller.fixture.controller.registerDriver(codexDriver);
  controller.fixture.controller.selectDriver("plugin", codexDriver.id);
  const codexPlugins = { [linearPluginId]: { enabled: true } };
  const codexHarness = "openclaw";
  assertRefused(
    await controller.request("POST", agents, {
      body: {
        name: "openclaw-codex-plugins",
        executionMode: "dedicated",
        configurationId: openclaw.id,
        plugins: codexPlugins,
      },
    }),
    "Codex Plugin Driver create",
    codexHarness,
  );
  assertRefused(
    await controller.request("POST", `${agents}/validate`, {
      body: {
        configuration: { kind: "agent", values: createHarnessConfiguration("openclaw", "gpt-5.1") },
        executionMode: "dedicated",
        plugins: codexPlugins,
      },
    }),
    "Codex Plugin Driver preflight",
    codexHarness,
  );
  const codexEmbedded = await controller.request("POST", agents, {
    body: { name: "embedded-codex-plugins", configurationId: openclaw.id, plugins: codexPlugins },
  });
  assertRefused(codexEmbedded, "embedded OpenClaw cannot use the Codex catalog", codexHarness);
});

test("a saved Google package refuses an incompatible Agent mode, Harness or Compute", async () => {
  const sandbox = {
    id: "sandbox-native",
    capability: "sandbox",
    implementation: "test-native-sandbox",
    supportsHarnessExecutionMode: DEDICATED_OPENCLAW_SUPPORT,
    facets: ["networking", "filesystem", "process"],
    async provisionHarness() {},
    async cleanup() {},
  };
  const kubernetes = createTestKubernetesComputeDriver("compute-google-placement", {
    sandboxDriver: sandbox,
  });
  const controller = await configuredController({ computeDriver: kubernetes });
  await bootstrap(controller);
  const namespace = await createNamespace(controller, "google-package-placement");
  const configuration = await createConfiguration(
    controller,
    namespace.id,
    createHarnessConfiguration("openclaw", "gpt-5.1"),
  );
  const driver = new OCCPluginDriver();
  controller.fixture.controller.installPluginDrivers([driver, new CodexPluginDriver()]);
  const packageId = "occ-plugin:google@1.0.0";
  const plugins = { [packageId]: { enabled: true } };
  const agentsPath = `/namespaces/${namespace.id}/agents`;
  const created = await controller.request("POST", agentsPath, {
    body: {
      name: "Workspace Agent",
      executionMode: "dedicated",
      configurationId: configuration.id,
      plugins,
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const path = `${agentsPath}/${created.data.id}`;
  const capabilities = await controller.request("GET", `${path}/plugins/capabilities`);
  assert.equal(capabilities.status, 200);
  assert.equal(capabilities.data.policyScopeByPlugin[packageId], "enablement_only");
  for (const unsupportedPolicy of [
    { toolDefaults: { approval: "all_actions" } },
    { tools: { "gmail.users.messages.list": { enabled: false } } },
    { approvers: [] },
  ]) {
    const policy = await controller.request("PATCH", path, {
      body: {
        configurationId: configuration.id,
        plugins: { [packageId]: { enabled: true, ...unsupportedPolicy } },
      },
    });
    assertApiError(policy, 400, "INVALID_REQUEST");
    assert.match(policy.body.error.message, /Google Workspace.*supports .*enablement/);
  }
  const mode = await controller.request("PATCH", path, {
    body: { configurationId: configuration.id, executionMode: "embedded" },
  });
  assert.equal(mode.status, 400, JSON.stringify(mode.body));
  assert.match(mode.body.error.message, /Google Workspace requires a dedicated OpenClaw Agent/);
  const saved = (await controller.request("GET", path)).data;
  assert.equal(saved.executionMode, "dedicated");
  assert.deepEqual(saved.plugins, plugins);

  await controller.fixture.platformState.transact((unit) =>
    unit.namespaces.transitionNamespaceStatus(namespace.id, "provisioning", "ready"),
  );
  await bindHarnessKey(controller.fixture, namespace.id, saved);
  const changeHarness = async (harnessId) => {
    const changed = await controller.request(
      "PATCH",
      `/namespaces/${namespace.id}/configurations/${configuration.id}`,
      {
        body: { values: createHarnessConfiguration(harnessId, "gpt-5.1") },
      },
    );
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
  };
  await changeHarness("codex");
  const deploy = await controller.request("POST", `${path}/deploy`);
  assert.equal(deploy.status, 400, JSON.stringify(deploy.body));
  assert.match(deploy.body.error.message, /Clear the Agent's existing plugin selections/);
  // A second Agent in the same Installation can select and admit a plugin through Codex.
  const codexAgent = await controller.request("POST", agentsPath, {
    body: {
      name: "Codex Agent",
      configurationId: configuration.id,
      executionMode: "dedicated",
      plugins: { [linearPluginId]: { enabled: true } },
    },
  });
  assert.equal(codexAgent.status, 201, JSON.stringify(codexAgent.body));
  await bindHarnessKey(controller.fixture, namespace.id, codexAgent.data);
  const codexRevision = await controller.request(
    "POST",
    `${agentsPath}/${codexAgent.data.id}/deploy`,
  );
  assert.equal(codexRevision.status, 202, JSON.stringify(codexRevision.body));
  assert.equal(codexRevision.data.plugins.driver.id, "codex-plugin");

  // The Sandbox can provision native workers. The replacement Compute cannot deliver the package.
  await changeHarness("openclaw");
  const unsupportedCompute = createReadyComputeDriver("compute-without-packages", {
    validateHarnessAuth() {},
    async stopRevision() {},
  });
  for (const replacement of [sandbox, unsupportedCompute]) {
    controller.fixture.controller.registerDriver(replacement);
    controller.fixture.controller.selectDriver(replacement.capability, replacement.id);
  }
  const unsupported = await controller.request("POST", `${path}/deploy`);
  assert.equal(unsupported.status, 400, JSON.stringify(unsupported.body));
  assert.equal(unsupported.body.error.message, "Google Workspace requires Kubernetes Compute.");
  assert.deepEqual((await controller.request("GET", `${path}/revisions`)).data, []);

  controller.fixture.controller.selectDriver("compute", kubernetes.id);
  const admitted = await controller.request("POST", `${path}/deploy`);
  assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
  assert.deepEqual(admitted.data.plugins, {
    driver: { id: driver.id, implementation: driver.implementation },
    plugins,
  });
});

registerOpenClawPluginPolicyCases(configuredController);

test("Codex Agents refuse plugin and tool approver overrides and keep Agent-wide approvers", async () => {
  const controller = await configuredController();
  await bootstrap(controller);
  const namespace = await createNamespace(controller, "codex-plugin-approvers-api");
  const configuration = await createConfiguration(controller, namespace.id, {
    ...createHarnessConfiguration("codex", "gpt-6-astra"),
  });
  const pluginDriver = new CodexPluginDriver();
  controller.fixture.controller.registerDriver(pluginDriver);
  controller.fixture.controller.selectDriver("plugin", pluginDriver.id);
  // The Console reads this capability to hide plugin and tool approver fields for Codex.
  const installation = await controller.request("GET", "/installation");
  assert.equal(installation.status, 200);
  assert.deepEqual(installation.data.capabilities.pluginCatalogs[0].pluginPolicies.approvers, {
    agent: true,
    plugin: false,
    tools: false,
  });

  const approvers = [{ channel: "slack", id: "team:T123:user:U123" }];
  const plugins = { [linearPluginId]: { enabled: true } };
  const created = await controller.request("POST", `/namespaces/${namespace.id}/agents`, {
    body: {
      name: "codex-approvers-agent",
      executionMode: "dedicated",
      configurationId: configuration.id,
      plugins,
      pluginApprovers: approvers,
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual(created.data.pluginApprovers, approvers);
  const path = `/namespaces/${namespace.id}/agents/${created.data.id}`;

  // Codex approval requests carry no plugin or tool identity, so any override list would make
  // every Codex plugin request unapprovable in Slack. Admission refuses it with remediation.
  const message =
    "This Plugin Driver does not support plugin or tool approvers. Omit approvers from plugin selections and set Agent-wide pluginApprovers instead.";
  for (const policy of [
    { enabled: true, approvers },
    { enabled: true, approvers: [] },
    { enabled: true, tools: { "app/search": { approvers } } },
  ]) {
    const rejectedUpdate = await controller.request("PATCH", path, {
      body: { configurationId: configuration.id, plugins: { [linearPluginId]: policy } },
    });
    assertApiError(rejectedUpdate, 400, "INVALID_REQUEST");
    assert.equal(rejectedUpdate.body.error.message, message);
  }
  const rejectedCreate = await controller.request("POST", `/namespaces/${namespace.id}/agents`, {
    body: {
      name: "codex-override-agent",
      executionMode: "dedicated",
      configurationId: configuration.id,
      plugins: { [linearPluginId]: { enabled: true, approvers } },
    },
  });
  assert.equal(rejectedCreate.status, 400);
  assert.equal(rejectedCreate.body.error.message, message);
  const saved = await controller.request("GET", path);
  assert.deepEqual(saved.data.plugins, plugins);
  assert.deepEqual(saved.data.pluginApprovers, approvers);
});

test("Agent plugin maps reject structural errors and preserve exact authorization and audit boundaries", async () => {
  const controller = await configuredController();
  await bootstrap(controller);
  const namespace = await createNamespace(controller, "plugin-api-auth");
  const configuration = await createConfiguration(controller, namespace.id);
  const pluginDriver = new OCCPluginDriver();
  controller.fixture.controller.registerDriver(pluginDriver);
  controller.fixture.controller.selectDriver("plugin", pluginDriver.id);
  const auditCount = controller.fixture.auditSink.events.length;

  for (const policy of [
    { ...pluginPolicy(), nativeId: "diffs" },
    { enabled: true, approvalMode: "always" },
  ]) {
    const invalidCreate = await controller.request("POST", `/namespaces/${namespace.id}/agents`, {
      body: {
        name: "invalid-plugin-agent",
        configurationId: configuration.id,
        plugins: { [diffsPluginId]: policy },
      },
    });
    assertApiError(invalidCreate, 400, "INVALID_REQUEST");
    assert.equal(controller.fixture.auditSink.events.length, auditCount);
  }

  const agent = await controller.request("POST", `/namespaces/${namespace.id}/agents`, {
    body: { name: "plugin-auth-agent", configurationId: configuration.id },
  });
  assert.equal(agent.status, 201);
  const secondAgent = await controller.request("POST", `/namespaces/${namespace.id}/agents`, {
    body: { name: "plugin-auth-sibling", configurationId: configuration.id },
  });
  assert.equal(secondAgent.status, 201);
  const agentPath = `/namespaces/${namespace.id}/agents/${agent.data.id}`;
  const siblingPath = `/namespaces/${namespace.id}/agents/${secondAgent.data.id}`;

  const auditBeforeInvalidUpdate = controller.fixture.auditSink.events.length;
  const snakeCaseReviewer = await controller.request("PATCH", agentPath, {
    body: {
      configurationId: configuration.id,
      plugins: {
        [linearPluginId]: {
          enabled: true,
          toolDefaults: { approval: "provider_default" },
          approvals_reviewer: "auto_review",
        },
      },
    },
  });
  assertApiError(snakeCaseReviewer, 400, "INVALID_REQUEST");
  assert.equal(controller.fixture.auditSink.events.length, auditBeforeInvalidUpdate);

  for (const plugins of [
    { "codex-plugin:bad/plugin@openai-curated-remote": pluginPolicy() },
    { [linearPluginId]: pluginPolicy({ tools: { "bad tool": { enabled: true } } }) },
    { [linearPluginId]: pluginPolicy({ tools: { search: {} } }) },
    { [diffsPluginId]: { enabled: true, approvalMode: "never" } },
    { [diffsPluginId]: pluginPolicy({ approvalsReviewer: "user" }) },
    { [diffsPluginId]: pluginPolicy({ destructiveActions: "never" }) },
    { [diffsPluginId]: pluginPolicy({ writes: "prompt" }) },
    { [diffsPluginId]: pluginPolicy({ tools: { diffs: { approvalMode: "always" } } }) },
    { [diffsPluginId]: pluginPolicy({ toolDefaults: { approval: "native" } }) },
    { [diffsPluginId]: pluginPolicy({ toolDefaults: { approval: "auto" } }) },
    { [diffsPluginId]: pluginPolicy({ toolDefaults: { reviewer: "user" } }) },
    { [diffsPluginId]: pluginPolicy({ tools: { diffs: { reviewer: null } } }) },
  ]) {
    const invalid = await controller.request("PATCH", agentPath, {
      body: { configurationId: configuration.id, plugins },
    });
    assertApiError(invalid, 400, "INVALID_REQUEST");
    assert.equal(controller.fixture.auditSink.events.length, auditBeforeInvalidUpdate);
  }

  const afterInvalidUpdate = await controller.request("GET", agentPath);
  assert.equal(Object.hasOwn(afterInvalidUpdate.data, "plugins"), false);

  // These policies satisfy the shared schema but the selected native driver cannot apply them.
  for (const [policy, message] of [
    [
      pluginPolicy({ toolDefaults: { approval: "all_actions" } }),
      "The supplied plugin policies are invalid.",
    ],
    [
      pluginPolicy({ toolDefaults: { approval: "write_actions" } }),
      "The supplied plugin policies are invalid.",
    ],
    [
      pluginPolicy({ tools: { diffs: { approval: "all_actions" } } }),
      "The supplied plugin policies are invalid.",
    ],
    [
      pluginPolicy({ driverPolicy: { destructiveEnabled: false } }),
      "The supplied plugin policies are invalid.",
    ],
    [
      pluginPolicy({ toolDefaults: { reviewer: "human" } }),
      "This Plugin Driver does not support toolDefaults.reviewer. Omit the reviewer to inherit the Harness setting.",
    ],
    [
      pluginPolicy({ tools: { diffs: { reviewer: "auto" } } }),
      "This Plugin Driver does not support tools[id].reviewer. Use toolDefaults.reviewer when supported, or omit the reviewer.",
    ],
  ]) {
    const unsupportedCreate = await controller.request(
      "POST",
      `/namespaces/${namespace.id}/agents`,
      {
        body: {
          name: "unsupported-plugin-agent",
          configurationId: configuration.id,
          plugins: { [diffsPluginId]: policy },
        },
      },
    );
    const unsupportedUpdate = await controller.request("PATCH", agentPath, {
      body: { configurationId: configuration.id, plugins: { [diffsPluginId]: policy } },
    });
    for (const response of [unsupportedCreate, unsupportedUpdate]) {
      assertApiError(response, 400, "INVALID_REQUEST");
      assert.equal(response.body.error.message, message);
    }
  }
  // A plugin the selected Driver does not offer, as after an Installation switches Drivers:
  // the refusal names the rejected ID and points at its selection.
  const otherDriverUpdate = await controller.request("PATCH", agentPath, {
    body: {
      configurationId: configuration.id,
      plugins: { [diffsPluginId]: pluginPolicy(), [linearPluginId]: pluginPolicy() },
    },
  });
  assertApiError(otherDriverUpdate, 400, "INVALID_REQUEST");
  assert.match(
    otherDriverUpdate.body.error.message,
    /^A plugin selection names a plugin that the selected Plugin Driver \(occ-plugin\) does not offer: codex-plugin:linear@openai-curated-remote\./,
  );
  assert.deepEqual(otherDriverUpdate.body.error.details, [
    { path: `/plugins/${linearPluginId}`, code: "INVALID_VALUE" },
  ]);
  const afterUnsupported = await controller.request("GET", agentPath);
  assert.deepEqual(afterUnsupported.data, afterInvalidUpdate.data);
  const savedAgents = await controller.request("GET", `/namespaces/${namespace.id}/agents`);
  assert.equal(savedAgents.data.length, 2, "unsupported policies must not create an Agent");

  const { principal: noGrantPrincipal } =
    await controller.fixture.createAuthPrincipal("plugin-no-grant");
  controller.fixture.state.identities.push(noGrantPrincipal);
  const noGrantApp = controller.fixture.createApp(noGrantPrincipal);
  const noGrantRead = await injectedRequest(noGrantApp, "GET", agentPath);
  assertApiError(noGrantRead, 403, "FORBIDDEN");
  const noGrantUpdate = await injectedRequest(noGrantApp, "PATCH", agentPath, {
    body: { configurationId: configuration.id, plugins: { [diffsPluginId]: pluginPolicy() } },
  });
  assertApiError(noGrantUpdate, 403, "FORBIDDEN");
  const afterNoGrant = await controller.request("GET", agentPath);
  assert.equal(Object.hasOwn(afterNoGrant.data, "plugins"), false);

  const { principal: exactAgentPrincipal } =
    await controller.fixture.createAuthPrincipal("plugin-exact-agent");
  controller.fixture.state.identities.push(exactAgentPrincipal);
  controller.fixture.state.roles.push({
    id: "role-plugin-exact-agent",
    namespaceId: namespace.id,
    permissions: [
      { action: "read", resourceKind: "agent" },
      { action: "update", resourceKind: "agent" },
      { action: "read", resourceKind: "configuration" },
    ],
  });
  controller.fixture.state.bindings.push(
    {
      id: "binding-plugin-exact-agent",
      namespaceId: namespace.id,
      subjectKind: "identity",
      subjectId: exactAgentPrincipal.id,
      roleId: "role-plugin-exact-agent",
      resourceKind: "agent",
      resourceId: agent.data.id,
    },
    {
      id: "binding-plugin-exact-configuration",
      namespaceId: namespace.id,
      subjectKind: "identity",
      subjectId: exactAgentPrincipal.id,
      roleId: "role-plugin-exact-agent",
      resourceKind: "configuration",
      resourceId: configuration.id,
    },
  );
  const exactAgentApp = controller.fixture.createApp(exactAgentPrincipal);
  const exactRead = await injectedRequest(exactAgentApp, "GET", agentPath);
  assert.equal(exactRead.status, 200);
  const foreignRead = await injectedRequest(exactAgentApp, "GET", siblingPath);
  assertApiError(foreignRead, 403, "FORBIDDEN");
  const foreignUpdate = await injectedRequest(exactAgentApp, "PATCH", siblingPath, {
    body: { configurationId: configuration.id, plugins: { [diffsPluginId]: pluginPolicy() } },
  });
  assertApiError(foreignUpdate, 403, "FORBIDDEN");

  // A catalog refusal must not bypass the exact grant on a newly requested source.
  const requestedSourceId = `cs_${randomUUID()}`;
  const deniedSource = await injectedRequest(exactAgentApp, "PATCH", agentPath, {
    body: {
      configurationId: configuration.id,
      credentialSources: [{ sourceId: requestedSourceId }],
      plugins: { [linearPluginId]: { enabled: true } },
    },
  });
  assertApiError(deniedSource, 403, "FORBIDDEN");
  assert.deepEqual(controller.fixture.auditSink.events.at(-1).authorization.resource, {
    kind: "credential_source",
    namespaceId: namespace.id,
    id: requestedSourceId,
  });

  const updated = await injectedRequest(exactAgentApp, "PATCH", agentPath, {
    body: { configurationId: configuration.id, plugins: { [diffsPluginId]: pluginPolicy() } },
  });
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.data.plugins, { [diffsPluginId]: pluginPolicy() });

  const secondDetail = await controller.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${secondAgent.data.id}`,
  );
  assert.equal(Object.hasOwn(secondDetail.data, "plugins"), false);

  const beforeAuditFailure = await controller.request("GET", agentPath);
  const originalAppend = controller.fixture.auditSink.append;
  controller.fixture.auditSink.append = async () => {
    throw new Error("plugin audit sink unavailable");
  };
  const failedAudit = await controller.request("PATCH", agentPath, {
    body: {
      configurationId: configuration.id,
      plugins: { [diffsPluginId]: pluginPolicy({ enabled: false }) },
    },
  });
  controller.fixture.auditSink.append = originalAppend;
  assert.equal(failedAudit.status, 503);
  assert.equal(failedAudit.body.error.code, "DEPENDENCY_UNAVAILABLE");
  const afterAuditFailure = await controller.request("GET", agentPath);
  assert.deepEqual(afterAuditFailure.data, beforeAuditFailure.data);

  // After the Installation switches Plugin Drivers, the Agent's stored selection is refused
  // where the plugins are read from storage: an update that omits plugins and a bodiless
  // deploy. The message still names the plugin, but no detail points into a request body
  // the caller never sent.
  await controller.fixture.controller.handleNamespaceLifecycle(
    controller.fixture.principal.id,
    namespace.id,
    "ready",
  );
  await bindHarnessKey(controller.fixture, namespace.id, agent.data);
  const beforeDriverSwitch = await controller.request("GET", agentPath);
  const codexPluginDriver = new CodexPluginDriver();
  controller.fixture.controller.registerDriver(codexPluginDriver);
  controller.fixture.controller.selectDriver("plugin", codexPluginDriver.id);
  const storedUpdate = await controller.request("PATCH", agentPath, {
    body: { configurationId: configuration.id },
  });
  const storedDeploy = await controller.request("POST", `${agentPath}/deploy`);
  for (const response of [storedUpdate, storedDeploy]) {
    assertApiError(response, 400, "INVALID_REQUEST");
    assert.match(
      response.body.error.message,
      /No Plugin Driver is enabled for the openclaw Harness/,
    );
    assert.equal(Object.hasOwn(response.body.error, "details"), false);
  }
  const afterStoredRefusal = await controller.request("GET", agentPath);
  assert.deepEqual(afterStoredRefusal.data, beforeDriverSwitch.data);
});

async function assertNoAgentsInNamespace(fixture, namespaceId, message) {
  const agents = await fixture.platformState.read((view) => view.agents.listAgents(namespaceId));
  assert.deepEqual(agents, [], message);
}

test("Agent provisioning API validates inline configuration with existing Secret references", async () => {
  const computeDriver = createProvisioningCapableComputeDriver();
  const configurationDriver = createProvisioningCapableConfigurationDriver();
  const logLines = [];
  const controller = await configuredController({
    computeDriver,
    configurationDriver,
    logger: createOccLogger({
      component: "occ-api",
      level: "info",
      destination: jsonLineDestination(logLines),
    }),
  });
  const { fixture } = controller;
  await bootstrap(controller, "Provisioning validation installation");
  const namespace = await createNamespace(controller, "provisioning-validation");

  // Observe successful Configuration writes: unlike Agents, Configurations have no list route.
  const configurationsCreated = [];
  const createConfigurationRecord = configurationDriver.create.bind(configurationDriver);
  configurationDriver.create = async (configuration) => {
    const created = await createConfigurationRecord(configuration);
    if (created.namespaceId === namespace.id) {
      configurationsCreated.push(created.id);
    }
    return created;
  };

  const provisionPath = `/namespaces/${namespace.id}/agents/provision`;
  const provision = (body) => controller.request("POST", provisionPath, { body });

  await fixture.controller.handleNamespaceLifecycle(fixture.principal.id, namespace.id, "ready");
  const modelApiKey = await controller.request("POST", `/namespaces/${namespace.id}/secrets`, {
    body: { name: "model-api-key", value: `model-key-${randomUUID()}` },
  });
  assert.equal(modelApiKey.status, 201, JSON.stringify(modelApiKey.body));
  const toolApiKey = await controller.request("POST", `/namespaces/${namespace.id}/secrets`, {
    body: { name: "tool-api-key", value: `tool-key-${randomUUID()}` },
  });
  assert.equal(toolApiKey.status, 201, JSON.stringify(toolApiKey.body));
  const secrets = { modelApiKey: modelApiKey.data, toolApiKey: toolApiKey.data };
  const requestBody = (overrides) => provisioningRequestBody(namespace.id, secrets, overrides);

  const foreignNamespaceId = `ns_${randomUUID()}`;
  const invalidPlans = invalidInlinePlans(
    requestBody,
    modelApiKey.data.ref,
    toolApiKey.data.ref,
    foreignNamespaceId,
  );
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
  ]) {
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
  assert.equal(preset.status, 201, JSON.stringify(preset.body));
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
  ]) {
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
  // A refusal the caller cannot fix (here the Installation enables dedicated runtime storage
  // without gateway routing) keeps fixed text, since its reason names Installation settings.
  // The API log names it with the request ID for the operator.
  const unrouted = createTestKubernetesComputeDriver("compute-provisioning-unrouted", {
    repositoryCredentials: true,
    routed: false,
  });
  computeDriver.validateAgentProvisioning = (input) => unrouted.validateAgentProvisioning(input);
  const computeRefused = await provision(requestBody());
  assert.equal(computeRefused.status, 409, JSON.stringify(computeRefused.body));
  const refusals = logLines.filter((line) => line.event === "agent_provisioning.compute_refused");
  assert.equal(refusals.length, 1, JSON.stringify(refusals));
  assert.deepEqual(
    {
      severity: refusals[0].severity,
      requestId: refusals[0].requestId,
      reason: refusals[0].reason,
    },
    {
      severity: "WARN",
      requestId: computeRefused.body.meta.requestId,
      reason: DEDICATED_STORAGE_ROUTING_REQUIRED,
    },
  );
  assert.equal(computeRefused.body.error.code, "RESOURCE_CONFLICT");
  assert.equal(
    computeRefused.body.error.message,
    "The Compute Driver cannot provision this execution mode or gateway configuration.",
  );
  // The refusal comes after authorization: a caller who cannot create Agents learns nothing
  // about the Installation's Compute settings.
  fixture.state.restrictions.push({
    id: "deny-provisioning-agent-create",
    namespaceId: namespace.id,
    resourceKind: "agent",
    resourceId: namespace.id,
    action: "create",
    effect: "deny",
  });
  const refusedUnauthorized = await provision(requestBody());
  assert.equal(refusedUnauthorized.status, 403, JSON.stringify(refusedUnauthorized.body));
  // Authorization also precedes OCC's own plan checks. Each body below draws a 400 from
  // an authorized caller; without the grant it is the same 403, so a caller learns nothing about
  // a Namespace they cannot provision in from how the plan is refused.
  const planRefusals = [
    { description: "omitted execution mode", body: requestBody({ executionMode: undefined }) },
    // Provisioning needs dedicated Harness authentication. The rule is about the body, so an
    // authorized caller gets it by name, not a generic "not found" (D547).
    {
      description: "no Harness authentication",
      body: requestBody({ harnessAuth: null }),
      message: "Agent provisioning requires dedicated Harness authentication.",
    },
    {
      description: "runtime Harness authentication",
      body: requestBody({ harnessAuth: { method: "runtime" } }),
      message: "Agent provisioning requires dedicated Harness authentication.",
    },
  ];
  const assertPlanRefusalsDenied = async (grant) => {
    for (const { description, body } of planRefusals) {
      const denied = await provision(body);
      assertApiError(denied, 403, "FORBIDDEN", `${grant}, ${description}`);
    }
  };
  await assertPlanRefusalsDenied("without Agent create");
  fixture.state.restrictions.pop();
  // Installation administer used to be checked only after the plan was validated and stored.
  fixture.state.restrictions.push({
    id: "deny-provisioning-installation-administer",
    resourceKind: "installation",
    action: "administer",
    effect: "deny",
  });
  await assertPlanRefusalsDenied("without Installation administer");
  fixture.state.restrictions.pop();
  for (const { description, body, message } of planRefusals) {
    const refused = await provision(body);
    assert.equal(refused.status, 400, `${description}: ${JSON.stringify(refused.body)}`);
    if (message !== undefined) {
      assert.deepEqual(
        { code: refused.body.error.code, message: refused.body.error.message },
        { code: "INVALID_REQUEST", message },
        description,
      );
    }
  }
  // The logged reason keeps at most 512 characters, and a thrown non-Error's value is not logged.
  for (const [thrown, reason] of [
    [new Error("r".repeat(600)), "r".repeat(512)],
    ["internal driver detail", "The Compute Driver refused the plan."],
  ]) {
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
  badBaseUrl.configuration.values = {
    ...badBaseUrl.configuration.values,
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

  const assertNeedsDurableStorage = (response) => {
    assertApiError(response, 503, "DEPENDENCY_UNAVAILABLE");
    assert.equal(response.body.error.message, "A required platform dependency is unavailable.");
    // Only the operator log says which dependency failed. Match this request to exclude earlier 503s.
    assert.deepEqual(
      logLines
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
  const account = await fixture.platformState.transact((unit) =>
    unit.serviceAccounts.createServiceAccount({
      id: `sa_${randomUUID()}`,
      namespaceId: namespace.id,
      name: `provisioning-account-${randomUUID().slice(0, 8)}`,
    }),
  );
  const managedSource = { kind: "service_account", namespaceId: namespace.id, id: account.id };
  const provisionWithAccount = (source) =>
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
});

registerBootstrapAuthorizationEvidenceCase(createInjectedFixture);

test("OCC development subprocess requires PostgreSQL-backed startup", async (t) => {
  await assertUnsafeStartupRejected(t);
});

test("bodyless OCC routes reject request payloads before IAM or domain side effects", () =>
  runBodylessRoutes({
    configuredController,
    bootstrap,
    createNamespace,
    createAgent,
    missingRevisionId,
  }));

test("API response serializers keep same-$id shared schemas of sibling plugins apart", async () => {
  // The serializer cache keys shared schemas by identity: two plugins that each add a
  // different schema under one $id, with identical route schemas, must not share a build.
  const fixture = await createInjectedFixture();
  const app = fixture.createApp(fixture.principal, createFastifyApp);
  try {
    for (const field of ["first", "second"]) {
      app.register(async (scope) => {
        scope.addSchema({
          $id: "SerializerCacheSibling",
          type: "object",
          properties: { [field]: { type: "string" } },
        });
        scope.get(
          `/serializer-cache/${field}`,
          { schema: { response: { 200: { $ref: "SerializerCacheSibling#" } } } },
          async () => ({ first: "one", second: "two" }),
        );
      });
    }
    for (const [field, value] of [
      ["first", "one"],
      ["second", "two"],
    ]) {
      const response = await app.inject({ method: "GET", url: `/serializer-cache/${field}` });
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(response.json(), { [field]: value });
    }
  } finally {
    await app.close();
  }
});

test("API serializer compiler is the copy Fastify itself loads", () => {
  // apps/controller pins @fastify/fast-json-stringify-compiler for its serializer cache. When
  // a Fastify upgrade moves its own compiler, move the pin with it so one copy serves both.
  const controller = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
  const fastify = createRequire(controller.resolve("fastify"));
  assert.equal(
    realpathSync(controller.resolve("@fastify/fast-json-stringify-compiler")),
    realpathSync(fastify.resolve("@fastify/fast-json-stringify-compiler")),
  );
});

test("OCC isolates Namespace ownership and filters collections by exact IAM grants", () =>
  runNamespaceIsolation({
    configuredController,
    bootstrap,
    createNamespace,
    createAgent,
    missingRevisionId,
  }));

test("two Namespaces become independently ready and deletion tombstones only its exact target", async () => {
  const controller = await configuredController();
  const { fixture } = controller;
  await bootstrap(controller, "Lifecycle installation");
  const namespaceA = await createNamespace(controller, "lifecycle-a");
  const namespaceB = await createNamespace(controller, "lifecycle-b");

  const originalConfiguration = await createConfiguration(controller, namespaceA.id, {
    model: "original",
  });
  const agentA = await injectedRequest(fixture.app, "POST", `/namespaces/${namespaceA.id}/agents`, {
    body: { name: "lifecycle-agent-a", configurationId: originalConfiguration.id },
  });
  assert.equal(agentA.status, 201);
  assert.equal(agentA.data.configurationId, originalConfiguration.id);
  const firstConfiguration = await createConfiguration(controller, namespaceA.id, {
    model: "first",
    temperature: "0",
  });
  const replacedReference = await injectedRequest(
    fixture.app,
    "PATCH",
    `/namespaces/${namespaceA.id}/agents/${agentA.data.id}`,
    { body: { configurationId: firstConfiguration.id } },
  );
  assert.equal(replacedReference.status, 200);
  assert.equal(replacedReference.data.configurationId, firstConfiguration.id);
  assert.deepEqual(fixture.computeCalls.ensureNamespace, []);
  const unavailable = await injectedRequest(
    fixture.app,
    "POST",
    `/namespaces/${namespaceA.id}/agents/${agentA.data.id}/deploy`,
  );
  assertApiError(unavailable, 409, "NAMESPACE_NOT_READY");

  await fixture.controller.handleNamespaceLifecycle(fixture.principal.id, namespaceA.id, "ready");
  await fixture.controller.handleNamespaceLifecycle(fixture.principal.id, namespaceB.id, "ready");
  assert.deepEqual(fixture.computeCalls.ensureNamespace, [namespaceA.id, namespaceB.id]);

  await bindHarnessKey(fixture, namespaceA.id, {
    ...agentA.data,
    configurationId: firstConfiguration.id,
  });
  const readyDeployment = await injectedRequest(
    fixture.app,
    "POST",
    `/namespaces/${namespaceA.id}/agents/${agentA.data.id}/deploy`,
  );
  assert.equal(readyDeployment.status, 202);
  assert.match(readyDeployment.data.id, identifier("rev"));
  assert.deepEqual(Object.keys(readyDeployment.data).sort(), [
    "agentId",
    "backendId",
    "compute",
    "configuration",
    "configurationGeneration",
    "configurationId",
    "configurationKind",
    "createdAt",
    "gatewayManagedMode",
    "harness",
    "harnessAuth",
    "id",
    "namespaceId",
    "revision",
  ]);
  assert.equal(readyDeployment.data.configurationId, firstConfiguration.id);
  assert.equal(readyDeployment.data.configurationKind, "agent");
  assert.equal(readyDeployment.data.configurationGeneration, 1);
  assert.deepEqual(
    readyDeployment.data.configuration,
    admittedConfiguration(servedAs({ model: "first", temperature: "0" }, agentA.data.name), "info"),
  );
  assert.deepEqual(readyDeployment.data.harness, {
    id: "openclaw",
    version: "1.0.0",
    mode: "embedded",
    overrides: {},
    configuration: {},
  });
  assert.deepEqual(readyDeployment.data.compute, {
    id: "compute-integration",
    implementation: "deterministic-test",
  });
  assert.equal(readyDeployment.data.revision, 1);
  assert.equal(Object.hasOwn(readyDeployment.data, "servicePrincipalId"), false);

  const secondConfiguration = await createConfiguration(controller, namespaceA.id, {
    model: "second",
    temperature: "1",
  });
  const nextReference = await injectedRequest(
    fixture.app,
    "PATCH",
    `/namespaces/${namespaceA.id}/agents/${agentA.data.id}`,
    { body: { configurationId: secondConfiguration.id } },
  );
  assert.equal(nextReference.status, 200);
  const historical = await injectedRequest(
    fixture.app,
    "GET",
    `/namespaces/${namespaceA.id}/agents/${agentA.data.id}/revisions/${readyDeployment.data.id}`,
  );
  assert.equal(historical.status, 200);
  assert.deepEqual(historical.data, readyDeployment.data);

  const nextDeployment = await injectedRequest(
    fixture.app,
    "POST",
    `/namespaces/${namespaceA.id}/agents/${agentA.data.id}/deploy`,
  );
  assert.equal(nextDeployment.status, 202);
  assert.equal(nextDeployment.data.revision, 2);
  assert.deepEqual(
    nextDeployment.data.configuration,
    admittedConfiguration(
      servedAs({ model: "second", temperature: "1" }, agentA.data.name),
      "info",
    ),
  );
  const admittedRevisions = await injectedRequest(
    fixture.app,
    "GET",
    `/namespaces/${namespaceA.id}/agents/${agentA.data.id}/revisions`,
  );
  // The list returns summaries, newest first, on one page.
  const summary = (revision) => ({
    id: revision.id,
    namespaceId: revision.namespaceId,
    agentId: revision.agentId,
    revision: revision.revision,
    backendId: revision.backendId,
    configurationId: revision.configurationId,
    configurationGeneration: revision.configurationGeneration,
    harness: revision.harness,
    createdAt: revision.createdAt,
    // This in-memory API records no deployment work.
    deploymentStatus: null,
    deploymentErrorCode: null,
  });
  assert.deepEqual(admittedRevisions.data, [
    summary(nextDeployment.data),
    summary(readyDeployment.data),
  ]);
  assert.equal(admittedRevisions.body.meta.nextCursor, null);
  assert.deepEqual(fixture.computeCalls.ensureNamespace, [namespaceA.id, namespaceB.id]);

  const deleting = await injectedRequest(fixture.app, "DELETE", `/namespaces/${namespaceB.id}`);
  assert.equal(deleting.status, 202);
  assert.equal(deleting.data.status, "deleting");
  const rejectedChild = await injectedRequest(
    fixture.app,
    "POST",
    `/namespaces/${namespaceB.id}/agents`,
    { body: { name: "too-late", configurationId: firstConfiguration.id } },
  );
  assert.equal(rejectedChild.status, 409);

  await fixture.controller.handleNamespaceLifecycle(fixture.principal.id, namespaceB.id, "deleted");
  assert.deepEqual(fixture.computeCalls.deleteNamespace, [namespaceB.id]);
  const absent = await injectedRequest(fixture.app, "GET", `/namespaces/${namespaceB.id}`);
  assert.equal(absent.status, 404);
  const listed = await injectedRequest(fixture.app, "GET", "/namespaces");
  assert.deepEqual(
    listed.data.map(({ name }) => name),
    [BOOTSTRAP_DEFAULT_NAMESPACE_NAME, "lifecycle-a"],
  );
  const stillReady = await injectedRequest(fixture.app, "GET", `/namespaces/${namespaceA.id}`);
  assert.equal(stillReady.data.status, "ready");
  // The tombstone keeps its name: a new Namespace cannot reuse it, and the 409 says the name
  // belongs to a deleted Namespace rather than one the caller could find in the list.
  const reused = await injectedRequest(fixture.app, "POST", "/namespaces", {
    body: { name: "lifecycle-b" },
  });
  assertApiError(reused, 409, "RESOURCE_CONFLICT");
  assert.equal(
    reused.body.error.message,
    "This name belongs to a deleted Namespace and cannot be reused. Choose a different name.",
  );
});

test("bootstrap, mutations, and denials emit attributable private audit events", async () => {
  const controller = await configuredController();
  const { fixture } = controller;
  const originalIAMDriverId = fixture.iamDriver.id;
  await bootstrap(controller, "Audited installation");
  const namespace = await createNamespace(controller, "audited-namespace");
  const agent = await createAgent(controller, namespace.id, "audited-agent");

  // Beginning deletion is an audited mutation in its own right: it is the
  // record that attributes the teardown to the principal who requested it,
  // and it must exist before any resource is destroyed.
  const deletion = await injectedRequest(
    fixture.app,
    "DELETE",
    `/namespaces/${namespace.id}/agents/${agent.id}`,
  );
  assert.equal(deletion.status, 202);
  assert.equal(deletion.data.status, "deleting");

  const expectedAuditEvents = fixture.auditSink.events.length;
  const unauthenticated = await injectedRequest(fixture.app, "GET", "/installation", {
    identity: false,
  });
  assert.equal(unauthenticated.status, 401);
  assert.equal(fixture.auditSink.events.length, expectedAuditEvents);

  const permissions = fixture.state.roles[0].permissions;
  const namespaceCreate = permissions.findIndex(
    (entry) => entry.action === "create" && entry.resourceKind === "namespace",
  );
  permissions.splice(namespaceCreate, 1);
  // Deleting an Agent is destructive and is gated by its own permission rather
  // than riding on update or deploy, so a principal that can change an Agent
  // still cannot tear it down.
  const agentDelete = permissions.findIndex(
    (entry) => entry.action === "delete" && entry.resourceKind === "agent",
  );
  permissions.splice(agentDelete, 1);
  const denialApp = fixture.createApp();
  const unauthorized = await injectedRequest(denialApp, "POST", "/namespaces", {
    body: { name: "never-log-this-request-body" },
  });
  assert.equal(unauthorized.status, 403);

  const deletionDenied = await injectedRequest(
    denialApp,
    "DELETE",
    `/namespaces/${namespace.id}/agents/${agent.id}`,
  );
  assert.equal(deletionDenied.status, 403);

  const mutationEvents = fixture.auditSink.events.filter((event) =>
    ["bootstrap", "mutation"].includes(event.kind),
  );
  assert.equal(mutationEvents.length, 5);
  assert.deepEqual(
    mutationEvents.map((event) => [event.kind, event.resource.kind]),
    [
      ["bootstrap", "installation"],
      ["mutation", "namespace"],
      ["mutation", "configuration"],
      ["mutation", "agent"],
      ["mutation", "agent"],
    ],
  );
  for (const event of mutationEvents) {
    assert.equal(event.outcome, "success");
    assert.equal(event.installationId, fixture.installationId);
    assert.equal(event.actorId, fixture.principal.id);
    assert.equal(event.actor.principalId, fixture.principal.id);
    assert.equal(event.actor.issuer, fixture.principal.issuer);
    assert.equal(event.actor.subject, fixture.principal.subject);
    assert.match(event.requestId, identifier("req"));
    assert.equal(typeof event.admissionDecisionId, "string");
    assert.equal(event.source, "occ");
    assert.equal(event.iamDriverId, originalIAMDriverId);
  }
  assert.deepEqual(
    mutationEvents.map((event) => event.authorization),
    [
      {
        principalId: fixture.principal.id,
        action: "administer",
        resource: {
          kind: "installation",
          id: fixture.installationId,
        },
      },
      {
        principalId: fixture.principal.id,
        action: "create",
        resource: {
          kind: "namespace",
          id: fixture.installationId,
        },
      },
      {
        principalId: fixture.principal.id,
        action: "create",
        resource: {
          kind: "configuration",
          id: namespace.id,
          namespaceId: namespace.id,
        },
      },
      {
        principalId: fixture.principal.id,
        action: "create",
        resource: {
          kind: "agent",
          id: namespace.id,
          namespaceId: namespace.id,
        },
      },
      {
        principalId: fixture.principal.id,
        action: "delete",
        resource: {
          kind: "agent",
          id: agent.id,
          namespaceId: namespace.id,
        },
      },
    ],
  );

  // Both refusals are audited, so a denied destructive request leaves evidence
  // naming the principal who attempted it.
  const authorizationDenials = fixture.auditSink.events.filter(
    (event) => event.kind === "authorization_denial",
  );
  assert.equal(authorizationDenials.length, 2);
  for (const denial of authorizationDenials) {
    assert.equal(denial.outcome, "denied");
    assert.equal(denial.actor.principalId, fixture.principal.id);
    assert.equal(denial.installationId, fixture.installationId);
    assert.equal(denial.reasonCode, "AUTHORIZATION_DENIED");
  }
  assert.deepEqual(
    authorizationDenials.map((denial) => [
      denial.authorization.action,
      denial.authorization.resource.kind,
    ]),
    [
      ["create", "namespace"],
      ["delete", "agent"],
    ],
  );
  assert.equal(authorizationDenials[1].authorization.resource.id, agent.id);

  const recorded = JSON.stringify(fixture.auditSink.events);
  assert.equal(recorded.includes(fixture.session.cookie), false);
  assert.equal(recorded.includes("never-log-this-request-body"), false);
});

registerAuthorizationDecisionCases(configuredController);

registerGatewayAdmissionCases();

registerDeploymentAuthorizationEvidenceCase(configuredController);

test("IAM and audit dependency failures fail closed without orphaned state", async () => {
  const bootstrapFailure = await createInjectedFixture();
  const originalBootstrapAppend = bootstrapFailure.auditSink.append;
  bootstrapFailure.auditSink.append = async () => {
    throw new Error("bootstrap audit unavailable");
  };
  let failedBootstrap;
  try {
    failedBootstrap = await injectedRequest(
      bootstrapFailure.app,
      "POST",
      "/installation/bootstrap",
      { body: { name: "must-not-create-an-installation" } },
    );
  } finally {
    bootstrapFailure.auditSink.append = originalBootstrapAppend;
  }
  assert.equal(failedBootstrap.status, 503);
  assert.equal(failedBootstrap.body.error.code, "DEPENDENCY_UNAVAILABLE");
  assert.deepEqual(bootstrapFailure.auditSink.events, []);

  const absentInstallation = await injectedRequest(bootstrapFailure.app, "GET", "/installation");
  assert.equal(absentInstallation.status, 404);

  const recoveredBootstrap = await injectedRequest(
    bootstrapFailure.app,
    "POST",
    "/installation/bootstrap",
    { body: { name: "recovered installation" } },
  );
  assert.equal(recoveredBootstrap.status, 201);

  const fixture = await createInjectedFixture();
  const bootstrapResult = await injectedRequest(fixture.app, "POST", "/installation/bootstrap", {
    body: { name: "Failure-injection installation" },
  });
  assert.equal(bootstrapResult.status, 201);

  const originalAppend = fixture.auditSink.append;
  fixture.auditSink.append = async () => {
    throw new Error("sk-audit-provider-credential-123456789");
  };
  let failedMutation;
  try {
    failedMutation = await injectedRequest(fixture.app, "POST", "/namespaces", {
      body: { name: "must-never-become-visible" },
    });
  } finally {
    fixture.auditSink.append = originalAppend;
  }
  assert.equal(failedMutation.status, 503);
  assert.equal(failedMutation.body.error.code, "DEPENDENCY_UNAVAILABLE");
  assert.equal(JSON.stringify(failedMutation.body).includes("sk-audit-provider"), false);

  const unchanged = await injectedRequest(fixture.app, "GET", "/namespaces");
  assertOnlyDefaultNamespace(unchanged);
  assert.equal(fixture.auditSink.events.length, 1);

  const originalAuthorize = fixture.iamDriver.authorize;
  fixture.iamDriver.authorize = async () => {
    throw new Error("sk-iam-provider-credential-123456789");
  };
  let unavailable;
  try {
    unavailable = await injectedRequest(fixture.app, "POST", "/namespaces", {
      body: { name: "must-never-be-authorized" },
    });
  } finally {
    fixture.iamDriver.authorize = originalAuthorize;
  }
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.body.error.code, "DEPENDENCY_UNAVAILABLE");
  assert.equal(JSON.stringify(unavailable.body).includes("sk-iam-provider"), false);

  const stillUnchanged = await injectedRequest(fixture.app, "GET", "/namespaces");
  assertOnlyDefaultNamespace(stillUnchanged);
});

registerSshAdmissionCases();

async function createSlackValidationFixture(controller, namespaceName) {
  const { fixture } = controller;
  await bootstrap(controller);
  const namespace = await createReadyNamespace(controller, namespaceName);
  const base = `/namespaces/${namespace.id}`;
  const makeSecret = async (name, value) => {
    const result = await controller.request("POST", `${base}/secrets`, { body: { name, value } });
    assert.equal(result.status, 201);
    return result.data;
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
    async saveConfiguration(configuration) {
      const result = await controller.request("POST", `${base}/configurations`, {
        body: configuration,
      });
      assert.equal(result.status, 201, JSON.stringify(result.body));
      return result.data;
    },
    async createAgent(name, configurationId) {
      const result = await controller.request("POST", `${base}/agents`, {
        body: { name, configurationId },
      });
      assert.equal(result.status, 201, JSON.stringify(result.body));
      return result.data;
    },
    provision(configuration) {
      return controller.request("POST", `${base}/agents/provision`, {
        body: provisioningRequestBody(namespace.id, secrets, { configuration }),
      });
    },
  };
}

async function bindSlackDeploymentCredentials(fixture, namespaceId, agent, { app, bot }) {
  await bindHarnessKey(fixture, namespaceId, agent);
  for (const secret of [app, bot]) {
    fixture.state.bindings.push({
      id: `slack-${secret.id}`,
      namespaceId,
      subjectKind: "identity",
      subjectId: agent.servicePrincipalId,
      roleId: `harness-key-${agent.id}`,
      resourceKind: "secret",
      resourceId: secret.id,
    });
  }
}

test("Agent provisioning and deploy name a refused channel token reference form before Slack validation", async () => {
  // Finding 2506: provisioning ran the Slack Channel Driver's check before the Configuration rules
  // Configuration save applies. That check reads only an env SecretRef, so every refused string
  // form, bound or not, got its generic "Select an environment-backed Secret" answer. These are
  // the bundled Kubernetes Compute's binding rules (OCC applies them by implementation) and the
  // Configuration Drivers' credential slot rule, with both Slack tokens bound.
  const configurationDriver = {
    ...createProvisioningCapableConfigurationDriver(),
    validate: async (configuration) => validateModelCredentialReferences(configuration.values),
  };
  const controller = await configuredController({
    computeDriver: {
      ...createProvisioningCapableComputeDriver(),
      implementation: "occ/kubernetes",
    },
    configurationDriver,
  });
  const { fixture, namespace, base, app, bot, saveConfiguration, createAgent, provision } =
    await createSlackValidationFixture(controller, "slack-reference-forms");
  let calls = 0;
  const channel = new SlackChannelDriver(async () => {
    calls++;
    return new Response(JSON.stringify({ ok: true, bot_id: "B123", team_id: "T123" }));
  });
  fixture.controller.registerDriver(channel);
  fixture.controller.selectDriver("channel", channel.id);
  const form = (name) => referenceFormRefusal("channels.slack.botToken", name);
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
  ];
  const configurationWithBotToken = (botToken) =>
    slackValidationConfiguration({
      appSource: app.ref,
      botSource: bot.ref,
      botToken,
      model: "codex/gpt-6-astra",
    });
  for (const [botToken, message] of forms) {
    const refused = await provision(configurationWithBotToken(botToken));
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
    await configurationDriver.update({
      ...stored,
      values: { ...values, channels: { slack: { ...values.channels.slack, botToken } } },
    });
    const refused = await controller.request("POST", `${base}/agents/${agent.id}/deploy`);
    assertApiError(refused, 400, "INVALID_REQUEST");
    assert.equal(refused.body.error.message, message, botToken);
    assert.doesNotMatch(JSON.stringify(refused.body), /xoxb-synthetic|SECRET/);
  }
  assert.equal(calls, 0);
});

test("Slack validation rejects swapped credentials and preserves authorization", async () => {
  const controller = await configuredController({
    computeDriver: createProvisioningCapableComputeDriver(),
    configurationDriver: createProvisioningCapableConfigurationDriver(),
  });
  const { fixture, namespace, base, app, bot, saveConfiguration, createAgent, provision } =
    await createSlackValidationFixture(controller, "slack-admission");
  let calls = 0;
  let response = { ok: true, bot_id: "B123", team_id: "T123" };
  const channel = new SlackChannelDriver(async (url, options) => {
    calls++;
    assert.equal(new URL(url).pathname, "/api/auth.test");
    assert.equal(options.method, "POST");
    assert.equal(options.headers.authorization, "Bearer xoxb-synthetic-bot");
    if (response instanceof Error) {
      throw response;
    }
    return new Response(JSON.stringify(response));
  });
  fixture.controller.registerDriver(channel);
  fixture.controller.selectDriver("channel", channel.id);
  const configuration = slackValidationConfiguration({
    appSource: bot.ref,
    botSource: app.ref,
  });
  // A foreign channel Secret is an invalid request, not a scope miss from channel validation.
  const foreignBot = { ...bot.ref, namespaceId: `ns_${randomUUID()}` };
  const foreign = await provision({
    ...configuration,
    secretBindings: {
      ...configuration.secretBindings,
      SLACK_BOT_TOKEN: { source: foreignBot, delivery: { type: "env" } },
    },
  });
  assertApiError(foreign, 400, "INVALID_REQUEST");
  assert.equal(foreign.body.error.message, "Secret references cannot cross Namespaces.");
  assert.equal(calls, 0);
  const swapped = await provision(configuration);
  assertApiError(swapped, 400, "CHANNEL_CREDENTIAL_ROLE_MISMATCH");
  assert.equal(swapped.body.error.details[0].path, "/channels/slack/appToken");
  assert.equal(calls, 0);
  await assertNoAgentsInNamespace(fixture, namespace.id);
  configuration.secretBindings.SLACK_APP_TOKEN.source = app.ref;
  const wrongBotRole = await provision(configuration);
  assert.equal(wrongBotRole.body.error.code, "CHANNEL_CREDENTIAL_ROLE_MISMATCH");
  assert.equal(wrongBotRole.body.error.details[0].path, "/channels/slack/botToken");
  assert.equal(calls, 0);
  configuration.secretBindings.SLACK_BOT_TOKEN.source = bot.ref;
  fixture.state.restrictions.push({
    id: "deny-bot",
    namespaceId: namespace.id,
    resourceKind: "secret",
    resourceId: bot.id,
    action: "operate",
    effect: "deny",
  });
  assert.equal((await provision(configuration)).status, 403);
  assert.equal(calls, 0);
  fixture.state.restrictions.pop();
  response = new Error("xoxb-sensitive-provider-error");
  const unavailable = await provision(configuration);
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.body.error.code, "CHANNEL_CREDENTIAL_UNAVAILABLE");
  assert.equal(unavailable.body.error.details[0].path, "/channels/slack/botToken");
  assert.doesNotMatch(JSON.stringify(unavailable.body), /xoxb|sensitive/);
  response = { ok: false, error: "invalid_auth" };
  assert.equal(
    (await provision(configuration)).body.error.code,
    "CHANNEL_CREDENTIAL_CREDENTIALS_REJECTED",
  );
  response = { ok: true, bot_id: "B123", team_id: "T123" };
  // The in-memory fixture deliberately has no durable work queue. Reaching its
  // error proves credentials passed without substituting for the durable worker test.
  assert.equal((await provision(configuration)).body.error.code, "DEPENDENCY_UNAVAILABLE");
  const enterprise = {
    ok: true,
    bot_id: "B123",
    is_enterprise_install: true,
    enterprise_id: "E123",
  };
  response = { ...enterprise, team_id: enterprise.enterprise_id };
  assert.equal((await provision(configuration)).body.error.code, "DEPENDENCY_UNAVAILABLE");
  const config = await saveConfiguration(configuration);
  const agent = await createAgent("slack-agent", config.id);
  await bindSlackDeploymentCredentials(fixture, namespace.id, agent, { app, bot });
  response = { ok: false, error: "invalid_auth" };
  const deploy = await controller.request("POST", `${base}/agents/${agent.id}/deploy`);
  assert.equal(deploy.status, 400, JSON.stringify(deploy.body));
  assert.equal(deploy.body.error.details[0].path, "/channels/slack/botToken");
  response = enterprise;
  const good = await controller.request("POST", `${base}/agents/${agent.id}/deploy`);
  assert.equal(good.status, 202, JSON.stringify(good.body));
  response = { ...enterprise, enterprise_id: "invalid", team_id: "T123" };
  assert.equal((await provision(configuration)).body.error.code, "CHANNEL_CREDENTIAL_UNAVAILABLE");
  response = enterprise;
  // Named accounts do not hide the top-level tokens: OpenClaw starts them as the
  // implicit default account, so they need Secret-backed refs too.
  const namedAccounts = structuredClone(configuration);
  namedAccounts.values.channels.slack.appToken = "xapp-plaintext-default";
  namedAccounts.values.channels.slack.botToken = "xoxb-plaintext-default";
  namedAccounts.values.channels.slack.accounts = {
    work: {
      appToken: { source: "env", provider: "default", id: "SLACK_WORK_APP_TOKEN" },
      botToken: { source: "env", provider: "default", id: "SLACK_WORK_BOT_TOKEN" },
    },
  };
  // OpenClaw also reads SLACK_BOT_TOKEN/SLACK_APP_TOKEN from the environment for the
  // implicit account, so the named account uses other names.
  namedAccounts.secretBindings = {
    SLACK_WORK_APP_TOKEN: { source: app.ref, delivery: { type: "env" } },
    SLACK_WORK_BOT_TOKEN: { source: bot.ref, delivery: { type: "env" } },
  };
  const plaintextDefault = await provision(namedAccounts);
  assertApiError(plaintextDefault, 400, "CHANNEL_CREDENTIAL_BINDING_REQUIRED");
  assert.equal(plaintextDefault.body.error.details[0].path, "/channels/slack/appToken");
  // An account named "default" replaces the implicit one and inherits the top level.
  namedAccounts.values.channels.slack.accounts.default = {};
  const explicitDefault = await provision(namedAccounts);
  assert.equal(explicitDefault.status, 400, JSON.stringify(explicitDefault.body));
  assert.equal(
    explicitDefault.body.error.details[0].path,
    "/channels/slack/accounts/default/appToken",
  );
  delete namedAccounts.values.channels.slack.accounts.default;
  delete namedAccounts.values.channels.slack.appToken;
  delete namedAccounts.values.channels.slack.botToken;
  assert.equal((await provision(namedAccounts)).body.error.code, "DEPENDENCY_UNAVAILABLE");
  const beforeDisabled = calls;
  configuration.values.channels.slack.enabled = false;
  configuration.secretBindings = {};
  const disabled = await provision(configuration);
  assert.equal(disabled.body.error.code, "DEPENDENCY_UNAVAILABLE");
  assert.equal(calls, beforeDisabled);
});

test("Slack validation reads a whole ${NAME} token as the env SecretRef it binds", async () => {
  const controller = await configuredController({
    computeDriver: createProvisioningCapableComputeDriver(),
    configurationDriver: createProvisioningCapableConfigurationDriver(),
  });
  const { fixture, namespace, base, app, bot, saveConfiguration, createAgent, provision } =
    await createSlackValidationFixture(controller, "slack-whole-reference");
  const tokens = [];
  const channel = new SlackChannelDriver(async (url, options) => {
    assert.equal(new URL(url).pathname, "/api/auth.test");
    tokens.push(options.headers.authorization);
    return new Response(JSON.stringify({ ok: true, bot_id: "B123", team_id: "T123" }));
  });
  fixture.controller.registerDriver(channel);
  fixture.controller.selectDriver("channel", channel.id);
  // Configuration save accepts the whole-reference form and Edit Slack keeps it; OpenClaw reads
  // it as the env SecretRef to that name (finding 2511).
  const configuration = slackValidationConfiguration({
    appSource: app.ref,
    botSource: bot.ref,
    appToken: "${SLACK_APP_TOKEN}",
    botToken: "${SLACK_BOT_TOKEN}",
  });
  // The fixture has no durable work queue: its error means the plan passed channel validation,
  // which sent the bound bot token to Slack.
  assert.equal((await provision(configuration)).body.error.code, "DEPENDENCY_UNAVAILABLE");
  assert.deepEqual(tokens, ["Bearer xoxb-synthetic-bot"]);

  // The name still needs a binding: an unbound one is refused before Slack is called.
  const unbound = structuredClone(configuration);
  delete unbound.secretBindings.SLACK_BOT_TOKEN;
  const refused = await provision(unbound);
  assertApiError(refused, 400, "CHANNEL_CREDENTIAL_BINDING_REQUIRED");
  assert.equal(refused.body.error.details[0].path, "/channels/slack/botToken");
  assert.equal(tokens.length, 1);

  // Deployment of a saved Configuration applies the same rule.
  const config = await saveConfiguration(configuration);
  assert.equal(config.values.channels.slack.botToken, "${SLACK_BOT_TOKEN}");
  const agent = await createAgent("slack-whole-reference", config.id);
  await bindSlackDeploymentCredentials(fixture, namespace.id, agent, { app, bot });
  const deploy = await controller.request("POST", `${base}/agents/${agent.id}/deploy`);
  assert.equal(deploy.status, 202, JSON.stringify(deploy.body));
  assert.deepEqual(tokens, ["Bearer xoxb-synthetic-bot", "Bearer xoxb-synthetic-bot"]);
});

test("Slack activation without managed egress fails before provider transport", async () => {
  const controller = await configuredController({
    computeDriver: createProvisioningCapableComputeDriver(),
    configurationDriver: createProvisioningCapableConfigurationDriver(),
  });
  const { fixture, namespace, base, app, bot, saveConfiguration, createAgent, provision } =
    await createSlackValidationFixture(controller, "slack-no-route");
  // Managed routing is a precondition even if another API egress grant could
  // reach Slack. Admission must not probe a direct-internet fallback.
  let calls = 0;
  const channel = new SlackChannelDriver(
    async () => {
      calls++;
      throw new Error("Unexpected provider transport without managed routing");
    },
    undefined,
    { expectProxy: true },
  );
  fixture.controller.registerDriver(channel);
  fixture.controller.selectDriver("channel", channel.id);
  const configuration = slackValidationConfiguration({
    appSource: app.ref,
    botSource: app.ref,
    appToken: "${SLACK_APP_TOKEN}",
    botToken: "${SLACK_BOT_TOKEN}",
  });
  const noRoute = SLACK_ROUTE_NOT_CONFIGURED;
  configuration.secretBindings.SLACK_BOT_TOKEN.source = bot.ref;
  const refused = await provision(configuration);
  assertApiError(refused, 409, "RESOURCE_CONFLICT");
  assert.equal(refused.body.error.message, noRoute);
  assert.doesNotMatch(JSON.stringify(refused.body), /xoxb-synthetic|xapp-synthetic/);
  assert.equal(calls, 0);
  await assertNoAgentsInNamespace(fixture, namespace.id);

  // Deployment of a saved Agent gets the same answer.
  const config = await saveConfiguration(configuration);
  const agent = await createAgent("slack-no-route", config.id);
  await bindSlackDeploymentCredentials(fixture, namespace.id, agent, { app, bot });
  const deploy = await controller.request("POST", `${base}/agents/${agent.id}/deploy`);
  assertApiError(deploy, 409, "RESOURCE_CONFLICT");
  assert.equal(deploy.body.error.message, noRoute);
  assert.equal(calls, 0);
});

test("saved-Agent discovery offers managed packages only where Agent save admits them", async () => {
  // Finding 2787: the Plugin Driver's catalog takes no Agent, so OCC checks each entry against
  // the Agent's Harness and the Installation's Compute, as Agent save does.
  const sandbox = {
    id: "sandbox-native",
    capability: "sandbox",
    supportsHarnessExecutionMode: DEDICATED_OPENCLAW_SUPPORT,
    implementation: "test-native-sandbox",
    facets: ["networking", "filesystem", "process"],
    async provisionHarness() {},
    async cleanup() {},
  };
  const kubernetes = createTestKubernetesComputeDriver("compute-google-discovery", {
    sandboxDriver: sandbox,
  });
  const controller = await configuredController({ computeDriver: kubernetes });
  await bootstrap(controller);
  const namespace = await createNamespace(controller, "google-package-discovery");
  const configuration = await createConfiguration(
    controller,
    namespace.id,
    createHarnessConfiguration("openclaw", "gpt-5.1"),
  );
  const driver = new OCCPluginDriver();
  controller.fixture.controller.registerDriver(driver);
  controller.fixture.controller.selectDriver("plugin", driver.id);
  const packageId = "occ-plugin:slack@1.0.0";
  const created = await controller.request("POST", `/namespaces/${namespace.id}/agents`, {
    body: {
      name: "Discovery Agent",
      executionMode: "dedicated",
      configurationId: configuration.id,
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const path = `/namespaces/${namespace.id}/agents/${created.data.id}`;
  // Each step compares discovery with what saving the package on this Agent returns.
  const discoverAndSave = async () => {
    const catalog = await controller.request("POST", `${path}/plugins`, { body: {} });

    const details = await controller.request("POST", `${path}/plugins/details`, {
      body: { pluginId: packageId },
    });
    const save = await controller.request("PATCH", path, {
      body: { configurationId: configuration.id, plugins: { [packageId]: { enabled: true } } },
    });
    return { catalog, details, save };
  };

  // A dedicated OpenClaw Agent on Kubernetes Compute is offered the package and may save it.
  const offered = await discoverAndSave();
  assert.equal(offered.catalog.status, 200);
  assert.deepEqual(
    offered.catalog.data.plugins.map((entry) => entry.id),
    ["occ-plugin:google@1.0.0", packageId],
  );
  assert.equal(offered.details.status, 200, JSON.stringify(offered.details.body));
  assert.equal(offered.details.data.id, packageId);
  assert.equal(offered.save.status, 200, JSON.stringify(offered.save.body));
  // Finding 2790: an ID the catalog does not offer is the caller's error, not a catalog
  // failure to retry. The unversioned package ID names its versioned one.
  for (const [pluginId, advice] of [
    ["occ-plugin:google", "Use occ-plugin:google@1.0.0."],
    [
      "occ-plugin:nope@1.0.0",
      "Check each plugin ID and its Driver prefix against the catalog for the Agent's Harness.",
    ],
  ]) {
    const unknown = await controller.request("POST", `${path}/plugins/details`, {
      body: { pluginId },
    });
    assertApiError(unknown, 400, "INVALID_REQUEST");
    assert.equal(
      unknown.body.error.message,
      `A plugin selection names a plugin that the selected Plugin Driver (occ-plugin) does not offer: ${pluginId}. ${advice}`,
    );
    assert.equal(unknown.body.error.details, undefined);
  }
  // Request text outside the plugin ID shape is never echoed into the refusal.
  const unshaped = await controller.request("POST", `${path}/plugins/details`, {
    body: { pluginId: "occ-plugin:google\u202e@1.0.0" },
  });
  assertApiError(unshaped, 400, "INVALID_REQUEST");
  assert.match(unshaped.body.error.message, /\(occ-plugin\) does not offer\. Check each plugin ID/);
  const cleared = await controller.request("PATCH", path, {
    body: { configurationId: configuration.id, plugins: {} },
  });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));

  // The same Agent on the Codex Harness: save refuses the package, so discovery hides it.
  const codex = await controller.request(
    "PATCH",
    `/namespaces/${namespace.id}/configurations/${configuration.id}`,
    { body: { values: createHarnessConfiguration("codex", "gpt-5.1") } },
  );
  assert.equal(codex.status, 200, JSON.stringify(codex.body));
  const codexOffer = await discoverAndSave();
  assertApiError(codexOffer.catalog, 501, "NOT_IMPLEMENTED");
  assertApiError(codexOffer.details, 501, "NOT_IMPLEMENTED");
  assertApiError(codexOffer.save, 400, "INVALID_REQUEST");
  assert.match(
    codexOffer.save.body.error.message,
    /No Plugin Driver is enabled for the codex Harness/,
  );

  // Back on OpenClaw, Compute that cannot deliver the package refuses it the same way.
  const openclaw = await controller.request(
    "PATCH",
    `/namespaces/${namespace.id}/configurations/${configuration.id}`,
    { body: { values: createHarnessConfiguration("openclaw", "gpt-5.1") } },
  );
  assert.equal(openclaw.status, 200, JSON.stringify(openclaw.body));
  const unsupportedCompute = createReadyComputeDriver("compute-without-package-discovery", {
    validateHarnessAuth() {},
    async stopRevision() {},
  });
  for (const replacement of [sandbox, unsupportedCompute]) {
    controller.fixture.controller.registerDriver(replacement);
    controller.fixture.controller.selectDriver(replacement.capability, replacement.id);
  }
  const computeOffer = await discoverAndSave();
  assert.equal(computeOffer.catalog.status, 200);
  assert.deepEqual(computeOffer.catalog.data.plugins, []);
  assertApiError(computeOffer.save, 400, "INVALID_REQUEST");
  assert.equal(computeOffer.save.body.error.message, "Slack requires Kubernetes Compute.");
  assertApiError(computeOffer.details, 400, "INVALID_REQUEST");
  assert.equal(computeOffer.details.body.error.message, computeOffer.save.body.error.message);
});

test("ordinary deployment admits only the Configuration and Drivers whose channels were validated", async (t) => {
  for (const change of [
    "unchanged",
    "generation",
    "binding",
    "configuration",
    "configuration-driver",
    "channel",
    "channel-validator",
  ]) {
    await t.test(change, async () => {
      const { promise: reached, resolve: reach } = Promise.withResolvers();
      const { promise: released, resolve: release } = Promise.withResolvers();
      let held = false;
      const deployment = await slackFirstDeploymentFixture(true, async () => {
        if (held) {
          reach();
          await released;
        }
      });
      const { controller, namespace, agent, path, work, channelDriver, providerCalls } = deployment;
      const fixture = controller.fixture;
      const replacement = await createConfiguration(controller, namespace.id);
      const app = fixture.createApp(undefined, createFastifyApp);
      try {
        const url = await app.listen({ host: "127.0.0.1", port: 0 });
        const send = () => request(url, "POST", `${path}/deploy`, { session: app.defaultSession });
        // A normal later deployment remains intentional: seed its first admitted revision.
        const first = await send();
        assert.equal(first.status, 202, JSON.stringify(first.body));
        assert.equal(first.data.revision, 1);
        held = true;
        const pending = send();
        await reached;
        if (change === "generation") {
          const updated = await controller.request(
            "PATCH",
            `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
            {
              body: { values: { temperature: "1" } },
            },
          );
          assert.equal(updated.status, 200, JSON.stringify(updated.body));
        } else if (change === "binding") {
          const updated = await controller.request("PATCH", path, {
            body: { configurationId: replacement.id },
          });
          assert.equal(updated.status, 200, JSON.stringify(updated.body));
        } else if (change === "configuration") {
          const driver = fixture.configurationDriver;
          const saved = driver.stored({ namespaceId: namespace.id, id: agent.configurationId });
          await driver.update({ ...saved, values: { temperature: "1" } });
        } else if (change === "configuration-driver") {
          const driver = createTestConfigurationDriver({ id: "replacement-configuration" });
          fixture.controller.registerDriver(driver);
          fixture.controller.selectDriver("configuration", driver.id);
        } else if (change === "channel") {
          const driver = new SlackChannelDriver(async () => assert.fail("Unexpected provider"));
          driver.id = "replacement-channel";
          fixture.controller.registerDriver(driver);
          fixture.controller.selectDriver("channel", driver.id);
        } else if (change === "channel-validator") {
          channelDriver.validateCredentials = async () => assert.fail("Unexpected validation");
        }
        const successes = () =>
          fixture.auditSink.events.filter(
            (event) => event.action === "openclaw.agents.deploy" && event.outcome === "success",
          ).length;
        const beforeAudit = successes();
        const beforeWork = work().length;
        release();
        const result = await pending;
        assert.equal(
          result.status,
          change === "unchanged" ? 202 : 409,
          JSON.stringify(result.body),
        );
        assert.equal(providerCalls(), 2, "one provider request per attempted deployment");
        assert.equal(work().length - beforeWork, change === "unchanged" ? 1 : 0);
        assert.equal(successes() - beforeAudit, change === "unchanged" ? 1 : 0);
        const revisions = await deployment.listRevisionMetadata();
        assert.equal(revisions.length, change === "unchanged" ? 2 : 1);
        if (change === "unchanged") {
          assert.equal(result.data.revision, 2);
          assert.equal(result.data.configurationId, agent.configurationId);
        } else {
          assert.doesNotMatch(
            result.body.error.message,
            /Recover the original first-deployment receipt/,
          );
        }
      } finally {
        release();
        await app.close();
      }
    });
  }
});

test("deployment credential use retains the selected Secret storage object after its read", async () => {
  const { controller, namespace, bot, path, intent, secretDriver, providerCalls, work } =
    await slackFirstDeploymentFixture();
  const replacement = createTestSecretDriver({ id: "replacement-secret-storage" });
  controller.fixture.controller.registerDriver(replacement);
  const withValue = secretDriver.withValue.bind(secretDriver);
  secretDriver.withValue = (secret, use) =>
    withValue(secret, (value) => {
      controller.fixture.controller.selectDriver("secret", replacement.id);
      return use(value);
    });
  const result = await controller.request("POST", `${path}/deploy-first`, { body: intent });
  assert.equal(result.status, 503, JSON.stringify(result.body));
  assert.equal(providerCalls(), 0, "a replaced storage selection must prevent provider dispatch");
  assert.equal(work().length, 0);
  assert.equal(
    secretDriver.calls.filter((call) => call.operation === "withValue" && call.secret.id === bot.id)
      .length,
    1,
  );
  assert.equal(namespace.id, bot.ref.namespaceId);
});
