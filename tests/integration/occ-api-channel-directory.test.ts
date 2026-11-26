import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { SlackChannelDriver } from "../../apps/controller/src/drivers/channel/slack.ts";
import { OCCTokenServiceDriver } from "../../apps/controller/src/drivers/token-service/occ.ts";
import {
  AgentResponse,
  ChannelDirectoryLookupResponse,
  ErrorResponse,
  CredentialSourceResponse,
  type ChannelDirectoryLookupInput,
  type ChannelDirectoryResult,
  type ChannelDriver,
  type Restriction,
} from "../../packages/contracts/src/index.ts";
import { createTestSecretDriver } from "../helpers/secret-driver.ts";
import {
  bootstrapInstallation,
  checkedInjectedBody,
  createConfiguration,
  createInjectedControllerFixture,
  createNamespace,
  injectedRequest,
  readyNamespaceFixture,
  withoutBackendSummaries,
  type FixtureRequest,
} from "./occ-api-injected-fixture.ts";

type ProviderResult = Omit<ChannelDirectoryResult, "candidates"> & {
  readonly token?: string;
  readonly candidates: readonly (ChannelDirectoryResult["candidates"][number] & {
    readonly token?: string;
  })[];
};

async function configuredController(
  secretDriver: ReturnType<typeof createTestSecretDriver>,
  qualified: () => boolean = () => true,
) {
  const fixture = await createInjectedControllerFixture(
    {
      secretDriver,
      gatewayStartupSourceDelivery: (compute, owner) =>
        compute.id === "compute-integration" &&
        owner instanceof OCCTokenServiceDriver &&
        qualified(),
    },
    withoutBackendSummaries,
  );
  const request: FixtureRequest = (method, path, options) =>
    injectedRequest(fixture.app, method, path, options);
  return { fixture, request };
}

async function createDirectorySource(
  controller: Awaited<ReturnType<typeof configuredController>>,
  namespaceId: string,
  secretDriver: ReturnType<typeof createTestSecretDriver>,
  token: string,
) {
  const ownerController = controller.fixture.controller;
  const state = controller.fixture.platformState;
  assert(ownerController && state);
  const instanceId = await ownerController.activateTokenServiceInstance(
    "directory-owner",
    randomUUID(),
  );
  const owner = new OCCTokenServiceDriver(
    "directory-owner",
    ownerController.installation.id,
    secretDriver.privateSecrets,
    instanceId,
    state,
  );
  ownerController.registerDriver(owner);
  ownerController.selectDriver("token_service", owner.id);
  const created = await controller.request(
    "POST",
    `/namespaces/${namespaceId}/credential-sources`,
    {
      body: {
        name: "directory-bot",
        type: "static",
        secret: token,
      },
    },
  );
  return checkedInjectedBody(created, 201, CredentialSourceResponse).data;
}

test("Channel directory accepts Slack's null terminal cursor without losing prior matches", async () => {
  const secretDriver = createTestSecretDriver();
  const { controller, fixture, namespace } = await readyNamespaceFixture(
    await configuredController(secretDriver),
    "slack-terminal-cursor",
  );
  const source = await createDirectorySource(
    controller,
    namespace.id,
    secretDriver,
    "xoxb-directory-fixture",
  );
  let terminalCursor: null | number = null;
  const driver = new SlackChannelDriver(async (url) => {
    const request = new URL(url instanceof Request ? url.url : url);
    if (request.pathname === "/api/auth.test") {
      return Response.json({ ok: true, bot_id: "BFIXTURE", team_id: "TWORKSPACE" });
    }
    assert.equal(request.pathname, "/api/conversations.list");
    const secondPage = request.searchParams.has("cursor");
    if (secondPage) {
      assert.equal(request.searchParams.get("cursor"), "page-two");
    }
    return Response.json({
      ok: true,
      channels: [
        secondPage ? { id: "CSECOND", name: "ann-second" } : { id: "CFIRST", name: "ann-first" },
      ],
      response_metadata: { next_cursor: secondPage ? terminalCursor : "page-two" },
    });
  });
  assert(fixture.controller, "bootstrap must create the controller");
  fixture.controller.registerDriver(driver);
  fixture.controller.selectDriver("channel", driver.id);
  const path = `/namespaces/${namespace.id}/channel-directory/lookup`;
  const body = { sourceId: source.id, kind: "channels", query: "ann" };
  const found = await controller.request("POST", path, { body });
  assert.deepEqual(checkedInjectedBody(found, 200, ChannelDirectoryLookupResponse).data, {
    workspaceId: "TWORKSPACE",
    candidates: [
      { id: "CFIRST", name: "ann-first" },
      { id: "CSECOND", name: "ann-second" },
    ],
    complete: true,
  });
  // Accepting the documented null sentinel must not accept arbitrary cursor types.
  terminalCursor = 7;
  const invalid = await controller.request("POST", path, { body });
  assert.equal(
    checkedInjectedBody(invalid, 503, ErrorResponse).error.code,
    "CHANNEL_DIRECTORY_INVALID_RESPONSE",
  );
});

