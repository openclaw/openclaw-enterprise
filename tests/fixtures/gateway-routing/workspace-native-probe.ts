import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { Check } from "typebox/value";
import { createWorkspaceFilesAccess } from "../../../apps/controller/src/composition/workspace-files.ts";
import type { ControllerWorkspaceFileReadRequest } from "../../../apps/controller/src/gateway/contracts.ts";
import { createNativeWorkspaceFilesAccess } from "../../../apps/controller/src/gateway/workspace-files-client.ts";
import { RevisionId } from "../../../packages/contracts/src/api/common.ts";
import type {
  HarnessExecutionMode,
  Permission,
  OpenClawConfigurationDocument,
  OpenClawConfigurationValue,
} from "../../../packages/contracts/src/index.ts";
import { createDevelopmentComputeDriver } from "../../helpers/development.ts";
import { createTestSecretDriver } from "../../helpers/secret-driver.ts";
import { bindRole } from "../../helpers/iam-grants.mjs";
import {
  createTenantReaderFixture,
  tenantRequest,
  type TenantRequestOptions,
} from "../../helpers/tenant-reader-app.ts";

export type WorkspaceNativeProbeInput = {
  agents: OpenClawConfigurationDocument;
  explicitAgentId?: string;
  content: string;
  deniedWrite: {
    identity: "proof-read" | "proof-write";
    content: string;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isConfigurationValue(value: unknown): value is OpenClawConfigurationValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isConfigurationValue);
  }
  return isConfigurationDocument(value);
}

function isConfigurationDocument(value: unknown): value is OpenClawConfigurationDocument {
  return isRecord(value) && Object.values(value).every(isConfigurationValue);
}

function readInput(): WorkspaceNativeProbeInput {
  const input: unknown = JSON.parse(readFileSync(0, "utf8"));
  assert.ok(isRecord(input));
  const { agents, explicitAgentId, content, deniedWrite } = input;
  assert.ok(isConfigurationDocument(agents));
  assert.ok(explicitAgentId === undefined || typeof explicitAgentId === "string");
  assert.ok(typeof content === "string");
  assert.ok(isRecord(deniedWrite));
  const { identity, content: deniedContent } = deniedWrite;
  assert.ok(identity === "proof-read" || identity === "proof-write");
  assert.ok(typeof deniedContent === "string");
  assert.notEqual(deniedContent, content);
  return {
    agents,
    ...(explicitAgentId === undefined ? {} : { explicitAgentId }),
    content,
    deniedWrite: { identity, content: deniedContent },
  };
}

function responseRecord(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}

function resourceId(value: unknown): string {
  const { id } = responseRecord(value);
  assert.ok(typeof id === "string");
  return id;
}

const scenario = readInput();
const keyPath = process.env.OCC_WORKSPACE_PROOF_KEY_PATH;
const endpoint = process.env.OCC_WORKSPACE_PROOF_ENDPOINT;
assert.ok(keyPath, "OCC_WORKSPACE_PROOF_KEY_PATH is required");
assert.ok(endpoint, "OCC_WORKSPACE_PROOF_ENDPOINT is required");
const compute = {
  ...createDevelopmentComputeDriver(),
  getGatewayEndpoint: () => endpoint,
};
const access = createWorkspaceFilesAccess(compute, keyPath);
const readableResources: Permission["resourceKind"][] = [
  "installation",
  "namespace",
  "configuration",
  "agent",
  "agent_revision",
];
const creatableResources: Permission["resourceKind"][] = [
  "namespace",
  "configuration",
  "secret",
  "agent",
];

const fixture = await createTenantReaderFixture({
  installationId: "ins_0366c9eb-b61a-4f6b-8722-a885a9b0d94b",
  label: "native-workspace-files",
  administratorName: "Workspace administrator",
  readerName: "Workspace reader",
  administratorPermissions: [
    ...readableResources.map((resourceKind): Permission => ({ action: "read", resourceKind })),
    { action: "administer", resourceKind: "installation" },
    ...creatableResources.map((resourceKind): Permission => ({ action: "create", resourceKind })),
    { action: "operate", resourceKind: "secret" },
    { action: "deploy", resourceKind: "agent" },
    { action: "operate", resourceKind: "agent" },
  ],
  computeDriver: compute,
  secretDriver: createTestSecretDriver(),
  appOptions: () => ({
    workspaceFilesAccess: access,
    publicOrigin: "https://console.oce.localhost",
  }),
});
const call = (path: string, options?: TenantRequestOptions) =>
  tenantRequest(fixture.app, path, options);
