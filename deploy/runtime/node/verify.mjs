import assert from "node:assert/strict";
import { createHash, randomBytes, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";

const source = JSON.parse(readFileSync("/usr/local/share/oce-node/source.json", "utf8"));
const receipt = JSON.parse(readFileSync("/usr/local/share/oce-node/provenance.json", "utf8"));
assert.equal(process.versions.node, source.version);
assert.equal(process.versions.modules, source.modules);
assert.equal(process.versions.napi, source.napi);
assert.equal(process.platform, "linux");
assert.ok(["x64", "arm64"].includes(process.arch));
assert.deepEqual(receipt, {
  source: "https://github.com/nodejs/node",
  ...source,
  version: process.versions.node,
  architecture: process.arch,
  platform: process.platform,
  modules: process.versions.modules,
  napi: process.versions.napi,
  icu: process.versions.icu,
  executable: "/usr/local/bin/node",
  sha256: createHash("sha256").update(readFileSync(process.execPath)).digest("hex"),
});
// Exercise ICU data and native crypto after copying the binary into slim Bookworm.
assert.deepEqual(Intl.DateTimeFormat.supportedLocalesOf(["en", "fr", "ja", "ar"]), [
  "en",
  "fr",
  "ja",
  "ar",
]);
assert.equal(
  new Intl.DateTimeFormat("fr", { month: "long", timeZone: "UTC" }).format(new Date("2026-01-01")),
  "janvier",
);
assert.equal(randomBytes(16).length, 16);
assert.equal((await webcrypto.subtle.digest("SHA-256", new Uint8Array([1, 2, 3]))).byteLength, 32);
console.log(JSON.stringify(receipt));
