import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type nodeTest from "node:test";
import type { TestContext } from "node:test";

import Type from "typebox";
import { Check } from "typebox/value";
import { deriveNativeAdminHost } from "../../apps/controller/src/gateway/native-admin.ts";
import type { createFastifyApp } from "../../apps/controller/src/index.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { ErrorResponse, Meta } from "../../packages/contracts/src/api/common.ts";
import type { Agent, AgentRevision, Namespace } from "../../packages/contracts/src/index.ts";
import {
  InMemoryPlatformState,
  type OpenClawController,
  type PlatformStateStore,
} from "../../packages/occ/src/index.ts";
import { denialsDuring } from "../helpers/console-audit-denials.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import type { ActionsByKind } from "../helpers/iam-grants.ts";
import { GENERIC_DENIAL, NATIVE_ADMIN_DENIED } from "../helpers/refusal-text.mjs";
import type { browserAccessDependencies } from "./native-admin-access.test.mjs";

type ConsoleFixture = Awaited<ReturnType<typeof createConsoleAppFixture>>;
type Session = Awaited<ReturnType<ConsoleFixture["signIn"]>>;
type FixtureResponse = { status: number; body: unknown };
type NativeAdminApp = { app: Pick<ReturnType<typeof createFastifyApp>, "inject"> };
type InjectedResponse = Awaited<ReturnType<NativeAdminApp["app"]["inject"]>>;
type HttpResponse = Pick<InjectedResponse, "statusCode" | "headers" | "body">;
type RequestOptions = NonNullable<Parameters<ConsoleFixture["request"]>[2]>;
type BrowserAccessFixture = {
  fixture: NativeAdminApp &
    Pick<
      ConsoleFixture,
      | "fixtureResponse"
      | "auditSink"
      | "createNamespace"
      | "createAgent"
      | "createAccountWithPolicy"
      | "deployAgent"
      | "signIn"
    > & {
      controller: OpenClawController;
      request: (
        ...args: Parameters<ConsoleFixture["request"]>
      ) => Promise<FixtureResponse & { headers: Headers; data: unknown }>;
      memoryDatabase: { session: { expiresAt: Date }[] };
    };
  namespace: Pick<Namespace, "id">;
  agent: Pick<Agent, "id" | "namespaceId">;
  revision: AgentRevision;
  session: Session;
  upstream: {
    cert: string;
    requests: readonly { method: string | undefined; url: string | undefined }[];
    routeProxy: { text: string | undefined };
  };
};
interface BrowserAccessDependencies {
  publicOrigin: string;
  nativeDomain: string;
  nativeAdminOffDenied: (resource: string) => string;
  createNativeAdminFixture: (
    t: TestContext,
    options?: {
      state?: PlatformStateStore;
      auditSink?: InMemoryAuditSink;
      recordOperations?: boolean;
      nativeAdminEnabled?: boolean;
      exclusiveReplacement?: boolean | ((revision: AgentRevision) => boolean);
    },
  ) => Promise<BrowserAccessFixture>;
  nativeStatus: (
    context: BrowserAccessFixture,
    options?: RequestOptions,
  ) => Promise<FixtureResponse>;
  injectJson: (
    fixture: NativeAdminApp,
    method: "GET" | "POST",
    path: string,
    options?: { headers?: Record<string, string | undefined> },
  ) => Promise<HttpResponse>;
  nativeAuthority: (native: { origin: string }) => string;
  nativeOriginForAgent: (installationId: string, namespaceId: string, agentId: string) => string;
  createReadOnlySession: (context: BrowserAccessFixture, label?: string) => Promise<Session>;
  createExactAgentAdministerSession: (
    context: BrowserAccessFixture,
    label?: string,
  ) => Promise<Session>;
  createAgentPermissionSession: (
    context: BrowserAccessFixture,
    label: string,
    permissions: ActionsByKind,
  ) => Promise<Session>;
  assertSiblingStatusDenied: (
    context: BrowserAccessFixture,
    session: Session,
    deniedText: (resource: string) => string,
  ) => Promise<void>;
  trustLocalUpstreamCertificate: (t: TestContext, cert: string) => void;
}

// Check the callbacks passed by the JavaScript test root at the actual registration sites.
type RegisterBrowserAccessCases = (
  test: typeof nodeTest,
  dependencies: typeof browserAccessDependencies,
) => void;

export const activatedDocumentNavigationHeaders = {
  accept: "text/html,application/xhtml+xml",
  "sec-fetch-mode": "navigate",
  "sec-fetch-dest": "document",
  "sec-fetch-user": "?1",
};

