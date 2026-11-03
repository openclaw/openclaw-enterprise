import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const lane = "skipper-prepared-git-installed";
const sourceSha = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
const counts = { passed: 1, failed: 0, skipped: 0, todo: 0, total: 1 };
const selection = {
  sourceSha,
  images: {
    controller: "sha256:" + "1".repeat(64),
    runtime: "sha256:" + "2".repeat(64),
    repository: "sha256:" + "3".repeat(64),
  },
};
function receipt() {
  // Built manifests independently match the control. Imported manifests and config IDs differ.
  const image = (digit: string) => ({
    built: "sha256:" + digit.repeat(64),
    installed: "sha256:" + "4".repeat(64),
    config: "sha256:" + "5".repeat(64),
  });
  return {
    version: 1,
    command: "run",
    lane,
    sourceSha,
    status: "passed",
    exitCode: 0,
    counts,
    imageScope: "checkout-images-with-synthetic-model-trust-layer",
    imageDigests: { controller: image("1"), runtime: image("2"), repository: image("3") },
    files: [
      {
        path: "tests/integration/skipper-prepared-git-installed.test.mjs",
        status: "passed",
        counts,
        cleanup: { status: "passed" },
        tests: [
          {
            name: "same Compute-owned Skipper chats, authors private Git, loses Git during an authenticated fetch, and still chats",
            status: "passed",
            durationMs: 1,
          },
        ],
      },
    ],
    proof: [
      "deployed-revision-gateway-and-harness-ready",
      "chat-before-private-git-verified",
      "prepared-before-native-git",
      "native-commit-confirmed-by-independent-fetch",
      "wrong-repository-hook-refusal-and-broker-denied-mixed-push",
      "native-authenticated-post-after-withdrawal-refused",
      "fresh-authenticated-fetch-after-effective-withdrawal-refused",
      "same-compute-owned-skipper-chat-after-git-withdrawal-verified",
      "same-compute-owned-skipper-chat-git-and-live-withdrawal-observed",
      "owned-agent-retired-cluster-cleanup-still-required",
      "owned-cluster-and-synthetic-model-removed",
    ],
  };
}