test("Slack directory refuses a non-bot Source before sending its value to Slack", async () => {
  const secretDriver = createTestSecretDriver();
  const { controller, fixture, namespace } = await readyNamespaceFixture(
    await configuredController(secretDriver),
    "slack-directory-token-role",
  );
  const unrelatedValue = `unrelated-static-credential-${randomUUID()}`;
  const source = await createDirectorySource(
    controller,
    namespace.id,
    secretDriver,
    unrelatedValue,
  );
  let transportRequests = 0;
  const driver = new SlackChannelDriver(async () => {
    transportRequests += 1;
    return Response.json({ ok: false, error: "invalid_auth" });
  });
  assert(fixture.controller, "bootstrap must create the controller");
  fixture.controller.registerDriver(driver);
  fixture.controller.selectDriver("channel", driver.id);

  // Exact Source authorization permits its use, but does not identify it as a Slack bot token.
  const refused = await controller.request(
    "POST",
    `/namespaces/${namespace.id}/channel-directory/lookup`,
    { body: { sourceId: source.id, kind: "users", query: "member" } },
  );
  const error = checkedInjectedBody(refused, 400, ErrorResponse).error;
  assert.equal(error.code, "CHANNEL_DIRECTORY_CREDENTIALS_REJECTED");
  assert.equal(
    error.message,
    "The channel provider rejected the selected credential. Check it and retry.",
  );
  assert.equal(JSON.stringify(refused.body).includes(unrelatedValue), false);
  assert.equal(transportRequests, 0, "an unrelated credential must never reach Slack transport");
});

