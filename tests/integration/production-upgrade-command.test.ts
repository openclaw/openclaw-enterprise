import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
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

test("status treats candidate checks as historical and rejects invalid preflight evidence", async (t) => {
  const f = await fixture(t);
  await mkdir(f.evidence, { mode: 0o700 });
  const status = () =>
    spawnSync("python3", [command, "status", "--evidence-dir", f.evidence], {
      cwd: repository,
      encoding: "utf8",
      env: { PATH: process.env.PATH },
    });
  const startup = join(f.evidence, "startup-preflight-passed");
  const blocker = join(f.evidence, "preflight-blocked-original-worker");
  const candidatePassed = /Candidate startup checks passed/u;

  // An older evidence directory can establish these checks without recording an upgrade outcome.
  await writeFile(startup, "", { mode: 0o600 });
  const historical = status();
  assert.equal(historical.status, 0, historical.stderr);
  assert.match(historical.stdout, candidatePassed);
  assert.match(historical.stdout, /No deployment preparation marker was observed/u);
  assert.doesNotMatch(historical.stdout, /original worker/u);

  for (const [marker, outcome] of [
    ["prepared", /No completion was recorded/u],
    [".upgrade-lock", /A lock marker was observed/u],
    ["native-command-failures.tsv", /No completion was recorded/u],
    ["database-migration-handoff.json", /A migration pause was recorded/u],
    ["helm-started", /Helm intent was recorded/u],
    ["completed", /Completion was recorded/u],
  ] as const) {
    const path = join(f.evidence, marker);
    if (marker === ".upgrade-lock") {
      await mkdir(path, { mode: 0o700 });
    } else {
      await writeFile(path, "", { mode: 0o600 });
    }
    const result = status();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, outcome);
    assert.doesNotMatch(result.stdout, candidatePassed);
    await rm(path, { recursive: true });
  }

  // Malformed evidence must never produce a reassuring status message.
  await symlink(startup, blocker);
  const linked = status();
  assert.equal(linked.status, 2);
  assert.match(linked.stderr, /invalid or nonprivate status marker/u);
  await rm(blocker);
  await writeFile(blocker, "unexpected content", { mode: 0o600 });
  const nonempty = status();
  assert.equal(nonempty.status, 2);
  assert.match(nonempty.stderr, /invalid or nonprivate status marker/u);
  await writeFile(blocker, "", { mode: 0o600 });
  await rm(startup);
  const inconsistent = status();
  assert.equal(inconsistent.status, 2);
  assert.match(inconsistent.stderr, /inconsistent preflight status markers/u);
});

test("status withholds conclusions when preparation is recorded during the scan", async (t) => {
  const f = await fixture(t);
  await mkdir(f.evidence, { mode: 0o700 });
  await writeFile(join(f.evidence, "startup-preflight-passed"), "", { mode: 0o600 });
  await mkdir(join(f.evidence, ".upgrade-lock"), { mode: 0o700 });

  // Publish preparation and release the lock after the first lookup, within one timestamp interval.
  const interleave = `
import os
import runpy
import sys
from types import SimpleNamespace

stat = os.stat
fstat = os.fstat

def fstat_with_constant_times(fd):
    item = fstat(fd)
    return SimpleNamespace(
        st_uid=item.st_uid, st_mode=item.st_mode, st_mtime_ns=0, st_ctime_ns=0
    )

def stat_during_upgrade(path, *args, **kwargs):
    try:
        return stat(path, *args, **kwargs)
    except FileNotFoundError:
        if path == "prepared":
            fd = kwargs["dir_fd"]
            os.close(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=fd))
            os.rmdir(".upgrade-lock", dir_fd=fd)
        raise

os.stat = stat_during_upgrade
os.fstat = fstat_with_constant_times
sys.argv = sys.argv[1:]
runpy.run_path(sys.argv[0], run_name="__main__")
`;
  const result = spawnSync(
    "python3",
    ["-c", interleave, command, "status", "--evidence-dir", f.evidence],
    {
      cwd: repository,
      encoding: "utf8",
      env: { PATH: process.env.PATH },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(join(f.evidence, "prepared"), "utf8"), "");
  assert.match(result.stdout, /evidence changed during this read.*Run status again/u);
  assert.doesNotMatch(result.stdout, /Historical local evidence|No deployment|Candidate startup/u);
});

test("private profiles reject credentials and target overrides without disclosure", async (t) => {
  const f = await fixture(t);
  const override = run("upgrade", f, ["--", "--context", "another-context"]);
  assert.equal(override.status, 2);
  assert.match(override.stderr, /cannot override profile or operation arguments/);

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
