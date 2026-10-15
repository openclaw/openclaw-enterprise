import assert from "node:assert/strict";
import test from "node:test";
import {
  allowsReceivePackInput,
  maximumPushRefs,
} from "../../apps/controller/src/drivers/repo/github/credentials/routes/receive-pack.ts";
import {
  normalizePushRefAllowlist,
  readPushedBranchRef,
} from "../../apps/controller/src/drivers/repo/credentials/client-contracts.ts";

// The development token authority enforces its push allowlist at the gateway by
// reading receive-pack commands before any byte goes upstream. These vectors use
// Git's wire format: 4-hex-digit pkt-line lengths, a flush-pkt, then the pack.
const pkt = (line) => {
  const payload = Buffer.isBuffer(line) ? line : Buffer.from(line, "latin1");
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
// Bidi controls, zero-width and invisible characters, and line and paragraph separators.
const invisibleCharacters = [
  0x061c, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2028, 0x2029, 0x202a, 0x202b, 0x202c, 0x202d,
  0x202e, 0x2060, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff,
];

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
    ["non-ASCII capability", body(`${a} ${b} refs/heads/agent/x${caps} agent=caf\xe9`)],
  ]) {
    assert.equal(allows(input), false, name);
  }
});

// Git's refnames are bytes; it accepts UTF-8 names such as agent/café. The gateway
// decodes them as strict UTF-8 and compares with the allowlist byte for byte.
test("receive-pack inspector admits UTF-8 branch names Git accepts and refuses lookalikes", () => {
  const utf8 = (ref, extra = caps) => pkt(Buffer.from(`${a} ${b} ${ref}${extra}\n`, "utf8"));
  const raw = (...parts) =>
    pkt(Buffer.concat([Buffer.from(`${a} ${b} `), ...parts.map((part) => Buffer.from(part))]));
  const section = (...lines) => Buffer.concat([...lines, flush, pack]);
  const exact = allowsReceivePackInput(["refs/heads/agent/*", "refs/heads/caf\u00e9"]);
  for (const [name, input] of [
    ["composed name under a prefix", section(utf8("refs/heads/agent/caf\u00e9"))],
    ["composed exact entry", section(utf8("refs/heads/caf\u00e9"))],
    ["astral character", section(utf8("refs/heads/agent/\u{1F680}"))],
    ["highest code point", section(utf8("refs/heads/agent/\u{10FFFF}"))],
    [
      "UTF-8 on a later command",
      section(utf8("refs/heads/agent/x"), utf8("refs/heads/caf\u00e9", "")),
    ],
  ]) {
    assert.equal(exact(input), true, name);
  }
  for (const [name, input] of [
    // NFD spelling of the exact entry: renders the same, differs in bytes.
    ["decomposed lookalike", section(utf8("refs/heads/cafe\u0301"))],
    ["case variant", section(utf8("refs/heads/CAF\u00c9"))],
    ["lone continuation byte", section(raw("refs/heads/agent/caf", [0x80], caps))],
    ["truncated sequence", section(raw("refs/heads/agent/caf", [0xc3], caps))],
    ["invalid byte", section(raw("refs/heads/agent/", [0xff], caps))],
    ["overlong slash", section(raw("refs/heads/agent/a", [0xc0, 0xaf], "main", caps))],
    ["encoded surrogate", section(raw("refs/heads/agent/", [0xed, 0xa0, 0x80], caps))],
    ["above U+10FFFF", section(raw("refs/heads/agent/", [0xf4, 0x90, 0x80, 0x80], caps))],
    ["C0 control byte", section(raw("refs/heads/agent/caf", [0x01], caps))],
    ["DEL", section(raw("refs/heads/agent/caf", [0x7f], caps))],
    ["C1 control", section(utf8("refs/heads/agent/a\u0085b"))],
    ["second NUL on the first command", section(utf8("refs/heads/agent/x", `${caps}\0x`))],
    [
      "non-ASCII shallow line",
      section(pkt(Buffer.from(`shallow ${a}\u00e9`)), utf8("refs/heads/agent/x")),
    ],
    ["UTF-8 name Git refuses", section(utf8("refs/heads/agent/caf\u00e9.lock"))],
    // Git accepts these, but they hide or reorder how the name displays (Trojan Source).
    ...invisibleCharacters.map((code) => [
      `U+${code.toString(16).toUpperCase().padStart(4, "0")} inside the name`,
      section(utf8(`refs/heads/agent/a${String.fromCodePoint(code)}b`)),
    ]),
    ["BOM ending the name", section(utf8("refs/heads/agent/a\ufeff"))],
    [
      "invisible character on a later command",
      section(utf8("refs/heads/agent/x"), utf8("refs/heads/agent/\u200bx", "")),
    ],
  ]) {
    assert.equal(exact(input), false, name);
  }
});

