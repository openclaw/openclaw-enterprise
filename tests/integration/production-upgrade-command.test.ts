import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { syntheticCredentialUrl } from "../fixtures/synthetic-credential-url.mjs";

const repository = fileURLToPath(new URL("../..", import.meta.url));
const command = join(repository, "scripts/upgrade-production");

function kubeconfigFor(context: string, selected: Record<string, string | boolean> = {}) {
  return {
    apiVersion: "v1",
    kind: "Config",
    clusters: [
      { name: "selected", cluster: { server: "https://127.0.0.1:9", ...selected } },
      {
        name: "unused",
        cluster: {
          server: "https://127.0.0.1:10",
          "certificate-authority": "unused-ca.pem",
        },
      },
    ],
    contexts: [
      { name: context, context: { cluster: "selected", user: "operator" } },
      { name: "unused", context: { cluster: "unused", user: "operator" } },
    ],
    users: [{ name: "operator", user: {} }],
    "current-context": "unused",
  };
}

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
  await writeFile(join(directory, input.kubeconfig), JSON.stringify(kubeconfigFor(input.context)), {
    mode: 0o600,
  });
  const rendered = join(directory, input.installationDirectory);
  await mkdir(rendered, { mode: 0o700 });
  for (const filename of ["values.yaml", "installation.yaml"]) {
    await writeFile(join(rendered, filename), "{}\n", { mode: 0o600 });
  }
  return { directory, profile, input, rendered, evidence: join(directory, "evidence") };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function selectCheckout(f: Fixture) {
  const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" });
  assert.equal(git.status, 0);
  const selected = { ...f.input, sourceRevision: git.stdout.trim() };
  await writeFile(f.profile, JSON.stringify(selected));
  return selected;
}

type RunOptions = {
  command?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  automaticEvidence?: boolean;
  confirmation?: string;
};

function run(action: string, f: Fixture, extra: string[] = [], options: RunOptions = {}) {
  return spawnSync(
    "python3",
    [
      ...(options.confirmation === undefined
        ? []
        : [
            "-c",
            "import os,pty,sys; sys.exit(os.waitstatus_to_exitcode(pty.spawn(sys.argv[1:])))",
          ]),
      options.command ?? command,
      action,
      ...(action === "status" ? [] : ["--profile", f.profile]),
      ...(options.automaticEvidence || action === "plan" ? [] : ["--evidence-dir", f.evidence]),
      ...extra,
    ],
    {
      cwd: options.cwd ?? repository,
      encoding: "utf8",
      env: { PATH: process.env.PATH, ...options.env },
      ...(options.confirmation === undefined
        ? {}
        : { input: options.confirmation, timeout: 30_000 }),
    },
  );
}

