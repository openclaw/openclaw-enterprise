import assert from "node:assert/strict";
import test from "node:test";
import { SlackChannelDriver } from "../../apps/controller/src/drivers/channel/slack.ts";
import {
  AgentResponse,
  ChannelDirectoryLookupResponse,
  ErrorResponse,
  SecretResponse,
  type ChannelDirectoryLookupInput,
  type ChannelDirectoryResult,
  type ChannelDriver,
  type Restriction,
} from "../../packages/contracts/src/index.ts";
import { ChannelDirectoryError, DriverSelectionError } from "../../packages/occ/src/index.ts";
import { createTestSecretDriver } from "../helpers/secret-driver.ts";
import {
  bootstrapInstallation,
  checkedInjectedBody,
  createConfiguration,
  createInjectedControllerFixture,
  createNamespace,
  injectedRequest,
  readyNamespaceFixture,
  type FixtureRequest,
} from "./occ-api-injected-fixture.ts";

type ProviderResult = Omit<ChannelDirectoryResult, "candidates"> & {
  readonly token?: string;
  readonly candidates: readonly (ChannelDirectoryResult["candidates"][number] & {
    readonly token?: string;
  })[];
};

async function configuredController(secretDriver: ReturnType<typeof createTestSecretDriver>) {
  const fixture = await createInjectedControllerFixture(
    { secretDriver },
    {
      wrapPlatformState: (state) => state,
      invokeApplication(factory, { backendSummaries, ...options }) {
        assert.equal(backendSummaries, undefined);
        return factory(options);
      },
    },
  );
  const request: FixtureRequest = (method, path, options) =>
    injectedRequest(fixture.app, method, path, options);
  return { fixture, request };
}

