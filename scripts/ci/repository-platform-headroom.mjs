#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { lstat, readFile, realpath, statfs } from "node:fs/promises";

// This fixed runner-image component is unused by these build/test jobs. Never
// derive a deletion target from workflow inputs or Android environment values.
const androidRoot = "/usr/local/lib/android";
const receipt = {
  kind: "repository-platform-capacity",
  lane: process.env.OPENCLAW_CI_HEADROOM_LANE,
  sourceSha: /^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA ?? "")
    ? process.env.GITHUB_SHA
    : undefined,
  status: "failed",
  stage: "hosted-guard",
  sdkRemoved: false,
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

async function main() {
  assert(
    process.env.GITHUB_ACTIONS === "true" && process.env.RUNNER_ENVIRONMENT === "github-hosted",
  );
  assert(
    process.platform === "linux" &&
      process.env.RUNNER_OS === "Linux" &&
      process.env.ImageOS === "ubuntu24",
  );
  assert(
    receipt.sourceSha &&
      /^\d+$/.test(process.env.GITHUB_RUN_ID ?? "") &&
      /^\d+$/.test(process.env.GITHUB_RUN_ATTEMPT ?? ""),
  );
  assert(
    ["repository-credentials-platform", "container-runtime-build"].includes(
      process.env.OPENCLAW_CI_HEADROOM_LANE,
    ) && process.argv.length === 2,
  );
  const os = await readFile("/etc/os-release", "utf8");
  assert(/^ID=ubuntu$/m.test(os) && /^VERSION_ID="24\.04"$/m.test(os));
  receipt.before = await capacity();
  receipt.stage = "sdk-guard";
  assert(
    process.env.ANDROID_HOME === `${androidRoot}/sdk` &&
      process.env.ANDROID_SDK_ROOT === `${androidRoot}/sdk`,
  );
  const info = await lstat(androidRoot);
  assert(info.isDirectory() && !info.isSymbolicLink() && info.uid === 0);
  assert((await realpath(androidRoot)) === androidRoot);
  assert(info.dev === (await lstat("/")).dev);
  const mounts = await readFile("/proc/self/mountinfo", "utf8");
  assert(
    !mounts.split("\n").some((line) => {
      const path = line.split(" ")[4];
      return path === androidRoot || path?.startsWith(`${androidRoot}/`);
    }),
  );
  receipt.stage = "sdk-removal";
  // The privileged timeout can terminate root-owned rm; the runner cannot.
  await execute(
    "/usr/bin/sudo",
    [
      "-n",
      "--",
      "/usr/bin/timeout",
      "--signal=TERM",
      "--kill-after=5s",
      "120s",
      "/usr/bin/rm",
      "--recursive",
      "--force",
      "--one-file-system",
      "--preserve-root=all",
      "--",
      androidRoot,
    ],
    130_000,
  );
  try {
    await lstat(androidRoot);
    assert.fail("SDK removal incomplete.");
  } catch (error) {
    assert(error.code === "ENOENT");
  }
  receipt.sdkRemoved = true;
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
