import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  codexBwrapAdditionalSyscalls,
  deriveCodexBwrapProfile,
} from "../../scripts/lib/codex-seccomp-profile.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const generatorPath = join(repositoryRoot, "scripts/generate-codex-seccomp.mjs");

const runtimeDefaultBaseline = Object.freeze({
  architectures: ["SCMP_ARCH_X86_64", "SCMP_ARCH_X86", "SCMP_ARCH_X32"],
  defaultAction: "SCMP_ACT_ERRNO",
  syscalls: [
    { names: ["read"], action: "SCMP_ACT_ALLOW" },
    { names: ["clone3"], action: "SCMP_ACT_ERRNO", errnoRet: 38 },
  ],
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "codex-seccomp-profile-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(root, { recursive: true });
  return root;
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

test("codex seccomp profile derivation preserves RuntimeDefault and adds only reviewed bwrap rules", () => {
  const profile = deriveCodexBwrapProfile(runtimeDefaultBaseline, { codexVersion: "0.158.0" });
  const added = profile.syscalls.slice(runtimeDefaultBaseline.syscalls.length);

  assert.deepEqual(profile.architectures, runtimeDefaultBaseline.architectures);
  assert.deepEqual(profile.syscalls.slice(0, runtimeDefaultBaseline.syscalls.length), [
    ...runtimeDefaultBaseline.syscalls,
  ]);
  assert.equal(profile.defaultAction, "SCMP_ACT_ERRNO");
  assert.equal(added.length, 78);
  assert.deepEqual(added, codexBwrapAdditionalSyscalls());
  assert.deepEqual(
    added.filter((rule) => rule.names.includes("unshare")),
    [
      {
        names: ["unshare"],
        action: "SCMP_ACT_ALLOW",
        args: [{ index: 0, op: "SCMP_CMP_EQ", value: 0x10000000 }],
      },
    ],
  );
  assert.deepEqual(
    added.filter((rule) => rule.names.includes("pivot_root")),
    [{ names: ["pivot_root"], action: "SCMP_ACT_ALLOW" }],
  );
  assert.deepEqual(
    added.filter((rule) => rule.names.includes("umount2")),
    [
      {
        names: ["umount2"],
        action: "SCMP_ACT_ALLOW",
        args: [{ index: 1, op: "SCMP_CMP_EQ", value: 2 }],
      },
    ],
  );
  assert.equal(
    added.some((rule) => rule.names.includes("clone3")),
    false,
    "clone3 must remain governed by the RuntimeDefault ENOSYS rule",
  );
});

test("codex seccomp profile derivation rejects unsupported baselines and versions", () => {
  assert.throws(
    () =>
      deriveCodexBwrapProfile({
        ...runtimeDefaultBaseline,
        defaultAction: "SCMP_ACT_ALLOW",
      }),
    /default-deny/,
  );
  assert.throws(
    () =>
      deriveCodexBwrapProfile({
        ...runtimeDefaultBaseline,
        syscalls: [{ names: ["read"], action: "SCMP_ACT_ALLOW" }],
      }),
    /clone3 ENOSYS/,
  );
  assert.throws(
    () =>
      deriveCodexBwrapProfile({
        ...runtimeDefaultBaseline,
        architectures: ["SCMP_ARCH_X86_64", "SCMP_ARCH_AARCH64"],
      }),
    /unsupported seccomp architecture grouping: SCMP_ARCH_X86_64, SCMP_ARCH_AARCH64/,
  );
  assert.throws(
    () =>
      deriveCodexBwrapProfile({
        ...runtimeDefaultBaseline,
        architectures: ["SCMP_ARCH_S390X", "SCMP_ARCH_S390"],
      }),
    /unsupported seccomp architecture grouping: SCMP_ARCH_S390X, SCMP_ARCH_S390/,
  );
  assert.throws(
    () =>
      deriveCodexBwrapProfile({
        ...runtimeDefaultBaseline,
        architectures: ["SCMP_ARCH_X86"],
      }),
    /unsupported seccomp architecture grouping: SCMP_ARCH_X86/,
  );
  assert.throws(
    () => deriveCodexBwrapProfile(runtimeDefaultBaseline, { codexVersion: "0.153.0" }),
    /reviewed Codex versions: 0\.152\.1, 0\.154\.0, 0\.156\.0/,
  );
});

test("codex seccomp profile derivation admits reviewed native architecture compat groups", () => {
  assert.deepEqual(
    deriveCodexBwrapProfile(
      {
        ...runtimeDefaultBaseline,
        architectures: ["SCMP_ARCH_X86_64", "SCMP_ARCH_X86", "SCMP_ARCH_X32"],
      },
      { codexVersion: "0.156.0" },
    ).architectures,
    ["SCMP_ARCH_X86_64", "SCMP_ARCH_X86", "SCMP_ARCH_X32"],
  );
  assert.deepEqual(
    deriveCodexBwrapProfile(
      { ...runtimeDefaultBaseline, architectures: ["SCMP_ARCH_AARCH64", "SCMP_ARCH_ARM"] },
      { codexVersion: "0.156.0" },
    ).architectures,
    ["SCMP_ARCH_AARCH64", "SCMP_ARCH_ARM"],
  );
});

test("offline codex seccomp generator writes immutable profile and nonsecret provenance", async (t) => {
  const root = await fixture(t);
  const baselinePath = join(root, "runtime-default.json");
  const profilePath = join(root, "codex-bwrap.json");
  const provenancePath = join(root, "codex-bwrap.provenance.json");
  await writeJson(baselinePath, { linux: { seccomp: runtimeDefaultBaseline } });

  const generated = spawnSync(
    process.execPath,
    [
      generatorPath,
      "--baseline",
      baselinePath,
      "--codex-version",
      "0.158.0",
      "--out",
      profilePath,
      "--provenance-out",
      provenancePath,
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );

  assert.equal(generated.status, 0, generated.stderr);
  const summary = JSON.parse(generated.stdout);
  const profile = JSON.parse(await readFile(profilePath, "utf8"));
  const provenance = JSON.parse(await readFile(provenancePath, "utf8"));
  assert.equal(summary.profilePath, profilePath);
  assert.equal(summary.provenancePath, provenancePath);
  assert.deepEqual(profile.syscalls.slice(0, runtimeDefaultBaseline.syscalls.length), [
    ...runtimeDefaultBaseline.syscalls,
  ]);
  assert.equal(provenance.codexVersion, "0.158.0");
  assert.equal(provenance.runtimeDefaultSha256, summary.runtimeDefaultSha256);
  assert.equal(provenance.profileSha256, summary.profileSha256);
  assert.equal(provenance.addedRules, 78);
  assert.ok(Array.isArray(provenance.sourceProvenance));

  const overwrite = spawnSync(
    process.execPath,
    [
      generatorPath,
      "--baseline",
      baselinePath,
      "--codex-version",
      "0.158.0",
      "--out",
      profilePath,
      "--provenance-out",
      join(root, "other-provenance.json"),
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );

  assert.equal(overwrite.status, 1);
  assert.match(overwrite.stderr, /already exists/);
});

test("offline codex seccomp generator rejects invalid arguments before writing outputs", async (t) => {
  const root = await fixture(t);
  const baselinePath = join(root, "runtime-default.json");
  const profilePath = join(root, "codex-bwrap.json");
  await writeJson(baselinePath, { linux: { seccomp: runtimeDefaultBaseline } });

  for (const args of [
    [
      "--baseline",
      baselinePath,
      "--codex-version",
      "0.156.0",
      "--out",
      profilePath,
      "--bogus",
      "1",
    ],
    [
      "--baseline",
      baselinePath,
      "--baseline",
      baselinePath,
      "--codex-version",
      "0.156.0",
      "--out",
      profilePath,
    ],
    [
      "--baseline",
      baselinePath,
      "--codex-version",
      "0.156.0",
      "--out",
      profilePath,
      "--provenance-out",
      profilePath,
    ],
  ]) {
    const generated = spawnSync(process.execPath, [generatorPath, ...args], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });

    assert.equal(generated.status, 1);
    await assert.rejects(() => readFile(profilePath, "utf8"), { code: "ENOENT" });
  }
});
