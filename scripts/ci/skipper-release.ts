import assert from "node:assert/strict";
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
