import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";

import { createOccLogger } from "../../apps/controller/src/logging.ts";
import { MANAGED_BY, MANAGED_BY_LABEL } from "../../apps/controller/src/backends/openshell.ts";
import {
  AgentDeviceAuthorizationResponse,
  CredentialSourceListResponse,
  ErrorResponse,
} from "../../packages/contracts/src/index.ts";
import {
  DEVICE_OAUTH_ACCESS_TOKEN,
  DEVICE_OAUTH_REFRESH_TOKEN,
} from "../helpers/device-credential-service.ts";
import { jsonLineDestination, requireLogRecord } from "../helpers/json-lines.ts";
import {
  readProviderRequestBody,
  startProviderServer,
} from "../helpers/provider-http-transport.ts";
import {
  assertNoCredentials,
  createFixture,
  readyLogin,
  type DeviceAuthFixture,
} from "./device-authorization-api-fixture.ts";

const issuerPaths = [
  "/api/accounts/deviceauth/usercode",
  "/api/accounts/deviceauth/token",
  "/oauth/token",
] as const;

function useLoopbackIssuer(t: TestContext, port: number) {
  const fetchThroughFixture = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === "https://auth.openai.com") {
      assert.ok(issuerPaths.includes(url.pathname as (typeof issuerPaths)[number]));
      return fetchThroughFixture(new URL(url.pathname, `http://127.0.0.1:${port}`), init);
    }
    return fetchThroughFixture(input, init);
  });
}

function loginReply(
  fixture: DeviceAuthFixture,
  reply: Awaited<ReturnType<DeviceAuthFixture["poll"]>>,
) {
  return fixture.fixtureResponse(reply, 200, AgentDeviceAuthorizationResponse, "poll device login")
    .data;
}

test("Codex pre-code poll failures retain one temporary login and enforce its interval", async (t) => {
  const fixture = await createFixture(t);
  let pollCount = 0;
  let exchanges = 0;
  // Route only the fixed issuer to loopback so HTTP status and connection loss reach the real Driver.
  const issuer = await startProviderServer(t, async (request, response) => {
    const body = await readProviderRequestBody(request);
    response.setHeader("content-type", "application/json");
    if (request.url === issuerPaths[0]) {
      assert.equal(typeof JSON.parse(body).client_id, "string");
      response.end(
        JSON.stringify({ device_auth_id: randomUUID(), user_code: "CODE-12345", interval: 5 }),
      );
      return;
    }
    if (request.url === issuerPaths[1]) {
      pollCount += 1;
      if (pollCount === 1 || pollCount === 2) {
        response.writeHead(pollCount === 1 ? 429 : 503).end();
      } else if (pollCount === 3) {
        request.socket.destroy();
      } else {
        response.end(
          JSON.stringify({ authorization_code: randomUUID(), code_verifier: randomUUID() }),
        );
      }
      return;
    }
    assert.equal(request.url, issuerPaths[2]);
    assert.equal(new URLSearchParams(body).get("grant_type"), "authorization_code");
    exchanges += 1;
    response.end(
      JSON.stringify({
        access_token: DEVICE_OAUTH_ACCESS_TOKEN,
        id_token: DEVICE_OAUTH_ACCESS_TOKEN,
        refresh_token: DEVICE_OAUTH_REFRESH_TOKEN,
      }),
    );
  });
  useLoopbackIssuer(t, issuer.port);
  const login = await fixture.start();
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await fixture.clock.advance(5000);
    const pending = loginReply(fixture, await fixture.poll(login));
    assert.equal(pending.status, "pending");
    assert.equal(pending.session.id, login.session.id);
    assert.equal(pollCount, attempt);
    assert.equal(exchanges, 0, "a pre-code failure must not redeem an authorization code");
    assert.equal(loginReply(fixture, await fixture.poll(login)).status, "pending");
    assert.equal(pollCount, attempt, "an immediate repeat cannot bypass the poll interval");
  }
  const beforeGrant = fixture.fixtureResponse(
    await fixture.request("GET", fixture.sourcesPath),
    200,
    CredentialSourceListResponse,
    "list pending login Sources",
  ).data;
  assert.deepEqual(beforeGrant, [], "temporary login state is not a durable Source");
  await fixture.clock.advance(5000);
  const ready = loginReply(fixture, await fixture.poll(login));
  assert.equal(ready.status, "ready");
  assert.ok(ready.source);
  assert.equal(exchanges, 1);
  assert.equal(loginReply(fixture, await fixture.poll(login)).status, "ready");
  assert.equal(exchanges, 1, "an already completed login must not exchange the grant again");
  assertNoCredentials(fixture);
});

