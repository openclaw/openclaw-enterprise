import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { commandCalls, commandPath, writeCommand } from "../helpers/fake-commands.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

const execute = promisify(execFile);
const repository = fileURLToPath(new URL("../..", import.meta.url));
const upgradeScript = "scripts/upgrade-production-images";
const chart = "deploy/helm/openclaw-enterprise";

test("production upgrades check the stock chart before recording evidence or contacting the cluster", async (t) => {
  const directory = await temporaryDirectory(t, "occ-upgrade-chart-");
  const checkout = join(directory, "checkout");
  const worktree = join(directory, "worktree");
  const bin = join(directory, "bin");
  await mkdir(join(checkout, chart, "templates"), { recursive: true });
  await mkdir(bin);
  // Keep this test at the real command boundary. The selected public helpers
  // are read by the command before the first cluster call.
  for (const path of [
    upgradeScript,
    "scripts/lib/image-reference-problem.mjs",
    "packages/occ/src/image-reference.ts",
    "scripts/upgrade-repository-image-probe.mjs",
    "scripts/upgrade-image-identity.py",
    "scripts/upgrade-node-platform.py",
    "scripts/upgrade-deployment-identity.py",
    "scripts/upgrade-startup-preflight.mjs",
    "scripts/upgrade-evidence.py",
    "scripts/upgrade-helm-state.py",
    "apps/controller/src/drivers/compute/kubernetes/resource-quantities.ts",
    "scripts/upgrade-dispatch-state.py",
    "docs/flows/coordinated-production-upgrade.md",
  ]) {
    const destination = join(checkout, path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(repository, path), destination);
  }
  await writeFile(
    join(checkout, chart, "Chart.yaml"),
    "apiVersion: v2\nname: fixture\nversion: 0.1.0\n",
  );
  const manifest = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: fixture\n";
  const trackedTemplate = join(chart, "templates", "configmap.yaml");
  await writeFile(join(checkout, trackedTemplate), manifest);
  await writeFile(join(checkout, "unrelated.md"), "Outside the chart\n");
  const env = {
    PATH: commandPath(bin, dirname(process.execPath)),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    OCC_URL: "https://occ.example.invalid",
    OCC_SERVICE_KEY_FILE: join(directory, "service-key.json"),
  };
  const git = (cwd: string, ...args: string[]) => execute("git", args, { cwd, env });
  await git(checkout, "init");
  await git(checkout, "add", ".");
  await git(
    checkout,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "Fixture chart",
  );
  const revision = (await git(checkout, "rev-parse", "HEAD")).stdout.trim();
  await writeFile(
    join(checkout, ".git", "info", "exclude"),
    `/${chart}/templates/local-ignored.yaml\n/.build/\n/retained-evidence/\n`,
  );
  await git(checkout, "worktree", "add", "--detach", worktree, revision);

  for (const name of [
    "kubeconfig",
    "values.yaml",
    "installation.yaml",
    "candidate.yaml",
    "service-key.json",
  ]) {
    await writeFile(join(directory, name), "{}\n", { mode: 0o600 });
  }
  const callLog = join(directory, "cluster-calls");
  const recorder = { interpreter: "sh", log: callLog };
  for (const command of ["helm", "kubectl", "occ"]) {
    await writeCommand(bin, command, "exit 97\n", recorder);
  }
  // Supply executable lookups for parser tools. This recorder stops the command
  // at its first read, before either parser would see cluster output.
  for (const command of ["jq", "yq"]) {
    await writeCommand(bin, command, "exit 96\n", recorder);
  }
  const run = (
    evidence: string,
    gitEnvironment: NodeJS.ProcessEnv = {},
    baselineValues = join(directory, "values.yaml"),
    baselineInstallation = join(directory, "installation.yaml"),
  ) =>
    execute(
      join(repository, upgradeScript),
      [
        "--kubeconfig",
        join(directory, "kubeconfig"),
        "--context",
        "fixture",
        "--namespace",
        "openclaw-system",
        "--release",
        "oce",
        "--values",
        baselineValues,
        "--installation",
        baselineInstallation,
        "--candidate-values",
        join(directory, "candidate.yaml"),
        "--controller-image",
        `registry.example.invalid/controller@sha256:${"a".repeat(64)}`,
        "--source-revision",
        revision,
        "--evidence-dir",
        evidence,
        "--preflight-only",
      ],
      { cwd: worktree, env: { ...env, ...gitEnvironment }, timeout: 10_000 },
    );

  const refusesBeforeEffects = async (evidence: string, diagnostic: string, values?: string) => {
    await assert.rejects(run(evidence, {}, values), { code: 1, stdout: "", stderr: diagnostic });
    assert.deepEqual(await commandCalls(callLog), []);
    await assert.rejects(stat(evidence), { code: "ENOENT" });
  };

  const refusesChart = (label: string) =>
    refusesBeforeEffects(
      join(directory, label),
      "upgrade-production-images: the stock Helm chart must match the selected commit. Use a complete release checkout with the original chart files.\n",
    );

  const reachesReadiness = async (label: string, gitEnvironment: NodeJS.ProcessEnv = {}) => {
    const evidence = join(directory, label);
    await assert.rejects(run(evidence, gitEnvironment), { code: 97 });
    assert.deepEqual(await commandCalls(callLog), [
      `--kubeconfig ${join(directory, "kubeconfig")} --context fixture --request-timeout=15s get --raw=/readyz`,
    ]);
    assert.equal(await readFile(join(evidence, "requested-values.yaml"), "utf8"), "{}\n");
    await rm(callLog);
  };

  await t.test("refuses a case-distinct template hidden by core.ignorecase", async (t) => {
    const extra = join(worktree, chart, "templates", "CONFIGMAP.yaml");
    try {
      await writeFile(extra, manifest, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      t.skip("requires a case-sensitive filesystem");
      return;
    }
    t.after(async () => {
      await rm(extra);
      await git(worktree, "config", "core.ignorecase", "false");
    });
    await git(worktree, "config", "core.ignorecase", "true");
    assert.equal((await git(worktree, "status", "--porcelain", "--", chart)).stdout, "");
    await refusesChart("case-distinct");
  });

  await t.test("refuses a template under a nested .git directory", async (t) => {
    const nested = join(worktree, chart, "templates", "nested");
    await mkdir(join(nested, ".git"), { recursive: true });
    t.after(() => rm(nested, { recursive: true }));
    await writeFile(join(nested, ".git", "extra.yaml"), manifest);
    assert.equal((await git(worktree, "status", "--porcelain", "--", chart)).stdout, "");
    await refusesChart("nested-git");
    assert.equal(await readFile(join(nested, ".git", "extra.yaml"), "utf8"), manifest);
  });

  await t.test("accepts the clean chart", () => reachesReadiness("clean"));
  const writeDiagnostic =
    "upgrade-production-images: keep the evidence directory and baseline files outside the stock Helm chart.\n";
  await t.test("refuses to create evidence inside the chart through a parent alias", async () => {
    const alias = join(directory, "chart-alias");
    await symlink(join(worktree, chart), alias);
    await refusesBeforeEffects(join(alias, "evidence"), writeDiagnostic);
  });
  await t.test("refuses a chart file as the writable values baseline", async () => {
    await refusesBeforeEffects(
      join(directory, "chart-values-evidence"),
      writeDiagnostic,
      join(worktree, chart, "Chart.yaml"),
    );
  });

  await t.test("refuses output paths with a chart directory's filesystem identity", async (t) => {
    t.after(() => rm(callLog, { force: true }));
    const outside = join(directory, "outside");
    await mkdir(outside);
    const outsidePhysical = await realpath(outside);
    const chartRoot = await realpath(join(worktree, chart));
    const chartSubtree = join(chartRoot, "templates");
    assert.notEqual(outsidePhysical, chartRoot);
    assert.notEqual(outsidePhysical, chartSubtree);

    // Supply the directory identity a bind mount would report without
    // requiring mount privileges. The actual checkout and CLI remain in use.
    await writeFile(
      join(directory, "sitecustomize.py"),
      `import os

original_stat = os.stat

def alias_stat(path, *args, **kwargs):
    if not isinstance(path, int) and os.fspath(path) == os.environ["TEST_ALIAS_PATH"]:
        path = os.environ["TEST_ALIAS_TARGET"]
    return original_stat(path, *args, **kwargs)

os.stat = alias_stat
`,
    );
    const aliased = (target: string) => ({
      PYTHONPATH: directory,
      TEST_ALIAS_PATH: outsidePhysical,
      TEST_ALIAS_TARGET: target,
    });
    const evidence = join(outside, "evidence");
    const outsideValues = join(outside, "values.yaml");
    const outsideInstallation = join(outside, "installation.yaml");
    await writeFile(outsideValues, "{}\n", { mode: 0o600 });
    await writeFile(outsideInstallation, "{}\n", { mode: 0o600 });

    const cases = [
      { evidence, environment: aliased(chartRoot) },
      {
        evidence: join(directory, "aliased-values"),
        environment: aliased(chartSubtree),
        values: outsideValues,
      },
      {
        evidence: join(directory, "aliased-installation"),
        environment: aliased(chartSubtree),
        installation: outsideInstallation,
      },
    ];
    for (const input of cases) {
      await assert.rejects(
        run(input.evidence, input.environment, input.values, input.installation),
        { code: 1, stdout: "", stderr: writeDiagnostic },
      );
      assert.deepEqual(await commandCalls(callLog), []);
      await assert.rejects(stat(input.evidence), { code: "ENOENT" });
    }

    // The same paths work when the validator sees the real outside directory.
    await assert.rejects(run(evidence, {}, outsideValues, outsideInstallation), { code: 97 });
    assert.deepEqual(await commandCalls(callLog), [
      `--kubeconfig ${join(directory, "kubeconfig")} --context fixture --request-timeout=15s get --raw=/readyz`,
    ]);
    assert.equal(await readFile(join(evidence, "requested-values.yaml"), "utf8"), "{}\n");
  });

  await t.test("accepts sparse and ignored paths outside the chart", async () => {
    await git(worktree, "sparse-checkout", "set", "--no-cone", "/*", "!/unrelated.md");
    await assert.rejects(stat(join(worktree, "unrelated.md")), { code: "ENOENT" });
    for (const path of [".build", "retained-evidence"]) {
      await mkdir(join(worktree, path));
      await writeFile(join(worktree, path, "keep"), "preserve\n");
    }
    await reachesReadiness("unrelated-paths");
  });

  for (const kind of ["ignored", "untracked"]) {
    await t.test(`refuses an ${kind} template at the same release SHA`, async (t) => {
      const name = `local-${kind}.yaml`;
      const template = join(worktree, chart, "templates", name);
      await writeFile(template, manifest);
      t.after(() => rm(template));
      // The old preparation and source check accepted this SHA even when
      // ordinary Git status had no entry for the ignored file.
      assert.equal((await git(worktree, "rev-parse", "HEAD")).stdout.trim(), revision);
      if (kind === "ignored") {
        assert.equal(
          (await git(worktree, "status", "--porcelain", "--untracked-files=all", "--", chart))
            .stdout,
          "",
        );
      }

      await refusesChart(kind);
      assert.equal(await readFile(template, "utf8"), manifest);
    });
  }

  await t.test("accepts the complete chart without a usable Git index", async () => {
    const index = join(directory, "invalid-index");
    await writeFile(index, "not a Git index");
    await reachesReadiness("complete-chart-invalid-index", { GIT_INDEX_FILE: index });
  });

  const template = join(worktree, trackedTemplate);
  const differentManifest = manifest.replace("name: fixture", "name: changed");
  await t.test("refuses a tracked chart file missing from a sparse checkout", async (t) => {
    await git(worktree, "sparse-checkout", "set", "--no-cone", "/*", `!/${trackedTemplate}`);
    t.after(async () => {
      await git(worktree, "sparse-checkout", "set", "--no-cone", "/*", "!/unrelated.md");
    });
    await assert.rejects(stat(template), { code: "ENOENT" });
    assert.equal((await git(worktree, "status", "--porcelain", "--", chart)).stdout, "");
    await refusesChart("sparse-chart");
  });

  await t.test("refuses a same-length change to a tracked chart file", async (t) => {
    t.after(() => writeFile(template, manifest));
    await writeFile(template, differentManifest);
    await refusesChart("tracked-modification");
  });

  await t.test("checks bytes even when Git assumes the file is unchanged", async (t) => {
    await git(worktree, "update-index", "--assume-unchanged", trackedTemplate);
    t.after(async () => {
      await writeFile(template, manifest);
      await git(worktree, "update-index", "--no-assume-unchanged", trackedTemplate);
    });
    await reachesReadiness("unchanged-marked-file");
    await writeFile(template, differentManifest);
    assert.equal((await git(worktree, "status", "--porcelain", "--", chart)).stdout, "");
    await refusesChart("modified-marked-file");
  });

  await t.test(
    "refuses a tracked file replaced by a symbolic link to the same bytes",
    async (t) => {
      const target = join(directory, "same-content.yaml");
      await writeFile(target, manifest);
      await rm(template);
      await symlink(target, template);
      t.after(async () => {
        await rm(template);
        await writeFile(template, manifest);
      });
      await refusesChart("symbolic-link");
      assert.ok((await lstat(template)).isSymbolicLink());
    },
  );

  await t.test("refuses a tracked file replaced by a FIFO without opening it", async (t) => {
    await rm(template);
    await execute("mkfifo", [template], { env });
    t.after(async () => {
      await rm(template);
      await writeFile(template, manifest);
    });
    await refusesChart("fifo");
    assert.ok((await lstat(template)).isFIFO());
  });

  await t.test("refuses a chart reached through a symbolic link in its parent path", async (t) => {
    const parent = dirname(join(worktree, chart));
    const relocated = join(directory, "helm");
    await rename(parent, relocated);
    await symlink(relocated, parent);
    t.after(async () => {
      await rm(parent);
      await rename(relocated, parent);
    });
    await refusesChart("symlink-parent");
  });

  for (const path of [".build", "retained-evidence"]) {
    assert.equal(await readFile(join(worktree, path, "keep"), "utf8"), "preserve\n");
  }
});
