import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chartPackage, chartPushParent, pushChart, writeBootstrapChart } from "./chart-package.mjs";
import {
  ghcrPackageName,
  github,
  inspectDigest,
  repository,
  skopeo,
  skopeoLogin,
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
  const chartPath = `orgs/openclaw/packages/container/${encodeURIComponent(ghcrPackageName(chartPackage))}`;
  assert.notEqual(destinations[0], destinations[1], "Images need separate packages.");
  assert.ok(!destinations.includes(chartPackage), "The chart needs its own package.");
  // Validate every existing destination before any registry write. A 404 only
  // permits harmless bootstrap bytes, never Enterprise source-bearing images.
  for (const pkg of packages) {
    const existing = await github(pkg.path, { allowNotFound: true });
    if (existing) {
      validatePackage(existing, pkg.image, {
        allowMissingRepository: true,
        allowPrivateBootstrap: true,
      });
    }
  }
  const existingChart = await github(chartPath, { allowNotFound: true });
  if (existingChart) {
    validatePackage(existingChart, chartPackage, {
      allowMissingRepository: true,
      allowPrivateBootstrap: true,
    });
  }
  assert.match(env.GITHUB_RUN_ID ?? "", /^[1-9][0-9]*$/);
  assert.match(env.GITHUB_RUN_ATTEMPT ?? "", /^[1-9][0-9]*$/);
  const tag = `bootstrap-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`;
  const directory = await mkdtemp(join(tmpdir(), "enterprise-package-bootstrap-"));
  const authfile = join(directory, "auth.json");
  const archive = join(directory, "marker.tar");
  const context = join(directory, "context");
  const chartDirectory = join(directory, "chart");
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
    skopeoLogin("ghcr.io", authfile, env.GITHUB_ACTOR, env.GH_TOKEN);
    for (const pkg of packages) {
      await validate();
      const existing = await github(pkg.path, { allowNotFound: true });
      if (existing) {
        validatePackage(existing, pkg.image, {
          allowMissingRepository: true,
          allowPrivateBootstrap: true,
        });
        await appendFile(
          env.GITHUB_STEP_SUMMARY,
          `- Existing package: \`${pkg.image}\` (unchanged; set visibility to public and confirm linkage in package settings before publication).\n`,
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
        allowPrivateBootstrap: true,
      });
      assert.equal(inspectDigest(`docker://${pkg.image}:${tag}`, authfile), digest);
      await appendFile(
        env.GITHUB_STEP_SUMMARY,
        `- Bootstrapped marker package: \`${pkg.image}:${tag}\` at \`${digest}\` (marker only; set visibility to public and confirm linkage in package settings before publication).\n`,
      );
    }
    await validate();
    const chart = await github(chartPath, { allowNotFound: true });
    if (chart) {
      validatePackage(chart, chartPackage, {
        allowMissingRepository: true,
        allowPrivateBootstrap: true,
      });
      await appendFile(
        env.GITHUB_STEP_SUMMARY,
        `- Existing chart package: \`${chartPackage}\` (unchanged; set visibility to public and confirm linkage before publication).\n`,
      );
    } else {
      const version = `0.0.0-bootstrap.${env.GITHUB_RUN_ID}.${env.GITHUB_RUN_ATTEMPT}`;
      await writeBootstrapChart(chartDirectory, version);
      execFileSync(
        env.OCC_HELM_BIN ?? "helm",
        ["package", chartDirectory, "--destination", directory],
        { stdio: "ignore" },
      );
      execFileSync(
        env.OCC_HELM_BIN ?? "helm",
        ["registry", "login", "ghcr.io", "--username", env.GITHUB_ACTOR, "--password-stdin"],
        { input: env.GH_TOKEN, stdio: ["pipe", "ignore", "pipe"] },
      );
      const chartArchive = join(directory, `openclaw-enterprise-${version}.tgz`);
      const pushedDigest = pushChart(chartArchive, chartPushParent);
      validatePackage(await github(chartPath, { retryNotFound: true }), chartPackage, {
        allowMissingRepository: true,
        allowPrivateBootstrap: true,
      });
      assert.equal(inspectDigest(`docker://${chartPackage}:${version}`, authfile), pushedDigest);
      await appendFile(
        env.GITHUB_STEP_SUMMARY,
        `- Bootstrapped chart marker package: \`${chartPackage}:${version}\` at \`${pushedDigest}\` (non-deployable marker; set visibility to public before publication).\n`,
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
