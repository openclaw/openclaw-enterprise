import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  protectedSourceFixture,
  protectedSourceInputs,
} from "../helpers/protected-source-refusals.mjs";
import {
  AGENT_DELETING,
  CREDENTIAL_PROXY_SOURCES_WITHOUT_PROXY,
  CREDENTIAL_SOURCE_SECRETS_CROSS_NAMESPACES,
  LIVE_SOURCE_MODEL_REQUIRED,
  PROTECTED_SOURCE_EMBEDDED_AGENT,
  RESOURCE_NOT_FOUND,
  WITHDRAWAL_SOURCE_NOT_USED,
  protectedSourceTypeRefused,
} from "../helpers/refusal-text.mjs";
import { assertSameAnswer, refusedAnswer } from "../helpers/refusal-answers.mjs";

// Finding 2536: these refusals answered a generic 404 (or a 500), though each comes after the
// caller's grants and is about the request or an Installation property. Each now names its
// cause, and none names a resource the caller cannot read.

const credentialFree = protectedSourceInputs["credential-free-repository-metadata"];

test("protected credential source create names the type, the foreign Secret or the Agent it refuses", async (t) => {
  // Prepared GitHub metadata enabled: the Proxy's longest list of protected types.
  const f = await protectedSourceFixture(t, { githubMetadata: true });
  const create = (body, session) => f.request("POST", f.path, { body, session });
  // With a Credential Proxy selected, a Gateway type the Proxy cannot protect is an Installation
  // property, not a missing resource.
  const pat = await create({
    name: "unprotected-pat",
    type: "codex-pat",
    secrets: { access_token: f.source.secrets.api_key },
  });
  assert.equal(pat.status, 409, JSON.stringify(pat.body));
  assert.equal(pat.body.error.code, "RESOURCE_CONFLICT");
  // The whole text, who to ask included: the 256-character message cap must not cut it.
  const protectedTypes = "openai, credential-free-repository-metadata, github-app-metadata";
  assert.equal(pat.body.error.message, protectedSourceTypeRefused("codex-pat", protectedTypes));
  // The longest bundled Gateway type (OpenShell, with toolBinaries and a Refresh Driver) fits too.
  assert.ok(protectedSourceTypeRefused("oauth2-client-credentials", protectedTypes).length <= 256);
  // A Secret reference to another Namespace is the request's own error, refused as the Credential
  // Gateway path refuses it.
  const crossed = await create({
    name: "foreign-material",
    type: "openai",
    config: f.source.config,
    secrets: { api_key: { ...f.source.secrets.api_key, namespaceId: `ns_${randomUUID()}` } },
  });
  assert.equal(crossed.status, 400, JSON.stringify(crossed.body));
  assert.equal(crossed.body.error.code, "INVALID_REQUEST");
  assert.equal(crossed.body.error.message, CREDENTIAL_SOURCE_SECRETS_CROSS_NAMESPACES);

  // The Agent a protected source names: the caller holds operate on it, so its state is named.
  const deleting = await f.deletingAgent("deleting-agent");
  const embedded = await f.embeddedAgent("embedded-agent");
  const missingId = `agt_${randomUUID()}`;
  const issuer = f.source.secrets.api_key;
  // Both types that name their Agent: the Proxy's credential-free metadata and prepared GitHub
  // metadata, which refuses before any issuer work.
  for (const [type, input] of Object.entries(protectedSourceInputs)) {
    for (const [agentId, status, code, message] of [
      [deleting.id, 409, "AGENT_DELETING", AGENT_DELETING],
      [embedded.id, 409, "RESOURCE_CONFLICT", PROTECTED_SOURCE_EMBEDDED_AGENT],
      // An Agent the caller may operate that does not exist stays the generic 404.
      [missingId, 404, "NOT_FOUND", RESOURCE_NOT_FOUND],
    ]) {
      const refused = await create(input(agentId, issuer));
      assert.equal(refused.status, status, `${type}: ${JSON.stringify(refused.body)}`);
      assert.equal(refused.body.error.code, code, type);
      assert.equal(refused.body.error.message, message, type);
    }
  }
  // A caller who may create sources but not operate the Agent gets one denial for an existing
  // Agent and a missing one: the Agent checks above never run for it.
  const member = await f.createNamespaceMember("source-creator", f.namespace.id, [
    ["create", "credential_source"],
  ]);
  const session = await f.signIn(member.credentials);
  await assertSameAnswer(
    (agentId) => create(credentialFree(agentId), session),
    [embedded.id, missingId],
  );
  assert.deepEqual(
    (await f.request("GET", f.path)).data.map(({ id }) => id),
    [f.source.id],
    "no refused request leaves a source",
  );
});

