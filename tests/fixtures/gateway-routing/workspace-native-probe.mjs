import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createWorkspaceFilesAccess } from "../../../apps/controller/src/composition/workspace-files.ts";
import { createNativeWorkspaceFilesAccess } from "../../../apps/controller/src/gateway/workspace-files-client.ts";
import { createDevelopmentComputeDriver } from "../../helpers/development.mjs";
import { createTestSecretDriver } from "../../helpers/secret-driver.mjs";
import { bindRole } from "../../helpers/iam-grants.mjs";
import { createTenantReaderFixture, tenantRequest } from "../../helpers/tenant-reader-app.mjs";

const scenario = JSON.parse(readFileSync(0, "utf8"));
const keyPath = process.env.OCC_WORKSPACE_PROOF_KEY_PATH;
const endpoint = process.env.OCC_WORKSPACE_PROOF_ENDPOINT;
const compute = {
  ...createDevelopmentComputeDriver(),
  getGatewayEndpoint: () => endpoint,
};
const access = createWorkspaceFilesAccess(compute, keyPath);
const fixture = await createTenantReaderFixture({
  installationId: "ins_0366c9eb-b61a-4f6b-8722-a885a9b0d94b",
  label: "native-workspace-files",
  administratorName: "Workspace administrator",
  readerName: "Workspace reader",
  administratorPermissions: [
    ...["installation", "namespace", "configuration", "agent", "agent_revision"].map(
      (resourceKind) => ({ action: "read", resourceKind }),
    ),
    { action: "administer", resourceKind: "installation" },
    ...["namespace", "configuration", "secret", "agent"].map((resourceKind) => ({
      action: "create",
      resourceKind,
    })),
    { action: "operate", resourceKind: "secret" },
    { action: "deploy", resourceKind: "agent" },
    { action: "operate", resourceKind: "agent" },
  ],
  computeDriver: compute,
  secretDriver: createTestSecretDriver(),
  appOptions: () => ({ workspaceFilesAccess: access, publicOrigin: "http://127.0.0.1" }),
});
const call = (path, options) => tenantRequest(fixture.app, path, options);
assert.equal(
  (await call("/installation/bootstrap", { body: { name: "Native workspace test" } })).response
    .status,
  201,
);
const namespace = (await call("/namespaces", { body: { name: "Workspace test" } })).payload.data;
await fixture.controller.transact((unit) =>
  unit.namespaces.transitionNamespaceStatus(namespace.id, "provisioning", "ready"),
);
let sequence = 0;
async function admitRevision(agents, executionMode) {
  sequence++;
  const configuration = await call(`/namespaces/${namespace.id}/configurations`, {
    body: { kind: "agent", values: { agents } },
  });
  assert.equal(configuration.response.status, 201);
  const secret = await fixture.controller.createSecret(fixture.administrator.id, {
    namespaceId: namespace.id,
    name: `unused-model-key-${sequence}`,
    value: "synthetic-workspace-model-key",
  });
  const created = await call(`/namespaces/${namespace.id}/agents`, {
    body: {
      name: `Workspace Agent ${sequence}`,
      executionMode,
      configurationId: configuration.payload.data.id,
      harnessAuth: { method: "api_key", source: secret.ref },
    },
  });
  assert.equal(created.response.status, 201);
  const agent = await fixture.controller.getAgent(
    fixture.administrator.id,
    namespace.id,
    created.payload.data.id,
  );
  fixture.state.identities.push({
    kind: "service_principal",
    id: agent.servicePrincipalId,
    namespaceId: namespace.id,
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
    namespaceId: namespace.id,
    resource: { kind: "secret", id: secret.id },
  });
  const deployed = await call(`/namespaces/${namespace.id}/agents/${agent.id}/deploy`, {
    method: "POST",
  });
  assert.equal(deployed.response.status, 202, JSON.stringify(deployed.payload));
  // The development state fixture admits the revision; native file effects below
  // use the real composition/client and Gateway. This does not run a worker.
  await fixture.controller.transact((unit) =>
    unit.agents.compareAndSetActiveRevision(
      namespace.id,
      agent.id,
      undefined,
      deployed.payload.data.id,
    ),
  );

  return { agent, revision: deployed.payload.data };
}
const { agent, revision } = await admitRevision(scenario.agents, "embedded");
assert.equal(revision.harness.id, "openclaw");
assert.equal(revision.harness.mode, "embedded");
const path = `/namespaces/${namespace.id}/agents/${agent.id}/workspace/files/USER.md`;
const put = () =>
  call(path, {
    method: "PUT",
    headers: { origin: "http://127.0.0.1" },
    body: { content: scenario.content },
  });
const write = await put();
assert.equal(write.response.status, 200, JSON.stringify(write.payload));
assert.equal(write.payload.data.size, Buffer.byteLength(scenario.content));
const read = await call(path);
assert.equal(read.response.status, 200, JSON.stringify(read.payload));
assert.equal(read.payload.data.content, scenario.content);

// Identity-specific native grants retain the existing read/admin write boundary.
await writeFile(keyPath, "proof-read");
assert.equal((await call(path)).response.status, 200);
assert.equal((await put()).response.status, 503);
await writeFile(keyPath, "proof-write");
assert.equal((await call(path)).response.status, 503);
assert.equal((await put()).response.status, 503);
await writeFile(keyPath, "proof-admin");

if (scenario.explicitAgentId !== undefined) {
  const request = {
    revision,
    filename: "USER.md",
    deadline: new Date(Date.now() + 15_000),
    signal: new AbortController().signal,
  };
  const explicit = createNativeWorkspaceFilesAccess(() => ({
    url: endpoint,
    nativeAgentId: scenario.explicitAgentId,
    apiKey: "proof-admin",
  }));
  const result = await explicit.read(request);
  assert.equal(result.status, "ok");
  assert.equal(result.file.content, scenario.content);

  // Dedicated Codex keeps main even when this file-only Gateway announces a sole
  // non-main roster. This exercises target selection, not a Codex workload.
  const dedicatedAgents = structuredClone(scenario.agents);
  dedicatedAgents.defaults.model = dedicatedAgents.defaults.model.replace(/^openai\//, "codex/");
  dedicatedAgents.defaults.models = {
    [dedicatedAgents.defaults.model]: { agentRuntime: { id: "codex" } },
  };
  const dedicated = await admitRevision(dedicatedAgents, "dedicated");
  assert.equal(dedicated.revision.harness.id, "codex");
  assert.equal(dedicated.revision.harness.mode, "dedicated");
  const dedicatedRead = await call(
    `/namespaces/${namespace.id}/agents/${dedicated.agent.id}/workspace/files/USER.md`,
  );
  assert.equal(dedicatedRead.response.status, 503);

  const main = createNativeWorkspaceFilesAccess(() => ({
    url: endpoint,
    nativeAgentId: "main",
    apiKey: "proof-admin",
  }));
  assert.deepEqual(await main.read(request), { status: "unavailable" });
}
process.stdout.write(JSON.stringify({ apiWrite: 200, apiRead: 200, scopeControls: true }) + "\n");
