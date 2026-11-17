import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type {
  AccessBinding,
  AgentRevision,
  EgressRoute,
} from "../../packages/contracts/src/index.ts";
import type { PlatformUnitOfWork } from "../../packages/occ/src/index.ts";
import { staticEgressFixture } from "./static-egress.mjs";

interface HarnessInferenceExpectation {
  readonly namespaceId: string;
  readonly sourceId: string;
  readonly baseUrl: string;
}

export function assertHarnessInferenceRoutes(
  revision: Readonly<AgentRevision>,
  expected: HarnessInferenceExpectation,
): void {
  assert.deepEqual(revision.harness.configuration.modelProvider, {
    protocol: "openai-responses",
    baseUrl: expected.baseUrl,
    supportsStandaloneWebSearch: false,
  });
  assert.ok(revision.egressPlan);
  const routes = revision.egressPlan.routes.map((route: EgressRoute) => ({
    endpoint: route.origin + route.path,
    method: route.method,
    grant: route.binding.grant.kind,
    namespaceId: route.binding.source.namespaceId,
    sourceId: route.binding.source.source.id,
  }));
  // The static OpenAI fixture admits both operations for this exact source. Require
  // its Responses route independently so an empty persisted plan cannot pass.
  const expectedRoutes = ["responses", "chat/completions"].map((operation) => ({
    endpoint: `${expected.baseUrl}/${operation}`,
    method: "POST",
    grant: "inference",
    namespaceId: expected.namespaceId,
    sourceId: expected.sourceId,
  }));
  assert.deepEqual(
    routes.find((route) => route.endpoint === `${expected.baseUrl}/responses`),
    expectedRoutes[0],
    "the admitted Responses route must retain its credential source",
  );
  const byEndpoint = (a: { endpoint: string }, b: { endpoint: string }) =>
    a.endpoint.localeCompare(b.endpoint);
  assert.deepEqual([...routes].sort(byEndpoint), [...expectedRoutes].sort(byEndpoint));
}