const NativeStatusResponse = Type.Object({
  meta: Meta,
  data: Type.Union([
    Type.Object({
      status: Type.Literal("available"),
      host: Type.String(),
      origin: Type.String({ format: "uri" }),
    }),
    Type.Object({ status: Type.Literal("disabled") }),
    Type.Object({ status: Type.Literal("stopped") }),
    Type.Object({ status: Type.Literal("unavailable") }),
  ]),
});
const NativeReturnResponse = Type.Object({
  meta: Meta,
  data: Type.Object({ namespaceId: Type.String(), agentId: Type.String() }),
});

function parseJson(text: string): unknown {
  return JSON.parse(text);
}
function jsonEnvelope(response: HttpResponse): FixtureResponse {
  return { status: response.statusCode, body: parseJson(response.body) };
}
function normalizedError(text: string) {
  const body = parseJson(text);
  assert.ok(body !== null && typeof body === "object" && "error" in body);
  assert.ok(
    Check(ErrorResponse.properties.error, body.error),
    "normalized refusal must contain a valid error",
  );
  return body.error;
}
function errorEnvelope(
  fixture: BrowserAccessFixture["fixture"],
  response: HttpResponse,
  status: number,
) {
  return fixture.fixtureResponse(
    jsonEnvelope(response),
    status,
    ErrorResponse,
    "read native browser refusal",
  );
}
function nativeStatusData(context: BrowserAccessFixture, response: FixtureResponse) {
  return context.fixture.fixtureResponse(
    response,
    200,
    NativeStatusResponse,
    "read native browser status",
  ).data;
}
function availableNative(context: BrowserAccessFixture, response: FixtureResponse) {
  const data = nativeStatusData(context, response);
  assert.equal(data.status, "available");
  return data;
}
function returnData(fixture: BrowserAccessFixture["fixture"], response: HttpResponse) {
  return fixture.fixtureResponse(
    jsonEnvelope(response),
    200,
    NativeReturnResponse,
    "resolve native browser return",
  ).data;
}
function contentType(response: HttpResponse): string {
  const value = response.headers["content-type"];
  assert.ok(typeof value === "string");
  return value;
}
function agentKey(host: string): string {
  const match = host.match(/^agent-([a-f0-9]{32})\./);
  assert.ok(match?.[1], "native host must contain an Agent key");
  return match[1];
}

