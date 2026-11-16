import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type nodeTest from "node:test";
import type { TestContext } from "node:test";

import Type from "typebox";
import { Check } from "typebox/value";
import { deriveNativeAdminHost } from "../../apps/controller/src/gateway/native-admin.ts";
import type { ControllerAppOptions, createFastifyApp } from "../../apps/controller/src/index.ts";
import { createOccLogger, type OccLogger } from "../../apps/controller/src/logging.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { ErrorResponse, Meta } from "../../packages/contracts/src/api/common.ts";
import {
  AgentResponse,
  ConfigurationResponse,
} from "../../packages/contracts/src/api/resources.ts";
import type {
  Agent,
  Identity,
  Namespace,
  ServicePrincipal,
} from "../../packages/contracts/src/index.ts";
import { denialsDuring } from "../helpers/console-audit-denials.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { grantRole } from "../helpers/iam-grants.ts";
import { callerDenied } from "../helpers/refusal-text.mjs";
import type { sharedSessionDependencies } from "./native-admin-access.test.mjs";

type ConsoleFixture = Awaited<ReturnType<typeof createConsoleAppFixture>>;
type FixtureResponse = { status: number; body: unknown };
type ServiceKeyContext = {
  fixture: {
    request: (
      ...args: Parameters<ConsoleFixture["request"]>
    ) => Promise<FixtureResponse & { headers: Headers; data: unknown }>;
    fixtureResponse: ConsoleFixture["fixtureResponse"];
    policy: Pick<ConsoleFixture["policy"], "roles" | "bindings"> & { identities: Identity[] };
  };
  namespace: Pick<Namespace, "id">;
  agent: Pick<Agent, "id">;
};

type SharedSessionFixture = ServiceKeyContext & {
  fixture: NativeAdminApp &
    Pick<ConsoleFixture, "createAgent"> & {
      memoryDatabase: Pick<ConsoleFixture["memoryDatabase"], "session">;
    };
  agent: Pick<Agent, "id" | "namespaceId">;
  session: Pick<Awaited<ReturnType<ConsoleFixture["signIn"]>>, "cookie" | "setCookie">;
  upstream: {
    cert: string;
    requests: readonly { method: string | undefined; url: string | undefined }[];
  };
};

type NativeAdminApp = { app: Pick<ReturnType<typeof createFastifyApp>, "inject"> };
type InjectedResponse = Awaited<ReturnType<NativeAdminApp["app"]["inject"]>>;
type HttpResponse = Pick<InjectedResponse, "statusCode" | "headers" | "body">;

interface SharedSessionDependencies {
  publicOrigin: string;
  authBaseURL: string;
  createNativeAdminFixture: (
    t: TestContext,
    options?: { nativeDomain?: string; auditSink?: InMemoryAuditSink; logger?: OccLogger },
  ) => Promise<SharedSessionFixture>;
  nativeStatus: (context: SharedSessionFixture) => Promise<FixtureResponse>;
  injectJson: (
    fixture: NativeAdminApp,
    method: "GET" | "POST",
    path: string,
    options: { headers: Record<string, string> },
  ) => Promise<HttpResponse>;
  nativeAuthority: (native: { origin: string }) => string;
  createSiblingAgent: (context: SharedSessionFixture) => Promise<Pick<Agent, "id">>;
  trustLocalUpstreamCertificate: (t: TestContext, cert: string) => void;
}

// Check the JavaScript entry's real fixture and callbacks wherever it registers these cases.
type RegisterSharedSessionCases = (
  test: typeof nodeTest,
  dependencies: typeof sharedSessionDependencies,
) => void;

