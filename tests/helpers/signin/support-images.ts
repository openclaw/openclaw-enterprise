import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { asRecord } from "../../../packages/utils/src/index.ts";
import {
  postgresImage,
  runtimeNodeBaseImage,
} from "../../../scripts/ci/fixture-support-images.mjs";
import type { FixtureRun } from "../production-rehearsal-custody.ts";

const runtimeRecipe = new URL("../../../deploy/runtime/Dockerfile", import.meta.url);
const verifier = fileURLToPath(
  new URL("../../../scripts/upgrade-image-identity.py", import.meta.url),
);

type SupportImageReferences = { node: string; postgres: string };

function repositoryDigest(pin: string) {
  const match = /^(docker\.io\/library\/[a-z0-9-]+):[^@/]+@(sha256:[a-f0-9]{64})$/.exec(pin);
  const [, repository, digest] = match ?? [];
  assert.ok(repository && digest, "support image must be a pinned official repository image");
  return repository + "@" + digest;
}

export async function signinSupportReferences(): Promise<SupportImageReferences> {
  return {
    node: repositoryDigest(runtimeNodeBaseImage(await readFile(runtimeRecipe, "utf8"))),
    postgres: repositoryDigest(postgresImage),
  };
}

async function inspectSupportImage(run: FixtureRun, reference: string) {
  const [, rootDigest] = reference.split("@");
  const digestPattern = /^sha256:[a-f0-9]{64}$/;
  assert.ok(rootDigest && digestPattern.test(rootDigest));
  const observed: unknown = JSON.parse(
    await run("python3", [verifier, reference, "linux/amd64"], { timeout: 180_000 }),
  );
  const identity = asRecord(observed);
  assert.ok(identity);
  assert.equal(identity.image, reference);
  assert.equal(identity.rootDigest, rootDigest);
  assert.equal(identity.platform, "linux/amd64");
  const { manifestDigest, configDigest } = identity;
  assert.ok(typeof manifestDigest === "string" && typeof configDigest === "string");
  assert.match(manifestDigest, digestPattern);
  assert.match(configDigest, digestPattern);
  return {
    ...identity,
    image: identity.image,
    rootDigest: identity.rootDigest,
    platform: identity.platform,
    manifestDigest,
    configDigest,
  };
}

// The launcher stages these immutable images on the local daemon before the test.
// The running Pod must later match this config, even when Kubernetes reports the index.
export async function inspectSigninSupport(run: FixtureRun, references: SupportImageReferences) {
  assert.ok(
    Object.keys(references).length === 2 &&
      Object.hasOwn(references, "node") &&
      Object.hasOwn(references, "postgres"),
  );
  return {
    node: await inspectSupportImage(run, references.node),
    postgres: await inspectSupportImage(run, references.postgres),
  };
}