test("operations hand off the selected profile and mode without changing the canonical options", async (t) => {
  const f = await fixture(t);
  const checkout = join(f.directory, "checkout");
  const scripts = join(checkout, "scripts");
  await mkdir(scripts, { recursive: true });
  const adapter = join(scripts, "upgrade-production");
  const capture = join(f.directory, "argv.json");
  const binding = join(f.directory, "approval.json");
  const kubeconfig = JSON.stringify(
    kubeconfigFor(f.input.context, {
      "certificate-authority": "server-ca.pem",
    }),
  );
  const ca = randomBytes(32);
  await writeFile(join(f.directory, f.input.kubeconfig), kubeconfig);
  await writeFile(join(f.directory, "server-ca.pem"), ca, { mode: 0o644 });
  const targetBinding = {
    kubeconfig: createHash("sha256").update(kubeconfig).digest("hex"),
    "kubeconfig server CA": createHash("sha256").update(ca).digest("hex"),
  };
  await copyFile(command, adapter);
  const canonical = join(scripts, "upgrade-production-images");
  // This executable records the adapter's dependency contract; the next test invokes the real owner.
  await writeFile(
    canonical,
    "#!/usr/bin/env python3\nimport json,os,sys\nopen(os.environ['CAPTURE_PATH'],'w').write(json.dumps(sys.argv[1:]))\nopen(os.environ['CAPTURE_BINDING'],'w').write(os.environ['OCC_UPGRADE_APPROVED_INPUTS'])\n",
    { mode: 0o755 },
  );
  const options = {
    command: adapter,
    cwd: checkout,
    env: { CAPTURE_PATH: capture, CAPTURE_BINDING: binding },
  };
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
  const preflightBinding = JSON.parse(await readFile(binding, "utf8"));
  assert.equal(preflightBinding.kubeconfig, targetBinding.kubeconfig);
  assert.equal(preflightBinding["kubeconfig server CA"], targetBinding["kubeconfig server CA"]);
  assert.deepEqual(Object.keys(preflightBinding).sort(), [
    "baseline Helm values",
    "baseline Installation",
    "kubeconfig",
    "kubeconfig server CA",
  ]);
  // The dedicated migration check and cleanup still need no Installation file.
  await rm(join(f.rendered, "installation.yaml"));
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
  assert.deepEqual(JSON.parse(await readFile(binding, "utf8")), targetBinding);
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
  assert.deepEqual(JSON.parse(await readFile(binding, "utf8")), targetBinding);

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
  assert.deepEqual((await readdir(f.directory)).sort(), [
    "kubeconfig",
    "operator.json",
    "rendered",
  ]);

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

  // A startup marker alone can come from a resume or an attempt without a final result.
  await writeFile(startup, "", { mode: 0o600 });
  const historical = status();
  assert.equal(historical.status, 0, historical.stderr);
  assert.match(historical.stdout, candidatePassed);
  assert.doesNotMatch(historical.stdout, /fresh evidence|original worker/u);
  assert.match(historical.stdout, /final preflight outcome is unknown/u);
  assert.match(historical.stdout, /Preserve the original attempt's top-level evidence/u);
  assert.match(
    historical.stdout,
    /Reconcile the command result and current inventory before any further write/u,
  );

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
  const blocked = status();
  assert.equal(blocked.status, 0, blocked.stderr);
  assert.match(
    blocked.stdout,
    /blocked because retained Agent revisions require their original worker/u,
  );
  assert.match(
    blocked.stdout,
    /Resolve the blocker.*then recheck inventory with fresh upgrade evidence/u,
  );

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
  assert.deepEqual((await readdir(f.directory)).sort(), [
    "kubeconfig",
    "operator.json",
    "rendered",
  ]);

  // The real owner rejects the untrusted local URL before contacting the cluster.
  // Even an early refusal must leave an unambiguous locator, never reuse a prior attempt.
  const guard = ["--", "--timeout-seconds", "1"];
  const nativeRefusal = { OCC_URL: "http://127.0.0.1:9" };
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
        env: { PATH: process.env.PATH, ...nativeRefusal },
      },
    );
  const decline = terminal("no");
  assert.match(decline.stdout, /Apply cancelled/);
  assert.deepEqual((await readdir(f.directory)).sort(), [
    "kubeconfig",
    "operator.json",
    "rendered",
  ]);

  const flags = ["--auto-approve", ...guard];
  const locators = new Set<string>();
  for (const result of [
    terminal("yes"),
    run("apply", f, flags, { ...fresh, env: nativeRefusal }),
  ]) {
    assert.equal(result.status, 1);
    assert.match(result.stdout + result.stderr, /OCC_URL must use HTTPS/);
    const evidence = /Evidence: (.+)$/m.exec(result.stdout)?.[1];
    assert.ok(evidence);
    locators.add(evidence);
    const parent = dirname(evidence);
    assert.equal(dirname(parent), await realpath(f.directory));
    assert.equal((await stat(parent)).mode & 0o777, 0o700);
    assert.deepEqual(await readdir(parent), []);
    assert.doesNotMatch(result.stdout, /occ installation upgrade resume/);
    const observed = run("status", { ...f, evidence });
    assert.equal(observed.status, 0);
    assert.match(observed.stdout, /no native evidence.*outcome is unknown/);
    const resume = run("resume", { ...f, evidence }, ["--auto-approve", ...guard]);
    assert.equal(resume.status, 2);
    assert.match(resume.stderr, /original native evidence directory/);
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

test("resume warns about Installation writes before approval even if the local files already match", async (t) => {
  const f = await fixture(t);
  await selectCheckout(f);
  const values = JSON.stringify({ installation: { secretName: "occ-staged" } });
  const installation = JSON.stringify({
    drivers: {
      plugin: [{ id: "codex-plugin", configuration: { catalogSource: "openai-curated" } }],
    },
  });
  const candidateValues = join(f.directory, "candidate-values.yaml");
  const candidateInstallation = join(f.directory, "candidate-installation.yaml");
  // An interrupted run can leave the local files at the candidate while Kubernetes
  // still needs reconciliation. Recreate that local observation without a cluster.
  await writeFile(join(f.rendered, "values.yaml"), values);
  await writeFile(join(f.rendered, "installation.yaml"), installation);
  await writeFile(candidateValues, values, { mode: 0o600 });
  await writeFile(candidateInstallation, installation, { mode: 0o600 });
  await mkdir(f.evidence, { mode: 0o700 });
  const prepared = join(f.evidence, "prepared");
  await writeFile(prepared, "", { mode: 0o600 });
  const original = await stat(f.evidence);
  const originalFiles = (await readdir(f.directory)).sort();
  const expert = [
    "--",
    "--candidate-values",
    candidateValues,
    "--candidate-installation",
    candidateInstallation,
    "--timeout-seconds",
    "1",
  ];
  // The real native owner rejects this URL before any cluster contact. Its
  // diagnostic distinguishes a dispatched command from a declined prompt.
  const env = { OCC_URL: "http://127.0.0.1:9" };
  const declined = spawnSync(
    "python3",
    [
      "-c",
      "import os,pty,sys; sys.exit(os.waitstatus_to_exitcode(pty.spawn(sys.argv[1:])))",
      command,
      "resume",
      "--profile",
      f.profile,
      "--evidence-dir",
      f.evidence,
      ...expert,
    ],
    {
      cwd: repository,
      encoding: "utf8",
      input: "no\n",
      timeout: 30_000,
      env: { PATH: process.env.PATH, ...env },
    },
  );
  assert.equal(declined.status, 1, declined.stdout + declined.stderr);
  const prompt = declined.stdout.indexOf("Type yes to continue:");
  assert.ok(prompt > 0, declined.stdout);
  const beforeApproval = declined.stdout.slice(0, prompt);
  assert.match(beforeApproval, /write the recorded local Installation/);
  assert.match(beforeApproval, /replace the live mutable Installation Secret/);
  assert.match(beforeApproval, /switch to the recorded immutable Secret/);
  assert.match(declined.stdout, /Resume cancelled; no command dispatched/);
  assert.doesNotMatch(declined.stdout + declined.stderr, /OCC_URL must use HTTPS/);

  const approved = run("resume", f, ["--auto-approve", ...expert], { env });
  assert.equal(approved.status, 1, approved.stdout + approved.stderr);
  assert.match(approved.stderr, /OCC_URL must use HTTPS/);
  const retained = await stat(f.evidence);
  assert.equal(retained.ino, original.ino);
  assert.equal(retained.mode & 0o777, 0o700);
  assert.deepEqual(await readdir(f.evidence), ["prepared"]);
  assert.equal((await stat(prepared)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(f.directory)).sort(), originalFiles);
  assert.equal(await readFile(join(f.rendered, "values.yaml"), "utf8"), values);
  assert.equal(await readFile(join(f.rendered, "installation.yaml"), "utf8"), installation);
});

test("migration apply requires approval of the original run before native dispatch", async (t) => {
  const f = await fixture(t);
  await selectCheckout(f);
  await mkdir(f.evidence, { mode: 0o700 });
  const handoff = join(f.evidence, "database-migration-handoff.json");
  const handoffBytes = JSON.stringify({ api: { uid: "api" }, worker: { uid: "worker" } });
  await writeFile(handoff, handoffBytes, { mode: 0o600 });
  const nativeExit = { OCC_URL: "http://127.0.0.1:9" };
  const original = await stat(f.evidence);
  const files = await readdir(f.directory);

  const unapproved = run("migration-apply", f, [], { env: nativeExit });
  assert.equal(unapproved.status, 2, unapproved.stdout + unapproved.stderr);
  assert.match(unapproved.stderr, /--auto-approve/);

  // A PTY exercises the real approval gate. A dispatched invocation reaches
  // the native URL guard before any Kubernetes request.
  const declined = run("migration-apply", f, [], { confirmation: "no\n", env: nativeExit });
  assert.equal(declined.status, 1, declined.stdout + declined.stderr);
  const prompt = declined.stdout.indexOf("Type yes to continue:");
  assert.ok(prompt > 0, declined.stdout);
  assert.match(declined.stdout.slice(0, prompt), /can commit irreversible SQL/);
  assert.ok(declined.stdout.includes(f.evidence));
  assert.match(declined.stdout, /cancelled; no command dispatched/);
  assert.doesNotMatch(declined.stdout + declined.stderr, /OCC_URL must use HTTPS/);

  for (const approved of [
    run("migration-apply", f, [], { confirmation: "yes\n", env: nativeExit }),
    run("migration-apply", f, ["--auto-approve"], { env: nativeExit }),
  ]) {
    assert.equal(approved.status, 1, approved.stdout + approved.stderr);
    assert.match(approved.stderr + approved.stdout, /OCC_URL must use HTTPS/);
    assert.doesNotMatch(
      approved.stdout,
      /This check creates temporary cluster resources|Evidence:/,
    );
  }
  const retained = await stat(f.evidence);
  assert.equal(retained.ino, original.ino);
  assert.equal(retained.mtimeMs, original.mtimeMs);
  assert.deepEqual(await readdir(f.directory), files);
  assert.deepEqual(await readdir(f.evidence), ["database-migration-handoff.json"]);
  assert.equal(await readFile(handoff, "utf8"), handoffBytes);
});

function postgresCompatibilityReport(
  releasedController: string,
  candidateController: string,
  historyStatus: "current" | "unsupported",
) {
  const compatibilityFile = "tests/integration/postgres-migration-compatibility.test.mjs";
  const counts = { passed: 2, failed: 0, skipped: 0, todo: 0, total: 2 };
  const compatibilityResult = {
    path: compatibilityFile,
    status: "passed",
    nodeExitCode: 0,
    signal: null,
    counts,
    tests: [
      "Released controller remains usable across candidate database writes",
      "Released controller remains usable after configured IAM activation",
    ].map((name) => ({ name, status: "passed", file: compatibilityFile })),
    issues: [],
    cleanup: { status: "passed" },
    imageDigests: { releasedController, candidateController },
    measurements: [{ kind: "released-controller-history", status: historyStatus }],
  };
  return {
    version: 1,
    command: "run",
    sourceSha: "1".repeat(40),
    lane: "postgres",
    scope: "focused",
    status: "passed",
    exitCode: 0,
    counts,
    issues: [],
    files: [compatibilityResult] as const,
  };
}

test("recovery history requires the exact pair, a completed runner, and one current measurement", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "oce-recovery-history-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const receipt = join(directory, "compatibility.json");
  const recoveryDigest = `sha256:${"b".repeat(64)}`;
  const candidateDigest = `sha256:${"a".repeat(64)}`;
  const compatibility = postgresCompatibilityReport(recoveryDigest, candidateDigest, "current");
  const [file] = compatibility.files;
  const passed = { status: "passed", exitCode: 0, signal: null, terminal: true };
  const phases = { prepare: passed, run: passed, cleanup: passed };
  const lifecycle = { status: "passed", interrupted: null, phases };
  const [history] = file.measurements;
  assert.ok(history);
  const report = {
    ...compatibility,
    lifecycle,
    files: [
      {
        ...file,
        measurements: [
          { kind: "keycloak-enrollment-interrupted", row: 0, operation: "sign-in" },
          history,
        ],
      },
    ],
  };
  const runHistory = (...inputs: string[]) =>
    spawnSync(
      "python3",
      [join(repository, "scripts/upgrade-evidence.py"), "recovery-history", ...inputs],
      {
        encoding: "utf8",
        timeout: 5_000,
      },
    );
  const inputs = [receipt, recoveryDigest, candidateDigest, report.sourceSha] as const;
  const assertRefused = (message: string, ...args: string[]) => {
    const result = runHistory(...args);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, message + "\n");
  };
  const valid = JSON.stringify(report);
  await writeFile(receipt, valid, { mode: 0o600 });
  const accepted = runHistory(...inputs);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(accepted.stderr, "");
  assert.equal(
    accepted.stdout,
    "Reported recovery controller history is current for the selected compatibility pair.\n",
  );
  assert.equal(await readFile(receipt, "utf8"), valid);
  assert.deepEqual(await readdir(directory), ["compatibility.json"]);

  const identityError =
    "Supply two distinct lowercase sha256 digests and the full lowercase runner SHA.";
  const compatibilityError =
    "Supply a passing PostgreSQL compatibility report for the selected digests and runner SHA.";
  const lifecycleError =
    "Use a completed PostgreSQL runner report with successful prepare, run, and cleanup phases.";
  const historyError =
    "Rerun compatibility with a runner that records exactly one current migration history measurement.";
  const fileError = "Supply a readable regular PostgreSQL report with valid, unambiguous JSON.";

  assertRefused(
    "Usage: python3 scripts/upgrade-evidence.py recovery-history REPORT RECOVERY_DIGEST CANDIDATE_DIGEST RUNNER_SHA",
    receipt,
  );
  for (const selection of [
    [recoveryDigest, recoveryDigest, report.sourceSha],
    [recoveryDigest, candidateDigest.toUpperCase(), report.sourceSha],
    ["registry.example/image@" + recoveryDigest, candidateDigest, report.sourceSha],
    [recoveryDigest, candidateDigest, report.sourceSha.slice(0, 12)],
  ]) {
    assertRefused(identityError, receipt, ...selection);
  }
  assertRefused(compatibilityError, receipt, candidateDigest, recoveryDigest, report.sourceSha);
  assertRefused(compatibilityError, receipt, recoveryDigest, candidateDigest, "2".repeat(40));

  // A passing summary cannot substitute for the selected cases or terminal lifecycle evidence.
  await writeFile(receipt, JSON.stringify({ ...report, files: [{ ...file, tests: [] }] }));
  assertRefused(compatibilityError, ...inputs);
  for (const state of [
    undefined,
    { ...lifecycle, status: "failed" },
    { ...lifecycle, interrupted: undefined },
    { ...lifecycle, interrupted: "SIGTERM" },
    ...(["prepare", "run", "cleanup"] as const).map((phase) => ({
      ...lifecycle,
      phases: { ...phases, [phase]: undefined },
    })),
    ...[
      { status: "failed" },
      { exitCode: false },
      { exitCode: 1 },
      { signal: undefined },
      { signal: "SIGTERM" },
      { terminal: 1 },
      { error: "private phase diagnostic" },
      { reason: "spawn-failed" },
    ].map((cleanup) => ({
      ...lifecycle,
      phases: { ...phases, cleanup: { ...passed, ...cleanup } },
    })),
  ]) {
    await writeFile(receipt, JSON.stringify({ ...report, lifecycle: state }));
    assertRefused(lifecycleError, ...inputs);
  }

  for (const measurements of [
    undefined,
    [history, history],
    [history, { ...history, status: "unsupported" }],
    [{ ...history, status: "unconfirmed" }],
  ]) {
    await writeFile(receipt, JSON.stringify({ ...report, files: [{ ...file, measurements }] }));
    assertRefused(historyError, ...inputs);
  }
  await writeFile(
    receipt,
    JSON.stringify({
      ...report,
      ...postgresCompatibilityReport(recoveryDigest, candidateDigest, "unsupported"),
    }),
  );
  assertRefused(
    "The recovery controller migrator refused the upgraded history. Qualify a different recovery controller.",
    ...inputs,
  );

  // An ambiguous report must fail even when the last value would pass.
  for (const content of [
    valid.replace('"interrupted":null', '"interrupted":"private value","interrupted":null'),
    valid.slice(0, -1),
    `{"private":NaN,${valid.slice(1)}`,
  ]) {
    await writeFile(receipt, content);
    assertRefused(fileError, ...inputs);
  }
  await writeFile(receipt, valid);
  const alias = join(directory, "receipt-link");
  await symlink(receipt, alias);
  assertRefused(fileError, alias, ...inputs.slice(1));
  assertRefused(fileError, directory, ...inputs.slice(1));
});

