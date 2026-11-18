import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../..", import.meta.url));
const command = join(repository, "scripts/upgrade-production");

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "oce-upgrade-command-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const profile = join(directory, "operator.json");
  const input = {
    kubeconfig: "kubeconfig",
    context: "reviewed-context",
    namespace: "openclaw-system",
    release: "oce",
    installationDirectory: "rendered",
    sourceRevision: "0".repeat(40),
    images: { controller: "registry.example/controller@sha256:" + "a".repeat(64) },
  };
  await writeFile(profile, JSON.stringify(input), { mode: 0o600 });
  return { directory, profile, input, evidence: join(directory, "evidence") };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function run(
  action: string,
  f: Fixture,
  extra: string[] = [],
  options: { command?: string; cwd?: string; env?: NodeJS.ProcessEnv } = {},
) {
  return spawnSync(
    "python3",
    [
      options.command ?? command,
      action,
      "--profile",
      f.profile,
      "--evidence-dir",
      f.evidence,
      ...extra,
    ],
    {
      cwd: options.cwd ?? repository,
      encoding: "utf8",
      env: { PATH: process.env.PATH, ...options.env },
    },
  );
}

test("operations hand off the selected profile and mode without changing the canonical options", async (t) => {
  const f = await fixture(t);
  const scripts = join(f.directory, "scripts");
  await mkdir(scripts);
  const adapter = join(scripts, "upgrade-production");
  const capture = join(f.directory, "argv.json");
  await copyFile(command, adapter);
  const canonical = join(scripts, "upgrade-production-images");
  // This executable records the adapter's dependency contract; the next test invokes the real owner.
  await writeFile(
    canonical,
    "#!/usr/bin/env python3\nimport json,os,sys\nopen(os.environ['CAPTURE_PATH'],'w').write(json.dumps(sys.argv[1:]))\n",
    { mode: 0o755 },
  );
  const options = { command: adapter, cwd: f.directory, env: { CAPTURE_PATH: capture } };
  const target = [
    "--kubeconfig",
    join(f.directory, "kubeconfig"),
    "--context",
    "reviewed-context",
    "--namespace",
    "openclaw-system",
    "--release",
    "oce",
  ];
  const upgrade = [
    ...target,
    "--values",
    join(f.directory, "rendered/values.yaml"),
    "--installation",
    join(f.directory, "rendered/installation.yaml"),
    "--source-revision",
    f.input.sourceRevision,
    "--evidence-dir",
    f.evidence,
    "--controller-image",
    f.input.images.controller,
  ];
  for (const [action, suffix] of [
    ["preflight", ["--preflight-only"]],
    ["upgrade", []],
    ["resume", ["--resume"]],
    ["migration-apply", ["--migration-apply-only"]],
  ] as const) {
    assert.equal(run(action, f, ["--", "--timeout-seconds", "1200"], options).status, 0);
    assert.deepEqual(JSON.parse(await readFile(capture, "utf8")), [
      ...upgrade,
      ...suffix,
      "--timeout-seconds",
      "1200",
    ]);
  }
  assert.equal(
    run("migration-check", f, ["--", "--candidate-values", "candidate.yaml"], options).status,
    0,
  );
  assert.deepEqual(JSON.parse(await readFile(capture, "utf8")), [
    ...target,
    "--values",
    join(f.directory, "rendered/values.yaml"),
    "--source-revision",
    f.input.sourceRevision,
    "--evidence-dir",
    f.evidence,
    "--controller-image",
    f.input.images.controller,
    "--migration-check-only",
    "--candidate-values",
    "candidate.yaml",
  ]);
  assert.equal(
    run(
      "cleanup-preflight",
      f,
      ["--", "--previous-process-settled", "--evidence-unrestored"],
      options,
    ).status,
    0,
  );
  assert.deepEqual(JSON.parse(await readFile(capture, "utf8")), [
    "--cleanup-preflight",
    ...target,
    "--evidence-dir",
    f.evidence,
    "--previous-process-settled",
    "--evidence-unrestored",
  ]);

  // A helper from one checkout cannot execute against another checkout's reviewed Git source.
  const splitCheckout = run("upgrade", f, [], { cwd: f.directory });
  assert.equal(splitCheckout.status, 2);
  assert.match(splitCheckout.stderr, /reviewed release checkout root/);
});

