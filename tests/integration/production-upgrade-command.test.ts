import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

async function selectCheckout(f: Fixture) {
  const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" });
  assert.equal(git.status, 0);
  const selected = { ...f.input, sourceRevision: git.stdout.trim() };
  await writeFile(f.profile, JSON.stringify(selected));
  return selected;
}

function run(
  action: string,
  f: Fixture,
  extra: string[] = [],
  options: {
    command?: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    automaticEvidence?: boolean;
  } = {},
) {
  return spawnSync(
    "python3",
    [
      options.command ?? command,
      action,
      "--profile",
      f.profile,
      ...(options.automaticEvidence || action === "plan" ? [] : ["--evidence-dir", f.evidence]),
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
  assert.equal(run("preflight", f, ["--", "--timeout-seconds", "1200"], options).status, 0);
  assert.deepEqual(JSON.parse(await readFile(capture, "utf8")), [
    ...upgrade,
    "--preflight-only",
    "--timeout-seconds",
    "1200",
  ]);
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
  const splitCheckout = run("apply", f, [], { cwd: f.directory });
  assert.equal(splitCheckout.status, 2);
  assert.match(splitCheckout.stderr, /reviewed release checkout root/);
});

test("upgrade commands reach the canonical source, mode, and recovery checks", async (t) => {
  const f = await fixture(t);

  // The adapter supplies the target, rendered files, image, and reviewed source to the real owner.
  const preflight = run("preflight", f);
  assert.equal(preflight.status, 1);
  assert.match(preflight.stderr, /checkout commit does not match --source-revision/);

  // A fresh apply cannot serve as a recovery command. Refuse before requesting approval.
  await selectCheckout(f);
  for (const flag of ["--recover-helm", "--migration-history-checked", "--recovery-reviewed"]) {
    const upgrade = run("apply", f, ["--", flag], { automaticEvidence: true });
    assert.equal(upgrade.status, 2);
    assert.match(upgrade.stderr, /occ installation upgrade resume RUN/);
    assert.equal(upgrade.stdout, "");
  }
  assert.deepEqual(await readdir(f.directory), ["operator.json"]);

  // Approval does not waive the native owner's recovery attestations.
  await mkdir(f.evidence, { mode: 0o700 });
  const resume = run("resume", f, ["--auto-approve", "--", "--recover-helm"]);
  assert.equal(resume.status, 1);
  assert.match(resume.stderr, /--recover-helm requires --resume --migration-history-checked/);
  await rm(f.evidence, { recursive: true });

  for (const flag of ["--previous-process-settled", "--evidence-unrestored"]) {
    const cleanup = run("cleanup-preflight", f, ["--", flag]);
    assert.equal(cleanup.status, 2);
    assert.match(
      cleanup.stderr,
      /cleanup requires --previous-process-settled and --evidence-unrestored/,
    );
  }
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
  const rawResume = run("apply", f, [
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
    /occ installation upgrade resume RUN --profile PROFILE -- ORIGINAL_EXPERT_OPTIONS/,
  );
  assert.ok(!rawResume.stderr.includes(privateCandidate));

  const rawPreflight = run("apply", f, [
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
    /occ installation upgrade preflight --profile PROFILE -- ORIGINAL_EXPERT_OPTIONS/,
  );
  assert.ok(!rawPreflight.stderr.includes(privateCandidate));
});

test("private profiles reject credentials and target overrides without disclosure", async (t) => {
  const f = await fixture(t);
  const override = run("apply", f, ["--", "--context", "another-context"]);
  assert.equal(override.status, 2);
  assert.match(override.stderr, /cannot override profile or operation arguments/);
  const checkInstead = run("apply", f, ["--", "--migration-check-only"]);
  assert.equal(checkInstead.status, 2);
  assert.match(checkInstead.stderr, /cannot override profile or operation arguments/);

  const secret = randomBytes(24).toString("hex");
  await writeFile(f.profile, JSON.stringify({ ...f.input, serviceKey: secret }));
  const unsupported = run("apply", f);
  assert.equal(unsupported.status, 2);
  assert.match(unsupported.stderr, /unsupported profile fields/);
  assert.ok(!unsupported.stderr.includes(secret));

  await chmod(f.profile, 0o644);
  const publicFile = run("apply", f);
  assert.equal(publicFile.status, 2);
  assert.match(publicFile.stderr, /owner-only regular file/);
  assert.ok(!publicFile.stderr.includes(secret));
});

test("apply requires approval of the current target before reserving private evidence", async (t) => {
  const f = await fixture(t);
  const profile = await selectCheckout(f);
  const fresh = { automaticEvidence: true };
  const plan = run("plan", f);
  assert.equal(plan.status, 0, plan.stderr);
  assert.ok(plan.stdout.includes(profile.images.controller));
  assert.ok(plan.stdout.includes(`Kubeconfig: ${join(f.directory, profile.kubeconfig)}`));
  assert.ok(
    plan.stdout.includes(`Rendered baseline: ${join(f.directory, profile.installationDirectory)}`),
  );

  // A past preview grants no authority. Refuse mutable images and closed stdin without writes.
  const changed = { ...profile, images: { controller: "image:latest" } };
  await writeFile(f.profile, JSON.stringify(changed));
  const mutable = run("apply", f, ["--auto-approve"], fresh);
  assert.equal(mutable.status, 2);
  assert.match(mutable.stderr, /immutable/);
  await writeFile(f.profile, JSON.stringify(profile));
  const refused = run("apply", f, [], fresh);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /--auto-approve/);
  assert.equal(run("upgrade", f).status, 2);
  assert.deepEqual(await readdir(f.directory), ["operator.json"]);

  // The real owner refuses the invalid timeout before contacting the cluster.
  // Even an early refusal must leave an unambiguous locator, never reuse a prior attempt.
  const guard = ["--", "--timeout-seconds", "0"];
  const terminal = (answer: string) =>
    spawnSync(
      "python3",
      [
        "-c",
        "import os,pty,sys; sys.exit(os.waitstatus_to_exitcode(pty.spawn(sys.argv[1:])))",
        command,
        "apply",
        "--profile",
        f.profile,
        ...guard,
      ],
      {
        cwd: repository,
        encoding: "utf8",
        input: answer + "\n",
        timeout: 30_000,
        env: { PATH: process.env.PATH },
      },
    );
  const decline = terminal("no");
  assert.match(decline.stdout, /Apply cancelled/);
  assert.deepEqual(await readdir(f.directory), ["operator.json"]);

  const flags = ["--auto-approve", ...guard];
  const locators = new Set<string>();
  for (const result of [terminal("yes"), run("apply", f, flags, fresh)]) {
    assert.equal(result.status, 1);
    assert.match(result.stdout + result.stderr, /--timeout-seconds must be positive/);
    const evidence = /Evidence: (.+)$/m.exec(result.stdout)?.[1];
    assert.ok(evidence);
    locators.add(evidence);
    const parent = dirname(evidence);
    assert.equal(dirname(parent), f.directory);
    assert.equal((await stat(parent)).mode & 0o777, 0o700);
    assert.deepEqual(await readdir(parent), []);
  }
  assert.equal(locators.size, 2);

  // Refuse to point recovery at a previous dispatch, even when its evidence leaf is missing.
  const journal = f.evidence + ".dispatch-state";
  await writeFile(journal, "original attempt", { mode: 0o600 });
  const reuse = run("apply", f, flags);
  assert.equal(reuse.status, 2);
  assert.doesNotMatch(reuse.stdout, /^Inspect:/m);
  assert.equal(await readFile(journal, "utf8"), "original attempt");

  // Unsafe or read-only profile directories require an explicit destination.
  for (const mode of [0o770, 0o500]) {
    await chmod(f.directory, mode);
    try {
      const result = run("apply", f, flags, fresh);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /--evidence-dir/);
      assert.doesNotMatch(result.stdout, /^Evidence:/m);
    } finally {
      await chmod(f.directory, 0o700);
    }
  }
});
