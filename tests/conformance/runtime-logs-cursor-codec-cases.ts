import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { AgentRuntimeLogChunk } from "../../packages/contracts/src/index.ts";
import { compareRuntimeLogTime } from "../../packages/occ/src/runtime-logs/read.ts";
import {
  createRuntimeLogCursorCodec,
  RUNTIME_LOG_CURSOR_TTL_MS,
  validRuntimeLogFrontierTime,
  type RuntimeLogCursorBinding,
} from "../../packages/occ/src/runtime-logs/cursor.ts";
import { cursorPayload, messages, pollReader } from "../helpers/runtime-logs-content.ts";

// Sign intentionally invalid wire data so the real decoder reaches its payload checks.
export function signRuntimeLogCursorPayload(secret: string, payload: object) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", secret)
    .update(`occ-runtime-logs-cursor\0v2\0${encoded}`)
    .digest("base64url");
  return `v2.${encoded}.${mac}`;
}

function cursorCodecFixture() {
  const secret = randomBytes(32).toString("hex");
  const codec = createRuntimeLogCursorCodec(secret);
  const binding: RuntimeLogCursorBinding = {
    principalId: "synthetic-person",
    agentId: "agent-test",
    revisionId: "revision-test",
    source: "gateway",
  };
  const issuedAt = Date.parse("2026-09-30T12:10:00Z");
  const position = {
    viewId: "rlv_synthetic",
    pod: "gateway-test-0",
    podUid: "synthetic-pod-0",
    restartCount: 0,
    previous: false,
    lastTime: "2026-09-30T12:00:00Z",
    lastHashes: [codec.lineHash("worker ready")],
    frontierComplete: true,
    frontierCount: 1,
    issuedAt,
  };
  const status = (
    cursor: string,
    {
      now = issuedAt,
      bound = binding,
    }: { now?: number | undefined; bound?: RuntimeLogCursorBinding | undefined } = {},
  ) => codec.decode(cursor, bound, now).status;
  return { codec, binding, issuedAt, position, status, secret };
}

function plainLineHash(raw: string) {
  return createHash("sha256").update(raw).digest("base64url").slice(0, 16);
}
// The pre-keying envelope: version outside the MAC and plain SHA-256 line hashes.
function legacyCursor(secret: string, payload: object) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", secret)
    .update(`occ-runtime-logs-cursor\0${encoded}`)
    .digest("base64url");
  return `v1.${encoded}.${mac}`;
}

