import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type nodeTest from "node:test";

import type { Permission } from "../../packages/contracts/src/index.ts";
import { NoActiveAgentRevisionError, ResourceConflictError } from "../../packages/occ/src/index.ts";
import { assertApiError } from "../helpers/api-error.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import type { ActionsByKind } from "../helpers/iam-grants.ts";
import { callerDenied } from "../helpers/refusal-text.mjs";
import {
  adminPrincipal,
  injectJson,
  issueServiceKeyForNativeAgent,
  nativeAuthority,
  nativeDomain,
  nativeStatus,
  publicOrigin,
  type CreateLiveNativeAgent,
  type NativeAdminCaseDependencies,
  type NativeAdminFixture,
  type Session,
} from "./native-admin-access-fixture.ts";
import { continueNativeAdminProxyCase } from "./native-admin-browser-access-cases.ts";

type ExactResource = { kind: Permission["resourceKind"]; id: string };
type AuthorityDependencies = Omit<NativeAdminCaseDependencies, "createAgentPermissionSession"> & {
  createAgentPermissionSession(
    context: NativeAdminFixture,
    label: string,
    permissions: ActionsByKind,
    resource?: ExactResource,
  ): Promise<Session>;
};
type DefaultCodexPreset = typeof import("../../deploy/presets/default-codex.json");

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function readRecord(value: unknown, label: string): Record<string, unknown> {
  assert.ok(isRecord(value), label);
  return value;
}
export function readString(value: unknown, label: string): string {
  assert.ok(typeof value === "string", label);
  return value;
}
export function errorRecord(body: unknown): Record<string, unknown> {
  return readRecord(
    readRecord(body, "response body must be an object").error,
    "response error must be an object",
  );
}
function statusData(response: { data: unknown }): Record<string, unknown> {
  return readRecord(response.data, "native status data must be an object");
}