test("the same local candidate is explained by plan and apply without printing its contents", async (t) => {
  const f = await fixture(t);
  const selectedProfile = await selectCheckout(f);
  const values = join(f.rendered, "candidate-values.yaml");
  const installation = join(f.rendered, "candidate-installation.yaml");
  const receipt = join(f.rendered, "compatibility.json");
  const password = randomBytes(24).toString("hex");
  const proxy = syntheticCredentialUrl({ username: "test", password, host: "proxy.example" });
  const candidate = JSON.stringify({
    database: { upgradeMigration: "separate" },
    api: { channelDirectoryProxyUrl: proxy },
    installation: { secretName: "occ-staged" },
  });
  await writeFile(values, candidate, { mode: 0o600 });
  await writeFile(
    installation,
    JSON.stringify({
      drivers: {
        plugin: [{ id: "codex-plugin", configuration: { catalogSource: "openai-curated" } }],
      },
    }),
    { mode: 0o600 },
  );
  const receiptCanary = randomBytes(24).toString("hex");
  const releasedController = `sha256:${"b".repeat(64)}`;
  const candidateController = f.input.images.controller.split("@")[1];
  assert.ok(candidateController);
  // The existing preview accepts the pair and does not promote the advisory to live proof.
  const compatibilityReceipt = {
    ...postgresCompatibilityReport(releasedController, candidateController, "unsupported"),
    privateReceipt: receiptCanary,
  };
  await writeFile(receipt, JSON.stringify(compatibilityReceipt), { mode: 0o600 });
  const options = [
    "--",
    "--candidate-values",
    values,
    "--candidate-installation",
    installation,
    "--controller-compatibility-results",
    receipt,
    "--timeout-seconds",
    "1",
  ];
  const plan = run("plan", f, options);
  const apply = run("apply", f, options, { automaticEvidence: true });
  assert.equal(plan.status, 0, plan.stderr);
  assert.equal(apply.status, 2);
  assert.match(apply.stderr, /--auto-approve/);
  assert.equal(apply.stdout, plan.stdout);
  assert.match(plan.stdout, /Database migration mode: separate/);
  assert.match(plan.stdout, /pause for separate database migration \(exit 3\)/);
  assert.match(plan.stdout, /Helm values change: Slack directory proxy/);
  assert.match(plan.stdout, /Candidate Installation Secret: occ-staged/);
  assert.match(plan.stdout, /Installation change: Plugin Driver registration/);
  assert.match(plan.stdout, /overwrite values.yaml and submit a Helm upgrade/);
  assert.match(plan.stdout, /overwrite the local installation.yaml/);
  assert.match(plan.stdout, /live mutable Installation Secret remains selected.*replace its data/);
  assert.match(plan.stdout, /select a staged immutable Installation Secret/);
  assert.match(plan.stdout, /compatibility receipt matches the selected controller/);
  assert.match(plan.stdout, /installed controller digest requires live preflight/);
  assert.ok(plan.stdout.includes(f.input.images.controller));
  const output = plan.stdout + plan.stderr + apply.stdout + apply.stderr;
  assert.doesNotMatch(output, /rejected the candidate migration history/);
  for (const withheld of [password, proxy, receiptCanary, receipt, releasedController]) {
    assert.ok(!output.includes(withheld));
  }
  for (const file of [
    f.profile,
    join(f.directory, f.input.kubeconfig),
    join(f.rendered, "values.yaml"),
    join(f.rendered, "installation.yaml"),
    values,
    installation,
    receipt,
  ]) {
    assert.ok(
      !output.includes(
        createHash("sha256")
          .update(await readFile(file))
          .digest("hex"),
      ),
    );
  }
  assert.deepEqual((await readdir(f.directory)).sort(), [
    "kubeconfig",
    "operator.json",
    "rendered",
  ]);

  const valid = JSON.stringify(compatibilityReceipt);
  for (const invalid of [
    valid.replace(candidateController, releasedController),
    valid.replace(releasedController, receiptCanary),
    JSON.stringify({ ...compatibilityReceipt, status: "failed" }),
    valid.slice(0, -1),
  ]) {
    await writeFile(receipt, invalid);
    for (const action of ["plan", "apply"]) {
      const result = run(action, f, options, { automaticEvidence: true });
      assert.equal(result.status, 2);
      assert.ok(result.stdout === "");
      assert.ok(
        result.stderr.includes(
          "Supply a passing PostgreSQL compatibility report for the selected controller and retry.",
        ),
      );
      assert.ok(!result.stderr.includes(receiptCanary) && !result.stderr.includes(receipt));
      assert.deepEqual((await readdir(f.directory)).sort(), [
        "kubeconfig",
        "operator.json",
        "rendered",
      ]);
    }
  }
  await writeFile(receipt, valid);
  await writeFile(
    f.profile,
    JSON.stringify({ ...selectedProfile, images: { broker: f.input.images.controller } }),
  );
  const noController = run("plan", f, options);
  assert.equal(noController.status, 2);
  assert.equal(noController.stdout, "");
  assert.match(
    noController.stderr,
    /--controller-compatibility-results requires a selected controller image/,
  );
  assert.ok(!noController.stderr.includes(receipt));
  await writeFile(f.profile, JSON.stringify(selectedProfile));

  const privateValue = randomBytes(32).toString("hex");
  for (const [file, invalid, description] of [
    [values, { deployment: { internalField: privateValue } }, "Helm values"],
    [installation, { auth: { extra: true } }, "Installation"],
    [
      installation,
      { drivers: { plugin: [{ id: "unreviewed-driver", configuration: {} }] } },
      "Installation",
    ],
  ] as const) {
    const reviewed = await readFile(file);
    await writeFile(file, JSON.stringify(invalid));
    for (const action of ["plan", "apply", "preflight"] as const) {
      const result = run(action, f, options, { automaticEvidence: true });
      assert.equal(result.status, 2, result.stderr);
      assert.ok(result.stderr.includes(`candidate ${description} change`), result.stderr);
      assert.match(result.stderr, /changes? a protected setting/);
      assert.ok(!result.stderr.includes(privateValue));
      assert.equal(result.stdout, "");
    }
    assert.deepEqual((await readdir(f.directory)).sort(), [
      "kubeconfig",
      "operator.json",
      "rendered",
    ]);
    await writeFile(file, reviewed);
  }

  const baselineValues = join(f.rendered, "values.yaml");
  await writeFile(baselineValues, JSON.stringify({ controlPlane: { protected: true } }));
  await writeFile(values, JSON.stringify({ controlPlane: { protected: 1 } }));
  const changedType = run("plan", f, options);
  assert.equal(changedType.status, 2);
  assert.match(changedType.stderr, /Helm values change a protected setting/);
  assert.equal(changedType.stdout, "");
  await writeFile(baselineValues, "{}\n");

  await writeFile(values, '["a sequence"]\n');
  const invalid = run("plan", f, options);
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /candidate Helm values must contain one readable YAML mapping/);
  assert.equal(invalid.stdout, "");
});

