import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { ErrorResponse } from "../../packages/contracts/src/api/common.ts";
import {
  AgentListResponse,
  AgentResponse,
  ConfigurationResponse,
  InstallationResponse,
} from "../../packages/contracts/src/api/resources.ts";
import { InMemoryPlatformState } from "../../packages/occ/src/index.ts";
import { assertApiError } from "../helpers/api-error.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { openShellSandbox } from "../helpers/openshell-sandbox.mjs";
import {
  registerHarnessPlacementAdmissionCases,
  registerProjectedIdentityAdmissionCase,
  registerWorkspaceSetupAdmissionCases,
} from "./workspace-setup-admission-cases.ts";

type AdmissionFixtures = Parameters<typeof registerWorkspaceSetupAdmissionCases>[0];
type WorkspaceFixture = Awaited<ReturnType<AdmissionFixtures["setup"]>>;
type SetupOptions = Parameters<AdmissionFixtures["setup"]>[1];
type RequestOptions = Parameters<WorkspaceFixture["request"]>[2];
type Response = Awaited<ReturnType<WorkspaceFixture["request"]>>;
type CreateFields = Record<string, unknown>;

const GATEWAY_PASSWORD = {
  source: "env",
  provider: "default",
  id: "OPENCLAW_GATEWAY_PASSWORD",
};

async function setup(t: TestContext, options: SetupOptions = {}): Promise<WorkspaceFixture> {
  const audit = new InMemoryAuditSink();
  const state = new InMemoryPlatformState({ auditSink: audit });
  const fixture = await createConsoleAppFixture(t, { state, backends: [], ...options });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Workspace setup", { ready: true });
  const configuration = await fixture.createConfiguration(namespace.id);
  const path = `/namespaces/${namespace.id}/agents`;
  const request = async (
    method: string,
    route: string,
    requestOptions?: RequestOptions,
  ): Promise<Response> => fixture.request(method, route, requestOptions);
  const create = (name: string, fields: CreateFields = {}, requestOptions: RequestOptions = {}) =>
    request("POST", path, {
      ...requestOptions,
      body: { name, configurationId: configuration.id, ...fields },
    });
  const staged = (agentId: string, namespaceId = namespace.id) =>
    state.read((view) => view.workspaceSetups.find(namespaceId, agentId));
  return { ...fixture, request, state, audit, namespace, configuration, path, create, staged };
}

// A Codex Configuration carries the Gateway password needed to apply the workspace node.
async function storeConfiguration(
  f: WorkspaceFixture,
  runtime: string,
  model: string,
): Promise<ConfigurationResponse> {
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

async function listAgents(fixture: WorkspaceFixture) {
  const response = await fixture.request("GET", fixture.path);
  return fixture.fixtureResponse(response, 200, AgentListResponse, "list Agents").data;
}

registerWorkspaceSetupAdmissionCases({ setup, storeConfiguration });

registerProjectedIdentityAdmissionCase({ setup });

// Admission must refuse settings that native workspace preparation cannot accept before a
// deployment can stop its predecessor. Codex remains a supported control.
test("Agent create refuses dedicated OpenClaw on OpenShell settings its workspace preparation refuses", async (t) => {
  const userNamespaces =
    "Dedicated OpenClaw needs kubernetes.userNamespaces: false in the OpenShell Sandbox Driver configuration. Select Codex, or ask an operator to set it.";
  const serviceAccountRefusal =
    "Dedicated OpenClaw needs at most one ServiceAccount in gateway.operatorWorkspaceResources of the OpenShell Sandbox Driver configuration. Select Codex, or ask an operator to remove the others.";
  const serviceAccounts = ["a", "b"].map((name) => ({
    apiVersion: "v1",
    kind: "ServiceAccount",
    metadata: { name },
  }));
  const variants: {
    kubernetes: { userNamespaces?: boolean | undefined };
    gateway: { operatorWorkspaceResources?: typeof serviceAccounts };
    message?: string;
  }[] = [
    { kubernetes: { userNamespaces: undefined }, gateway: {}, message: userNamespaces },
    { kubernetes: { userNamespaces: true }, gateway: {}, message: userNamespaces },
    {
      kubernetes: {},
      gateway: { operatorWorkspaceResources: serviceAccounts },
      message: serviceAccountRefusal,
    },
    // With both invalid settings, main admission reports the user-namespace refusal first.
    {
      kubernetes: { userNamespaces: undefined },
      gateway: { operatorWorkspaceResources: serviceAccounts },
      message: userNamespaces,
    },
    {
      kubernetes: { userNamespaces: true },
      gateway: { operatorWorkspaceResources: serviceAccounts },
      message: userNamespaces,
    },
    { kubernetes: {}, gateway: { operatorWorkspaceResources: serviceAccounts.slice(0, 1) } },
  ];
  for (const { kubernetes, gateway, message } of variants) {
    const options = openShellSandbox(t, kubernetes, gateway);
    // Capability reads must not execute the real transformation, even when settings refuse.
    const transform = t.mock.method(options.sandboxDriver, "configureAgent");
    const f = await setup(t, options);
    transform.mock.resetCalls();
    const installationResponse = await f.request("GET", "/installation");
    const { data: installation } = f.fixtureResponse(
      installationResponse,
      200,
      InstallationResponse,
      "read Installation",
    );
    assert.equal(transform.mock.callCount(), 0);
    assert.ok(installation.capabilities);
    assert.deepEqual(
      installation.capabilities.openclaw,
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
      f.fixtureResponse(refused, 201, AgentResponse, "create OpenClaw Agent");
      assert.ok(transform.mock.callCount() > 0);
      const firstCall = transform.mock.calls[0];
      assert.ok(firstCall);
      assert.deepEqual(firstCall.arguments[0], openclaw.data.values);
      continue;
    }
    assertApiError(refused, 400, "INVALID_REQUEST");
    assert.equal(
      f.fixtureResponse(refused, 400, ErrorResponse, "refuse OpenClaw Agent").error.message,
      message,
    );
    assert.equal(
      (await listAgents(f)).some(({ name }) => name === "OpenShell openclaw"),
      false,
    );
    const codex = await storeConfiguration(f, "codex", "codex/gpt-5.1");
    const created = await f.create("OpenShell codex", {
      configurationId: codex.data.id,
      executionMode: "dedicated",
    });
    f.fixtureResponse(created, 201, AgentResponse, "create Codex Agent");
  }
});

registerHarnessPlacementAdmissionCases({ setup, storeConfiguration });
