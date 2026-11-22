import { isDeepStrictEqual } from "node:util";
import type { GitHubRepositoryPolicy } from "../../apps/controller/src/drivers/repo/github/policy.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";
import type { createFastifyApp } from "../../apps/controller/src/index.ts";
import {
  SandboxPolicyResponse,
  SandboxPolicyViewResponse,
} from "../../packages/contracts/src/api/sandbox-policy.ts";
import { CodexPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import type { GitHubRepositoryRegistry } from "../../apps/controller/src/drivers/repo/github/access/registry.ts";
import {
  AgentListResponse,
  AgentReadResponse,
  AgentRevisionListResponse,
  AgentRevisionReadResponse,
  AgentRevisionResponse,
  AgentResponse,
  AgentSchema,
  ConfigurationResponse,
  ConfigurationSchema,
  CredentialSourceResponse,
  ErrorResponse,
  JsonValue,
  Meta,
  NamespaceSchema,
  PluginApproversSchema,
  PluginDesiredSelectionSchema,
  PluginDesiredStateSchema,
  PluginDriverIdentitySchema,
  PluginToolDefaultsSchema,
  PluginToolPolicySchema,
  RepositoryOptionListResponse,
  SecretResponse,
  type AgentWire,
  type ComputeDriver,
  type ConfigurationDriver,
  type CreateAgentBody,
  type LegacyEgressProxyDriver,
  type Identity,
  type Namespace,
  type OpenClawConfigurationValue,
  type PluginDesiredState,
  type ProvisionAgentBody,
  type RepositoryBindingSelection,
  type RepositoryNetworkGrant,
  type SandboxPolicy,
  type SandboxDriver,
} from "../../packages/contracts/src/index.ts";
import {
  InstalledDriver,
  type InMemoryPlatformState,
  type OpenClawController,
} from "../../packages/occ/src/index.ts";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { grantRole } from "../helpers/iam-grants.ts";
import { assertSameAnswer } from "../helpers/refusal-answers.ts";
import {
  BROKER_PROXY_DISABLED,
  BROKER_PROXY_DOMAIN_DECISION,
  BROKER_PROXY_DOMAINS,
  BROKER_PROXY_EMPTY_HOST,
  BROKER_PROXY_LOCAL_BINDING,
  BROKER_PROXY_MODE,
  COMPUTE_REPOSITORY_UNSUPPORTED,
  COMPUTE_TOPOLOGY_REPOSITORY_UNSUPPORTED,
  REPOSITORY_SELECTION_NOT_APPROVED,
  REPOSITORY_SETTINGS_MISSING,
  runtimeIdUnsupported,
  SAVED_REPOSITORY_SELECTION_NOT_APPROVED,
} from "../helpers/refusal-text.mjs";
import { CODEX_NEEDS_DEDICATED } from "../helpers/refusal-configuration-runtime.ts";
import { DEDICATED_OPENCLAW_SUPPORT } from "../helpers/sandbox-driver.ts";

type App = ReturnType<typeof createFastifyApp>;
interface FixtureOptions {
  readonly compute?: ComputeDriver;
  readonly configurationDriver?: ConfigurationDriver;
  readonly harness?: string;
  readonly repositories?: boolean;
}

interface HttpResponse {
  readonly status: number;
  readonly [field: string]: unknown;
}

type Request = (
  method: "GET" | "POST" | "PATCH" | "PUT",
  path: string,
  payload?: unknown,
) => Promise<HttpResponse>;

interface Composition {
  readonly app: App;
  readonly request: Request;
}

interface AdmissionFixture extends Composition {
  readonly collection: string;
  readonly configuration: unknown;
  readonly controller: OpenClawController;
  readonly namespace: unknown;
  readonly registry: GitHubRepositoryRegistry;
  readonly state: InMemoryPlatformState;
  compose(registry: GitHubRepositoryRegistry): Promise<Composition>;
  createAgent(fields?: Partial<CreateAgentBody>): Promise<unknown>;
  prepareDeployment(agent: AgentWire): Promise<void>;
  requestWithoutGrants(app: App): Promise<Request>;
}

interface DeploymentAdmissionFixtures {
  fixture(t: TestContext, options?: FixtureOptions): Promise<AdmissionFixture>;
  kubernetesCompute(): ComputeDriver;
  sshCompute(): ComputeDriver;
  codexProxyValues(harness: string, networkProxy: OpenClawConfigurationValue): unknown;
  readonly selection: RepositoryBindingSelection[];
  readonly driverId: string;
  readonly backendId: string;
}

const schemaContext = {
  SafeJsonValue: JsonValue,
  PluginDriverIdentity: PluginDriverIdentitySchema,
  PluginApprovers: PluginApproversSchema,
  PluginToolPolicy: PluginToolPolicySchema,
  PluginToolDefaults: PluginToolDefaultsSchema,
  PluginDesiredSelection: PluginDesiredSelectionSchema,
  PluginDesiredState: PluginDesiredStateSchema,
};

function checkedEnvelope<Schema extends TSchema>(
  response: HttpResponse,
  schema: Schema,
  status: number,
  label?: string,
) {
  const message =
    label === undefined ? JSON.stringify(response) : `${label}: ${JSON.stringify(response)}`;
  assert.equal(response.status, status, message);
  // The shared authenticated request adds status to the serialized HTTP body.
  const { status: _status, ...body } = response;
  assert.ok(Check(schemaContext, schema, body), message);
  return body;
}

export async function verifyRepositoryPolicyWriteProjection(
  fixture: Composition & {
    readonly namespace: { readonly id: string };
    readonly configuration: { readonly id: string };
    readonly iamState: Parameters<typeof grantRole>[0];
    requestWithoutGrants(app: App, grant: (principalId: string) => void): Promise<Request>;
  },
  editableAgent: () => Promise<{
    readonly policyPath: string;
  }>,
  sourceId: string,
  grant: RepositoryNetworkGrant,
) {
  const absent = await editableAgent();
  const present = await editableAgent();
  const read = async (path: string) =>
    checkedEnvelope(await fixture.request("GET", path), SandboxPolicyViewResponse, 200).data.policy;
  const original = await read(absent.policyPath);
  const initial = await read(present.policyPath);
  for (const policy of [original, initial]) {
    assert.equal(Object.hasOwn(policy, "repositoryNetworkPolicy"), false);
  }

  // Grant read on the Agent, Configuration and Harness source, plus mutation
  // on these two policies. Policy read remains unavailable to this account.
  const edit = await fixture.requestWithoutGrants(fixture.app, (principalId) => {
    const namespaceId = fixture.namespace.id;
    for (const policy of [original, initial]) {
      grantRole(fixture.iamState, principalId, {
        id: "manage-" + policy.agentId,
        namespaceId,
        resource: { kind: "agent", id: policy.agentId },
        permissions: { agent: ["read", "manage_policy"] },
      });
      grantRole(fixture.iamState, principalId, {
        id: "update-" + policy.id,
        namespaceId,
        resource: { kind: "sandbox_policy", id: policy.id },
        permissions: { sandbox_policy: ["update"] },
      });
    }
    grantRole(fixture.iamState, principalId, {
      id: "read-policy-configuration",
      namespaceId,
      resource: { kind: "configuration", id: fixture.configuration.id },
      permissions: { configuration: ["read"] },
    });
    grantRole(fixture.iamState, principalId, {
      id: "read-policy-source",
      namespaceId,
      resource: { kind: "credential_source", id: sourceId },
      permissions: { credential_source: ["read"] },
    });
  });
  assert.equal((await edit("GET", absent.policyPath)).status, 403);
  assert.equal((await edit("GET", present.policyPath)).status, 403);

  const update = (
    path: string,
    expectedVersion: number,
    repositoryNetworkPolicy?: readonly RepositoryNetworkGrant[],
  ) =>
    edit("PUT", path, {
      expectedVersion,
      additions: [],
      ...(repositoryNetworkPolicy === undefined ? {} : { repositoryNetworkPolicy }),
    });
  const saved = checkedEnvelope(
    await update(present.policyPath, initial.version, [grant]),
    SandboxPolicyResponse,
    200,
  ).data;
  assert.deepEqual(saved.repositoryNetworkPolicy, [grant]);
  // Align versions with ordinary saves and check that the response omits both
  // an absent list and the existing list, which this caller cannot read.
  const omitted = checkedEnvelope(
    await update(present.policyPath, saved.version),
    SandboxPolicyResponse,
    200,
  ).data;
  assert.equal(Object.hasOwn(omitted, "repositoryNetworkPolicy"), false);
  const advance = checkedEnvelope(
    await update(absent.policyPath, original.version),
    SandboxPolicyResponse,
    200,
  ).data;
  const omittedAbsent = checkedEnvelope(
    await update(absent.policyPath, advance.version),
    SandboxPolicyResponse,
    200,
  ).data;
  assert.equal(Object.hasOwn(omittedAbsent, "repositoryNetworkPolicy"), false);
  assert.equal(omittedAbsent.version, omitted.version);

  const before = await read(absent.policyPath);
  const existing = await read(present.policyPath);
  assert.equal(Object.hasOwn(before, "repositoryNetworkPolicy"), false);
  assert.deepEqual(existing.repositoryNetworkPolicy, [grant]);
  const first = checkedEnvelope(
    await update(absent.policyPath, before.version, []),
    ErrorResponse,
    403,
    "first deny-all save without SandboxPolicy read",
  ).error;
  const withdrawal = checkedEnvelope(
    await update(present.policyPath, existing.version, []),
    ErrorResponse,
    403,
    "withdrawal without SandboxPolicy read",
  ).error;
  assert.deepEqual(
    { ...first, message: first.message.replaceAll(before.id, "<policy>") },
    { ...withdrawal, message: withdrawal.message.replaceAll(existing.id, "<policy>") },
  );
  assert.deepEqual(await read(absent.policyPath), before);
  assert.deepEqual(await read(present.policyPath), existing);
}

function narrowRepositoryPolicy(
  registry: GitHubRepositoryRegistry,
  namespaceId: string,
): GitHubRepositoryRegistry {
  const project = registry.repositories.find(({ repositoryRef }) => repositoryRef === "project");
  assert.ok(project);
  const grant = project.namespaces.find((entry) => entry.namespaceId === namespaceId);
  assert.ok(grant);
  return {
    ...registry,
    repositories: registry.repositories.map((repository) =>
      repository === project
        ? {
            ...project,
            namespaces: project.namespaces.map((entry) =>
              entry === grant ? { ...grant, profiles: ["git-read"] } : entry,
            ),
          }
        : repository,
    ),
  };
}

function assertBrokerProxyRefused(response: HttpResponse, message: string, label: string) {
  const { error } = checkedEnvelope(response, ErrorResponse, 400, label);
  assert.equal(error.code, "INVALID_REQUEST", label);
  assert.equal(error.message, message, label);
}

type BrokerProxyRefusal = {
  readonly label: string;
  readonly networkProxy: OpenClawConfigurationValue;
  readonly message: string;
};

// Kubernetes Compute sends a Codex Harness's repository traffic through its Codex network proxy
// and refused a proxy setting that blocks the broker only in preparation, after a dedicated
// deployment had stopped the running revision (finding 2350). Configuration save does not know
// which Agents use the Configuration, so Agent save, provisioning and deployment refuse it, with
// the text preparation uses. A deny of the broker host itself stays with preparation, the only
// step that knows the host (tests/conformance/repository-runtime-material.test.ts).
const brokerProxyRefusals: readonly BrokerProxyRefusal[] = [
  { label: "disabled", networkProxy: { enabled: false }, message: BROKER_PROXY_DISABLED },
  {
    label: "unknown mode",
    networkProxy: { enabled: true, mode: "offline" },
    message: BROKER_PROXY_MODE,
  },
  {
    label: "local binding",
    networkProxy: { enabled: true, allowLocalBinding: "yes" },
    message: BROKER_PROXY_LOCAL_BINDING,
  },
  {
    label: "domains list",
    networkProxy: { enabled: true, domains: ["github.com"] },
    message: BROKER_PROXY_DOMAINS,
  },
  {
    label: "domain decision",
    networkProxy: { enabled: true, domains: { "github.com": "block" } },
    message: BROKER_PROXY_DOMAIN_DECISION,
  },
  {
    label: "empty host",
    networkProxy: { enabled: true, domains: { " ": "allow" } },
    message: BROKER_PROXY_EMPTY_HOST,
  },
];

export function registerRepositoryCredentialsDeploymentAdmissionCases({
  fixture: admissionFixture,
  kubernetesCompute,
  sshCompute,
  codexProxyValues: buildCodexProxyValues,
  selection,
  driverId,
  backendId,
}: DeploymentAdmissionFixtures): void {
  async function fixture(t: TestContext, options?: FixtureOptions) {
    const f = await admissionFixture(t, options);
    const { namespace, configuration } = f;
    assert.ok(Check(schemaContext, NamespaceSchema, namespace));
    assert.ok(Check(schemaContext, ConfigurationSchema, configuration));
    return {
      ...f,
      namespace,
      configuration,
      async createAgent(fields?: Partial<CreateAgentBody>) {
        const agent = await f.createAgent(fields);
        assert.ok(Check(schemaContext, AgentSchema, agent));
        return agent;
      },
    };
  }

  function codexProxyValues(harness: string, networkProxy: OpenClawConfigurationValue) {
    const values = buildCodexProxyValues(harness, networkProxy);
    assert.ok(Check(schemaContext, ConfigurationSchema.properties.values, values));
    return values;
  }

  test("Deploy freezes public repository selection without exposing provider grants", async (t) => {
    const f = await fixture(t);
    const agent = await f.createAgent({ repositoryBindings: [{ repositoryRef: "project" }] });
    await f.prepareDeployment(agent);
    const path = `${f.collection}/${agent.id}`;
    const { data: deployed } = checkedEnvelope(
      await f.request("POST", `${path}/deploy`),
      AgentRevisionResponse,
      202,
    );
    const snapshot = deployed.repositoryCredentials;
    assert.ok(snapshot);
    assert.deepEqual(Object.keys(snapshot).sort(), ["bindings", "deadlineWallMs", "driver"]);
    assert.deepEqual(snapshot.bindings, selection);
    assert.equal(snapshot.driver.id, driverId);
    assert.equal(typeof snapshot.driver.implementation, "string");
    assert.equal(snapshot.deadlineWallMs, Date.parse(deployed.createdAt) + 600_000);
    const internal = await f.state.read((view) =>
      view.revisions.findRevision(f.namespace.id, agent.id, deployed.id),
    );
    const privateBinding = internal?.repositoryCredentials?.bindings[0];
    assert.ok(privateBinding);
    assert.equal(privateBinding.backendId, backendId);
    assert.equal(privateBinding.grant.repositoryId, "789");

    const cleared = await f.request("PATCH", path, {
      configurationId: f.configuration.id,
      repositoryBindings: [],
    });
    assert.equal(cleared.status, 200);
    const { data: historical } = checkedEnvelope(
      await f.request("GET", `${path}/revisions/${deployed.id}`),
      AgentRevisionReadResponse,
      200,
    );
    assert.ok(!("configurationReadError" in historical));
    assert.deepEqual(historical.repositoryCredentials, snapshot);
    // The list names the revision without its saved settings; the snapshot stays on the GET.
    const {
      data: [listed],
    } = checkedEnvelope(
      await f.request("GET", `${path}/revisions`),
      AgentRevisionListResponse,
      200,
    );
    assert.ok(listed);
    assert.equal(listed.id, deployed.id);
    assert.equal(Object.hasOwn(listed, "repositoryCredentials"), false);
    const { data: independent } = checkedEnvelope(
      await f.request("POST", `${path}/deploy`),
      AgentRevisionResponse,
      202,
    );
    assert.equal(Object.hasOwn(independent, "repositoryCredentials"), false);
  });

  test("Deploy rechecks repository policy after a draft was accepted", async (t) => {
    const f = await fixture(t);
    const agent = await f.createAgent({ repositoryBindings: selection });
    await f.prepareDeployment(agent);
    // Recomposition replaces operator policy; an accepted draft is not a permanent grant.
    const reconfigured = await f.compose(narrowRepositoryPolicy(f.registry, f.namespace.id));
    const path = `${f.collection}/${agent.id}`;
    // The request sends no selections: the saved ones are refused as saved state, a 409, both by
    // deploy and by the standing approval review that reads them (finding 2536).
    for (const { method, suffix } of [
      { method: "POST", suffix: "/deploy" },
      { method: "GET", suffix: "/repository-approval-scopes" },
    ] as const) {
      const { error } = checkedEnvelope(
        await reconfigured.request(method, `${path}${suffix}`),
        ErrorResponse,
        409,
        suffix,
      );
      assert.equal(error.code, "RESOURCE_CONFLICT", suffix);
      assert.equal(error.message, SAVED_REPOSITORY_SELECTION_NOT_APPROVED, suffix);
    }
    const { data: revisions } = checkedEnvelope(
      await reconfigured.request("GET", `${path}/revisions`),
      AgentRevisionListResponse,
      200,
    );
    assert.deepEqual(revisions, []);
    const { data: unchanged } = checkedEnvelope(
      await reconfigured.request("GET", path),
      AgentReadResponse,
      200,
    );
    assert.ok(!("configurationReadError" in unchanged));
    assert.deepEqual(unchanged.repositoryBindings, selection);
    assert.equal(unchanged.desiredRuntimeState, "stopped");
  });

  test("Repository refusals wait for the Agent grant: a missing and an unreadable Agent answer alike", async (t) => {
    // Finding 2536 names repository refusals at save and deploy. They run only after the caller's
    // grant on the Agent, so a caller without it learns nothing from them: the same request gets
    // the same answer for an Agent that exists and one that does not, each request's ID hidden.
    const f = await fixture(t);
    const agent = await f.createAgent({ repositoryBindings: selection });
    await f.prepareDeployment(agent);
    const reconfigured = await f.compose(narrowRepositoryPolicy(f.registry, f.namespace.id));
    const outsider = await f.requestWithoutGrants(reconfigured.app);
    const missing = `agt_${randomUUID()}`;
    const refusedSave = {
      configurationId: f.configuration.id,
      repositoryBindings: [{ repositoryRef: "missing" }],
    };
    for (const { method, suffix, body, status, message } of [
      {
        method: "PATCH",
        suffix: "",
        body: refusedSave,
        status: 400,
        message: REPOSITORY_SELECTION_NOT_APPROVED,
      },
      {
        method: "POST",
        suffix: "/deploy",
        body: undefined,
        status: 409,
        message: SAVED_REPOSITORY_SELECTION_NOT_APPROVED,
      },
    ] as const) {
      // The same request from the administrator meets the named refusal.
      const { error } = checkedEnvelope(
        await reconfigured.request(method, `${f.collection}/${agent.id}${suffix}`, body),
        ErrorResponse,
        status,
      );
      assert.equal(error.message, message);
      await assertSameAnswer(
        (id) => outsider(method, `${f.collection}/${id}${suffix}`, body),
        [agent.id, missing],
        { label: `${method} ${suffix}` },
      );
    }
    // Agent create names the refusal only after the Namespace grant: an outsider gets the same
    // answer for this Namespace and for one that does not exist.
    const refusedCreate = { name: "Refused Agent", ...refusedSave };
    const { error } = checkedEnvelope(
      await reconfigured.request("POST", f.collection, refusedCreate),
      ErrorResponse,
      400,
    );
    assert.equal(error.message, REPOSITORY_SELECTION_NOT_APPROVED);
    await assertSameAnswer(
      (id) => outsider("POST", `/namespaces/${id}/agents`, refusedCreate),
      [f.namespace.id, `ns_${randomUUID()}`],
      { label: "POST agents" },
    );
  });

  test("Unsupported Compute refuses repository deployment while ordinary deployment remains optional", async (t) => {
    const f = await fixture(t, { compute: sshCompute() });
    const options = checkedEnvelope(
      await f.request("GET", `${f.collection}/repository-options`),
      ErrorResponse,
      503,
    );
    assert.equal(options.error.code, "REPOSITORY_OPTIONS_UNAVAILABLE");
    const agent = await f.createAgent({
      repositoryBindings: selection,
      harnessAuth: { method: "runtime" },
      gatewayManagedMode: false,
    });
    await f.prepareDeployment(agent);
    const path = `${f.collection}/${agent.id}`;
    // A permanent Installation property, not an outage to retry (finding 2536).
    const denied = await f.request("POST", `${path}/deploy`);
    const { error } = checkedEnvelope(denied, ErrorResponse, 409);
    assert.equal(error.code, "RESOURCE_CONFLICT");
    assert.equal(error.message, COMPUTE_REPOSITORY_UNSUPPORTED);
    assert.deepEqual(
      checkedEnvelope(await f.request("GET", `${path}/revisions`), AgentRevisionListResponse, 200)
        .data,
      [],
    );
    const cleared = await f.request("PATCH", path, {
      configurationId: f.configuration.id,
      repositoryBindings: [],
    });
    assert.equal(cleared.status, 200);
    const { data: ordinary } = checkedEnvelope(
      await f.request("POST", `${path}/deploy`),
      AgentRevisionResponse,
      202,
    );
    assert.equal(Object.hasOwn(ordinary, "repositoryCredentials"), false);
  });

  test("Repository admission retains unknown Harness and execution-mode rejection", async (t) => {
    for (const { harness, executionMode, status, code, message, boundary } of [
      // An unsupported runtime identity is Configuration content, not a missing resource.
      // Configuration save refuses it (finding 3020), so only a row an older release stored
      // reaches deployment.
      {
        harness: "unknown",
        executionMode: "embedded",
        status: 400,
        code: "INVALID_REQUEST",
        message: runtimeIdUnsupported('agents.defaults.models["openai/gpt-5.1"]'),
        boundary: "stored",
      },
      // Kubernetes cannot deliver repository credentials to dedicated OpenClaw, so Agent save
      // refuses this Harness/mode pair before deployment admission.
      {
        harness: "openclaw",
        executionMode: "dedicated",
        status: 409,
        code: "RESOURCE_CONFLICT",
        message: COMPUTE_TOPOLOGY_REPOSITORY_UNSUPPORTED,
        boundary: "save",
      },
      // A Harness/mode mismatch names the execution mode the Configuration needs, at Agent save
      // as at deployment.
      {
        harness: "codex",
        executionMode: "embedded",
        status: 400,
        code: "INVALID_REQUEST",
        message: CODEX_NEEDS_DEDICATED,
        boundary: "save",
      },
    ] as const) {
      await t.test(`${harness}/${executionMode}`, async (t) => {
        const configurationDriver = createTestConfigurationDriver();
        const f = await fixture(t, {
          harness: boundary === "stored" ? "openclaw" : harness,
          configurationDriver,
        });
        if (boundary === "save") {
          const refused = await f.request("POST", f.collection, {
            name: `Repository Agent ${randomUUID()}`,
            configurationId: f.configuration.id,
            executionMode,
            repositoryBindings: selection,
          });
          const { error } = checkedEnvelope(refused, ErrorResponse, status);
          assert.equal(error.code, code);
          assert.equal(error.message, message);
          assert.deepEqual(
            checkedEnvelope(await f.request("GET", f.collection), AgentListResponse, 200).data,
            [],
          );
          return;
        }
        const agent = await f.createAgent({ executionMode, repositoryBindings: selection });
        await f.prepareDeployment(agent);
        // Written past OCC, as an older release's Configuration save stored it.
        const { gateway, ...native } = createHarnessConfiguration(harness, "gpt-5.1");
        const { auth: _auth, ...gatewayValues } = gateway;
        const values = { ...native, gateway: gatewayValues };
        const stored = configurationDriver.stored({
          namespaceId: f.namespace.id,
          id: f.configuration.id,
        });
        assert.ok(stored);
        assert.ok(Check(schemaContext, ConfigurationSchema.properties.values, values));
        await configurationDriver.update({ ...stored, values });
        const path = `${f.collection}/${agent.id}`;
        const denied = await f.request("POST", `${path}/deploy`);
        const { error } = checkedEnvelope(denied, ErrorResponse, status);
        assert.equal(error.code, code);
        assert.equal(error.message, message);
        assert.deepEqual(
          checkedEnvelope(
            await f.request("GET", `${path}/revisions`),
            AgentRevisionListResponse,
            200,
          ).data,
          [],
        );
      });
    }
    const f = await fixture(t);
    const invalidMode = await f.request("POST", f.collection, {
      name: "Unknown mode",
      configurationId: f.configuration.id,
      repositoryBindings: selection,
      executionMode: "unknown",
    });
    const { error } = checkedEnvelope(invalidMode, ErrorResponse, 400);
    assert.equal(error.code, "INVALID_REQUEST");
    assert.deepEqual(
      checkedEnvelope(await f.request("GET", f.collection), AgentListResponse, 200).data,
      [],
    );
  });

  test("Dedicated repository admission still rejects a selected Sandbox Driver", async (t) => {
    const f = await fixture(t, { harness: "codex" });
    const agent = await f.createAgent({
      executionMode: "dedicated",
      repositoryBindings: selection,
    });
    await f.prepareDeployment(agent);
    // Selecting Sandbox changes the admitted topology; no Sandbox runtime is invoked.
    const sandbox: SandboxDriver = {
      id: "repository-admission-sandbox",
      capability: "sandbox",
      implementation: "test-sandbox",
      supportsHarnessExecutionMode: DEDICATED_OPENCLAW_SUPPORT,
      facets: ["networking", "filesystem", "process"],
      async cleanup() {},
    };
    f.controller.registerDriver(sandbox);
    f.controller.selectDriver("sandbox", sandbox.id);
    const path = `${f.collection}/${agent.id}`;
    const denied = await f.request("POST", `${path}/deploy`);
    const { error } = checkedEnvelope(denied, ErrorResponse, 409);
    assert.equal(error.code, "RESOURCE_CONFLICT");
    assert.deepEqual(
      checkedEnvelope(await f.request("GET", `${path}/revisions`), AgentRevisionListResponse, 200)
        .data,
      [],
    );
  });

  test("Kubernetes admission supports dedicated Codex repositories for every profile", async (t) => {
    for (const profile of ["git-read", "git-write", "git-full"]) {
      await t.test(profile, async (t) => {
        const f = await fixture(t, { harness: "codex" });
        const bindings = [{ repositoryRef: "project", profile }];
        const agent = await f.createAgent({
          executionMode: "dedicated",
          repositoryBindings: bindings,
        });
        assert.deepEqual(agent.repositoryBindings, bindings);
        await f.prepareDeployment(agent);
        const path = `${f.collection}/${agent.id}`;
        const { data: deployed } = checkedEnvelope(
          await f.request("POST", `${path}/deploy`),
          AgentRevisionResponse,
          202,
        );
        assert.deepEqual(deployed.harness, {
          id: "codex",
          version: "1.0.0",
          mode: "dedicated",
          overrides: {},
          configuration: {
            modelProvider: {
              protocol: "openai-responses",
              baseUrl: "https://api.openai.com/v1",
              supportsStandaloneWebSearch: false,
            },
          },
        });
        assert.ok(deployed.repositoryCredentials);
        assert.deepEqual(deployed.repositoryCredentials.bindings, bindings);
        const { data: historical } = checkedEnvelope(
          await f.request("GET", `${path}/revisions/${deployed.id}`),
          AgentRevisionReadResponse,
          200,
        );
        assert.ok(!("configurationReadError" in historical));
        assert.deepEqual(historical.repositoryCredentials, deployed.repositoryCredentials);
      });
    }
  });

  test("Agent save and deployment refuse a Codex network proxy that blocks the repository broker", async (t) => {
    const f = await fixture(t, { harness: "codex" });
    const configurationPath = `/namespaces/${f.namespace.id}/configurations/${f.configuration.id}`;
    // A limited proxy with its own allowlist lets Compute add the broker host: it deploys.
    const allowing = await f.request("PATCH", configurationPath, {
      values: codexProxyValues("codex", {
        enabled: true,
        mode: "limited",
        domains: { "github.com": "allow" },
      }),
    });
    assert.equal(allowing.status, 200, JSON.stringify(allowing));
    const agent = await f.createAgent({
      executionMode: "dedicated",
      repositoryBindings: selection,
    });
    await f.prepareDeployment(agent);
    const path = `${f.collection}/${agent.id}`;
    const { data: savedRevision } = checkedEnvelope(
      await f.request("POST", `${path}/deploy`),
      AgentRevisionResponse,
      202,
    );

    for (const { label, networkProxy, message } of brokerProxyRefusals) {
      // Configuration edits succeed independently of the Agent's next deployment.
      const edited = await f.request("PATCH", configurationPath, {
        values: codexProxyValues("codex", networkProxy),
      });
      assert.equal(edited.status, 200, `${label}: ${JSON.stringify(edited)}`);
      assertBrokerProxyRefused(
        await f.request("POST", f.collection, {
          name: `Repository Agent ${randomUUID()}`,
          configurationId: f.configuration.id,
          executionMode: "dedicated",
          repositoryBindings: selection,
        }),
        message,
        `${label} create`,
      );
      assertBrokerProxyRefused(
        await f.request("PATCH", path, {
          configurationId: f.configuration.id,
          repositoryBindings: selection,
        }),
        message,
        `${label} update`,
      );
      const pendingWork = f.state.pendingOperations();
      assertBrokerProxyRefused(
        await f.request("POST", `${path}/deploy`),
        message,
        `${label} deploy`,
      );
      // A refused redeploy preserves the admitted revision, desired state and queued Work.
      assert.deepEqual(f.state.pendingOperations(), pendingWork, label);
      const { data: revisions } = checkedEnvelope(
        await f.request("GET", `${path}/revisions`),
        AgentRevisionListResponse,
        200,
        label,
      );
      assert.deepEqual(
        revisions.map(({ id }) => id),
        [savedRevision.id],
        label,
      );
      const { data: unchanged } = checkedEnvelope(
        await f.request("GET", path),
        AgentReadResponse,
        200,
        label,
      );
      assert.equal(unchanged.desiredRuntimeState, "running", label);
    }

    // Without repository bindings the proxy carries no broker traffic, and the same setting saves
    // and deploys: the refusal's other remedy works.
    const cleared = await f.request("PATCH", path, {
      configurationId: f.configuration.id,
      repositoryBindings: [],
    });
    assert.equal(cleared.status, 200, JSON.stringify(cleared));
    const unbound = await f.request("POST", `${path}/deploy`);
    assert.equal(unbound.status, 202, JSON.stringify(unbound));
  });

  test("Embedded OpenClaw skips the Codex broker proxy and refuses Codex plugin selections", async (t) => {
    const f = await fixture(t);
    const configuration = await f.request("POST", `/namespaces/${f.namespace.id}/configurations`, {
      kind: "agent",
      values: codexProxyValues("openclaw", { enabled: false }),
    });
    const { data: savedConfiguration } = checkedEnvelope(configuration, ConfigurationResponse, 201);
    const create = (plugins?: PluginDesiredState) =>
      f.request("POST", f.collection, {
        name: `Repository Agent ${randomUUID()}`,
        configurationId: savedConfiguration.id,
        repositoryBindings: selection,
        ...(plugins === undefined ? {} : { plugins }),
      });
    // Without plugins no Plugin Driver runs Codex in the Gateway, so nothing reads the proxy.
    const plain = await create();
    assert.equal(plain.status, 201, JSON.stringify(plain));
    // Enabling the Codex catalog does not install a Codex bridge on an OpenClaw Harness.
    const driver = new CodexPluginDriver();
    f.controller.registerDriver(driver);
    f.controller.selectDriver("plugin", driver.id);
    const refused = await create({
      "codex-plugin:linear@openai-curated-remote": { enabled: true },
    });
    const { error } = checkedEnvelope(refused, ErrorResponse, 400);
    assert.match(error.message, /Plugin Driver.*openclaw Harness/i);
  });

  test("Provisioning refuses a Codex network proxy that blocks the repository broker before queueing", async (t) => {
    const configurationDriver = createTestConfigurationDriver();
    // Refusing the request creates no Configuration; only the worker would.
    configurationDriver.createExact = async () => assert.fail("The request created Configuration");
    configurationDriver.inspectExact = async () =>
      assert.fail("The request inspected Configuration");
    const f = await fixture(t, { harness: "codex", configurationDriver });
    await f.state.transact((unit) =>
      unit.namespaces.transitionNamespaceStatus(f.namespace.id, "provisioning", "ready"),
    );
    const secret = await f.request("POST", `/namespaces/${f.namespace.id}/secrets`, {
      name: "Provisioning model",
      value: "synthetic-model-key",
    });
    const { data: modelSecret } = checkedEnvelope(secret, SecretResponse, 201);
    for (const { label, networkProxy, message } of brokerProxyRefusals) {
      assertBrokerProxyRefused(
        await f.request("POST", `${f.collection}/provision`, {
          requestId: `req_${randomUUID()}`,
          name: `Provisioned ${label}`,
          executionMode: "dedicated",
          configuration: { kind: "agent", values: codexProxyValues("codex", networkProxy) },
          harnessAuth: { method: "api_key", source: modelSecret.ref },
          repositoryBindings: selection,
        }),
        message,
        `${label} provision`,
      );
    }
    assert.deepEqual(
      checkedEnvelope(await f.request("GET", f.collection), AgentListResponse, 200).data,
      [],
    );
  });

  test("Repository capability remains optional when no repository Backend or Driver is configured", async (t) => {
    const f = await fixture(t, { compute: sshCompute(), repositories: false });
    const agent = await f.createAgent({
      harnessAuth: { method: "runtime" },
      gatewayManagedMode: false,
    });
    await f.prepareDeployment(agent);
    const { data: deployed } = checkedEnvelope(
      await f.request("POST", `${f.collection}/${agent.id}/deploy`),
      AgentRevisionResponse,
      202,
    );
    assert.equal(Object.hasOwn(deployed, "repositoryCredentials"), false);
    // Finding 2362: binding a repository with no repository Driver configured is a permanent
    // Installation state, not an outage, so create and update name the setting instead of a 503.
    for (const { method, path, body } of [
      {
        method: "PATCH",
        path: `${f.collection}/${agent.id}`,
        body: { configurationId: f.configuration.id, repositoryBindings: selection },
      },
      {
        method: "POST",
        path: f.collection,
        body: {
          name: `Repository Agent ${randomUUID()}`,
          configurationId: f.configuration.id,
          repositoryBindings: selection,
        },
      },
    ] as const) {
      const { error } = checkedEnvelope(
        await f.request(method, path, body),
        ErrorResponse,
        409,
        method,
      );
      assert.equal(error.code, "RESOURCE_CONFLICT", method);
      // Names the missing settings and who adds them (finding D763).
      assert.equal(error.message, REPOSITORY_SETTINGS_MISSING);
    }
    const { data: agents } = checkedEnvelope(
      await f.request("GET", f.collection),
      AgentListResponse,
      200,
    );
    assert.equal(agents.length, 1, "no Agent was created");
    const { data: unchanged } = checkedEnvelope(
      await f.request("GET", `${f.collection}/${agent.id}`),
      AgentReadResponse,
      200,
    );
    assert.equal(Object.hasOwn(unchanged, "repositoryBindings"), false);
    // Without a repository Driver, discovery answers no options before the Compute check.
    const options = checkedEnvelope(
      await f.request("GET", `${f.collection}/repository-options`),
      RepositoryOptionListResponse,
      200,
    );
    assert.deepEqual(options.data, []);
    assert.equal(options.meta.notConfigured, true);
    // A binding stored before the Installation dropped its repository settings has no approval
    // scope to review: nothing can approve it, so the review lists none instead of the refusal.
    await f.state.transact((unit) =>
      unit.agents.updateConfiguration(
        f.namespace.id,
        agent.id,
        f.configuration.id,
        undefined,
        undefined,
        undefined,
        undefined,
        selection,
      ),
    );
    const scopes = checkedEnvelope(
      await f.request("GET", `${f.collection}/${agent.id}/repository-approval-scopes`),
      Type.Object({ data: Type.Array(Type.Unknown()), meta: Meta }),
      200,
    );
    assert.deepEqual(scopes.data, []);
    // Such a binding can still be dropped: an empty selection needs no repository Driver, so the
    // console's Repositories tab offers Save for it (finding 2398).
    const dropped = await f.request("PATCH", `${f.collection}/${agent.id}`, {
      configurationId: f.configuration.id,
      repositoryAccess: { defaultProfile: "git-full", repositories: [] },
    });
    assert.equal(dropped.status, 200, JSON.stringify(dropped));
    const { data: cleared } = checkedEnvelope(
      await f.request("GET", `${f.collection}/${agent.id}`),
      AgentReadResponse,
      200,
    );
    assert.ok(!("configurationReadError" in cleared));
    assert.deepEqual(cleared.repositoryBindings ?? [], []);
  });

  test("Provisioning rejects a forbidden repository profile before queueing or creating resources", async (t) => {
    const configurationDriver = createTestConfigurationDriver();
    // These effect methods must remain unused when admission rejects the repository selection.
    configurationDriver.createExact = async () =>
      assert.fail("Rejected admission created Configuration");
    configurationDriver.inspectExact = async () =>
      assert.fail("Rejected admission inspected Configuration");
    const f = await fixture(t, {
      harness: "codex",
      configurationDriver,
      compute: kubernetesCompute(),
    });
    await f.state.transact((unit) =>
      unit.namespaces.transitionNamespaceStatus(f.namespace.id, "provisioning", "ready"),
    );
    const secret = await f.request("POST", `/namespaces/${f.namespace.id}/secrets`, {
      name: "Provisioning model",
      value: "synthetic-model-key",
    });
    const { data: modelSecret } = checkedEnvelope(secret, SecretResponse, 201);
    const body = {
      requestId: `req_${randomUUID()}`,
      name: "Rejected provisioning",
      executionMode: "dedicated",
      configuration: { kind: "agent", values: f.configuration.values },
      harnessAuth: { method: "api_key", source: modelSecret.ref },
      repositoryBindings: [{ repositoryRef: "foreign-project", profile: "git-write" }],
    } satisfies ProvisionAgentBody;
    const response = await f.request("POST", `${f.collection}/provision`, body);
    const { error } = checkedEnvelope(response, ErrorResponse, 400);
    assert.equal(error.code, "INVALID_REQUEST");
    assert.equal(error.message, REPOSITORY_SELECTION_NOT_APPROVED);
    assert.deepEqual(
      checkedEnvelope(await f.request("GET", f.collection), AgentListResponse, 200).data,
      [],
    );
    // The refusal follows the Namespace's provisioning grants (finding 2536).
    const outsider = await f.requestWithoutGrants(f.app);
    const outsiderBody = { ...body, requestId: `req_${randomUUID()}` };
    await assertSameAnswer(
      (id) => outsider("POST", `/namespaces/${id}/agents/provision`, outsiderBody),
      [f.namespace.id, `ns_${randomUUID()}`],
      { label: "POST agents/provision" },
    );
  });
}

type ProtectedPolicyFixture = Pick<
  AdmissionFixture,
  "collection" | "controller" | "request" | "state"
> & {
  readonly actorId: string;
  readonly namespace: Pick<Namespace, "id">;
  readonly protectedDriver: InstalledDriver;
  readonly iamState: Parameters<typeof grantRole>[0] & { readonly identities: Identity[] };
  createAgent(fields: Partial<CreateAgentBody>): Promise<AgentWire>;
};

interface ProtectedPolicyDeploymentFixtures {
  protectedOpenShellComposition(
    t: TestContext,
    options: {
      readonly harness: "codex";
      readonly bindings: readonly RepositoryBindingSelection[];
      readonly installedProfile: "repository";
      readonly gatewayVersion: string;
      readonly credentialGateway: true;
      readonly repositoryNetworkPolicyCeiling: readonly RepositoryNetworkGrant[];
      configureRegistry(registry: GitHubRepositoryRegistry): GitHubRepositoryRegistry;
    },
  ): Promise<ProtectedPolicyFixture>;
  seedRepositoryPolicy(
    fixture: ProtectedPolicyFixture,
    agent: Pick<AgentWire, "id">,
    grants: readonly RepositoryNetworkGrant[],
  ): Promise<Readonly<SandboxPolicy>>;
}

export function selectedRepositoryRegistry(
  contents: "read" | "write",
  overrides: Readonly<Record<string, "read" | "write">> = {},
) {
  return (registry: GitHubRepositoryRegistry): GitHubRepositoryRegistry => ({
    ...registry,
    repositories: registry.repositories.map((repo) => ({
      ...repo,
      namespaces: repo.namespaces.map(({ namespaceId }) => ({
        namespaceId,
        profiles: ["github-repository"],
        permissions: { contents: overrides[repo.repositoryRef] ?? contents, metadata: "read" },
      })),
    })),
  });
}

export function registerProtectedRepositoryPolicyDeploymentCase({
  protectedOpenShellComposition,
  seedRepositoryPolicy,
}: ProtectedPolicyDeploymentFixtures): void {
  async function setup(
    t: TestContext,
    selected: RepositoryNetworkGrant,
    bindings: readonly RepositoryBindingSelection[],
    repositoryNetworkPolicyCeiling: readonly RepositoryNetworkGrant[],
    configureRegistry: (registry: GitHubRepositoryRegistry) => GitHubRepositoryRegistry,
  ) {
    const f = await protectedOpenShellComposition(t, {
      harness: "codex",
      bindings,
      installedProfile: "repository",
      gatewayVersion: "0.1.8",
      credentialGateway: true,
      repositoryNetworkPolicyCeiling,
      configureRegistry,
    });
    const fixtureCompute = f.controller.selectedDriver("compute");
    const sandbox = f.controller.selectedDriver("sandbox");
    assert.ok(sandbox);
    const validate = t.mock.fn<
      NonNullable<ComputeDriver["validateProtectedRepositoryNetworkPolicy"]>
    >((revision) => {
      assert.ok(Object.isFrozen(revision));
      assert.equal(revision.executionAdmission.mode, "protected");
      assert.deepEqual(revision.sandboxPolicy?.repositoryNetworkPolicy?.grants, [selected]);
    });
    const credentialStatus = t.mock.fn(async () => ({ transportConfigured: true }));
    const provisioned = t.mock.fn(async () =>
      assert.fail("this admission test must never provision runtime credentials"),
    );
    // Control placement without an execution provider. The API still owns grant,
    // authority, policy snapshot and revision admission.
    Object.assign(fixtureCompute, {
      admitRevision: () => undefined,
      snapshotRuntimeInputs: () => undefined,
      validateProtectedRepositoryNetworkPolicy: validate,
      getAgentRuntimeCredentialStatus: credentialStatus,
      provisionAgentRuntimeCredentials: provisioned,
    });
    await f.state.transact((unit) =>
      unit.namespaces.transitionNamespaceStatus(f.namespace.id, "provisioning", "ready"),
    );
    const namespacePath = `/namespaces/${f.namespace.id}`;
    const { data: secret } = checkedEnvelope(
      await f.request("POST", `${namespacePath}/secrets`, {
        name: "protected-repository-model",
        value: "synthetic-admission-model-key",
      }),
      SecretResponse,
      201,
    );
    const { data: model } = checkedEnvelope(
      await f.request("POST", `${namespacePath}/credential-sources`, {
        name: "protected-repository-model",
        type: "openai",
        secrets: { api_key: secret.ref },
      }),
      CredentialSourceResponse,
      201,
    );
    const sourceId = model.id;
    async function createSelectedAgent() {
      const agent = await f.createAgent({
        executionMode: "dedicated",
        repositoryBindings: [...bindings],
        harnessAuth: { method: "credential_source", sourceId },
        credentialSources: [{ sourceId }],
      });
      const principal = await f.controller.getAgent(f.actorId, f.namespace.id, agent.id);
      f.iamState.identities.push({
        kind: "service_principal",
        id: principal.servicePrincipalId,
        namespaceId: f.namespace.id,
        agentId: agent.id,
      });
      grantRole(f.iamState, principal.servicePrincipalId, {
        id: `model-for-${agent.id}`,
        namespaceId: f.namespace.id,
        permissions: { credential_source: ["operate"] },
        resource: { kind: "credential_source", id: sourceId },
      });
      return agent;
    }
    return {
      f,
      fixtureCompute,
      sandbox,
      validate,
      credentialStatus,
      provisioned,
      createSelectedAgent,
    };
  }

  const read = { repository: "example/selected", access: "read" } as const;
  const write = { ...read, access: "write" } as const;
  const other = { repository: "example/project", access: "write" } as const;
  for (const scenario of [
    {
      name: "a selected git-read binding cannot use its git-write sibling",
      profile: "git-read",
      configure: (registry: GitHubRepositoryRegistry) => registry,
      ceiling: [write],
      selectedGrants: undefined,
      requested: write,
      refusal: /Credential Proxy cannot deliver this repository's Git access level/,
    },
    {
      name: "a selected read credential cannot use a Namespace-approved write on another repository",
      profile: "github-repository",
      configure: selectedRepositoryRegistry("read", { project: "write" }),
      ceiling: [read, other],
      selectedGrants: [read],
      requested: other,
      refusal: /exceeds the Agent's selected Git credential/,
    },
    {
      name: "a selected write credential cannot exceed a read-only delegation ceiling",
      profile: "github-repository",
      configure: selectedRepositoryRegistry("write"),
      ceiling: [read],
      selectedGrants: [write],
      requested: write,
      refusal: /exceeds the Installation repository network policy delegation limit/,
    },
  ] as const) {
    test(scenario.name, async (t) => {
      const bindings = [{ repositoryRef: "selected", profile: scenario.profile }];
      const { f, fixtureCompute, sandbox, credentialStatus, provisioned, createSelectedAgent } =
        await setup(t, read, bindings, scenario.ceiling, scenario.configure);
      fixtureCompute.validateProtectedRepositoryNetworkPolicy = () => {};
      fixtureCompute.admitsProtectedRepositoryNetworkPolicySave = () => true;
      sandbox.admitRepositoryNetworkPolicy = (_policy, network) => network.defaults;
      sandbox.validateProtectedRepositoryNetworkPolicy = () => {};
      const repo = f.controller.selectedDriver("repo") as GitHubRepositoryPolicy;
      const namespaceId = f.namespace.id;
      const resolve = (profile: string) =>
        repo.resolveBindings({ namespaceId, bindings: [{ repositoryRef: "selected", profile }] });
      assert.deepEqual(
        resolve(scenario.profile).selectedRepositoryNetworkGrants,
        scenario.selectedGrants,
      );
      assert.equal(
        repo.repositoryNetworkPolicyAllows({ namespaceId, grant: scenario.requested }),
        true,
      );
      if (scenario.profile === "git-read") {
        assert.equal(resolve("git-write").bindings[0]?.profile, "git-write");
      }
      const agent = await createSelectedAgent();
      const base = `${f.collection}/${agent.id}`;
      const path = `${base}/sandbox-policy/networking`;
      assert.equal((await f.request("PATCH", `${path}/editing`, { enabled: true })).status, 200);
      const view = async () =>
        checkedEnvelope(await f.request("GET", path), SandboxPolicyViewResponse, 200).data;
      const put = (version: number, grant: RepositoryNetworkGrant) =>
        f.request("PUT", path, {
          expectedVersion: version,
          additions: [],
          repositoryNetworkPolicy: [grant],
        });
      const before = await view();
      assert.deepEqual(before.repositoryNetworkPolicyCeiling, scenario.ceiling);
      checkedEnvelope(await put(before.policy.version, scenario.requested), ErrorResponse, 409);
      if (scenario.profile === "git-read") {
        // Fixed Git profiles cannot issue a selected-repository Proxy credential, even for read.
        checkedEnvelope(await put(before.policy.version, read), ErrorResponse, 409);
      }
      assert.deepEqual((await view()).policy, before.policy);
      const saved = await seedRepositoryPolicy(f, agent, [scenario.requested]);
      const deploy = () => f.request("POST", `${base}/deploy`);
      assert.match(
        checkedEnvelope(await deploy(), ErrorResponse, 409).error.message,
        scenario.refusal,
      );
      assert.equal(credentialStatus.mock.callCount(), 0);
      assert.equal(provisioned.mock.callCount(), 0);
      assert.deepEqual((await f.request("GET", `${base}/revisions`)).data, []);
      if (scenario.profile === "github-repository") {
        const allowed = checkedEnvelope(await put(saved.version, read), SandboxPolicyResponse, 200);
        assert.deepEqual(allowed.data.repositoryNetworkPolicy, [read]);
        const { data: admitted } = checkedEnvelope(await deploy(), AgentRevisionResponse, 202);
        const revision = await f.state.read((view) =>
          view.revisions.findRevision(namespaceId, agent.id, admitted.id),
        );
        assert.deepEqual(revision?.sandboxPolicy?.repositoryNetworkPolicy?.grants, [read]);
        assert.deepEqual(
          revision?.repositoryCredentials?.bindings.map(({ repositoryRef, profile }) => ({
            repositoryRef,
            profile,
          })),
          bindings,
        );
        assert.equal(credentialStatus.mock.callCount(), 1);
      }
    });
  }

  test("Deploy requires scoped Driver admission before preparing runtime credentials", async (t) => {
    const selected = { repository: "example/selected", access: "read" } as const;
    const writeGrant = { ...selected, access: "write" } as const;
    const unselected = { repository: "example/project", access: "read" } as const;
    const foreign = { repository: "example/foreign-project", access: "read" } as const;
    const bindings = [{ repositoryRef: "selected", profile: "github-repository" }] as const;
    const {
      f,
      fixtureCompute,
      sandbox,
      validate,
      credentialStatus,
      provisioned,
      createSelectedAgent,
    } = await setup(
      t,
      selected,
      bindings,
      [writeGrant, unselected, foreign],
      selectedRepositoryRegistry("read"),
    );
    const agent = await createSelectedAgent();
    const path = `${f.collection}/${agent.id}`;
    const deploy = () => f.request("POST", `${path}/deploy`);
    // A previously saved, authorized grant cannot deploy with a Sandbox that lacks
    // scoped admission. The refusal occurs before credential or revision effects.
    await seedRepositoryPolicy(f, agent, [selected]);
    const { error } = checkedEnvelope(await deploy(), ErrorResponse, 409);
    assert.match(
      error.message,
      /Protected execution cannot enforce the saved repository network policy/,
    );
    assert.equal(credentialStatus.mock.callCount(), 0);
    assert.deepEqual((await f.request("GET", `${path}/revisions`)).data, []);

    const eligible = await createSelectedAgent();
    const eligiblePath = `${f.collection}/${eligible.id}`;
    const policyPath = `${eligiblePath}/sandbox-policy/networking`;
    assert.equal(
      (await f.request("PATCH", `${policyPath}/editing`, { enabled: true })).status,
      200,
    );
    const { data: before } = checkedEnvelope(
      await f.request("GET", policyPath),
      SandboxPolicyViewResponse,
      200,
    );
    const put = (grants: readonly RepositoryNetworkGrant[] = [selected]) =>
      f.request("PUT", policyPath, {
        expectedVersion: before.policy.version,
        additions: [],
        repositoryNetworkPolicy: grants,
      });
    // Bundled Drivers lack first-save admission. The API leaves desired policy
    // untouched until both selected Drivers explicitly support it.
    assert.equal(before.repositoryNetworkPolicySaveSupported, false);
    checkedEnvelope(await put(), ErrorResponse, 409);
    checkedEnvelope(await put([]), ErrorResponse, 409);
    assert.deepEqual(
      checkedEnvelope(await f.request("GET", policyPath), SandboxPolicyViewResponse, 200).data
        .policy,
      before.policy,
    );
    fixtureCompute.admitsProtectedRepositoryNetworkPolicySave = ({
      harness,
      protectedDriver,
      repositoryNetworkPolicy,
    }) =>
      (repositoryNetworkPolicy?.grants.length ?? 0) > 0 &&
      harness.id === "codex" &&
      harness.mode === "dedicated" &&
      protectedDriver.configurationId === f.protectedDriver.ref.configurationId;
    // An affirmative Compute response alone cannot enable save.
    checkedEnvelope(await put(), ErrorResponse, 409);
    const admitSandboxPolicy: NonNullable<SandboxDriver["admitRepositoryNetworkPolicy"]> = (
      _policy,
      network,
    ) => network.defaults;
    sandbox.admitRepositoryNetworkPolicy = admitSandboxPolicy;
    const validateSandbox = t.mock.fn<
      NonNullable<SandboxDriver["validateProtectedRepositoryNetworkPolicy"]>
    >((revision) => {
      assert.ok(Object.isFrozen(revision));
      assert.deepEqual(revision.sandboxPolicy?.repositoryNetworkPolicy?.grants, [selected]);
    });
    sandbox.validateProtectedRepositoryNetworkPolicy = validateSandbox;
    const repo = f.controller.selectedDriver("repo") as GitHubRepositoryPolicy;
    await t.test("GET hides first-save support with no matching delegated grant", async () => {
      const approve = repo.repositoryNetworkPolicyAllows;
      repo.repositoryNetworkPolicyAllows = (input) =>
        input.grant.repository !== selected.repository && approve.call(repo, input);
      try {
        const unavailable = checkedEnvelope(
          await f.request("GET", policyPath),
          SandboxPolicyViewResponse,
          200,
        ).data;
        assert.deepEqual(unavailable.repositoryNetworkPolicyCeiling, [unselected]);
        assert.equal(unavailable.repositoryNetworkPolicySaveSupported, false);
      } finally {
        repo.repositoryNetworkPolicyAllows = approve;
      }
    });
    // Namespace approval includes an unselected repository, but the Agent's token does not.
    await t.test("Save refuses a Namespace-approved unselected repository", async () => {
      const draft = await createSelectedAgent();
      const path = `${f.collection}/${draft.id}/sandbox-policy/networking`;
      assert.equal((await f.request("PATCH", `${path}/editing`, { enabled: true })).status, 200);
      const readPolicy = async () =>
        checkedEnvelope(await f.request("GET", path), SandboxPolicyViewResponse, 200).data.policy;
      const previous = await readPolicy();
      checkedEnvelope(
        await f.request("PUT", path, {
          expectedVersion: previous.version,
          additions: [],
          repositoryNetworkPolicy: [unselected],
        }),
        ErrorResponse,
        409,
      );
      assert.deepEqual(await readPolicy(), previous);
    });
    // Exercise the portable Repo contract. GitHub requires github-repository to be the sole
    // profile for a repository in a Namespace, so a different same-repository scope is synthetic.
    // GET must advertise first-save support for read; PUT must still reject write.
    const approve = repo.repositoryNetworkPolicyAllows;
    repo.repositoryNetworkPolicyAllows = (input) =>
      (input.namespaceId === f.namespace.id &&
        input.grant.repository === selected.repository &&
        input.grant.access === "write") ||
      approve.call(repo, input);
    const available = checkedEnvelope(
      await f.request("GET", policyPath),
      SandboxPolicyViewResponse,
      200,
    ).data;
    assert.deepEqual(available.repositoryNetworkPolicyCeiling, [writeGrant, unselected]);
    assert.equal(available.repositoryNetworkPolicySaveSupported, true);
    checkedEnvelope(
      await f.request("PUT", policyPath, {
        expectedVersion: before.policy.version,
        additions: [],
        repositoryNetworkPolicy: [writeGrant],
      }),
      ErrorResponse,
      409,
    );
    const { data: desired } = checkedEnvelope(await put(), SandboxPolicyResponse, 200);
    assert.deepEqual(desired.repositoryNetworkPolicy, [selected]);
    repo.repositoryNetworkPolicyAllows = approve;
    assert.equal(credentialStatus.mock.callCount(), 0);
    assert.deepEqual((await f.request("GET", `${eligiblePath}/revisions`)).data, []);
    fixtureCompute.validateProtectedRepositoryNetworkPolicy = (draft) => {
      validate(draft);
      fixtureCompute.validateProtectedRepositoryNetworkPolicy = validate;
    };
    // A successful validation from a method that changed during admission cannot release
    // runtime credentials or save a revision. A stable validator admits the same saved policy.
    checkedEnvelope(await f.request("POST", `${eligiblePath}/deploy`), ErrorResponse, 409);
    assert.equal(credentialStatus.mock.callCount(), 0);
    assert.deepEqual((await f.request("GET", `${eligiblePath}/revisions`)).data, []);
    const { data: admitted } = checkedEnvelope(
      await f.request("POST", `${eligiblePath}/deploy`),
      AgentRevisionResponse,
      202,
    );
    assert.equal(credentialStatus.mock.callCount(), 1);
    assert.equal(provisioned.mock.callCount(), 0);
    const revision = await f.state.read((view) =>
      view.revisions.findRevision(f.namespace.id, eligible.id, admitted.id),
    );
    assert.ok(revision);
    assert.deepEqual(revision.executionAdmission, { version: 5, mode: "protected" });
    assert.deepEqual(revision.sandboxPolicy?.repositoryNetworkPolicy?.grants, [selected]);
    assert.equal(revision.sandboxPolicy?.version, desired.version);
    assert.equal(revision.egressPlan?.execution.revisionId, revision.id);
    assert.deepEqual(revision.egressPlan?.harnessCredentialSource, revision.harnessAuth);
    assert.deepEqual(revision.egressPlan?.routes, []);
    assert.equal(validate.mock.callCount(), 2);
    assert.equal(validateSandbox.mock.callCount(), 1);
    assert.equal(validateSandbox.mock.calls[0]?.arguments[0], validate.mock.calls[1]?.arguments[0]);

    async function savedPolicyAgent(
      grants: readonly RepositoryNetworkGrant[] = [selected],
      refused: readonly (readonly RepositoryNetworkGrant[])[] = [],
    ) {
      const agent = await createSelectedAgent();
      const path = `${f.collection}/${agent.id}`;
      const policyPath = `${path}/sandbox-policy/networking`;
      assert.equal(
        (await f.request("PATCH", `${policyPath}/editing`, { enabled: true })).status,
        200,
      );
      const { data } = checkedEnvelope(
        await f.request("GET", policyPath),
        SandboxPolicyViewResponse,
        200,
      );
      const put = (requested: readonly RepositoryNetworkGrant[]) =>
        f.request("PUT", policyPath, {
          expectedVersion: data.policy.version,
          additions: [],
          repositoryNetworkPolicy: requested,
        });
      for (const proposal of refused) {
        checkedEnvelope(await put(proposal), ErrorResponse, 409);
      }
      const result = checkedEnvelope(await put(grants), SandboxPolicyResponse, 200);
      assert.deepEqual(result.data.repositoryNetworkPolicy, grants);
      assert.equal(data.repositoryNetworkPolicySaveSupported, true);
      return path;
    }

    await t.test(
      "GET lets an editor try a pair when neither grant can be saved alone",
      async () => {
        const pair = [unselected, writeGrant];
        const originalResolver = repo.resolveBindings;
        const originalAllows = repo.repositoryNetworkPolicyAllows;
        const previousSave = fixtureCompute.admitsProtectedRepositoryNetworkPolicySave;
        assert.ok(previousSave);
        repo.resolveBindings = (input) => ({
          ...originalResolver.call(repo, input),
          selectedRepositoryNetworkGrants: pair,
        });
        repo.repositoryNetworkPolicyAllows = ({ grant }) =>
          pair.some((item) => item.repository === grant.repository);
        fixtureCompute.admitsProtectedRepositoryNetworkPolicySave = ({ repositoryNetworkPolicy }) =>
          isDeepStrictEqual(repositoryNetworkPolicy?.grants, pair);
        try {
          await savedPolicyAgent(pair, [[], [unselected], [writeGrant]]);
        } finally {
          repo.resolveBindings = originalResolver;
          repo.repositoryNetworkPolicyAllows = originalAllows;
          fixtureCompute.admitsProtectedRepositoryNetworkPolicySave = previousSave;
        }
      },
    );

    await t.test("an unscoped deployment closes first-save admission for that Agent", async () => {
      const agent = await createSelectedAgent();
      const path = `${f.collection}/${agent.id}`;
      const policyPath = path + "/sandbox-policy/networking";
      assert.equal(
        (await f.request("PATCH", policyPath + "/editing", { enabled: true })).status,
        200,
      );
      const get = async () =>
        checkedEnvelope(await f.request("GET", policyPath), SandboxPolicyViewResponse, 200).data;
      assert.equal((await get()).repositoryNetworkPolicySaveSupported, true);
      checkedEnvelope(await f.request("POST", path + "/deploy"), AgentRevisionResponse, 202);
      const after = await get();
      for (const proposal of [[selected], []]) {
        const { error } = checkedEnvelope(
          await f.request("PUT", policyPath, {
            expectedVersion: after.policy.version,
            additions: [],
            repositoryNetworkPolicy: proposal,
          }),
          ErrorResponse,
          409,
        );
        assert.match(error.message, /Create a new Agent/);
      }
      assert.equal(after.repositoryNetworkPolicySaveSupported, false);
      assert.deepEqual((await get()).policy, after.policy);
    });

    await t.test(
      "same Agent saves a downgrade only while its selected credential covers the request",
      async () => {
        const resolver = repo.resolveBindings;
        const allows = repo.repositoryNetworkPolicyAllows;
        const admission = fixtureCompute.admitsProtectedRepositoryNetworkPolicySave;
        assert.ok(admission);
        let selectedGrants: readonly RepositoryNetworkGrant[] = [writeGrant];
        let withdraw = false;
        repo.resolveBindings = (input) => ({
          ...resolver.call(repo, input),
          selectedRepositoryNetworkGrants: selectedGrants,
        });
        repo.repositoryNetworkPolicyAllows = ({ grant }) =>
          grant.repository === selected.repository;
        fixtureCompute.admitsProtectedRepositoryNetworkPolicySave = () => {
          if (withdraw) {
            selectedGrants = [];
          }
          return true;
        };
        fixtureCompute.validateProtectedRepositoryNetworkPolicy = () => {};
        sandbox.validateProtectedRepositoryNetworkPolicy = () => {};
        try {
          const path = await savedPolicyAgent([writeGrant]);
          const deploy = async () =>
            checkedEnvelope(await f.request("POST", path + "/deploy"), AgentRevisionResponse, 202)
              .data;
          const first = await deploy();
          const policyPath = path + "/sandbox-policy/networking";
          const readSaved = () =>
            f.state.read((view) => view.sandboxPolicies.find(f.namespace.id, first.agentId));
          const original = await readSaved();
          assert.ok(original);
          assert.deepEqual(original.repositoryNetworkPolicy, [writeGrant]);
          const put = () =>
            f.request("PUT", policyPath, {
              expectedVersion: original.version,
              additions: [],
              repositoryNetworkPolicy: [selected],
            });
          // Repo identity and Namespace permission are stable. The same resolver returns
          // a narrower selected credential after Compute checks the requested policy.
          withdraw = true;
          checkedEnvelope(await put(), ErrorResponse, 409);
          assert.deepEqual(await readSaved(), original);
          withdraw = false;
          selectedGrants = [writeGrant];
          checkedEnvelope(await put(), SandboxPolicyResponse, 200);
          const second = await deploy();
          assert.equal(second.agentId, first.agentId);
          const revisions = await f.state.read((view) =>
            view.revisions.listRevisions(f.namespace.id, first.agentId),
          );
          assert.deepEqual(
            revisions.map((r) => r.sandboxPolicy?.repositoryNetworkPolicy?.grants),
            [[writeGrant], [selected]],
          );
          assert.deepEqual(
            revisions[0]?.repositoryCredentials?.bindings,
            revisions[1]?.repositoryCredentials?.bindings,
          );
        } finally {
          repo.resolveBindings = resolver;
          repo.repositoryNetworkPolicyAllows = allows;
          fixtureCompute.admitsProtectedRepositoryNetworkPolicySave = admission;
          fixtureCompute.validateProtectedRepositoryNetworkPolicy = validate;
          sandbox.validateProtectedRepositoryNetworkPolicy = validateSandbox;
        }
      },
    );

    await t.test("supported first empty list admits an explicit deny-all snapshot", async () => {
      const previousSave = fixtureCompute.admitsProtectedRepositoryNetworkPolicySave;
      assert.ok(previousSave);
      fixtureCompute.admitsProtectedRepositoryNetworkPolicySave = ({ repositoryNetworkPolicy }) =>
        repositoryNetworkPolicy?.grants.length === 0;
      const path = await savedPolicyAgent([], [[selected]]).finally(() => {
        fixtureCompute.admitsProtectedRepositoryNetworkPolicySave = previousSave;
      });
      const { data: saved } = checkedEnvelope(
        await f.request("GET", path + "/sandbox-policy/networking"),
        SandboxPolicyViewResponse,
        200,
      );
      assert.deepEqual(saved.policy.repositoryNetworkPolicy, []);
      const oldCompute = fixtureCompute.validateProtectedRepositoryNetworkPolicy;
      assert.ok(oldCompute);
      const oldSandbox = sandbox.validateProtectedRepositoryNetworkPolicy;
      assert.ok(oldSandbox);
      fixtureCompute.validateProtectedRepositoryNetworkPolicy = (draft) => {
        assert.deepEqual(draft.sandboxPolicy?.repositoryNetworkPolicy?.grants, []);
      };
      sandbox.validateProtectedRepositoryNetworkPolicy = (draft) => {
        assert.deepEqual(draft.sandboxPolicy?.repositoryNetworkPolicy?.grants, []);
      };
      try {
        const { data } = checkedEnvelope(
          await f.request("POST", path + "/deploy"),
          AgentRevisionResponse,
          202,
        );
        const frozen = await f.state.read((view) =>
          view.revisions.findRevision(f.namespace.id, saved.policy.agentId, data.id),
        );
        assert.equal(frozen?.sandboxPolicy?.version, saved.policy.version);
        assert.deepEqual(frozen?.sandboxPolicy?.repositoryNetworkPolicy, {
          version: 1,
          grants: [],
          identity: '{"version":1,"grants":[]}',
        });
      } finally {
        fixtureCompute.validateProtectedRepositoryNetworkPolicy = oldCompute;
        sandbox.validateProtectedRepositoryNetworkPolicy = oldSandbox;
      }
    });

    async function verifyNoDeployment(path: string, message: RegExp) {
      const previousChecks = credentialStatus.mock.callCount();
      const { error } = checkedEnvelope(
        await f.request("POST", `${path}/deploy`),
        ErrorResponse,
        409,
      );
      assert.match(error.message, message);
      assert.equal(credentialStatus.mock.callCount(), previousChecks);
      assert.equal(provisioned.mock.callCount(), 0);
      assert.deepEqual((await f.request("GET", `${path}/revisions`)).data, []);
      return error;
    }

    await t.test(
      "Changing the selected repository invalidates a previously saved grant",
      async () => {
        const path = await savedPolicyAgent();
        const { data: before } = checkedEnvelope(
          await f.request("GET", path),
          AgentReadResponse,
          200,
        );
        const { data } = checkedEnvelope(
          await f.request("PATCH", path, {
            configurationId: before.configurationId,
            repositoryBindings: [{ repositoryRef: "project", profile: "github-repository" }],
          }),
          AgentResponse,
          200,
        );
        assert.deepEqual(data.repositoryBindings, [
          { repositoryRef: "project", profile: "github-repository" },
        ]);
        await verifyNoDeployment(path, /selected Git credential/);
      },
    );

    await t.test(
      "A Sandbox can refuse the frozen revision before credentials are checked",
      async (scope) => {
        const path = await savedPolicyAgent();
        const sentinel = "synthetic-private-sandbox-revision-refusal";
        const refuse = scope.mock.fn<
          NonNullable<SandboxDriver["validateProtectedRepositoryNetworkPolicy"]>
        >(() => {
          throw new Error(sentinel);
        });
        sandbox.validateProtectedRepositoryNetworkPolicy = refuse;
        try {
          const error = await verifyNoDeployment(path, /Sandbox Driver/);
          assert.equal(JSON.stringify(error).includes(sentinel), false);
          assert.equal(refuse.mock.callCount(), 1);
        } finally {
          sandbox.validateProtectedRepositoryNetworkPolicy = validateSandbox;
        }
      },
    );

    await t.test(
      "Changing either Sandbox method during awaited Compute validation refuses deploy",
      async () => {
        const path = await savedPolicyAgent();
        for (const change of [
          () => {
            sandbox.admitRepositoryNetworkPolicy = (_policy, network) => network.defaults;
          },
          () => {
            sandbox.validateProtectedRepositoryNetworkPolicy = () => undefined;
          },
        ]) {
          fixtureCompute.validateProtectedRepositoryNetworkPolicy = async (revision) => {
            validate(revision);
            await Promise.resolve();
            change();
          };
          try {
            await verifyNoDeployment(path, /Drivers changed/);
          } finally {
            sandbox.admitRepositoryNetworkPolicy = admitSandboxPolicy;
            sandbox.validateProtectedRepositoryNetworkPolicy = validateSandbox;
            fixtureCompute.validateProtectedRepositoryNetworkPolicy = validate;
          }
        }
      },
    );

    const selectedProxy = f.controller.selectedDriver("credential_proxy");
    const originalResolver = repo.resolveBindings;
    const withdrawSelectedGrants: GitHubRepositoryPolicy["resolveBindings"] = (input) =>
      Object.freeze({
        ...originalResolver.call(repo, input),
        selectedRepositoryNetworkGrants: Object.freeze([]),
      });
    const alternateProxyEffect = t.mock.fn(async (): Promise<never> => {
      assert.fail("the alternate Credential Proxy must never perform an effect");
    });
    const alternateProxy: LegacyEgressProxyDriver = {
      capability: "credential_proxy",
      id: "synthetic-alternate-proxy",
      implementation: selectedProxy.implementation,
      sourceControl: selectedProxy.sourceControl,
      bindRepositoryGit: alternateProxyEffect,
      configureRevision: alternateProxyEffect,
      wiringStatus: alternateProxyEffect,
      verifyInstallation: alternateProxyEffect,
      removeRevision: alternateProxyEffect,
    };
    f.controller.registerDriver(
      new InstalledDriver(
        { id: alternateProxy.id, implementation: alternateProxy.implementation, configuration: {} },
        { capabilities: { credential_proxy: alternateProxy } },
      ),
    );

    let namespaceAllowsGrant = true;
    const policyAllows = repo.repositoryNetworkPolicyAllows.bind(repo);
    repo.repositoryNetworkPolicyAllows = (input) => namespaceAllowsGrant && policyAllows(input);

    const changes = [
      {
        name: "the Namespace revokes a grant through the same Repo method",
        change: () => {
          namespaceAllowsGrant = false;
        },
        restore: () => {
          namespaceAllowsGrant = true;
        },
        message: /Drivers changed/,
      },
      {
        name: "Repo withdraws the selected grant",
        change: () => {
          repo.resolveBindings = withdrawSelectedGrants;
        },
        restore: () => {
          repo.resolveBindings = originalResolver;
        },
        message: /selected Git credential/,
      },
      {
        name: "the selected Credential Proxy changes",
        change: () => {
          f.controller.selectDriver("credential_proxy", alternateProxy.id);
        },
        restore: () => {
          f.controller.selectDriver("credential_proxy", selectedProxy.id);
        },
        message: /Drivers changed/,
      },
    ];
    for (const { name, change, restore, message } of changes) {
      await t.test(`Deploy refuses if ${name} during Compute validation`, async () => {
        const path = await savedPolicyAgent();
        const checks = credentialStatus.mock.callCount();
        fixtureCompute.validateProtectedRepositoryNetworkPolicy = async (revision) => {
          validate(revision);
          assert.ok(revision.egressPlan?.repositoryGit);
          assert.deepEqual(revision.egressPlan.routes, []);
          await Promise.resolve();
          change();
        };
        try {
          const error = await verifyNoDeployment(path, message);
          assert.equal(error.code, "RESOURCE_CONFLICT");
          assert.equal(alternateProxyEffect.mock.callCount(), 0);
        } finally {
          restore();
          fixtureCompute.validateProtectedRepositoryNetworkPolicy = validate;
        }
        const { data } = checkedEnvelope(
          await f.request("POST", `${path}/deploy`),
          AgentRevisionResponse,
          202,
        );
        const stored = await f.state.read((view) =>
          view.revisions.findRevision(f.namespace.id, data.agentId, data.id),
        );
        assert.deepEqual(stored?.sandboxPolicy?.repositoryNetworkPolicy?.grants, [selected]);
        assert.deepEqual(stored?.egressPlan?.driver, f.protectedDriver.ref);
        assert.equal(credentialStatus.mock.callCount(), checks + 1);
        assert.equal(provisioned.mock.callCount(), 0);
      });
    }
  });
}