// Exercise HTTP, IAM, Compute resolution and Proxy admission with the supplied State implementation.
// External runtime observations remain the existing wire fixture, not live-cluster evidence.
export async function exerciseHarnessOverrides(
  t: TestContext,
  options: Parameters<typeof staticEgressFixture>[1] = {},
  grantSourceOnDeployment = false,
) {
  const f = await staticEgressFixture(t, { ...options, admitRevision: false });
  assert.ok("grant" in f);
  const root = `/namespaces/${f.namespace.id}`;
  const post = async (path: string, body: unknown, status = 201) => {
    const result = await f.request("POST", root + path, { body });
    assert.equal(result.status, status, JSON.stringify(result.body));
    return result.data;
  };
  // Source consent may differ from the Installation default. It does not choose the route.
  const destination = f.modelProvider.baseUrl.replace("/v1", "/evaluation/v1");
  const source = await post("/credential-sources", {
    name: "evaluation",
    type: "openai",
    config: { authorized_base_url: destination },
    secrets: f.source.secrets,
  });
  // Destination restrictions are enforced by protected-source admission. A new
  // Gateway source must be explicitly adopted before this workflow binds it.
  const adopted = await f.request("PATCH", `${root}/credential-sources/${source.id}`, {
    body: { adoption: "live", authorityScope: "execution" },
  });
  assert.equal(adopted.status, 200, JSON.stringify(adopted.body));
  const create = async (name: string, sourceId: string) => {
    const agent = await post("/agents", {
      name,
      configurationId: f.agent.configurationId,
      executionMode: "dedicated",
      harnessAuth: { method: "credential_source", sourceId },
      credentialSources: [{ sourceId }],
    });
    await post("/iam/access-bindings", {
      subjectKind: "identity",
      subjectId: agent.servicePrincipalId,
      roleId: f.grant.roleId,
      resourceKind: "credential_source",
      resourceId: sourceId,
    });
    return agent;
  };
  const alternate = await create("evaluation-agent", source.id);
  const inherited = await create("inherited-agent", f.source.id);
  const overrides = { modelProvider: { protocol: "openai-responses", baseUrl: destination + "/" } };
  const [standard, evaluation, defaults] = await Promise.all([
    post(
      `/agents/${f.agent.id}/deploy`,
      { harnessOverrides: { modelProvider: f.modelProvider } },
      202,
    ),
    post(`/agents/${alternate.id}/deploy`, { harnessOverrides: overrides }, 202),
    post(`/agents/${inherited.id}/deploy`, {}, 202),
  ]);
  assert.equal(standard.harness.configuration.modelProvider.baseUrl, f.modelProvider.baseUrl);
  assert.equal(evaluation.harness.configuration.modelProvider.baseUrl, destination);
  assert.equal(evaluation.harness.overrides.modelProvider.supportsStandaloneWebSearch, false);
  assert.deepEqual(defaults.harness.overrides, {});
  assert.equal(defaults.harness.configuration.modelProvider.baseUrl, f.modelProvider.baseUrl);
  const expectedInference = new Map<string, HarnessInferenceExpectation>([
    [
      standard.id,
      { namespaceId: f.namespace.id, sourceId: f.source.id, baseUrl: f.modelProvider.baseUrl },
    ],
    [evaluation.id, { namespaceId: f.namespace.id, sourceId: source.id, baseUrl: destination }],
    [
      defaults.id,
      { namespaceId: f.namespace.id, sourceId: f.source.id, baseUrl: f.modelProvider.baseUrl },
    ],
  ]);
  const assertStoredInference = async (expected: { agentId: string; id: string }) => {
    const revision: Readonly<AgentRevision> | undefined = await f.controller.transact(
      (unit: PlatformUnitOfWork) =>
        unit.revisions.findRevision(f.namespace.id, expected.agentId, expected.id),
    );
    const inference = expectedInference.get(expected.id);
    assert.ok(revision);
    assert.ok(inference);
    assertHarnessInferenceRoutes(revision, inference);
  };
  for (const expected of [standard, evaluation, defaults]) {
    await assertStoredInference(expected);
  }
  const mismatch = await f.request("POST", `${root}/agents/${alternate.id}/deploy`, { body: {} });
  assert.equal(
    mismatch.status,
    409,
    "inheriting the default must not redirect evaluation credentials",
  );
  const history = await f.request("GET", `${root}/agents/${alternate.id}/revisions`);
  assert.equal(history.data.length, 1, "refused destination must create no revision");

  for (const invalid of [
    null,
    { unsupported: true },
    { modelProvider: null },
    { modelProvider: { protocol: "openai-responses" } },
    {
      modelProvider: { protocol: "openai-responses", baseUrl: "http://evaluation.example.test/v1" },
    },
    { modelProvider: { ...overrides.modelProvider, protocol: "openai-completions" } },
    { modelProvider: { ...overrides.modelProvider, supportsStandaloneWebSearch: "true" } },
  ]) {
    const refused: { status: number; body: unknown } = await f.request(
      "POST",
      `${root}/agents/${alternate.id}/deploy`,
      {
        body: { harnessOverrides: invalid },
      },
    );
    assert.equal(refused.status, 400, JSON.stringify(refused.body));
  }
  const ungranted = await post("/agents", {
    name: "ungranted-evaluation",
    configurationId: f.agent.configurationId,
    executionMode: "dedicated",
    harnessAuth: { method: "credential_source", sourceId: source.id },
    credentialSources: [{ sourceId: source.id }],
  });
  const revisions = [standard, evaluation, defaults];
  if (grantSourceOnDeployment) {
    const bindingsForAgent = async () => {
      const result = await f.request("GET", `${root}/iam/access-bindings`);
      assert.equal(result.status, 200, JSON.stringify(result.body));
      return result.data.filter(
        (binding: AccessBinding) => binding.subjectId === ungranted.servicePrincipalId,
      );
    };
    assert.deepEqual(await bindingsForAgent(), []);
    // Native IAM can grant caller-authorized sources during admission. A destination
    // mismatch must roll that transaction back, leaving neither a revision nor a grant.
    const mismatch = await f.request("POST", `${root}/agents/${ungranted.id}/deploy`, {
      body: { harnessOverrides: { modelProvider: f.modelProvider } },
    });
    assert.equal(mismatch.status, 409, JSON.stringify(mismatch.body));
    assert.deepEqual(await bindingsForAgent(), []);
    assert.deepEqual((await f.request("GET", `${root}/agents/${ungranted.id}/revisions`)).data, []);
    const admitted = await post(
      `/agents/${ungranted.id}/deploy`,
      { harnessOverrides: overrides },
      202,
    );
    const bindings = await bindingsForAgent();
    assert.equal(bindings.length, 1, "admission grants only the referenced source");
    assert.equal(bindings[0].subjectKind, "identity");
    assert.equal(bindings[0].namespaceId, f.namespace.id);
    assert.equal(bindings[0].resourceKind, "credential_source");
    assert.equal(bindings[0].resourceId, source.id);
    assert.equal(admitted.harness.configuration.modelProvider.baseUrl, destination);
    revisions.push(admitted);
    expectedInference.set(admitted.id, {
      namespaceId: f.namespace.id,
      sourceId: source.id,
      baseUrl: destination,
    });
    await assertStoredInference(admitted);
  } else {
    // An IAM policy outside this State cannot receive an automatic deployment grant.
    const denied = await f.request("POST", `${root}/agents/${ungranted.id}/deploy`, {
      body: { harnessOverrides: overrides },
    });
    assert.equal(
      denied.status,
      403,
      "external policy still requires the Agent's explicit source grant",
    );
  }

  const first = await create("first-evaluation", source.id);
  const configuration = await f.request("GET", `${root}/configurations/${first.configurationId}`);
  const intent = {
    key: "reviewed-destination",
    expectedConfigurationId: first.configurationId,
    expectedGeneration: configuration.data.generation,
  };
  const receipt = await post(
    `/agents/${first.id}/deploy-first`,
    { ...intent, harnessOverrides: overrides },
    202,
  );
  // URL normalization and omitted false capability are the same request; another destination is not.
  const normalized = {
    modelProvider: {
      ...overrides.modelProvider,
      baseUrl: destination,
      supportsStandaloneWebSearch: false,
    },
  };
  assert.equal(
    (
      await post(
        `/agents/${first.id}/deploy-first`,
        { ...intent, harnessOverrides: normalized },
        202,
      )
    ).revisionId,
    receipt.revisionId,
  );
  const conflict = await f.request("POST", `${root}/agents/${first.id}/deploy-first`, {
    body: { ...intent, harnessOverrides: { modelProvider: f.modelProvider } },
  });
  assert.equal(conflict.status, 409);
  const recovery = await f.request(
    "GET",
    `${root}/agents/${first.id}/deploy-first/${intent.key}/${intent.expectedConfigurationId}/${intent.expectedGeneration}?harnessOverrides=${encodeURIComponent(JSON.stringify(normalized))}`,
  );
  assert.equal(recovery.status, 200, JSON.stringify(recovery.body));
  assert.equal(recovery.data.revisionId, receipt.revisionId);
  return { fixture: f, revisions, expectedInference };
}
