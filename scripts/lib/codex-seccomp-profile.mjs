import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const reviewedCodexVersions = Object.freeze(["0.152.1", "0.154.0", "0.156.0"]);
const supportedSeccompArchitectureGroups = Object.freeze([
  Object.freeze({
    native: "SCMP_ARCH_X86_64",
    compatible: Object.freeze(["SCMP_ARCH_X86", "SCMP_ARCH_X32"]),
  }),
  Object.freeze({
    native: "SCMP_ARCH_AARCH64",
    compatible: Object.freeze(["SCMP_ARCH_ARM"]),
  }),
]);

// The vendored Bubblewrap sources are byte-identical across the reviewed releases.
// Codex 0.156.0 adds socket masking with existing tmpfs and remount flags.
// Version admission does not change the syscall rules or the live positive/negative probes.
const codexBwrapSourceProvenance = Object.freeze([
  {
    name: "containerd RuntimeDefault seccomp",
    source: "operator-captured RuntimeDefault OCI runtimeSpec.linux.seccomp",
  },
  {
    name: "Codex 0.152.1 and 0.154.0 bubblewrap launcher",
    source: "openai/codex rust-v0.152.1 and rust-v0.154.0 codex-rs/linux-sandbox/src/bwrap.rs",
    sha256: "bfce8aa44048b2441a7c02b301fe7366ae1b8b9ddd8ff8518711cd874a9e749e",
  },
  {
    name: "Codex 0.156.0 bubblewrap launcher",
    source: "openai/codex rust-v0.156.0 codex-rs/linux-sandbox/src/bwrap.rs",
    sha256: "e1c2a7a0ac805a70f3531ff7d584970b023da2d59fc221e0cb6bd0fa0c31729d",
  },
  {
    name: "bubblewrap mount setup",
    source:
      "openai/codex rust-v0.152.1, rust-v0.154.0 and rust-v0.156.0 codex-rs/vendor/bubblewrap/bubblewrap.c",
    sha256: "9bc38fb46080b6854e0c414ccb5fbd369d9d7c0230fdfa877283d31aef0c5720",
  },
  {
    name: "bubblewrap bind mount flags",
    source:
      "openai/codex rust-v0.152.1, rust-v0.154.0 and rust-v0.156.0 codex-rs/vendor/bubblewrap/bind-mount.c",
    sha256: "19a6ae020803e342667dd562efab027967b1c1f2965525ec7ee09521554f8f71",
  },
]);

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function allowSyscall(name, index, value) {
  return {
    names: [name],
    action: "SCMP_ACT_ALLOW",
    ...(index === undefined ? {} : { args: [{ index, op: "SCMP_CMP_EQ", value }] }),
  };
}

const linuxCloneFlags = Object.freeze({
  SIGCHLD: 0x00000011,
  CLONE_NEWNS: 0x00020000,
  CLONE_NEWUSER: 0x10000000,
  CLONE_NEWIPC: 0x08000000,
  CLONE_NEWPID: 0x20000000,
  CLONE_NEWNET: 0x40000000,
});

const linuxMountFlags = Object.freeze({
  MS_RDONLY: 0x00000001,
  MS_NOSUID: 0x00000002,
  MS_NODEV: 0x00000004,
  MS_NOEXEC: 0x00000008,
  MS_BIND: 0x00001000,
  MS_REC: 0x00004000,
  MS_SILENT: 0x00008000,
  MS_PRIVATE: 0x00040000,
  MS_SLAVE: 0x00080000,
  MS_REMOUNT: 0x00000020,
  MS_NOATIME: 0x00000400,
  MS_NODIRATIME: 0x00000800,
  MS_RELATIME: 0x00200000,
  MS_MGC_VAL: 0xc0ed0000,
});

const mountNamespaceCloneFlags =
  linuxCloneFlags.CLONE_NEWUSER | linuxCloneFlags.CLONE_NEWNS | linuxCloneFlags.SIGCHLD;