test("aggregate qualifies only the independently selected Skipper image set with complete installed proof", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "skipper-release-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const control = join(directory, "release.json");
  const imageEnvironment = {
    OCC_DEVELOPMENT_CONTROLLER_IMAGE: `127.0.0.1:5000/oce-smoke/controller@${selection.images.controller}`,
    OCC_KUBERNETES_RUNTIME_IMAGE: `127.0.0.1:5000/oce-smoke/runtime@${selection.images.runtime}`,
    OCC_DEVELOPMENT_REPOSITORY_IMAGE: `127.0.0.1:5000/oce-smoke/repository@${selection.images.repository}`,
  };
  const summary = join(directory, "summary.md");
  const exported = join(directory, "environment");
  function produce(file: string, overrides: NodeJS.ProcessEnv = {}) {
    const result = spawnSync(
      process.execPath,
      ["scripts/ci/first-agent-smoke.mjs", "release-selection", file],
      {
        encoding: "utf8",
        timeout: 30_000,
        env: {
          PATH: process.env.PATH,
          GITHUB_SHA: "f".repeat(40), // The producer must use checked-out HEAD.
          GITHUB_STEP_SUMMARY: summary,
          GITHUB_ENV: exported,
          ...imageEnvironment,
          ...overrides,
        },
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.stdout, "");
    return result;
  }
  for (const [name, value] of [
    ["OCC_DEVELOPMENT_CONTROLLER_IMAGE", undefined],
    ["OCC_KUBERNETES_RUNTIME_IMAGE", "127.0.0.1:5000/oce-smoke/runtime@sha256:short"],
    ["OCC_DEVELOPMENT_REPOSITORY_IMAGE", imageEnvironment.OCC_DEVELOPMENT_CONTROLLER_IMAGE],
  ] as const) {
    const invalid = join(directory, "invalid.json");
    const result = produce(invalid, { [name]: value });
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(`${name} must be a SHA-256 image digest reference`));
    assert.ok(!result.stderr.includes("127.0.0.1"));
    await assert.rejects(readFile(invalid), { code: "ENOENT" });
  }
  const produced = produce(control);
  assert.equal(produced.status, 0, produced.stderr);
  assert.equal(produced.stderr, "");
  assert.deepEqual(JSON.parse(await readFile(control, "utf8")), selection);
  await assert.rejects(readFile(summary), { code: "ENOENT" });
  await assert.rejects(readFile(exported), { code: "ENOENT" });
  const args = ["scripts/ci/run-tests.mjs", "aggregate", lane, "--results-dir", directory];
  async function aggregate(evidence: unknown, expected: unknown = selection, mode = "qualify") {
    await writeFile(join(directory, lane + ".json"), JSON.stringify(evidence));
    if (mode !== "produced") {
      await writeFile(control, JSON.stringify(expected));
    }
    const result = spawnSync(
      process.execPath,
      [
        ...args,
        ...(mode === "smoke"
          ? []
          : ["--release-selection", mode === "missing" ? control + ".missing" : control]),
      ],
      {
        encoding: "utf8",
        timeout: 30_000,
        env: { PATH: process.env.PATH, GITHUB_SHA: sourceSha },
      },
    );
    assert.equal(result.error, undefined);
    const output = JSON.parse(result.stdout);
    assert.equal(result.status, output.status === "passed" ? 0 : 1, result.stderr);
    return output;
  }
  const passed = await aggregate(receipt(), selection, "produced");
  assert.equal(passed.status, "passed");
  assert.deepEqual(passed.releaseQualification, {
    ...selection,
    imageScope: "checkout-images-with-synthetic-model-trust-layer",
  });
  const smoke = await aggregate(receipt(), selection, "smoke");
  assert.equal(smoke.status, "passed");
  assert.equal(
    smoke.releaseQualification,
    undefined,
    "ordinary smoke does not qualify a selected release",
  );
  const denied = async (evidence: unknown, expected: unknown = selection, mode = "qualify") => {
    const output = await aggregate(evidence, expected, mode);
    assert.equal(output.status, "failed");
    assert.equal(output.releaseQualification, undefined);
    assert.ok(
      output.issues.some((issue: { code: string }) => issue.code === "skipper-release-mismatch"),
    );
  };
  await denied(receipt(), selection, "missing");
  await denied(receipt(), {});
  await denied(receipt(), { ...selection, sourceSha: "a".repeat(40) });
  await denied({ ...receipt(), sourceSha: "b".repeat(40) });
  await denied({ ...receipt(), imageScope: undefined });
  await denied({ ...receipt(), imageScope: "published-images" });
  for (const role of ["controller", "runtime", "repository"] as const) {
    await denied(receipt(), { ...selection, images: { ...selection.images, [role]: undefined } });
    await denied(receipt(), {
      ...selection,
      images: { ...selection.images, [role]: "sha256:" + "9".repeat(64) },
    });
    await denied({ ...receipt(), imageDigests: { ...receipt().imageDigests, [role]: undefined } });
    for (const field of ["built", "installed", "config"] as const) {
      const missing = receipt();
      Reflect.deleteProperty(missing.imageDigests[role], field);
      await denied(missing);
      const malformed = receipt();
      malformed.imageDigests[role][field] = "latest";
      await denied(malformed);
    }
  }
  for (let index = 0; index < receipt().proof.length; index++) {
    const missing = receipt();
    missing.proof.splice(index, 1);
    await denied(missing);
  }
  const duplicate = receipt();
  duplicate.proof.push(duplicate.proof[0]!);
  await denied(duplicate);
  const failedCleanup = receipt();
  failedCleanup.files[0]!.cleanup.status = "failed";
  await denied(failedCleanup);
  const skipped = receipt();
  skipped.files[0]!.tests[0]!.status = "skipped";
  await denied(skipped);
  const raw = receipt();
  for (const field of ["proof", "imageDigests", "imageScope"]) {
    Reflect.deleteProperty(raw, field);
  }
  await denied(raw);
  // The hosted producer uses the team-review variant of the same complete journey.
  const team = receipt();
  team.proof.splice(
    3,
    1,
    "controlled-draft-and-tested-commit-observed",
    "review-feedback-advanced-same-draft",
    "later-turn-reauthorized-and-advanced-same-draft",
  );
  assert.equal((await aggregate(team)).status, "passed");
});