// These controller-local routes have no shared TypeBox response schema.
// Validate the fields this case family consumes at the JSON boundary.
const NativeStatusResponse = Type.Object({
  meta: Meta,
  data: Type.Union([
    Type.Object({ status: Type.Literal("available"), origin: Type.String({ format: "uri" }) }),
    Type.Object({
      status: Type.Literal("unavailable"),
      host: Type.Optional(Type.Never()),
      origin: Type.Optional(Type.Never()),
      url: Type.Optional(Type.Never()),
    }),
  ]),
});
const IssuedKeyResponse = Type.Object({
  meta: Meta,
  data: Type.Object({
    key: Type.String({ pattern: "^occ_" }),
    namespaceId: Type.String(),
    servicePrincipalId: Type.String(),
    id: Type.String(),
    name: Type.String(),
    expiresAt: Type.String({ format: "date-time" }),
  }),
});
const SessionResponse = Type.Object({
  meta: Meta,
  data: Type.Union([
    Type.Null(),
    Type.Object({
      authenticated: Type.Literal(true),
      sessionKey: Type.String(),
      user: Type.Object({ id: Type.String(), email: Type.String(), name: Type.String() }),
    }),
  ]),
});
const CompletedRequest = Type.Object({
  event: Type.Literal("http.completed"),
  requestId: Type.String(),
  nativeAdmissionReason: Type.Optional(Type.String()),
  status: Type.Number(),
});

function jsonEnvelope(response: HttpResponse): FixtureResponse {
  const body: unknown = JSON.parse(response.body);
  return { status: response.statusCode, body };
}

function availableNativeOrigin(
  fixture: Pick<ConsoleFixture, "fixtureResponse">,
  response: FixtureResponse,
) {
  const { data } = fixture.fixtureResponse(
    response,
    200,
    NativeStatusResponse,
    "read native status",
  );
  assert.equal(data.status, "available");
  return data.origin;
}

export async function issueServiceKeyForNativeAgent(context: ServiceKeyContext) {
  const principal: ServicePrincipal = {
    id: `native-admin-service-${randomUUID()}`,
    kind: "service_principal",
    namespaceId: context.namespace.id,
  };
  context.fixture.policy.identities.push(principal);
  const { role } = grantRole(context.fixture.policy, principal.id, {
    id: `native-admin-service-role-${randomUUID()}`,
    bindingId: `native-admin-service-binding-${randomUUID()}`,
    namespaceId: context.namespace.id,
    permissions: { agent: ["administer"] },
    resource: { kind: "agent", id: context.agent.id },
  });
  const issued = await context.fixture.request("POST", "/api/auth/service-keys", {
    body: {
      servicePrincipalId: principal.id,
      namespaceId: context.namespace.id,
      name: "native-admin-service-key",
    },
  });
  const { data } = context.fixture.fixtureResponse(
    issued,
    201,
    IssuedKeyResponse,
    "issue Agent service key",
  );
  assert.equal(data.servicePrincipalId, principal.id);
  assert.equal(data.namespaceId, context.namespace.id);
  return { key: data.key, role };
}