export const registerNativeAdminAvailabilityCases: RegisterBrowserAccessCases = (
  test: typeof nodeTest,
  {
    publicOrigin,
    nativeAdminOffDenied,
    createNativeAdminFixture,
    nativeStatus,
    injectJson,
    nativeAuthority,
    createReadOnlySession,
    createExactAgentAdministerSession,
    assertSiblingStatusDenied,
    trustLocalUpstreamCertificate,
  }: BrowserAccessDependencies,
): void => {
  // While it reconnects, the Agent UI probes GET /healthz and treats 401 or 403 as a sign-in or
  // access problem; when its configuration request is refused too, it opens its sign-in dialog.
  test("an unreachable Gateway or a deployment answers an authorized probe 503, a stop shows a page, and outsiders see neither", async (t) => {
    const context = await createNativeAdminFixture(t, {
      exclusiveReplacement: (revision) => revision.revision === 2,
    });
    trustLocalUpstreamCertificate(t, context.upstream.cert);
    const host = nativeAuthority(availableNative(context, await nativeStatus(context)));
    const readOnly = await createReadOnlySession(context, "native-transition-reader");
    // The sign-in dialog's "Sign in" button opens / in a new tab: a user-activated page load.
    const navigation = activatedDocumentNavigationHeaders;
    const probe = (
      cookie: string | undefined,
      path = "/healthz",
      headers: Record<string, string> = {},
    ) => injectJson(context.fixture, "GET", path, { headers: { ...headers, host, cookie } });
    // Signed out, and signed in without Agent operate, for the probe and the page load: each whole
    // answer, request ID and date aside.
    const outsiders = async () => {
      const answers: {
        path: string;
        status: number;
        headers: HttpResponse["headers"];
        body: string;
      }[] = [];
      for (const cookie of [undefined, readOnly.cookie]) {
        const requests: readonly [string, Record<string, string>][] = [
          ["/healthz", {}],
          ["/", navigation],
        ];
        for (const [path, headers] of requests) {
          const response = await probe(cookie, path, headers);
          const { "x-request-id": requestId, date, ...rest } = response.headers;
          assert.ok(requestId);
          // The 302 has no body, though it is labelled JSON.
          if (
            response.body !== "" &&
            String(response.headers["content-type"]).startsWith("application/json")
          ) {
            assert.equal(
              errorEnvelope(context.fixture, response, response.statusCode).meta.requestId,
              requestId,
            );
          }
          answers.push({
            path,
            status: response.statusCode,
            headers: rest,
            body: response.body.replaceAll(String(requestId), "<request>"),
          });
        }
      }
      return answers;
    };

    assert.equal((await probe(context.session.cookie)).statusCode, 200);
    const available = await outsiders();
    assert.deepEqual(
      available.map(({ status }) => status),
      [403, 302, 403, 403],
    );
    assert.ok(available[3]);
    assert.match(available[3].body, /You do not have access to this gateway\./);
    assert.ok(available[2]);
    assert.deepEqual(normalizedError(available[2].body), {
      code: "FORBIDDEN",
      message: NATIVE_ADMIN_DENIED,
    });
    const key = agentKey(host);
    const link = `<a href="${publicOrigin}/console/#native-agent=${key}">Return to console</a>`;

    // The Gateway refuses connections, so the route's proxy answers instead of it: OCE's own answer
    // replaces that text, a page for a page load.
    context.upstream.routeProxy.text =
      "upstream connect error or disconnect/reset before headers. reset reason: remote connection failure, transport failure reason: delayed connect error: Connection refused";
    for (const headers of [{}, { accept: "application/json" }]) {
      const unreachable = await probe(context.session.cookie, "/healthz", headers);
      assert.equal(unreachable.statusCode, 503, unreachable.body);
      assert.equal(
        errorEnvelope(context.fixture, unreachable, 503).meta.requestId,
        unreachable.headers["x-request-id"],
      );
      assert.deepEqual(errorEnvelope(context.fixture, unreachable, 503).error, {
        code: "DEPENDENCY_UNAVAILABLE",
        message: "A required platform dependency is unavailable.",
      });
    }
    const notResponding = await probe(context.session.cookie, "/", navigation);
    assert.equal(notResponding.statusCode, 503, notResponding.body);
    assert.match(contentType(notResponding), /^text\/html/);
    assert.equal(notResponding.headers["cache-control"], "no-store");
    assert.match(notResponding.body, /<title>Agent not responding<\/title>/);
    assert.match(notResponding.body, /This Agent is not responding right now\./);
    assert.ok(notResponding.body.includes(link), notResponding.body);
    assert.deepEqual(await outsiders(), available, "an unreachable Gateway is invisible to them");
    assert.equal(context.upstream.requests.length, 4, "only authorized requests reached the route");
    // Any other short 503 text/plain answer is the Gateway's own and passes through as it is.
    context.upstream.routeProxy.text = "other";
    const other = await probe(context.session.cookie, "/healthz");
    assert.equal(other.statusCode, 503);
    assert.equal(other.body, "other");
    assert.equal(other.headers["content-type"], "text/plain");
    assert.equal(other.headers["content-length"], "5");
    context.upstream.routeProxy.text = undefined;

    const replacement = await context.fixture.deployAgent(context.namespace.id, context.agent.id);
    await context.fixture.controller.transact((state) =>
      state.agents.recordPredecessorReplacement(context.namespace.id, context.agent.id, {
        predecessorRevisionId: context.revision.id,
        candidateRevisionId: replacement.id,
        phase: "stopping",
      }),
    );
    assert.deepEqual(nativeStatusData(context, await nativeStatus(context)), {
      status: "unavailable",
    });
    const replacing = await probe(context.session.cookie);
    assert.equal(replacing.statusCode, 503, replacing.body);
    assert.deepEqual(errorEnvelope(context.fixture, replacing, 503).error, {
      code: "DEPENDENCY_UNAVAILABLE",
      message: "A required platform dependency is unavailable.",
    });
    assert.deepEqual(await outsiders(), available, "a deployment is invisible to outsiders");

    const stop = await context.fixture.request(
      "POST",
      `/namespaces/${context.namespace.id}/agents/${context.agent.id}/stop`,
    );
    assert.equal(stop.status, 202);
    assert.equal(nativeStatusData(context, await nativeStatus(context)).status, "stopped");
    // A stopped Agent stays refused, so the Agent UI still offers its sign-in panel. Its link, a page
    // load, gets a page that says the Agent is unavailable; probes and API reads keep the JSON 403.
    for (const headers of [{}, navigation]) {
      const stopped = await probe(context.session.cookie, "/healthz", headers);
      assert.equal(stopped.statusCode, 403, stopped.body);
      assert.deepEqual(errorEnvelope(context.fixture, stopped, 403).error, {
        code: "FORBIDDEN",
        message: GENERIC_DENIAL,
      });
    }
    const apiRead = await probe(context.session.cookie, "/", { accept: "application/json" });
    assert.equal(apiRead.statusCode, 403, apiRead.body);
    assert.deepEqual(errorEnvelope(context.fixture, apiRead, 403).error, {
      code: "FORBIDDEN",
      message: GENERIC_DENIAL,
    });
    const page = await probe(context.session.cookie, "/", navigation);
    assert.equal(page.statusCode, 403, page.body);
    assert.match(contentType(page), /^text\/html/);
    assert.equal(page.headers["cache-control"], "no-store");
    assert.equal(page.headers["referrer-policy"], "no-referrer");
    assert.match(page.body, /<title>Agent unavailable<\/title>/);
    assert.match(
      page.body,
      /<p>This Agent is not available right now\. Open it from the console\.<\/p>/,
    );
    assert.ok(page.body.includes(link), page.body);
    assert.equal(page.body.includes(context.agent.id), false);
    assert.deepEqual(await outsiders(), available, "a stop is invisible to outsiders");
    assert.equal(context.upstream.requests.length, 5, "only authorized running probes reached it");
  });

  test("native browser disabled status still requires exact Agent authority", async (t) => {
    const context = await createNativeAdminFixture(t, { nativeAdminEnabled: false });

    const disabled = await nativeStatus(context);
    assert.equal(disabled.status, 200);
    assert.equal(nativeStatusData(context, disabled).status, "disabled");

    const administerOnlySession = await createExactAgentAdministerSession(
      context,
      "native-admin-disabled-exact-administer",
    );
    const administerOnlyDisabled = await nativeStatus(context, { session: administerOnlySession });
    assert.equal(administerOnlyDisabled.status, 200);
    assert.equal(nativeStatusData(context, administerOnlyDisabled).status, "disabled");
    await assertSiblingStatusDenied(context, administerOnlySession, nativeAdminOffDenied);

    const limitedSession = await createReadOnlySession(context, "native-admin-disabled-reader");
    const denied = await nativeStatus(context, { session: limitedSession });
    const deniedBody = context.fixture.fixtureResponse(
      denied,
      403,
      ErrorResponse,
      "reject read-only native status",
    );
    assert.equal(deniedBody.error.code, "FORBIDDEN");
    // With native admin off, the denial also says the grant alone would not open it (finding D762).
    assert.equal(deniedBody.error.message, nativeAdminOffDenied(`Agent ${context.agent.id}`));

    const missingStatus = await context.fixture.request(
      "GET",
      `/namespaces/${context.namespace.id}/agents/agt_${randomUUID()}/native-admin`,
    );
    assert.equal(missingStatus.status, 404);
    assert.equal(
      context.fixture.fixtureResponse(
        missingStatus,
        404,
        ErrorResponse,
        "reject missing Agent status",
      ).error.code,
      "NOT_FOUND",
    );
  });
};

