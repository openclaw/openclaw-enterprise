import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  postgresImage,
  runtimeNodeBaseImage,
} from "../../../scripts/ci/fixture-support-images.mjs";

const runtimeRecipe = new URL("../../../deploy/runtime/Dockerfile", import.meta.url);
const verifier = fileURLToPath(
  new URL("../../../scripts/upgrade-image-identity.py", import.meta.url),
);
function repositoryDigest(pin) {
  const match = /^(docker\.io\/library\/[a-z0-9-]+):[^@/]+@(sha256:[a-f0-9]{64})$/.exec(pin);
  assert.ok(match, "support image must be a pinned official repository image");
  return match[1] + "@" + match[2];
}
export async function signinSupportReferences() {
  return {
    node: repositoryDigest(runtimeNodeBaseImage(await readFile(runtimeRecipe, "utf8"))),
    postgres: repositoryDigest(postgresImage),
  };
}

// The launcher stages these immutable images on the local daemon before the test.
// The running Pod must later match this config, even when Kubernetes reports the index.
export async function inspectSigninSupport(run, references) {
  const selected = {};
  for (const [role, reference] of Object.entries(references)) {
    const identity = JSON.parse(
      await run("python3", [verifier, reference, "linux/amd64"], { timeout: 180_000 }),
    );
    assert.equal(identity.image, reference);
    assert.equal(identity.rootDigest, reference.split("@")[1]);
    assert.equal(identity.platform, "linux/amd64");
    assert.match(identity.manifestDigest, /^sha256:[a-f0-9]{64}$/);
    assert.match(identity.configDigest, /^sha256:[a-f0-9]{64}$/);
    selected[role] = identity;
  }
  return selected;
}