export const registerNativeAdminSharedCookieCases: RegisterSharedSessionCases = (
  test: typeof nodeTest,
  {
    publicOrigin,
    authBaseURL,
    createNativeAdminFixture,
    nativeStatus,
    injectJson,
    nativeAuthority,
  }: SharedSessionDependencies,
): void => {
  // Retained installation settings must not take ordinary Console and API access down.
  test("native admin retained domains preserve controller access and refuse unusable targets", async (t) => {
    const longest: string = `${"a.".repeat(99)}oce.example.test`;
    assert.equal(longest.length, 214);
    for (const length of [214, 215]) {
      const domain: string = `${"a".repeat(length - longest.length)}${longest}`;
      const context = await createNativeAdminFixture(t, { nativeDomain: domain });
      const { fixture, namespace, agent } = context;
      assert.equal(deriveNativeAdminHost("installation", agent, domain).length, length + 39);
      const ordinary = await fixture.request(
        "GET",
        `/namespaces/${namespace.id}/agents/${agent.id}`,
      );
      assert.equal(ordinary.status, 200);
      const consolePage = await fixture.app.inject({
        method: "GET",
        url: "/console/",
        headers: { host: new URL(publicOrigin).host },
      });
      assert.equal(consolePage.statusCode, 200);
      const { data: status } = fixture.fixtureResponse(
        await nativeStatus(context),
        200,
        NativeStatusResponse,
        "read native status for retained domain",
      );
      assert.equal(status.status, length === 214 ? "available" : "unavailable");
      if (status.status === "unavailable") {
        const configurations = `/namespaces/${namespace.id}/configurations`;
        const { data: config } = fixture.fixtureResponse(
          await fixture.request("POST", configurations, { body: { kind: "agent", values: {} } }),
          201,
          ConfigurationResponse,
          "create Configuration for refused Agent",
        );
        const configPath = `${configurations}/${config.id}`;
        const before = fixture.fixtureResponse(
          await fixture.request("GET", configPath),
          200,
          ConfigurationResponse,
          "read original Configuration",
        );
        const created = await fixture.request("POST", `/namespaces/${namespace.id}/agents`, {
          body: {
            name: "refused-native-opt-in",
            configurationId: config.id,
            nativeAdmin: true,
            expectedConfigurationGeneration: config.generation,
          },
        });
        assert.equal(created.status, 400, JSON.stringify(created.body));
        const after = fixture.fixtureResponse(
          await fixture.request("GET", configPath),
          200,
          ConfigurationResponse,
          "read retained Configuration",
        );
        assert.deepEqual(after.data, before.data);
      }
    }
    // Retained settings still identify disabled native hosts, which must be denied
    // instead of preventing startup or falling through to ordinary Console routes.
    const domain = `aaa${longest}`;
    let gatewayKeyReads = 0;
    const disabledOptions = {
      publicOrigin,
      authBaseURL,
      development: { enabled: false },
      nativeAdmin: { enabled: false, domain },
      nativeAdminGatewayApiKey: async () => {
        gatewayKeyReads += 1;
        return randomUUID();
      },
    } satisfies Pick<
      ControllerAppOptions,
      "publicOrigin" | "development" | "nativeAdmin" | "nativeAdminGatewayApiKey"
    > & { authBaseURL: string };
    const disabled: NativeAdminApp & Pick<ConsoleFixture, "fixtureResponse"> =
      await createConsoleAppFixture(t, disabledOptions);
    for (const host of [
      `agent-${"a".repeat(32)}.${domain}`,
      `agent-invalid.${domain}`,
      `agent-${"a".repeat(32)}.other.${domain}`,
    ]) {
      const denied = await disabled.app.inject({
        method: "GET",
        url: "/console/",
        headers: { host },
      });
      const { error } = disabled.fixtureResponse(
        jsonEnvelope(denied),
        403,
        ErrorResponse,
        "reject disabled native host",
      );
      assert.equal(error.code, "FORBIDDEN");
    }
    // The transport catches provider errors, so inspect calls after the requests.
    assert.equal(
      gatewayKeyReads,
      0,
      "disabled native administration must not read the gateway key",
    );
  });

  test("native admin shared session configuration validates cookie scope and rejects keys", async (t) => {
    const context = await createNativeAdminFixture(t);
    const origin = availableNativeOrigin(context.fixture, await nativeStatus(context));
    const cookie = context.session.setCookie.join("\n");
    assert.match(cookie, /(?:__Secure-)?openclaw_occ_shared\.session_token=/);
    assert.match(cookie, /Domain=oce\.example\.test/i);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Lax/i);
    assert.doesNotMatch(cookie, /__Host-occ_native_admin=/);

    const { key } = await issueServiceKeyForNativeAgent(context);
    for (const deniedHeaders of [
      { "x-api-key": key },
      { cookie: context.session.cookie, "x-api-key": key },
    ]) {
      const denied = await injectJson(context.fixture, "GET", "/", {
        headers: {
          host: nativeAuthority({ origin }),
          origin,
          ...deniedHeaders,
        },
      });
      assert.equal(denied.statusCode, 403, denied.body);
      assert.equal(denied.headers["set-cookie"], undefined);
    }
  });
};