export const registerNativeAdminCopiedLinkCase: RegisterBrowserAccessCases = (
  test: typeof nodeTest,
  {
    publicOrigin,
    nativeDomain,
    createNativeAdminFixture,
    nativeStatus,
    injectJson,
    nativeAuthority,
    createReadOnlySession,
  }: BrowserAccessDependencies,
): void => {
  test("a copied Agent chat link redirects an activated browser navigation to the configured console without granting access", async (t) => {
    const auditSink = new InMemoryAuditSink();
    const context = await createNativeAdminFixture(t, { auditSink });
    const status = await nativeStatus(context);
    const native = availableNative(context, status);
    const host = nativeAuthority(native);
    const navigation = {
      host,
      ...activatedDocumentNavigationHeaders,
    };
    const page = await injectJson(context.fixture, "GET", "/chat/main", {
      headers: { ...navigation, "x-forwarded-host": "attacker.example.test" },
    });
    const key = agentKey(native.host);
    const destination = `${publicOrigin}/console/#native-agent=${key}`;
    assert.equal(page.statusCode, 302);
    assert.equal(page.headers.location, destination);
    assert.equal(page.headers["cache-control"], "no-store");
    assert.equal(page.headers["referrer-policy"], "no-referrer");
    assert.ok(page.headers["x-request-id"]);
    assert.equal(page.headers["set-cookie"], undefined);
    // The console opens the native root, not only copied chat links.
    const rootPage = await injectJson(context.fixture, "GET", "/?return=https://attacker.example", {
      headers: navigation,
    });
    assert.equal(rootPage.statusCode, 302);
    assert.equal(rootPage.headers.location, destination);
    const sessionSuffix = "a".repeat(32);
    const sessionPage = await injectJson(
      context.fixture,
      "GET",
      `/chat/main/${sessionSuffix}?private=omitted`,
      { headers: navigation },
    );
    assert.equal(sessionPage.statusCode, 302);
    assert.equal(sessionPage.headers.location, destination);
    // Named sessions are valid copied chat URLs too, not only opaque hex IDs.
    const namedSessionPath = `/chat/main/simple-test-session-${sessionSuffix}`;
    const namedSession = await injectJson(context.fixture, "GET", namedSessionPath, {
      headers: navigation,
    });
    assert.equal(namedSession.statusCode, 302, namedSession.body);
    assert.equal(namedSession.headers.location, destination);
    const inventedKey = "f".repeat(32);
    const invented = await injectJson(context.fixture, "GET", "/chat/main", {
      headers: {
        ...navigation,
        host: `agent-${inventedKey}.${nativeDomain}`,
        "x-forwarded-host": "attacker.example.test",
      },
    });
    assert.equal(invented.statusCode, 302);
    assert.equal(invented.headers.location, destination.replace(key, inventedKey));
    // A copied link with a trailing slash is the same page load.
    const trailing = await injectJson(context.fixture, "GET", "/chat/main/", {
      headers: navigation,
    });
    assert.equal(trailing.statusCode, 302);
    assert.equal(trailing.headers.location, destination);

    // Safari never sends Sec-Fetch-User, and other browsers omit it on navigations without user
    // activation. Such a page load stays 403 without redirecting, but shows a sign-in link instead of
    // the JSON refusal.
    const { "sec-fetch-user": _activation, ...unactivated } = navigation;
    for (const path of [
      "/",
      "/chat/main",
      "/chat/main/",
      `/chat/main/${sessionSuffix}`,
      namedSessionPath,
    ]) {
      const signIn = await injectJson(context.fixture, "GET", path, { headers: unactivated });
      assert.equal(signIn.statusCode, 403, path);
      assert.equal(signIn.headers.location, undefined, path);
      assert.match(contentType(signIn), /^text\/html/, path);
      assert.equal(signIn.headers["cache-control"], "no-store", path);
      assert.equal(signIn.headers["referrer-policy"], "no-referrer", path);
      assert.equal(signIn.headers["x-content-type-options"], "nosniff", path);
      assert.ok(signIn.headers["x-request-id"], path);
      assert.equal(signIn.headers["set-cookie"], undefined, path);
      assert.match(
        signIn.body,
        new RegExp(`<a href="${publicOrigin}/console/#native-agent=${key}">Sign in</a>`),
        path,
      );
      assert.equal(signIn.body.includes(context.agent.id), false, path);
    }

    const refusedRequests: readonly ["GET" | "POST", string, Record<string, string>][] = [
      ["GET", "/chat/main", { host, accept: "application/json" }],
      // Link unfurlers send no Fetch Metadata: no redirect and no sign-in page.
      ["GET", "/chat/main", { host, accept: "text/html", "user-agent": "Slackbot-LinkExpanding" }],
      [
        "GET",
        "/chat/main",
        {
          host,
          accept: "text/html",
          "user-agent": "Slackbot-LinkExpanding",
          "sec-fetch-user": "?1",
        },
      ],
      ["GET", "/chat/main", { ...navigation, host: `agent-${key}.other.${nativeDomain}` }],
      ["GET", "/chat/main", { ...navigation, "sec-fetch-dest": "iframe" }],
      ["GET", "/chat/main", { ...navigation, "sec-fetch-mode": "cors" }],
      ["GET", "/chat/main", { ...navigation, accept: "text/html;q=0,application/json" }],
      ["GET", "/chat/main/session/extra", navigation],
      ["GET", "/settings", navigation],
      ["GET", "/", { ...navigation, "sec-fetch-mode": "cors" }],
      ["GET", "/", { ...navigation, "sec-fetch-dest": "iframe" }],
      ["GET", "/api/status", navigation],
      ["GET", "/auth/callback", navigation],
      ["GET", "//attacker.example/", navigation],
      ["POST", "/chat/main", navigation],
    ];
    for (const [method, path, headers] of refusedRequests) {
      const denied = await injectJson(context.fixture, method, path, { headers });
      assert.equal(denied.statusCode, 403, `${method} ${path}`);
      assert.equal(denied.headers.location, undefined);
      assert.match(contentType(denied), /^application\/json/);
      assert.equal(errorEnvelope(context.fixture, denied, 403).error.code, "FORBIDDEN");
    }
    const limited = await createReadOnlySession(context);
    const limitedRequests: readonly [string, Record<string, string>][] = [
      ["/", navigation],
      ["/chat/main", navigation],
      ["/chat/main", unactivated],
    ];
    for (const [path, headers] of limitedRequests) {
      const unauthorized = await injectJson(context.fixture, "GET", path, {
        headers: { ...headers, cookie: limited.cookie },
      });
      assert.equal(unauthorized.statusCode, 403);
      assert.equal(unauthorized.headers.location, undefined);
      assert.match(contentType(unauthorized), /^text\/html/);
      assert.match(unauthorized.body, /Go to your Agents/);
      assert.equal(unauthorized.body.includes(context.agent.id), false);
    }
    const endpoint = `/native-admin/return/${key}`;
    const found = await injectJson(context.fixture, "GET", endpoint, {
      headers: { host: new URL(publicOrigin).host, cookie: context.session.cookie },
    });
    assert.equal(found.statusCode, 200, found.body);
    assert.deepEqual(returnData(context.fixture, found), {
      namespaceId: context.namespace.id,
      agentId: context.agent.id,
    });
    assert.equal(found.headers["cache-control"], "no-store");
    const unknown = await injectJson(
      context.fixture,
      "GET",
      `/native-admin/return/${"f".repeat(32)}`,
      {
        headers: { host: new URL(publicOrigin).host, cookie: limited.cookie },
      },
    );
    const forbidden = await injectJson(context.fixture, "GET", endpoint, {
      headers: { host: new URL(publicOrigin).host, cookie: limited.cookie },
    });
    assert.equal(unknown.statusCode, 404, unknown.body);
    assert.equal(forbidden.statusCode, 404, forbidden.body);
    assert.deepEqual(
      errorEnvelope(context.fixture, unknown, 404).error,
      errorEnvelope(context.fixture, forbidden, 404).error,
    );
    assert.ok(
      auditSink.events.some(
        (event) =>
          event.action === "openclaw.agents.native_admin.return.authorize" &&
          event.requestId === errorEnvelope(context.fixture, forbidden, 404).meta.requestId &&
          event.outcome === "denied",
      ),
    );
    const anonymous = await injectJson(context.fixture, "GET", endpoint, {
      headers: { host: new URL(publicOrigin).host },
    });
    assert.equal(anonymous.statusCode, 401, anonymous.body);
    const invalid = await injectJson(context.fixture, "GET", "/native-admin/return/not-a-key", {
      headers: { host: new URL(publicOrigin).host, cookie: context.session.cookie },
    });
    assert.equal(invalid.statusCode, 400, invalid.body);
    const forwarded = await injectJson(context.fixture, "GET", endpoint, {
      headers: {
        host: new URL(publicOrigin).host,
        cookie: context.session.cookie,
        "x-forwarded-host": "attacker.example.test",
      },
    });
    assert.equal(forwarded.statusCode, 403);

    // The detail page is the recovery destination even when no revision is serving.
    const stopped = await context.fixture.request(
      "POST",
      `/namespaces/${context.namespace.id}/agents/${context.agent.id}/stop`,
    );
    assert.equal(stopped.status, 202);
    await context.fixture.controller.transact((state) =>
      state.agents.compareAndClearActiveRevision(
        context.namespace.id,
        context.agent.id,
        context.revision.id,
      ),
    );
    const stoppedReturn = await injectJson(context.fixture, "GET", endpoint, {
      headers: { host: new URL(publicOrigin).host, cookie: context.session.cookie },
    });
    assert.equal(stoppedReturn.statusCode, 200, stoppedReturn.body);
    assert.deepEqual(
      returnData(context.fixture, stoppedReturn),
      returnData(context.fixture, found),
    );

    // Changing the key must not buy more lookups; another administrator keeps their own budget.
    const burst = await Promise.all(
      Array.from({ length: 7 }, (_, index) =>
        injectJson(
          context.fixture,
          "GET",
          endpoint.replace(key, index.toString(16).padStart(32, "0")),
          {
            headers: { host: new URL(publicOrigin).host, cookie: limited.cookie },
          },
        ),
      ),
    );
    const throttled = burst.find((response) => response.statusCode === 429);
    assert.ok(
      throttled,
      "expected repeated return lookups to be limited; got " +
        burst.map((response) => response.statusCode).join(", "),
    );
    assert.equal(
      errorEnvelope(context.fixture, throttled, 429).error.code,
      "NATIVE_ADMIN_RETURN_RATE_LIMITED",
    );
    assert.ok(Number(throttled.headers["retry-after"]) > 0);
    const independent = await injectJson(context.fixture, "GET", endpoint, {
      headers: { host: new URL(publicOrigin).host, cookie: context.session.cookie },
    });
    assert.equal(independent.statusCode, 200, independent.body);
    assert.equal(context.upstream.requests.length, 0);

    // Expiry of a previously issued cookie takes the same safe route as a missing cookie.
    for (const session of context.fixture.memoryDatabase.session) {
      session.expiresAt = new Date(Date.now() - 1000);
    }
    const expired = await injectJson(context.fixture, "GET", "/", {
      headers: { ...navigation, cookie: context.session.cookie },
    });
    assert.equal(expired.statusCode, 302);
    assert.equal(expired.headers.location, destination);
    const expiredApi = await injectJson(context.fixture, "POST", "/", {
      headers: { ...navigation, cookie: context.session.cookie },
    });
    assert.equal(expiredApi.statusCode, 403);
    assert.equal(expiredApi.headers.location, undefined);

    const renewed = await context.fixture.signIn();
    const resumed = await injectJson(context.fixture, "GET", endpoint, {
      headers: { host: new URL(publicOrigin).host, cookie: renewed.cookie },
    });
    assert.equal(resumed.statusCode, 200, resumed.body);
    assert.deepEqual(returnData(context.fixture, resumed), returnData(context.fixture, found));
  });
};

