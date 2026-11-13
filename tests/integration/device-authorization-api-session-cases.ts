import assert from "node:assert/strict";
import { test } from "node:test";

import { ErrorResponse } from "../../packages/contracts/src/api/common.ts";
import {
  AgentDeviceAuthorizationResponse,
  CredentialSourceListResponse,
} from "../../packages/contracts/src/api/resources.ts";
import type { SecretDriver } from "../../packages/contracts/src/drivers/secret/index.ts";
import {
  assertNoCredentials,
  createFixture,
  readyLogin,
  type DeviceAuthFixture,
} from "./device-authorization-api-fixture.ts";

export function registerDeviceAuthorizationSessionCases() {
  test("one poll owns Gateway completion and cancellation fences its result without revoking the source", async (t) => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    t.after(() => release.resolve());
    const fixture = await createFixture(t, {
      beforePoll: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    const login = await fixture.start();
    const sourceId = (await fixture.stored(login)).sourceId;
    await fixture.clock.advance(5000);
    // Hold the first exchange open while a second poll and cancellation run.
    const first = fixture.poll(login);
    await Promise.race([
      entered.promise,
      first.then(() => assert.fail("poll must reach the Gateway")),
    ]);
    const second = await fixture.poll(login);
    const { data: secondPoll } = fixture.fixtureResponse(
      second,
      200,
      AgentDeviceAuthorizationResponse,
      "poll while the first poll owns the exchange",
    );
    assert.equal(secondPoll.status, "pending");
    assert.equal(
      fixture.gateway.calls.filter((call) => call.operation === "pollDeviceAuthorization").length,
      1,
    );
    assert.equal(
      (await fixture.request("DELETE", `${fixture.path}/${login.session.id}`)).status,
      204,
    );
    release.resolve();
    assert.equal((await first).status, 409);
    const stored = await fixture.stored(login);
    assert.equal(stored.phase, "cancelled");
    assert.equal(stored.privateState, undefined);
    assert.equal((await fixture.poll(login)).status, 409);
    assert.equal(
      fixture.gateway.sources.get(sourceId),
      "ready",
      "external completion remains managed after its UI handle is cancelled",
    );
    assert.equal(
      fixture.gateway.calls.some((call) => call.operation === "removeSource"),
      false,
    );
    assert.equal(await firstListedSourceId(fixture), sourceId);
    assertNoCredentials(fixture);
  });

  test("a changed Refresh Driver cannot receive an existing device login handle", async (t) => {
    const fixture = await createFixture(t);
    const login = await fixture.start();
    const original = await fixture.stored(login);
    await fixture.clock.advance(5000);
    // Selecting another owner must fail before forwarding the old owner's opaque handle.
    const replacement = { ...fixture.refresh, id: "replacement-device-refresh" };
    fixture.controller.registerDriver(replacement);
    fixture.controller.selectDriver("credential_refresh", replacement.id);
    const before = [...fixture.gateway.calls];

    const refused = await fixture.poll(login);
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.deepEqual(fixture.gateway.calls, before, "owner mismatch must precede external calls");
    const stored = await fixture.stored(login);
    assert.equal(stored.version, 2);
    assert.equal(stored.credentialGatewayId, fixture.gateway.id);
    assert.equal(stored.credentialRefreshId, fixture.refresh.id);
    assert.equal(stored.sourceId, original.sourceId);
    assert.equal(stored.phase, "pending");
    assert.equal(stored.privateState, original.privateState);
    assert.equal(await firstListedSourceId(fixture), original.sourceId);
    assertNoCredentials(fixture);
  });

  test("a Refresh Driver change during polling fences completion without replaying the exchange", async (t) => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    t.after(() => release.resolve());
    const fixture = await createFixture(t, {
      beforePoll: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    const login = await fixture.start();
    const original = await fixture.stored(login);
    await fixture.clock.advance(5000);
    const pending = fixture.poll(login);
    await Promise.race([
      entered.promise,
      pending.then(() => assert.fail("poll must reach the original Refresh Driver")),
    ]);
    // The original owner can finish externally, but a changed selection cannot authorize
    // committing that result to the login session. The separately managed source survives.
    const replacement = { ...fixture.refresh, id: "replacement-device-refresh" };
    fixture.controller.registerDriver(replacement);
    fixture.controller.selectDriver("credential_refresh", replacement.id);
    release.resolve();
    const refused = await pending;
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    const stored = await fixture.stored(login);
    assert.equal(stored.version, 2);
    assert.equal(stored.credentialGatewayId, fixture.gateway.id);
    assert.equal(stored.credentialRefreshId, fixture.refresh.id);
    assert.equal(stored.sourceId, original.sourceId);
    assert.equal(
      stored.phase,
      "polling",
      "an externally completed grant cannot mark this session ready",
    );
    assert.equal(fixture.gateway.sources.get(original.sourceId), "ready");
    assert.equal(await firstListedSourceId(fixture), original.sourceId);
    assert.equal(
      fixture.gateway.calls.some(
        ({ operation }) => operation === "removeRefresh" || operation === "removeSource",
      ),
      false,
    );

    // Restoring the original selection still must not re-enter a consumed exchange.
    fixture.controller.selectDriver("credential_refresh", fixture.refresh.id);
    const repeated = await fixture.poll(login);
    const { data: repeatedPoll } = fixture.fixtureResponse(
      repeated,
      200,
      AgentDeviceAuthorizationResponse,
      "poll after restoring the original Refresh Driver",
    );
    assert.equal(repeatedPoll.status, "pending");
    assert.equal(repeatedPoll.source, undefined);
    assert.equal(
      fixture.gateway.calls.filter(({ operation }) => operation === "pollDeviceAuthorization")
        .length,
      1,
    );
    assertNoCredentials(fixture);
  });

  test("expiry closes the login handle without removing the ready source or its discovery", async (t) => {
    const fixture = await createFixture(t);
    const login = await readyLogin(fixture);
    await fixture.clock.advance(24 * 60 * 60 * 1000);
    assert.equal((await fixture.poll(login)).status, 409);
    const stored = await fixture.stored(login);
    assert.equal(stored.phase, "cancelled");
    assert.equal(stored.privateState, undefined);
    const discovery = await fixture.request("POST", fixture.pluginsPath, {
      body: { harnessId: "codex", credentialSource: login.source, q: "knowledge" },
    });
    assert.equal(discovery.status, 200, JSON.stringify(discovery.body));
    // Explicit source deletion, unlike session closure, invokes external removal.
    assert.equal(
      (await fixture.request("DELETE", `${fixture.sourcesPath}/${login.source.id}`)).status,
      204,
    );
    assert.equal(fixture.gateway.sources.has(login.source.id), false);
    assert.equal(
      (
        await fixture.request("POST", fixture.pluginsPath, {
          body: { harnessId: "codex", credentialSource: login.source, q: "knowledge" },
        })
      ).status,
      409,
    );
    assertNoCredentials(fixture);
  });

  test("missing login-session fencing refuses device authorization before Gateway I/O", async (t) => {
    const fixture = await createFixture(t);
    const login = await fixture.start();
    const before = fixture.gateway.calls.length;
    // Remove the optional capability after start so both new and existing logins fail closed.
    const secretDriver: SecretDriver = fixture.secretDriver;
    delete secretDriver.compareAndSwap;
    assert.equal(
      (await fixture.request("POST", fixture.path, { body: { harnessId: "codex" } })).status,
      501,
    );
    await fixture.clock.advance(5000);
    const poll = await fixture.poll(login);
    const { error } = fixture.fixtureResponse(poll, 501, ErrorResponse, "poll without fencing");
    assert.equal(error.message, "Device authorization is unavailable for the Secret Driver.");
    assert.equal(fixture.gateway.calls.length, before);
  });
}

async function firstListedSourceId(fixture: DeviceAuthFixture) {
  const response = await fixture.request("GET", fixture.sourcesPath);
  const { data } = fixture.fixtureResponse(
    response,
    200,
    CredentialSourceListResponse,
    "list sources",
  );
  const first = data[0];
  assert.ok(first, "the credential source must remain listed");
  return first.id;
}
