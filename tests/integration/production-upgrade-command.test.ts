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
      ...(action === "status" ? [] : ["--profile", f.profile]),
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
  const checkout = join(f.directory, "checkout");
  const scripts = join(checkout, "scripts");
  await mkdir(scripts, { recursive: true });
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
  const options = { command: adapter, cwd: checkout, env: { CAPTURE_PATH: capture } };
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

test("the same local candidate is explained by plan and apply without printing its contents", async (t) => {
  const f = await fixture(t);
  await selectCheckout(f);
  const values = join(f.rendered, "candidate-values.yaml");
  const installation = join(f.rendered, "candidate-installation.yaml");
  const receipt = join(f.rendered, "compatibility.json");
  const password = randomBytes(24).toString("hex");
  const proxy = syntheticCredentialUrl({ username: "test", password, host: "proxy.example" });
  const candidate = JSON.stringify({
    database: { upgradeMigration: "separate" },
    api: { channelDirectoryProxyUrl: proxy },
    installation: { secretName: "occ-staged" },
    deployment: { internalField: "private-value" },
  });
  await writeFile(values, candidate, { mode: 0o600 });
  await writeFile(
    installation,
    JSON.stringify({ drivers: { plugin: [{ id: "codex-plugin" }] }, auth: { extra: true } }),
    { mode: 0o600 },
  );
  const receiptCanary = randomBytes(24).toString("hex");
  await writeFile(receipt, JSON.stringify({ privateReceipt: receiptCanary }), { mode: 0o600 });
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
  assert.match(plan.stdout, /Helm values change: other settings/);
  assert.match(plan.stdout, /Installation change: other settings/);
  assert.match(plan.stdout, /overwrite values.yaml and submit a Helm upgrade/);
  assert.match(plan.stdout, /overwrite the local installation.yaml/);
  assert.match(plan.stdout, /live mutable Installation Secret remains selected.*replace its data/);
  assert.match(plan.stdout, /select a staged immutable Installation Secret/);
  assert.ok(plan.stdout.includes(f.input.images.controller));
  const output = plan.stdout + plan.stderr + apply.stdout + apply.stderr;
  for (const withheld of [password, proxy, "private-value", receiptCanary]) {
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
  ]) {
    for (const action of ["plan", "apply", "preflight"]) {
      const result = run(action, f, ["--", flag, value], { automaticEvidence: true });
      assert.equal(result.status, 2);
      assert.ok(result.stderr.includes(flag + " must be a positive integer"));
      assert.equal(result.stdout, "");
    }
  }
  assert.deepEqual((await readdir(f.directory)).sort(), before);
});

test("explicit evidence uses the physical parent behind a trusted macOS system alias", async (t) => {
  const f = await fixture(t);
  await selectCheckout(f);
  const physical = await realpath(f.directory);
  if (process.platform !== "darwin" || !physical.startsWith("/private/var/")) {
    t.skip("requires the macOS /var system alias and a temporary directory below it");
    return;
  }
  const evidence = join(physical.slice("/private".length), "alias-evidence");
  const result = run("apply", { ...f, evidence }, ["--auto-approve"], {
    env: { OCC_URL: "http://127.0.0.1:9" },
  });
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes("OCC_URL must use HTTPS"));
  assert.ok(result.stdout.includes(`Evidence: ${join(physical, "alias-evidence")}`));
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
    assert.match(plan.stdout, /verified CA from the selected kubeconfig context/);
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
  assert.doesNotMatch(inlinePlan.stdout, /verified CA from the selected kubeconfig context/);
  assert.ok(!inlinePlan.stdout.includes(inline["certificate-authority-data"]));
  await writeConfig(external);
  await writeFile(ca, "", { mode: 0o644 });
  const empty = run("plan", f);
  assert.equal(empty.status, 0, empty.stderr);
  assert.match(empty.stdout, /empty.*system trust store/);

  await writeConfig({ ...external, ...inline });
  const conflict = run("plan", f);
  assert.equal(conflict.status, 2);
  assert.match(conflict.stderr, /specifies both an inline CA and a CA file/);
  await writeConfig({ ...external, "insecure-skip-tls-verify": true });
  const insecure = run("plan", f);
  assert.equal(insecure.status, 2);
  assert.match(insecure.stderr, /specifies both a CA and insecure TLS/);
});