test("deploy names a live-adopted source without a provider/model and Proxy sources without a Proxy", async (t) => {
  const f = await protectedSourceFixture(t);
  const agentPath = `/namespaces/${f.namespace.id}/agents/${f.agent.id}`;
  // A live-adopted source routes protected inference only to agents.defaults.model's provider;
  // a model chosen only per entry names none. The deployer reads the Configuration, so the
  // refusal names the setting.
  const configurationPath = `/namespaces/${f.namespace.id}/configurations/${f.agent.configurationId}`;
  const configuration = (await f.request("GET", configurationPath)).data;
  const { model, ...defaults } = configuration.values.agents.defaults;
  await f.updateConfiguration(f.namespace.id, f.agent.configurationId, {
    ...configuration.values,
    agents: { defaults, entries: { [f.agent.id]: { model } } },
  });
  const unrouted = await f.request("POST", `${agentPath}/deploy`);
  assert.equal(unrouted.status, 400, JSON.stringify(unrouted.body));
  assert.equal(unrouted.body.error.code, "INVALID_REQUEST");
  assert.equal(unrouted.body.error.message, LIVE_SOURCE_MODEL_REQUIRED);
  await f.updateConfiguration(f.namespace.id, f.agent.configurationId, configuration.values);

  // A credential-free source is owned by the Proxy itself. Bind it to a second dedicated Agent,
  // with the operate grant deployment checks for the Agent's own principal.
  const created = await f.request("POST", f.path, {
    body: credentialFree(f.agent.id),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.data.ownerCapability, "credential_proxy");
  const metadataAgent = await f.request("POST", `/namespaces/${f.namespace.id}/agents`, {
    body: {
      name: "metadata-agent",
      configurationId: f.agent.configurationId,
      executionMode: "dedicated",
      harnessAuth: { method: "runtime" },
      credentialSources: [{ sourceId: created.data.id }],
    },
  });
  assert.equal(metadataAgent.status, 201, JSON.stringify(metadataAgent.body));
  const grant = await f.request("POST", `/namespaces/${f.namespace.id}/iam/access-bindings`, {
    body: {
      subjectKind: "identity",
      subjectId: metadataAgent.data.servicePrincipalId,
      roleId: f.grant.roleId,
      resourceKind: "credential_source",
      resourceId: created.data.id,
    },
  });
  assert.equal(grant.status, 201, JSON.stringify(grant.body));

  // The Installation drops drivers.credential_proxy and keeps its OpenShell Sandbox and Gateway.
  // Both Agents bind sources admitted under the Proxy: the live-adopted Gateway source and the
  // Proxy's own. Neither can deploy until the Proxy returns or the bindings change; a retry
  // cannot help, so each is a 409 that names no source.
  const restarted = f.restart(["sandbox", "credential_gateway"]);
  for (const agentId of [f.agent.id, metadataAgent.data.id]) {
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
  const unused = await f.request("POST", f.path, {
    body: credentialFree(f.agent.id),
  });
  assert.equal(unused.status, 201, JSON.stringify(unused.body));
  // The check reads only the revision's bindings, never the source: an existing source and a
  // missing ID get the same answer.
  for (const sourceId of [unused.data.id, `cs_${randomUUID()}`]) {
    const refused = await f.request(
      "POST",
      `/namespaces/${f.namespace.id}/agents/${f.agent.id}/credential-sources/${sourceId}/withdraw`,
    );
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.error.code, "RESOURCE_CONFLICT");
    assert.equal(refused.body.error.message, WITHDRAWAL_SOURCE_NOT_USED);
  }
});
