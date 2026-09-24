#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { lstat, readFile, realpath, statfs } from "node:fs/promises";

// These fixed runner-image components are unused by the selected jobs. Never
// derive a deletion target from workflow inputs or runner environment values.
const androidRoot = "/usr/local/lib/android";
const runtimeOnlyRoots = [
  "/opt/az",
  "/opt/hostedtoolcache/PyPy",
  "/opt/hostedtoolcache/Python",
  "/opt/hostedtoolcache/Ruby",
  "/opt/hostedtoolcache/go",
  "/usr/local/.ghcup",
  "/usr/local/share/vcpkg",
  "/usr/share/dotnet",
  "/usr/share/miniconda",
  "/usr/share/swift",
];
const minimumRuntimeAvailableBytes = 36 * 1024 ** 3;
const largeImageLane = [
  "container-runtime-build",
  "k3d-observability",
  "k3d-observability-demo",
].includes(process.env.OPENCLAW_CI_HEADROOM_LANE);
const receipt = {
  kind: "repository-platform-capacity",
  lane: process.env.OPENCLAW_CI_HEADROOM_LANE,
  sourceSha: /^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA ?? "")
    ? process.env.GITHUB_SHA
    : undefined,
  status: "failed",
  stage: "hosted-guard",
  sdkRemoved: false,
  rootsRemoved: [],
  rootsSkipped: [],
};

// Bound the command and its descendants; never forward raw command output.
function execute(command, args, timeout = 30_000) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      cwd: "/",
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C.UTF-8" },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let bytes = 0;
    let failed = false;
    let settled = false;
    let joinTimer;
    const kill = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* Already exited. */
        }
      }
    };
    const finish = (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(joinTimer);
      kill();
      if (failed || code !== 0) {
        reject(new Error("Headroom command failed."));
      } else {
        resolveResult(stdout);
      }
    };
    const stop = () => {
      failed = true;
      kill();
      joinTimer ??= setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        finish(null);
      }, 1_000);
    };
    const collect = (chunk, output) => {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) {
        stop();
      } else if (output && !failed) {
        stdout += chunk;
      }
    };
    const timer = setTimeout(stop, timeout);
    child.stdout.on("data", (chunk) => collect(chunk, true));
    child.stderr.on("data", (chunk) => collect(chunk, false));
    child.once("error", stop);
    child.once("close", finish);
  });
}

async function capacity() {
  const info = await statfs("/");
  const counters = {
    availableBytes: info.bavail * info.bsize,
    capacityBytes: info.blocks * info.bsize,
    inodesFree: info.ffree,
    inodes: info.files,
  };
  assert(Object.values(counters).every((value) => Number.isSafeInteger(value) && value >= 0));
  assert(counters.capacityBytes > 0 && counters.availableBytes <= counters.capacityBytes);
  return counters;
}

async function guardRemovalRoot(root, rootInfo, mounts, required) {
  let info;
  try {
    info = await lstat(root);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
    assert(!required);
    return false;
  }
  const safe =
    info.isDirectory() &&
    !info.isSymbolicLink() &&
    info.uid === 0 &&
    (await realpath(root)) === root &&
    info.dev === rootInfo.dev &&
    !mounts.split("\n").some((line) => {
      const path = line.split(" ")[4];
      return path === root || path?.startsWith(`${root}/`);
    });
  assert(safe || !required, required ? "Required cleanup root failed safety checks." : undefined);
  return safe;
}