test("explicit evidence placement refuses unsafe parents before preview or dispatch", async (t) => {
  const f = await fixture(t);
  await selectCheckout(f);
  const safe = join(f.directory, "safe");
  const shared = join(f.directory, "shared");
  const linked = join(f.directory, "linked");
  await mkdir(safe, { mode: 0o700 });
  await mkdir(shared);
  await chmod(shared, 0o770);
  await symlink(safe, linked);
  for (const parent of [shared, linked, join(f.directory, "missing")]) {
    const evidence = join(parent, "evidence");
    const result = run("apply", { ...f, evidence }, [
      "--auto-approve",
      "--",
      "--timeout-seconds",
      "1",
    ]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /safe --evidence-dir/);
    assert.equal(result.stdout, "");
  }
  assert.deepEqual(await readdir(safe), []);
  assert.deepEqual(await readdir(shared), []);
});

test("plan and apply refuse invalid numeric options before prompting or creating evidence", async (t) => {
  const f = await fixture(t);
  await selectCheckout(f);
  const before = (await readdir(f.directory)).sort();
  for (const [flag, value] of [
    ["--timeout-seconds", "0"],
    ["--timeout-seconds", "86401"],
    ["--doctor-heap-mib", "0"],
    ["--doctor-heap-mib", "9223372036854775168"],
  ] as const) {
    for (const action of ["plan", "apply", "preflight"]) {
      const result = run(action, f, ["--", flag, value], { automaticEvidence: true });
      assert.equal(result.status, 2);
      assert.ok(result.stderr.includes(flag + " must be a positive integer"));
      assert.equal(result.stdout, "");
    }
  }
  assert.deepEqual((await readdir(f.directory)).sort(), before);
});

