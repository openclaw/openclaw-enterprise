import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createFixture,
  assertNoCredentials,
  readyLogin,
} from "./device-authorization-api-fixture.ts";
import { installDeviceTokenService } from "../helpers/device-token-service.ts";

export function registerDeviceAuthorizationSessionCases(): void {
  test("cancelling or expiring a pending device login closes temporary state without creating a Source", async (t) => {
    const fixture = await createFixture(t, { approve: async () => false });
    const cancelled = await fixture.start();
    assert.match(cancelled.session.id, /^das_/);
    assert.equal(
      (await fixture.request("DELETE", `${fixture.path}/${cancelled.session.id}`)).status,
      204,
    );
    assert.equal((await fixture.stored(cancelled)).phase, "cancelled");
    assert.equal((await fixture.poll(cancelled)).status, 409);
    const expiring = await fixture.start();
    await fixture.clock.advance(Date.parse(expiring.expiresAt) - fixture.clock.wallNow() + 1);
    assert.equal((await fixture.poll(expiring)).status, 409);
    assert.equal((await fixture.stored(expiring)).phase, "cancelled");
    const sources = await fixture.controller.transact((unit) =>
      unit.credentialSources.listCredentialSources(fixture.namespace.id),
    );
    assert.deepEqual(sources, []);
    assert.deepEqual(fixture.issuer.operations, ["start", "start"]);
    assertNoCredentials(fixture);
  });

  test("a changed TokenService instance cannot receive an existing device login handle", async (t) => {
    const fixture = await createFixture(t);
    const login = await fixture.start();
    const stored = await fixture.stored(login);
    assert.equal(stored.tokenServiceInstanceId, fixture.instanceId);
    await installDeviceTokenService(
      fixture.controller,
      fixture.state,
      fixture.secretDriver,
      "replacement-device-token-service",
    );
    await fixture.clock.advance(5000);
    assert.equal((await fixture.poll(login)).status, 503);
    assert.deepEqual(fixture.issuer.operations, ["start"]);
    assertNoCredentials(fixture);
  });

  test("expiring a completed login does not remove its authorized Source", async (t) => {
    const fixture = await createFixture(t);
    const login = await readyLogin(fixture);
    await fixture.clock.advance(Date.parse(login.expiresAt) - fixture.clock.wallNow() + 1);
    assert.equal((await fixture.poll(login)).status, 409);
    assert.equal((await fixture.stored(login)).sourceId, undefined);
    assert.equal(
      (await fixture.request("GET", `${fixture.sourcesPath}/${login.source.id}`)).status,
      200,
    );
    assertNoCredentials(fixture);
  });
}