export const registerNativeAdminSessionRecoveryCase: RegisterSharedSessionCases = (
  test: typeof nodeTest,
  {
    createNativeAdminFixture,
    nativeStatus,
    injectJson,
    nativeAuthority,
    trustLocalUpstreamCertificate,
  }: SharedSessionDependencies,
): void => {
  test("native browser admission reports a failed session lookup and accepts the same session after recovery", async (t) => {
    const logLines: string[] = [];
    const context = await createNativeAdminFixture(t, {
      logger: createOccLogger({
        component: "native-admin-test",
        level: "info",
        destination: {
          write(chunk: string) {
            logLines.push(...chunk.split("\n").filter(Boolean));
            return true;
          },
        },
      }),
    });
    const origin = availableNativeOrigin(context.fixture, await nativeStatus(context));
    const headers = {
      host: nativeAuthority({ origin }),
      cookie: context.session.cookie,
      accept: "text/html,application/xhtml+xml",
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
      "sec-fetch-user": "?1",
    };
    // Fail the backing session store below Better Auth while leaving the issued session intact.
    const sessions = context.fixture.memoryDatabase.session;
    const previousFilter = Object.getOwnPropertyDescriptor(sessions, "filter");
    Object.defineProperty(sessions, "filter", {
      configurable: true,
      value() {
        throw new Error("Session store unavailable");
      },
    });
    try {
      const page = await injectJson(context.fixture, "GET", "/chat/main", { headers });
      const { error: pageError } = context.fixture.fixtureResponse(
        jsonEnvelope(page),
        503,
        ErrorResponse,
        "reject native navigation during session-store outage",
      );
      assert.equal(pageError.code, "DEPENDENCY_UNAVAILABLE");
      assert.equal(page.headers.location, undefined);
      assert.equal(page.headers["set-cookie"], undefined);
      const completed = logLines
        .map((line): unknown => JSON.parse(line))
        .find(
          (line) =>
            typeof line === "object" &&
            line !== null &&
            "event" in line &&
            line.event === "http.completed" &&
            "requestId" in line &&
            line.requestId === page.headers["x-request-id"],
        );
      assert.ok(Check(CompletedRequest, completed), "expected a correlated HTTP completion log");
      assert.equal(completed.nativeAdmissionReason, "dependency_failure");
      assert.equal(completed.status, 503);
      assert.ok(!JSON.stringify(completed).includes("Session store unavailable"));
      // The Control UI probes this route before offering a browser reconnect on 401 or 403.
      const probe = await injectJson(context.fixture, "GET", "/healthz", {
        headers: {
          host: headers.host,
          cookie: headers.cookie,
          "x-openclaw-reachability-probe": "1",
        },
      });
      const { error: probeError } = context.fixture.fixtureResponse(
        jsonEnvelope(probe),
        503,
        ErrorResponse,
        "reject reachability probe during session-store outage",
      );
      assert.equal(probeError.code, "DEPENDENCY_UNAVAILABLE");
      assert.equal(probe.headers["set-cookie"], undefined);
      assert.equal(context.upstream.requests.length, 0);
    } finally {
      if (previousFilter === undefined) {
        assert.ok(Reflect.deleteProperty(sessions, "filter"));
      } else {
        Object.defineProperty(sessions, "filter", previousFilter);
      }
      assert.deepEqual(Object.getOwnPropertyDescriptor(sessions, "filter"), previousFilter);
    }

    trustLocalUpstreamCertificate(t, context.upstream.cert);
    const recovered = await injectJson(context.fixture, "GET", "/chat/main", { headers });
    assert.equal(recovered.statusCode, 200);
    assert.equal(recovered.headers["x-native-upstream"], "reached");
    assert.equal(context.upstream.requests.length, 1);
  });
};

