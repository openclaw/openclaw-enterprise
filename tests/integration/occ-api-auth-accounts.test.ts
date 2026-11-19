import assert from "node:assert/strict";
import test from "node:test";
import { signInWithEmailPassword } from "../helpers/auth-session.mjs";
import { registerAuthAccountCases } from "./occ-api-auth-account-cases.ts";
import {
  configuredController,
  SessionResponse,
  type JsonValue,
} from "./occ-api-auth-account-fixture.ts";
import { checkedInjectedBody, injectedRequest } from "./occ-api-injected-fixture.ts";

test("session inspection stays optional and never exposes session or credential secrets", async () => {
  const { fixture } = await configuredController();

  const anonymous = await injectedRequest(fixture.app, "GET", "/api/auth/session", {
    identity: false,
  });
  assert.equal(checkedInjectedBody(anonymous, 200, SessionResponse).data, null);

  const authenticated = await injectedRequest(fixture.app, "GET", "/api/auth/session");
  const authenticatedData = checkedInjectedBody(authenticated, 200, SessionResponse).data;
  assert.ok(authenticatedData);
  // Match secret-bearing field names at every depth, not serialized values: the
  // generated user ID and random sessionKey can spell "token" by chance (finding 725).
  const fieldNames: string[] = [];
  const collectFieldNames = (value: JsonValue): void => {
    if (value === null || typeof value !== "object") {
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      fieldNames.push(key);
      collectFieldNames(child);
    }
  };
  collectFieldNames(authenticatedData);
  assert.deepEqual(
    fieldNames.filter((name) => /token|password|credential/i.test(name)),
    [],
  );
  // Known secret values must not appear anywhere, under any field name.
  const exposed = JSON.stringify(authenticatedData);
  assert.ok(fixture.app.defaultSession);
  assert.equal(exposed.includes(fixture.app.defaultSession.cookie), false);
  for (const pair of fixture.app.defaultSession.cookie.split(";")) {
    const value = pair.slice(pair.indexOf("=") + 1).trim();
    assert.ok(value.length > 0);
    assert.equal(exposed.includes(value), false);
    const decoded = decodeURIComponent(value);
    assert.equal(exposed.includes(decoded), false);
    // A signed cookie value is "<token>.<signature>"; the bare token is a secret too.
    const signature = decoded.lastIndexOf(".");
    if (signature > 0) {
      assert.equal(exposed.includes(decoded.slice(0, signature)), false);
    }
  }
  assert.equal(exposed.includes(fixture.authFixture.password), false);
  assert.match(authenticatedData.sessionKey, /^[A-Za-z0-9_-]+$/);

  const repeated = await injectedRequest(fixture.app, "GET", "/api/auth/session");
  const repeatedData = checkedInjectedBody(repeated, 200, SessionResponse).data;
  assert.ok(repeatedData);
  assert.equal(repeatedData.sessionKey, authenticatedData.sessionKey);
  assert.deepEqual(repeatedData.user, authenticatedData.user);

  const nextSession = await signInWithEmailPassword({
    fetch: fixture.app.fetch.bind(fixture.app),
    email: fixture.authFixture.email,
    password: fixture.authFixture.password,
  });
  const nextAuthenticated = await injectedRequest(fixture.app, "GET", "/api/auth/session", {
    session: nextSession,
  });
  const nextData = checkedInjectedBody(nextAuthenticated, 200, SessionResponse).data;
  assert.ok(nextData);
  assert.notEqual(nextData.sessionKey, authenticatedData.sessionKey);
  assert.deepEqual(nextData.user, authenticatedData.user);
});

registerAuthAccountCases();