async function main() {
  assert(
    process.env.GITHUB_ACTIONS === "true" && process.env.RUNNER_ENVIRONMENT === "github-hosted",
  );
  assert(
    process.platform === "linux" &&
      process.env.RUNNER_OS === "Linux" &&
      (process.env.ImageOS === "ubuntu24" ||
        (["k3d-observability", "k3d-observability-demo"].includes(
          process.env.OPENCLAW_CI_HEADROOM_LANE,
        ) &&
          process.env.ImageOS === "ubuntu22")),
  );
  assert(
    receipt.sourceSha &&
      /^\d+$/.test(process.env.GITHUB_RUN_ID ?? "") &&
      /^\d+$/.test(process.env.GITHUB_RUN_ATTEMPT ?? ""),
  );
  assert(
    [
      "repository-credentials-platform",
      "container-runtime-build",
      "k3d-observability",
      "k3d-observability-demo",
    ].includes(process.env.OPENCLAW_CI_HEADROOM_LANE) && process.argv.length === 2,
  );
  const os = await readFile("/etc/os-release", "utf8");
  const expectedVersion = process.env.ImageOS === "ubuntu22" ? "22.04" : "24.04";
  assert(/^ID=ubuntu$/m.test(os) && os.split("\n").includes(`VERSION_ID="${expectedVersion}"`));
  receipt.before = await capacity();
  receipt.stage = "sdk-guard";
  assert(
    process.env.ANDROID_HOME === `${androidRoot}/sdk` &&
      process.env.ANDROID_SDK_ROOT === `${androidRoot}/sdk`,
  );
  const rootInfo = await lstat("/");
  const mounts = await readFile("/proc/self/mountinfo", "utf8");
  const removalRoots = [androidRoot];
  assert(await guardRemovalRoot(androidRoot, rootInfo, mounts, true));
  if (largeImageLane) {
    for (const root of runtimeOnlyRoots) {
      if (await guardRemovalRoot(root, rootInfo, mounts, false)) {
        removalRoots.push(root);
      } else {
        receipt.rootsSkipped.push(root);
      }
    }
  }
  receipt.stage = "sdk-removal";
  const observability = ["k3d-observability", "k3d-observability-demo"].includes(receipt.lane);
  const groups = observability ? removalRoots.map((root) => [root]) : [removalRoots];
  const timeoutSeconds = observability ? 600 : 240;
  receipt.removals = groups.map((roots) => ({ roots, status: "pending" }));
  // All roots have passed the ownership/mount guards. The fixed, disjoint SDK
  // roots can be removed together; settle every process before checking capacity.
  const removals = await Promise.allSettled(
    receipt.removals.map(async (removal) => {
      const started = performance.now();
      removal.status = "failed";
      try {
        // The privileged timeout can terminate root-owned rm; the runner cannot.
        await execute(
          "/usr/bin/sudo",
          [
            "-n",
            "--",
            "/usr/bin/timeout",
            "--signal=TERM",
            "--kill-after=5s",
            `${timeoutSeconds}s`,
            "/usr/bin/rm",
            "--recursive",
            "--force",
            "--one-file-system",
            "--preserve-root=all",
            "--",
            ...removal.roots,
          ],
          (timeoutSeconds + 10) * 1_000,
        );
        for (const root of removal.roots) {
          try {
            await lstat(root);
            assert.fail("Runner cleanup incomplete.");
          } catch (error) {
            assert(error.code === "ENOENT");
          }
        }
        removal.status = "passed";
      } finally {
        removal.durationMs = Math.round(performance.now() - started);
      }
    }),
  );
  receipt.rootsRemoved = receipt.removals
    .filter(({ status }) => status === "passed")
    .flatMap(({ roots }) => roots);
  assert(removals.every(({ status }) => status === "fulfilled"));
  receipt.sdkRemoved = true;
  if (largeImageLane) {
    receipt.minimumAvailableBytes = minimumRuntimeAvailableBytes;
    receipt.stage = "capacity-guard";
    assert((await capacity()).availableBytes >= minimumRuntimeAvailableBytes);
  }
  receipt.stage = "complete";
  receipt.status = "passed";
}

try {
  await main();
} catch {
  process.exitCode = 1;
} finally {
  if (receipt.before) {
    try {
      receipt.after = await capacity();
      receipt.availableBytesDelta = receipt.after.availableBytes - receipt.before.availableBytes;
    } catch {
      receipt.status = "failed";
      process.exitCode = 1;
    }
  }
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}
