import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { Static } from "typebox";

import { FilesystemConfigurationDriver } from "../../apps/controller/src/drivers/configuration/filesystem/index.ts";
import { OCCPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import {
  AgentListResponse,
  AgentResponse,
  ConfigurationResponse,
  ErrorResponse,
  IAMAccessBindingListResponse,
  InstallationResponse,
  NamespaceAgentCapabilitiesResponse,
  SecretListResponse,
  WORKSPACE_DEFAULTS_ID,
  type ConfigurationValues,
  type CreateAgentBody,
  type CreateConfigurationBody,
  type PluginDesiredState,
  type ResourceRef,
  type SecretReference,
  type ValidateAgentCreateBody,
} from "../../packages/contracts/src/index.ts";
import type { PlatformStateStore } from "../../packages/occ/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { authenticatedHeaders } from "../helpers/auth-session.mjs";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { consoleFixtureClient } from "../helpers/console-fixture-client.ts";
import { grantRole } from "../helpers/iam-grants.mjs";
import { assertWriteAuthorizationDenial } from "../helpers/partial-write-authorization.ts";
import { createDenied } from "../helpers/refusal-text.mjs";

type ConsoleFixture = Awaited<ReturnType<typeof createConsoleAppFixture>>;
type Session = Awaited<ReturnType<ConsoleFixture["signIn"]>>;
type HttpResult = { status: number; body: unknown };
type PreflightBody = Omit<Static<typeof ValidateAgentCreateBody>, "plugins"> & {
  plugins?: PluginDesiredState;
};
type AgentFields = Pick<PreflightBody, "initialWorkspaceFiles" | "executionMode" | "plugins">;
type PreflightRow = { values: ConfigurationValues; fields: AgentFields };

// The real controller over HTTP: OCC, Native IAM, the bundled OpenClaw Plugin Driver and the
// fixture's test Kubernetes Compute Driver, whose workspace rule Agent create applies.
const pluginId = "occ-plugin:diffs";
const plugins = {
  [pluginId]: { enabled: true, toolDefaults: { approval: "none" } },
} satisfies PluginDesiredState;
const files = { "USER.md": "Preflight notes." };
const denyAll = { tools: { deny: ["*"] } };
// The workspace rule applies once the Configuration selects a Harness through its model.
const roster = {
  agents: {
    defaults: {
      model: "openai/gpt-5.1",
      models: { "openai/gpt-5.1": { agentRuntime: { id: "openclaw" } } },
    },
    ownership: "explicit",
    entries: { main: {}, research: {} },
  },
};

async function setup(
  t: TestContext,
  options: { configurationDriver?: FilesystemConfigurationDriver } = {},
) {
  let platformState: PlatformStateStore | undefined;
  const fixture = consoleFixtureClient(
    await createConsoleAppFixture(t, {
      ...options,
      wrapState(state: PlatformStateStore) {
        platformState = state;
        return state;
      },
    }),
  );
  await fixture.bootstrap();
  const { controller } = fixture;
  assert.ok(controller, "expected the bootstrapped Controller");
  const driver = new OCCPluginDriver();
  controller.registerDriver(driver);
  controller.selectDriver("plugin", driver.id);
  const namespace = await fixture.createNamespace("Agent create preflight", { ready: true });
  const agents = `/namespaces/${namespace.id}/agents`;
  const validate = (body: PreflightBody, session?: Session): Promise<HttpResult> =>
    fixture.request("POST", `${agents}/validate`, { session, body });
  const accept = async (body: PreflightBody, session: Session) => {
    const { response, text } = await fixture.rawRequest("POST", `${agents}/validate`, {
      headers: authenticatedHeaders(session),
      body,
    });
    assert.equal(response.status, 204, text);
    assert.equal(text, "");
    assert.equal(response.headers.get("content-length"), null);
    assert.equal(response.headers.get("cache-control"), "no-store");
  };
  // The same pair through Agent create, with the Configuration saved first as the console does.
  let created = 0;
  const create = async (
    values: ConfigurationValues,
    fields: AgentFields & Pick<CreateAgentBody, "workspaceDefaultsId">,
  ): Promise<HttpResult> => {
    const configuration = await fixture.createConfiguration(namespace.id, values);
    created += 1;
    const body: CreateAgentBody = {
      name: `preflight-agent-${created}`,
      configurationId: configuration.id,
      ...fields,
    };
    return fixture.request("POST", agents, { body });
  };
  const configurationIds = () => {
    assert.ok(platformState);
    // Configuration IDs have no public collection route. Observe the real Namespace repository
    // in a transaction that performs no writes.
    return platformState.transact((state) => state.namespaces.listConfigurationIds(namespace.id));
  };
  const listAgents = async () =>
    fixture.fixtureResponse(
      await fixture.request("GET", agents),
      200,
      AgentListResponse,
      "list Agents",
    ).data;
  const listSecrets = async () =>
    fixture.fixtureResponse(
      await fixture.request("GET", `/namespaces/${namespace.id}/secrets`),
      200,
      SecretListResponse,
      "list Secrets",
    ).data;
  const mutationCount = () =>
    fixture.auditSink.events.filter((event) => event.kind === "mutation").length;
  return {
    ...fixture,
    namespace,
    agents,
    validate,
    accept,
    create,
    configurationIds,
    listAgents,
    listSecrets,
    mutationCount,
  };
}

test("Agent create preflight refuses what Agent create refuses, with its message, and saves nothing", async (t) => {
  const f = await setup(t);
  const configurationsBefore = await f.configurationIds();
  const mutationsBefore = f.mutationCount();
  const refusals: PreflightRow[] = [
    // The plugin's every tool is denied (findings 508, 1848).
    { values: denyAll, fields: { plugins } },
    // With several roster entries, one entry's deny-all list fails its turns (finding 1860).
    // The workspace rule refuses this roster too; the plugin rule answers first, as in create.
    {
      values: {
        agents: { ...roster.agents, entries: { main: {}, research: { tools: { deny: ["*"] } } } },
      },
      fields: { plugins, initialWorkspaceFiles: files },
    },
    // Initial workspace files reach only the main Agent, so the roster must be main alone.
    { values: roster, fields: { initialWorkspaceFiles: files } },
  ];
  const answers: ErrorResponse["error"][] = [];
  for (const [index, { values, fields }] of refusals.entries()) {
    const refused = await f.validate({ configuration: { kind: "agent", values }, ...fields });
    answers.push(f.fixtureResponse(refused, 400, ErrorResponse, `preflight ${index}`).error);
  }
  const [denyAllError, rosterToolError, workspaceError] = answers;
  assert.ok(
    denyAllError && rosterToolError && workspaceError,
    "expected all three preflight refusals",
  );
  assert.match(
    denyAllError.message,
    new RegExp(`tools\\.deny blocks every tool of plugin ${pluginId}`),
  );
  assert.match(rosterToolError.message, /agents\.entries\.research\.tools\.deny/);
  assert.equal(
    workspaceError.message,
    "Configuration setting agents.entries must hold only main, or be omitted, for initial workspace files: only the main Agent reads them.",
  );
  // The preflight wrote nothing: no Secret, Configuration or Agent, and no mutation audit row.
  assert.deepEqual(await f.configurationIds(), configurationsBefore);
  assert.deepEqual(await f.listAgents(), []);
  assert.deepEqual(await f.listSecrets(), []);
  assert.equal(f.mutationCount(), mutationsBefore);
  // Agent create gives each pair the same answer once its Configuration is saved.
  for (const [index, { values, fields }] of refusals.entries()) {
    const refused = await f.create(values, fields);
    assert.deepEqual(
      f.fixtureResponse(refused, 400, ErrorResponse, `create ${index}`).error,
      answers[index],
    );
  }
  // The form saves the Configuration before Agent create runs, so Configuration create's content
  // rules answer first: here, a several-entry roster without explicit ownership.
  const unowned: CreateConfigurationBody = {
    kind: "agent",
    values: { agents: { entries: { main: {}, research: {} } } },
  };
  const content = await f.validate({ configuration: unowned, plugins });
  const saved = await f.request("POST", `/namespaces/${f.namespace.id}/configurations`, {
    body: unowned,
  });
  assert.deepEqual(
    f.fixtureResponse(content, 400, ErrorResponse, "preflight unowned roster").error,
    f.fixtureResponse(saved, 400, ErrorResponse, "save unowned roster").error,
  );
});

test("Agent create preflight accepts what Agent create accepts", async (t) => {
  const f = await setup(t);
  const session = await f.signIn();
  const accepted: PreflightRow[] = [
    // A disabled selection adds nothing to the tool allowlist.
    {
      values: denyAll,
      fields: { plugins: { [pluginId]: { enabled: false } }, initialWorkspaceFiles: files },
    },
    // Several entries are fine without initial workspace files.
    { values: roster, fields: { plugins } },
    { values: {}, fields: { plugins, initialWorkspaceFiles: files, executionMode: "embedded" } },
  ];
  for (const [index, { values, fields }] of accepted.entries()) {
    const configurationsBefore = await f.configurationIds();
    await f.accept({ configuration: { kind: "agent", values }, ...fields }, session);
    assert.deepEqual(await f.configurationIds(), configurationsBefore);
    const created = await f.create(values, {
      ...fields,
      ...(fields.initialWorkspaceFiles ? { workspaceDefaultsId: WORKSPACE_DEFAULTS_ID } : {}),
    });
    f.fixtureResponse(created, 201, AgentResponse, `create ${index}`);
  }
  // A body outside the create contract is refused as one. The name is part of it (finding 2420).
  const malformed: unknown = { configuration: { kind: "agent", values: {} }, unknown: "x" };
  const extra = await f.request("POST", `${f.agents}/validate`, { body: malformed });
  assert.equal(
    f.fixtureResponse(extra, 400, ErrorResponse, "preflight unknown field").error.code,
    "INVALID_REQUEST",
  );
});

async function setupConfigurationAdmission(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "occ-preflight-configuration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = await setup(t, { configurationDriver: new FilesystemConfigurationDriver(root) });
  const configurations = `/namespaces/${f.namespace.id}/configurations`;
  const save = (body: CreateConfigurationBody): Promise<HttpResult> =>
    f.request("POST", configurations, { body });
  const ownerSession = await f.signIn();
  const member = await f.createAccountWithPolicy("preflight-config-reader", (principal) => {
    grantRole(f.policy, principal.id, {
      id: "preflight-config-reader",
      namespaceId: f.namespace.id,
      permissions: { namespace: ["read"], agent: ["read"], configuration: ["read", "create"] },
    });
  });
  const deniedSession = await f.signIn(member.credentials);
  const nativeDocuments = async () =>
    Promise.all(
      (await readdir(root, { recursive: true })).sort().map(async (path) => {
        const file = join(root, path);
        const entry = await lstat(file);
        if (entry.isFile()) {
          return {
            path,
            kind: "file",
            sha256: createHash("sha256")
              .update(await readFile(file))
              .digest("hex"),
          };
        }
        return { path, kind: entry.isDirectory() ? "directory" : "other" };
      }),
    );
  // Keep an existing native document in every snapshot, so an unaudited overwrite cannot hide
  // behind an unchanged filename. Use the genuine HTTP save and keep document contents private.
  const existing = f.fixtureResponse(
    await save({ kind: "agent", values: {} }),
    201,
    ConfigurationResponse,
    "save initial Configuration",
  ).data;
  assert.ok((await f.configurationIds()).includes(existing.id));
  assert.ok(
    (await nativeDocuments()).some(
      (entry) => entry.path === `${f.namespace.id}/${existing.id}.json` && entry.kind === "file",
    ),
  );
  const snapshot = async () => ({
    configurations: await f.configurationIds(),
    nativeDocuments: await nativeDocuments(),
    agents: await f.listAgents(),
    secrets: await f.listSecrets(),
    accessBindings: f.fixtureResponse(
      await f.request("GET", `/namespaces/${f.namespace.id}/iam/access-bindings`),
      200,
      IAMAccessBindingListResponse,
      "list Namespace access bindings",
    ).data,
    mutations: f.mutationCount(),
  });
  async function withoutWrites<T>(operation: () => Promise<T>): Promise<T> {
    const before = await snapshot();
    const result = await operation();
    assert.deepEqual(await snapshot(), before);
    return result;
  }
  const expectRefused = async (configuration: CreateConfigurationBody, message: string) => {
    const refused = await withoutWrites(() => f.validate({ configuration }));
    const preflightError = f.fixtureResponse(
      refused,
      400,
      ErrorResponse,
      "preflight refused Configuration",
    ).error;
    assert.deepEqual(preflightError, { code: "INVALID_REQUEST", message });
    const saved = await withoutWrites(() => save(configuration));
    assert.deepEqual(
      f.fixtureResponse(saved, 400, ErrorResponse, "save refused Configuration").error,
      preflightError,
    );

    // Agent create authorization still answers before the Configuration refusal.
    const denied = await withoutWrites(async () => {
      const auditStart = f.auditSink.events.length;
      const result = await f.validate({ configuration }, deniedSession);
      assertWriteAuthorizationDenial(
        f.auditSink.events.slice(auditStart),
        {
          principalId: member.principal.id,
          action: "openclaw.agents.validate",
          grant: "create",
          resource: { kind: "agent", id: f.namespace.id, namespaceId: f.namespace.id },
        },
        "openclaw.agents.validate",
      );
      return result;
    });
    assert.deepEqual(
      f.fixtureResponse(denied, 403, ErrorResponse, "preflight denied Configuration").error,
      {
        code: "FORBIDDEN",
        message: createDenied("Agent", f.namespace.id),
      },
    );
  };
  const acceptWithoutWrites = (configuration: CreateConfigurationBody) =>
    withoutWrites(() => f.accept({ configuration }, ownerSession));
  const expectAccepted = async (configuration: CreateConfigurationBody) => {
    await acceptWithoutWrites(configuration);
    const saved = f.fixtureResponse(
      await save(configuration),
      201,
      ConfigurationResponse,
      "save accepted Configuration",
    ).data;
    // The real save proves that both independent Configuration inventories are live.
    assert.ok((await f.configurationIds()).includes(saved.id));
    assert.ok(
      (await readdir(root, { recursive: true })).includes(`${f.namespace.id}/${saved.id}.json`),
    );
  };
  return { ...f, save, withoutWrites, expectRefused, expectAccepted, acceptWithoutWrites };
}

test("Agent create preflight applies the required Configuration Driver admission", async (t) => {
  const f = await setupConfigurationAdmission(t);
  // An empty string is harmless, but only the real Configuration Driver rejects this native
  // credential slot. Compare the public errors so a different 400 cannot satisfy the case.
  await f.expectRefused(
    { kind: "agent", values: { cron: { webhookToken: "" } } },
    "Configuration field /cron/webhookToken holds a credential value inline, where a reference is required. Make the value a ${NAME} reference or a SecretRef.",
  );
  // Plain native values and a supported reference still pass admission and save.
  await f.expectAccepted({ kind: "agent", values: {} });
  await f.expectAccepted({
    kind: "agent",
    values: { cron: { webhookToken: "${PREFLIGHT_WEBHOOK_TOKEN}" } },
  });
});

test("Agent create preflight checks Configuration Secret Namespace scope without reading saved Secrets", async (t) => {
  const f = await setupConfigurationAdmission(t);
  const secret = await f.createSecret(
    f.namespace.id,
    "preflight-webhook-token",
    "synthetic-preflight-webhook-token",
  );
  const own: SecretReference = { kind: "secret", namespaceId: f.namespace.id, id: secret.id };
  const foreign = { ...own, namespaceId: `ns_${randomUUID()}` };
  const missing = { ...own, id: `sec_${randomUUID()}` };
  const configurationFor = (source: SecretReference): CreateConfigurationBody => ({
    kind: "agent",
    values: { cron: { webhookToken: "${PREFLIGHT_WEBHOOK_TOKEN}" } },
    secretBindings: {
      PREFLIGHT_WEBHOOK_TOKEN: { source, delivery: { type: "env" } },
    },
  });
  await f.expectRefused(configurationFor(foreign), "Secret references cannot cross Namespaces.");

  // A missing same-Namespace source passes the request-only check. Only the actual write
  // reads the saved Secret and returns 404; preflight must not reveal whether it exists.
  const unsavedSource = configurationFor(missing);
  await f.acceptWithoutWrites(unsavedSource);
  const missingSave = await f.withoutWrites(() => f.save(unsavedSource));
  assert.equal(
    f.fixtureResponse(missingSave, 404, ErrorResponse, "save missing Secret reference").error.code,
    "NOT_FOUND",
  );
  await f.expectAccepted(configurationFor(own));
});

test("Agent create preflight refuses a caller without Agent create as Agent create does", async (t) => {
  const f = await setup(t);
  const configuration = await f.createConfiguration(f.namespace.id, {});
  // An Agent already holds the name both requests use. The 403 must still come first: a caller
  // without Agent create never learns that the name is taken (finding 2420).
  const taken = f.fixtureResponse(
    await f.create({}, {}),
    201,
    AgentResponse,
    "create Agent holding name",
  ).data;
  // Configuration create and read, but no Agent create: the console form saves nothing for them.
  const member = await f.createAccountWithPolicy("preflight-member", (principal) => {
    grantRole(f.policy, principal.id, {
      id: "preflight-configuration-writer",
      namespaceId: f.namespace.id,
      permissions: { namespace: ["read"], agent: ["read"], configuration: ["read", "create"] },
    });
  });
  const session = await f.signIn(member.credentials);
  const target: ResourceRef = { kind: "agent", id: f.namespace.id, namespaceId: f.namespace.id };
  const preflight: PreflightBody = {
    configuration: { kind: "agent", values: denyAll },
    plugins,
    name: taken.name,
  };
  const create: CreateAgentBody = {
    name: taken.name,
    configurationId: configuration.id,
    plugins,
  };
  const deniedRequests = [
    { action: "openclaw.agents.validate", path: `${f.agents}/validate`, body: preflight },
    { action: "openclaw.agents.create", path: f.agents, body: create },
  ];
  for (const { action, path, body } of deniedRequests) {
    const auditStart = f.auditSink.events.length;
    const refused = await f.request("POST", path, { session, body });
    // The same refusal as Agent create: the deny-all pair is never evaluated for this caller.
    assert.deepEqual(f.fixtureResponse(refused, 403, ErrorResponse, action).error, {
      code: "FORBIDDEN",
      message: createDenied("Agent", f.namespace.id),
    });
    assertWriteAuthorizationDenial(
      f.auditSink.events.slice(auditStart),
      { principalId: member.principal.id, action, grant: "create", resource: target },
      action,
    );
  }
});

test("ordinary creators enable browser access atomically on an unshared Configuration", async (t) => {
  // A root dot and surrounding whitespace do not consume the DNS hostname budget.
  const domain = `${"a.".repeat(99)}oce.localhost`;
  assert.equal(domain.length, 211);
  const canonicalDomain = `aaa${domain}`;
  assert.equal(canonicalDomain.length, 214);
  const f = consoleFixtureClient(
    await createConsoleAppFixture(t, {
      publicOrigin: true,
      nativeAdmin: { enabled: true, domain: `  ${canonicalDomain.toUpperCase()}.  ` },
      nativeAdminGatewayApiKey: "synthetic-browser-create-service-key",
      filesystemConfiguration: true,
    }),
  );
  const bootstrapped = await f.request("POST", "/installation/bootstrap", {
    body: { name: "Browser creation integration" },
  });
  f.fixtureResponse(bootstrapped, 201, InstallationResponse, "bootstrap Installation");
  const namespace = await f.createNamespace("Browser chat creators", { ready: true });
  const member = await f.createNamespaceMember("browser-creator", namespace.id, [
    ["read", "namespace"],
    ["create", "agent"],
    ["read", "agent"],
    ["read", "configuration"],
    ["create", "configuration"],
    ["update", "configuration"],
  ]);
  const session = await f.signIn(member.credentials);
  const installation = await f.request("GET", "/installation", { session });
  f.fixtureResponse(installation, 403, ErrorResponse, "creator cannot read Installation");
  const capabilities = await f.request("GET", `/namespaces/${namespace.id}/agent-capabilities`, {
    session,
  });
  const { data } = f.fixtureResponse(
    capabilities,
    200,
    NamespaceAgentCapabilitiesResponse,
    "read Namespace Agent capabilities",
  );
  assert.equal(data.capabilities.nativeAdmin, true);
  assert.equal("agentProvisioning" in data.capabilities, false);
  const agents = `/namespaces/${namespace.id}/agents`;
  const configurations = `/namespaces/${namespace.id}/configurations`;
  const readConfiguration = async (id: string) =>
    f.fixtureResponse(
      await f.request("GET", `${configurations}/${id}`, { session }),
      200,
      ConfigurationResponse,
      "read Configuration",
    ).data;
  const freshConfiguration = async () => {
    const body: CreateConfigurationBody = { kind: "agent", values: {} };
    const result = await f.request("POST", configurations, {
      session,
      body,
    });
    return f.fixtureResponse(result, 201, ConfigurationResponse, "save browser Configuration").data;
  };
  const config = await freshConfiguration();
  const body: CreateAgentBody = {
    name: "browser-agent",
    configurationId: config.id,
    nativeAdmin: true,
    expectedConfigurationGeneration: 1,
  };
  const created = f.fixtureResponse(
    await f.request("POST", agents, { session, body }),
    201,
    AgentResponse,
    "create browser Agent",
  ).data;
  const saved = await readConfiguration(config.id);
  assert.equal(saved.generation, 2);
  const gateway = asRecord(asRecord(saved.values)?.gateway);
  assert.ok(gateway, "expected native Gateway configuration");
  const controlUi = asRecord(gateway.controlUi);
  assert.ok(controlUi, "expected native Control UI configuration");
  assert.equal(controlUi.enabled, true);
  const origins = controlUi.allowedOrigins;
  assert.ok(Array.isArray(origins), "expected a list of Control UI origins");
  assert.equal(origins.length, 1);
  const origin: unknown = origins[0];
  assert.ok(typeof origin === "string", "expected an HTTPS origin string");
  const nativeOrigin = new URL(origin);
  assert.equal(nativeOrigin.protocol, "https:");
  assert.ok(nativeOrigin.hostname.endsWith(`.${canonicalDomain}`));
  assert.equal(nativeOrigin.hostname.length, 253);
  assert.equal(nativeOrigin.port, new URL(f.origin).port);
  const trustedProxy = asRecord(asRecord(gateway.auth)?.trustedProxy);
  assert.ok(trustedProxy, "expected trusted proxy authentication");
  const requiredHeaders = trustedProxy.requiredHeaders;
  assert.ok(Array.isArray(requiredHeaders), "expected a list of trusted proxy headers");
  assert.ok(requiredHeaders.some((header: unknown) => header === "x-openclaw-scopes"));
  const event = f.auditSink.events.find(
    (event) => event.action === "openclaw.agents.create" && event.resource.id === created.id,
  );
  assert.ok(event, "expected an audit event for Agent creation");
  assert.equal(event.kind, "mutation");
  assert.equal(event.actor?.principalId, member.principal.id);
  assert.ok(event.details, "expected Agent creation audit details");
  assert.equal(event.details.browserAccess, true);
  const preparedConfiguration = asRecord(event.details.preparedConfiguration);
  assert.ok(preparedConfiguration, "expected the prepared Configuration in the audit details");
  assert.equal(preparedConfiguration.id, config.id);

  // Reusing a referenced Configuration must not retarget the first Agent's browser origin.
  const shared = await f.request("POST", agents, {
    session,
    body: { ...body, name: "shared-browser", expectedConfigurationGeneration: 2 },
  });
  f.fixtureResponse(shared, 409, ErrorResponse, "refuse shared Configuration");
  assert.deepEqual(await readConfiguration(config.id), saved);
  const unused = await freshConfiguration();
  const unusedBody = { ...body, configurationId: unused.id };
  const stale = await f.request("POST", agents, {
    session,
    body: { ...unusedBody, expectedConfigurationGeneration: 2 },
  });
  f.fixtureResponse(stale, 409, ErrorResponse, "refuse stale Configuration generation");
  // A duplicate-name failure happens after native preparation. The filesystem document
  // and metadata must both roll back rather than leave an origin for a nonexistent Agent.
  const duplicate = await f.request("POST", agents, { session, body: unusedBody });
  f.fixtureResponse(duplicate, 409, ErrorResponse, "refuse duplicate Agent name");
  assert.deepEqual(await readConfiguration(unused.id), unused);
  const readonly = await f.createNamespaceMember("browser-config-reader", namespace.id, [
    ["create", "agent"],
    ["read", "configuration"],
  ]);
  const denied = await f.request("POST", agents, {
    session: await f.signIn(readonly.credentials),
    body: { ...unusedBody, name: "cannot-configure" },
  });
  f.fixtureResponse(
    denied,
    403,
    ErrorResponse,
    "refuse browser preparation without Configuration update",
  );
  const listed = await f.request("GET", agents, { session });
  assert.equal(
    f.fixtureResponse(listed, 200, AgentListResponse, "list creator's Agents").data.length,
    1,
  );
});
