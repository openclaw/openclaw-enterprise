import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { Static } from "typebox";

import { CodexPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import type { OccLogger } from "../../apps/controller/src/logging.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { AgentDeviceAuthorizationResponse } from "../../packages/contracts/src/api/resources.ts";
import type {
  CredentialGatewayDriver,
  CredentialRefreshDriver,
} from "../../packages/contracts/src/index.ts";
import { OpenClawController } from "../../packages/occ/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { createControlledClock } from "../fixtures/repository-credentials/clock.mjs";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import {
  createDeviceCredentialDrivers,
  DEVICE_ACCESS_TOKEN,
  DEVICE_ACCOUNT_ID,
} from "../helpers/device-credential-gateway.mjs";
import { DEDICATED_OPENCLAW_SUPPORT } from "../helpers/sandbox-driver.ts";
import { createTestSecretDriver } from "../helpers/secret-driver.ts";

type ConsoleFixture = Awaited<ReturnType<typeof createConsoleAppFixture>>;
type RequestArguments = Parameters<ConsoleFixture["request"]>;
type Session = NonNullable<RequestArguments[2]>["session"];
type ApiResponse = Omit<Awaited<ReturnType<ConsoleFixture["request"]>>, "body" | "data"> & {
  body: unknown;
  data: unknown;
};

interface FixtureOptions {
  logger?: OccLogger;
  auditSink?: InMemoryAuditSink;
  approve?: () => Promise<boolean>;
  beforePoll?: () => Promise<void>;
  startError?: unknown;
}

type DeviceGateway = CredentialGatewayDriver & {
  calls: readonly { operation: string; sourceId: string }[];
  sources: ReadonlyMap<string, "pending" | "ready">;
};

export type DeviceLogin = Static<typeof AgentDeviceAuthorizationResponse>["data"];
export type DeviceAuthFixture = Awaited<ReturnType<typeof createFixture>>;

export const devicePluginId = "remote-fixture";

const plugin = {
  id: devicePluginId,
  name: "fixture",
  scope: "GLOBAL",
  status: "ENABLED",
  installation_policy: "AVAILABLE",
  release: {
    display_name: "Fixture",
    description: "Search shared knowledge.",
    interface: {},
    requires_local_executor: false,
    app_ids: ["fixture-app"],
    app_manifest: null,
    skills: [],
    mcp_servers: [],
  },
};

