#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { extractSeccompProfile } from "./generate-codex-seccomp.mjs";
import {
  sha256Hex,
  stableJson,
  validateRuntimeDefaultSeccompProfile,
} from "./lib/codex-seccomp-profile.mjs";

const [baselinePath, outputPath] = process.argv.slice(2);
assert.ok(
  baselinePath && outputPath && process.argv.length === 4,
  "Usage: node scripts/generate-strands-box-seccomp.mjs <RuntimeDefault.json> <new-profile.json>",
);
const baseline = extractSeccompProfile(JSON.parse(await readFile(baselinePath, "utf8")));
validateRuntimeDefaultSeccompProfile(baseline);
assert.ok(baseline.architectures.includes("SCMP_ARCH_AARCH64"), "Only ARM64 is qualified.");
assert.ok(
  !baseline.syscalls.some((rule) => rule.names.some((name) => ["mount", "unshare"].includes(name))),
  "Use the captured RuntimeDefault baseline, not another sandbox's expanded profile.",
);

// These exact operations match the qualified read-only-root, private-network mount view.
const operations = [
  ["unshare", 0, 0x10000000, "private user namespace"],
  ["unshare", 0, 0x4c020000, "private mount, IPC, UTS and network namespaces"],
  ["mount", 3, 0x44000, "private recursive propagation"],
  ["mount", 3, 0x5000, "recursive bind"],
  ["mount", 3, 0x0e, "non-executable tmpfs"],
  ["mount", 3, 0x0f, "read-only non-executable tmpfs"],
  ["mount", 3, 0x102a, "writable non-executable device bind"],
  ["mount", 3, 0x102f, "read-only non-executable root bind"],
  ["mount", 3, 0x1027, "read-only executable bind"],
  ["mount", 3, 0x102e, "writable non-executable bind"],
  ["pivot_root", null, null, "enter the isolated mount view"],
  ["umount2", 1, 2, "detach the old root"],
];
const profile = {
  ...baseline,
  syscalls: [
    ...baseline.syscalls,
    ...operations.map(([name, index, value]) => ({
      names: [name],
      action: "SCMP_ACT_ALLOW",
      ...(index === null ? {} : { args: [{ index, op: "SCMP_CMP_EQ", value }] }),
    })),
  ],
};
const profileJson = stableJson(profile);
await writeFile(outputPath, profileJson, { flag: "wx", mode: 0o644 });
process.stdout.write(
  stableJson({
    profileSha256: sha256Hex(profileJson),
    runtimeDefaultSha256: sha256Hex(stableJson(baseline)),
    operations: operations.map(([syscall, argument, value, purpose]) => ({
      syscall,
      argument,
      value,
      purpose,
    })),
    qualification:
      "Linux ARM64, default proc masks, separate PID namespaces, original Box remount arguments. Other mount variants require requalification. Workload seccomp still denies mount creation. This setup profile does not resolve native IPC compatibility.",
  }),
);