test("Channel directory lookup checks the exact edit target and Source before and after resolution", async () => {
  const token = "synthetic-channel-directory-token";
  const secretDriver = createTestSecretDriver({ id: "secret-directory-integration" });
  const originalWithValue = secretDriver.privateSecrets.withValue.bind(secretDriver.privateSecrets);
  let revokeOnRead: Restriction | undefined;
  let qualified = true;
  const controller = await configuredController(secretDriver, () => qualified);
  const fixture = controller.fixture;
  let custodyReads = 0;
  secretDriver.privateSecrets.withValue = (ref, use) =>
    originalWithValue(ref, (value) => {
      custodyReads += 1;
      if (revokeOnRead !== undefined) {
        fixture.state.restrictions.push(revokeOnRead);
        revokeOnRead = undefined;
      }
      return use(value);
    });
  await bootstrapInstallation(controller);
  const namespace = await createNamespace(controller, "channel-directory-api");
  const configuration = await createConfiguration(controller, namespace.id);
  await fixture.markNamespaceReady(namespace.id);
  const source = await createDirectorySource(controller, namespace.id, secretDriver, token);
  const agent = await controller.request("POST", `/namespaces/${namespace.id}/agents`, {
    body: { name: "directory-agent", configurationId: configuration.id },
  });
  const { data: agentData } = checkedInjectedBody(agent, 201, AgentResponse);

  const path = `/namespaces/${namespace.id}/channel-directory/lookup`;
  const body = { sourceId: source.id, kind: "users", query: "mem" };
  const obsoleteBody = await controller.request("POST", path, {
    body: { secretId: source.id, kind: "users", query: "mem" },
  });
  assert.equal(obsoleteBody.status, 400, "the cutover contract accepts sourceId, not secretId");
  const unavailable = await controller.request("POST", path, { body });
  assert.equal(checkedInjectedBody(unavailable, 501, ErrorResponse).error.code, "NOT_IMPLEMENTED");

  let providerCalls = 0;
  let lastProviderInput: ChannelDirectoryLookupInput | undefined;
  let providerResult: ProviderResult = {
    workspaceId: "T123",
    workspaceName: "Example workspace",
    candidates: [{ id: "U123", name: "member", displayName: "Member", token }],
    complete: true,
    token,
  };
  const channelDriver: ChannelDriver = {
    id: "channel-directory-integration",
    capability: "channel",
    enableRouting: () => [],
    implementation: "test-directory",
    async lookupDirectory(input) {
      providerCalls += 1;
      lastProviderInput = input;
      assert.equal(input.token, token);
      return providerResult;
    },
  };
  assert(fixture.controller, "bootstrap must create the controller");
  fixture.controller.registerDriver(channelDriver);
  fixture.controller.selectDriver("channel", channelDriver.id);
  const expected = {
    workspaceId: "T123",
    workspaceName: "Example workspace",
    candidates: [{ id: "U123", name: "member", displayName: "Member" }],
    complete: true,
  };
  const created = await controller.request("POST", path, { body });
  assert.deepEqual(
    checkedInjectedBody(created, 200, ChannelDirectoryLookupResponse).data,
    expected,
  );
  assert.equal(JSON.stringify(created.body).includes(token), false);
  assert.equal(providerCalls, 1);
  const hydrated = await controller.request("POST", path, {
    body: { sourceId: source.id, kind: "users", ids: ["U123", "U999"] },
  });
  assert.deepEqual(
    checkedInjectedBody(hydrated, 200, ChannelDirectoryLookupResponse).data,
    expected,
  );
  assert(lastProviderInput);
  assert.deepEqual(lastProviderInput.ids, ["U123", "U999"]);
  const mixed = await controller.request("POST", path, {
    body: { ...body, ids: ["U123"] },
  });
  assert.equal(mixed.status, 400);
  // The body is a union of lookup and hydration shapes. A lookup whose query is too long
  // names only that field, not the fields other shapes require, and only the lookup shape
  // fits, so the message names its bound.
  const longQuery = await controller.request("POST", path, {
    body: { ...body, query: "q".repeat(201) },
  });
  const longQueryError = checkedInjectedBody(longQuery, 400, ErrorResponse).error;
  assert.equal(
    longQueryError.message,
    "The request does not match the operation contract: body /query is too long (expected at most 200 characters).",
  );
  assert.deepEqual(longQueryError.details, [{ path: "/query", code: "TOO_LONG" }]);
  // A string array declared uniqueItems names the rule, not just an unsupported value.
  const repeatedIds = await controller.request("POST", path, {
    body: { sourceId: source.id, kind: "users", ids: ["U123", "U123"] },
  });
  const repeatedIdsError = checkedInjectedBody(repeatedIds, 400, ErrorResponse).error;
  assert.equal(
    repeatedIdsError.message,
    "The request does not match the operation contract: body /ids has an unsupported value (expected no duplicate items).",
  );
  assert.deepEqual(repeatedIdsError.details, [{ path: "/ids", code: "INVALID_VALUE" }]);
  // At most 20 IDs are hydrated in one request.
  const tooManyIds = await controller.request("POST", path, {
    body: {
      sourceId: source.id,
      kind: "users",
      ids: Array.from({ length: 21 }, (_, index) => `U${index}`),
    },
  });
  const tooManyIdsError = checkedInjectedBody(tooManyIds, 400, ErrorResponse).error;
  assert.equal(
    tooManyIdsError.message,
    "The request does not match the operation contract: body /ids has an unsupported value (expected at most 20 items).",
  );
  assert.deepEqual(tooManyIdsError.details, [{ path: "/ids", code: "INVALID_VALUE" }]);
  // An unknown kind fits no shape, so every shape's problem stays, but the three hydration
  // shapes' identical missing /ids is listed once.
  const unknownKind = await controller.request("POST", path, {
    body: { ...body, kind: "groups" },
  });
  const unknownKindError = checkedInjectedBody(unknownKind, 400, ErrorResponse).error;
  assert.deepEqual(unknownKindError.details, [
    { path: "/kind", code: "INVALID_VALUE" },
    { path: "/agentId", code: "REQUIRED" },
    { path: "/configurationId", code: "REQUIRED" },
    { path: "/ids", code: "REQUIRED" },
    { path: "", code: "INVALID_VALUE" },
  ]);
  assert.deepEqual(
    checkedInjectedBody(
      await controller.request("POST", path, { body: { ...body, agentId: agentData.id } }),
      200,
      ChannelDirectoryLookupResponse,
    ).data,
    expected,
  );
  assert.deepEqual(
    checkedInjectedBody(
      await controller.request("POST", path, {
        body: { ...body, configurationId: configuration.id },
      }),
      200,
      ChannelDirectoryLookupResponse,
    ).data,
    expected,
  );

  // Authorization denials must occur before resolving the selected Source or calling the provider.
  for (const [resourceKind, resourceId, action, editTarget] of [
    ["agent", namespace.id, "create", {}],
    ["agent", agentData.id, "update", { agentId: agentData.id }],
    ["configuration", configuration.id, "update", { configurationId: configuration.id }],
    ["credential_source", source.id, "operate", {}],
  ] as const) {
    const restriction: Restriction = {
      id: `deny-directory-${resourceKind}-${action}`,
      namespaceId: namespace.id,
      resourceKind,
      resourceId,
      action,
      effect: "deny",
    };
    fixture.state.restrictions.push(restriction);
    const readsBefore = custodyReads;
    const callsBefore: number = providerCalls;
    const denied = await controller.request("POST", path, { body: { ...body, ...editTarget } });
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal(custodyReads, readsBefore);
    assert.equal(providerCalls, callsBefore);
    fixture.state.restrictions.pop();
  }

  // A restriction installed during TokenService custody resolution must still block the provider.
  for (const [resourceKind, resourceId, action, editTarget] of [
    ["agent", agentData.id, "update", { agentId: agentData.id }],
    ["credential_source", source.id, "operate", {}],
  ] as const) {
    revokeOnRead = {
      id: `revoke-directory-after-read-${resourceKind}`,
      namespaceId: namespace.id,
      resourceKind,
      resourceId,
      action,
      effect: "deny",
    };
    const readsBefore = custodyReads;
    const callsBefore: number = providerCalls;
    const denied = await controller.request("POST", path, { body: { ...body, ...editTarget } });
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal(custodyReads, readsBefore + 1);
    assert.equal(providerCalls, callsBefore);
    fixture.state.restrictions.pop();
  }

  // An unqualified owner/Compute pair is refused before usable Source custody is read.
  qualified = false;
  const beforeQualification = { custodyReads, providerCalls };
  const unqualified = await controller.request("POST", path, { body });
  assert.equal(unqualified.status, 409, JSON.stringify(unqualified.body));
  assert.deepEqual({ custodyReads, providerCalls }, beforeQualification);
  qualified = true;

  providerResult = { workspaceId: "T123", candidates: [], complete: false, nextCursor: "more" };
  const incompleteHydration = await controller.request("POST", path, {
    body: { sourceId: source.id, kind: "users", ids: ["U123"] },
  });
  assert.equal(
    checkedInjectedBody(incompleteHydration, 503, ErrorResponse).error.code,
    "CHANNEL_DIRECTORY_INVALID_RESPONSE",
  );

  providerResult = { workspaceId: "T123", workspaceName: token, candidates: [], complete: true };
  const echoed = await controller.request("POST", path, { body });
  assert.equal(
    checkedInjectedBody(echoed, 503, ErrorResponse).error.code,
    "CHANNEL_DIRECTORY_INVALID_RESPONSE",
  );
  assert.equal(JSON.stringify(echoed.body).includes(token), false);

  providerResult = { workspaceId: "T123", candidates: [], complete: true, token };
  // Simulate a malformed external Driver reply that omits its required workspace identity.
  Reflect.deleteProperty(providerResult, "workspaceId");
  const invalid = await controller.request("POST", path, { body });
  assert.equal(
    checkedInjectedBody(invalid, 503, ErrorResponse).error.code,
    "CHANNEL_DIRECTORY_INVALID_RESPONSE",
  );
  assert.equal(JSON.stringify(invalid.body).includes(token), false);
});