test("a pushed ref is refused with a readable reason that names the character", () => {
  const read = (ref) => readPushedBranchRef(Buffer.isBuffer(ref) ? ref : Buffer.from(ref, "utf8"));
  assert.deepEqual(read("refs/heads/agent/caf\u00e9"), { ref: "refs/heads/agent/caf\u00e9" });
  assert.deepEqual(read("refs/heads/agent/a\u202eb"), {
    refused: "the ref name contains U+202E, an invisible or direction-changing character",
  });
  assert.deepEqual(read("refs/heads/agent/a\u061cb"), {
    refused: "the ref name contains U+061C, an invisible or direction-changing character",
  });
  assert.deepEqual(read(Buffer.from([...Buffer.from("refs/heads/agent/"), 0xff])), {
    refused: "the ref name is not valid UTF-8",
  });
  assert.deepEqual(read("refs/heads/agent/a\u0085b"), {
    refused: "the ref name contains a control character",
  });
  assert.deepEqual(read("refs/heads/agent/x.lock"), {
    refused: "the ref name is not a branch name Git accepts",
  });
  assert.deepEqual(read("refs/tags/v1"), {
    refused: "only branches under refs/heads/ can be pushed",
  });
  // Neighbors of the refused ranges stay ordinary text.
  for (const code of [
    0x061b, 0x061d, 0x200a, 0x2010, 0x2027, 0x202f, 0x205f, 0x2061, 0x2065, 0x206a, 0xfefe, 0xff01,
  ]) {
    const ref = `refs/heads/agent/a${String.fromCodePoint(code)}b`;
    assert.deepEqual(read(ref), { ref }, code.toString(16));
  }
});

test("push allowlist entries must have one exact, visible UTF-8 spelling", () => {
  assert.deepEqual(normalizePushRefAllowlist(["refs/heads/caf\u00e9", "refs/heads/agent/*"]), [
    "refs/heads/agent/*",
    "refs/heads/caf\u00e9",
  ]);
  for (const entry of [
    "refs/heads/\ud800/*",
    "refs/heads/a\udc00",
    "refs/heads/a\u0001",
    "refs/heads/agent\u202e/*",
    "refs/heads/a\u200bb",
    "refs/heads/a\ufeff",
  ]) {
    assert.throws(() => normalizePushRefAllowlist([entry]), /invalid-push-ref-allowlist/);
  }
});

test("receive-pack inspector refuses more than 256 ref updates with its own code", () => {
  const commands = (count) =>
    Array.from({ length: count }, (_, index) => `${a} ${b} refs/heads/agent/${index}`);
  const push = (count) => {
    const lines = commands(count);
    return body(`${lines[0]}${caps}`, ...lines.slice(1));
  };
  assert.equal(maximumPushRefs, 256);
  assert.equal(allows(push(256)), true);
  assert.deepEqual(allows(push(257)), {
    status: 413,
    code: "push-ref-limit-exceeded",
    message: "A push may update at most 256 refs. Push the refs in smaller batches.",
  });
  // A disallowed ref is still refused as such, whatever the count.
  const mixed = commands(300);
  mixed[10] = `${a} ${b} refs/heads/main`;
  assert.equal(allows(body(`${mixed[0]}${caps}`, ...mixed.slice(1))), false);
});

test("an empty allowlist refuses every push command while allowing an empty flush", () => {
  const none = allowsReceivePackInput([]);
  assert.equal(none(body(`${zero} ${b} refs/heads/agent/x${caps}`)), false);
  assert.equal(none(Buffer.concat([flush])), true);
});
