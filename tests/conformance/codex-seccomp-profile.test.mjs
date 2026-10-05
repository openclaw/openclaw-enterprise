import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  codexBwrapAdditionalSyscalls,
  deriveCodexBwrapProfile,
} from "../../scripts/lib/codex-seccomp-profile.mjs";

import { prepareCodexSeccompProfile } from "../../scripts/lib/codex-seccomp-k3d.mjs";

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
  const profile = deriveCodexBwrapProfile(runtimeDefaultBaseline, { codexVersion: "0.160.0" });
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
      "0.160.0",
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
  assert.equal(provenance.codexVersion, "0.160.0");
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
      "0.160.0",
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

// The helper sleeps 750 ms between Pod reads and measures its deadline with
// Date.now(). A mocked clock fires each armed poll delay at once and moves
// Date.now() forward by the same 750 ms, so every deadline and read count below
// is the one a real wait would produce, without the wall time.
async function withMockedPollClock(t, operation) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  try {
    let settled = false;
    const result = operation();
    result.then(
      () => (settled = true),
      () => (settled = true),
    );
    // performance.now() is not mocked. A helper that polls without arming its
    // delay never advances the mocked clock, so fail fast instead of spinning;
    // each run settles within milliseconds otherwise.
    const started = performance.now();
    while (!settled) {
      assert.ok(
        performance.now() - started < 5_000,
        "the helper made no progress on the mocked clock within 5 s",
      );
      // setImmediate is not mocked: let file and injected-command work run, then
      // fire whichever poll delay the helper armed meanwhile.
      await new Promise((resolve) => setImmediate(resolve));
      t.mock.timers.runAll();
    }
    return await result;
  } finally {
    t.mock.timers.reset();
  }
}

// Exercise the real preparation/cleanup path with injected command responses.
// These ordered API observations are synthetic, not a claimed live Pod transition.
async function missingProfileFixture(t, observations, options = {}) {
  const root = await fixture(t);
  const directory = join(root, "openclaw-k8s-poll-owned");
  await mkdir(directory);
  const cluster = {
    name: "openclaw-k8s-poll",
    directory,
    kubeconfig: join(directory, "kubeconfig"),
    context: "k3d-openclaw-k8s-poll",
  };
  const applied = new Map();
  let installedProfile;
  let missingReads = 0;
  let cleanupCalls = 0;
  const execFile = async (command, args) => {
    // Like a real child process, every injected command completes on a later turn.
    // This also lets withMockedPollClock's guard run between polls: a poll loop
    // that stayed on the microtask queue would starve it.
    await new Promise((resolve) => setImmediate(resolve));
    if (command === "kubectl") {
      if (args.includes("create")) {
        return { stdout: "", stderr: "" };
      }
      if (args.includes("delete")) {
        cleanupCalls += 1;
        assert.ok(args.includes("--wait=false"));
        if (options.cleanupError) {
          throw options.cleanupError;
        }
        return { stdout: "", stderr: "" };
      }
      if (args.includes("apply")) {
        const manifest = JSON.parse(await readFile(args.at(-1), "utf8"));
        applied.set(manifest.metadata.name, manifest);
        return { stdout: "", stderr: "" };
      }
      if (args.includes("nodes")) {
        return {
          stdout: JSON.stringify({
            items: [{ metadata: { name: "k3d-openclaw-k8s-poll-server-0" } }],
          }),
          stderr: "",
        };
      }
      if (args.includes("pod")) {
        const name = args[args.indexOf("pod") + 1];
        const profile =
          applied.get(name).spec.containers[0].securityContext.seccompProfile?.localhostProfile;
        if (profile?.includes("missing-")) {
          const entry = observations[Math.min(missingReads, observations.length - 1)];
          const observation = typeof entry === "function" ? entry(profile) : entry;
          missingReads += 1;
          if (observation instanceof Error) {
            throw observation;
          }
          return {
            stdout: JSON.stringify({
              metadata: { name },
              status: { containerStatuses: [observation] },
            }),
            stderr: "",
          };
        }
        return {
          stdout: JSON.stringify({
            metadata: { name },
            status: {
              containerStatuses: [
                {
                  name: "probe",
                  ready: true,
                  containerID: `containerd://${profile ? "installed" : "runtime-default"}`,
                },
              ],
            },
          }),
          stderr: "",
        };
      }
      if (args.includes("exec")) {
        const name = args[args.indexOf("exec") + 1];
        if (!applied.get(name).spec.containers[0].securityContext.seccompProfile) {
          const error = new Error("RuntimeDefault denied namespace creation");
          error.stderr = "bwrap namespace denied by seccomp";
          throw error;
        }
        return { stdout: "", stderr: "" };
      }
    }
    if (command === "docker") {
      if (args[0] === "exec" && args[2] === "crictl") {
        const seccomp = args[4] === "runtime-default" ? runtimeDefaultBaseline : installedProfile;
        return {
          stdout: JSON.stringify({ info: { runtimeSpec: { linux: { seccomp } } } }),
          stderr: "",
        };
      }
      if (args[0] === "cp") {
        installedProfile = JSON.parse(await readFile(args[1], "utf8"));
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "exec" && ["mkdir", "chmod"].includes(args[2])) {
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "exec" && args[2] === "sha256sum") {
        const digest = createHash("sha256")
          .update(`${JSON.stringify(installedProfile, null, 2)}\n`)
          .digest("hex");
        return { stdout: `${digest}  ${args[4]}\n`, stderr: "" };
      }
    }
    throw new Error(`Unexpected injected command: ${command} ${args.join(" ")}`);
  };
  return {
    run: () =>
      withMockedPollClock(t, () =>
        prepareCodexSeccompProfile({
          cluster,
          image: `registry.invalid/runtime@sha256:${"a".repeat(64)}`,
          execFile,
          timeoutMs: options.timeoutMs ?? 2_000,
        }),
      ),
    reads: () => missingReads,
    async assertCleanup() {
      assert.equal(cleanupCalls, 1);
      assert.equal(
        (await readdir(directory)).some((name) => name.startsWith("codex-seccomp-")),
        false,
      );
    },
  };
}

