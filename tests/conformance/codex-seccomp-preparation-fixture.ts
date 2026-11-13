import assert from "node:assert/strict";
import type { SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { prepareCodexSeccompProfile } from "../../scripts/lib/codex-seccomp-k3d.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

export const repositoryRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));

export const runtimeDefaultBaseline = Object.freeze({
  architectures: ["SCMP_ARCH_X86_64", "SCMP_ARCH_X86", "SCMP_ARCH_X32"],
  defaultAction: "SCMP_ACT_ERRNO",
  syscalls: [
    { names: ["read"], action: "SCMP_ACT_ALLOW" },
    { names: ["clone3"], action: "SCMP_ACT_ERRNO", errnoRet: 38 },
  ],
});

export function fixture(t: Parameters<typeof temporaryDirectory>[0]) {
  return temporaryDirectory(t, "codex-seccomp-profile-test-");
}

export async function writeJson(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

// The helper sleeps 750 ms between Pod reads and measures its deadline with
// Date.now(). A mocked clock fires each armed poll delay at once and moves
// Date.now() forward by the same 750 ms, so every deadline and read count below
// is the one a real wait would produce, without the wall time.
async function withMockedPollClock<T>(t: TestContext, operation: () => Promise<T>) {
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
      await new Promise<void>((resolve) => setImmediate(resolve));
      t.mock.timers.runAll();
    }
    return await result;
  } finally {
    t.mock.timers.reset();
  }
}

// Synthetic receipts exercise classification; runGeneratedProbe executes the actual shell.
export function probeEvidence(
  args: readonly string[],
  stage: string,
  exit: number,
  entered: boolean,
  detail = "",
) {
  const nonce = args.at(-1);
  const message = "the owning helper must generate an invocation binding";
  assert.ok(typeof nonce === "string", message);
  assert.match(nonce, /^[a-f0-9]{32}$/, message);
  const prefix = `OCE_SANDBOX_PROBE_V1:${nonce}:`;
  return `${prefix}START\n${entered ? `${prefix}ENTERED\n` : ""}${detail ? `${detail}\n` : ""}${prefix}END:${stage}:${exit}\n`;
}

const baselineContainerId = "b".repeat(64);
export const installedContainerId = "c".repeat(64);
export const probePodUid = "8c00ce88-c148-4c3e-a2e8-32c4dbf39c89";
export const probeImageDigest = `sha256:${"a".repeat(64)}`;

type PreparationOptions = NonNullable<Parameters<typeof prepareCodexSeccompProfile>[0]>;
type CommandResult = Pick<SpawnSyncReturns<string>, "stdout" | "stderr"> & {
  exitCode?: SpawnSyncReturns<string>["status"];
  code?: number;
  signal?: SpawnSyncReturns<string>["signal"];
  killed?: boolean;
  timedOut?: boolean;
};

// The preparation entrypoint is JavaScript and does not type its injected command.
type ExecFile = (
  command: string,
  args: string[],
  options: { timeoutMs: NonNullable<PreparationOptions["commandTimeoutMs"]> },
) => Promise<CommandResult>;

type MissingProfileFixtureOptions = {
  beforeCleanup?: () => void;
  cleanupError?: Error;
  baselineStderr?: string;
  probeExec?: (
    args: Parameters<ExecFile>[1],
    context: { baseline: boolean; root: string },
  ) => CommandResult | ReturnType<ExecFile>;
  prepareProfile?: (options: {
    cluster: { name: string; directory: string; kubeconfig: string; context: string };
    image: string;
    execFile: ExecFile;
    timeoutMs: NonNullable<PreparationOptions["timeoutMs"]>;
  }) => Promise<unknown>;
  timeoutMs?: PreparationOptions["timeoutMs"];
};

type ProbeStatus = {
  name: string;
  containerID?: string;
  state?: { waiting: { reason: string; message?: string } };
};

type MissingProfileObservation = ProbeStatus | Error | ((profile: string) => ProbeStatus | Error);

