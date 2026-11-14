import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { deriveCodexBwrapProfile } from "../../scripts/lib/codex-seccomp-profile.ts";
import { writeCommand } from "../helpers/fake-commands.ts";
import {
  fixture,
  installedContainerId,
  missingProfileFixture,
  missingProfileMessage,
  missingProfileWaiting,
  probeEvidence,
  probeImageDigest,
  probePodUid,
  profileWaiting,
  reportedContainer,
  repositoryRoot,
  runtimeDefaultBaseline,
  writeJson,
} from "./codex-seccomp-preparation-fixture.ts";

const generatedProbeFailures = [
  ["version", "VERSION", 64, false],
  ["prepare", "PREPARE", 73, false],
  ["unknown", "SANDBOX", 1, false],
  ["timeout", "SANDBOX", 124, false],
  ["missing", "SANDBOX", 127, false],
  ["escape", "SANDBOX", 70, true],
  ["assertion", "ASSERTIONS", 1, true],
  ["cleanup", "CLEANUP", 74, true],
] as const;

type GeneratedProbeMode = (typeof generatedProbeFailures)[number][0] | "denied" | "success";

type MalformedProcessStatus = {
  exitCode?: number | string | undefined;
  signal?: NodeJS.Signals | undefined;
  code?: number;
  killed?: boolean;
  timedOut?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The real helper delivers the shell asset and its positional inputs. Only its two resource roots are remapped
// into this fixture. The injected codex executable is inert: no sandbox, cluster
// or provider is run. Successful payload execution uses an ordinary read-only file
// to model the tested outside-workspace refusal; this is not isolation evidence.
async function runGeneratedProbe(args: readonly string[], root: string, mode: GeneratedProbeMode) {
  const shellArgs = args.slice(args.indexOf("--") + 2);
  assert.equal(shellArgs[0], "-c");
  assert.equal(shellArgs[2], "codex-sandbox-probe");
  assert.equal(shellArgs[3], "0.164.0");
  assert.ok(typeof shellArgs[4] === "string", "the probe must receive a nonce");
  assert.match(shellArgs[4], /^[a-f0-9]{32}$/);
  assert.equal(shellArgs.length, 5);
  assert.equal(
    shellArgs[1],
    await readFile(join(repositoryRoot, "scripts/lib/codex-sandbox-probe.sh"), "utf8"),
  );
  const syntax = spawnSync("/bin/sh", ["-n", ...shellArgs], {
    encoding: "utf8",
    timeout: 5_000,
  });
  assert.equal(syntax.error, undefined);
  assert.equal(syntax.status, 0, syntax.stderr);
  const tools = join(root, "tools");
  await mkdir(tools, { recursive: true });
  await writeCommand(
    tools,
    "codex",
    `if [ "$1" = --version ]; then
  if [ "$PROBE_MODE" = version ]; then echo 'codex 0.0.0'; else echo 'codex 0.164.0'; fi
  exit 0
fi
# Validate the real command's sandbox arguments, independently of its shell layout.
[ "$#" -eq 11 ] && [ "$1" = sandbox ] && [ "$2" = -c ] &&
  [ "$3" = sandbox_mode=workspace-write ] && [ "$4" = -c ] &&
  [ "$5" = sandbox_workspace_write.network_access=false ] &&
  [ "$6" = -- ] && [ "$7" = sh ] && [ "$8" = -c ] &&
  [ "\${10}" = codex-sandbox-boundary ] && [ "\${11}" = "$PROBE_NONCE" ] || exit 65
case "$PROBE_MODE" in
  denied) echo 'bwrap: creating new namespace: Operation not permitted' >&2; exit 1 ;;
  unknown) echo 'synthetic unexplained failure' >&2; exit 1 ;;
  timeout) exit 124 ;;
  missing) exit 127 ;;
esac
shift 6
if [ "$PROBE_MODE" != escape ]; then chmod 400 "$PROBE_ROOT/home/codex-seccomp-outside"; fi
"$@"
result=$?
chmod 600 "$PROBE_ROOT/home/codex-seccomp-outside"
if [ "$PROBE_MODE" = assertion ]; then echo changed > "$PROBE_ROOT/home/codex-seccomp-outside"; fi
exit "$result"
`,
  );
  // Fail actual shell commands at preparation and cleanup, leaving the probe's
  // trap and stage transitions responsible for reporting the failure.
  await writeCommand(
    tools,
    "mkdir",
    `if [ "$PROBE_MODE" = prepare ]; then exit 73; fi
exec /bin/mkdir "$@"
`,
  );
  await writeCommand(
    tools,
    "rm",
    `if [ "$PROBE_MODE" = cleanup ] && [ -f "$PROBE_ROOT/workspace/codex-seccomp-ok" ]; then exit 74; fi
exec /bin/rm "$@"
`,
  );
  const command = shellArgs[1]
    .replaceAll("/home/node", join(root, "home"))
    .replaceAll("/workspace", join(root, "workspace"));
  const result = spawnSync("/bin/sh", ["-c", command, ...shellArgs.slice(2)], {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 8192,
    env: {
      PATH: `${tools}:/usr/bin:/bin`,
      PROBE_MODE: mode,
      PROBE_ROOT: root,
      PROBE_NONCE: shellArgs[4],
    },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  if (result.status !== 0) {
    const error = new Error("generated probe failed");
    Object.assign(error, {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.status,
      signal: result.signal,
      timedOut: false,
    });
    throw error;
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

async function runDevelopmentPreparation(root: string, repository: string, mode: string) {
  const state = join(root, "state");
  const tools = join(root, "tools");
  const reached = join(root, "profile-derivation");
  await mkdir(state, { mode: 0o700 });
  await mkdir(tools, { mode: 0o700 });
  const dockerHost = "unix:///tmp/inert-probe-fixture.sock";
  await writeFile(join(state, ".openclaw-development"), "openclaw-enterprise-development-v3\n", {
    mode: 0o600,
  });
  await writeJson(join(state, "state.json"), {
    version: 3,
    repository,
    computeDriver: "kubernetes",
    deploymentMode: "k3d",
    sandboxDriver: "none",
    containerEngine: "docker",
    cluster: "occ-dev-origin-fixture",
    dockerHost,
  });
  await writeFile(join(state, "kubeconfig"), "{}\n", { mode: 0o600 });
  // These are inert external commands. The actual preparation entrypoint owns
  // the execFile callback and error propagation; no Kubernetes or Docker runs.
  await writeCommand(
    tools,
    "kubectl",
    `const args = process.argv.slice(2);
const a = args.slice(args.indexOf('--request-timeout') + 2);
if (a[0] === 'get' && a[1] === 'nodes') {
  process.stdout.write(JSON.stringify({items:[{metadata:{name:'k3d-occ-dev-origin-fixture-server-0'}}]}));
} else if (a[0] === 'get' && a[1] === 'pod') {
  process.stdout.write(JSON.stringify({status:{containerStatuses:[{name:'probe',ready:true,containerID:'containerd://fixture'}]}}));
} else if (a[0] === 'exec') {
  const { readFileSync } = process.getBuiltinModule('node:fs');
  if (a[5] !== 'sh' || a[6] !== '-c' || a[7] !== readFileSync('scripts/lib/codex-sandbox-probe.sh', 'utf8')) {
    process.exit(72);
  }
  const nonce = a.at(-1);
  const prefix = 'OCE_SANDBOX_PROBE_V1:' + nonce + ':';
  process.stderr.write(prefix + 'START\\n');
  if (['done_error','success'].includes(process.env.PROBE_MODE)) {
    process.stderr.write(prefix + 'ENTERED\\n' + prefix + 'END:DONE:0\\n');
  } else {
    process.stderr.write('bwrap: namespace: Operation not permitted\\n' + prefix + 'END:SANDBOX:1\\n');
  }
  if (process.env.PROBE_MODE === 'signal') process.kill(process.pid, 'SIGTERM');
  else process.exit(process.env.PROBE_MODE === 'success' ? 0 : process.env.PROBE_MODE === 'exit2' ? 2 : 1);
}
`,
    { interpreter: process.execPath },
  );
  // getBuiltinModule, not require: the stand-in loads as ESM when TMPDIR is inside this repo.
  await writeCommand(
    tools,
    "docker",
    `process.getBuiltinModule('node:fs').writeFileSync(process.env.PROBE_REACHED, 'reached');
process.exit(71);
`,
    { interpreter: process.execPath },
  );
  const result = spawnSync(
    process.execPath,
    [
      join(repository, "scripts/prepare-development-codex-seccomp.ts"),
      state,
      `registry.invalid/runtime@sha256:${"a".repeat(64)}`,
      "5",
    ],
    {
      cwd: repository,
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 8192,
      env: { PATH: tools, DOCKER_HOST: dockerHost, PROBE_MODE: mode, PROBE_REACHED: reached },
    },
  );
  return { result, reached, state };
}

export function registerSeccompPreparationCases() {
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
  ] as const) {
    test(`missing-profile preparation retries ${label} before a valid observation`, async (t) => {
      const control = await missingProfileFixture(t, [first, missingProfileWaiting]);
      const result = await control.run();
      assert.equal(result.profileName, "openclaw/codex-bwrap.json");
      assert.equal(control.reads(), 2);
      await control.assertCleanup();
    });
  }

  // Each probe's Node process is PID 1 and ignores SIGTERM. Local Setup's cleanup
  // (prepareDevelopmentCodexSeccompProfile) waits for the probe Namespace, so the
  // default 30 s grace was idle time. Both paths share this Pod spec; the CI path
  // is the one with an offline fixture.
  test("codex seccomp probe Pods stop within a one-second grace period", async (t) => {
    const control = await missingProfileFixture(t, [missingProfileWaiting]);
    await control.run();
    const pods = control.applied();
    assert.equal(pods.length, 3, "RuntimeDefault, installed-profile and missing-profile probes");
    for (const pod of pods) {
      assert.equal(pod.spec.terminationGracePeriodSeconds, 1, pod.metadata.name);
    }
    await control.assertCleanup();
  });

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
    await assert.rejects(control.run, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(
        error.message,
        /^Missing localhost seccomp profile unexpectedly started a container/,
      );
      assert.match(error.message, /cleanup also failed: namespace cleanup unavailable/);
      assert.ok("cleanupError" in error && error.cleanupError instanceof AggregateError);
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
    [
      "unexpected diagnostic suffix",
      (profile) => `${missingProfileMessage(profile)}; another error`,
    ],
  ] satisfies [label: string, message: (profile: string) => string][]) {
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

  for (const [label, diagnostic] of [
    ["Forbidden", 'Error from server (Forbidden): cannot exec in namespace "synthetic"'],
    ["NotFound", 'Error from server (NotFound): pod absent in namespace "synthetic"'],
  ] as const) {
    test(`baseline origin refuses Kubernetes ${label} before profile installation`, async (t) => {
      const control = await missingProfileFixture(t, [missingProfileWaiting], {
        baselineStderr: diagnostic,
      });
      await assert.rejects(
        control.run,
        { message: "RuntimeDefault denied namespace creation", stderr: diagnostic },
        "a client error must not qualify the baseline denial",
      );
      assert.equal(control.installations(), 0);
      await control.assertCleanup();
    });
  }

  for (const [label, alter, extra] of [
    ["wrong nonce", (text) => text.replaceAll(/:[a-f0-9]{32}:/g, `:${"0".repeat(32)}:`)],
    ["duplicate terminal", (text) => text + text.split("\n").at(-2) + "\n"],
    ["partial terminal", (text) => text.slice(0, -1)],
    ["oversized output", (text) => text + "x".repeat(4097)],
    ["unexpected stage", (text) => text.replace("END:SANDBOX", "END:OTHER")],
    ["wrong exit", (text) => text.replace("END:SANDBOX:1", "END:SANDBOX:127")],
    [
      "entered payload",
      (text) => text.replace("START\n", "START\n" + text.split("START")[0] + "ENTERED\n"),
    ],
    ["version failure", (text) => text.replace("END:SANDBOX:1", "END:VERSION:64")],
    ["contradictory exit", (text) => text, { exitCode: 2 }],
    ["missing exit", (text) => text, { exitCode: undefined }],
    ["missing signal", (text) => text, { signal: undefined }],
    ["contradictory code fields", (text) => text, { code: 2 }],
    ["non-numeric status", (text) => text, { exitCode: "1" }],
    ["killed process", (text) => text, { killed: true }],
    ["timeout", (text) => text, { timedOut: true }],
    ["signal", (text) => text, { signal: "SIGTERM" }],
    ["success-shaped failure", (text) => text.replace("END:SANDBOX:1", "END:DONE:0")],
  ] satisfies [label: string, alter: (text: string) => string, extra?: MalformedProcessStatus][]) {
    test(`baseline origin refuses ${label} and preserves cleanup`, async (t) => {
      const control = await missingProfileFixture(t, [missingProfileWaiting], {
        probeExec(args) {
          const error = Object.assign(new Error("probe rejected"), {
            exitCode: 1,
            signal: null,
            timedOut: false,
            stderr: alter(probeEvidence(args, "SANDBOX", 1, false, "bwrap namespace denied")),
          });
          Object.assign(error, extra);
          throw error;
        },
      });
      await assert.rejects(control.run, /probe rejected/);
      assert.equal(control.installations(), 0);
      await control.assertCleanup();
    });
  }

  for (const [mode, stage, exit, entered] of generatedProbeFailures) {
    test(`generated probe ${mode} refuses profile qualification with fixed stage`, async (t) => {
      const control = await missingProfileFixture(t, [missingProfileWaiting], {
        probeExec: (args, { root }) => runGeneratedProbe(args, root, mode),
      });
      await assert.rejects(control.run, (error: unknown) => {
        assert.ok(error instanceof Error && "codexSandboxProbe" in error && "exitCode" in error);
        assert.deepEqual(error.codexSandboxProbe, { stage, exit, entered });
        assert.equal(error.exitCode, exit);
        return true;
      });
      assert.equal(control.installations(), 0);
      await control.assertCleanup();
    });
  }

  test("failed installed sandbox probe reports its verified profile and exact context before cleanup", async (t) => {
    const output: string[] = [];
    const prefix = "OCE_CODEX_SECCOMP_PROBE_FAILURE ";
    const write = process.stderr.write.bind(process.stderr);
    t.mock.method(process.stderr, "write", (...args: Parameters<typeof process.stderr.write>) => {
      const [chunk] = args;
      if (typeof chunk === "string" && chunk.startsWith(prefix)) {
        output.push(chunk);
        return true;
      }
      return write(...args);
    });
    const control = await missingProfileFixture(t, [missingProfileWaiting], {
      probeExec(args, { baseline }) {
        throw Object.assign(new Error("probe refused"), {
          exitCode: 1,
          signal: null,
          timedOut: false,
          stdout: "private-probe-stdout",
          stderr: probeEvidence(
            args,
            "SANDBOX",
            1,
            false,
            baseline ? "bwrap namespace denied" : "private-probe-stderr",
          ),
        });
      },
      beforeCleanup() {
        assert.equal(output.length, 1, "the failure must reach stderr before Namespace deletion");
      },
    });
    await assert.rejects(control.run, { message: "probe refused" });
    assert.equal(output.length, 1);
    const [line] = output;
    assert.ok(line !== undefined);
    assert.doesNotMatch(line, /private-probe|OCE_SANDBOX_PROBE_V1/);
    const report: unknown = JSON.parse(line.slice(prefix.length));
    assert.ok(isRecord(report));
    assert.equal(report.mode, "Localhost");
    assert.equal(report.podUid, probePodUid);
    assert.equal(report.containerId, installedContainerId);
    assert.equal(report.node, "k3d-openclaw-k8s-poll-server-0");
    assert.equal(report.runtimeImageDigest, probeImageDigest);
    assert.equal(report.observedImageDigest, probeImageDigest);
    assert.equal(report.profileVerification, "passed");
    const installed = deriveCodexBwrapProfile(runtimeDefaultBaseline, { codexVersion: "0.164.0" });
    assert.equal(
      report.effectiveProfileSha256,
      createHash("sha256")
        .update(`${JSON.stringify(installed, null, 2)}\n`)
        .digest("hex"),
    );
    assert.equal(report.expectedCodexVersion, "0.164.0");
    assert.equal(report.verifiedCodexVersion, "0.164.0");
    assert.deepEqual(report.probe, { stage: "SANDBOX", exit: 1, entered: false });
    assert.deepEqual(report.security, {
      runAsNonRoot: true,
      runAsUser: 1000,
      runAsGroup: 1000,
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      dropAllCapabilities: true,
    });
    assert.ok(typeof report.startedAt === "string" && typeof report.finishedAt === "string");
    assert.ok(Date.parse(report.startedAt) <= Date.parse(report.finishedAt));
    assert.ok(typeof report.guide === "string");
    assert.match(report.guide, /codex-sandbox\.md#identify-the-restriction$/);
    await control.assertCleanup();
  });

  test("generated negative and positive probes complete the real profile preparation path", async (t) => {
    const control = await missingProfileFixture(t, [missingProfileWaiting], {
      probeExec: (args, { baseline, root }) =>
        runGeneratedProbe(args, root, baseline ? "denied" : "success"),
    });
    const result = await control.run();
    assert.equal(result.profileName, "openclaw/codex-bwrap.json");
    assert.equal(control.installations(), 1);
    await control.assertCleanup();
  });

  test("relocated preparation entrypoints require and deliver the local shell asset", async (t) => {
    const root = await fixture(t);
    const scripts = join(root, "scripts");
    await mkdir(join(scripts, "lib"), { recursive: true });
    for (const path of [
      "lib/assert-inside-directory.ts",
      "lib/codex-seccomp-k3d.ts",
      "lib/private-owned-path.mjs",
      "lib/codex-seccomp-profile.ts",
      "prepare-development-codex-seccomp.ts",
    ]) {
      await writeFile(join(scripts, path), await readFile(join(repositoryRoot, "scripts", path)));
    }
    // An incomplete source delivery fails before either entrypoint can prepare resources.
    for (const entrypoint of ["lib/codex-seccomp-k3d.ts", "prepare-development-codex-seccomp.ts"]) {
      const missing = spawnSync(process.execPath, [join(scripts, entrypoint)], {
        cwd: root,
        encoding: "utf8",
        timeout: 5_000,
        env: { PATH: "/usr/bin:/bin" },
      });
      assert.equal(missing.error, undefined);
      assert.equal(missing.status, 1);
      assert.match(missing.stderr, /ENOENT[^\n]*codex-sandbox-probe\.sh/);
    }
    await writeFile(
      join(scripts, "lib/codex-sandbox-probe.sh"),
      await readFile(join(repositoryRoot, "scripts/lib/codex-sandbox-probe.sh")),
    );
    const delivered = (await import(
      pathToFileURL(join(scripts, "lib/codex-seccomp-k3d.ts")).href
    )) as typeof import("../../scripts/lib/codex-seccomp-k3d.ts");
    const control = await missingProfileFixture(t, [missingProfileWaiting], {
      prepareProfile: delivered.prepareCodexSeccompProfile,
      probeExec: (args, { baseline, root: probeRoot }) =>
        runGeneratedProbe(args, probeRoot, baseline ? "denied" : "success"),
    });
    await control.run();
    assert.equal(control.installations(), 1);
    await control.assertCleanup();

    const { result, reached, state } = await runDevelopmentPreparation(root, root, "success");
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '{"mode":"RuntimeDefault","profileName":""}\n');
    await assert.rejects(() => readFile(reached, "utf8"), { code: "ENOENT" });
    assert.ok(!(await readdir(state)).some((name) => name.startsWith("codex-seccomp-")));
  });

  test("a client success without completed probe evidence does not qualify a positive", async (t) => {
    const control = await missingProfileFixture(t, [missingProfileWaiting], {
      probeExec: async () => ({ stdout: "", stderr: "" }),
    });
    await assert.rejects(control.run, /complete invocation-bound success evidence/);
    assert.equal(control.installations(), 0);
    await control.assertCleanup();
  });

  for (const mode of ["exit1", "exit2", "signal", "done_error", "success"]) {
    test(`actual preparation adapter binds probe evidence to ${mode}`, async (t) => {
      const root = await fixture(t);
      const { result, reached } = await runDevelopmentPreparation(root, repositoryRoot, mode);
      assert.equal(result.error, undefined);
      assert.equal(result.signal, null);
      if (mode === "exit1") {
        assert.equal(await readFile(reached, "utf8"), "reached");
      } else {
        await assert.rejects(() => readFile(reached, "utf8"), { code: "ENOENT" });
      }
      assert.equal(result.status, mode === "success" ? 0 : 1);
    });
  }
}