export const registerNativeAdminHostResolutionCase: RegisterBrowserAccessCases = (
  test: typeof nodeTest,
  {
    nativeDomain,
    createNativeAdminFixture,
    injectJson,
    nativeOriginForAgent,
    createAgentPermissionSession,
    trustLocalUpstreamCertificate,
  }: BrowserAccessDependencies,
): void => {
  test("native admin proxy resolves a host only to the live Agent it names", async (t) => {
    const state = new InMemoryPlatformState();
    const context = await createNativeAdminFixture(t, { state, recordOperations: true });
    const { fixture, namespace, agent, upstream } = context;
    trustLocalUpstreamCertificate(t, upstream.cert);
    const installationId = fixture.controller.installation.id;
    // The installation administrator's session administers every Agent, so each refusal below
    // comes from host resolution, not from IAM.
    const proxied = (namespaceId: string, agentId: string, cookie = context.session.cookie) => {
      const origin = nativeOriginForAgent(installationId, namespaceId, agentId);
      return injectJson(fixture, "GET", "/settings/profile", {
        headers: { host: new URL(origin).host, origin, cookie },
      });
    };

    const resolveReference = fixture.controller.resolveAgentReference.bind(fixture.controller);
    const shapeLookups = t.mock.method(
      fixture.controller,
      "resolveAgentReference",
      (...args: Parameters<typeof resolveReference>) => resolveReference(...args),
    );
    try {
      const own = await proxied(namespace.id, agent.id);
      assert.equal(own.statusCode, 200, own.body);
      assert.equal(upstream.requests.length, 1);
      assert.equal(shapeLookups.mock.callCount(), 1, "a valid host uses the real reference lookup");

      const account = await fixture.createAccountWithPolicy("native-host-no-access", () => {});
      const limited = await fixture.signIn(account.credentials);
      const unknown = await proxied(namespace.id, `agt_${randomUUID()}`, limited.cookie);
      const inaccessible = await proxied(namespace.id, agent.id, limited.cookie);
      assert.equal(unknown.statusCode, 403, unknown.body);
      assert.equal(inaccessible.statusCode, 403, inaccessible.body);
      assert.deepEqual(
        errorEnvelope(fixture, unknown, 403).error,
        errorEnvelope(fixture, inaccessible, 403).error,
      );
      assert.equal(shapeLookups.mock.callCount(), 3, "well-formed hosts retain the real lookup");

      const key = agentKey(deriveNativeAdminHost(installationId, agent, nativeDomain));
      for (const malformedHost of [
        `agent-.${nativeDomain}`,
        `agent-${key.slice(1)}.${nativeDomain}`,
        `agent-${key}0.${nativeDomain}`,
        `agent-${"g".repeat(32)}.${nativeDomain}`,
        `agent-${key}.other.${nativeDomain}`,
      ]) {
        const before = shapeLookups.mock.callCount();
        const denied = await injectJson(fixture, "GET", "/console/", {
          headers: { host: malformedHost, cookie: limited.cookie },
        });
        assert.equal(denied.statusCode, 403, denied.body);
        assert.equal(errorEnvelope(fixture, denied, 403).error.code, "FORBIDDEN");
        assert.equal(denied.headers.location, undefined);
        assert.equal(
          shapeLookups.mock.callCount() - before,
          0,
          `malformed native hosts must not enumerate Agent references: ${malformedHost}`,
        );
        assert.equal(
          upstream.requests.length,
          1,
          "a malformed host must not reach a native gateway",
        );
      }
    } finally {
      shapeLookups.mock.restore();
    }

    const other = await fixture.createNamespace("Native admin other", { ready: true });
    const otherAgent = await fixture.createAgent(
      other.id,
      "Native admin other Agent",
      createHarnessConfiguration("openclaw", "gpt-4.1"),
    );
    const unresolvedAgents: readonly [string, string, string][] = [
      ["an Agent that does not exist", namespace.id, `agt_${randomUUID()}`],
      ["this Agent under another Namespace", other.id, agent.id],
      ["another Namespace's Agent under this Namespace", namespace.id, otherAgent.id],
    ];
    for (const [label, namespaceId, agentId] of unresolvedAgents) {
      const denied = await proxied(namespaceId, agentId);
      assert.equal(denied.statusCode, 403, `${label}: ${denied.body}`);
      // The same text as a caller denied on a live Agent, so a host reveals no Agent.
      assert.deepEqual(errorEnvelope(fixture, denied, 403).error, {
        code: "FORBIDDEN",
        message: NATIVE_ADMIN_DENIED,
      });
    }
    // Another Namespace's Agent resolves to itself alone; it has no active revision to serve.
    const otherHost = await proxied(other.id, otherAgent.id);
    assert.notEqual(otherHost.statusCode, 200, otherHost.body);
    assert.equal(upstream.requests.length, 1, "no refused host may reach a native gateway");

    const chat = await createAgentPermissionSession(context, "deleting-agent-chat", {
      agent: ["operate"],
    });
    const beforeDeletion = await proxied(namespace.id, agent.id, chat.cookie);
    assert.equal(beforeDeletion.statusCode, 200, beforeDeletion.body);
    const deleted = await fixture.request(
      "DELETE",
      `/namespaces/${namespace.id}/agents/${agent.id}`,
    );
    assert.equal(deleted.status, 202);
    const { response: deleting, denials: deletingDenials } = await denialsDuring(
      fixture.auditSink,
      () => proxied(namespace.id, agent.id, chat.cookie),
    );

    // Commit real deletion after the real host lookup, before admission's exact Agent read.
    // The wrapper changes only ordering: no lookup result or failure is invented.
    const resolve = fixture.controller.resolveAgentReference.bind(fixture.controller);
    const lookup = t.mock.method(
      fixture.controller,
      "resolveAgentReference",
      async (...args: Parameters<typeof resolve>) => {
        const selected = await resolve(...args);
        assert.equal(selected?.id, agent.id);
        assert.equal(await state.completeAgentDeletion(namespace.id, agent.id), true);
        return selected;
      },
    );
    let racing: Awaited<ReturnType<typeof denialsDuring<Promise<HttpResponse>>>>;
    try {
      racing = await denialsDuring(fixture.auditSink, () => proxied(namespace.id, agent.id));
    } finally {
      lookup.mock.restore();
    }
    const afterDeletion = await proxied(namespace.id, agent.id);
    assert.deepEqual(
      [deleting.statusCode, racing.response.statusCode, afterDeletion.statusCode],
      [403, 403, 403],
      "deleting and deleted Agents are refusals, not temporary dependency outages",
    );
    assert.deepEqual(
      errorEnvelope(fixture, racing.response, 403).error,
      errorEnvelope(fixture, afterDeletion, 403).error,
    );
    assert.deepEqual(deletingDenials, []);
    assert.deepEqual(racing.denials, [], "deletion does not invent an attributable IAM denial");
    assert.equal(upstream.requests.length, 2);
  });
};

