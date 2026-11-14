import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { OpenShellCredentialGatewayDriver } from "../../apps/controller/src/drivers/credential-gateway/openshell.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { ConfigurationResponse } from "../../packages/contracts/src/api/resources.ts";
import { InMemoryPlatformState } from "../../packages/occ/src/index.ts";
import { assertApiError } from "../helpers/api-error.mjs";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { grantRole } from "../helpers/iam-grants.mjs";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";
import { openShellSandbox } from "../helpers/openshell-sandbox.mjs";
import {
  registerHarnessPlacementAdmissionCases,
  registerWorkspaceSetupAdmissionCases,
} from "./workspace-setup-admission-cases.ts";

const GATEWAY_PASSWORD = { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_PASSWORD" };

async function setup(t, options = {}) {
  const audit = new InMemoryAuditSink();
  const state = new InMemoryPlatformState({ auditSink: audit });
  const fixture = await createConsoleAppFixture(t, { state, backends: [], ...options });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Workspace setup", { ready: true });
  const configuration = await fixture.createConfiguration(namespace.id);
  const path = `/namespaces/${namespace.id}/agents`;
  const create = (name, fields = {}, options = {}) =>
    fixture.request("POST", path, {
      ...options,
      body: { name, configurationId: configuration.id, ...fields },
    });
  const staged = (agentId, namespaceId = namespace.id) =>
    state.read((view) => view.workspaceSetups.find(namespaceId, agentId));
  return { ...fixture, state, audit, namespace, configuration, path, create, staged };
}

/**
 * Saves an Agent Configuration that selects `model` on the `runtime` Harness. A Codex one carries
 * the generated Gateway password, which its Gateway needs to apply the workspace node (finding
 * 3132).
 */
async function storeConfiguration(f, runtime, model) {
  const stored = await f.request("POST", `/namespaces/${f.namespace.id}/configurations`, {
    body: {
      kind: "agent",
      values: {
        agents: { defaults: { model, models: { [model]: { agentRuntime: { id: runtime } } } } },
        ...(runtime === "codex" ? { gateway: { auth: { password: GATEWAY_PASSWORD } } } : {}),
      },
    },
  });
  return f.fixtureResponse(stored, 201, ConfigurationResponse, "store Harness Configuration");
}

registerWorkspaceSetupAdmissionCases({ setup, storeConfiguration });

test("Agent admission refuses projected identity only for OpenShell-owned Harnesses", async (t) => {
  for (const selected of [true, false]) {
    const sandbox = selected ? openShellSandbox(t) : {};
    const computeDriver = createTestKubernetesComputeDriver("identity-admission", {
      sandboxDriver: sandbox.sandboxDriver,
      servicePrincipalCredentials: {
        mode: "projectedServiceAccountToken",
        audience: "occ",
        expirationSeconds: 600,
      },
    });
    const f = await setup(t, sandbox);
    // Namespace setup uses the fixture lifecycle; admission below uses the real Compute
    // validator without provisioning Kubernetes resources or contacting OpenShell.
    f.controller.registerDriver(computeDriver);
    f.controller.selectDriver("compute", computeDriver.id);
    const key = await f.createSecret(f.namespace.id, "model-key", "test-api-key");
    for (const [runtime, model] of [
      ["openclaw", "openai/gpt-4.1"],
      ["codex", "codex/gpt-5.1"],
    ]) {
      // Native dedicated workers require a provider; the no-provider control uses Codex.
      if (!selected && runtime === "openclaw") {
        continue;
      }
      const stored = {
        data: await f.createConfiguration(
          f.namespace.id,
          createHarnessConfiguration(runtime, model.split("/")[1]),
        ),
      };
      const result = await f.create(`Projected ${runtime}`, {
        configurationId: stored.data.id,
        executionMode: "dedicated",
        harnessAuth: { method: "api_key", source: key.ref },
      });
      if (selected) {
        assertApiError(result, 400, "INVALID_REQUEST");
        assert.match(
          result.body.error.message,
          /OpenShell cannot preserve an Agent ServiceAccount/,
        );
        assert.match(result.body.error.message, /servicePrincipalCredentials\.mode to disabled/);
        // Refuse before creating an Agent or staging a revision that can stop a predecessor.
        assert.deepEqual((await f.request("GET", f.path)).data, []);
      } else {
        assert.equal(result.status, 201, JSON.stringify(result.body));
      }
    }
  }
});

test("Credential-source deployment refuses OpenShell projected identity before creating a revision", async (t) => {
  const sandbox = openShellSandbox(t);
  const gateway = new OpenShellCredentialGatewayDriver(
    { binaries: ["/app/bin/codex"] },
    { id: "workspace-openshell-credentials", backend: sandbox.backend },
  );
  const f = await setup(t, sandbox);
  const compute = createTestKubernetesComputeDriver("source-identity-admission", {
    sandboxDriver: sandbox.sandboxDriver,
    credentialGatewayDriver: gateway,
    servicePrincipalCredentials: {
      mode: "projectedServiceAccountToken",
      audience: "occ",
      expirationSeconds: 600,
    },
  });
  for (const driver of [gateway, compute]) {
    f.controller.registerDriver(driver);
    f.controller.selectDriver(driver.capability, driver.id);
  }
  const secret = await f.createSecret(f.namespace.id, "model-token", "synthetic-model-token");
  const sourceId = `cs_${randomUUID()}`;
  // A previously registered source is ready; admission uses its real Driver catalog, not
  // provider provisioning or live model credentials.
  await f.state.transact((unit) =>
    unit.credentialSources.createCredentialSource({
      id: sourceId,
      namespaceId: f.namespace.id,
      name: "Codex account",
      type: "codex-pat",
      config: {},
      secrets: { access_token: secret.ref },
      ownerCapability: "credential_gateway",
      driverId: gateway.id,
      state: "ready",
      createdAt: new Date().toISOString(),
    }),
  );
  const configuration = await f.createConfiguration(
    f.namespace.id,
    createHarnessConfiguration("codex", "gpt-5.1"),
  );
  const saved = await f.create("Credential-source Agent", {
    configurationId: configuration.id,
    executionMode: "dedicated",
    harnessAuth: { method: "credential_source", sourceId },
    credentialSources: [{ sourceId }],
  });
  // Source-backed bindings intentionally defer authentication validation from save to deploy.
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  const agent = saved.data;
  f.policy.identities.push({
    kind: "service_principal",
    id: agent.servicePrincipalId,
    namespaceId: f.namespace.id,
  });
  grantRole(f.policy, agent.servicePrincipalId, {
    id: `source-${agent.id}`,
    namespaceId: f.namespace.id,
    permissions: { credential_source: ["operate"] },
    resource: { kind: "credential_source", id: sourceId },
  });
  const deployed = await f.request("POST", `${f.path}/${agent.id}/deploy`);
  assertApiError(deployed, 400, "INVALID_REQUEST");
  assert.match(deployed.body.error.message, /servicePrincipalCredentials\.mode to disabled/);
  assert.deepEqual((await f.request("GET", `${f.path}/${agent.id}/revisions`)).data, []);
});

// Native OpenClaw's workspace preparation needs userNamespaces: false and at most one operator
// ServiceAccount, and runs only after a deploy has stopped its predecessors, so Agent save refuses
// those settings first and the Installation stops offering dedicated OpenClaw (findings 2334,
// 2346, 2347).
test("Agent create refuses dedicated OpenClaw on OpenShell settings its workspace preparation refuses", async (t) => {
  const userNamespaces =
    "Dedicated OpenClaw needs kubernetes.userNamespaces: false in the OpenShell Sandbox Driver configuration. Select Codex, or ask an operator to set it.";
  const serviceAccounts = ["a", "b"].map((name) => ({
    apiVersion: "v1",
    kind: "ServiceAccount",
    metadata: { name },
  }));
  for (const [kubernetes, gateway, message] of [
    [{ userNamespaces: undefined }, {}, userNamespaces],
    [{ userNamespaces: true }, {}, userNamespaces],
    [
      {},
      { operatorWorkspaceResources: serviceAccounts },
      "Dedicated OpenClaw needs at most one ServiceAccount in gateway.operatorWorkspaceResources of the OpenShell Sandbox Driver configuration. Select Codex, or ask an operator to remove the others.",
    ],
    // Control: the shape workspace preparation accepts.
    [{}, { operatorWorkspaceResources: serviceAccounts.slice(0, 1) }],
  ]) {
    const options = openShellSandbox(t, kubernetes, gateway);
    // Capability reads must not execute this real transformation, even when settings refuse.
    const transform = t.mock.method(options.sandboxDriver, "configureAgent");
    const f = await setup(t, options);
    transform.mock.resetCalls();
    const installation = await f.request("GET", "/installation");
    assert.equal(installation.status, 200, JSON.stringify(installation.body));
    assert.equal(transform.mock.callCount(), 0);
    // Create Agent offers only the modes admission accepts, and shows the refusal that names the
    // setting (finding 2373).
    assert.deepEqual(
      installation.data.capabilities.openclaw,
      message === undefined
        ? { executionModes: ["dedicated"] }
        : { executionModes: [], settingRefusals: { dedicated: message } },
    );
    const openclaw = await storeConfiguration(f, "openclaw", "openai/gpt-4.1");
    const refused = await f.create("OpenShell openclaw", {
      configurationId: openclaw.data.id,
      executionMode: "dedicated",
    });
    if (message === undefined) {
      assert.equal(refused.status, 201, JSON.stringify(refused.body));
      assert.ok(transform.mock.callCount() > 0);
      assert.deepEqual(transform.mock.calls[0].arguments[0], openclaw.data.values);
      continue;
    }
    assertApiError(refused, 400, "INVALID_REQUEST");
    assert.equal(refused.body.error.message, message);
    assert.equal(
      (await f.request("GET", f.path)).data.some(({ name }) => name === "OpenShell openclaw"),
      false,
    );
    // Control: Codex never runs that preparation and still saves.
    const codex = await storeConfiguration(f, "codex", "codex/gpt-5.1");
    const created = await f.create("OpenShell codex", {
      configurationId: codex.data.id,
      executionMode: "dedicated",
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
  }
});

registerHarnessPlacementAdmissionCases({ setup, storeConfiguration });
