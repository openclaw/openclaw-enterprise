import assert from "node:assert/strict";
import { appendFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { publicationAlias, validate } from "./container-release/admission.ts";
import { digestPattern, identity, match } from "./container-release/metadata.ts";
import { smoke } from "./container-release/native-smoke.ts";
import { assemble, runtimeBuild, verifyPlatform } from "./container-release/oci.ts";
import { publishPrepared, seal } from "./container-release/publication.ts";

export {
  ghcrPackageName,
  github,
  githubPages,
  isReleaseVersion,
  publishWorkflow,
  repository,
  validateCi,
  validateContext,
  validateEnvironment,
  validatePackage,
  verifyCi,
  verifyEnvironment,
  verifyGhcr,
  verifyMainSource,
} from "./container-release/admission.ts";
export { fileDigest, validatePreparedImage } from "./container-release/metadata.ts";
export { runtimeImageSmokeTests } from "./container-release/native-smoke.ts";
export { readArchivePlatforms } from "./container-release/oci.ts";
export { publishPrepared } from "./container-release/publication.ts";
export {
  inspectDigest,
  remoteTagDigest,
  skopeo,
  skopeoLogin,
} from "./container-release/registry.ts";

async function main() {
  const [command, directory] = process.argv.slice(2);
  if (command === "validate") {
    const attempt = await validate(process.env);
    assert.ok(process.env.GITHUB_OUTPUT !== undefined, "GITHUB_OUTPUT is required.");
    await appendFile(process.env.GITHUB_OUTPUT, `ci_attempt=${attempt}\n`);
  } else if (command === "verify-platform") {
    const { PLATFORM, IMAGE_DIGEST } = process.env;
    match(IMAGE_DIGEST, digestPattern, "Expected the native build output digest.");
    assert.ok(directory !== undefined, "An OCI layout directory is required.");
    const { manifest, configDigest, rootDigest } = await verifyPlatform(
      resolve(directory),
      process.env,
      PLATFORM,
      IMAGE_DIGEST,
    );
    console.log(
      JSON.stringify({
        platform: PLATFORM,
        rootDigest,
        manifestDigest: manifest.digest,
        configDigest,
      }),
    );
  } else if (command === "record-build" || command === "verify-build") {
    assert.ok(directory !== undefined, "An OCI layout directory is required.");
    const digest = await runtimeBuild(resolve(directory), process.env, command === "record-build");
    assert.ok(process.env.GITHUB_OUTPUT !== undefined, "GITHUB_OUTPUT is required.");
    await appendFile(process.env.GITHUB_OUTPUT, `digest=${digest}\n`);
  } else if (command === "assemble") {
    assert.ok(directory !== undefined, "An OCI layout directory is required.");
    await assemble(directory, process.env);
  } else if (command === "smoke") {
    await smoke(directory, process.env);
  } else if (command === "seal") {
    await seal(directory, process.env);
  } else if (command === "publish") {
    assert.equal(process.env.PUBLISH, "true");
    const receipt = await publishPrepared(
      directory,
      process.env,
      identity(process.env, "controller"),
      () => validate(process.env),
      publicationAlias(process.env.IMAGE_TAG),
    );
    assert.ok(directory !== undefined);
    await writeFile(join(directory, "publication.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  } else {
    throw new Error(
      "Expected validate, record-build, verify-build, verify-platform, assemble, smoke, seal, or publish.",
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
