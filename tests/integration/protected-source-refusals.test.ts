import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { ErrorResponse } from "../../packages/contracts/src/api/common.ts";
import {
  AgentResponse,
  ConfigurationResponse,
} from "../../packages/contracts/src/api/resources.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import {
  protectedSourceFixture,
  protectedSourceInputs,
} from "../helpers/protected-source-refusals.ts";
import { LIVE_SOURCE_MODEL_REQUIRED } from "../helpers/refusal-text.mjs";
import {
  CREDENTIAL_PROXY_SOURCES_WITHOUT_PROXY,
  WITHDRAWAL_SOURCE_NOT_USED,
} from "../helpers/refusal-credential-admission.ts";
import { refusedAnswer } from "../helpers/refusal-answers.ts";

// Finding 2536: these refusals answered a generic 404 (or a 500), though each comes after the
// caller's grants and is about the request or an Installation property. Each now names its
// cause, and none names a resource the caller cannot read.

const credentialFree = protectedSourceInputs["credential-free-repository-metadata"];

test("deploy names a live-adopted source without a provider/model and Proxy sources without a Proxy", async (t) => {
  const f = await protectedSourceFixture(t);
  const agentPath = `/namespaces/${f.namespace.id}/agents/${f.agent.id}`;
  // A live-adopted source routes protected inference only to agents.defaults.model's provider;
  // a model chosen only per entry names none. The deployer reads the Configuration, so the
  // refusal names the setting.
  const configurationPath = `/namespaces/${f.namespace.id}/configurations/${f.agent.configurationId}`;
  const read = await f.request("GET", configurationPath);
  const { data: configuration } = f.fixtureResponse(
    read,
    200,
    ConfigurationResponse,
    "read Agent Configuration",
  );
  const savedDefaults = asRecord(asRecord(asRecord(configuration.values)?.agents)?.defaults);
  assert.ok(savedDefaults && savedDefaults.model !== undefined, "fixture sets a default model");
  const { model, ...defaults } = savedDefaults;
  await f.updateConfiguration(f.namespace.id, f.agent.configurationId, {
    ...configuration.values,
    agents: { defaults, entries: { [f.agent.id]: { model } } },
  });
  const unrouted = await f.request("POST", `${agentPath}/deploy`);
  const { error } = f.fixtureResponse(unrouted, 400, ErrorResponse, "refuse unrouted deployment");
  assert.equal(error.code, "INVALID_REQUEST");
  assert.equal(error.message, LIVE_SOURCE_MODEL_REQUIRED);
  await f.updateConfiguration(f.namespace.id, f.agent.configurationId, configuration.values);

  // A credential-free source is owned by the Proxy itself. Bind it to a second dedicated Agent,
  // with the operate grant deployment checks for the Agent's own principal.
  // Establish a Source admitted by the former Proxy enrollment path; deployment remains a
  // current Agent operation and must still refuse it when the Proxy is removed.
  const source = await f.controller.createCredentialSource(f.administratorId, {
    namespaceId: f.namespace.id,
    ...credentialFree(f.agent.id),
  });
  assert.equal(source.ownerCapability, "credential_proxy");
  const metadataAgent = await f.request("POST", `/namespaces/${f.namespace.id}/agents`, {
    body: {
      name: "metadata-agent",
      configurationId: f.agent.configurationId,
      executionMode: "dedicated",
      harnessAuth: { method: "runtime" },
      credentialSources: [{ sourceId: source.id }],
    },
  });
  const { data: agent } = f.fixtureResponse(
    metadataAgent,
    201,
    AgentResponse,
    "create metadata Agent",
  );
  const grant = await f.request("POST", `/namespaces/${f.namespace.id}/iam/access-bindings`, {
    body: {
      subjectKind: "identity",
      subjectId: agent.servicePrincipalId,
      roleId: f.grant.roleId,
      resourceKind: "credential_source",
      resourceId: source.id,
    },
  });
  assert.equal(grant.status, 201, JSON.stringify(grant.body));

  // The Installation drops drivers.credential_proxy and keeps its OpenShell Sandbox and Gateway.
  // Both Agents bind sources admitted under the Proxy: the live-adopted Gateway source and the
  // Proxy's own. Neither can deploy until the Proxy returns or the bindings change; a retry
  // cannot help, so each is a 409 that names no source.
  const restarted = f.restart(["sandbox", "credential_gateway"]);
  for (const agentId of [f.agent.id, agent.id]) {
    assert.deepEqual(await refusedAnswer(() => f.deploy(restarted, agentId)), {
      status: 409,
      code: "RESOURCE_CONFLICT",
      message: CREDENTIAL_PROXY_SOURCES_WITHOUT_PROXY,
    });
  }
});

test("withdrawal of a source the active version does not use is a conflict, for any source ID", async (t) => {
  const f = await protectedSourceFixture(t);
  const revision = await f.deployAgent(f.namespace.id, f.agent.id);
  await f.activateRevision(f.namespace.id, f.agent.id, revision.id);
  const source = await f.controller.createCredentialSource(f.administratorId, {
    namespaceId: f.namespace.id,
    ...credentialFree(f.agent.id),
  });
  // The check reads only the revision's bindings, never the source: an existing source and a
  // missing ID get the same answer.
  for (const sourceId of [source.id, `cs_${randomUUID()}`]) {
    const refused = await f.request(
      "POST",
      `/namespaces/${f.namespace.id}/agents/${f.agent.id}/credential-sources/${sourceId}/withdraw`,
    );
    const { error } = f.fixtureResponse(refused, 409, ErrorResponse, "refuse withdrawal");
    assert.equal(error.code, "RESOURCE_CONFLICT");
    assert.equal(error.message, WITHDRAWAL_SOURCE_NOT_USED);
  }
});