test("Codex start failures classify the CredentialService boundary without exposing issuer diagnostics", async (t) => {
  const logs: unknown[] = [];
  const fixture = await createFixture(t, {
    logger: createOccLogger({
      component: "occ-api",
      level: "info",
      destination: jsonLineDestination(logs),
    }),
  });
  const privateDetail = randomUUID();
  let refuseConnection = true;
  const issuer = await startProviderServer(t, (request, response) => {
    request.resume();
    if (refuseConnection) {
      request.socket.destroy();
      return;
    }
    response
      .writeHead(503, { "content-type": "application/json" })
      .end(JSON.stringify({ error: privateDetail }));
  });
  useLoopbackIssuer(t, issuer.port);
  for (const reason of ["unreachable", "unavailable"] as const) {
    const reply = await fixture.request("POST", fixture.path, { body: { harnessId: "codex" } });
    const failure = fixture.fixtureResponse(reply, 503, ErrorResponse, "start Codex login");
    assert.equal(failure.error.code, "DEPENDENCY_UNAVAILABLE");
    const warning = logs
      .map(requireLogRecord)
      .findLast(
        (entry) =>
          entry.event === "device_authorization.start_failed" &&
          entry.requestId === failure.meta.requestId,
      );
    assert.ok(warning);
    assert.equal(warning.boundary, "credential_service");
    assert.equal(warning.reason, reason);
    if (reason === "unavailable") {
      assert.equal(warning.failure, "HTTP_503");
    }
    assert.equal(JSON.stringify([reply.body, logs]).includes(privateDetail), false);
    refuseConnection = false;
  }
});

test("deleting a completed Codex Source retires native delivery before erasing CredentialService custody", async (t) => {
  const calls: string[] = [];
  let unavailable = true;
  let namespaceId = "";
  const fixture = await createFixture(t, {
    native: true,
    gatewayClient: {
      async getWorkspace(name) {
        return {
          name,
          id: "workspace-fixture",
          labels: { [MANAGED_BY_LABEL]: MANAGED_BY, "openclaw.dev/namespace-id": namespaceId },
        };
      },
      async getProvider() {
        return undefined;
      },
      async getProviderProfile() {
        return undefined;
      },
      async listProviders() {
        calls.push("providers");
        if (unavailable) {
          throw new Error("controlled Gateway outage");
        }
        return [];
      },
      async listProviderProfiles() {
        calls.push("profiles");
        return [];
      },
    },
  });
  namespaceId = fixture.namespace.id;
  const login = await readyLogin(fixture);
  const custody = await fixture.state.read((view) =>
    view.oauthCredentials.findTokenCustody(fixture.namespace.id, login.source.id),
  );
  assert.ok(custody);
  const path = `${fixture.sourcesPath}/${login.source.id}`;
  assert.equal((await fixture.request("PATCH", path, { body: { config: {} } })).status, 409);
  assert.equal(calls.length, 0, "an OAuth Source cannot be changed through the static update API");
  // Failed native retirement must preserve custody; a normal retry can finish after Gateway recovery.
  assert.equal((await fixture.request("DELETE", path)).status, 503);
  assert.ok(
    await fixture.state.read((view) =>
      view.oauthCredentials.findTokenCustody(fixture.namespace.id, login.source.id),
    ),
    "failed delivery retirement retains refresh custody for the normal retry",
  );
  assert.equal(
    await fixture.secretDriver.privateSecrets.withValue(custody.secret, async () => true),
    true,
  );
  unavailable = false;
  const retry = await fixture.request("DELETE", path);
  assert.equal(retry.status, 204, JSON.stringify({ body: retry.body, calls }));
  assert.equal((await fixture.request("GET", path)).status, 404);
  assert.equal(
    await fixture.state.read((view) =>
      view.oauthCredentials.findTokenCustody(fixture.namespace.id, login.source.id),
    ),
    undefined,
  );
  await assert.rejects(
    fixture.secretDriver.privateSecrets.withValue(custody.secret, async () => true),
    { message: /Secret does not exist\./u },
  );
  assert.ok(calls.includes("providers") && calls.includes("profiles"));
});
