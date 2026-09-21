import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ghcrPackageName,
  github,
  inspectDigest,
  repository,
  skopeo,
  validatePackage,
  verifyCi,
  verifyEnvironment,
  verifyMainSource,
} from "./container-release.mjs";

const workflow = ".github/workflows/container-bootstrap.yml";

async function main(env) {
  const validate = async () => {
    await verifyMainSource(env, workflow);
    assert.equal(env.SOURCE_SHA, env.GITHUB_WORKFLOW_SHA);
    assert.equal(
      execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      env.SOURCE_SHA,
    );
    await verifyCi(env);
    await verifyEnvironment();
  };
  await validate();
  const destinations = [env.GHCR_CONTROLLER_IMAGE, env.GHCR_RUNTIME_IMAGE];
  const packages = destinations.map((image) => ({
    image,
    path: `orgs/openclaw/packages/container/${encodeURIComponent(ghcrPackageName(image))}`,
  }));
  assert.notEqual(destinations[0], destinations[1], "Images need separate packages.");
  // Validate every existing destination before any registry write. A 404 only
  // permits harmless bootstrap bytes, never Enterprise source-bearing images.
  for (const pkg of packages) {
    const existing = await github(pkg.path, { allowNotFound: true });
    if (existing) {
      validatePackage(existing, pkg.image, { allowMissingRepository: true });
    }
  }
  assert.match(env.GITHUB_RUN_ID ?? "", /^[1-9][0-9]*$/);
  assert.match(env.GITHUB_RUN_ATTEMPT ?? "", /^[1-9][0-9]*$/);
  const tag = `bootstrap-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`;
  const directory = await mkdtemp(join(tmpdir(), "enterprise-package-bootstrap-"));
  const authfile = join(directory, "auth.json");
  const archive = join(directory, "marker.tar");
  const context = join(directory, "context");
  try {
    await mkdir(context);
    await writeFile(join(context, "marker.txt"), "Non-deployable container package bootstrap.\n");
    await writeFile(
      join(context, "Dockerfile"),
      [
        "FROM scratch",
        `LABEL org.opencontainers.image.source=https://github.com/${repository}`,
        `LABEL org.opencontainers.image.revision=${env.SOURCE_SHA}`,
        "COPY marker.txt /package-bootstrap.txt",
        "",
      ].join("\n"),
    );
    execFileSync(
      "docker",
      [
        "buildx",
        "build",
        "--platform",
        "linux/amd64",
        "--provenance=false",
        "--output",
        `type=oci,dest=${archive}`,
        context,
      ],
      { stdio: "inherit" },
    );
    const digest = inspectDigest(`oci-archive:${archive}`);
    skopeo(
      [
        "login",
        "--authfile",
        authfile,
        "--username",
        env.GITHUB_ACTOR,
        "--password-stdin",
        "ghcr.io",
      ],
      { input: env.GH_TOKEN, stdio: ["pipe", "ignore", "pipe"] },
    );
    for (const pkg of packages) {
      await validate();
      const existing = await github(pkg.path, { allowNotFound: true });
      if (existing) {
        validatePackage(existing, pkg.image, { allowMissingRepository: true });
        await appendFile(
          env.GITHUB_STEP_SUMMARY,
          `- Existing private package: \`${pkg.image}\` (unchanged; confirm linkage in package settings before publication).\n`,
        );
        continue;
      }
      skopeo(
        [
          "copy",
          "--all",
          "--preserve-digests",
          "--authfile",
          authfile,
          `oci-archive:${archive}`,
          `docker://${pkg.image}:${tag}`,
        ],
        { stdio: "inherit" },
      );
      validatePackage(await github(pkg.path, { retryNotFound: true }), pkg.image, {
        allowMissingRepository: true,
      });
      assert.equal(inspectDigest(`docker://${pkg.image}:${tag}`, authfile), digest);
      await appendFile(
        env.GITHUB_STEP_SUMMARY,
        `- Bootstrapped private package: \`${pkg.image}:${tag}\` at \`${digest}\` (marker only; confirm linkage in package settings before publication).\n`,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

main(process.env).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
