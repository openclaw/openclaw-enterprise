import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { accessSync, constants, lstatSync, readFileSync } from "node:fs";

interface PayloadFile {
  path: string;
  sha256: string;
  mode: number;
}

/** Used both for file verification and as the official code sent into a running container. */
export function verifyPayloadFiles(files: PayloadFile[]): void {
  for (const file of files) {
    const stat = lstatSync(file.path);
    assert.ok(stat.isFile(), `${file.path}: expected a regular file`);
    assert.equal(stat.mode & 0o777, file.mode, `${file.path}: installed mode mismatch`);
    accessSync(file.path, constants.R_OK | (file.mode === 0o555 ? constants.X_OK : 0));
    const actual = createHash("sha256").update(readFileSync(file.path)).digest("hex");
    assert.equal(actual, file.sha256, `${file.path}: installed SHA-256 mismatch`);
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
    };
  });
  const recordSha256 = createHash("sha256").update(recordBytes).digest("hex");
  files.push({ path: "/opt/strands-box/build-record.json", sha256: recordSha256, mode: 0o444 });
  const script = `
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { accessSync, constants, lstatSync, readFileSync } from "node:fs";
assert.equal(process.getuid(), 1000, "payload verification requires the normal node user (UID 1000)");
const verify = ${verifyPayloadFiles.toString()};
verify(${JSON.stringify(files)});
console.log(${JSON.stringify(recordSha256)});
`;
  return { script, recordSha256 };
}
