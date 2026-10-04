import assert from "node:assert/strict";
import test from "node:test";
import { allowsReceivePackInput } from "../../apps/controller/src/drivers/repo/github/credentials/routes/receive-pack.ts";

// The development token authority enforces its push allowlist at the gateway by
// reading receive-pack commands before any byte goes upstream. These vectors use
// Git's wire format: 4-hex-digit pkt-line lengths, a flush-pkt, then the pack.
const pkt = (line) => {
  const payload = Buffer.from(line, "latin1");
  return Buffer.concat([Buffer.from((payload.length + 4).toString(16).padStart(4, "0")), payload]);
};
const flush = Buffer.from("0000");
const pack = Buffer.from("PACK\0\0\0\x02\0\0\0\0garbage after the command section");
const zero = "0".repeat(40);
const a = "a".repeat(40);
const b = "b".repeat(40);
const caps =
  "\0report-status-v2 side-band-64k quiet object-format=sha1 agent=git/2.39.5.(Apple.Git-154)";
const body = (...lines) => Buffer.concat([...lines.map(pkt), flush, pack]);
const allows = allowsReceivePackInput(["refs/heads/agent/*", "refs/heads/release"]);

test("receive-pack inspector admits create, update and delete on allowed refs only", () => {
  for (const [name, input] of [
    ["update with capabilities", body(`${a} ${b} refs/heads/agent/x${caps}\n`)],
    ["create", body(`${zero} ${b} refs/heads/agent/new${caps}\n`)],
    ["delete", body(`${a} ${zero} refs/heads/agent/old${caps}\n`)],
    ["exact ref", body(`${a} ${b} refs/heads/release\n`)],
    [
      "several allowed",
      body(`${a} ${b} refs/heads/agent/one${caps}\n`, `${a} ${b} refs/heads/agent/two/deep\n`),
    ],
    ["shallow line first", body(`shallow ${a}`, `${a} ${b} refs/heads/agent/x${caps}`)],
    [
      "sha256",
      body(`${"c".repeat(64)} ${"d".repeat(64)} refs/heads/agent/x\0object-format=sha256`),
    ],
    ["flush only", Buffer.concat([flush, pack])],
  ]) {
    assert.equal(allows(input), true, name);
  }
});

test("receive-pack inspector refuses every disallowed or malformed command section", () => {
  const many = Array.from({ length: 257 }, (_, index) => `${a} ${b} refs/heads/agent/${index}`);
  for (const [name, input] of [
    ["default branch", body(`${a} ${b} refs/heads/main${caps}\n`)],
    [
      "one denied among allowed",
      body(`${a} ${b} refs/heads/agent/x${caps}\n`, `${a} ${b} refs/heads/main\n`),
    ],
    ["deleting a denied ref", body(`${a} ${zero} refs/heads/main${caps}`)],
    ["tag", body(`${zero} ${b} refs/tags/agent/v1${caps}`)],
    ["prefix without slash", body(`${a} ${b} refs/heads/agentx${caps}`)],
    ["exact entry is not a prefix", body(`${a} ${b} refs/heads/release/x${caps}`)],
    // Git would refuse these names too; the gateway refuses them before upstream.
    ["dot-dot inside an allowed prefix", body(`${a} ${b} refs/heads/agent/../main${caps}`)],
    ["empty name under an allowed prefix", body(`${a} ${b} refs/heads/agent/${caps}`)],
    ["lock suffix", body(`${a} ${b} refs/heads/agent/x.lock${caps}`)],
    ["reflog syntax", body(`${a} ${b} refs/heads/agent/x@{1}${caps}`)],
    ["mixed oid lengths", body(`${a} ${"d".repeat(64)} refs/heads/agent/x${caps}`)],
    ["uppercase oid", body(`${"A".repeat(40)} ${b} refs/heads/agent/x${caps}`)],
    ["signed push", body(`push-cert${caps}`, "certificate version 0.1")],
    [
      "capabilities on a later command",
      body(`${a} ${b} refs/heads/agent/x`, `${a} ${b} refs/heads/agent/y${caps}`),
    ],
    ["capabilities on a shallow line", body(`shallow ${a}${caps}`, `${a} ${b} refs/heads/agent/x`)],
    ["malformed shallow", body(`shallow ${a.slice(1)}`, `${a} ${b} refs/heads/agent/x`)],
    ["control byte", body(`${a} ${b} refs/heads/agent/x\r${caps}`)],
    ["truncated pkt-line", Buffer.concat([pkt(`${a} ${b} refs/heads/agent/x`)]).subarray(0, 30)],
    ["missing flush", Buffer.concat([pkt(`${a} ${b} refs/heads/agent/x${caps}`)])],
    ["bad length hex", Buffer.concat([Buffer.from("00zz"), flush])],
    ["delimiter packet", Buffer.concat([Buffer.from("0001"), flush])],
    ["empty body", Buffer.alloc(0)],
    ["257 commands", body(`${many[0]}${caps}`, ...many.slice(1))],
  ]) {
    assert.equal(allows(input), false, name);
  }
});

test("an empty allowlist refuses every push command while allowing an empty flush", () => {
  const none = allowsReceivePackInput([]);
  assert.equal(none(body(`${zero} ${b} refs/heads/agent/x${caps}`)), false);
  assert.equal(none(Buffer.concat([flush])), true);
});
