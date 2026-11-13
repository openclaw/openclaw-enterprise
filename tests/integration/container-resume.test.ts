import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  publishPrepared,
  publishWorkflow,
  repository,
} from "../../scripts/ci/container-release.mjs";
import { setEnvironment } from "../helpers/environment.ts";
import { prependPath, writeCommand } from "../helpers/fake-commands.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

function field<K extends PropertyKey>(value: unknown, key: K): unknown {
  return (value as Record<K, unknown>)[key];
}

function item<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) {
    throw new Error(`Missing fixture item ${index}.`);
  }
  return value;
}

function array(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function object(value: unknown): Record<string, unknown> {
  assert.ok(isObject(value));
  return value;
}

function string(value: unknown): string {
  assert.ok(typeof value === "string");
  return value;
}

function parse(value: string): unknown {
  const parsed: unknown = JSON.parse(value);
  return parsed;
}

type Job = { name: string; head_sha: string; status: string; conclusion: string };

function isJob(value: unknown): value is Job {
  return (
    isObject(value) &&
    typeof value.name === "string" &&
    typeof value.head_sha === "string" &&
    typeof value.status === "string" &&
    typeof value.conclusion === "string"
  );
}

function job(value: unknown): Job {
  assert.ok(isJob(value));
  return value;
}

type Artifact = {
  id: number;
  name: string;
  expired: boolean;
  workflow_run: { id: number; head_sha: string };
  digest: string;
};

function isArtifact(value: unknown): value is Artifact {
  return (
    isObject(value) &&
    typeof value.id === "number" &&
    typeof value.name === "string" &&
    typeof value.expired === "boolean" &&
    isObject(value.workflow_run) &&
    typeof value.workflow_run.id === "number" &&
    typeof value.workflow_run.head_sha === "string" &&
    typeof value.digest === "string"
  );
}

function artifact(value: unknown): Artifact {
  assert.ok(isArtifact(value));
  return value;
}

test("publication aliases and recovery preserve producer bytes and identity", async (t) => {
  const directory: string = await temporaryDirectory(t, "container-resume-test-");
  setEnvironment(t, { GH_TOKEN: "test-token" });
  prependPath(t, directory);
  const workflowSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  let sourceSha = "a".repeat(40);
  const statePath = join(directory, "registry.json");
  const env: Record<string, string> = {
    GITHUB_REPOSITORY: repository,
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/container-resume.yml@refs/heads/main`,
    GITHUB_WORKFLOW_SHA: workflowSha,
    GITHUB_SHA: workflowSha,
    GITHUB_RUN_ID: "999",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_ACTOR: "publisher",
    GITHUB_TRIGGERING_ACTOR: "publisher",
    GITHUB_STEP_SUMMARY: join(directory, "summary.md"),
    SOURCE_SHA: sourceSha,
    PREPARATION_RUN_ID: "123",
    PREPARATION_ATTEMPT: "1",
    PREPARATION_ARTIFACT_IDS: "10,11",
    WORKFLOW_CI_RUN_ID: "789",
    WORKFLOW_CI_ATTEMPT: "1",
    NODE_BASE_IMAGE: string(
      field(
        field(
          field(
            parse(await readFile("scripts/ci/test-suites/images-packaging.json", "utf8")),
            "prepare",
          ),
          "defaultEnv",
        ),
        "NODE_BASE_IMAGE",
      ),
    ),
    GHCR_CONTROLLER_IMAGE: "ghcr.io/openclaw/enterprise-controller",
    GHCR_RUNTIME_IMAGE: "ghcr.io/openclaw/enterprise-runtime",
    GH_TOKEN: "test-token",
  };
  let tag = `sha-${sourceSha}`;
  const repo: { full_name: string; private?: boolean; default_branch?: string } = {
    full_name: repository,
    private: false,
    default_branch: "main",
  };
  const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
  const images = ["controller", "runtime"];
  const prepared: {
    path: string;
    metadata: {
      sourceSha: string;
      workflowSha: string;
      runId: string;
      attempt: string;
      ciRunId: string;
      ciAttempt: string;
      nodeBaseImage: string | undefined;
      image: string;
      platforms: string[];
      digest: string;
      archiveSha256: string;
    };
    bytes: string;
    remote: string;
  }[] = [];
  for (const image of images) {
    const bytes = JSON.stringify({ config: { image } });
    const metadata = {
      sourceSha,
      workflowSha: sourceSha,
      runId: "123",
      attempt: "1",
      ciRunId: "456",
      ciAttempt: "1",
      nodeBaseImage: env.NODE_BASE_IMAGE,
      image,
      platforms: ["linux/amd64", "linux/arm64"],
      digest: `sha256:${hash(bytes)}`,
      archiveSha256: hash(bytes),
    };
    const path = join(directory, `container-${image}-123-1`);
    await mkdir(path);
    await writeFile(join(path, "image.tar"), bytes);
    await writeFile(join(path, "metadata.json"), JSON.stringify(metadata));
    prepared.push({
      path,
      metadata,
      bytes,
      remote: `docker://${env[`GHCR_${image.toUpperCase()}_IMAGE`]}:${tag}`,
    });
  }
  // The fixture replaces only the external transport executable and HTTP API.
  // Production recovery, seal/hash checks, gate ordering, receipt and remote
  // digest comparisons run unchanged. This is not a real registry proof.
  await writeCommand(
    directory,
    "skopeo",
    `import { readFileSync, writeFileSync } from "node:fs";
const statePath = ${JSON.stringify(statePath)};
const state = JSON.parse(readFileSync(statePath, "utf8"));
const args = process.argv.slice(2);
if (args[0] === "inspect") {
  const ref = args.at(-1);
  if (!ref.startsWith("oci-archive:") && (state.remoteError || !state.remote[ref])) {
    process.stderr.write(state.remoteError ?? ('reading manifest ' + ref.split(':').at(-1) + ' in ' + ref.slice(9).split(':')[0] + ': manifest unknown'));
    process.exit(state.remoteStatus ?? 1);
  }
  process.stdout.write(ref.startsWith("oci-archive:") ? readFileSync(ref.slice(12)) : (state.inspectOverride ?? state.remote[ref]));
} else if (args[0] === "copy") {
  if (state.failCopyRef === args.at(-1)) {
    process.stderr.write("simulated registry copy failure");
    process.exit(1);
  }
  state.copies.push(args.at(-1));
  state.remote[args.at(-1)] = readFileSync(args.at(-2).slice(12), "utf8");
  writeFileSync(statePath, JSON.stringify(state));
} else if (args[0] !== "login") {
  throw new Error("Unexpected transport command");
}
`,
    { interpreter: process.execPath },
  );
  const initialState = {
    remote: { [item(prepared, 0).remote]: item(prepared, 0).bytes },
    copies: [],
  };
  await writeFile(statePath, JSON.stringify(initialState));
  const run = {
    id: 123,
    run_attempt: 1,
    workflow_id: 2,
    path: publishWorkflow,
    repository: repo,
    head_repository: repo,
    head_branch: "main",
    head_sha: sourceSha,
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "failure",
  };
  const jobs = [
    "validate",
    "prepare / Prepare controller (amd64)",
    "prepare / Prepare controller (arm64)",
    "prepare / Prepare runtime (amd64)",
    "prepare / Prepare runtime (arm64)",
    "Assemble controller OCI image",
    "Assemble runtime OCI image",
    "prepare / Smoke runtime (amd64)",
    "prepare / Smoke runtime (arm64)",
  ].map((name) => ({
    name,
    head_sha: sourceSha,
    status: "completed",
    conclusion: "success",
  }));
  const legacyJobs = ["Prepare controller OCI image", "Prepare runtime OCI image"].map((name) => ({
    ...item(jobs, 0),
    name,
  }));
  const artifacts = images.map((image, index) => ({
    id: index + 10,
    name: `container-${image}-123-1`,
    expired: false,
    workflow_run: { id: 123, head_sha: sourceSha },
    digest: `sha256:${"c".repeat(64)}`,
  }));
  const publishWorkflowRecord = { id: 2, path: publishWorkflow, state: "active" };
  // The jobs of a rerun's second attempt; the first attempt keeps `jobs`.
  let retryJobs: Job[] = [];
  let workflowComparison: string | undefined;
  let packageVisibility = "public";
  let interruptRuntime = false;
  let sourceCiConclusion = "success";
  let metadataMissing = false;
  const fetchFixture = async (url: string) => {
    const path = new URL(url).pathname;
    if (path === `/repos/${repository}`) {
      return Response.json(repo);
    }
    if (path.includes("/compare/")) {
      if (workflowComparison && path.endsWith(`...${workflowSha}`)) {
        return Response.json({ status: workflowComparison });
      }
      return Response.json({
        status:
          path.endsWith(`${sourceSha}...${workflowSha}`) && sourceSha === workflowSha
            ? "identical"
            : "ahead",
      });
    }
    if (path.endsWith("/workflows/ci.yml")) {
      return Response.json({ id: 1, path: ".github/workflows/ci.yml", state: "active" });
    }
    if (path.endsWith("/workflows/container-publish.yml")) {
      return Response.json(publishWorkflowRecord);
    }
    if (path.endsWith("/runs/123")) {
      return Response.json(run);
    }
    if (path.endsWith("/runs/123/attempts/1/jobs")) {
      return Response.json({ jobs });
    }
    if (path.endsWith("/runs/123/attempts/2/jobs")) {
      return Response.json({ jobs: retryJobs });
    }
    if (path.endsWith("/runs/123/artifacts")) {
      return Response.json({ artifacts });
    }
    for (const [id, sha] of [
      ["456", sourceSha],
      ["789", workflowSha],
    ]) {
      if (path.endsWith(`/runs/${id}`)) {
        return Response.json({
          id: Number(id),
          run_attempt: 1,
          workflow_id: 1,
          path: ".github/workflows/ci.yml",
          repository: repo,
          head_repository: repo,
          head_branch: "main",
          head_sha: sha,
          event: "push",
          status: "completed",
          conclusion: id === "456" ? sourceCiConclusion : "success",
        });
      }
      if (path.endsWith(`/runs/${id}/attempts/1/jobs`)) {
        return Response.json({
          jobs: [
            { name: "CI Required", head_sha: sha, status: "completed", conclusion: "success" },
          ],
        });
      }
    }
    if (path.endsWith("/environments/container-publish")) {
      return Response.json({
        id: 42,
        name: "container-publish",
        can_admins_bypass: false,
        protection_rules: [],
        deployment_branch_policy: { custom_branch_policies: true, protected_branches: false },
      });
    }
    if (path.endsWith("/deployment-branch-policies")) {
      return Response.json({ branch_policies: [{ name: "main", type: "branch" }] });
    }
    for (const [index, image] of images.entries()) {
      const packagePath = `/orgs/openclaw/packages/container/enterprise-${image}`;
      if (path === packagePath) {
        if (image === "runtime" && interruptRuntime) {
          throw new TypeError("fetch failed");
        }
        return Response.json({
          name: `enterprise-${image}`,
          package_type: "container",
          visibility: packageVisibility,
        });
      }
      if (path === `${packagePath}/versions`) {
        const state: unknown = JSON.parse(await readFile(statePath, "utf8"));
        const bytes = field(field(state, "remote"), item(prepared, index).remote);
        return Response.json(
          bytes && !metadataMissing
            ? [
                {
                  name: `sha256:${hash(bytes as string)}`,
                  metadata: { container: { tags: [tag] } },
                },
              ]
            : [],
        );
      }
    }
    throw new Error(`Unexpected request ${path}`);
  };
  const fixtureConfig = join(directory, "fixture.json");
  const preload = join(directory, "http-fixture.mjs");
  await writeFile(
    preload,
    `
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const { env, sourceSha, workflowSha, repository, publishWorkflow, repo, run, jobs, retryJobs, artifacts, images, prepared, statePath, publishWorkflowRecord, workflowComparison, packageVisibility, interruptRuntime, sourceCiConclusion, metadataMissing, tag } = JSON.parse(await readFile(${JSON.stringify(fixtureConfig)}, "utf8"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const field = ${field.toString()};
const item = ${item.toString()};
globalThis.fetch = ${fetchFixture.toString()};
globalThis.setTimeout = (resolve) => queueMicrotask(resolve);
`,
  );
  const writeFixture = async () => {
    await writeFile(
      fixtureConfig,
      JSON.stringify({
        env,
        sourceSha,
        workflowSha,
        repository,
        publishWorkflow,
        repo,
        run,
        jobs,
        retryJobs,
        artifacts,
        images,
        prepared,
        statePath,
        publishWorkflowRecord,
        workflowComparison,
        packageVisibility,
        interruptRuntime,
        sourceCiConclusion,
        metadataMissing,
        tag,
      }),
    );
  };
  const runRecovery = async () => {
    await writeFixture();
    execFileSync(
      process.execPath,
      ["--import", preload, "scripts/ci/container-resume.ts", "publish", directory],
      { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] },
    );
    return parse(await readFile(join(directory, "publication.json"), "utf8"));
  };
  // Transport failures leave the original controller and receipt absent.
  interruptRuntime = true;
  await assert.rejects(runRecovery(), /GET.*runtime transport failed/);
  await assert.rejects(readFile(join(directory, "publication.json")), { code: "ENOENT" });
  assert.deepEqual(parse(await readFile(statePath, "utf8")), initialState);
  interruptRuntime = false;
  // Each refusal names the guard that must refuse it: the child prints only the
  // error message, and each case plants a value that only one guard reports (in
  // a message of that guard's form), except the controller ciRunId case below,
  // which verifyCi's identical run id check also refuses. The CI runs above do
  // not inherit the producer run, so only the producer's own guards see its fields.
  const refusedBy = (pattern: RegExp) => (error: unknown) =>
    pattern.test(String(field(error, "stderr")));
  const mismatch = (value: string) =>
    new RegExp(`^Expected values to be strictly equal:[\\s\\S]*${value}`);
  const unmatched = (value: string) =>
    new RegExp(`^The input did not match the regular expression [^\\n]*\\. Input:\\s+${value}`);
  const pristine = JSON.stringify({ run, jobs, artifacts, env, publishWorkflowRecord });
  const writeController = (patch: Record<string, unknown>) =>
    writeFile(
      join(item(prepared, 0).path, "metadata.json"),
      JSON.stringify({ ...item(prepared, 0).metadata, ...patch }),
    );
  const other = (name: string) => `.github/workflows/${name}.yml`;
  for (const [change, guard] of [
    [() => (env.PREPARATION_RUN_ID = "run-x"), unmatched("'run-x'")],
    [() => (env.PREPARATION_ATTEMPT = "attempt-x"), unmatched("'attempt-x'")],
    [
      () => (workflowComparison = "behind"),
      /^The expression evaluated to a falsy value:[\s\S]*comparison\.status === "ahead"/,
    ],
    [
      () => (publishWorkflowRecord.path = other("workflow-other")),
      mismatch("workflow-other\\.yml"),
    ],
    [() => (publishWorkflowRecord.state = "disabled_manually"), mismatch("'disabled_manually'")],
    [() => (run.workflow_id = 9), mismatch("\\b9\\b")],
    [() => (run.path = other("run-other")), mismatch("run-other\\.yml")],
    [() => (run.id = 124), mismatch("'124'")],
    [() => (run.run_attempt = 2), /^Select the unchanged producer attempt\./],
    [() => (run.repository = { full_name: "other/enterprise" }), mismatch("'other/enterprise'")],
    [() => (run.head_repository = { full_name: "fork/enterprise" }), mismatch("'fork/enterprise'")],
    [() => (run.head_sha = "e".repeat(40)), mismatch("'e{40}'")],
    [() => (run.head_branch = "feature"), mismatch("'feature'")],
    [() => (run.event = "pull_request"), mismatch("'pull_request'")],
    [() => (run.status = "in_progress"), mismatch("'in_progress'")],
    [
      () => (run.conclusion = "skipped"),
      /^The expression evaluated to a falsy value:[\s\S]*includes\(run\.conclusion\)/,
    ],
    [
      () => jobs.push({ ...item(jobs, 1) }),
      /^Exactly one successful prepare \/ Prepare controller \(amd64\) job/,
    ],
    [() => jobs.splice(6, 1), /^Exactly one successful Assemble runtime OCI image job/],
    [
      () => jobs.splice(1, 1),
      /^Exactly one successful prepare \/ Prepare controller \(amd64\) job/,
    ],
    [
      () => jobs.splice(2, Infinity, ...legacyJobs),
      /^Preparation attempt mixes legacy and native jobs/,
    ],
    [
      () => jobs.splice(1, Infinity, item(legacyJobs, 0)),
      /^Exactly one successful Prepare runtime OCI image job/,
    ],
    [() => (item(jobs, 0).head_sha = "f".repeat(40)), mismatch("'f{40}'")],
    [() => (item(jobs, 1).status = "queued"), mismatch("'queued'")],
    [
      () => (item(jobs, 2).conclusion = "skipped"),
      /^prepare \/ Prepare controller \(arm64\) job must have succeeded/,
    ],
    [
      () => (item(jobs, 6).conclusion = "failure"),
      /^Assemble runtime OCI image job must have succeeded/,
    ],
    // Retained build/assembly metadata never excuses a missing or failed native smoke job.
    [() => jobs.pop(), /^Exactly one successful prepare \/ Smoke runtime \(arm64\) job/],
    [
      () => (item(jobs, 7).conclusion = "failure"),
      /^prepare \/ Smoke runtime \(amd64\) job must have succeeded/,
    ],
    [
      // The selected attempt's own jobs decide: attempt 1 succeeded, but rerun attempt 2's
      // runtime assembly failed.
      () => {
        env.PREPARATION_ATTEMPT = "2";
        run.run_attempt = 2;
        retryJobs = jobs.map((job) =>
          job.name === "Assemble runtime OCI image" ? { ...job, conclusion: "failure" } : job,
        );
      },
      /^Assemble runtime OCI image job must have succeeded/,
    ],
    [
      () => artifacts.push({ ...item(artifacts, 0) }),
      /^One retained artifact named container-controller/,
    ],
    [() => (item(artifacts, 1).expired = true), mismatch("\\btrue\\b")],
    [() => (item(artifacts, 1).workflow_run = { id: 125, head_sha: sourceSha }), mismatch("'125'")],
    [() => (item(artifacts, 1).workflow_run.head_sha = "1".repeat(40)), mismatch("'1{40}'")],
    [
      () => (item(artifacts, 1).id = 0),
      /^The expression evaluated to a falsy value:[\s\S]*Number\.isSafeInteger\(artifact\.id\)/,
    ],
    [() => (item(artifacts, 1).digest = "sha256:short"), unmatched("'sha256:short'")],
    [
      () => (item(artifacts, 1).id = 12),
      /^Downloaded artifacts must match the validated producer\./,
    ],
    [() => writeController({ ciRunId: "run-y" }), unmatched("'run-y'")],
    [() => writeController({ ciAttempt: "attempt-y" }), unmatched("'attempt-y'")],
    [
      () => (env.NODE_BASE_IMAGE = "docker.io/library/node:24"),
      unmatched("'docker\\.io/library/node:24'"),
    ],
    [() => (packageVisibility = "private"), /^GHCR package must already exist and be public\./],
    [() => (sourceCiConclusion = "failure"), /^The entire CI run must succeed\./],
  ] satisfies Array<[() => unknown, RegExp]>) {
    await change();
    await assert.rejects(runRecovery(), refusedBy(guard));
    const restored = parse(pristine);
    Object.assign(run, field(restored, "run"));
    jobs.splice(0, Infinity, ...array(field(restored, "jobs")).map(job));
    artifacts.splice(0, Infinity, ...array(field(restored, "artifacts")).map(artifact));
    Object.assign(env, field(restored, "env"));
    Object.assign(publishWorkflowRecord, field(restored, "publishWorkflowRecord"));
    retryJobs = [];
    workflowComparison = undefined;
    packageVisibility = "public";
    sourceCiConclusion = "success";
    await writeController({});
    assert.deepEqual(parse(await readFile(statePath, "utf8")), initialState);
  }
  const runtimeMetadata = join(item(prepared, 1).path, "metadata.json");
  await writeFile(runtimeMetadata, JSON.stringify({ ...item(prepared, 1).metadata, attempt: "2" }));
  await assert.rejects(runRecovery(), /attempt/);
  await writeFile(runtimeMetadata, JSON.stringify(item(prepared, 1).metadata));
  await writeFile(join(item(prepared, 1).path, "image.tar"), "changed");
  await assert.rejects(runRecovery(), /OCI archive bytes changed/);
  await writeFile(join(item(prepared, 1).path, "image.tar"), item(prepared, 1).bytes);
  await writeFile(
    statePath,
    JSON.stringify({
      ...initialState,
      remote: { [item(prepared, 0).remote]: "conflicting bytes" },
    }),
  );
  await assert.rejects(runRecovery(), /overwrite/);
  await writeFile(statePath, JSON.stringify(initialState));
  await writeFile(statePath, JSON.stringify({ ...initialState, inspectOverride: "remote drift" }));
  await assert.rejects(runRecovery(), /Remote source tag has different image bytes/);
  assert.deepEqual(field(parse(await readFile(statePath, "utf8")), "copies"), []);
  await assert.rejects(readFile(join(directory, "publication.json")), { code: "ENOENT" });
  await writeFile(statePath, JSON.stringify(initialState));
  // Package metadata may lag; the authenticated remote manifest is authoritative.
  metadataMissing = true;
  await writeFile(
    statePath,
    JSON.stringify({
      ...initialState,
      remote: { [item(prepared, 0).remote]: "conflicting bytes" },
    }),
  );
  await assert.rejects(runRecovery(), /Remote source tag has different image bytes/);
  assert.deepEqual(field(parse(await readFile(statePath, "utf8")), "copies"), []);
  for (const remoteError of [
    "unauthorized: authentication required",
    "connection reset",
    "reading manifest other in unrelated: manifest unknown",
  ]) {
    await writeFile(statePath, JSON.stringify({ ...initialState, remoteError }));
    // remoteTagDigest rethrows anything but this tag's manifest-unknown diagnostic.
    await assert.rejects(runRecovery(), refusedBy(new RegExp(`${remoteError}$`, "m")));
    assert.deepEqual(field(parse(await readFile(statePath, "utf8")), "copies"), []);
  }
  // A missing tag is copied only when its listing omits it and inspection exits 1
  // with exactly that diagnostic; either other signal must refuse before a copy.
  const missing = `reading manifest ${tag} in ${env.GHCR_CONTROLLER_IMAGE}: manifest unknown`;
  const absent = new RegExp(`^${missing}$`, "m");
  await writeFile(statePath, JSON.stringify({ remote: {}, copies: [], remoteStatus: 2 }));
  await assert.rejects(runRecovery(), refusedBy(absent));
  assert.deepEqual(field(parse(await readFile(statePath, "utf8")), "copies"), []);
  metadataMissing = false;
  await writeFile(statePath, JSON.stringify({ ...initialState, remoteError: missing }));
  await assert.rejects(runRecovery(), refusedBy(absent));
  assert.deepEqual(field(parse(await readFile(statePath, "utf8")), "copies"), []);
  metadataMissing = true;
  await writeFile(statePath, JSON.stringify(initialState));
  const receipt = await runRecovery();
  assert.deepEqual(
    array(field(receipt, "images")).map((image) => field(image, "digest")),
    prepared.map(({ metadata }) => metadata.digest),
  );
  assert.deepEqual(
    array(field(receipt, "images")).map((image) => [
      field(image, "runId"),
      field(image, "attempt"),
    ]),
    [
      ["123", "1"],
      ["123", "1"],
    ],
  );
  assert.equal(field(field(receipt, "publication"), "runId"), "999");
  assert.equal(field(field(receipt, "publication"), "workflowSha"), workflowSha);
  const state = parse(await readFile(statePath, "utf8"));
  assert.deepEqual(field(state, "copies"), [item(prepared, 1).remote]);
  assert.equal(field(field(state, "remote"), item(prepared, 0).remote), item(prepared, 0).bytes);
  assert.equal(field(field(state, "remote"), item(prepared, 1).remote), item(prepared, 1).bytes);
  assert.deepEqual(parse(await readFile(join(directory, "publication.json"), "utf8")), receipt);
  // Retrying recovery verifies both existing digests without another copy.
  await runRecovery();
  assert.deepEqual(parse(await readFile(statePath, "utf8")), state);
  // A cancelled producer recovers too, as does a successful preparation-only run (publish: false).
  for (const conclusion of ["cancelled", "success"]) {
    run.conclusion = conclusion;
    await runRecovery();
    assert.deepEqual(parse(await readFile(statePath, "utf8")), state);
  }
  run.conclusion = "failure";
  // Older producers sealed both architectures in one job per image.
  jobs.splice(1, Infinity, ...legacyJobs);
  await runRecovery();
  assert.deepEqual(parse(await readFile(statePath, "utf8")), state);
  // The ordinary publication command updates a mutable alias only after both
  // immutable tags exist. Recovery above must not move an older build to latest.
  const latestRefs = images.map(
    (image) => `docker://${env[`GHCR_${image.toUpperCase()}_IMAGE`]}:latest`,
  );
  const customRefs = images.map(
    (image) => `docker://${env[`GHCR_${image.toUpperCase()}_IMAGE`]}:candidate`,
  );
  sourceSha = workflowSha;
  metadataMissing = false;
  tag = `sha-${sourceSha}`;
  env.SOURCE_SHA = sourceSha;
  for (const [index, image] of images.entries()) {
    item(prepared, index).metadata.sourceSha = sourceSha;
    item(prepared, index).metadata.workflowSha = sourceSha;
    item(prepared, index).remote = `docker://${env[`GHCR_${image.toUpperCase()}_IMAGE`]}:${tag}`;
    await writeFile(
      join(item(prepared, index).path, "metadata.json"),
      JSON.stringify(item(prepared, index).metadata),
    );
  }
  // Recovery on the producer's own commit: main has not moved since, so the comparison is
  // identical rather than ahead, and both immutable tags are copied.
  run.head_sha = sourceSha;
  jobs.splice(
    0,
    Infinity,
    ...array(field(parse(pristine), "jobs")).map((value) => ({
      ...job(value),
      head_sha: sourceSha,
    })),
  );
  for (const artifact of artifacts) {
    artifact.workflow_run.head_sha = sourceSha;
  }
  await writeFile(statePath, JSON.stringify({ remote: {}, copies: [] }));
  const identical = await runRecovery();
  assert.deepEqual(
    array(field(identical, "images")).map((image) => field(image, "digest")),
    prepared.map(({ metadata }) => metadata.digest),
  );
  assert.deepEqual(
    field(parse(await readFile(statePath, "utf8")), "copies"),
    prepared.map(({ remote }) => remote),
  );
  const runPublicationCommand = async (command: "validate" | "publish", alias = "") => {
    await writeFixture();
    execFileSync(
      process.execPath,
      ["--import", preload, "scripts/ci/container-release.mjs", command, directory],
      {
        env: {
          ...process.env,
          ...env,
          GITHUB_WORKFLOW_REF: `${repository}/${publishWorkflow}@refs/heads/main`,
          GITHUB_RUN_ID: "123",
          CI_RUN_ID: "456",
          CI_ATTEMPT: "1",
          GITHUB_OUTPUT: join(directory, "publication-output"),
          PUBLISH: "true",
          IMAGE_TAG: alias,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  };
  const runPublication = async (alias = "") => {
    await runPublicationCommand("publish", alias);
    return parse(await readFile(join(directory, "publication.json"), "utf8"));
  };
  const priorState = { ...object(state), remote: { ...object(field(state, "remote")) } };
  for (const ref of latestRefs) {
    priorState.remote[ref] = "previous image";
  }
  // A conflicting immutable tag must stop publication before moving either alias.
  const conflict = {
    ...priorState,
    remote: { ...priorState.remote, [item(prepared, 1).remote]: "conflict" },
  };
  await writeFile(statePath, JSON.stringify(conflict));
  await assert.rejects(runPublication(), /overwrite/);
  assert.deepEqual(parse(await readFile(statePath, "utf8")), conflict);
  // A failure during the second source copy also leaves both aliases untouched.
  await writeFile(
    statePath,
    JSON.stringify({ ...priorState, failCopyRef: item(prepared, 1).remote }),
  );
  await assert.rejects(runPublication(), /simulated registry copy failure/);
  const sourceFailure = parse(await readFile(statePath, "utf8"));
  assert.equal(
    field(field(sourceFailure, "remote"), item(prepared, 0).remote),
    item(prepared, 0).bytes,
  );
  for (const ref of latestRefs) {
    assert.equal(field(field(sourceFailure, "remote"), ref), "previous image");
  }
  await writeFile(statePath, JSON.stringify(priorState));
  const publication = await runPublication();
  const latestState = parse(await readFile(statePath, "utf8"));
  for (const [index, ref] of latestRefs.entries()) {
    assert.equal(field(field(latestState, "remote"), ref), item(prepared, index).bytes);
    assert.equal(
      field(field(latestState, "remote"), item(prepared, index).remote),
      item(prepared, index).bytes,
    );
    assert.equal(field(item(array(publication), index), "tag"), tag);
    assert.equal(field(item(array(publication), index), "aliasTag"), "latest");
  }
  const customPublication = await runPublication("candidate");
  const customState = parse(await readFile(statePath, "utf8"));
  for (const [index, ref] of customRefs.entries()) {
    assert.equal(field(field(customState, "remote"), ref), item(prepared, index).bytes);
    assert.equal(
      field(field(customState, "remote"), item(latestRefs, index)),
      field(field(latestState, "remote"), item(latestRefs, index)),
    );
    assert.equal(field(item(array(customPublication), index), "aliasTag"), "candidate");
  }
  const reserved = /^Source and bootstrap tags are reserved\./;
  const invalidTag = /^Invalid image tag\./;
  for (const [invalid, guard] of [
    [`sha-${"f".repeat(40)}`, reserved],
    ["bootstrap-123", reserved],
    ["bad/tag", invalidTag],
    ["x".repeat(129), invalidTag],
  ] satisfies Array<[string, RegExp]>) {
    await assert.rejects(runPublication(invalid), refusedBy(guard));
    assert.deepEqual(parse(await readFile(statePath, "utf8")), customState);
  }
  // Cover release versions, leading-zero components, and the chart owner's
  // permissive prerelease forms. None may replace an existing release image.
  const releaseVersions = ["0.0.0", "1.2.3", "01.002.0003", "1.2.3-rc.1", "1.2.3-A-."];
  const versionState = {
    ...object(customState),
    remote: { ...object(field(customState, "remote")) },
  };
  for (const version of releaseVersions) {
    for (const image of images) {
      versionState.remote[`docker://${env[`GHCR_${image.toUpperCase()}_IMAGE`]}:${version}`] =
        `existing ${image} release bytes`;
    }
  }
  const versionStateBytes = JSON.stringify(versionState);
  await writeFile(statePath, versionStateBytes);
  const releaseVersion = /^Release version tags are reserved\./;
  let verifications = 0;
  const stopBeforePublication = async () => {
    verifications++;
    throw new Error("Reached publication verification.");
  };
  for (const version of releaseVersions) {
    await assert.rejects(runPublicationCommand("validate", version), refusedBy(releaseVersion));
    await assert.rejects(runPublication(version), refusedBy(releaseVersion));
    // Other callers must reach the same refusal before their first verification
    // or transport operation. The sentinel makes a missing boundary guard safe.
    await assert.rejects(
      publishPrepared(directory, env, item(prepared, 0).metadata, stopBeforePublication, version),
      { message: releaseVersion },
    );
    assert.equal(verifications, 0);
    assert.equal(await readFile(statePath, "utf8"), versionStateBytes);
  }
  // Reserve only the chart owner's grammar. Recovery still omits the alias,
  // and other valid OCI tags still pass the shared boundary.
  for (const alias of [undefined, "", "latest", "candidate", "v1.2.3", "1.2.3-"]) {
    await assert.rejects(
      publishPrepared(directory, env, item(prepared, 0).metadata, stopBeforePublication, alias),
      { message: /^Reached publication verification\.$/ },
    );
  }
  assert.equal(verifications, 6);
  assert.equal(await readFile(statePath, "utf8"), versionStateBytes);
  // The aliases are separate registry writes: a failure must not produce a receipt.
  const partial = {
    ...object(customState),
    remote: { ...object(field(customState, "remote")) },
    failCopyRef: item(latestRefs, 1),
  };
  for (const ref of latestRefs) {
    partial.remote[ref] = "previous image";
  }
  await writeFile(statePath, JSON.stringify(partial));
  await rm(join(directory, "publication.json"));
  await assert.rejects(runPublication(), /simulated registry copy failure/);
  const failedState = parse(await readFile(statePath, "utf8"));
  assert.equal(field(field(failedState, "remote"), item(latestRefs, 0)), item(prepared, 0).bytes);
  assert.equal(field(field(failedState, "remote"), item(latestRefs, 1)), "previous image");
  await assert.rejects(readFile(join(directory, "publication.json")), { code: "ENOENT" });
});