test("upgrade commands reach the canonical source, mode, and recovery checks", async (t) => {
  const f = await fixture(t);

  // The adapter supplies the target, rendered files, image, and reviewed source to the real owner.
  const preflight = run("preflight", f);
  assert.equal(preflight.status, 1);
  assert.match(preflight.stderr, /checkout commit does not match --source-revision/);

  // Recovery remains a canonical decision: only resume plus both attestations can request it.
  const flags = ["--", "--recover-helm", "--migration-history-checked", "--recovery-reviewed"];
  const upgrade = run("upgrade", f, flags);
  assert.equal(upgrade.status, 1);
  assert.match(upgrade.stderr, /--recover-helm requires --resume/);
  const resume = run("resume", f, flags);
  assert.equal(resume.status, 1);
  assert.match(resume.stderr, /checkout commit does not match --source-revision/);

  const cleanup = run("cleanup-preflight", f);
  assert.equal(cleanup.status, 2);
  assert.match(
    cleanup.stderr,
    /cleanup requires --previous-process-settled and --evidence-unrestored/,
  );
  const settled = run("cleanup-preflight", f, [
    "--",
    "--previous-process-settled",
    "--evidence-unrestored",
  ]);
  assert.equal(settled.status, 2);
  assert.match(settled.stderr, /evidence path must be a directory/);
});

test("canonical operation flags direct operators to usable profiled commands", async (t) => {
  const f = await fixture(t);

  // Follow the canonical migration handoff through the profiled entry point.
  const privateCandidate = join(f.directory, "candidate-values.yaml");
  const rawResume = run("upgrade", f, [
    "--",
    "--candidate-values",
    privateCandidate,
    "--resume",
    "--migration-history-checked",
    "--recover-helm",
    "--recovery-reviewed",
  ]);
  assert.equal(rawResume.status, 2);
  assert.match(rawResume.stderr, /remove only --resume; retain every other original expert option/);
  assert.match(rawResume.stderr, /--migration-history-checked when required/);
  assert.match(
    rawResume.stderr,
    /scripts\/upgrade-production resume --profile PROFILE --evidence-dir ORIGINAL -- ORIGINAL_EXPERT_OPTIONS/,
  );
  assert.ok(!rawResume.stderr.includes(privateCandidate));
  const resume = run("resume", f, ["--", "--migration-history-checked"]);
  assert.equal(resume.status, 1);
  assert.match(resume.stderr, /checkout commit does not match --source-revision/);

  const rawPreflight = run("upgrade", f, [
    "--",
    "--candidate-values",
    privateCandidate,
    "--preflight-only",
  ]);
  assert.equal(rawPreflight.status, 2);
  assert.match(
    rawPreflight.stderr,
    /remove only --preflight-only; retain every other original expert option/,
  );
  assert.match(
    rawPreflight.stderr,
    /scripts\/upgrade-production preflight --profile PROFILE --evidence-dir FRESH -- ORIGINAL_EXPERT_OPTIONS/,
  );
  assert.ok(!rawPreflight.stderr.includes(privateCandidate));
});

test("private profiles reject credentials and target overrides without disclosure", async (t) => {
  const f = await fixture(t);
  const override = run("upgrade", f, ["--", "--context", "another-context"]);
  assert.equal(override.status, 2);
  assert.match(override.stderr, /cannot override profile or operation arguments/);
  const checkInstead = run("upgrade", f, ["--", "--migration-check-only"]);
  assert.equal(checkInstead.status, 2);
  assert.match(checkInstead.stderr, /cannot override profile or operation arguments/);

  const secret = randomBytes(24).toString("hex");
  await writeFile(f.profile, JSON.stringify({ ...f.input, serviceKey: secret }));
  const unsupported = run("upgrade", f);
  assert.equal(unsupported.status, 2);
  assert.match(unsupported.stderr, /unsupported profile fields/);
  assert.ok(!unsupported.stderr.includes(secret));

  await chmod(f.profile, 0o644);
  const publicFile = run("upgrade", f);
  assert.equal(publicFile.status, 2);
  assert.match(publicFile.stderr, /owner-only regular file/);
  assert.ok(!publicFile.stderr.includes(secret));
});