type AppliedProbePod = {
  metadata: { name: string };
  spec: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertAppliedProbePod(value: unknown): asserts value is AppliedProbePod {
  assert.ok(
    isRecord(value) &&
      isRecord(value.metadata) &&
      typeof value.metadata.name === "string" &&
      isRecord(value.spec),
    "expected a probe manifest with a Pod name and spec",
  );
}

function containerSeccompProfile(pod: AppliedProbePod) {
  const containers = pod.spec.containers;
  assert.ok(Array.isArray(containers), "expected probe containers");
  const container: unknown = containers[0];
  assert.ok(
    isRecord(container) && isRecord(container.securityContext),
    "expected a probe container security context",
  );
  const profile = container.securityContext.seccompProfile;
  assert.ok(profile === undefined || isRecord(profile), "expected a seccomp profile object");
  return profile;
}

// Exercise the real preparation/cleanup path with injected command responses.
// These ordered API observations are synthetic, not a claimed live Pod transition.
export async function missingProfileFixture(
  t: TestContext,
  observations: readonly [MissingProfileObservation, ...MissingProfileObservation[]],
  options: MissingProfileFixtureOptions = {},
) {
  const root = await fixture(t);
  const directory = join(root, "openclaw-k8s-poll-owned");
  await mkdir(directory);
  const cluster = {
    name: "openclaw-k8s-poll",
    directory,
    kubeconfig: join(directory, "kubeconfig"),
    context: "k3d-openclaw-k8s-poll",
  };
  const applied = new Map<string, AppliedProbePod>();
  let installedProfile: unknown;
  let missingReads = 0;
  let cleanupCalls = 0;
  let installations = 0;
  const execFile: ExecFile = async (command, args) => {
    // Like a real child process, every injected command completes on a later turn.
    // This also lets withMockedPollClock's guard run between polls: a poll loop
    // that stayed on the microtask queue would starve it.
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (command === "kubectl") {
      if (args.includes("create")) {
        return { stdout: "", stderr: "" };
      }
      if (args.includes("delete")) {
        cleanupCalls += 1;
        options.beforeCleanup?.();
        assert.ok(args.includes("--wait=false"));
        if (options.cleanupError) {
          throw options.cleanupError;
        }
        return { stdout: "", stderr: "" };
      }
      if (args.includes("apply")) {
        const path = args.at(-1);
        assert.ok(path !== undefined, "kubectl apply must supply a manifest path");
        const manifest: unknown = JSON.parse(await readFile(path, "utf8"));
        assertAppliedProbePod(manifest);
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
        assert.ok(name !== undefined, "kubectl get pod must supply a name");
        const pod = applied.get(name);
        assert.ok(pod, "kubectl get pod must refer to an applied probe");
        const profile = containerSeccompProfile(pod)?.localhostProfile;
        assert.ok(profile === undefined || typeof profile === "string");
        if (profile?.includes("missing-")) {
          const entry = observations[Math.min(missingReads, observations.length - 1)];
          assert.ok(entry !== undefined, "expected a missing-profile observation");
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
            ...pod,
            metadata: { name, uid: probePodUid },
            status: {
              containerStatuses: [
                {
                  name: "probe",
                  ready: true,
                  imageID: `registry.invalid/runtime@${probeImageDigest}`,
                  containerID: `containerd://${profile ? installedContainerId : baselineContainerId}`,
                },
              ],
            },
          }),
          stderr: "",
        };
      }
      if (args.includes("exec")) {
        const name = args[args.indexOf("exec") + 1];
        assert.ok(name !== undefined, "kubectl exec must supply a Pod name");
        const pod = applied.get(name);
        assert.ok(pod, "kubectl exec must refer to an applied probe");
        const baseline = !containerSeccompProfile(pod);
        if (options.probeExec) {
          return options.probeExec(args, { baseline, root });
        }
        if (baseline) {
          throw Object.assign(new Error("RuntimeDefault denied namespace creation"), {
            exitCode: 1,
            signal: null,
            timedOut: false,
            stderr:
              options.baselineStderr ??
              probeEvidence(args, "SANDBOX", 1, false, "bwrap namespace denied by seccomp"),
          });
        }
        return { stdout: "", stderr: probeEvidence(args, "DONE", 0, true) };
      }
    }
    if (command === "docker") {
      if (args[0] === "exec" && args[2] === "crictl") {
        const seccomp = args[4] === baselineContainerId ? runtimeDefaultBaseline : installedProfile;
        return {
          stdout: JSON.stringify({ info: { runtimeSpec: { linux: { seccomp } } } }),
          stderr: "",
        };
      }
      if (args[0] === "cp") {
        installations += 1;
        const sourcePath = args[1];
        assert.ok(sourcePath !== undefined, "docker cp must supply a source profile path");
        installedProfile = JSON.parse(await readFile(sourcePath, "utf8"));
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "exec" && (args[2] === "mkdir" || args[2] === "chmod")) {
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
    run: (): Promise<unknown> =>
      withMockedPollClock<unknown>(t, () =>
        (options.prepareProfile ?? prepareCodexSeccompProfile)({
          cluster,
          image: `registry.invalid/runtime@${probeImageDigest}`,
          execFile,
          timeoutMs: options.timeoutMs ?? 2_000,
        }),
      ),
    reads: () => missingReads,
    installations: () => installations,
    applied: () => [...applied.values()],
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
export const missingProfileMessage = (profile: string) => {
  const path = `/var/lib/kubelet/seccomp/${profile}`;
  return `cannot load seccomp profile ${JSON.stringify(path)}: open ${path}: no such file or directory`;
};
export const profileWaiting = (message: string) => ({
  name: "probe",
  state: { waiting: { reason: "CreateContainerError", message } },
});
export const missingProfileWaiting = (profile: string) =>
  profileWaiting(`failed to create containerd container: ${missingProfileMessage(profile)}`);
export const reportedContainer = { name: "probe", containerID: "containerd://reported-probe" };