test("Channel directory accepts Slack's null terminal cursor without losing prior matches", async () => {
  const { controller, fixture, namespace } = await readyNamespaceFixture(
    await configuredController(createTestSecretDriver()),
    "slack-terminal-cursor",
  );
  const secret = await controller.request("POST", `/namespaces/${namespace.id}/secrets`, {
    body: { name: "directory-bot", value: "xoxb-directory-fixture" },
  });
  const { data: secretData } = checkedInjectedBody(secret, 201, SecretResponse);
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
  fixture.controller.installChannelDrivers([{ provider: "slack", driver }]);
  const path = `/namespaces/${namespace.id}/channel-directory/lookup`;
  const body = { provider: "slack", secretId: secretData.id, kind: "channels", query: "ann" };
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

test("Channel directory lookup reaches only the named provider's Driver", async () => {
  // Count Secret value reads: refused lookups must not read the credential at all.
  const secretDriver = createTestSecretDriver();
  const withValue = secretDriver.withValue.bind(secretDriver);
  let secretReads = 0;
  secretDriver.withValue = (secret, use) => {
    secretReads += 1;
    return withValue(secret, use);
  };
  const { controller, fixture, namespace } = await readyNamespaceFixture(
    await configuredController(secretDriver),
    "channel-provider-dispatch",
  );
  const secret = await controller.request("POST", `/namespaces/${namespace.id}/secrets`, {
    body: { name: "directory-bot", value: "xoxb-provider-dispatch" },
  });
  const { data: secretData } = checkedInjectedBody(secret, 201, SecretResponse);
  const slackCalls: string[] = [];
  const slack = new SlackChannelDriver(async (url) => {
    const request = new URL(url instanceof Request ? url.url : url);
    slackCalls.push(request.pathname);
    if (request.pathname === "/api/auth.test") {
      return Response.json({ ok: true, bot_id: "BFIXTURE", team_id: "TWORKSPACE" });
    }
    return Response.json({
      ok: true,
      members: [{ id: "U123", name: "member", profile: { display_name: "Member" } }],
      response_metadata: { next_cursor: "" },
    });
  });
  // A second provider's Driver defines its own lookup field: a required `team`.
  const otherInputs: ChannelDirectoryLookupInput[] = [];
  const other: ChannelDriver = {
    id: "other-channel",
    capability: "channel",
    implementation: "test/other-channel",
    enableRouting: () => [],
    directoryContextSchema: () => ({
      type: "object",
      additionalProperties: false,
      required: ["team"],
      properties: { team: { type: "string", pattern: "^T-[A-Z]+$" } },
    }),
    async lookupDirectory(input) {
      otherInputs.push(input);
      if (input.cursor === "foreign") {
        // A rule no schema can express: a cursor issued for another lookup.
        throw new ChannelDirectoryError("invalid_request", [
          { path: "/cursor", code: "INVALID_VALUE", message: "Issued for another Team." },
        ]);
      }
      return { workspaceId: input.context?.team ?? "", candidates: [], complete: true };
    },
  };
  assert(fixture.controller, "bootstrap must create the controller");
  // OCC refuses an open or uncompilable lookup schema when it installs the set, not per request.
  for (const directoryContextSchema of [
    () => ({ type: "object" }),
    () => ({
      type: "object",
      additionalProperties: false,
      properties: { team: { type: "string", pattern: "(" } },
    }),
  ]) {
    assert.throws(
      () =>
        fixture.controller!.installChannelDrivers([
          { provider: "other", driver: { ...other, directoryContextSchema } },
        ]),
      DriverSelectionError,
    );
  }
  fixture.controller.installChannelDrivers([
    { provider: "slack", driver: slack },
    { provider: "other", driver: other },
  ]);
  const path = `/namespaces/${namespace.id}/channel-directory/lookup`;
  const lookup = (body: Record<string, unknown>) =>
    controller.request("POST", path, { body: { secretId: secretData.id, kind: "users", ...body } });

  // Clients written before provider selection send no provider; they keep reaching Slack.
  const legacy = await lookup({ query: "mem" });
  assert.deepEqual(checkedInjectedBody(legacy, 200, ChannelDirectoryLookupResponse).data, {
    workspaceId: "TWORKSPACE",
    candidates: [{ id: "U123", name: "member", displayName: "Member" }],
    complete: true,
  });
  assert.deepEqual(slackCalls, ["/api/auth.test", "/api/users.list"]);
  const legacyHydration = await lookup({ ids: ["U123"] });
  assert.equal(legacyHydration.status, 200, JSON.stringify(legacyHydration.body));
  assert.equal(otherInputs.length, 0);
  const readsBeforeRefusals = secretReads;

  // A named provider reaches only its own Driver, with the context that Driver defines.
  slackCalls.length = 0;
  const routed = await lookup({ provider: "other", context: { team: "T-OTHER" }, query: "a" });
  assert.equal(
    checkedInjectedBody(routed, 200, ChannelDirectoryLookupResponse).data.workspaceId,
    "T-OTHER",
  );
  assert.deepEqual(
    otherInputs.map(({ context }) => context),
    [{ team: "T-OTHER" }],
  );
  assert.deepEqual(slackCalls, []);

  // OCC checks context against the schema the provider's Driver declares, before any
  // credential read or provider call, and names the refused field.
  const refused = async (body: Record<string, unknown>, details: unknown) => {
    const error = checkedInjectedBody(await lookup(body), 400, ErrorResponse).error;
    assert.equal(error.code, "INVALID_REQUEST");
    assert.deepEqual(error.details, details);
  };
  await refused({ provider: "other", query: "a" }, [{ path: "/context/team", code: "REQUIRED" }]);
  await refused({ provider: "other", context: { team: "lowercase" } }, [
    { path: "/context/team", code: "INVALID_FORMAT" },
  ]);
  // Slack declares no lookup fields, with or without an explicit provider.
  for (const provider of [{ provider: "slack" }, {}]) {
    await refused({ ...provider, context: { team: "T-OTHER" }, query: "a" }, [
      { path: "/context", code: "UNKNOWN_FIELD" },
    ]);
  }
  // The API contract refuses a malformed key before OCC or a Driver sees it.
  const malformed = checkedInjectedBody(
    await lookup({ provider: "other", context: { "tenant-id": "x", team: "T-OTHER" } }),
    400,
    ErrorResponse,
  ).error;
  assert.equal(malformed.code, "INVALID_REQUEST");
  assert.equal(otherInputs.length, 1);
  assert.deepEqual(slackCalls, []);
  // One successful routed lookup read the Secret; no refusal did.
  assert.equal(secretReads, readsBeforeRefusals + 1);

  // A Driver's own refusal keeps its field path and code, never its message.
  const foreign = checkedInjectedBody(
    await lookup({
      provider: "other",
      context: { team: "T-OTHER" },
      query: "a",
      cursor: "foreign",
    }),
    400,
    ErrorResponse,
  ).error;
  assert.equal(foreign.code, "INVALID_REQUEST");
  assert.deepEqual(foreign.details, [{ path: "/cursor", code: "INVALID_VALUE" }]);

  // A provider without an installed Driver is unavailable, not a provider failure.
  const uninstalled = await lookup({ provider: "discord", query: "a" });
  assert.equal(checkedInjectedBody(uninstalled, 501, ErrorResponse).error.code, "NOT_IMPLEMENTED");
  assert.equal(otherInputs.length, 2);
});

test("Channel directory lookup checks the exact edit target and Secret before and after reading", async () => {
  const token = "synthetic-channel-directory-token";
  const secretDriver = createTestSecretDriver({ id: "secret-directory-integration" });
  const originalWithValue = secretDriver.withValue.bind(secretDriver);
  let revokeOnRead: Restriction | undefined;
  const controller = await configuredController(secretDriver);
  const fixture = controller.fixture;
  secretDriver.withValue = (secret, use) =>
    originalWithValue(secret, (value) => {
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
  const secret = await controller.request("POST", `/namespaces/${namespace.id}/secrets`, {
    body: { name: "channel-bot", value: token },
  });
  const { data: secretData } = checkedInjectedBody(secret, 201, SecretResponse);
  const agent = await controller.request("POST", `/namespaces/${namespace.id}/agents`, {
    body: { name: "directory-agent", configurationId: configuration.id },
  });
  const { data: agentData } = checkedInjectedBody(agent, 201, AgentResponse);

  const path = `/namespaces/${namespace.id}/channel-directory/lookup`;
  const body = { provider: "slack", secretId: secretData.id, kind: "users", query: "mem" };
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
    directoryContextSchema: () => ({ type: "object", additionalProperties: false, properties: {} }),
    async lookupDirectory(input) {
      providerCalls += 1;
      lastProviderInput = input;
      assert.equal(input.token, token);
      return providerResult;
    },
  };
  assert(fixture.controller, "bootstrap must create the controller");
  fixture.controller.installChannelDrivers([{ provider: "slack", driver: channelDriver }]);
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
    body: { provider: "slack", secretId: secretData.id, kind: "users", ids: ["U123", "U999"] },
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
    body: { provider: "slack", secretId: secretData.id, kind: "users", ids: ["U123", "U123"] },
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
      provider: "slack",
      secretId: secretData.id,
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

  const selectedSecretReads = () =>
    secretDriver.calls.filter(
      (call) =>
        call.operation === "withValue" &&
        call.secret.namespaceId === namespace.id &&
        call.secret.id === secretData.id,
    ).length;

  // Authorization denials must occur before reading the selected Secret or calling the provider.
  for (const [resourceKind, resourceId, action, editTarget] of [
    ["agent", namespace.id, "create", {}],
    ["agent", agentData.id, "update", { agentId: agentData.id }],
    ["configuration", configuration.id, "update", { configurationId: configuration.id }],
    ["secret", secretData.id, "operate", {}],
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
    const readsBefore = selectedSecretReads();
    const callsBefore: number = providerCalls;
    const denied = await controller.request("POST", path, { body: { ...body, ...editTarget } });
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal(selectedSecretReads(), readsBefore);
    assert.equal(providerCalls, callsBefore);
    fixture.state.restrictions.pop();
  }

  // A restriction installed during the selected Secret read must still block the provider.
  for (const [resourceKind, resourceId, action, editTarget] of [
    ["agent", agentData.id, "update", { agentId: agentData.id }],
    ["secret", secretData.id, "operate", {}],
  ] as const) {
    revokeOnRead = {
      id: `revoke-directory-after-read-${resourceKind}`,
      namespaceId: namespace.id,
      resourceKind,
      resourceId,
      action,
      effect: "deny",
    };
    const readsBefore = selectedSecretReads();
    const callsBefore: number = providerCalls;
    const denied = await controller.request("POST", path, { body: { ...body, ...editTarget } });
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal(selectedSecretReads(), readsBefore + 1);
    assert.equal(providerCalls, callsBefore);
    fixture.state.restrictions.pop();
  }

  providerResult = { workspaceId: "T123", candidates: [], complete: false, nextCursor: "more" };
  const incompleteHydration = await controller.request("POST", path, {
    body: { provider: "slack", secretId: secretData.id, kind: "users", ids: ["U123"] },
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