if (process.platform === "darwin" && `${await realpath(tmpdir())}/`.startsWith("/private/var/")) {
  test("explicit evidence uses the physical parent behind a trusted macOS system alias", async (t) => {
    const f = await fixture(t);
    await selectCheckout(f);
    const physical = await realpath(f.directory);
    const evidence = join(physical.slice("/private".length), "alias-evidence");
    const result = run("apply", { ...f, evidence }, ["--auto-approve"], {
      env: { OCC_URL: "http://127.0.0.1:9" },
    });
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes("OCC_URL must use HTTPS"));
    assert.ok(result.stdout.includes(`Evidence: ${join(physical, "alias-evidence")}`));
  });
}

test("profile operations bind Kubernetes transport and Helm release storage before approval", async (t) => {
  const f = await fixture(t);
  await selectCheckout(f);
  const config = join(f.directory, f.input.kubeconfig);
  const endpoint = "127.0.0.1:9/private-kubernetes-endpoint";
  const writeConfig = (scheme: "http" | "https") =>
    writeFile(
      config,
      JSON.stringify(kubeconfigFor(f.input.context, { server: `${scheme}://${endpoint}` })),
    );

  // The real profile runner execs a Bash helper. Detect its start and stop it
  // before it can touch recovery evidence or contact Kubernetes.
  const startup = join(f.directory, "detect-native-start.sh");
  await writeFile(startup, "printf 'native helper started\n' >&2\nexit 73\n", { mode: 0o600 });
  const env = { BASH_ENV: startup };
  const password = "fixture-release-storage-canary";
  const connection = syntheticCredentialUrl({
    protocol: "postgresql",
    username: "fixture-release-user",
    password,
    host: "storage.example.invalid",
  });

  const resumeEvidence = join(f.directory, "original-upgrade");
  const cleanupEvidence = join(f.directory, "original-preflight");
  await mkdir(resumeEvidence, { mode: 0o700 });
  await writeFile(join(resumeEvidence, "prepared"), "", { mode: 0o600 });
  await writeFile(join(resumeEvidence, "helm-started"), "", { mode: 0o600 });
  await mkdir(cleanupEvidence, { mode: 0o700 });
  const operations: (RunOptions & { action: string; evidence?: string; extra?: string[] })[] = [
    { action: "plan" },
    { action: "apply", automaticEvidence: true, confirmation: "yes\n" },
    { action: "preflight", automaticEvidence: true },
    { action: "migration-check", automaticEvidence: true },
    { action: "resume", evidence: resumeEvidence, confirmation: "yes\n" },
    { action: "migration-apply", evidence: resumeEvidence, confirmation: "yes\n" },
    {
      action: "cleanup-preflight",
      evidence: cleanupEvidence,
      extra: ["--", "--previous-process-settled", "--evidence-unrestored"],
    },
  ];
  for (const { action, evidence = f.evidence, extra = [], ...options } of operations) {
    await t.test(action, async () => {
      const before = (await readdir(f.directory)).sort();
      if (action !== "cleanup-preflight") {
        // A valid target still cannot use a different or external release store.
        await writeConfig("https");
        for (const driver of ["sql", "configmap"]) {
          const refused = run(action, { ...f, evidence }, extra, {
            ...options,
            env: { ...env, HELM_DRIVER: driver, HELM_DRIVER_SQL_CONNECTION_STRING: connection },
          });
          const output = refused.stdout + refused.stderr;
          assert.equal(refused.status, 2, output);
          assert.match(output, /HELM_DRIVER.*secret/);
          assert.doesNotMatch(
            output,
            /offline\)|Type yes to continue|Evidence:|native helper started/,
          );
          assert.ok(!output.includes(password));
          assert.deepEqual((await readdir(f.directory)).sort(), before);
        }
      }

      await writeConfig("http");
      const refused = run(action, { ...f, evidence }, extra, { ...options, env });
      const output = refused.stdout + refused.stderr;
      assert.equal(refused.status, 2, output);
      assert.match(output, /the selected kubeconfig cluster must use an HTTPS server URL/);
      assert.ok(!output.includes(endpoint));
      assert.doesNotMatch(output, /offline\)|Type yes to continue|Evidence:|native helper started/);
      assert.deepEqual((await readdir(f.directory)).sort(), before);
      assert.deepEqual((await readdir(resumeEvidence)).sort(), ["helm-started", "prepared"]);
      assert.equal(await readFile(join(resumeEvidence, "helm-started"), "utf8"), "");
      assert.equal(await readFile(join(resumeEvidence, "prepared"), "utf8"), "");
      assert.deepEqual(await readdir(cleanupEvidence), []);

      // Cleanup contacts Kubernetes without using Helm. Other operations can
      // proceed with Helm's default storage or the same storage selected explicitly.
      await writeConfig("https");
      const drivers = action === "cleanup-preflight" ? ["sql"] : [undefined, "secret"];
      for (const driver of drivers) {
        const accepted = run(action, { ...f, evidence }, extra, {
          ...options,
          env: { ...env, HELM_DRIVER: driver },
        });
        const output = accepted.stdout + accepted.stderr;
        assert.equal(accepted.status, action === "plan" ? 0 : 73, output);
        if (action === "plan") {
          assert.match(output, /TLS trust: system roots/);
        } else {
          assert.match(output, /native helper started/);
        }
        if (options.confirmation) {
          assert.match(output, /Type yes to continue/);
        }
        if (action === "resume") {
          assert.match(output, /Helm intent was recorded; its outcome remains uncertain/);
          assert.match(output, /replace the live mutable Installation Secret/);
        }
      }
    });
  }
  await writeConfig("http");
  const status = run("status", { ...f, evidence: resumeEvidence }, [], {
    env: { ...env, HELM_DRIVER: "sql" },
  });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /^ {2}prepared: observed$/m);
  assert.match(status.stdout, /^ {2}helm-started: observed$/m);
});

