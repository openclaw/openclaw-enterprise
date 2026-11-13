import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { ErrorResponse } from "../../packages/contracts/src/api/common.ts";
import {
  AgentResponse,
  ConfigurationResponse,
  CredentialSourceListResponse,
  CredentialSourceResponse,
} from "../../packages/contracts/src/api/resources.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import {
  protectedSourceFixture,
  protectedSourceInputs,
} from "../helpers/protected-source-refusals.ts";
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
  const apiKey = f.source.secrets.api_key;
  assert.ok(apiKey);
  const create = (
    body: unknown,
    session?: NonNullable<Parameters<typeof f.request>[2]>["session"],
  ) => f.request("POST", f.path, { body, ...(session === undefined ? {} : { session }) });
  // With a Credential Proxy selected, a Gateway type the Proxy cannot protect is an Installation
  // property, not a missing resource.
  const pat = await create({
    name: "unprotected-pat",
    type: "codex-pat",
    secrets: { access_token: apiKey },
  });
  const { error: patError } = f.fixtureResponse(pat, 409, ErrorResponse, "refuse PAT source");
  assert.equal(patError.code, "RESOURCE_CONFLICT");
  // The whole text, who to ask included: the 256-character message cap must not cut it.
  const protectedTypes = "openai, credential-free-repository-metadata, github-app-metadata";
  assert.equal(patError.message, protectedSourceTypeRefused("codex-pat", protectedTypes));
  // The longest bundled Gateway type (OpenShell, with toolBinaries and a Refresh Driver) fits too.
  assert.ok(protectedSourceTypeRefused("oauth2-client-credentials", protectedTypes).length <= 256);
  // A Secret reference to another Namespace is the request's own error, refused as the Credential
  // Gateway path refuses it.
  const crossed = await create({
    name: "foreign-material",
    type: "openai",
    config: f.source.config,
    secrets: { api_key: { ...apiKey, namespaceId: `ns_${randomUUID()}` } },
  });
  const { error: crossedError } = f.fixtureResponse(
    crossed,
    400,
    ErrorResponse,
    "refuse cross-Namespace Secret",
  );
  assert.equal(crossedError.code, "INVALID_REQUEST");
  assert.equal(crossedError.message, CREDENTIAL_SOURCE_SECRETS_CROSS_NAMESPACES);

  // The Agent a protected source names: the caller holds operate on it, so its state is named.
  const deleting = await f.deletingAgent("deleting-agent");
  const embedded = await f.embeddedAgent("embedded-agent");
  const missingId = `agt_${randomUUID()}`;
  const issuer = apiKey;
  // Both types that name their Agent: the Proxy's credential-free metadata and prepared GitHub
  // metadata, which refuses before any issuer work.
  for (const [type, input] of Object.entries(protectedSourceInputs)) {
    for (const [agentId, status, code, message] of [
      [deleting.id, 409, "AGENT_DELETING", AGENT_DELETING],
      [embedded.id, 409, "RESOURCE_CONFLICT", PROTECTED_SOURCE_EMBEDDED_AGENT],
      // An Agent the caller may operate that does not exist stays the generic 404.
      [missingId, 404, "NOT_FOUND", RESOURCE_NOT_FOUND],
    ] as const) {
      const refused = await create(input(agentId, issuer));
      const { error } = f.fixtureResponse(refused, status, ErrorResponse, `refuse ${type}`);
      assert.equal(error.code, code, type);
      assert.equal(error.message, message, type);
    }
  }
  // A caller who may create sources but not operate the Agent gets one denial for an existing
  // Agent and a missing one: the Agent checks above never run for it.
  const member = await f.createNamespaceMember("source-creator", f.namespace.id, [
    ["create", "credential_source"],
  ]);
  const session = await f.signIn(member.credentials);
  await assertSameAnswer(
    (agentId: string) => create(credentialFree(agentId), session),
    [embedded.id, missingId],
  );
  const list = await f.request("GET", f.path);
  const { data: sources } = f.fixtureResponse(
    list,
    200,
    CredentialSourceListResponse,
    "list sources after refused create",
  );
  assert.deepEqual(
    sources.map(({ id }) => id),
    [f.source.id],
    "no refused request leaves a source",
  );
});

test("explicit live adoption refuses an unsupported Gateway source after full Proxy cutover", async (t) => {
  const f = await protectedSourceFixture(t, { githubMetadata: true });
  const apiKey = f.source.secrets.api_key;
  assert.ok(apiKey);
  // Register through the real Gateway-only controller before asking the full Proxy API
  // to adopt it. The full profile cannot create an ordinary PAT source itself.
  const pat = await f
    .restart(["sandbox", "credential_gateway"])
    .createCredentialSource(f.administratorId, {
      namespaceId: f.namespace.id,
      name: "unprotected-pat",
      type: "codex-pat",
      secrets: { access_token: apiKey },
    });
  assert.equal(pat.egress, undefined);
  const adoption = await f.request("PATCH", `${f.path}/${pat.id}`, {
    body: { adoption: "live", authorityScope: "execution" },
  });
  const { error } = f.fixtureResponse(adoption, 409, ErrorResponse, "refuse live adoption");
  assert.equal(error.code, "RESOURCE_CONFLICT");
  assert.equal(
    error.message,
    protectedSourceTypeRefused(
      "codex-pat",
      "openai, credential-free-repository-metadata, github-app-metadata",
    ),
  );
  const read = await f.request("GET", `${f.path}/${pat.id}`);
  const { data: retained } = f.fixtureResponse(
    read,
    200,
    CredentialSourceResponse,
    "read retained PAT source",
  );
  assert.equal(retained.egress, undefined);
  assert.deepEqual(retained.secrets, pat.secrets);
  const list = await f.request("GET", f.path);
  const { data: sources } = f.fixtureResponse(
    list,
    200,
    CredentialSourceListResponse,
    "list sources after refused adoption",
  );
  assert.deepEqual(
    sources.map(({ id }) => id),
    [f.source.id, pat.id],
    "refused adoption preserves the existing sources without creating another row",
  );
});

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
  const created = await f.request("POST", f.path, {
    body: credentialFree(f.agent.id),
  });
  const { data: source } = f.fixtureResponse(
    created,
    201,
    CredentialSourceResponse,
    "create credential-free source",
  );
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
  const unused = await f.request("POST", f.path, {
    body: credentialFree(f.agent.id),
  });
  const { data: source } = f.fixtureResponse(
    unused,
    201,
    CredentialSourceResponse,
    "create unused credential source",
  );
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
