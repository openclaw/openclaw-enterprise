import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const digest = `sha256:${"b".repeat(64)}`;
const repository = "openclaw/openclaw-enterprise";
const runtimeFile = "tests/integration/runtime-image-startup.test.mjs";
const runtimeChildCase = "runtime startup child consumes the CI-prepared Codex seccomp profile";
const runtimeChildFixture = new URL(
  "../fixtures/staging-qualification-seccomp-child.ts",
  import.meta.url,
);

test(
  "staging workflow command consumes bound digests and refuses invalid release evidence",
  checkWorkflowCommand,
);
test("staging runtime lane preserves the reviewed Codex version in its child", checkRuntimeChild);

async function checkWorkflowCommand(t: TestContext) {
  const directory = await mkdtemp(join(process.cwd(), ".staging-command-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "trusted-source");
  const hostEnv = { HOME: directory, PATH: process.env.PATH, GIT_NO_LAZY_FETCH: "1" };
  const git = (args: string[], cwd = root) =>
    execute("git", ["-C", cwd, ...args], { env: hostEnv });
  const commit = async (cwd = root) => {
    await git(["add", "--all"], cwd);
    await git(
      [
        "-c",
        "user.name=CI Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--quiet",
        "--no-gpg-sign",
        "-m",
        "Fixture inputs",
      ],
      cwd,
    );
    return (await git(["rev-parse", "HEAD"], cwd)).stdout.trim();
  };
  const recipePath = join(root, "deploy/runtime/Dockerfile");
  await mkdir(dirname(recipePath), { recursive: true });
  const recipe = await readFile("deploy/runtime/Dockerfile", "utf8");
  const nodeBaseImage = recipe.match(/^ARG NODE_BASE_IMAGE=(.+)$/m)?.[1];
  assert.ok(nodeBaseImage);
  // All executable files remain the current trusted implementation. Only the
  // literal Dockerfile has fixture history; none of that history is executed.
  await symlink(resolve("scripts"), join(root, "scripts"), "dir");
  await symlink(resolve("tests"), join(root, "tests"), "dir");
  await writeFile(
    recipePath,
    recipe.replace("OPENAI_CODEX_VERSION=0.164.0", "OPENAI_CODEX_VERSION=0.160.0"),
  );
  await git(["init", "--quiet", "--initial-branch=main"]);
  const unsupported = await commit();
  await writeFile(recipePath, recipe + "\nENV OPENAI_CODEX_VERSION=0.164.0\n");
  const duplicateField = await commit();
  await writeFile(
    recipePath,
    recipe.replace("OPENAI_CODEX_VERSION=0.164.0", "OPENAI_CODEX_VERSION=unreviewed"),
  );
  const malformedField = await commit();
  await rm(recipePath);
  await symlink("missing-recipe", recipePath);
  const symlinkSource = await commit();
  await rm(recipePath);
  await writeFile(recipePath, recipe);
  const source = await commit();
  const unrelated = (
    await git([
      "-c",
      "user.name=CI Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit-tree",
      "HEAD^{tree}",
      "-m",
      "Unrelated fixture history",
    ])
  ).stdout.trim();
  await writeFile(join(root, "workflow-marker"), "Trusted workflow revision\n");
  const workflowSha = await commit();
  await git(["update-ref", "refs/remotes/origin/main", workflowSha]);
  // Advance main only on the remote so the runner starts without this commit.
  const remote = join(directory, "official-origin");
  await git(["clone", "--quiet", "--no-local", root, remote]);
  await git(["config", "uploadpack.allowFilter", "true"], remote);
  await writeFile(join(remote, "workflow-marker"), "Main advanced after checkout\n");
  const newerMain = await commit(remote);
  const newerTree = (await git(["rev-parse", "HEAD^{tree}"], remote)).stdout.trim();
  const env = {
    ...hostEnv,
    RUNNER_TEMP: directory,
    GH_TOKEN: "invented-workflow-token",
    GITHUB_ACTOR: "fixture-actor",
    SOURCE_SHA: source,
    GITHUB_SHA: workflowSha,
    GITHUB_WORKFLOW_SHA: workflowSha,
    GITHUB_WORKSPACE: root,
    GITHUB_REPOSITORY: repository,
    GITHUB_REF: "refs/heads/main",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/staging-qualification.yml@refs/heads/main`,
    PUBLICATION_RUN_ID: "123",
    PUBLICATION_ATTEMPT: "2",
    STAGING_INSTALLATION: "test-staging",
    CONFIGURED_STAGING_INSTALLATION: "test-staging",
    GHCR_CONTROLLER_IMAGE: "ghcr.io/openclaw/controller",
    GHCR_RUNTIME_IMAGE: "ghcr.io/openclaw/runtime",
    GITHUB_OUTPUT: join(directory, "hostile-output"),
  };
  // A writable hostile output path must remain untouched even on success.
  await writeFile(env.GITHUB_OUTPUT, "owner data\n");
  const receipt = ["controller", "runtime"].map((image) => ({
    image,
    sourceSha: source,
    workflowSha: source,
    runId: "123",
    attempt: "2",
    ciRunId: "456",
    ciAttempt: "1",
    nodeBaseImage,
    platforms: ["linux/amd64", "linux/arm64"],
    digest,
    archiveSha256: "c".repeat(64),
    destination: `ghcr.io/openclaw/${image}`,
    tag: `sha-${source}`,
  }));
  const archiveDirectory = join(directory, "publication");
  await mkdir(archiveDirectory);
  const archive = join(archiveDirectory, "response-header-filename.zip");
  const replacement = join(directory, "replacement.zip");
  const metadata = join(directory, "artifact.json");
  const receiptPath = join(directory, "publication.json");
  const recordArchive = async () => {
    const bytes = await readFile(archive);
    await writeFile(
      metadata,
      JSON.stringify({
        digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        size_in_bytes: bytes.length,
      }),
    );
  };
  const pack = async (value: unknown, path = archive) => {
    await writeFile(receiptPath, JSON.stringify(value));
    await rm(path, { force: true });
    await execute("zip", ["-q", path, "publication.json"], { cwd: directory, env: hostEnv });
    if (path === archive) {
      await recordArchive();
    }
  };
  await pack(receipt);
  const preload = join(directory, "transport.mjs");
  await writeFile(
    preload,
    `
import { syncBuiltinESMExports } from 'node:module';
import child from 'node:child_process';
import crypto from 'node:crypto';
import { appendFileSync, readFileSync, renameSync, statSync, readdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const env = process.env;
// Service identities are fixed independently of dispatched inputs and receipts.
const source = ${JSON.stringify(source)};
const workflowSha = ${JSON.stringify(workflowSha)};
const token = 'invented-workflow-token';
const auth = Buffer.from('fixture-actor:' + token).toString('base64');
const repo = '${repository}';
const publication = '.github/workflows/container-publish.yml';
const log = value => appendFileSync(env.RUNNER_TEMP + '/calls.jsonl', JSON.stringify(value) + '\\n');
if (env.CHANGE_ARCHIVE) {
  const archive = ${JSON.stringify(archive)};
  const replacement = ${JSON.stringify(replacement)};
  const expected = JSON.parse(readFileSync(${JSON.stringify(metadata)}, 'utf8')).digest;
  const createHash = crypto.createHash;
  crypto.createHash = (...args) => {
    const hash = createHash(...args);
    const digest = hash.digest;
    hash.digest = function (...args) {
      const result = digest.apply(this, args);
      if ('sha256:' + result === expected) {
        if (env.CHANGE_ARCHIVE === 'rename') renameSync(replacement, archive);
        else writeFileSync(archive, readFileSync(replacement));
        log({changedArchive: env.CHANGE_ARCHIVE});
      }
      return result;
    };
    return hash;
  };
}
const run = (id, workflow, event, attempt) => ({id, run_attempt: attempt, workflow_id: id,
  path: workflow, repository: {full_name: repo}, head_repository: {full_name: repo},
  head_branch: 'main', head_sha: source, event, status: 'completed', conclusion: 'success'});
globalThis.fetch = async (url, options) => {
  assert.equal(options.headers.Authorization, 'Bearer ' + token);
  const path = new URL(url).pathname;
  log({api: path});
  let body;
  if (path === '/repos/' + repo) body = {full_name: repo, private: false, default_branch: 'main'};
  else if (path.endsWith('/branches/main')) body = {name: 'main', protected: !env.UNPROTECTED, commit: {sha: env.OBSERVED_MAIN_SHA || workflowSha}};
  else if (path.endsWith('/workflows/container-publish.yml')) body = {id: 123, path: publication, state: 'active'};
  else if (path.endsWith('/workflows/ci.yml')) body = {id: 456, path: '.github/workflows/ci.yml', state: 'active'};
  else if (path.endsWith('/workflows/ci.yml/runs')) {
    assert.equal(new URL(url).searchParams.get('head_sha'), source);
    const ci = run(456, '.github/workflows/ci.yml', 'push', 1);
    if (env.FOREIGN_CI) ci.head_repository.full_name = 'other/repository';
    body = {workflow_runs: [ci]};
  }
  else if (path.endsWith('/runs/123')) {
    body = run(123, publication, 'workflow_dispatch', env.BAD_ATTEMPT ? 3 : 2);
    if (env.FOREIGN_PRODUCER) body.head_repository.full_name = 'other/repository';
  }
  else if (path.endsWith('/runs/456')) body = run(456, '.github/workflows/ci.yml', 'push', 1);
  else if (path.endsWith('/runs/123/attempts/2/jobs')) body = {jobs: [{name: 'Publish exact OCI digests to public GHCR',
    status: 'completed', conclusion: env.SKIP_PUBLISH ? 'skipped' : 'success', head_sha: source}]};
  else if (path.endsWith('/artifacts')) {
    const artifact = {id: env.BAD_ARTIFACT_ID ? '789\\nsource_sha=bad' : 789, name: 'container-publication-123-2',
      ...JSON.parse(readFileSync(${JSON.stringify(metadata)}, 'utf8')),
      expired: !!env.EXPIRED, workflow_run: {id: 123, head_sha: source}};
    body = {artifacts: env.DUPLICATE ? [artifact, artifact] : [artifact]};
  }
  else if (path.endsWith('/runs/456/attempts/1/jobs')) body = {jobs: [{name: 'CI Required', status: 'completed', conclusion: 'success', head_sha: source}]};
  else throw new Error('Unexpected network request: ' + url);
  return new Response(JSON.stringify(body), {status: 200});
};
const executeSync = child.execFileSync;
child.execFileSync = (command, args, options) => {
  if (command === 'git') {
    assert.equal(options.env.GH_TOKEN, undefined);
    assert.equal(options.env.GITHUB_TOKEN, undefined);
    assert.equal(options.env.GITHUB_OUTPUT, undefined);
    if (args.includes('fetch')) {
      const official = 'https://github.com/openclaw/openclaw-enterprise.git';
      assert.equal(args.at(-2), official);
      assert.equal(args.at(-1), ${JSON.stringify(newerMain)});
      assert.equal(options.env.GIT_TERMINAL_PROMPT, '0');
      log({gitFetch: args.at(-1)});
      // Redirect only transport. Git still fetches and checks the real fixture history.
      return executeSync(command, args.map(arg => arg.replace(official, ${JSON.stringify(pathToFileURL(remote).href)})), options);
    }
    return executeSync(command, args, options);
  }
  assert.equal(process.env.GH_TOKEN, undefined);
  assert.equal(process.env.GITHUB_TOKEN, undefined);
  log({command, args});
  if (command === 'docker' && args[0] === '--config') {
    assert.equal(args[2], '--host=unix:///var/run/docker.sock');
    assert.equal(args[3], 'pull');
    assert.equal(options.stdio, 'ignore');
    const config = args[1] + '/config.json';
    assert.equal(statSync(config).mode & 0o777, 0o600);
    assert.equal(statSync(args[1]).mode & 0o777, 0o700);
    assert.deepEqual(JSON.parse(readFileSync(config, 'utf8')), {auths: {'ghcr.io': {auth}}});
    if (env.FAIL_PULL === args.at(-1)) throw new Error('denied ' + token + ' ' + auth);
    return 'untrusted-output ' + token;
  }
  assert.ok(!readdirSync(env.RUNNER_TEMP).some(name => name.startsWith('staging-docker-')));
  if (command === 'docker' && args[0] === 'image') return JSON.stringify([{
    RepoDigests: [env.BAD_DIGEST ? 'wrong' : args[2]],
    Id: args[2].startsWith('sha256:') ? args[2] : 'sha256:' + (args[2].includes('controller') ? 'c' : 'd').repeat(64),
    Os: 'linux', Architecture: 'amd64', Config: {Labels: {'org.opencontainers.image.revision': env.BAD_LABEL ? workflowSha : source}}
  }]);
  throw Error('Unexpected subprocess: ' + command + ' ' + args.join(' '));
};
const spawnSync = child.spawnSync;
child.spawnSync = (command, args, options) => {
  assert.equal(command, 'python3');
  assert.equal(options.env.GH_TOKEN, undefined);
  assert.equal(options.env.GITHUB_TOKEN, undefined);
  assert.equal(options.env.GITHUB_OUTPUT, undefined);
  return spawnSync(command, args, options);
};
// Fail the real preparer's first Docker command. No helper or state outcome is
// replaced: the preparer must record its resource, fail, and execute cleanup.
const spawn = child.spawn;
child.spawn = (command, args, options) => {
  assert.equal(options?.env?.GH_TOKEN, undefined);
  log({spawn: command, args});
  if (command === 'docker' && args[0] === 'tag') {
    return spawn(process.execPath, ['-e', 'process.exit(1)'], options);
  }
  if (command === 'docker' && args[0] === 'image' && args[1] === 'rm') {
    return spawn(process.execPath, ['-e', 'process.exit(0)'], options);
  }
  throw Error('Unexpected asynchronous subprocess: ' + command + ' ' + args.join(' '));
};
syncBuiltinESMExports();
`,
  );
  const workflow = await readFile(".github/workflows/staging-qualification.yml", "utf8");
  assert.equal((workflow.match(/uses: actions\/checkout@/g) ?? []).length, 1);
  assert.ok(workflow.includes("ref: ${{ github.workflow_sha }}"));
  assert.ok(workflow.includes("persist-credentials: false"));
  assert.ok(workflow.includes("package-manager-cache: false"));
  assert.ok(workflow.includes("skip-decompress: true"));
  assert.ok(workflow.includes("digest-mismatch: error"));
  const commands = [
    ...workflow.matchAll(
      /^ {8}run: (node scripts\/ci\/staging-qualification\.ts (validate|pull|smoke).*?)$/gm,
    ),
  ];
  assert.equal(commands.length, 3);
  const run = (command: string, patch: Record<string, string> = {}) => {
    const selected = commands.find((match) => match[2] === command)?.[1];
    assert.ok(selected);
    return execute("bash", ["-e", "-c", selected], {
      cwd: root,
      timeout: 30_000,
      env: { ...env, NODE_OPTIONS: `--import=${preload}`, ...patch },
    });
  };
  const calls = async () =>
    (await readFile(join(directory, "calls.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  const containerCalls = async () => (await calls()).filter((call) => call.command || call.spawn);
  const refsBefore = (await git(["show-ref", "--head"])).stdout;
  const configPath = join(root, ".git/config");
  const configBefore = await readFile(configPath);
  await run("validate");
  assert.ok(!(await calls()).some((call) => call.gitFetch));
  await assert.rejects(git(["cat-file", "-e", newerMain]), { code: 1 });
  await run("validate", { OBSERVED_MAIN_SHA: newerMain });
  assert.equal((await git(["cat-file", "-t", newerMain])).stdout, "commit\n");
  await assert.rejects(git(["cat-file", "-e", newerTree]), { code: 1 });
  assert.equal((await git(["show-ref", "--head"])).stdout, refsBefore);
  assert.equal((await git(["status", "--porcelain"])).stdout, "");
  assert.deepEqual(await readFile(configPath), configBefore);
  await assert.rejects(readFile(join(root, ".git/FETCH_HEAD")), { code: "ENOENT" });
  assert.deepEqual(
    (await calls()).flatMap((call) => (call.gitFetch ? [call.gitFetch] : [])),
    [newerMain],
  );
  const beforeDivergence = (await calls()).length;
  await assert.rejects(run("validate", { OBSERVED_MAIN_SHA: unrelated }), { code: 1 });
  assert.deepEqual((await calls()).slice(beforeDivergence), [
    { api: `/repos/${repository}` },
    { api: `/repos/${repository}/branches/main` },
  ]);
  assert.equal(await readFile(env.GITHUB_OUTPUT, "utf8"), "owner data\n");
  const success = await run("pull");
  assert.equal(success.stdout, "");
  assert.equal(success.stderr, "");
  const pulled = join(directory, "staging-pulled-images.json");
  const proof = JSON.parse(await readFile(pulled, "utf8"));
  assert.equal(proof.liveInstall, false);
  assert.equal(proof.sourceSha, source);
  assert.equal(proof.workflowSha, workflowSha);
  assert.equal(proof.codexVersion, "0.164.0");
  assert.equal(proof.nodeBaseImage, nodeBaseImage);
  assert.equal(proof.selected.runtime, `${env.GHCR_RUNTIME_IMAGE}@${digest}`);
  assert.equal(proof.imageIds.controller, `sha256:${"c".repeat(64)}`);
  assert.equal(proof.imageIds.runtime, `sha256:${"d".repeat(64)}`);
  assert.deepEqual(
    (await containerCalls())
      .filter((call) => call.args[3] === "pull")
      .map((call) => call.args.slice(3)),
    [
      ["pull", "--platform", "linux/amd64", `${env.GHCR_CONTROLLER_IMAGE}@${digest}`],
      ["pull", "--platform", "linux/amd64", `${env.GHCR_RUNTIME_IMAGE}@${digest}`],
    ],
  );
  await assert.rejects(run("smoke"), /Startup must run without the GitHub token/);
  await assert.rejects(run("smoke", { GH_TOKEN: "" }), /failed|exited|exit code/i);
  assert.ok((await calls()).some((call) => call.spawn === "docker" && call.args[0] === "tag"));
  assert.ok(
    (await calls()).some(
      (call) => call.spawn === "docker" && call.args[0] === "image" && call.args[1] === "rm",
    ),
  );
  for (const lane of ["packaging", "runtime-startup"]) {
    await assert.rejects(readFile(join(directory, `staging-images-${lane}.json`)), {
      code: "ENOENT",
    });
  }
  assert.equal(await readFile(pulled, "utf8"), JSON.stringify(proof));
  await assert.rejects(readFile(join(directory, "staging-qualification.json")), { code: "ENOENT" });
  const upload = workflow
    .split(/^ {6}- /m)
    .find((step) => step.includes("uses: actions/upload-artifact@"));
  assert.ok(upload);
  assert.match(upload, /^ {8}if: always\(\)$/m);
  const uploads = [...upload.matchAll(/^ {12}\$\{\{ runner\.temp \}\}\/([^\n]+)$/gm)].map(
    (entry) => entry[1],
  );
  assert.deepEqual(uploads, [
    "staging-pulled-images.json",
    "staging-images-packaging.json",
    "staging-images-runtime-startup.json",
    "staging-qualification.json",
  ]);
  const produced = await readdir(directory);
  assert.deepEqual(
    uploads.filter((name) => produced.includes(name)),
    ["staging-pulled-images.json"],
  );
  assert.equal(await readFile(env.GITHUB_OUTPUT, "utf8"), "owner data\n");
  await rm(pulled);
  // Both partial and initial pull failure must erase credentials and suppress
  // subprocess output. Neither can create a success or pull receipt.
  for (const reference of [proof.selected.controller, proof.selected.runtime]) {
    await assert.rejects(run("pull", { FAIL_PULL: reference }), (error: unknown) => {
      assert.ok(error instanceof Error && "stdout" in error && "stderr" in error);
      assert.match(String(error.stderr), /Unable to pull/);
      for (const secret of [
        env.GH_TOKEN,
        Buffer.from(`${env.GITHUB_ACTOR}:${env.GH_TOKEN}`).toString("base64"),
      ]) {
        assert.ok(!String(error.stdout).includes(secret));
        assert.ok(!String(error.stderr).includes(secret));
      }
      return true;
    });
    assert.ok(!(await readdir(directory)).some((name) => name.startsWith("staging-docker-")));
    await assert.rejects(readFile(pulled), { code: "ENOENT" });
  }
  for (const patch of [
    { PUBLICATION_RUN_ID: "01" },
    { PUBLICATION_RUN_ID: "123\n" },
    { PUBLICATION_RUN_ID: "9007199254740992" },
    { PUBLICATION_ATTEMPT: "2\nartifact_id=999" },
    { PUBLICATION_ATTEMPT: "0" },
    { SOURCE_SHA: "../other" },
    { SOURCE_SHA: "e".repeat(40) },
    { GITHUB_WORKFLOW_SHA: source },
    { UNPROTECTED: "1" },
    { FOREIGN_PRODUCER: "1" },
    { FOREIGN_CI: "1" },
    { BAD_ATTEMPT: "1" },
    { SKIP_PUBLISH: "1" },
    { EXPIRED: "1" },
    { DUPLICATE: "1" },
    { BAD_ARTIFACT_ID: "1" },
    { SOURCE_SHA: unsupported },
    { SOURCE_SHA: symlinkSource },
    { SOURCE_SHA: unrelated },
    { SOURCE_SHA: duplicateField },
    { SOURCE_SHA: malformedField },
    { GITHUB_ACTOR: "" },
    { GHCR_RUNTIME_IMAGE: "ghcr.io/other/runtime" },
    { CONFIGURED_STAGING_INSTALLATION: "other" },
  ]) {
    const before = await containerCalls();
    await assert.rejects(run("pull", patch), { code: 1 });
    assert.deepEqual(await containerCalls(), before, "Invalid evidence must stop before Docker");
  }
  for (const patch of [{ BAD_DIGEST: "1" }, { BAD_LABEL: "1" }]) {
    await assert.rejects(run("pull", patch), { code: 1 });
    await assert.rejects(readFile(pulled), { code: "ENOENT" });
  }
  // Change the original pathname or its inode immediately after the real hash.
  // A valid alternate receipt must not be able to select its own image digest.
  for (const change of ["rename", "overwrite"]) {
    await pack(receipt);
    await pack(
      receipt.map((image) => ({ ...image, digest: `sha256:${"e".repeat(64)}` })),
      replacement,
    );
    await run("pull", { CHANGE_ARCHIVE: change });
    assert.ok((await calls()).some((call) => call.changedArchive === change));
    const observed = JSON.parse(await readFile(pulled, "utf8"));
    assert.deepEqual(observed.selected, proof.selected);
    await rm(pulled);
  }
  await pack(receipt);
  const before = await containerCalls();
  const bytes = await readFile(archive);
  const firstByte = bytes[0];
  assert.ok(firstByte !== undefined);
  bytes[0] = firstByte ^ 1;
  await writeFile(archive, bytes);
  await assert.rejects(run("pull"), /Publication archive digest mismatch/);
  await pack(receipt);
  await cp(archive, join(archiveDirectory, "extra.zip"));
  await assert.rejects(run("pull"), /exactly one publication archive/);
  await rm(join(archiveDirectory, "extra.zip"));
  await writeFile(join(directory, "unexpected.txt"), "not a receipt");
  await execute("zip", ["-q", archive, "unexpected.txt"], { cwd: directory, env: hostEnv });
  await recordArchive();
  await assert.rejects(run("pull"), /only publication.json/);
  await writeFile(archive, "invalid zip data");
  await recordArchive();
  await assert.rejects(run("pull"), /only publication.json/);
  await pack(receipt);
  await cp(archive, replacement);
  await rm(archive);
  await symlink(replacement, archive);
  await assert.rejects(run("pull"), /ELOOP/);
  await rm(archive);
  await execute("mkfifo", [archive], { env: hostEnv });
  await assert.rejects(run("pull"), /must be a regular file/);
  await rm(archive);
  // A valid JSON value beyond the uncompressed bound must be rejected even
  // when the archive is small and has an authenticated digest.
  await writeFile(receiptPath, JSON.stringify(receipt) + " ".repeat(64 * 1024));
  await execute("zip", ["-q", archive, "publication.json"], { cwd: directory, env: hostEnv });
  await recordArchive();
  await assert.rejects(run("pull"), /at most 64 KiB/);
  await writeFile(receiptPath, JSON.stringify(receipt));
  await execute(
    "python3",
    [
      "-I",
      "-S",
      "-c",
      `import sys, zipfile
with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as archive:
    archive.write(sys.argv[2], 'publication.json')
    archive.write(sys.argv[2], 'publication.json')`,
      archive,
      receiptPath,
    ],
    { env: hostEnv },
  );
  await recordArchive();
  await assert.rejects(run("pull"), /only publication.json/);
  // A receipt cannot redirect the exact CI lookup, including to another valid ID.
  for (const ciRunId of ["999", "456/../../other"]) {
    await pack(receipt.map((image) => ({ ...image, ciRunId })));
    await assert.rejects(run("pull"), { code: 1 });
    assert.ok(!(await calls()).some((call) => call.api?.includes("/runs/999")));
  }
  assert.deepEqual(await containerCalls(), before);
  assert.equal(await readFile(env.GITHUB_OUTPUT, "utf8"), "owner data\n");
}

async function checkRuntimeChild(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "staging-runtime-lane-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lane = "images-runtime-startup";
  const manifest = join(root, "manifest.json");
  const state = join(root, "state.json");
  const result = join(root, "results.json");
  const original = JSON.parse(await readFile(`scripts/ci/test-suites/${lane}.json`, "utf8"));
  // Keep the actual lane's environment contract and startup file selection. The
  // fixture root has no preparer and runs only the child profile check.
  await mkdir(join(root, dirname(runtimeFile)), { recursive: true });
  await symlink(fileURLToPath(runtimeChildFixture), join(root, runtimeFile));
  await writeFile(
    manifest,
    JSON.stringify({
      version: 1,
      lanes: {
        [lane]: {
          ...original,
          files: [{ path: runtimeFile, expectedTests: [runtimeChildCase] }],
          parallelFiles: [],
        },
      },
      groups: {},
    }),
  );
  const contents = '{"defaultAction":"SCMP_ACT_ERRNO","syscalls":[]}\n';
  const sha256 = createHash("sha256").update(contents).digest("hex");
  for (const version of [undefined, "0.163.0-alpha.2"]) {
    const profile = join(root, `codex-${version ?? "0.164.0"}-${sha256}.json`);
    await writeFile(profile, contents);
    await writeFile(
      state,
      JSON.stringify({
        resources: [{ kind: "k3d-cluster", codexDockerSeccompProfile: { path: profile, sha256 } }],
      }),
    );
    await execute(
      process.execPath,
      [
        "scripts/ci/run-tests.mjs",
        "run",
        lane,
        "--file",
        runtimeFile,
        "--root",
        root,
        "--manifest",
        manifest,
        "--state",
        state,
        "--results",
        result,
      ],
      {
        timeout: 30_000,
        env: {
          HOME: root,
          PATH: process.env.PATH,
          CI: "1",
          OPENCLAW_ENTERPRISE_CI_STATE: state,
          OCC_TEST_CODEX_SECCOMP_PROFILE: profile,
          OCC_TEST_RUNTIME_IMAGE: `sha256:${"a".repeat(64)}`,
          OCC_TEST_PRODUCTION_IMAGE: `sha256:${"c".repeat(64)}`,
          OCC_TEST_WORKSPACE_ENVOY_IMAGE:
            original.prepare.defaultEnv.OCC_TEST_WORKSPACE_ENVOY_IMAGE,
          OCC_TEST_STAGING_CODEX_VERSION: version,
          OCC_TEST_STAGING_UNDECLARED: "outer-only",
        },
      },
    );
    const proof = JSON.parse(await readFile(result, "utf8"));
    assert.deepEqual(
      proof.files.map((file: { path: string; tests: { name: string; status: string }[] }) => ({
        path: file.path,
        tests: file.tests.map(({ name, status }) => ({ name, status })),
      })),
      [{ path: runtimeFile, tests: [{ name: runtimeChildCase, status: "passed" }] }],
    );
  }
}
