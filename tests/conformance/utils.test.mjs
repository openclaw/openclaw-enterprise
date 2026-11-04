import assert from "node:assert/strict";
import test from "node:test";
import {
  asRecord,
  cookieHeaderFromSetCookie,
  deepFreeze,
  freezeSnapshot,
  hasControlCharacter,
  immutableCopy,
  immutableSnapshot,
  isImmutableSnapshot,
  isNonEmptyString,
  isPositiveSafeInteger,
  MAX_TIMER_DELAY_MS,
  numericErrorStatus,
  numericLastLabel,
  sha256Hex,
} from "../../packages/utils/src/index.ts";
import { hasControlCharacter as clientHasControlCharacter } from "../../apps/controller/src/drivers/repo/credentials/client-contracts.ts";
import { MAX_TIMER_DELAY_MS as clockMaxTimerDelayMs } from "../../apps/controller/src/drivers/repo/credentials/clock.ts";

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

test("freezeSnapshot freezes a new value in place and records it like immutableSnapshot", () => {
  const permissions = Object.freeze([Object.freeze({ action: "read", resourceKind: "agent" })]);
  const state = { roles: [{ id: "role-a", permissions }], groups: [{ id: "group-a" }] };
  const snapshot = freezeSnapshot(state);

  // No copy: the snapshot is the value, and its already frozen parts stay shared.
  assert.equal(snapshot, state);
  assert.equal(snapshot.roles[0].permissions, permissions);
  assert.equal(isImmutableSnapshot(snapshot), true);
  for (const part of [
    snapshot,
    snapshot.roles,
    snapshot.roles[0],
    snapshot.roles[0].permissions[0],
    snapshot.groups[0],
  ]) {
    assert.equal(Object.isFrozen(part), true);
  }
  assert.throws(() => {
    state.groups[0].id = "group-b";
  }, TypeError);

  // immutableSnapshot copies first; a plain or merely frozen object is not a snapshot.
  const copied = { roles: [] };
  assert.notEqual(immutableSnapshot(copied), copied);
  assert.equal(isImmutableSnapshot(copied), false);
  assert.equal(isImmutableSnapshot(deepFreeze({ roles: [] })), false);
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

test("the timer bound is the longest delay Node.js honours, and the clock copy agrees", () => {
  assert.equal(MAX_TIMER_DELAY_MS, 2 ** 31 - 1);
  // The repository-credentials clock keeps a reviewed-boundary copy.
  assert.equal(clockMaxTimerDelayMs, MAX_TIMER_DELAY_MS);
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

test("numeric error status reads only HTTP statuses, not DOMException or gRPC codes", () => {
  // A DOMException keeps its legacy code (TIMEOUT_ERR 23, ABORT_ERR 20) and a grpc-js error its
  // status (PERMISSION_DENIED 7, UNAUTHENTICATED 16) in `code`. Read as HTTP statuses, they named
  // "HTTP status 7" in Namespace failure reasons (finding 1390).
  for (const value of [
    new DOMException("timed out", "TimeoutError"),
    new DOMException("aborted", "AbortError"),
    Object.assign(new Error("7 PERMISSION_DENIED: workspace:create"), { code: 7 }),
    Object.assign(new Error("16 UNAUTHENTICATED: bad token"), { code: 16 }),
    { code: 0 },
    { code: 99 },
    { code: 600 },
    { code: 403.5 },
  ]) {
    assert.equal(numericErrorStatus(value), undefined);
  }
  // A non-HTTP number in `code` does not hide a real status in a later field.
  assert.equal(numericErrorStatus({ code: 14, statusCode: 503 }), 503);
  assert.equal(numericErrorStatus({ code: 100 }), 100);
  assert.equal(numericErrorStatus({ code: 599 }), 599);
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

// The isolated repository-credentials runtimes never load a workspace package (their build
// closures reject bare specifiers), so client-contracts keeps its own copy of this check.
// Both copies must flag exactly the same characters.
for (const [owner, check] of [
  ["@openclaw-enterprise/utils", hasControlCharacter],
  ["repository-credentials client-contracts", clientHasControlCharacter],
]) {
  test(`${owner} hasControlCharacter flags exactly C0 controls and DEL`, () => {
    for (let code = 0; code <= 0xffff; code += 1) {
      const character = String.fromCharCode(code);
      const expected = code <= 0x1f || code === 0x7f;
      const label = `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
      assert.equal(check(`a${character}b`), expected, label);
      if (expected) {
        assert.equal(check(`${character}ab`), true, `${label} first`);
        assert.equal(check(`ab${character}`), true, `${label} last`);
      }
    }
    // Every UTF-16 code unit is covered above, including C1 controls (U+0080-U+009F), the
    // line and paragraph separators (U+2028, U+2029) and lone surrogates; astral characters
    // and the empty string pass too. Callers that must refuse more add their own rules.
    assert.equal(check("\u{1f600}\u{e0001}"), false);
    assert.equal(check(""), false);
  });
}

test("numericLastLabel follows the URL parser's ends-in-a-number rule", () => {
  for (const host of [
    "0xa000005",
    "0xa.0.0.5",
    "10.0x0.0.5",
    "0x7f.0x1",
    "0X7F.0X1",
    "example.123",
    "example.123.",
    // A one-label host keeps the rule: only the trailing dot is dropped.
    "0x7f.",
    "5.",
    "example.0x",
    "127.0.0.1",
  ]) {
    assert.equal(numericLastLabel(host), true, host);
    // The WHATWG URL parser agrees: the host is an IPv4 address or the URL is invalid.
    assert.equal(
      !URL.canParse(`https://${host}/`) || /^[0-9.]+$/.test(new URL(`https://${host}/`).hostname),
      true,
      host,
    );
  }
  for (const host of [
    "api.example.com",
    "a1.example.com",
    "0xdead.example.com",
    "123.example.com",
    "example.0xg",
    "example.1a",
    "example.a1",
    // Only one trailing dot is dropped: the last label here is empty, as the URL parser reads it.
    "example.123..",
    "",
  ]) {
    assert.equal(numericLastLabel(host), false, host);
  }
});
