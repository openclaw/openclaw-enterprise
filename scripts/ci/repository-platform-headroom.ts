#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { Stats } from "node:fs";
import { lstat, readFile, realpath, statfs } from "node:fs/promises";

type Stage = "hosted-guard" | "sdk-guard" | "sdk-removal" | "capacity-guard" | "complete";
type Status = "passed" | "failed";

interface Capacity {
  availableBytes: number;
  capacityBytes: number;
  inodesFree: number;
  inodes: number;
}

interface Removal {
  roots: string[];
  status: Status | "pending";
  durationMs?: number;
}

interface RemovalResult {
  status: "fulfilled" | "rejected";
}

interface Receipt {
  kind: "repository-platform-capacity";
  lane: string | undefined;
  sourceSha: string | undefined;
  status: Status;
  stage: Stage;
  sdkRemoved: boolean;
  rootsRemoved: string[];
  rootsSkipped: string[];
  before?: Capacity;
  minimumAvailableBytes?: number;
  removalSkipped?: "capacity-sufficient";
  removals?: Removal[];
  after?: Capacity;
  availableBytesDelta?: number;
}

// The subprocess emits Buffer data because neither pipe has an encoding.
interface CommandPipe {
  on(event: "data", listener: (chunk: Buffer) => void): void;
  destroy(): void;
}

interface RunningCommand {
  readonly pid?: number | undefined;
  readonly stdout: CommandPipe;
  readonly stderr: CommandPipe;
  once(event: "error", listener: (error: Error) => void): void;
  once(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): void;
  unref(): void;
}

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
const supportedLanes = [
  "openshell",
  "container-runtime-build",
  "k3d-quickstart",
  "k3d-observability",
  "k3d-observability-demo",
] as const;
type Lane = (typeof supportedLanes)[number];
const requestedLane = process.env.OPENCLAW_CI_HEADROOM_LANE;
const lane: Lane | undefined = supportedLanes.find(
  (supportedLane) => supportedLane === requestedLane,
);
const observability = lane === "k3d-observability" || lane === "k3d-observability-demo";
const receipt: Receipt = {
  kind: "repository-platform-capacity",
  lane: requestedLane,
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
function execute(command: string, args: string[], timeout: number): Promise<string> {
  return new Promise<string>((resolveResult, reject: (reason: Error) => void) => {
    const child: RunningCommand = spawn(command, args, {
      cwd: "/",
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C.UTF-8" },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let bytes = 0;
    let failed = false;
    let settled = false;
    let joinTimer: NodeJS.Timeout | undefined;
    const kill = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* Already exited. */
        }
      }
    };
    const finish = (code: number | null) => {
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
    const collect = (chunk: Buffer, output: boolean) => {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) {
        stop();
      } else if (output && !failed) {
        stdout += chunk.toString();
      }
    };
    const timer = setTimeout(stop, timeout);
    child.stdout.on("data", (chunk: Buffer) => collect(chunk, true));
    child.stderr.on("data", (chunk: Buffer) => collect(chunk, false));
    child.once("error", stop);
    child.once("close", finish);
  });
}

async function capacity(): Promise<Capacity> {
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

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function guardRemovalRoot(
  root: string,
  rootInfo: Stats,
  mounts: string,
  required: boolean,
): Promise<boolean> {
  let info: Stats;
  try {
    info = await lstat(root);
  } catch (error) {
    if (!isMissing(error)) {
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
  assert(safe || !required, "Required cleanup root failed safety checks.");
  return safe;
}

async function main(): Promise<void> {
  assert(
    process.env.GITHUB_ACTIONS === "true" && process.env.RUNNER_ENVIRONMENT === "github-hosted",
  );
  assert(
    process.platform === "linux" &&
      process.env.RUNNER_OS === "Linux" &&
      (process.env.ImageOS === "ubuntu24" || (observability && process.env.ImageOS === "ubuntu22")),
  );
  assert(
    receipt.sourceSha &&
      /^\d+$/.test(process.env.GITHUB_RUN_ID ?? "") &&
      /^\d+$/.test(process.env.GITHUB_RUN_ATTEMPT ?? ""),
  );
  assert(lane && process.argv.length === 2);
  const os = await readFile("/etc/os-release", "utf8");
  const expectedVersion = process.env.ImageOS === "ubuntu22" ? "22.04" : "24.04";
  assert(/^ID=ubuntu$/m.test(os) && os.split("\n").includes(`VERSION_ID="${expectedVersion}"`));
  receipt.before = await capacity();
  receipt.minimumAvailableBytes = minimumRuntimeAvailableBytes;
  // Current hosted images already leave far more than the minimum free (about
  // 84 GiB on ubuntu-22.04), and deleting the SDK trees costs 60-160 s. Keep
  // them when the disk already passes the same guard checked after removal.
  if (receipt.before.availableBytes >= minimumRuntimeAvailableBytes) {
    receipt.stage = "complete";
    receipt.status = "passed";
    receipt.removalSkipped = "capacity-sufficient";
    return;
  }
  receipt.stage = "sdk-guard";
  assert(
    process.env.ANDROID_HOME === `${androidRoot}/sdk` &&
      process.env.ANDROID_SDK_ROOT === `${androidRoot}/sdk`,
  );
  const rootInfo = await lstat("/");
  const mounts = await readFile("/proc/self/mountinfo", "utf8");
  const removalRoots = [androidRoot];
  assert(await guardRemovalRoot(androidRoot, rootInfo, mounts, true));
  for (const root of runtimeOnlyRoots) {
    // OpenShell tests still use the installed Go and Python toolchains.
    if (
      lane === "openshell" &&
      [
        "/opt/hostedtoolcache/go",
        "/opt/hostedtoolcache/Python",
        "/opt/hostedtoolcache/PyPy",
      ].includes(root)
    ) {
      receipt.rootsSkipped.push(root);
      continue;
    }
    if (await guardRemovalRoot(root, rootInfo, mounts, false)) {
      removalRoots.push(root);
    } else {
      receipt.rootsSkipped.push(root);
    }
  }
  receipt.stage = "sdk-removal";
  const groups = observability ? removalRoots.map((root) => [root]) : [removalRoots];
  const timeoutSeconds = observability ? 600 : 240;
  receipt.removals = groups.map((roots) => ({ roots, status: "pending" }));
  // All roots have passed the ownership/mount guards. The fixed, disjoint SDK
  // roots can be removed together; settle every process before checking capacity.
  const removals: RemovalResult[] = await Promise.allSettled(
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
            assert(isMissing(error));
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
  receipt.stage = "capacity-guard";
  assert((await capacity()).availableBytes >= minimumRuntimeAvailableBytes);
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
