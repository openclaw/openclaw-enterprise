// Prepare the release-only runner. Pair selection and package authentication are
// finished before this entry point. It never accepts a target cluster or tag.
import assert from "node:assert/strict";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  assertHostedSigninJob as validateHostedSigninJob,
  readStagedSignin,
} from "../../tests/helpers/signin/staged.mjs";
import {
  inspectSigninSupport,
  signinSupportReferences,
} from "../../tests/helpers/signin/support-images.mjs";
import {
  assertLocalRehearsalDaemon,
  bindLocalRehearsalCluster,
  runFixtureCommand,
  type FixtureRun,
} from "../../tests/helpers/production-rehearsal-custody.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const run: FixtureRun = (command, args, options) =>
  runFixtureCommand(command, args, options, String, true);
const platform = "linux/amd64";
const assertHostedSigninJob: (
  environment: NodeJS.ProcessEnv,
) => asserts environment is NodeJS.ProcessEnv & { GITHUB_WORKSPACE: string; RUNNER_TEMP: string } =
  validateHostedSigninJob;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasStringField<Key extends string>(
  value: unknown,
  key: Key,
): value is Record<Key, string> {
  return isRecord(value) && typeof value[key] === "string";
}

export function restrictStagingProcess(e: NodeJS.ProcessEnv) {
  // This command runs in its own process; spawned tools inherit only the runner
  // facts they need. Registry, model and Actions service credentials stay out.
  const keep = new Set([
    "PATH",
    "GOMODCACHE",
    "CI",
    "GITHUB_ACTIONS",
    "RUNNER_ENVIRONMENT",
    "RUNNER_OS",
    "RUNNER_ARCH",
    "RUNNER_TEMP",
    "RUNNER_TRACKING_ID",
    "GITHUB_WORKSPACE",
    "GITHUB_SHA",
    "GITHUB_WORKFLOW_SHA",
    "GITHUB_REPOSITORY",
    "GITHUB_EVENT_NAME",
    "GITHUB_REF",
    "GITHUB_REF_PROTECTED",
    "GITHUB_JOB",
    "GITHUB_WORKFLOW_REF",
    "GITHUB_RUN_ID",
    "GITHUB_RUN_ATTEMPT",
    "STAGING_INSTALLATION",
    "CONFIGURED_STAGING_INSTALLATION",
    "GHCR_CONTROLLER_IMAGE",
    "GHCR_RUNTIME_IMAGE",
  ]);
  for (const name of Object.keys(e)) {
    if (!keep.has(name)) {
      delete e[name];
    }
  }
  Object.assign(e, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_LAZY_FETCH: "1",
  });
}

async function prepare(expectedPlanHash: string | undefined) {
  const e = process.env;
  assertHostedSigninJob(e);
  restrictStagingProcess(e);
  assert.equal(await realpath(root), await realpath(e.GITHUB_WORKSPACE));
  assert.equal(await realpath(root), await realpath(process.cwd()));
  const picked: { previous: unknown; candidate: unknown; fixedRuntime: unknown } =
    await readStagedSignin({
      directory: e.RUNNER_TEMP,
      expectedPlanHash,
      workflowSha: e.GITHUB_WORKFLOW_SHA,
      installation: e.STAGING_INSTALLATION,
    });
  assert.equal((await run("git", ["rev-parse", "HEAD"])).trim(), e.GITHUB_WORKFLOW_SHA);
  assert.equal(await run("git", ["status", "--porcelain", "--untracked-files=no"]), "");
  const { ghcrPackageName } = await import("./container-release.mjs");
  const refs = await signinSupportReferences();
  const release = [picked.previous, picked.candidate, picked.fixedRuntime].map((item, i) => {
    const repository = i < 2 ? e.GHCR_CONTROLLER_IMAGE : e.GHCR_RUNTIME_IMAGE;
    ghcrPackageName(repository);
    assert.ok(isRecord(item));
    assert.equal(item.reference, repository + "@" + item.rootDigest);
    assert.equal(item.platform, platform);
    for (const digest of [item.rootDigest, item.manifestDigest, item.configDigest]) {
      assert.ok(typeof digest === "string");
      assert.match(digest, /^sha256:[a-f0-9]{64}$/);
    }
    return {
      image: item.reference,
      rootDigest: item.rootDigest,
      manifestDigest: item.manifestDigest,
      configDigest: item.configDigest,
    };
  });
  assert.equal(new Set(release.map((x) => x.image)).size, 3);
  const directory = join(e.RUNNER_TEMP, "staging-installed-signin");
  await mkdir(directory, { mode: 0o700 }); // exclusive: never adopt an earlier attempt
  const docker = join(directory, "docker");
  const home = join(directory, "home");
  await mkdir(docker, { mode: 0o700 });
  await mkdir(home, { mode: 0o700 });
  e.DOCKER_CONFIG = docker;
  e.HOME = home;
  e.DOCKER_HOST = "unix:///var/run/docker.sock";
  await assertLocalRehearsalDaemon(run);
  // No registry token or chart credentials are supplied to the host or node.
  for (const ref of Object.values(refs)) {
    await run("docker", ["pull", "--platform", platform, ref], {
      protectedInput: true,
      timeout: 600_000,
    });
  }
  const support: Record<string, unknown> = await inspectSigninSupport(run, refs);
  const { prepareStagingSigninCluster } = await import("./prepare.mjs");
  const statePath = join(directory, "cluster-state.json");
  const existingVolumes = new Set(
    (await run("docker", ["volume", "ls", "-q"])).trim().split(/\r?\n/u),
  );
  const created: unknown = await prepareStagingSigninCluster(statePath);
  assert.ok(hasStringField(created, "name"));
  const bound = await bindLocalRehearsalCluster(
    run,
    created.name,
    join(directory, "bound-kubeconfig"),
  );
  const membership = await bound.cleanupIdentity();
  assert.ok(
    membership.volumes.every(({ name }) => !existingVolumes.has(name)),
    "fixture mounted a preexisting volume",
  );
  for (const image of [...release, support.node, support.postgres]) {
    assert.ok(hasStringField(image, "image"));
    await bound.pullPublishedImage(image.image);
    assert.ok(
      hasStringField(image, "rootDigest") &&
        hasStringField(image, "manifestDigest") &&
        hasStringField(image, "configDigest"),
    );
    await bound.assertStagedImage(image);
  }
  assert.deepEqual(await bound.cleanupIdentity(), membership);
  const receipt = {
    membership,
    kind: "staged-signin-cluster",
    workflowSha: e.GITHUB_WORKFLOW_SHA,
    installation: e.STAGING_INSTALLATION,
    planSha256: expectedPlanHash,
    cluster: created.name,
    nodeUID: bound.nodeUID,
    clusterUID: bound.clusterUID,
    serverID: bound.serverID,
    runId: e.GITHUB_RUN_ID,
    runAttempt: e.GITHUB_RUN_ATTEMPT,
    stateSha256: createHash("sha256")
      .update(await readFile(statePath))
      .digest("hex"),
    support,
    release,
  };
  const bytes = JSON.stringify(receipt) + "\n";
  await writeFile(join(directory, "prepared.json"), bytes, { flag: "wx", mode: 0o600 });
  return createHash("sha256").update(bytes).digest("hex");
}
if (import.meta.main) {
  assert.equal(process.argv.length, 3, "supply the sign-in plan digest from pair preparation");
  console.log(await prepare(process.argv[2]));
}
