import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import type { TSchema } from "typebox";
import { Check } from "typebox/value";
import { KubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { OCCPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import type { GitHubRepositoryRegistry } from "../../apps/controller/src/drivers/repo/github/access/registry.ts";
import {
  AgentListResponse,
  AgentReadResponse,
  AgentResponse,
  AgentRevisionListResponse,
  AgentRevisionResponse,
  AgentSchema,
  ConfigurationSchema,
  ErrorResponse,
  JsonValue,
  NamespaceResponse,
  NamespaceSchema,
  PluginApproversSchema,
  PluginDesiredSelectionSchema,
  PluginDesiredStateSchema,
  PluginDriverIdentitySchema,
  PluginToolDefaultsSchema,
  PluginToolPolicySchema,
  RepositoryOptionListResponse,
  type AgentWire,
  type CreateAgentBody,
  type RepositoryBindingSelection,
  type SandboxDriver,
  type UpdateAgentBody,
} from "../../packages/contracts/src/index.ts";
import type { NativeIAMState } from "../../packages/iam/src/index.ts";
import type { OpenClawController } from "../../packages/occ/src/index.ts";
import { liftRestriction, restrict } from "../helpers/iam-grants.ts";
import {
  COMPUTE_TOPOLOGY_REPOSITORY_UNSUPPORTED,
  DEPENDENCY_UNAVAILABLE,
  REPOSITORY_ACCESS_OR_BINDINGS,
  REPOSITORY_SELECTION_NOT_APPROVED,
} from "../helpers/refusal-text.mjs";
import { DEDICATED_OPENCLAW_SUPPORT } from "../helpers/sandbox-driver.ts";

interface HttpResponse {
  readonly status: number;
  readonly [field: string]: unknown;
}

type Request = (
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  payload?: unknown,
) => Promise<HttpResponse>;

interface AdmissionFixture {
  readonly request: Request;
  readonly collection: string;
  readonly configuration: unknown;
  readonly controller: OpenClawController;
  readonly iamState: { restrictions: NativeIAMState["restrictions"][number][] };
  readonly namespace: unknown;
  readonly registry: GitHubRepositoryRegistry;
  compose(registry: GitHubRepositoryRegistry): Promise<{ request: Request }>;
  createAgent(fields?: Partial<CreateAgentBody>): Promise<unknown>;
  failIAMAfterReads(count: number): void;
  prepareDeployment(agent: Pick<AgentWire, "id" | "harnessAuth">): Promise<void>;
}

type AdmissionFixtureFactory = (
  context: TestContext,
  options?: {
    readonly compute?: KubernetesComputeDriver;
    readonly harness?: "codex" | "openclaw";
    readonly repositories?: boolean;
  },
) => Promise<AdmissionFixture>;

interface AdmissionInputs {
  fixture: AdmissionFixtureFactory;
  kubernetesCompute(Driver: typeof KubernetesComputeDriver): KubernetesComputeDriver;
  readonly selection: RepositoryBindingSelection[];
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
) {
  const message = JSON.stringify(response);
  assert.equal(response.status, status, message);
  // The authenticated request helper adds status to the serialized HTTP envelope.
  const { status: _status, ...body } = response;
  assert.ok(Check(schemaContext, schema, body), message);
  return body;
}

async function createAgent(fixture: AdmissionFixture, fields?: Partial<CreateAgentBody>) {
  const agent = await fixture.createAgent(fields);
  assert.ok(Check(schemaContext, AgentSchema, agent));
  return agent;
}

class DedicatedRepositoryComputeDriver extends KubernetesComputeDriver {
  override validateRepositoryCredentials(
    ...args: Parameters<KubernetesComputeDriver["validateRepositoryCredentials"]>
  ): void {
    super.validateRepositoryCredentials(...args);
    const [harness] = args;
    if (harness.mode !== "dedicated") {
      throw new Error("This Compute Driver supports only dedicated repository execution.");
    }
  }
}

async function readAgent(request: Request, path: string) {
  const { data } = checkedEnvelope(await request("GET", path), AgentReadResponse, 200);
  assert.ok(!("configurationReadError" in data), "fixture Agent configuration must be readable");
  return data;
}

async function admissionFixture(
  fixture: AdmissionFixtureFactory,
  context: TestContext,
  options?: Parameters<AdmissionFixtureFactory>[1],
) {
  const result = await fixture(context, options);
  assert.ok(Check(NamespaceSchema, result.namespace));
  assert.ok(Check(schemaContext, ConfigurationSchema, result.configuration));
  return { ...result, namespaceId: result.namespace.id, configurationId: result.configuration.id };
}

export function registerRepositoryOptionCases(fixture: AdmissionFixtureFactory) {
  test("Repository options expose only Namespace-approved display choices behind Agent create authorization", async (t) => {
    const f = await admissionFixture(fixture, t);
    const path = `${f.collection}/repository-options`;
    const { data } = checkedEnvelope(
      await f.request("GET", path),
      RepositoryOptionListResponse,
      200,
    );
    assert.deepEqual(data, [
      {
        repositoryRef: "project",
        displayName: "example/project",
        allowedProfiles: ["git-full", "git-read", "git-write"],
      },
    ]);
    const [project] = data;
    assert.ok(project);
    assert.deepEqual(Object.keys(project).sort(), [
      "allowedProfiles",
      "displayName",
      "repositoryRef",
    ]);
    assert.doesNotMatch(
      JSON.stringify(data),
      /provider|backend|installation|repositoryId|grant|duration|token|key|credential/i,
    );

    checkedEnvelope(await f.request("GET", `${path}?descriptionRefs=project`), ErrorResponse, 400);

    const restriction = restrict(f.iamState, "create", "agent", { namespaceId: f.namespaceId });
    const { error: denied } = checkedEnvelope(await f.request("GET", path), ErrorResponse, 403);
    assert.equal(denied.code, "FORBIDDEN");

    liftRestriction(f.iamState, restriction);
    const sandbox: SandboxDriver = {
      id: "repository-options-sandbox",
      capability: "sandbox",
      implementation: "test-sandbox",
      supportsHarnessExecutionMode: DEDICATED_OPENCLAW_SUPPORT,
      facets: ["networking", "filesystem", "process"],
      async cleanup() {},
    };
    f.controller.registerDriver(sandbox);
    f.controller.selectDriver("sandbox", sandbox.id);
    const { error: incompatible } = checkedEnvelope(
      await f.request("GET", path),
      ErrorResponse,
      503,
    );
    assert.equal(incompatible.code, "REPOSITORY_OPTIONS_UNAVAILABLE");

    const { data: transient } = checkedEnvelope(
      await f.request("POST", "/namespaces", { name: "deleting-options" }),
      NamespaceResponse,
      201,
    );
    checkedEnvelope(
      await f.request("DELETE", `/namespaces/${transient.id}`),
      NamespaceResponse,
      202,
    );
    const { error: conflict } = checkedEnvelope(
      await f.request("GET", `/namespaces/${transient.id}/agents/repository-options`),
      ErrorResponse,
      409,
    );
    assert.equal(conflict.code, "RESOURCE_CONFLICT");
  });

  test("Exact-Agent repository choices require Agent update authorization", async (t) => {
    const f = await admissionFixture(fixture, t);
    const agent = await createAgent(f);
    const otherAgent = await createAgent(f);
    const path = `${f.collection}/${agent.id}/repository-options`;
    const options = checkedEnvelope(
      await f.request("GET", path),
      RepositoryOptionListResponse,
      200,
    );

    // Deny one Agent while leaving another in the same Namespace readable for editing.
    restrict(f.iamState, "update", "agent", { namespaceId: f.namespaceId, resourceId: agent.id });
    const { error } = checkedEnvelope(await f.request("GET", path), ErrorResponse, 403);
    assert.equal(error.code, "FORBIDDEN");
    const allowed = checkedEnvelope(
      await f.request("GET", `${f.collection}/${otherAgent.id}/repository-options`),
      RepositoryOptionListResponse,
      200,
    );
    assert.deepEqual(allowed.data, options.data);
  });

  test("Repository options preserve an empty successful discovery", async (t) => {
    const f = await admissionFixture(fixture, t);
    const reconfigured = await f.compose({
      ...f.registry,
      repositories: f.registry.repositories.filter(
        (repository) => repository.repositoryRef === "foreign-project",
      ),
    });
    const { data, meta } = checkedEnvelope(
      await reconfigured.request("GET", `${f.collection}/repository-options`),
      RepositoryOptionListResponse,
      200,
    );
    assert.deepEqual(data, []);
    assert.equal(Object.hasOwn(meta, "notConfigured"), false);
  });
}

export function registerRepositoryAdmissionCases({
  fixture,
  kubernetesCompute,
  selection,
  backendId,
}: AdmissionInputs) {
  test("Repository discovery supports a dedicated-only Compute Driver without admitting unsupported Harnesses", async (t) => {
    // Discovery must support a Driver that admits a narrower topology than the Harness catalog.
    for (const [harness, executionMode, status] of [
      ["codex", "dedicated", 202],
      ["openclaw", "embedded", 409],
    ] as const) {
      const f = await admissionFixture(fixture, t, {
        compute: kubernetesCompute(DedicatedRepositoryComputeDriver),
        harness,
      });
      const { data: options } = checkedEnvelope(
        await f.request("GET", `${f.collection}/repository-options`),
        RepositoryOptionListResponse,
        200,
      );
      assert.equal(options[0]?.repositoryRef, "project");

      if (status === 409) {
        // Agent save and deployment refuse the same unsupported topology (finding 1117).
        const payload: CreateAgentBody = {
          name: `Repository Agent ${randomUUID()}`,
          configurationId: f.configurationId,
          executionMode,
          repositoryBindings: selection,
        };
        const { error } = checkedEnvelope(
          await f.request("POST", f.collection, payload),
          ErrorResponse,
          status,
        );
        assert.equal(error.code, "RESOURCE_CONFLICT");
        assert.equal(error.message, COMPUTE_TOPOLOGY_REPOSITORY_UNSUPPORTED);
        const { data: agents } = checkedEnvelope(
          await f.request("GET", f.collection),
          AgentListResponse,
          200,
        );
        assert.deepEqual(agents, []);
        continue;
      }
      const agent = await createAgent(f, { executionMode, repositoryBindings: selection });
      await f.prepareDeployment(agent);
      const { data: deployed } = checkedEnvelope(
        await f.request("POST", `${f.collection}/${agent.id}/deploy`),
        AgentRevisionResponse,
        status,
      );
      assert.equal(deployed.harness.mode, "dedicated");
      assert.equal(deployed.repositoryCredentials?.bindings[0]?.repositoryRef, "project");
    }
  });

  test("Missing repository composition cannot hide denied or unavailable IAM", async (t) => {
    const f = await admissionFixture(fixture, t, { repositories: false });
    const path = `${f.collection}/repository-options`;
    // Authorized callers can distinguish an unconfigured Installation from an outage (finding 2387).
    const { data, meta } = checkedEnvelope(
      await f.request("GET", path),
      RepositoryOptionListResponse,
      200,
    );
    assert.deepEqual(data, []);
    assert.equal(meta.notConfigured, true);

    const restriction = restrict(f.iamState, "create", "agent", { namespaceId: f.namespaceId });
    const { error: denied } = checkedEnvelope(await f.request("GET", path), ErrorResponse, 403);
    assert.equal(denied.code, "FORBIDDEN");
    liftRestriction(f.iamState, restriction);

    // Fail the real Native IAM store during identity lookup, then after lookup at authorization.
    for (const successfulReads of [0, 1]) {
      f.failIAMAfterReads(successfulReads);
      const { error } = checkedEnvelope(await f.request("GET", path), ErrorResponse, 503);
      assert.equal(error.code, "DEPENDENCY_UNAVAILABLE");
      assert.equal(error.message, DEPENDENCY_UNAVAILABLE);
    }
  });

  test("Successful repository discovery does not authorize later writes", async (t) => {
    const f = await admissionFixture(fixture, t);
    const agent = await createAgent(f, { repositoryBindings: selection });
    await f.prepareDeployment(agent);
    const path = `${f.collection}/${agent.id}`;
    const before = await readAgent(f.request, path);
    checkedEnvelope(
      await f.request("GET", `${f.collection}/repository-options`),
      RepositoryOptionListResponse,
      200,
    );

    const bindings = { configurationId: f.configurationId, repositoryBindings: selection };
    const update: UpdateAgentBody = bindings;
    const create: CreateAgentBody = { ...bindings, name: "Denied Agent" };
    for (const [action, method, target, payload] of [
      ["create", "POST", f.collection, create],
      ["update", "PATCH", path, update],
      ["deploy", "POST", `${path}/deploy`, undefined],
    ] as const) {
      // Each mutation must get a fresh IAM decision after discovery succeeds.
      const restriction = restrict(f.iamState, action, "agent", {
        id: `deny-${action}-after-discovery`,
        namespaceId: f.namespaceId,
      });
      try {
        const { error } = checkedEnvelope(
          await f.request(method, target, payload),
          ErrorResponse,
          403,
        );
        assert.equal(error.code, "FORBIDDEN");
      } finally {
        liftRestriction(f.iamState, restriction);
      }
    }
    const unchanged = await readAgent(f.request, path);
    const { data: agents } = checkedEnvelope(
      await f.request("GET", f.collection),
      AgentListResponse,
      200,
    );
    const { data: revisions } = checkedEnvelope(
      await f.request("GET", `${path}/revisions`),
      AgentRevisionListResponse,
      200,
    );
    assert.deepEqual(unchanged, before);
    assert.deepEqual(agents, [before]);
    assert.deepEqual(revisions, []);
  });

  test("Repository bindings normalize through Agent create and preserve or clear through PATCH", async (t) => {
    const f = await admissionFixture(fixture, t);
    for (const fields of [{}, { repositoryBindings: [] }]) {
      const agent = await createAgent(f, fields);
      assert.equal(Object.hasOwn(agent, "repositoryBindings"), false);
    }
    const agent = await createAgent(f, { repositoryBindings: [{ repositoryRef: "project" }] });
    const path = `${f.collection}/${agent.id}`;
    assert.deepEqual(agent.repositoryBindings, selection);
    const saved = await readAgent(f.request, path);
    assert.deepEqual(saved.repositoryBindings, selection);

    const patch: UpdateAgentBody = { configurationId: f.configurationId };
    const { data: preserved } = checkedEnvelope(
      await f.request("PATCH", path, patch),
      AgentResponse,
      200,
    );
    assert.deepEqual(preserved.repositoryBindings, selection);
    const clearedPatch: UpdateAgentBody = { ...patch, repositoryBindings: [] };
    const { data: cleared } = checkedEnvelope(
      await f.request("PATCH", path, clearedPatch),
      AgentResponse,
      200,
    );
    assert.equal(Object.hasOwn(cleared, "repositoryBindings"), false);
    const current = await readAgent(f.request, path);
    assert.equal(Object.hasOwn(current, "repositoryBindings"), false);

    // A configured GitHub Backend cannot supply an Agent ServiceAccount association.
    const wrongBackend: CreateAgentBody = {
      name: "Wrong Backend kind",
      configurationId: f.configurationId,
      backendId,
    };
    const { error } = checkedEnvelope(
      await f.request("POST", f.collection, wrongBackend),
      ErrorResponse,
      404,
    );
    assert.equal(error.code, "NOT_FOUND");
  });
}

export function registerRepositoryAccessUpdateCases({
  fixture,
  selection,
}: Pick<AdmissionInputs, "fixture" | "selection">) {
  test("Agent repository access preserves inheritance intent and admits only resolved approved profiles", async (t) => {
    const f = await admissionFixture(fixture, t);
    const intent: NonNullable<CreateAgentBody["repositoryAccess"]> = {
      defaultProfile: "git-full",
      repositories: [{ repositoryRef: "project" }],
    };
    const agent = await createAgent(f, { repositoryAccess: intent });
    const path = `${f.collection}/${agent.id}`;
    assert.deepEqual(agent.repositoryAccess, intent);
    assert.deepEqual(agent.repositoryBindings, [{ repositoryRef: "project", profile: "git-full" }]);

    const updateAgent = async (fields: UpdateAgentBody) =>
      checkedEnvelope(
        await f.request("PATCH", path, { configurationId: f.configurationId, ...fields }),
        AgentResponse,
        200,
      ).data;
    assert.deepEqual((await readAgent(f.request, path)).repositoryAccess, intent);
    checkedEnvelope(
      await f.request("GET", `${path}/repository-options`),
      RepositoryOptionListResponse,
      200,
    );
    assert.deepEqual((await updateAgent({})).repositoryAccess, intent);

    // An explicit override stays explicit even while it equals the Agent default.
    const custom: typeof intent = {
      defaultProfile: "git-full",
      repositories: [{ repositoryRef: "project", profile: "git-full" }],
    };
    const explicit = await updateAgent({ repositoryAccess: custom });
    assert.deepEqual(explicit.repositoryAccess, custom);
    const updatedDefault = { ...custom, defaultProfile: "git-read" };
    const changed = await updateAgent({ repositoryAccess: updatedDefault });
    assert.deepEqual(changed.repositoryAccess, updatedDefault);
    assert.deepEqual(changed.repositoryBindings, agent.repositoryBindings);

    // Resetting to inheritance applies the new default while preserving the omitted profile.
    const reset = { ...intent, defaultProfile: "git-read" };
    const inherited = await updateAgent({ repositoryAccess: reset });
    assert.deepEqual(inherited.repositoryAccess, reset);
    assert.deepEqual(inherited.repositoryBindings, [
      { repositoryRef: "project", profile: "git-read" },
    ]);
    const { error: denied } = checkedEnvelope(
      await f.request("PATCH", path, {
        configurationId: f.configurationId,
        repositoryAccess: { ...reset, defaultProfile: "unapproved" },
      }),
      ErrorResponse,
      400,
    );
    assert.equal(denied.message, REPOSITORY_SELECTION_NOT_APPROVED);
    assert.deepEqual((await readAgent(f.request, path)).repositoryAccess, reset);

    const { error: ambiguous } = checkedEnvelope(
      await f.request("PATCH", path, {
        configurationId: f.configurationId,
        repositoryAccess: reset,
        repositoryBindings: selection,
      }),
      ErrorResponse,
      400,
    );
    assert.equal(ambiguous.message, REPOSITORY_ACCESS_OR_BINDINGS);
    const legacy = await updateAgent({ repositoryBindings: selection });
    assert.equal(Object.hasOwn(legacy, "repositoryAccess"), false);
    const empty: typeof intent = { defaultProfile: "git-full", repositories: [] };
    const cleared = await updateAgent({ repositoryAccess: empty });
    assert.deepEqual(cleared.repositoryAccess, empty);
    assert.equal(Object.hasOwn(cleared, "repositoryBindings"), false);
  });

  test("Agent updates apply repository access and validate plugin policy together", async (t) => {
    const f = await admissionFixture(fixture, t);
    const driver = new OCCPluginDriver();
    f.controller.registerDriver(driver);
    f.controller.selectDriver("plugin", driver.id);
    const initialAccess: NonNullable<CreateAgentBody["repositoryAccess"]> = {
      defaultProfile: "git-read",
      repositories: [{ repositoryRef: "project" }],
    };
    const initialPlugins = { "occ-plugin:diffs": { enabled: true } };
    const agent = await createAgent(f, {
      repositoryAccess: initialAccess,
      plugins: initialPlugins,
    });
    const path = `${f.collection}/${agent.id}`;
    const nextAccess = { ...initialAccess, defaultProfile: "git-full" };

    // A policy the selected Driver cannot enforce rejects the whole update, including access.
    const rejected: UpdateAgentBody = {
      configurationId: f.configurationId,
      repositoryAccess: nextAccess,
      plugins: { "occ-plugin:diffs": { enabled: true, toolDefaults: { approval: "all_actions" } } },
    };
    const { error } = checkedEnvelope(await f.request("PATCH", path, rejected), ErrorResponse, 400);
    assert.equal(error.code, "INVALID_REQUEST");
    assert.equal(error.message, "The supplied plugin policies are invalid.");
    const unchanged = await readAgent(f.request, path);
    assert.deepEqual(unchanged.repositoryAccess, initialAccess);
    assert.deepEqual(unchanged.repositoryBindings, [
      { repositoryRef: "project", profile: "git-read" },
    ]);
    assert.deepEqual(unchanged.plugins, initialPlugins);

    const nextPlugins = {
      "occ-plugin:diffs": { enabled: true, toolDefaults: { approval: "none" } },
    } satisfies NonNullable<UpdateAgentBody["plugins"]>;
    const payload: UpdateAgentBody = {
      configurationId: f.configurationId,
      repositoryAccess: nextAccess,
      plugins: nextPlugins,
    };
    const { data: updated } = checkedEnvelope(
      await f.request("PATCH", path, payload),
      AgentResponse,
      200,
    );
    assert.deepEqual(updated.repositoryAccess, nextAccess);
    assert.deepEqual(updated.repositoryBindings, [
      { repositoryRef: "project", profile: "git-full" },
    ]);
    assert.deepEqual(updated.plugins, nextPlugins);
    assert.deepEqual(await readAgent(f.request, path), updated);
  });
}
