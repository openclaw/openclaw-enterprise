import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";

export const images = ["controller", "runtime"] as const;
export type Image = (typeof images)[number];
export const platforms = ["linux/amd64", "linux/arm64"] as const;
export type Platform = (typeof platforms)[number];
export const shaPattern = /^[a-f0-9]{40}$/;
export const digestPattern = /^sha256:[a-f0-9]{64}$/;
export const integerPattern = /^[1-9][0-9]*$/;
export type Producer = {
  sourceSha: string | undefined;
  workflowSha: string | undefined;
  runId: string | undefined;
  attempt: string | undefined;
  ciRunId: string | undefined;
  ciAttempt: string | undefined;
  nodeBaseImage: string | undefined;
};

const receiptKeys = [
  "sourceSha",
  "workflowSha",
  "runId",
  "attempt",
  "ciRunId",
  "ciAttempt",
  "nodeBaseImage",
  "image",
] as const;

type PreparedImage = Record<string, unknown> & {
  digest: string;
  archiveSha256: string;
  platforms: typeof platforms;
};

export function field(value: unknown, key: string): unknown {
  return value == null ? undefined : Reflect.get(Object(value), key);
}

export function match(value: unknown, pattern: RegExp, message?: string): asserts value is string {
  // Node checks the value's type before applying the regex. Keep its diagnostic
  // for untrusted inputs even though the TypeScript signature expects a string.
  Reflect.apply(assert.match, undefined, [value, pattern, message]);
}

export function validatePreparedImage(
  metadata: unknown,
  expected: Record<(typeof receiptKeys)[number], unknown>,
): asserts metadata is PreparedImage {
  for (const key of receiptKeys) {
    assert.equal(
      field(metadata, key),
      expected[key],
      `Prepared image ${key} does not match this run.`,
    );
  }
  assert.deepEqual(field(metadata, "platforms"), platforms);
  match(field(metadata, "digest") ?? "", digestPattern);
  match(field(metadata, "archiveSha256") ?? "", /^[a-f0-9]{64}$/);
}

export function isImage(image: unknown): image is Image {
  return images.some((name) => name === image);
}

export function isPlatform(platform: unknown): platform is Platform {
  return platforms.some((name) => name === platform);
}

export function identity(env: NodeJS.ProcessEnv, image: string | undefined) {
  assert.ok(isImage(image));
  return {
    sourceSha: env.SOURCE_SHA,
    workflowSha: env.GITHUB_WORKFLOW_SHA,
    runId: env.GITHUB_RUN_ID,
    attempt: env.GITHUB_RUN_ATTEMPT,
    ciRunId: env.CI_RUN_ID,
    ciAttempt: env.CI_ATTEMPT,
    nodeBaseImage: env.NODE_BASE_IMAGE,
    image,
    platforms,
  };
}

export async function fileDigest(path: string) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}
