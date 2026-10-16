import assert from "node:assert/strict";
import test from "node:test";
import { carryDocument } from "../../apps/controller/src/console/carry.mjs";

const ref = (id) => ({ source: "env", provider: "default", id });

test("a carried object whose keys each browser changed separately is named for review", () => {
  // The reader switched auth to a password; another browser added a token to the token mode.
  const merged = carryDocument(
    { gateway: { auth: { mode: "token" } } },
    { gateway: { auth: { mode: "password", password: ref("GATEWAY_PASSWORD") } } },
    { gateway: { auth: { mode: "token", token: ref("GATEWAY_TOKEN") } } },
  );
  assert.deepEqual(merged.value, {
    gateway: {
      auth: { mode: "password", token: ref("GATEWAY_TOKEN"), password: ref("GATEWAY_PASSWORD") },
    },
  });
  assert.deepEqual(merged.conflicts, []);
  assert.deepEqual(merged.mixed, ["/gateway/auth"]);
});

test("a key both browsers changed differently is a conflict and also mixes its object", () => {
  const merged = carryDocument(
    { auth: { mode: "token" } },
    { auth: { mode: "password" } },
    { auth: { mode: "none", token: ref("GATEWAY_TOKEN") } },
  );
  assert.deepEqual(merged.value, { auth: { mode: "password", token: ref("GATEWAY_TOKEN") } });
  assert.deepEqual(merged.conflicts, [{ path: "/auth/mode", saved: "none" }]);
  assert.deepEqual(merged.mixed, ["/auth"]);
});

test("only the object holding the separate changes is named, not its parents", () => {
  const merged = carryDocument(
    { a: { b: { x: 1, y: 1 } } },
    { a: { b: { x: 2, y: 1 } } },
    { a: { b: { x: 1, y: 3 } } },
  );
  assert.deepEqual(merged.value, { a: { b: { x: 2, y: 3 } } });
  assert.deepEqual(merged.mixed, ["/a/b"]);
});

test("an object is not named when every key from the other browser was replaced", () => {
  const merged = carryDocument({ o: { a: 1, b: 1 } }, { o: { a: 2, b: 2 } }, { o: { a: 3, b: 1 } });
  assert.deepEqual(merged.value, { o: { a: 2, b: 2 } });
  assert.deepEqual(merged.conflicts, [{ path: "/o/a", saved: 3 }]);
  assert.deepEqual(merged.mixed, []);
});

test("an object that only groups other objects is not named, but a mixed child is", () => {
  const merged = carryDocument(
    { channels: { slack: { enabled: true, mode: "socket" } } },
    { channels: { slack: { enabled: true, mode: "http" } } },
    { channels: { slack: { enabled: false, mode: "socket" }, discord: { enabled: true } } },
  );
  assert.deepEqual(merged.value, {
    channels: { slack: { enabled: false, mode: "http" }, discord: { enabled: true } },
  });
  assert.deepEqual(merged.conflicts, []);
  assert.deepEqual(merged.mixed, ["/channels/slack"]);
  const separate = carryDocument(
    { plugins: { entries: { a: { config: { m: 1 } }, b: { config: { n: 1 } } } } },
    { plugins: { entries: { a: { config: { m: 2 } }, b: { config: { n: 1 } } } } },
    { plugins: { entries: { a: { config: { m: 1 } }, b: { config: { n: 2 } } } } },
  );
  assert.deepEqual(separate.mixed, []);
});

test("separate top-level sections merge without a review note", () => {
  const merged = carryDocument(
    { agents: { list: [] }, channels: {} },
    { agents: { list: [{ id: "main" }] }, channels: {} },
    { agents: { list: [] }, channels: { slack: { enabled: true } } },
  );
  assert.deepEqual(merged.value, {
    agents: { list: [{ id: "main" }] },
    channels: { slack: { enabled: true } },
  });
  assert.deepEqual(merged.conflicts, []);
  assert.deepEqual(merged.mixed, []);
});

test("an object only one browser changed, or both changed the same way, is not named", () => {
  const onlyMine = carryDocument(
    { auth: { mode: "token" }, port: 1 },
    { auth: { mode: "password" }, port: 1 },
    { auth: { mode: "token" }, port: 2 },
  );
  assert.deepEqual(onlyMine.value, { auth: { mode: "password" }, port: 2 });
  assert.deepEqual(onlyMine.mixed, []);
  const same = carryDocument(
    { auth: { mode: "token", bind: "lan" } },
    { auth: { mode: "password", bind: "lan" } },
    { auth: { mode: "password", bind: "lan" } },
  );
  assert.deepEqual(same.value, { auth: { mode: "password", bind: "lan" } });
  assert.deepEqual(same.mixed, []);
  // The reader's change already holds the other browser's: nothing of theirs is mixed in.
  const contained = carryDocument(
    { auth: { mode: "token" } },
    { auth: { mode: "password", bind: "lan" } },
    { auth: { mode: "token", bind: "lan" } },
  );
  assert.deepEqual(contained.value, { auth: { mode: "password", bind: "lan" } });
  assert.deepEqual(contained.mixed, []);
});

test("an untouched or unchanged document reports nothing mixed", () => {
  const base = { auth: { mode: "token" } };
  assert.deepEqual(carryDocument(base, base, { auth: { mode: "none" } }).mixed, []);
  assert.deepEqual(carryDocument(base, { auth: { mode: "none" } }, base).mixed, []);
});