export function registerNativeAdminAuthorityStatusCase(
  test: typeof nodeTest,
  dependencies: AuthorityDependencies,
): void {
  const {
    createNativeAdminFixture,
    createExactAgentAdministerSession,
    createAgentPermissionSession,
    createReadOnlySession,
    assertSiblingStatusDenied,
    trustLocalUpstreamCertificate,
  } = dependencies;
  test("native browser status selects exact Agent authority and reports lifecycle availability", async (t) => {
    const context = await createNativeAdminFixture(t);

    const available = await nativeStatus(context);
    assert.equal(available.status, 200);
    const availableData = statusData(available);
    assert.equal(availableData.status, "available");
    assert.equal(availableData.mode, "admin");
    assert.equal(availableData.activeRevisionId, context.revision.id);
    assert.match(
      readString(availableData.host, "available host"),
      new RegExp(`\\.${nativeDomain.replaceAll(".", "\\.")}$`),
    );
    assert.equal(
      new URL(readString(availableData.url, "available URL")).hostname,
      availableData.host,
    );
    assert.equal(new URL(readString(availableData.url, "available URL")).pathname, "/");
    assert.equal(availableData.bootstrapUrl, undefined);

    const exactAdministerOnlySession = await createExactAgentAdministerSession(
      context,
      "native-admin-status-exact-administer",
    );
    const exactAvailable = await nativeStatus(context, { session: exactAdministerOnlySession });
    assert.equal(exactAvailable.status, 200);
    const exactAvailableData = statusData(exactAvailable);
    assert.equal(exactAvailableData.status, "available");
    await assertSiblingStatusDenied(context, exactAdministerOnlySession, (target) =>
      callerDenied("Agent operate", target),
    );

    // An IAM outage is a dependency failure, never an Agent lifecycle state: the console must
    // not read it as "unavailable" (deploying) for an Agent the caller may not even administer.
    const authorize = context.fixture.iamDriver.authorize;
    context.fixture.iamDriver.authorize = async () => {
      throw new Error("IAM outage");
    };
    let iamOutage: Awaited<ReturnType<typeof nativeStatus>>;
    try {
      iamOutage = await nativeStatus(context);
    } finally {
      context.fixture.iamDriver.authorize = authorize;
    }
    assert.equal(iamOutage.status, 503);
    assert.equal(errorRecord(iamOutage.body).code, "DEPENDENCY_UNAVAILABLE");

    // An exact operate grant opens only the restricted route; it does not imply administration.
    const operatorSession = await createAgentPermissionSession(
      context,
      "exact-operator",
      {
        agent: ["operate"],
      },
      { kind: "agent", id: context.agent.id },
    );
    const chat = await nativeStatus(context, { session: operatorSession });
    assert.equal(chat.status, 200);
    const chatData = statusData(chat);
    assert.equal(chatData.mode, "chat");
    trustLocalUpstreamCertificate(t, context.upstream.cert);
    const response = await injectJson(context.fixture, "GET", "/", {
      headers: {
        host: nativeAuthority({ origin: readString(chatData.origin, "chat origin") }),
        origin: readString(chatData.origin, "chat origin"),
        cookie: operatorSession.cookie,
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    const lastRequest = context.upstream.requests.at(-1);
    assert.ok(lastRequest);
    assert.equal(
      lastRequest.url,
      `/native-browser/namespaces/${context.namespace.id}/agents/${context.agent.id}`,
    );
    await assertSiblingStatusDenied(context, operatorSession, (target) =>
      callerDenied("Agent operate", target),
    );
    const driver = context.fixture.controller.selectedDriver("compute");
    const chatEndpoint = driver.getGatewayBrowserRequest;
    delete driver.getGatewayBrowserRequest;
    try {
      const unsupported = await nativeStatus(context, { session: operatorSession });
      const unsupportedData = statusData(unsupported);
      assert.equal(unsupportedData.status, "unsupported");
      // The Configuration is complete; the Compute Driver gives no chat endpoint (finding 3168).
      assert.equal(unsupportedData.reason, "compute");
      assert.equal(unsupportedData.mode, "chat");
    } finally {
      if (chatEndpoint !== undefined) {
        driver.getGatewayBrowserRequest = chatEndpoint;
      }
    }

    const limitedSession = await createReadOnlySession(context, "native-admin-reader");
    const denied = await nativeStatus(context, { session: limitedSession });
    assertApiError(denied, 403, "FORBIDDEN");
    // With native admin on, the grant is all the caller lacks.
    assert.equal(
      errorRecord(denied.body).message,
      callerDenied("Agent operate", `Agent ${context.agent.id}`),
    );

    const missingStatus = await context.fixture.request(
      "GET",
      `/namespaces/${context.namespace.id}/agents/agt_${randomUUID()}/native-admin`,
    );
    assert.equal(missingStatus.status, 404);
    assert.equal(errorRecord(missingStatus.body).code, "NOT_FOUND");

    const stopped = await context.fixture.request(
      "POST",
      `/namespaces/${context.namespace.id}/agents/${context.agent.id}/stop`,
    );
    assert.equal(stopped.status, 202);
    const stoppedStatus = await nativeStatus(context);
    assert.equal(stoppedStatus.status, 200);
    const stoppedStatusData = statusData(stoppedStatus);
    assert.equal(stoppedStatusData.status, "stopped");
    assert.equal(stoppedStatusData.host, availableData.host);

    // Completed stop reconciliation clears the selected revision but retains historical revisions.
    const cleared = await context.fixture.controller.transact((state) =>
      state.agents.compareAndClearActiveRevision(
        context.namespace.id,
        context.agent.id,
        context.revision.id,
      ),
    );
    assert.ok(cleared);
    assert.equal(cleared.desiredRuntimeState, "stopped");
    assert.equal(cleared.activeRevisionId, undefined);
    const controllerStatus = () =>
      context.fixture.controller.getAdministerableActiveAgentRevision(
        adminPrincipal(context.fixture).id,
        context.namespace.id,
        context.agent.id,
      );
    await assert.rejects(controllerStatus, ResourceConflictError);
    const fullyStopped = await nativeStatus(context, { session: exactAdministerOnlySession });
    assert.equal(fullyStopped.status, 200);
    const fullyStoppedData = statusData(fullyStopped);
    assert.deepEqual(fullyStoppedData, { status: "stopped" });
    const stillDenied = await nativeStatus(context, { session: limitedSession });
    assertApiError(stillDenied, 403, "FORBIDDEN");
    const { key: serviceKey } = await issueServiceKeyForNativeAgent(context);
    const serviceDenied = await injectJson(
      context.fixture,
      "GET",
      `/namespaces/${context.namespace.id}/agents/${context.agent.id}/native-admin`,
      { headers: { "x-api-key": serviceKey } },
    );
    assert.equal(serviceDenied.statusCode, 403);
    assert.equal(errorRecord(serviceDenied.json<unknown>()).code, "FORBIDDEN");
    // The denial tells key holders what to use instead; it names no Agent state.
    assert.equal(
      errorRecord(serviceDenied.json<unknown>()).message,
      "Native admin UI requires a signed-in console session; service API keys cannot open it.",
    );

    // Redeployment makes the Agent desired-running before a worker selects the new revision.
    const pending = await context.fixture.deployAgent(context.namespace.id, context.agent.id);
    await assert.rejects(controllerStatus, NoActiveAgentRevisionError);
    const unavailable = await nativeStatus(context, { session: exactAdministerOnlySession });
    assert.equal(unavailable.status, 200);
    const unavailableData = statusData(unavailable);
    assert.deepEqual(unavailableData, { status: "unavailable" });
    await context.fixture.activateRevision(context.namespace.id, context.agent.id, pending.id);
    const restored = await nativeStatus(context, { session: exactAdministerOnlySession });
    assert.equal(restored.status, 200);
    const restoredData = statusData(restored);
    assert.equal(restoredData.status, "available");
    assert.equal(restoredData.activeRevisionId, pending.id);
  });
}

export function registerNativeAdminPresetCase(
  test: typeof nodeTest,
  { createNativeAdminFixture }: AuthorityDependencies,
  createLiveNativeAgent: CreateLiveNativeAgent,
  nativeAdminHarnessConfiguration: (origin: string) => object,
  defaultCodexPreset: DefaultCodexPreset,
): void {
  // What Create Agent saves from the shipped default Preset (Console `configurationTemplate`):
  // its gateway, with Control UI on for loopback port-forward origins only, and the selected
  // model. `nativeOrigin` is added to the allowed origins when given.
  function defaultPresetConfiguration(nativeOrigin?: string) {
    const { gateway } = structuredClone(defaultCodexPreset.template.configuration.values);
    if (nativeOrigin !== undefined) {
      gateway.controlUi.allowedOrigins.push(nativeOrigin);
    }
    return { ...createHarnessConfiguration("openclaw", "gpt-4.1"), gateway };
  }

  // Findings 3168 and 3189: an unsupported status names its cause, so the console can say what to
  // change. A Configuration without the browser chat opt-in is not-enabled: Control UI off, or on
  // without this Agent's origin and trusted-proxy auth. A browser chat setup that refuses for
  // another reason is configuration. All Agents are deployed and running.
  test("native browser status names why a Configuration is unsupported", async (t) => {
    const context = await createNativeAdminFixture(t);
    const cases: readonly {
      name: string;
      configure: (origin: string) => object;
      reason: "not-enabled" | "configuration";
    }[] = [
      {
        name: "Browser chat off",
        configure: () => createHarnessConfiguration("openclaw", "gpt-4.1"),
        reason: "not-enabled",
      },
      // Create Agent from the default Preset with Enable browser chat unchecked (finding 3189).
      {
        name: "Default Preset",
        configure: () => defaultPresetConfiguration(),
        reason: "not-enabled",
      },
      // Browser chat is on, but its allowed origin is the console, not this Agent.
      {
        name: "Other origin",
        configure: () => nativeAdminHarnessConfiguration(publicOrigin),
        reason: "configuration",
      },
      // This Agent's origin is allowed, but the gateway keeps password auth.
      { name: "Password auth", configure: defaultPresetConfiguration, reason: "configuration" },
    ];
    for (const { name, configure, reason } of cases) {
      const { agent } = await createLiveNativeAgent(context.fixture, context.namespace, name, {
        configure,
      });
      const status = await nativeStatus({ ...context, agent });
      assert.equal(status.status, 200, name);
      const data = statusData(status);
      assert.equal(data.status, "unsupported", name);
      assert.equal(data.reason, reason, name);
    }
  });
}

export function registerNativeAdminExplicitStopCase(
  test: typeof nodeTest,
  { createNativeAdminFixture }: AuthorityDependencies,
): void {
  test("redeploy after explicit Stop keeps the old native endpoint closed", async (t) => {
    const context = await createNativeAdminFixture(t, { exclusiveReplacement: true });
    const stop = await context.fixture.request(
      "POST",
      `/namespaces/${context.namespace.id}/agents/${context.agent.id}/stop`,
    );
    assert.equal(stop.status, 202);
    await context.fixture.deployAgent(context.namespace.id, context.agent.id);
    assert.deepEqual(statusData(await nativeStatus(context)), { status: "unavailable" });
  });
}

export function registerNativeAdminProxyCase(
  test: typeof nodeTest,
  {
    createNativeAdminFixture,
    createExactAgentAdministerSession,
    trustLocalUpstreamCertificate,
  }: AuthorityDependencies,
  nativeGatewayApiKey: string,
  createLiveNativeAgent: CreateLiveNativeAgent,
): void {
  test("native admin proxy strips browser credentials and preserves the Agent gateway base path", async (t) => {
    const context = await createNativeAdminFixture(t);
    const status = await nativeStatus(context);
    const data = statusData(status);
    const administerOnlySession = await createExactAgentAdministerSession(
      context,
      "native-admin-proxy-exact-administer",
    );
    const nativeCookie = administerOnlySession.cookie;
    const sessionResponse = await injectJson(context.fixture, "GET", "/api/auth/session", {
      headers: { cookie: nativeCookie },
    });
    const sessionBody = readRecord(sessionResponse.json<unknown>(), "session body");
    const sessionData = readRecord(sessionBody.data, "session data");
    const nativeSessionKey = readString(sessionData.sessionKey, "session key");
    assert.match(nativeSessionKey, /^[A-Za-z0-9_-]{43}$/);

    trustLocalUpstreamCertificate(t, context.upstream.cert);

    const proxied = await injectJson(context.fixture, "GET", "/settings/profile?tab=devices", {
      headers: {
        host: nativeAuthority({ origin: readString(data.origin, "native origin") }),
        origin: readString(data.origin, "native origin"),
        cookie: nativeCookie,
        "x-forwarded-for": "203.0.113.1",
        "x-occ-identity": "must-not-forward",
        "x-occ-browser-key": "must-not-forward",
        "x-openclaw-scopes": "must-not-forward",
        "x-safe-client-header": "preserved",
        "x-occ-session-key": nativeSessionKey,
      },
    });
    assert.equal(proxied.statusCode, 200, proxied.body);
    assert.equal(proxied.headers["x-native-upstream"], "reached");
    assert.equal(proxied.headers["set-cookie"], undefined);
    assert.match(String(proxied.headers["content-security-policy"]), /default-src 'self'/);
    assert.match(String(proxied.headers["content-security-policy"]), /worker-src 'none'/);

    assert.equal(context.upstream.requests.length, 1);
    const observed = readRecord(context.upstream.requests[0], "native upstream request");
    const observedHeaders = readRecord(observed.headers, "native upstream headers");
    assert.equal(
      observed.url,
      `/native-browser/namespaces/${context.namespace.id}/agents/${context.agent.id}/settings/profile?tab=devices`,
    );
    assert.equal(observedHeaders.origin, data.origin);
    assert.equal(observedHeaders["x-safe-client-header"], "preserved");
    assert.equal(observedHeaders["x-api-key"], nativeGatewayApiKey);
    assert.equal(observedHeaders["x-occ-browser-key"], "server-browser-credential");
    assert.match(readString(observedHeaders["x-occ-identity"], "native identity"), /^test:/);
    assert.equal(observedHeaders["x-openclaw-scopes"], "operator.admin");
    for (const header of ["authorization", "cookie", "x-forwarded-for", "x-occ-session-key"]) {
      assert.equal(observedHeaders[header], undefined, `${header} must not reach native upstream`);
    }

    await continueNativeAdminProxyCase(context, status, nativeCookie, createLiveNativeAgent);
  });
}