const namespaceCloneFlags = Object.freeze([
  mountNamespaceCloneFlags,
  mountNamespaceCloneFlags | linuxCloneFlags.CLONE_NEWPID | linuxCloneFlags.CLONE_NEWIPC,
  mountNamespaceCloneFlags |
    linuxCloneFlags.CLONE_NEWNET |
    linuxCloneFlags.CLONE_NEWPID |
    linuxCloneFlags.CLONE_NEWIPC,
]);

function bindMountFlagAllowlist() {
  const base =
    linuxMountFlags.MS_BIND |
    linuxMountFlags.MS_SILENT |
    linuxMountFlags.MS_REMOUNT |
    linuxMountFlags.MS_NOSUID;
  const variable = [
    linuxMountFlags.MS_RDONLY,
    linuxMountFlags.MS_NODEV,
    linuxMountFlags.MS_NOEXEC,
    linuxMountFlags.MS_NOATIME,
    linuxMountFlags.MS_NODIRATIME,
    linuxMountFlags.MS_RELATIME,
  ];
  const flags = [];

  function append(index, value) {
    if (index === variable.length) {
      flags.push(value);
      return;
    }
    append(index + 1, value);
    append(index + 1, value | variable[index]);
  }

  append(0, base);
  return flags;
}

function codexBwrapAdditionalSyscalls() {
  const directMountFlags = [
    linuxMountFlags.MS_NOSUID | linuxMountFlags.MS_NODEV,
    linuxMountFlags.MS_NOSUID | linuxMountFlags.MS_NOEXEC,
    linuxMountFlags.MS_NOSUID | linuxMountFlags.MS_NODEV | linuxMountFlags.MS_NOEXEC,
    linuxMountFlags.MS_SILENT | linuxMountFlags.MS_BIND,
    linuxMountFlags.MS_SILENT | linuxMountFlags.MS_BIND | linuxMountFlags.MS_REC,
    linuxMountFlags.MS_SILENT | linuxMountFlags.MS_PRIVATE | linuxMountFlags.MS_REC,
    linuxMountFlags.MS_SILENT | linuxMountFlags.MS_SLAVE | linuxMountFlags.MS_REC,
    (linuxMountFlags.MS_MGC_VAL |
      linuxMountFlags.MS_BIND |
      linuxMountFlags.MS_SILENT |
      linuxMountFlags.MS_REC) >>>
      0,
  ].sort((left, right) => left - right);
  const mountFlags = [...directMountFlags, ...bindMountFlagAllowlist()];

  return [
    ...namespaceCloneFlags.map((flags) => allowSyscall("clone", 0, flags)),
    allowSyscall("unshare", 0, linuxCloneFlags.CLONE_NEWUSER),
    ...mountFlags.map((flags) => allowSyscall("mount", 3, flags)),
    allowSyscall("pivot_root"),
    allowSyscall("umount2", 1, 2),
  ];
}

function assertSyscallRule(rule, description) {
  assert.equal(typeof rule, "object", `${description} syscall rule must be an object.`);
  assert.ok(Array.isArray(rule.names), `${description} syscall rule names must be an array.`);
  assert.ok(rule.names.length > 0, `${description} syscall rule must name at least one syscall.`);
  for (const name of rule.names) {
    assert.equal(typeof name, "string", `${description} syscall names must be strings.`);
    assert.ok(name.length > 0, `${description} syscall names must be non-empty.`);
  }
  assert.equal(typeof rule.action, "string", `${description} syscall action must be a string.`);
  if (rule.args !== undefined) {
    assert.ok(Array.isArray(rule.args), `${description} syscall args must be an array.`);
    for (const arg of rule.args) {
      assert.equal(typeof arg.index, "number", `${description} syscall arg index must be numeric.`);
      assert.equal(typeof arg.op, "string", `${description} syscall arg op must be a string.`);
      assert.equal(typeof arg.value, "number", `${description} syscall arg value must be numeric.`);
    }
  }
}

function reviewedArchitectureGroupDescription() {
  return supportedSeccompArchitectureGroups
    .map((group) => [group.native, ...group.compatible].join(", "))
    .join(" or ");
}

