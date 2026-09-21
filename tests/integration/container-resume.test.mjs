import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { publishWorkflow, repository } from "../../scripts/ci/container-release.mjs";

test("recovery preserves producer bytes and identity across a partial publication", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "container-resume-test-"));
  const original = { PATH: process.env.PATH, GH_TOKEN: process.env.GH_TOKEN };
  t.after(async () => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await rm(directory, { recursive: true, force: true });
  });
  process.env.GH_TOKEN = "test-token";
  process.env.PATH = `${directory}:${process.env.PATH}`;
  const sourceSha = "a".repeat(40);
  const workflowSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const statePath = join(directory, "registry.json");
  const env = {
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
    NODE_BASE_IMAGE: `docker.io/library/node:24-bookworm@sha256:${"b".repeat(64)}`,
    GHCR_CONTROLLER_IMAGE: "ghcr.io/openclaw/enterprise-controller",
    GHCR_RUNTIME_IMAGE: "ghcr.io/openclaw/enterprise-runtime",
    GH_TOKEN: "test-token",
  };
  const tag = `sha-${sourceSha}`;
  const repo = { full_name: repository, private: true, default_branch: "main" };
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const images = ["controller", "runtime"];
  const prepared = [];
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
      platform: "linux/amd64",
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
  await writeFile(
    join(directory, "skopeo"),
    `#!${process.execPath}
import { readFileSync, writeFileSync } from "node:fs";
const statePath = ${JSON.stringify(statePath)};
const state = JSON.parse(readFileSync(statePath, "utf8"));
const args = process.argv.slice(2);
if (args[0] === "inspect") {
  const ref = args.at(-1);
  if (!ref.startsWith("oci-archive:") && (state.remoteError || !state.remote[ref])) {
    process.stderr.write(state.remoteError ?? ('reading manifest ${tag} in ' + ref.slice(9).split(':')[0] + ': manifest unknown'));
    process.exit(1);
  }
  process.stdout.write(ref.startsWith("oci-archive:") ? readFileSync(ref.slice(12)) : (state.inspectOverride ?? state.remote[ref]));
} else if (args[0] === "copy") {
  state.copies.push(args.at(-1));
  state.remote[args.at(-1)] = readFileSync(args.at(-2).slice(12), "utf8");
  writeFileSync(statePath, JSON.stringify(state));
} else if (args[0] !== "login") {
  throw new Error("Unexpected transport command");
}
`,
    { mode: 0o755 },
  );
  const initialState = { remote: { [prepared[0].remote]: prepared[0].bytes }, copies: [] };
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
  const jobs = ["validate", ...images.map((image) => `Prepare ${image} OCI image`)].map((name) => ({
    name,
    head_sha: sourceSha,
    status: "completed",
    conclusion: "success",
  }));
  const artifacts = images.map((image, index) => ({
    id: index + 10,
    name: `container-${image}-123-1`,
    expired: false,
    workflow_run: { id: 123, head_sha: sourceSha },
    digest: `sha256:${"c".repeat(64)}`,
  }));
  let approvalRun = "999";
  let packageVisibility = "private";
  let interruptRuntime = false;
  let sourceCiConclusion = "success";
  let metadataMissing = false;
  const fetchFixture = async (url) => {
    const path = new URL(url).pathname;
    if (path === `/repos/${repository}`) {
      return Response.json(repo);
    }
    if (path.includes("/compare/")) {
      return Response.json({ status: "ahead" });
    }
    if (path.endsWith("/workflows/ci.yml")) {
      return Response.json({ id: 1, path: ".github/workflows/ci.yml", state: "active" });
    }
    if (path.endsWith("/workflows/container-publish.yml")) {
      return Response.json({ id: 2, path: publishWorkflow, state: "active" });
    }
    if (path.endsWith("/runs/123")) {
      return Response.json(run);
    }
    if (path.endsWith("/runs/123/attempts/1/jobs")) {
      return Response.json({ jobs });
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
          ...run,
          id: Number(id),
          workflow_id: 1,
          path: ".github/workflows/ci.yml",
          event: "push",
          head_sha: sha,
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
        protection_rules: [
          { type: "required_reviewers", prevent_self_review: true, reviewers: [{ type: "Team" }] },
        ],
        deployment_branch_policy: { custom_branch_policies: true, protected_branches: false },
      });
    }
    if (path.endsWith("/deployment-branch-policies")) {
      return Response.json({ branch_policies: [{ name: "main", type: "branch" }] });
    }
    if (path.endsWith("/approvals")) {
      return Response.json([
        {
          state: "approved",
          user: { type: "User", login: "reviewer" },
          environments: [{ id: 42, name: "container-publish" }],
          comment: images
            .map(
              (image) =>
                `Verified GHCR linkage: ${env[`GHCR_${image.toUpperCase()}_IMAGE`]} -> ${repository}; source=${sourceSha}; run=${approvalRun}; attempt=1`,
            )
            .join("\n"),
        },
      ]);
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
        const state = JSON.parse(await readFile(statePath, "utf8"));
        const bytes = state.remote[prepared[index].remote];
        return Response.json(
          bytes && !metadataMissing
            ? [{ name: `sha256:${hash(bytes)}`, metadata: { container: { tags: [tag] } } }]
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
const { env, sourceSha, workflowSha, repository, publishWorkflow, repo, run, jobs, artifacts, images, prepared, statePath, approvalRun, packageVisibility, interruptRuntime, sourceCiConclusion, metadataMissing, tag } = JSON.parse(await readFile(${JSON.stringify(fixtureConfig)}, "utf8"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
globalThis.fetch = ${fetchFixture.toString()};
globalThis.setTimeout = (resolve) => queueMicrotask(resolve);
`,
  );
  const runRecovery = async () => {
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
        artifacts,
        images,
        prepared,
        statePath,
        approvalRun,
        packageVisibility,
        interruptRuntime,
        sourceCiConclusion,
        metadataMissing,
        tag,
      }),
    );
    execFileSync(
      process.execPath,
      ["--import", preload, "scripts/ci/container-resume.mjs", "publish", directory],
      { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] },
    );
    return JSON.parse(await readFile(join(directory, "publication.json"), "utf8"));
  };
  // Transport failures leave the original controller and receipt absent.
  interruptRuntime = true;
  await assert.rejects(runRecovery(), /GET.*runtime transport failed/);
  await assert.rejects(readFile(join(directory, "publication.json")), { code: "ENOENT" });
  assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), initialState);
  interruptRuntime = false;
  for (const [change, restore] of [
    [
      () => {
        run.run_attempt = 2;
      },
      () => {
        run.run_attempt = 1;
      },
    ],
    [
      () => {
        run.workflow_id = 9;
      },
      () => {
        run.workflow_id = 2;
      },
    ],
    [
      () => {
        jobs[2].conclusion = "skipped";
      },
      () => {
        jobs[2].conclusion = "success";
      },
    ],
    [
      () => {
        artifacts[1].expired = true;
      },
      () => {
        artifacts[1].expired = false;
      },
    ],
    [
      () => {
        artifacts[1].id = 12;
      },
      () => {
        artifacts[1].id = 11;
      },
    ],
    [
      () => {
        approvalRun = "123";
      },
      () => {
        approvalRun = "999";
      },
    ],
    [
      () => {
        packageVisibility = "public";
      },
      () => {
        packageVisibility = "private";
      },
    ],
    [
      () => {
        sourceCiConclusion = "failure";
      },
      () => {
        sourceCiConclusion = "success";
      },
    ],
  ]) {
    change();
    await assert.rejects(runRecovery());
    restore();
    assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), initialState);
  }
  const runtimeMetadata = join(prepared[1].path, "metadata.json");
  await writeFile(runtimeMetadata, JSON.stringify({ ...prepared[1].metadata, attempt: "2" }));
  await assert.rejects(runRecovery(), /attempt/);
  await writeFile(runtimeMetadata, JSON.stringify(prepared[1].metadata));
  await writeFile(join(prepared[1].path, "image.tar"), "changed");
  await assert.rejects(runRecovery(), /OCI archive bytes changed/);
  await writeFile(join(prepared[1].path, "image.tar"), prepared[1].bytes);
  await writeFile(
    statePath,
    JSON.stringify({ ...initialState, remote: { [prepared[0].remote]: "conflicting bytes" } }),
  );
  await assert.rejects(runRecovery(), /overwrite/);
  await writeFile(statePath, JSON.stringify(initialState));
  await writeFile(statePath, JSON.stringify({ ...initialState, inspectOverride: "remote drift" }));
  await assert.rejects(runRecovery(), /Remote source tag has different image bytes/);
  assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")).copies, []);
  await assert.rejects(readFile(join(directory, "publication.json")), { code: "ENOENT" });
  await writeFile(statePath, JSON.stringify(initialState));
  // Package metadata may lag; the authenticated remote manifest is authoritative.
  metadataMissing = true;
  await writeFile(
    statePath,
    JSON.stringify({ ...initialState, remote: { [prepared[0].remote]: "conflicting bytes" } }),
  );
  await assert.rejects(runRecovery());
  assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")).copies, []);
  for (const remoteError of [
    "unauthorized: authentication required",
    "connection reset",
    "reading manifest other in unrelated: manifest unknown",
  ]) {
    await writeFile(statePath, JSON.stringify({ ...initialState, remoteError }));
    await assert.rejects(runRecovery());
    assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")).copies, []);
  }
  await writeFile(statePath, JSON.stringify(initialState));
  const receipt = await runRecovery();
  assert.deepEqual(
    receipt.images.map(({ digest }) => digest),
    prepared.map(({ metadata }) => metadata.digest),
  );
  assert.deepEqual(
    receipt.images.map(({ runId, attempt }) => [runId, attempt]),
    [
      ["123", "1"],
      ["123", "1"],
    ],
  );
  assert.equal(receipt.publication.runId, "999");
  assert.equal(receipt.publication.workflowSha, workflowSha);
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.deepEqual(state.copies, [prepared[1].remote]);
  assert.equal(state.remote[prepared[0].remote], prepared[0].bytes);
  assert.equal(state.remote[prepared[1].remote], prepared[1].bytes);
  assert.deepEqual(
    JSON.parse(await readFile(join(directory, "publication.json"), "utf8")),
    receipt,
  );
  // Retrying recovery verifies both existing digests without another copy.
  await runRecovery();
  assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), state);
});