test("direct native upgrade rejects unsupported Helm release storage before cluster access", async (t) => {
  const f = await fixture(t);
  const selected = await selectCheckout(f);
  const bin = join(f.directory, "bin");
  const log = join(f.directory, "cluster-commands");
  await mkdir(bin);
  for (const tool of ["helm", "kubectl"]) {
    await writeFile(join(bin, tool), '#!/bin/sh\n: > "$TEST_CLUSTER_LOG"\nexit 74\n', {
      mode: 0o700,
    });
  }
  const args = [
    "--kubeconfig",
    join(f.directory, f.input.kubeconfig),
    "--context",
    selected.context,
    "--namespace",
    selected.namespace,
    "--release",
    selected.release,
    "--values",
    join(f.rendered, "values.yaml"),
    "--installation",
    join(f.rendered, "installation.yaml"),
    "--controller-image",
    selected.images.controller,
    "--source-revision",
    selected.sourceRevision,
    "--evidence-dir",
    f.evidence,
  ];
  const before = (await readdir(f.directory)).sort();
  for (const driver of ["sql", "configmap", "secret", undefined]) {
    const result = spawnSync(join(repository, "scripts/upgrade-production-images"), args, {
      cwd: repository,
      encoding: "utf8",
      env: {
        PATH: [bin, process.env.PATH].join(":"),
        TEST_CLUSTER_LOG: log,
        HELM_DRIVER: driver,
        // Stop the accepted storage settings at the next independent local check.
        OCC_URL: "http://127.0.0.1:9",
      },
    });
    const output = result.stdout + result.stderr;
    assert.equal(result.status, 1, output);
    if (driver === "sql" || driver === "configmap") {
      assert.match(output, /HELM_DRIVER.*secret/);
      assert.doesNotMatch(output, /OCC_URL/);
    } else {
      assert.match(output, /OCC_URL must use HTTPS/);
    }
    assert.deepEqual((await readdir(f.directory)).sort(), before);
  }
});

test("profile previews use the Kubernetes decoding of literal kubeconfig YAML", async (t) => {
  const f = await fixture(t);
  await selectCheckout(f);
  const config = join(f.directory, f.input.kubeconfig);
  const writeConfig = (setting: string) =>
    writeFile(
      config,
      `apiVersion: v1
kind: Config
clusters:
- name: selected
  cluster:
    server: https://127.0.0.1:9
    ${setting}
contexts:
- name: ${f.input.context}
  context:
    cluster: selected
    user: operator
users:
- name: operator
  user: {}
current-context: ${f.input.context}
`,
    );

  // Observe dispatch without allowing the native helper to write or contact Kubernetes.
  const startup = join(f.directory, "detect-native-start.sh");
  await writeFile(startup, "printf 'native helper started\n'\nexit 73\n", { mode: 0o600 });
  const env = { BASH_ENV: startup };
  await mkdir(f.evidence, { mode: 0o700 });

  await t.test("a YAML merge that selects HTTP stops before approval or dispatch", async () => {
    const before = (await readdir(f.directory)).sort();
    await writeConfig("<<: {server: http://127.0.0.1:9/merged-private-path}");
    const result = run("apply", f, ["--auto-approve"], { env, automaticEvidence: true });
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stderr, /the selected kubeconfig cluster must use an HTTPS server URL/);
    assert.doesNotMatch(result.stderr, /merged-private-path/);
    assert.equal(result.stdout, "");
    assert.deepEqual((await readdir(f.directory)).sort(), before);
  });

  for (const setting of [
    "<<: {insecure-skip-tls-verify: true}",
    "<<: {insecure-skip-tls-verify: yes}",
    "insecure-skip-tls-verify: yes",
  ]) {
    await t.test(setting, async () => {
      await writeConfig(setting);
      const plan = run("plan", f, [], { env });
      assert.equal(plan.status, 0, plan.stderr);
      assert.match(plan.stdout, /TLS VERIFICATION DISABLED/);
      assert.doesNotMatch(plan.stdout, /TLS trust: system roots|native helper started/);

      for (const action of ["preflight", "migration-check", "cleanup-preflight"]) {
        const cleanup = action === "cleanup-preflight";
        const extra = cleanup ? ["--", "--previous-process-settled", "--evidence-unrestored"] : [];
        const result = run(action, f, extra, { env, automaticEvidence: !cleanup });
        assert.equal(result.status, 73, result.stdout + result.stderr);
        assert.match(result.stdout, /TLS VERIFICATION DISABLED[\s\S]*native helper started/);
        assert.doesNotMatch(result.stdout, /Type yes to continue/);
      }
    });
  }
});

