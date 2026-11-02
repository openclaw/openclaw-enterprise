import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);
const source = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;
const repository = "openclaw/openclaw-enterprise";

test("staging workflow command consumes bound digests and refuses invalid release evidence", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "staging-command-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = {
    ...process.env,
    RUNNER_TEMP: directory,
    GH_TOKEN: "fixture",
    SOURCE_SHA: source,
    GITHUB_SHA: source,
    GITHUB_WORKFLOW_SHA: source,
    GITHUB_REPOSITORY: repository,
    GITHUB_REF: "refs/heads/main",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/staging-qualification.yml@refs/heads/main`,
    PUBLICATION_RUN_ID: "123",
    PUBLICATION_ATTEMPT: "2",
    ARTIFACT_ID: "789",
    STAGING_INSTALLATION: "test-staging",
    CONFIGURED_STAGING_INSTALLATION: "test-staging",
    NODE_BASE_IMAGE: `docker.io/library/node:24-bookworm@${digest}`,
    GHCR_CONTROLLER_IMAGE: "ghcr.io/openclaw/controller",
    GHCR_RUNTIME_IMAGE: "ghcr.io/openclaw/runtime",
    GITHUB_OUTPUT: join(directory, "output"),
  };
  const receipt = ["controller", "runtime"].map((image) => ({
    image,
    sourceSha: source,
    workflowSha: source,
    runId: "123",
    attempt: "2",
    ciRunId: "456",
    ciAttempt: "1",
    nodeBaseImage: env.NODE_BASE_IMAGE,
    platforms: ["linux/amd64", "linux/arm64"],
    digest,
    archiveSha256: "c".repeat(64),
    destination: `ghcr.io/openclaw/${image}`,
    tag: `sha-${source}`,
  }));
  await mkdir(join(directory, "publication"));
  const path = join(directory, "publication/publication.json");
  await writeFile(path, JSON.stringify(receipt));
  // Replace only network, container transport and the expensive smoke boundary.
  // The real workflow CLI performs all admission, binding and command selection.
  const preload = join(directory, "transport.ts");
  await writeFile(
    preload,
    `
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import child from 'node:child_process';
import { appendFileSync } from 'node:fs';
const env = process.env;
const source = env.SOURCE_SHA;
const repo = '${repository}';
const publication = '.github/workflows/container-publish.yml';
globalThis.fetch = async (url) => {
  const path = new URL(url).pathname;
  let body;
  const run = (id, workflow, event, attempt) => ({id, run_attempt: attempt, workflow_id: id,
    path: workflow, repository: {full_name: repo}, head_repository: {full_name: repo},
    head_branch: 'main', head_sha: source, event, status: 'completed', conclusion: 'success'});
  if (path === '/repos/' + repo) body = {full_name: repo, private: false, default_branch: 'main'};
  else if (path.includes('/compare/')) body = {status: 'identical'};
  else if (path.endsWith('/workflows/container-publish.yml')) body = {id: 123, path: publication, state: 'active'};
  else if (path.endsWith('/workflows/ci.yml')) body = {id: 456, path: '.github/workflows/ci.yml', state: 'active'};
  else if (path.endsWith('/runs/123')) body = run(123, publication, 'workflow_dispatch', env.BAD_ATTEMPT ? 3 : 2);
  else if (path.endsWith('/runs/456')) body = run(456, '.github/workflows/ci.yml', 'push', 1);
  else if (path.endsWith('/artifacts')) body = {artifacts: [{id: 789, name: 'container-publication-123-2',
    expired: !!env.EXPIRED, workflow_run: {id: 123, head_sha: source}}]};
  else if (path.endsWith('/jobs')) body = {jobs: [{name: 'CI Required', status: 'completed', conclusion: 'success', head_sha: source}]};
  else throw new Error('Unexpected network request: ' + url);
  return new Response(JSON.stringify(body), {status: 200});
};
registerHooks({resolve(specifier, context, next) {
  if (specifier.endsWith('/prepare.mjs')) return {url: 'data:text/javascript,' + encodeURIComponent(
    'export async function prepareRuntimeImageSmoke({image}) { if (!image.startsWith("sha256:")) throw Error("not immutable"); return {env: {}, cleanup: async () => {}}; }'), shortCircuit: true};
  return next(specifier, context);
}});
child.execFileSync = (command, args, options) => {
  appendFileSync(env.RUNNER_TEMP + '/calls.jsonl', JSON.stringify({command, args,
    controller: options?.env?.OCC_TEST_PRODUCTION_IMAGE, runtime: options?.env?.OCC_TEST_RUNTIME_IMAGE}) + '\\n');
  if (command === 'docker' && args[0] === 'pull') return '';
  if (command === 'docker' && args[0] === 'image') return JSON.stringify([{
    RepoDigests: [env.BAD_DIGEST ? 'wrong' : args[2]], Id: 'sha256:' + (args[2].includes('controller') ? 'c' : 'd').repeat(64),
    Os: 'linux', Architecture: 'amd64', Config: {Labels: {'org.opencontainers.image.revision': source}}
  }]);
  if (command === process.execPath && args[0] === 'scripts/ci/run-tests.mjs' && ['images-packaging', 'images-runtime-startup'].includes(args[2])) {
    if (env.FAIL_SMOKE) throw Error('smoke failed');
    return '';
  }
  throw Error('Unexpected subprocess: ' + command + ' ' + args.join(' '));
};
syncBuiltinESMExports();
`,
  );
  const workflow = await readFile(".github/workflows/staging-qualification.yml", "utf8");
  const commands = [
    ...workflow.matchAll(
      /^ {8}run: (node scripts\/ci\/staging-qualification\.ts (validate|qualify).*?)$/gm,
    ),
  ];
  assert.equal(commands.length, 2);
  const run = (command: string, patch: Record<string, string> = {}) => {
    const selected = commands.find((match) => match[2] === command)?.[1];
    assert.ok(selected);
    return execute("bash", ["-e", "-c", selected], {
      env: { ...env, NODE_OPTIONS: `--import=${preload}`, ...patch },
    });
  };
  await run("validate");
  assert.equal(await readFile(env.GITHUB_OUTPUT, "utf8"), "artifact_id=789\n");
  await run("qualify");
  const proof = JSON.parse(await readFile(join(directory, "staging-qualification.json"), "utf8"));
  assert.equal(proof.liveInstall, false);
  assert.equal(proof.selected.runtime, `${env.GHCR_RUNTIME_IMAGE}@${digest}`);
  const calls = (await readFile(join(directory, "calls.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    calls.filter((call) => call.args[0] === "pull").map((call) => call.args),
    [
      ["pull", "--platform", "linux/amd64", `${env.GHCR_CONTROLLER_IMAGE}@${digest}`],
      ["pull", "--platform", "linux/amd64", `${env.GHCR_RUNTIME_IMAGE}@${digest}`],
    ],
  );
  assert.equal(calls.at(-1).controller, `sha256:${"c".repeat(64)}`);
  assert.equal(calls.at(-1).runtime, `sha256:${"d".repeat(64)}`);
  for (const patch of [
    { CONFIGURED_STAGING_INSTALLATION: "" },
    { CONFIGURED_STAGING_INSTALLATION: "other" },
    { BAD_ATTEMPT: "1" },
    { EXPIRED: "1" },
    { ARTIFACT_ID: "999" },
    { GHCR_RUNTIME_IMAGE: "" },
    { GHCR_RUNTIME_IMAGE: "ghcr.io/openclaw/other" },
    { BAD_DIGEST: "1" },
    { FAIL_SMOKE: "1" },
  ]) {
    await rm(join(directory, "staging-qualification.json"), { force: true });
    const before = await readFile(join(directory, "calls.jsonl"), "utf8");
    await assert.rejects(run("qualify", patch), { code: 1 });
    if (!("BAD_DIGEST" in patch) && !("FAIL_SMOKE" in patch)) {
      assert.equal(
        await readFile(join(directory, "calls.jsonl"), "utf8"),
        before,
        "Invalid release evidence must stop before any container command.",
      );
    }
    await assert.rejects(readFile(join(directory, "staging-qualification.json")), {
      code: "ENOENT",
    });
  }
  await writeFile(path, JSON.stringify([receipt[0], { ...receipt[1], sourceSha: "e".repeat(40) }]));
  await assert.rejects(run("qualify"), /Prepared image sourceSha does not match/);
});