export async function createFixture(
  t: TestContext,
  { logger, auditSink = new InMemoryAuditSink(), ...gatewayOptions }: FixtureOptions = {},
) {
  const clock = createControlledClock();
  const secretDriver = createTestSecretDriver();
  const drivers = createDeviceCredentialDrivers({
    now: () => clock.wallNow(),
    ...gatewayOptions,
  });
  const gateway = drivers.gateway satisfies DeviceGateway;
  const refresh = drivers.refresh satisfies CredentialRefreshDriver;
  const fixture = await createConsoleAppFixture(t, {
    auditSink,
    secretDriver,
    credentialGatewayDriver: gateway,
    logger,
    now: () => new Date(clock.wallNow()),
    // The existing Console fixture admits revisions without executing Compute.
    // Selecting a Sandbox satisfies source admission.
    sandboxDriver: deviceTestSandbox(),
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Device login", { ready: true });
  const controller: unknown = fixture.controller;
  assert.ok(controller instanceof OpenClawController, "bootstrap must create a controller");
  controller.registerDriver(gateway);
  controller.selectDriver("credential_gateway", gateway.id);
  controller.registerDriver(refresh);
  controller.selectDriver("credential_refresh", refresh.id);
  const driver = new CodexPluginDriver();
  controller.registerDriver(driver);
  controller.selectDriver("plugin", driver.id);
  const originalFetch = globalThis.fetch;
  // Only the external Gateway service and catalog HTTP are simulated. Fastify,
  // authentication, IAM, OCC, source storage, and the hosted Plugin Driver are real.
  t.mock.method(
    globalThis,
    "fetch",
    async (input: Parameters<typeof fetch>[0], options?: RequestInit) => {
      const address = new URL(input instanceof Request ? input.url : input);
      if (address.hostname === "127.0.0.1") {
        return originalFetch(input, options);
      }
      assert.equal(
        address.origin,
        "https://chatgpt.com",
        "OCC must not exchange or refresh OAuth tokens",
      );
      const headers = asRecord(options?.headers);
      assert.ok(headers, "the catalog request must carry authentication headers");
      assert.equal(headers.Authorization, `Bearer ${DEVICE_ACCESS_TOKEN}`);
      assert.equal(headers["ChatGPT-Account-ID"], DEVICE_ACCOUNT_ID);
      assert.equal(headers["OAI-Product-Sku"], "codex");
      if (address.pathname === "/backend-api/ps/plugins/search") {
        assert.equal(address.searchParams.get("q"), "knowledge");
        return Response.json({ plugins: [plugin], pagination: { next_page_token: null } });
      }
      if (address.pathname === `/backend-api/ps/plugins/${devicePluginId}`) {
        return Response.json(plugin);
      }
      assert.equal(address.pathname, "/backend-api/ps/apps/batch");
      return Response.json({
        apps: [
          {
            id: "fixture-app",
            status: "ENABLED",
            tools: [{ name: "search", is_enabled: true, is_read_only: true }],
          },
        ],
      });
    },
  );
  const responses: unknown[] = [];
  const request = async (...args: RequestArguments): Promise<ApiResponse> => {
    const response = await fixture.request(...args);
    responses.push(response.body);
    return response;
  };
  const path = `/namespaces/${namespace.id}/agents/device-authorizations`;
  return {
    ...fixture,
    controller,
    request,
    namespace,
    secretDriver,
    gateway,
    refresh,
    auditSink,
    responses,
    clock,
    path,
    pluginsPath: `/namespaces/${namespace.id}/agents/plugins`,
    sourcesPath: `/namespaces/${namespace.id}/credential-sources`,
    async start(loginPath = path, session?: Session) {
      const response = await request("POST", loginPath, {
        body: { harnessId: "codex" },
        ...(session === undefined ? {} : { session }),
      });
      const { data } = fixture.fixtureResponse(
        response,
        200,
        AgentDeviceAuthorizationResponse,
        "start device authorization",
      );
      assert.equal(data.status, "pending");
      assert.equal(data.source, undefined, "a pending login cannot be bound to an Agent");
      return data;
    },
    async poll(login: Pick<DeviceLogin, "session">, loginPath = path, session?: Session) {
      return request("POST", `${loginPath}/${login.session.id}/poll`, {
        body: {},
        ...(session === undefined ? {} : { session }),
      });
    },
    async stored(
      login: Pick<DeviceLogin, "session">,
    ): Promise<Record<string, unknown> & { sourceId: string }> {
      const secret = await controller.transact((unit) =>
        unit.secrets.findSecret(namespace.id, login.session.id),
      );
      assert.ok(secret, "the login session must have a Secret");
      const value = secretDriver.valueFor(secret);
      assert.ok(value, "the login Secret must have a stored value");
      const stored = asRecord(JSON.parse(value));
      assert.ok(
        stored && typeof stored.sourceId === "string",
        "the session must identify its source",
      );
      return { ...stored, sourceId: stored.sourceId };
    },
  };
}

// Admits dedicated Agents without executing Compute.
export function deviceTestSandbox() {
  return {
    id: "device-test-sandbox",
    capability: "sandbox" as const,
    implementation: "test-admission-only",
    supportsHarnessExecutionMode: DEDICATED_OPENCLAW_SUPPORT,
    facets: ["networking", "filesystem", "process"],
    async cleanup() {},
  };
}

export function assertNoCredentials(fixture: DeviceAuthFixture) {
  assert.equal(JSON.stringify(fixture.auditSink.events).includes("CODE-12345"), false);
  const publicOutput = JSON.stringify([fixture.responses, fixture.auditSink.events]);
  for (const value of [DEVICE_ACCESS_TOKEN, "device-private-handle-"]) {
    assert.equal(
      publicOutput.includes(value),
      false,
      "HTTP responses and audit must not expose private credential material",
    );
  }
}

export function assertDeviceAudit(
  fixture: DeviceAuthFixture,
  operation: "start" | "poll" | "cancel",
  agentId?: string,
) {
  const events = fixture.auditSink.events.filter(
    (event) => event.action === `openclaw.agents.device_authorization.${operation}`,
  );
  const event = events.at(-1);
  assert.ok(event, `device authorization ${operation} must be audited`);
  assert.equal(event.kind, "mutation");
  assert.equal(event.outcome, "success");
  assert.ok(event.authorization, "device authorization audit must identify the grant");
  assert.equal(event.authorization.action, agentId === undefined ? "create" : "update");
  assert.deepEqual(event.authorization.resource, {
    kind: "agent",
    id: agentId ?? fixture.namespace.id,
    namespaceId: fixture.namespace.id,
  });
}

export async function readyLogin(fixture: DeviceAuthFixture, path?: string) {
  const login = await fixture.start(path);
  await fixture.clock.advance(5000);
  const response = await fixture.poll(login, path);
  const { data } = fixture.fixtureResponse(
    response,
    200,
    AgentDeviceAuthorizationResponse,
    "poll device authorization",
  );
  assert.equal(data.status, "ready");
  assert.ok(data.source, "a ready login must identify its credential source");
  return { ...data, source: data.source };
}