export function registerRuntimeLogCursorCodecCases(
  timedLog: (raw: string, second: number) => AgentRuntimeLogChunk["lines"][number],
) {
  test("runtime log cursor codec refuses other bindings, altered envelopes and future issue times", () => {
    const { codec, binding, issuedAt, position, status } = cursorCodecFixture();
    const cursor = codec.encode(binding, position);
    assert.equal(status(cursor), "valid");
    for (const [label, bound] of [
      ["agent", { ...binding, agentId: "agent-other" }],
      ["revision", { ...binding, revisionId: "revision-other" }],
      ["source", { ...binding, source: "sandbox" }],
      // Fields are delimited: moving text between them is another binding.
      ["boundary", { ...binding, principalId: "synthetic-personagent", agentId: "-test" }],
    ] satisfies [string, RuntimeLogCursorBinding][]) {
      assert.equal(status(cursor, { bound }), "invalid", label);
    }
    // Only the exact three-part v2 envelope verifies; a short MAC is refused, not thrown.
    // The MAC covers the version, so relabelling a v2 cursor as v1 does not verify.
    const [, payload, mac] = cursor.split(".");
    assert.ok(payload && mac);
    for (const [label, forged] of [
      ["extra part", `${cursor}.extra`],
      ["version", `v1.${payload}.${mac}`],
      ["unknown version", `v3.${payload}.${mac}`],
      ["short MAC", `v2.${payload}.${mac.slice(0, -1)}`],
    ] satisfies [string, string][]) {
      assert.equal(status(forged), "invalid", label);
    }
    // Expiry starts strictly after the TTL; up to one minute of clock skew is tolerated.
    for (const [now, expected] of [
      [issuedAt + RUNTIME_LOG_CURSOR_TTL_MS, "valid"],
      [issuedAt + RUNTIME_LOG_CURSOR_TTL_MS + 1, "expired"],
      [issuedAt - 60_000, "valid"],
      [issuedAt - 60_001, "invalid"],
    ] satisfies [number, string][]) {
      assert.equal(status(cursor, { now }), expected, `${now - issuedAt} ms`);
    }
  });

  test("runtime log cursor codec keeps the newest 48 hashes, hashes raw lines exactly and needs a 32-character secret", () => {
    const { codec, binding, issuedAt, position } = cursorCodecFixture();
    const hashes = Array.from({ length: 49 }, (_, index) => codec.lineHash(`worker ${index}`));
    const many = codec.encode(binding, { ...position, lastHashes: hashes, frontierCount: 49 });
    const decoded = codec.decode(many, binding, issuedAt);
    assert.equal(decoded.status, "valid");
    assert.deepEqual(decoded.position.lastHashes, hashes.slice(-48));
    // Frontier hashes compare raw lines exactly.
    assert.notEqual(codec.lineHash("worker ready"), codec.lineHash("worker ready "));
    assert.throws(() => createRuntimeLogCursorCodec("s".repeat(31)), TypeError);
    assert.doesNotThrow(() => createRuntimeLogCursorCodec("s".repeat(32)));
  });

  test("runtime log cursor line hashes are keyed by the server secret, not plain SHA-256", async () => {
    const secret = randomBytes(32).toString("hex");
    const reader = pollReader({ secret });
    // A low-entropy value that redaction masks; its raw-line digest must not be testable.
    const secretLine = "db login password=hunter2";
    const lines = [timedLog("worker ready", 0), timedLog(secretLine, 0)];
    const page = await reader.poll(lines);
    assert.equal(JSON.stringify(page.records).includes("hunter2"), false);
    const payload = cursorPayload(reader.cursor);
    assert.ok(typeof payload === "object" && payload !== null && "h" in payload);
    assert.ok(typeof payload.h === "string");
    const carried = payload.h.match(/.{16}/g);
    assert.ok(carried);
    assert.deepEqual(
      carried,
      lines.map(({ raw }) => reader.codec.lineHash(raw)),
    );
    for (const { raw } of lines) {
      assert.equal(carried.includes(plainLineHash(raw)), false, raw);
    }
    const keyed = reader.codec.lineHash(secretLine);
    // Same secret, same digest; another secret cannot reproduce it.
    assert.equal(createRuntimeLogCursorCodec(secret).lineHash(secretLine), keyed);
    assert.notEqual(
      createRuntimeLogCursorCodec(randomBytes(32).toString("hex")).lineHash(secretLine),
      keyed,
    );
    // Nor is the line hash the cursor MAC key applied directly.
    assert.notEqual(
      createHmac("sha256", secret).update(secretLine).digest("base64url").slice(0, 16),
      keyed,
    );
    // Frontier hashes and byte-cut window checkpoints (container and Sandbox) all go
    // through the keyed codec; the readers have no unkeyed digest of their own.
    for (const file of ["read.ts", "sandbox.ts"]) {
      const source = await readFile(
        new URL(`../../packages/occ/src/runtime-logs/${file}`, import.meta.url),
        "utf8",
      );
      assert.equal(/node:crypto|createHash|createHmac/.test(source), false, file);
    }
  });

  test("runtime log cursor keyed hashes still de-duplicate and resume", async () => {
    const reader = pollReader();
    const first = [timedLog("worker ready", 0), timedLog("worker ready", 0), timedLog("a", 1)];
    assert.deepEqual(await reader.shown(first), ["worker ready", "worker ready", "a"]);
    // The overlap at the frontier is consumed; a new copy and later lines are kept.
    assert.deepEqual(await reader.shown([...first, timedLog("a", 1), timedLog("b", 2)]), [
      "a",
      "b",
    ]);
    assert.deepEqual(await reader.shown([timedLog("a", 1), timedLog("b", 2)]), []);
    assert.equal(reader.admissions, 1);
  });

  test("runtime log cursors from before keyed hashes expire into a new audited view", async () => {
    const secret = randomBytes(32).toString("hex");
    const reader = pollReader({ secret });
    const lines = [timedLog("worker ready", 0), timedLog("worker ready", 0), timedLog("a", 1)];
    await reader.poll(lines);
    const current = cursorPayload(reader.cursor);
    assert.ok(typeof current === "object" && current !== null && "v" in current);
    // What the previous release issued for the same position: plain hashes, v1 MAC.
    const legacy = legacyCursor(secret, { ...current, h: plainLineHash("a") });
    const decoded = reader.codec.decode(legacy, reader.binding);
    assert.equal(decoded.status, "expired");
    assert.deepEqual(decoded.position.lastHashes, []);
    assert.equal(decoded.position.containerWindow, undefined);
    // Forged, foreign or malformed legacy envelopes stay invalid. The forged MAC always
    // differs: about one MAC in 1024 already ends in "AA".
    const forgedEnd = legacy.endsWith("AA") ? "AE" : "AA";
    for (const [cursor, binding] of [
      [`${legacy.slice(0, -2)}${forgedEnd}`, reader.binding],
      [legacy, { ...reader.binding, principalId: "other-person" }],
      [legacyCursor(secret, { ...current, r: -1 }), reader.binding],
    ] satisfies [string, RuntimeLogCursorBinding][]) {
      assert.equal(reader.codec.decode(cursor, binding).status, "invalid");
    }
    const before = reader.admissions;
    const page = await reader.poll([...lines, timedLog("b", 2)], { query: { cursor: legacy } });
    // A visible gap and a fresh audited view, never a silent de-duplication.
    assert.ok(
      page.records.some((record) => record.type === "gap" && record.reason === "cursor_expired"),
    );
    assert.equal(reader.admissions, before + 1);
    assert.deepEqual(messages(page), ["worker ready", "worker ready", "a", "b"]);
    assert.ok(reader.cursor);
    assert.match(reader.cursor, /^v2\./);
    const next = cursorPayload(reader.cursor);
    assert.ok(typeof next === "object" && next !== null && "v" in next);
    assert.notEqual(next.v, current.v);
  });

  test("runtime log cursor refuses signed positions with malformed fields", () => {
    const { codec, binding, position, status, secret } = cursorCodecFixture();
    const cursor = codec.encode(binding, position);
    assert.equal(status(cursor), "valid");
    const payload = cursorPayload(cursor);
    assert.ok(typeof payload === "object" && payload !== null);
    assert.equal(signRuntimeLogCursorPayload(secret, payload), cursor);
    for (const [label, change] of [
      ["viewId", { v: 7 }],
      ["podUid", { u: null }],
      ["restartCount", { r: -1 }],
      ["restartCount", { r: 1.5 }],
      ["previous", { pr: "false" }],
      ["lastTime", { t: 5 }],
      ["lastHashes", { h: "short" }],
      ["issuedAt", { i: String(position.issuedAt) }],
      ["frontierComplete", { fc: "true" }],
      ["frontierCount", { fn: "1" }],
      ["pemOpen and pemAfterTime", { po: false, pt: [position.lastTime] }],
    ] satisfies [string, object][]) {
      // Authenticate the malformed wire payload without passing it through the typed encoder.
      assert.equal(
        status(signRuntimeLogCursorPayload(secret, { ...payload, ...change })),
        "invalid",
        label,
      );
    }
  });

  test("runtime log frontier times accept only kubelet UTC and order trimmed fractions", () => {
    for (const [value, valid] of [
      ["2026-09-30T12:00:00Z", true],
      ["2026-09-30T12:00:00.123456789Z", true],
      ["2026-09-30T12:00:00.1234567890Z", false],
      ["2026-09-30T12:00:00+00:00", false],
      ["+012026-09-30T12:00:00Z", false],
      ["2026-02-30T12:00:00Z", false],
      ["2026-13-01T12:00:00Z", false],
    ] satisfies [string, boolean][]) {
      assert.equal(validRuntimeLogFrontierTime(value), valid, value);
    }
    // Kubelet trims trailing zeros from the fraction.
    assert.equal(compareRuntimeLogTime("2026-09-30T12:00:00Z", "2026-09-30T12:00:00.000Z"), 0);
    assert.equal(compareRuntimeLogTime("2026-09-30T12:00:00.5Z", "2026-09-30T12:00:00.123Z"), 1);
  });
}
