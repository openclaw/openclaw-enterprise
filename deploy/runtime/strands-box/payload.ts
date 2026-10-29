import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";

interface PayloadFile {
  path: string;
  sha256: string;
  mode: number;
  uid: number;
}

/** Used both for file verification and as the official code sent into a running container. */
export function verifyPayloadFiles(files: PayloadFile[]): void {
  for (const file of files) {
    // Only the leaf is resolved without following links. The caller supplies
    // trusted ancestor directories, not paths controlled by the workload.
    const fd = openSync(
      file.path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = fstatSync(fd);
      assert.ok(stat.isFile(), `${file.path}: expected a regular file`);
      assert.equal(stat.uid, file.uid, `${file.path}: unexpected file owner`);
      assert.equal(stat.mode & 0o7777, file.mode, `${file.path}: installed mode mismatch`);
      // Opening proves readability; mode verification does not prove effective execution.
      const actual = createHash("sha256").update(readFileSync(fd)).digest("hex");
      assert.equal(actual, file.sha256, `${file.path}: installed SHA-256 mismatch`);
    } finally {
      closeSync(fd);
    }
  }
}

/** Expected bytes and executable code come from the operator's checkout, never the image. */
export function strandsPayloadProbe(recordBytes: Buffer): { script: string; recordSha256: string } {
  const record = JSON.parse(recordBytes.toString());
  const names = [
    "strands-box",
    "strands-box-sock-alias",
    "strands-box-contain-trampoline",
    "bridge/inner.mjs",
    "bridge/outer.mjs",
    "bridge/proxy-preload.mjs",
    "bridge/readiness.mjs",
    "bridge/supervisor.mjs",
    "bridge/transport.mjs",
  ];
  assert.deepEqual(
    Object.keys(record.sha256).sort(),
    [...names].sort(),
    "unexpected build-record inventory",
  );
  const files = names.map((name): PayloadFile => {
    assert.match(record.sha256[name], /^[a-f0-9]{64}$/u, "invalid expected payload hash");
    return {
      path: name.startsWith("bridge/")
        ? `/opt/oce/strands-box/${name.slice(7)}`
        : `/opt/strands-box/${name}`,
      sha256: record.sha256[name],
      mode: name.startsWith("bridge/") ? 0o444 : 0o555,
      uid: 0,
    };
  });
  const recordSha256 = createHash("sha256").update(recordBytes).digest("hex");
  files.push({
    path: "/opt/strands-box/build-record.json",
    sha256: recordSha256,
    mode: 0o444,
    uid: 0,
  });
  const script = `
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
assert.equal(process.getuid(), 1000, "payload verification requires the normal node user (UID 1000)");
const verify = ${verifyPayloadFiles.toString()};
verify(${JSON.stringify(files)});
console.log(${JSON.stringify(recordSha256)});
`;
  return { script, recordSha256 };
}
