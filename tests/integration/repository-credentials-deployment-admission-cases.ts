import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";
import type { createFastifyApp } from "../../apps/controller/src/index.ts";
import { CodexPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import type { GitHubRepositoryRegistry } from "../../apps/controller/src/drivers/repo/github/access/registry.ts";
import {
  AgentListResponse,
  AgentReadResponse,
  AgentRevisionListResponse,
  AgentRevisionReadResponse,
  AgentRevisionResponse,
  AgentSchema,
  ConfigurationResponse,
  ConfigurationSchema,
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
  type OpenClawConfigurationValue,
  type PluginDesiredState,
  type ProvisionAgentBody,
  type RepositoryBindingSelection,
  type SandboxDriver,
} from "../../packages/contracts/src/index.ts";
import type { InMemoryPlatformState, OpenClawController } from "../../packages/occ/src/index.ts";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { assertSameAnswer } from "../helpers/refusal-answers.ts";
import {
  BROKER_PROXY_DISABLED,
  BROKER_PROXY_DOMAIN_DECISION,
  BROKER_PROXY_DOMAINS,
  BROKER_PROXY_EMPTY_HOST,
  BROKER_PROXY_LOCAL_BINDING,
  BROKER_PROXY_MODE,
  CODEX_NEEDS_DEDICATED,
  COMPUTE_REPOSITORY_UNSUPPORTED,
  COMPUTE_TOPOLOGY_REPOSITORY_UNSUPPORTED,
  REPOSITORY_SELECTION_NOT_APPROVED,
  REPOSITORY_SETTINGS_MISSING,
  runtimeIdUnsupported,
  SAVED_REPOSITORY_SELECTION_NOT_APPROVED,
} from "../helpers/refusal-text.mjs";
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
  method: "GET" | "POST" | "PATCH",
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