export const registerNativeAdminDeniedBackCase: RegisterBrowserAccessCases = (
  test: typeof nodeTest,
  {
    publicOrigin,
    createNativeAdminFixture,
    nativeStatus,
    injectJson,
    nativeAuthority,
    createReadOnlySession,
  }: BrowserAccessDependencies,
): void => {
  test("a browser Back to a denied Agent gateway stays 403 and links to the console", async (t) => {
    const context = await createNativeAdminFixture(t);
    const status = await nativeStatus(context);
    const native = availableNative(context, status);
    const host = nativeAuthority(native);
    const limited = await createReadOnlySession(context);
    const navigation = {
      host,
      cookie: limited.cookie,
      ...activatedDocumentNavigationHeaders,
    };
    const page = await injectJson(context.fixture, "GET", "/", { headers: navigation });
    assert.equal(page.statusCode, 403);
    assert.equal(page.headers.location, undefined);
    assert.match(contentType(page), /^text\/html/);
    assert.equal(page.headers["cache-control"], "no-store");
    assert.equal(page.headers["referrer-policy"], "no-referrer");
    assert.equal(page.headers["set-cookie"], undefined);
    assert.match(page.body, /Go to your Agents/);
    assert.match(page.body, new RegExp(`href="${publicOrigin}/console/agents"`));
    assert.equal(page.body.includes(context.agent.id), false);
    assert.equal(page.body.includes(native.host), false);

    const api = await injectJson(context.fixture, "GET", "/", {
      headers: { host, accept: "application/json", cookie: limited.cookie },
    });
    assert.equal(api.statusCode, 403);
    assert.match(contentType(api), /^application\/json/);
    // The JSON refusal names the grant but not the Agent, which the host named, not the caller.
    assert.deepEqual(errorEnvelope(context.fixture, api, 403).error, {
      code: "FORBIDDEN",
      message: NATIVE_ADMIN_DENIED,
    });
  });
};