test("profile commands refuse malformed selected kubeconfig trust settings before approval", async (t) => {
  const f = await fixture(t);
  await selectCheckout(f);
  const config = join(f.directory, f.input.kubeconfig);
  const options = { automaticEvidence: true, env: { OCC_URL: "http://127.0.0.1:9" } };
  const writeConfig = (skipVerification: boolean | string) =>
    writeFile(
      config,
      JSON.stringify(
        kubeconfigFor(f.input.context, {
          "insecure-skip-tls-verify": skipVerification,
        }),
      ),
    );
  const before = (await readdir(f.directory)).sort();
  // Kubernetes can include input fields in decoding errors. Keep the raw
  // error private even when a malformed field contains a secret.
  const withheld = "fixture-private-kubeconfig-value";
  await writeConfig(withheld);
  const apply = run("apply", f, ["--auto-approve"], options);
  assert.equal(apply.status, 2, apply.stdout + apply.stderr);
  assert.match(apply.stderr, /cannot decode the kubeconfig with local kubectl/);
  assert.ok(!apply.stderr.includes(withheld));
  assert.equal(apply.stdout, "");
  assert.deepEqual((await readdir(f.directory)).sort(), before);

  for (const skipVerification of [false, true]) {
    await writeConfig(skipVerification);
    const plan = run("plan", f);
    assert.equal(plan.status, 0, plan.stderr);
    assert.match(
      plan.stdout,
      skipVerification ? /TLS VERIFICATION DISABLED/ : /TLS trust: system roots/,
    );
  }
});

test("profile and native snapshot paths reject selected built-in authentication", async (t) => {
  const f = await fixture(t);
  const selected = await selectCheckout(f);
  const config = join(f.directory, f.input.kubeconfig);
  const withheld = "fixture-private-refresh-value";
  const builtIn = { "auth-provider": { name: "oidc", config: { "refresh-token": withheld } } };
  const base = kubeconfigFor(selected.context);
  const writeConfig = async (user: Record<string, unknown>) => {
    const bytes = JSON.stringify({
      ...base,
      contexts: [
        { name: selected.context, context: { cluster: "selected", user: "operator" } },
        { name: "unused", context: { cluster: "unused", user: "other" } },
      ],
      users: [
        { name: "other", user: builtIn },
        { name: "operator", user },
      ],
    });
    await writeFile(config, bytes);
    return bytes;
  };
  const diagnostic = /selected Kubernetes user uses a built-in auth-provider/;

  await t.test("the profile stops before preview, approval, and evidence", async () => {
    // A read-only or temporary snapshot cannot retain a refreshed provider token.
    const original = await writeConfig(builtIn);
    const before = (await readdir(f.directory)).sort();
    for (const action of ["plan", "apply"]) {
      const result = run(action, f, [], {
        automaticEvidence: true,
        ...(action === "apply" ? { confirmation: "yes\n" } : {}),
        env: { OCC_URL: "http://127.0.0.1:9" },
      });
      const output = result.stdout + result.stderr;
      assert.equal(result.status, 2, output);
      assert.match(output, diagnostic);
      assert.doesNotMatch(
        output,
        /Type yes to continue|Plan \(offline\)|upgrade plan|Evidence:|OCC_URL/,
      );
      assert.ok(!output.includes(withheld));
      assert.deepEqual((await readdir(f.directory)).sort(), before);
      assert.equal(await readFile(config, "utf8"), original);
    }
  });

  await t.test("the real native snapshot refuses even without the profile wrapper", async () => {
    const original = await writeConfig(builtIn);
    const bin = join(f.directory, "bin");
    const invoked = join(f.directory, "cluster-tool-started");
    await mkdir(bin);
    const kubectl = spawnSync("sh", ["-c", "command -v kubectl"], { encoding: "utf8" });
    assert.equal(kubectl.status, 0, kubectl.stderr);
    // Keep kubectl's real offline decoder. Stop before any cluster operation
    // so even the raw-mode control cannot contact the API or refresh a token.
    const canary = 'printf "%s\n" "$0" > "$TEST_CLUSTER_MARKER"\nexit 74\n';
    await writeFile(
      join(bin, "kubectl"),
      '#!/bin/sh\nif [ "$3" = config ] && [ "$4" = view ]; then\n  exec "$TEST_KUBECTL" "$@"\nfi\n' +
        canary,
      { mode: 0o700 },
    );
    await writeFile(join(bin, "helm"), "#!/bin/sh\n" + canary, { mode: 0o700 });
    const native = (evidence: string, approval?: string, kuberc?: string) =>
      spawnSync(
        join(repository, "scripts/upgrade-production-images"),
        [
          "--migration-check-only",
          "--kubeconfig",
          config,
          "--context",
          selected.context,
          "--namespace",
          selected.namespace,
          "--release",
          selected.release,
          "--values",
          join(f.rendered, "values.yaml"),
          "--controller-image",
          selected.images.controller,
          "--source-revision",
          selected.sourceRevision,
          "--evidence-dir",
          evidence,
        ],
        {
          cwd: repository,
          encoding: "utf8",
          env: {
            PATH: [bin, process.env.PATH].join(":"),
            TEST_KUBECTL: kubectl.stdout.trim(),
            TEST_CLUSTER_MARKER: invoked,
            KUBERC: kuberc,
            OCC_UPGRADE_APPROVED_INPUTS: approval,
          },
        },
      );
    const approved = JSON.stringify({
      kubeconfig: createHash("sha256").update(original).digest("hex"),
    });
    const refused = native(f.evidence, approved);
    assert.equal(refused.status, 1, refused.stdout + refused.stderr);
    assert.match(refused.stderr, diagnostic);
    assert.ok(!refused.stderr.includes(withheld));
    assert.deepEqual(await readdir(f.evidence), []);
    await assert.rejects(readFile(invoked), { code: "ENOENT" });

    const protectedRaw = native(join(f.directory, "protected-raw-evidence"));
    assert.equal(protectedRaw.status, 1, protectedRaw.stderr);
    assert.match(protectedRaw.stderr, diagnostic);
    await assert.rejects(readFile(invoked), { code: "ENOENT" });

    const raw = native(join(f.directory, "raw-evidence"), undefined, "off");
    assert.notEqual(raw.status, 0, raw.stdout + raw.stderr);
    assert.match(await readFile(invoked, "utf8"), /helm\s*$/);
    assert.equal(await readFile(config, "utf8"), original);
  });

  await t.test(
    "the selected exec, token, and certificate configurations still preview",
    async () => {
      const marker = join(f.directory, "credential-plugin-started");
      const plugin = join(f.directory, "exec-credential");
      await writeFile(plugin, '#!/bin/sh\n: > "$TEST_PLUGIN_MARKER"\nexit 75\n', { mode: 0o700 });
      for (const user of [
        {
          exec: {
            apiVersion: "client.authentication.k8s.io/v1",
            command: plugin,
            interactiveMode: "Never",
          },
        },
        { token: "fixture-temporary-token" },
        { "client-certificate": "client.pem", "client-key": "client-key.pem" },
      ]) {
        await writeConfig(user);
        const plan = run("plan", f, [], { env: { TEST_PLUGIN_MARKER: marker } });
        assert.equal(plan.status, 0, plan.stderr);
        assert.match(plan.stdout, /TLS trust: system roots/);
        assert.ok(!(plan.stdout + plan.stderr).includes(withheld));
        await assert.rejects(stat(marker), { code: "ENOENT" });
      }
    },
  );
});