export const registerNativeAdminSessionOriginCases: RegisterSharedSessionCases = (
  test: typeof nodeTest,
  {
    publicOrigin,
    createNativeAdminFixture,
    nativeStatus,
    injectJson,
    nativeAuthority,
    trustLocalUpstreamCertificate,
    createSiblingAgent,
  }: SharedSessionDependencies,
): void => {
  test("native Agent requests retain their own origin boundary", async (t) => {
    const context = await createNativeAdminFixture(t);
    const origin = availableNativeOrigin(context.fixture, await nativeStatus(context));
    trustLocalUpstreamCertificate(t, context.upstream.cert);
    const response = await injectJson(context.fixture, "POST", "/settings", {
      headers: {
        host: nativeAuthority({ origin }),
        origin,
        cookie: context.session.cookie,
        "sec-fetch-site": "same-origin",
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(context.upstream.requests.length, 1);
  });

  test("session mutations reject sibling origins before changing Agent or audit state", async (t) => {
    const auditSink = new InMemoryAuditSink();
    const context = await createNativeAdminFixture(t, { auditSink });
    const origin = availableNativeOrigin(context.fixture, await nativeStatus(context));
    const agentPath = `/namespaces/${context.namespace.id}/agents/${context.agent.id}`;
    const cookie = context.session.cookie;
    const before = auditSink.events.length;

    // A sibling can submit a bodyless request with the shared cookie without reading it.
    const noCookie = await injectJson(context.fixture, "POST", `${agentPath}/stop`, {
      headers: { origin, "sec-fetch-site": "same-site" },
    });
    assert.equal(noCookie.statusCode, 401);
    const badOrigins: Record<string, string>[] = [
      { origin, "sec-fetch-site": "same-site", "sec-fetch-mode": "no-cors" },
      { origin: "https://other.oce.example.test", "sec-fetch-site": "same-site" },
      {},
      { origin: "null" },
      { origin: `${publicOrigin}/path` },
      { origin: publicOrigin, "sec-fetch-site": "cross-site" },
      { origin: publicOrigin, "sec-fetch-site": "same-site" },
      { origin: publicOrigin, "sec-fetch-site": "invalid" },
    ];
    for (const headers of badOrigins) {
      const response = await injectJson(context.fixture, "POST", `${agentPath}/stop`, {
        headers: { cookie, ...headers },
      });
      assert.equal(response.statusCode, 403, `${JSON.stringify(headers)}: ${response.body}`);
      // The refusal says what is missing instead of a generic admission boundary.
      const { error } = context.fixture.fixtureResponse(
        jsonEnvelope(response),
        403,
        ErrorResponse,
        "reject Agent stop from untrusted browser origin",
      );
      assert.match(error.message, /^A trusted browser origin is required: /);
    }
    // Reads need no Origin to be admitted; the account route then names the same requirement.
    const accountRead = await injectJson(context.fixture, "GET", "/api/auth/accounts/any-account", {
      headers: { cookie },
    });
    const { error: accountError } = context.fixture.fixtureResponse(
      jsonEnvelope(accountRead),
      403,
      ErrorResponse,
      "reject account read without trusted browser origin",
    );
    assert.equal(
      accountError.message,
      "A current human session and trusted browser origin are required.",
    );
    for (const path of [
      `${agentPath}/deploy`,
      "/api/auth/accounts",
      "/api/auth/service-keys",
      `/namespaces/${context.namespace.id}/iam/roles`,
    ]) {
      const response = await injectJson(context.fixture, "POST", path, {
        headers: { cookie, origin, "sec-fetch-site": "same-site" },
      });
      assert.equal(response.statusCode, 403, `${path}: ${response.body}`);
    }
    assert.equal(auditSink.events.length, before);
    const { data: agent } = context.fixture.fixtureResponse(
      await context.fixture.request("GET", agentPath),
      200,
      AgentResponse,
      "read Agent after denied mutations",
    );
    assert.equal(agent.desiredRuntimeState, "running");
    const safeRead = await injectJson(context.fixture, "GET", agentPath, { headers: { cookie } });
    assert.equal(safeRead.statusCode, 200);

    const { key, role } = await issueServiceKeyForNativeAgent(context);
    role.permissions.push({ action: "operate", resourceKind: "agent" });
    const badKey = await injectJson(context.fixture, "POST", `${agentPath}/stop`, {
      headers: { cookie, "x-api-key": "invalid", origin: publicOrigin },
    });
    assert.equal(badKey.statusCode, 401);
    const keyStop = await injectJson(context.fixture, "POST", `${agentPath}/stop`, {
      headers: { "x-api-key": key },
    });
    assert.equal(keyStop.statusCode, 202, keyStop.body);
    // The key's binding names this Agent alone: a second Agent of the Namespace is refused.
    const sibling = await createSiblingAgent(context);
    const { response: siblingStop, denials } = await denialsDuring(auditSink, () =>
      injectJson(
        context.fixture,
        "POST",
        `/namespaces/${context.namespace.id}/agents/${sibling.id}/stop`,
        { headers: { "x-api-key": key } },
      ),
    );
    const { error: siblingError } = context.fixture.fixtureResponse(
      jsonEnvelope(siblingStop),
      403,
      ErrorResponse,
      "reject service key on sibling Agent",
    );
    assert.equal(siblingError.message, callerDenied("Agent operate", `Agent ${sibling.id}`));
    assert.deepEqual(denials, [{ action: "operate", kind: "agent", id: sibling.id }]);
    const deployed = await injectJson(context.fixture, "POST", `${agentPath}/deploy`, {
      headers: { cookie, origin: publicOrigin, "sec-fetch-site": "same-origin" },
    });
    assert.equal(deployed.statusCode, 202, deployed.body);
    const keyFromSibling = await injectJson(context.fixture, "POST", `${agentPath}/stop`, {
      headers: { cookie, "x-api-key": key, origin, "sec-fetch-site": "same-site" },
    });
    assert.equal(keyFromSibling.statusCode, 202, keyFromSibling.body);
    const stopped = await injectJson(context.fixture, "POST", `${agentPath}/stop`, {
      headers: { cookie, origin: publicOrigin },
    });
    assert.equal(stopped.statusCode, 202, stopped.body);
  });

  test("sign-out requires the console origin for session requests", async (t) => {
    const context = await createNativeAdminFixture(t);
    const deniedOrigins: Record<string, string>[] = [
      {},
      { origin: "https://other.oce.example.test" },
      { origin: publicOrigin, "sec-fetch-site": "cross-site" },
    ];
    for (const headers of deniedOrigins) {
      const denied = await injectJson(context.fixture, "POST", "/api/auth/sign-out", {
        headers: { cookie: context.session.cookie, ...headers },
      });
      assert.equal(denied.statusCode, 403, denied.body);
      const session = await injectJson(context.fixture, "GET", "/api/auth/session", {
        headers: { cookie: context.session.cookie },
      });
      const { data } = context.fixture.fixtureResponse(
        jsonEnvelope(session),
        200,
        SessionResponse,
        "read session after denied sign-out",
      );
      assert.equal(data?.authenticated, true);
    }
    const allowed = await injectJson(context.fixture, "POST", "/api/auth/sign-out", {
      headers: {
        cookie: context.session.cookie,
        origin: publicOrigin,
        "sec-fetch-site": "same-origin",
      },
    });
    assert.equal(allowed.statusCode, 200, allowed.body);
    const session = await injectJson(context.fixture, "GET", "/api/auth/session", {
      headers: { cookie: context.session.cookie },
    });
    const { data } = context.fixture.fixtureResponse(
      jsonEnvelope(session),
      200,
      SessionResponse,
      "read session after Console sign-out",
    );
    assert.equal(data, null);
  });
};
