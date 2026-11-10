import assert from "node:assert/strict";
import test from "node:test";
import { exerciseHarnessOverrides } from "../helpers/harness-overrides.ts";
import { staticEgressFixture } from "../helpers/static-egress.mjs";
import type { AgentRevision, EgressRoute } from "../../packages/contracts/src/index.ts";
import type { PlatformUnitOfWork } from "../../packages/occ/src/index.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";

// Real HTTP, IAM, OCC and Compute admission. The Console fixture simulates Namespace and
// runtime-credential provisioning; these cases make no cluster or model-execution claim.
for (const harness of ["codex", "openclaw"] as const) {
  for (const configured of [false, true]) {
    test(`${harness} deployment ${configured ? "binds the shared provider" : "retains native defaults"} and preserves its destination across default changes`, async (t) => {
      const modelProvider = {
        protocol: "openai-responses" as const,
        baseUrl: "https://models.example.test/v1",
      };
      const f = await createConsoleAppFixture(t, { ...(configured ? { modelProvider } : {}) });
      await f.bootstrap();
      const namespace = await f.createNamespace("shared-provider", { ready: true });
      const computeDriver = f.controller.selectedDriver("compute");
      const authored = createHarnessConfiguration(harness, "gpt-5");
      // Retain the Gateway password reference needed for private workspace-node status.
      const configuration = {
        ...authored,
        gateway: {
          ...authored.gateway,
          auth: {
            ...authored.gateway.auth,
            mode: "trusted-proxy",
            trustedProxy: {
              userHeader: "x-occ-identity",
              allowUsers: ["occ-workspace-files"],
            },
          },
        },
      };
      const agent = await f.createAgent(namespace.id, "shared-provider-agent", configuration, {
        executionMode: harness === "codex" ? "dedicated" : "embedded",
      });
      const refused = await f.request(
        "POST",
        `/namespaces/${namespace.id}/agents/${agent.id}/deploy`,
        {
          body: { harnessOverrides: { modelProvider } },
        },
      );
      assert.equal(refused.status, 400);
      assert.match(refused.body.error.message, /source-backed OpenAI API-key/);
      const deployed = await f.deployAgent(namespace.id, agent.id);
      const revision: Readonly<AgentRevision> | undefined = await f.controller.transact(
        (unit: PlatformUnitOfWork) =>
          unit.revisions.findRevision(namespace.id, agent.id, deployed.id),
      );
      assert.ok(revision);
      assert.match(revision.compute.admission ?? "", /^model-provider:v1:[a-f0-9]{64}:/);
      assert.deepEqual(revision.harness.overrides, {});
      assert.deepEqual(revision.harness.configuration, {
        modelProvider: {
          protocol: "openai-responses",
          baseUrl: configured ? modelProvider.baseUrl : "https://api.openai.com/v1",
          supportsStandaloneWebSearch: false,
        },
      });
      assert.equal(revision.harness.id, harness);
      // Recomputing the admission with changed defaults must preserve the saved fingerprint.
      for (const replacement of [
        ...(configured ? [undefined] : []),
        { ...modelProvider, baseUrl: "https://other.example.test/v1" },
      ]) {
        const changed = createTestKubernetesComputeDriver(computeDriver.id, {
          gatewayRuntime: true,
          ...(replacement === undefined ? {} : { modelProvider: replacement }),
        });
        assert.equal(changed.admitRevision(revision), revision.compute.admission);
        const { configuration: _settings, ...missingSettings } = revision.harness;
        await assert.rejects(
          // Deliberately corrupt saved state to verify refusal before any delivery.
          changed.prepareRevision({
            ...revision,
            harness: missingSettings,
          } as unknown as AgentRevision),
          /Harness settings/,
        );
      }
      assert.equal(revision.compute.admission, computeDriver.admitRevision?.(revision));
    });
  }
}

test("ordinary deployment admits concurrent source-authorized destinations and isolates first-deployment intent", async (t) => {
  await exerciseHarnessOverrides(t);
});

test("Agents share a named provider while their revisions pin the route, model metadata, and allowed operation", async (t) => {
  const f = await staticEgressFixture(t, { admitRevision: false });
  assert.ok("grant" in f);
  const root = `/namespaces/${f.namespace.id}`;
  const request = async (method: string, path: string, body: unknown, status: number) => {
    const result = await f.request(method, path, { body });
    assert.equal(result.status, status, JSON.stringify(result.body));
    return result.data;
  };
  const template = await request(
    "POST",
    "/connection-templates",
    { displayName: "Inference key", mode: "static_bearer", ...f.modelProvider },
    201,
  );
  const values = {
    displayName: "Research models",
    ...f.modelProvider,
    connectionTemplateId: template.id,
    models: [{ id: "fixture-model", contextWindow: 8192, maxTokens: 512 }, { id: "another-model" }],
  };
  const provider = await request("POST", "/model-providers", values, 201);
  const key = await request(
    "POST",
    root + "/credential-sources",
    {
      name: "research-key",
      type: "openai",
      secrets: f.source.secrets,
      connectionTemplateId: template.id,
      connectionTemplateVersion: template.current.version,
    },
    201,
  );
  const create = async (name: string, sourceId: string) => {
    const agent = await request(
      "POST",
      root + "/agents",
      {
        name,
        configurationId: f.agent.configurationId,
        modelProviderId: provider.id,
        executionMode: "dedicated",
        harnessAuth: { method: "credential_source", sourceId },
        credentialSources: [{ sourceId }],
      },
      201,
    );
    assert.equal(agent.modelProviderId, provider.id);
    await request(
      "POST",
      root + "/iam/access-bindings",
      {
        subjectKind: "identity",
        subjectId: agent.servicePrincipalId,
        roleId: f.grant.roleId,
        resourceKind: "credential_source",
        resourceId: sourceId,
      },
      201,
    );
    return root + "/agents/" + agent.id;
  };
  const first = await create("first-research-agent", key.id);
  const second = await create("second-research-agent", key.id);
  const revision = await request("POST", first + "/deploy", {}, 202);
  assert.equal(revision.harness.modelProviderId, provider.id);
  assert.equal(revision.harness.configuration.modelProvider.baseUrl, values.baseUrl);
  assert.deepEqual(revision.configuration.models.providers.codex.models, [
    { id: "fixture-model", name: "fixture-model", contextWindow: 8192, maxTokens: 512 },
  ]);
  const saved = await f.controller.transact((state: PlatformUnitOfWork) =>
    state.revisions.findRevision(f.namespace.id, revision.agentId, revision.id),
  );
  // The request sender receives only the admitted protocol's operation, even though the legacy source permits both.
  assert.deepEqual(
    saved?.egressPlan?.routes.map((route: EgressRoute) => [
      route.method,
      route.origin + route.path,
    ]),
    [["POST", values.baseUrl + "/responses"]],
  );
  const next = await request("POST", second + "/deploy", {}, 202);
  assert.deepEqual(next.harness, revision.harness);
  await request(
    "POST",
    first + "/deploy",
    { harnessOverrides: { modelProvider: f.modelProvider } },
    400,
  );
  // A legacy credential approves the same URL but has no consent for this template.
  const unapproved = await create("legacy-key-agent", f.source.id);
  await request("POST", unapproved + "/deploy", {}, 409);
  await request(
    "PUT",
    "/model-providers/" + provider.id,
    { ...values, models: [{ id: "another-model" }] },
    200,
  );
  await request("POST", first + "/deploy", {}, 400);
  const original = await request("GET", first + "/revisions/" + revision.id, undefined, 200);
  assert.deepEqual(original.configuration, revision.configuration);
});