test("approval binds only the selected context's referenced CA and refuses changes while waiting", async (t) => {
  const f = await fixture(t);
  const profile = await selectCheckout(f);
  const configDirectory = join(f.directory, "contexts");
  const trustDirectory = join(f.directory, "trust");
  const config = join(configDirectory, "kubeconfig");
  const ca = join(trustDirectory, "original.pem");
  await mkdir(configDirectory, { mode: 0o700 });
  await mkdir(trustDirectory, { mode: 0o700 });
  await symlink("original.pem", join(trustDirectory, "active.pem"));
  await writeFile(f.profile, JSON.stringify({ ...profile, kubeconfig: "contexts/kubeconfig" }));
  const original = randomBytes(32).toString("hex");
  const replacement = randomBytes(32).toString("hex");
  const external = { "certificate-authority": "../trust/active.pem" };
  const inline = { "certificate-authority-data": Buffer.from(original).toString("base64") };
  const writeConfig = (selected: Record<string, string | boolean>) =>
    writeFile(config, JSON.stringify(kubeconfigFor(profile.context, selected)), { mode: 0o600 });

  await writeConfig(external);
  await writeFile(ca, original, { mode: 0o644 });
  // Production inputs may be readable in an operator-owned read-only directory.
  // The CA reference is read from the selected named context, not current-context.
  await chmod(configDirectory, 0o500);
  try {
    const plan = run("plan", f);
    assert.equal(plan.status, 0, plan.stderr);
    assert.match(
      plan.stdout,
      /TLS trust: selected external CA file \(read and bound to this preview\)/,
    );
    const privateDigest = createHash("sha256").update(original).digest("hex");
    const before = (await readdir(f.directory)).sort();

    // Change or remove the actual file after the real adapter produces its prompt.
    // The native owner's non-HTTPS guard prevents any cluster contact if dispatch regresses.
    const terminal = (action: "replace" | "remove") =>
      spawnSync(
        "python3",
        [
          "-c",
          String.raw`
import os, pty, sys
from pathlib import Path
observed = bytearray()
changed = False
def at_confirmation(fd):
    global changed
    chunk = os.read(fd, 4096)
    observed.extend(chunk)
    if not changed and b"Type yes to continue:" in observed:
        changed = True
        if sys.argv[1] == "replace":
            Path(sys.argv[2]).write_text(sys.argv[3])
        else:
            Path(sys.argv[2]).unlink()
        os.write(fd, b"yes\n")
    return chunk
sys.exit(os.waitstatus_to_exitcode(pty.spawn(sys.argv[4:], master_read=at_confirmation)))
`,
          action,
          ca,
          replacement,
          command,
          "apply",
          "--profile",
          f.profile,
        ],
        {
          cwd: repository,
          encoding: "utf8",
          timeout: 30_000,
          env: { PATH: process.env.PATH, OCC_URL: "http://127.0.0.1:9" },
        },
      );
    for (const action of ["replace", "remove"] as const) {
      await writeFile(ca, original, { mode: 0o644 });
      const result = terminal(action);
      assert.equal(result.status, 2, result.stdout + result.stderr);
      assert.match(result.stdout, /Type yes to continue/);
      if (action === "replace") {
        assert.match(result.stdout, /kubeconfig server CA changed after the preview/);
        assert.equal(await readFile(ca, "utf8"), replacement);
      } else {
        assert.match(result.stdout, /cannot read the selected kubeconfig server CA file/);
      }
      assert.doesNotMatch(result.stdout, /^Evidence:/m);
      assert.deepEqual((await readdir(f.directory)).sort(), before);
      for (const withheld of [original, replacement, privateDigest]) {
        assert.ok(!(plan.stdout + plan.stderr + result.stdout + result.stderr).includes(withheld));
      }
    }
    const missing = run("plan", f);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /cannot read the selected kubeconfig server CA file/);
    assert.equal(missing.stdout, "");
  } finally {
    await chmod(configDirectory, 0o700);
  }

  await writeConfig(inline);
  const inlinePlan = run("plan", f);
  assert.equal(inlinePlan.status, 0, inlinePlan.stderr);
  assert.match(inlinePlan.stdout, /TLS trust: inline kubeconfig CA/);
  const inlineOutput = inlinePlan.stdout + inlinePlan.stderr;
  for (const withheld of [
    original,
    inline["certificate-authority-data"],
    createHash("sha256").update(original).digest("hex"),
    createHash("sha256")
      .update(await readFile(config))
      .digest("hex"),
  ]) {
    assert.ok(!inlineOutput.includes(withheld));
  }
  await writeConfig(external);
  await writeFile(ca, "", { mode: 0o644 });
  const empty = run("plan", f);
  assert.equal(empty.status, 0, empty.stderr);
  assert.match(empty.stdout, /TLS trust: system roots/);
  await writeConfig({});
  const system = run("plan", f);
  assert.equal(system.status, 0, system.stderr);
  assert.match(system.stdout, /TLS trust: system roots/);

  await writeConfig({ "insecure-skip-tls-verify": true });
  const unverified = run("plan", f);
  assert.equal(unverified.status, 0, unverified.stderr);
  assert.match(unverified.stdout, /TLS VERIFICATION DISABLED/);
  assert.doesNotMatch(
    unverified.stdout,
    /TLS trust: (selected external CA|inline kubeconfig CA|system roots)/,
  );

  await writeConfig({ ...external, ...inline });
  const conflict = run("plan", f);
  assert.equal(conflict.status, 2);
  assert.match(conflict.stderr, /specifies both an inline CA and a CA file/);
  await writeConfig({ ...external, "insecure-skip-tls-verify": true });
  const insecure = run("plan", f);
  assert.equal(insecure.status, 2);
  assert.match(insecure.stderr, /specifies both a CA and insecure TLS/);
});