assert.equal(
  (await call("/installation/bootstrap", { body: { name: "Native workspace test" } })).response
    .status,
  201,
);
const namespace = await call("/namespaces", { body: { name: "Workspace test" } });
assert.equal(namespace.response.status, 201);
const namespaceId = resourceId(namespace.payload.data);
const controller = fixture.controller;
assert.ok(controller);
await controller.transact((unit) =>
  unit.namespaces.transitionNamespaceStatus(namespaceId, "provisioning", "ready"),
);
let sequence = 0;
const admitRevision = async (
  agents: OpenClawConfigurationDocument,
  executionMode: HarnessExecutionMode,
  harnessId: string,
) => {
  sequence += 1;
  const configuration = await call(`/namespaces/${namespaceId}/configurations`, {
    body: { kind: "agent", values: { agents } },
  });
  assert.equal(configuration.response.status, 201);
  const secret = await controller.createSecret(fixture.administrator.id, {
    namespaceId,
    name: `unused-model-key-${sequence}`,
    value: "synthetic-workspace-model-key",
  });
  const created = await call(`/namespaces/${namespaceId}/agents`, {
    body: {
      name: `Workspace Agent ${sequence}`,
      executionMode,
      configurationId: resourceId(configuration.payload.data),
      harnessAuth: { method: "api_key", source: secret.ref },
    },
  });
  assert.equal(created.response.status, 201);
  const agent = await controller.getAgent(
    fixture.administrator.id,
    namespaceId,
    resourceId(created.payload.data),
  );
  fixture.state.identities.push({
    kind: "service_principal",
    id: agent.servicePrincipalId,
    namespaceId,
    agentId: agent.id,
  });
  const roleId = `model-${agent.id}`;
  fixture.state.roles.push({
    id: roleId,
    permissions: [{ action: "operate", resourceKind: "secret" }],
  });
  bindRole(fixture.state, agent.servicePrincipalId, {
    id: roleId,
    roleId,
    namespaceId,
    resource: { kind: "secret", id: secret.id },
  });
  const deployed = await call(`/namespaces/${namespaceId}/agents/${agent.id}/deploy`, {
    method: "POST",
  });
  assert.equal(deployed.response.status, 202, JSON.stringify(deployed.payload));
  const { id: revisionId, harness: reportedHarness } = responseRecord(deployed.payload.data);
  assert.ok(Check(RevisionId, revisionId), "Expected an AgentRevision ID in the deploy response");
  const harness = responseRecord(reportedHarness);
  assert.equal(harness.id, harnessId);
  assert.equal(harness.mode, executionMode);
  // The development state fixture admits the revision; native file effects below
  // use the real composition/client and Gateway. This does not run a worker.
  await controller.transact((unit) =>
    unit.agents.compareAndSetActiveRevision(namespaceId, agent.id, undefined, revisionId),
  );

  return { agent, revisionId };
};

const { agent, revisionId } = await admitRevision(scenario.agents, "embedded", "openclaw");
const path = `/namespaces/${namespaceId}/agents/${agent.id}/workspace/files/USER.md`;
const put = (content: string) =>
  call(path, {
    method: "PUT",
    body: { content },
  });
const write = await put(scenario.content);
assert.equal(write.response.status, 200, JSON.stringify(write.payload));
assert.equal(responseRecord(write.payload.data).size, Buffer.byteLength(scenario.content));
const read = await call(path);
assert.equal(read.response.status, 200, JSON.stringify(read.payload));
assert.equal(responseRecord(read.payload.data).content, scenario.content);

const { explicitAgentId } = scenario;
if (explicitAgentId !== undefined) {
  const revision = await controller.getRevision(
    fixture.administrator.id,
    namespaceId,
    agent.id,
    revisionId,
  );
  const request: ControllerWorkspaceFileReadRequest = {
    revision,
    filename: "USER.md",
    deadline: new Date(Date.now() + 15_000),
    signal: new AbortController().signal,
  };
  const explicit = createNativeWorkspaceFilesAccess(() => ({
    url: endpoint,
    nativeAgentId: explicitAgentId,
    apiKey: "proof-admin",
  }));
  const result = await explicit.read(request);
  assert.equal(result.status, "ok");
  assert.equal(result.file.content, scenario.content);

  // Dedicated Codex keeps main even when this file-only Gateway announces a sole
  // non-main roster. This exercises target selection, not a Codex workload.
  const { defaults } = scenario.agents;
  assert.ok(isConfigurationDocument(defaults));
  assert.ok(typeof defaults.model === "string");
  const model = defaults.model.replace(/^openai\//, "codex/");
  const dedicatedAgents = {
    ...scenario.agents,
    defaults: {
      ...defaults,
      model,
      models: { [model]: { agentRuntime: { id: "codex" } } },
    },
  };
  const dedicated = await admitRevision(dedicatedAgents, "dedicated", "codex");
  const dedicatedRead = await call(
    `/namespaces/${namespaceId}/agents/${dedicated.agent.id}/workspace/files/USER.md`,
  );
  assert.equal(dedicatedRead.response.status, 503);

  const main = createNativeWorkspaceFilesAccess(() => ({
    url: endpoint,
    nativeAgentId: "main",
    apiKey: "proof-admin",
  }));
  assert.deepEqual(await main.read(request), { status: "unavailable" });
}
// Finish with one denied write so the parent can inspect native disk before
// another probe's successful admin PUT could hide an unauthorized file change.
const deniedWrite = scenario.deniedWrite;
await writeFile(keyPath, deniedWrite.identity);
assert.equal((await call(path)).response.status, deniedWrite.identity === "proof-read" ? 200 : 503);
assert.equal((await put(deniedWrite.content)).response.status, 503);
process.stdout.write(
  JSON.stringify({
    apiWrite: 200,
    apiRead: 200,
    scopeControls: true,
    deniedIdentity: deniedWrite.identity,
  }) + "\n",
);