// k3s v1.35.8+k3s1 selects containerd v2.2.7-k3s1. Its WithProfile
// error names the quoted profile path and os.ReadFile cause; CreateContainer wraps it.
const missingProfileMessage = (profile) => {
  const path = `/var/lib/kubelet/seccomp/${profile}`;
  return `cannot load seccomp profile ${JSON.stringify(path)}: open ${path}: no such file or directory`;
};
const profileWaiting = (message) => ({
  name: "probe",
  state: { waiting: { reason: "CreateContainerError", message } },
});
const missingProfileWaiting = (profile) =>
  profileWaiting(`failed to create containerd container: ${missingProfileMessage(profile)}`);
const reportedContainer = { name: "probe", containerID: "containerd://reported-probe" };

test("missing-profile preparation cannot forget a reported container before a later valid observation", async (t) => {
  const control = await missingProfileFixture(t, [reportedContainer, missingProfileWaiting]);
  await assert.rejects(
    control.run,
    /Missing localhost seccomp profile unexpectedly started a container/,
  );
  assert.equal(control.reads(), 1, "the semantic failure must stop polling immediately");
  await control.assertCleanup();
});

for (const [label, first] of [
  ["pending", { name: "probe", state: { waiting: { reason: "ContainerCreating" } } }],
  ["transient GET error", new Error("temporary API read unavailable")],
]) {
  test(`missing-profile preparation retries ${label} before a valid observation`, async (t) => {
    const control = await missingProfileFixture(t, [first, missingProfileWaiting]);
    const result = await control.run();
    assert.equal(result.profileName, "openclaw/codex-bwrap.json");
    assert.equal(control.reads(), 2);
    await control.assertCleanup();
  });
}

test("missing-profile preparation preserves pending timeout and cleanup", async (t) => {
  const control = await missingProfileFixture(t, [{ name: "probe" }], { timeoutMs: 5 });
  await assert.rejects(control.run, /Timed out waiting for Pod .* to fail closed/);
  assert.equal(control.reads(), 1);
  await control.assertCleanup();
});

test("missing-profile terminal failure remains primary when cleanup also fails", async (t) => {
  const cleanupError = new Error("namespace cleanup unavailable");
  const control = await missingProfileFixture(t, [reportedContainer, missingProfileWaiting], {
    cleanupError,
  });
  await assert.rejects(control.run, (error) => {
    assert.match(
      error.message,
      /^Missing localhost seccomp profile unexpectedly started a container/,
    );
    assert.match(error.message, /cleanup also failed: namespace cleanup unavailable/);
    assert.deepEqual(error.cleanupError.errors, [cleanupError]);
    return true;
  });
  assert.equal(control.reads(), 1);
  await control.assertCleanup();
});

for (const wrapped of [false, true]) {
  test(`missing-profile proof accepts the exact generated path (${wrapped ? "CRI wrapped" : "direct"})`, async (t) => {
    const control = await missingProfileFixture(t, [
      (profile) => {
        assert.match(profile, /^openclaw\/missing-[a-f0-9]+-codex-bwrap\.json$/);
        const message = missingProfileMessage(profile);
        return profileWaiting(
          wrapped ? `failed to create containerd container: ${message}` : message,
        );
      },
    ]);
    await control.run();
    assert.equal(control.reads(), 1);
    await control.assertCleanup();
  });
}

// All messages describe CreateContainerError, but none proves this generated file is missing.
for (const [label, message] of [
  [
    "AppArmor profile",
    (profile) =>
      `cannot load AppArmor profile "/var/lib/kubelet/seccomp/${profile}": no such file or directory`,
  ],
  ["another seccomp profile", () => missingProfileMessage("openclaw/wrong.json")],
  ["profile path prefix", (profile) => missingProfileMessage(`prefix/${profile}`)],
  ["profile path suffix", (profile) => missingProfileMessage(`${profile}.other`)],
  [
    "incidental expected path",
    (profile) =>
      `${missingProfileMessage("openclaw/wrong.json")} (expected /var/lib/kubelet/seccomp/${profile})`,
  ],
  ["generic profile text", () => "seccomp profile is not found"],
  [
    "permission denied",
    (profile) =>
      missingProfileMessage(profile).replace("no such file or directory", "permission denied"),
  ],
  [
    "malformed profile",
    (profile) =>
      `decoding seccomp profile failed "/var/lib/kubelet/seccomp/${profile}": invalid character`,
  ],
  [
    "unexpected diagnostic prefix",
    (profile) => `AppArmor failure: ${missingProfileMessage(profile)}`,
  ],
  ["unexpected diagnostic suffix", (profile) => `${missingProfileMessage(profile)}; another error`],
]) {
  test(`missing-profile proof rejects ${label} and cleans up`, async (t) => {
    const control = await missingProfileFixture(
      t,
      [(profile) => profileWaiting(message(profile))],
      {
        timeoutMs: 5,
      },
    );
    await assert.rejects(control.run, /Timed out waiting for Pod .* to fail closed/);
    assert.equal(control.reads(), 1);
    await control.assertCleanup();
  });
}
