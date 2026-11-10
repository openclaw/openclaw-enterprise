import assert from "node:assert/strict";
import { basename, resolve } from "node:path";
import { teamReviewProof } from "../../tests/fixtures/skipper-team-review-journey.mjs";

export const skipperImageScope = "checkout-images-with-synthetic-model-trust-layer";

export function skipperInstalledProof(teamReview: boolean): string[] {
  return [
    "deployed-revision-gateway-and-harness-ready",
    "chat-before-private-git-verified",
    "prepared-before-native-git",
    ...(teamReview ? teamReviewProof : ["native-commit-confirmed-by-independent-fetch"]),
    "wrong-repository-hook-refusal-and-broker-denied-mixed-push",
    "native-authenticated-post-after-withdrawal-refused",
    "fresh-authenticated-fetch-after-effective-withdrawal-refused",
    "same-compute-owned-skipper-chat-after-git-withdrawal-verified",
    "same-compute-owned-skipper-chat-git-and-live-withdrawal-observed",
    "owned-agent-retired-cluster-cleanup-still-required",
  ];
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

/** Keep the selected failure's location and category together, without publishing its text. */
export function skipperFailureSummary(resultText: string, root: string, fallback: string): string {
  const coordinate = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 1_000_000;
  let text = fallback;
  let site;
  let category;
  try {
    const files = record(JSON.parse(resultText)).files;
    assert.ok(Array.isArray(files));
    const path = "tests/integration/skipper-prepared-git-installed.test.mjs";
    const file = files.map(record).find((entry) => entry.path === path);
    assert.ok(file && Array.isArray(file.tests));
    const failed = file.tests.map(record).find((entry) => entry.status === "failed");
    const fileFailure = failed?.error == null ? record(file.fileFailure) : undefined;
    const error = record(failed?.error ?? fileFailure?.error);
    const cause = record(error.cause ?? {});
    const location = record(error.location ?? {});
    // Commit selected state only after its nested records validate. Never pair
    // one case's location with another case's error from the lane output.
    text = [error.message, error.frame].filter((value) => typeof value === "string").join("\n");
    if (fileFailure?.diagnosticKind === "post-test-async-activity") {
      category = "post-test-async-activity";
    } else if (cause.code === "ERR_ASSERTION") {
      category = "ERR_ASSERTION";
    } else if (error.code === "ERR_TEST_FAILURE") {
      category = "ERR_TEST_FAILURE";
    }
    const source = [path, "tests/helpers/skipper-prepared-compute.mjs"].find(
      (name) => location.file === resolve(root, name),
    );
    if (source && coordinate(location.line) && coordinate(location.column)) {
      site = `${basename(source)}:${location.line}:${location.column}`;
    }
  } catch {
    // Missing or malformed diagnostics must not replace the original test failure.
  }
  if (!site) {
    const match = text.match(
      /((?:skipper-prepared-compute|skipper-prepared-git-installed\.test)\.mjs):(\d+):(\d+)(?!\d)/,
    );
    const line = Number(match?.[2]);
    const column = Number(match?.[3]);
    if (match && coordinate(line) && coordinate(column)) {
      site = `${match[1]}:${line}:${column}`;
    }
  }
  // Prefer a specific signal in this error to the generic Node test wrapper.
  category =
    text.match(
      /RTM_NEWADDR|bwrap|native command failed|missing-env|test-timeout|selected-zero|timed out:/,
    )?.[0] ??
    category ??
    text.match(/ERR_ASSERTION|expected-test-not-passed/)?.[0];
  return `${site ?? "location unavailable"}, ${category ?? "unclassified"}`;
}

function digest(value: unknown): string {
  assert.ok(typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value));
  return value;
}

/** The aggregate's explicit control file is independent of the installed receipt. */
export function qualifySkipperRelease(selection: unknown, evidence: unknown, currentSha: string) {
  const expected = record(selection);
  assert.ok(typeof expected.sourceSha === "string" && /^[a-f0-9]{40}$/.test(expected.sourceSha));
  assert.equal(expected.sourceSha, currentSha);
  const selectedImages = record(expected.images);
  const receipt = record(evidence);
  assert.equal(receipt.sourceSha, expected.sourceSha);
  assert.equal(receipt.imageScope, skipperImageScope);
  assert.equal(receipt.version, 1);
  assert.equal(receipt.command, "run");
  assert.equal(receipt.lane, "skipper-prepared-git-installed");
  assert.equal(receipt.status, "passed");
  assert.equal(receipt.exitCode, 0);
  const counts = { passed: 1, failed: 0, skipped: 0, todo: 0, total: 1 };
  assert.deepEqual(receipt.counts, counts);
  assert.deepEqual(receipt.issues ?? [], []);
  assert.ok(Array.isArray(receipt.files) && receipt.files.length === 1);
  const file = record(receipt.files[0]);
  assert.equal(file.path, "tests/integration/skipper-prepared-git-installed.test.mjs");
  assert.equal(file.status, "passed");
  assert.deepEqual(file.counts, counts);
  assert.deepEqual(file.cleanup, { status: "passed" });
  assert.ok(Array.isArray(file.tests) && file.tests.length === 1);
  const test = record(file.tests[0]);
  assert.equal(
    test.name,
    "same Compute-owned Skipper chats, authors private Git, loses Git during an authenticated fetch, and still chats",
  );
  assert.equal(test.status, "passed");
  assert.ok(Array.isArray(receipt.proof));
  const teamReview = receipt.proof.includes(teamReviewProof[0]);
  assert.deepEqual(receipt.proof, [
    ...skipperInstalledProof(teamReview),
    "owned-cluster-and-synthetic-model-removed",
  ]);
  const observed = record(receipt.imageDigests);
  const images: Record<string, string> = {};
  for (const name of ["controller", "runtime", "repository"]) {
    const image = record(observed[name]);
    images[name] = digest(selectedImages[name]);
    assert.equal(digest(image.built), images[name]);
    // Imported manifests can differ from the built manifest; checkImage already
    // verified the actual CRI config against the selected local image config.
    digest(image.installed);
    digest(image.config);
  }
  return { sourceSha: expected.sourceSha, images, imageScope: skipperImageScope };
}