function assertSupportedArchitectures(architectures, description) {
  const matchingGroups = supportedSeccompArchitectureGroups.filter((group) => {
    const allowed = new Set([group.native, ...group.compatible]);
    return (
      architectures.includes(group.native) &&
      architectures.every((architecture) => allowed.has(architecture))
    );
  });

  assert.equal(
    matchingGroups.length,
    1,
    `${description} contains unsupported seccomp architecture grouping: ${architectures.join(
      ", ",
    )}. Codex bwrap syscall argument allowlists are reviewed only for native groups ${reviewedArchitectureGroupDescription()}.`,
  );
}

function assertReviewedCodexVersion(codexVersion) {
  assert.ok(
    reviewedCodexVersions.includes(codexVersion),
    `Codex seccomp profile verification is limited to reviewed Codex versions: ${reviewedCodexVersions.join(
      ", ",
    )}.`,
  );
}

function validateRuntimeDefaultSeccompProfile(
  profile,
  description = "RuntimeDefault seccomp profile",
) {
  assert.equal(typeof profile, "object", `${description} must be an object.`);
  assert.equal(
    profile.defaultAction,
    "SCMP_ACT_ERRNO",
    `${description} must default-deny with SCMP_ACT_ERRNO.`,
  );
  assert.ok(Array.isArray(profile.architectures), `${description} must name architectures.`);
  assert.ok(
    profile.architectures.length > 0,
    `${description} must name at least one architecture.`,
  );
  for (const architecture of profile.architectures) {
    assert.equal(
      typeof architecture,
      "string",
      `${description} seccomp architectures must be strings.`,
    );
  }
  assertSupportedArchitectures(profile.architectures, description);
  assert.ok(Array.isArray(profile.syscalls), `${description} must contain syscall rules.`);
  assert.ok(profile.syscalls.length > 0, `${description} syscall rules must be non-empty.`);
  for (const rule of profile.syscalls) {
    assertSyscallRule(rule, description);
  }
  assert.ok(
    profile.syscalls.some(
      (rule) =>
        rule.action === "SCMP_ACT_ERRNO" &&
        rule.errnoRet === 38 &&
        Array.isArray(rule.names) &&
        rule.names.includes("clone3"),
    ),
    `${description} must preserve the containerd clone3 ENOSYS rule.`,
  );
}

function deriveCodexBwrapProfile(baseline, { codexVersion = "0.156.0" } = {}) {
  assertReviewedCodexVersion(codexVersion);
  validateRuntimeDefaultSeccompProfile(baseline);
  const profile = structuredClone(baseline);
  profile.syscalls = [...profile.syscalls, ...codexBwrapAdditionalSyscalls()];
  return profile;
}

function buildCodexBwrapProfileArtifact({ baseline, codexVersion }) {
  const profile = deriveCodexBwrapProfile(baseline, { codexVersion });
  const baselineJson = stableJson(baseline);
  const profileJson = stableJson(profile);

  return {
    profile,
    profileJson,
    provenance: {
      codexVersion,
      sourceProvenance: codexBwrapSourceProvenance,
      architectures: profile.architectures,
      runtimeDefaultSha256: sha256Hex(baselineJson),
      profileSha256: sha256Hex(profileJson),
      addedRules: codexBwrapAdditionalSyscalls().length,
      proofLimits: [
        "Generated from an operator-captured RuntimeDefault OCI seccomp profile.",
        "Architecture proof is limited to native x86_64 with x86/x32 compat entries or native aarch64 with ARM compat entries.",
        "The generated profile must still be installed and verified on each selected node.",
      ],
    },
  };
}

export {
  assertReviewedCodexVersion,
  buildCodexBwrapProfileArtifact,
  codexBwrapAdditionalSyscalls,
  codexBwrapSourceProvenance,
  deriveCodexBwrapProfile,
  reviewedCodexVersions,
  sha256Hex,
  stableJson,
  supportedSeccompArchitectureGroups,
  validateRuntimeDefaultSeccompProfile,
};
