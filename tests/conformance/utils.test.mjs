import assert from "node:assert/strict";
import test from "node:test";
import {
  asRecord,
  cookieHeaderFromSetCookie,
  deepFreeze,
  immutableCopy,
  isNonEmptyString,
  isPositiveSafeInteger,
  numericErrorStatus,
  sha256Hex,
} from "../../packages/utils/src/index.ts";

test("immutableCopy detaches and deeply freezes resource snapshots", () => {
  const original = { identity: { namespaceId: "tenant-a" }, roles: ["reader"] };
  const snapshot = immutableCopy(original);

  original.identity.namespaceId = "tenant-b";
  original.roles.push("writer");

  assert.deepEqual(snapshot, {
    identity: { namespaceId: "tenant-a" },
    roles: ["reader"],
  });
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.identity), true);
  assert.equal(Object.isFrozen(snapshot.roles), true);
  assert.equal(Object.isFrozen(original), false);
});

test("asRecord preserves object identity without accepting null, arrays, or primitives", () => {
  const object = { status: "ready" };
  const withoutPrototype = Object.create(null);
  const date = new Date(0);
  assert.equal(asRecord(object), object);
  assert.equal(asRecord(withoutPrototype), withoutPrototype);
  // This helper is an object guard, not a plain-JSON-object validator.
  assert.equal(asRecord(date), date);
  for (const value of [null, undefined, [], "value", 1, true, () => {}]) {
    assert.equal(asRecord(value), undefined);
  }
});

test("nonempty string checks preserve whitespace policy without coercing values", () => {
  for (const value of ["value", " value ", "0", "日本語"]) {
    assert.equal(isNonEmptyString(value), true);
  }
  for (const value of ["", " \t\n", null, undefined, 0, false, [], {}]) {
    assert.equal(isNonEmptyString(value), false);
  }
});

test("positive safe integers reject coercion, fractional values, and unsafe limits", () => {
  for (const value of [1, 250, Number.MAX_SAFE_INTEGER]) {
    assert.equal(isPositiveSafeInteger(value), true);
  }
  for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, "1", null]) {
    assert.equal(isPositiveSafeInteger(value), false);
  }
});

test("SHA-256 output and resource-name prefixes match fixed digest vectors", () => {
  const digest = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
  assert.equal(sha256Hex("abc"), digest);
  assert.equal(sha256Hex("abc", 12), "ba7816bf8f01");
  assert.equal(sha256Hex("abc", 8), "ba7816bf");
  assert.equal(sha256Hex("abc", 0), "");
  assert.equal(sha256Hex("abc", 100), digest);
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("numeric error status preserves SDK field precedence without interpreting string codes", () => {
  assert.equal(numericErrorStatus({ code: 409, statusCode: 500, response: { status: 503 } }), 409);
  assert.equal(numericErrorStatus({ code: "ECONNRESET", statusCode: 429 }), 429);
  assert.equal(numericErrorStatus({ response: { statusCode: 404, status: 500 } }), 404);
  assert.equal(numericErrorStatus({ response: { status: 503 } }), 503);
  for (const value of [undefined, null, [], "503", { code: "403" }, { response: [] }]) {
    assert.equal(numericErrorStatus(value), undefined);
  }
});

test("Cookie headers retain name-value pairs and discard Set-Cookie attributes", () => {
  assert.equal(cookieHeaderFromSetCookie(undefined), "");
  assert.equal(cookieHeaderFromSetCookie([]), "");
  assert.equal(cookieHeaderFromSetCookie(" a=one=two; Path=/; HttpOnly"), "a=one=two");
  assert.equal(
    cookieHeaderFromSetCookie([
      "a=one; Expires=Wed, 21 Oct 2030 07:28:00 GMT; Path=/",
      "openclaw_occ.session_token=; Max-Age=0; Path=/; HttpOnly",
      "b=two; Secure; SameSite=Strict",
      "  ",
    ]),
    "a=one; b=two",
  );
});

test("deepFreeze freezes nested event data in place and handles cycles", () => {
  const event = { actor: { id: "principal-a" }, details: { values: [1, 2] } };
  event.self = event;
  assert.equal(deepFreeze(event), event);
  assert.equal(Object.isFrozen(event.actor), true);
  assert.equal(Object.isFrozen(event.details.values), true);
  assert.throws(() => {
    event.actor.id = "principal-b";
  }, TypeError);
});
