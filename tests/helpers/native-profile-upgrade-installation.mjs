import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "../../scripts/ci/prepare-command.ts";
import { assertDockerImageId } from "../../scripts/ci/k3d-image-admission.ts";
import {
  privateBootstrapDirectory,
  productionBootstrapEnvironment,
} from "./bootstrap-installation.mjs";

// Run the image's real production entrypoints, never the host checkout's
// bootstrap implementation. Only this short-lived initializer gets the
// migrator URL. API and Worker retain the limited application role.
export async function initializeNativeUpgradeInstallation(context, options) {
  const { image, migrationUrl, databaseUrl, expectedInstallationId } = options;
  assertDockerImageId(image, "native upgrade initializer image");
  const directory = await privateBootstrapDirectory(context, "oce-native-upgrade-bootstrap-");
  const environment = productionBootstrapEnvironment({ ...options, directory: "/bootstrap" });
  const docker = process.env.OCC_DOCKER_BIN ?? "docker";
  const run = async (script, database, args = []) => {
    const name = "oce-native-upgrade-init-" + randomUUID();
    const values = {
      ...environment,
      OCC_DATABASE_URL: databaseUrl,
      OCC_MIGRATION_DATABASE_URL: database,
    };
    // Names only enter argv; URLs, auth secrets and generated credentials never
    // enter command diagnostics. Do not forward unrelated host/model variables.
    const names = Object.keys(values).filter((key) => key === "NODE_ENV" || key.startsWith("OCC_"));
    const allowed = names.filter((key) =>
      [
        "NODE_ENV",
        "OCC_DATABASE_URL",
        "OCC_MIGRATION_DATABASE_URL",
        "OCC_AUTH_SECRET",
        "OCC_AUTH_BASE_URL",
        "OCC_AGENT_NATIVE_ADMIN_DOMAIN",
        "OCC_BOOTSTRAP_ADMIN_EMAIL",
        "OCC_BOOTSTRAP_PASSWORD_FILE",
        "OCC_BOOTSTRAP_SERVICE_KEY_FILE",
        "OCC_BOOTSTRAP_INSTALLATION_NAME",
      ].includes(key),
    );
    let failed = false;
    let cleanupFailed = false;
    let output;
    try {
      output = await execFile(
        docker,
        [
          "run",
          "--name",
          name,
          "--network=host",
          "--read-only",
          "--cap-drop=ALL",
          "--security-opt=no-new-privileges",
          "--user",
          String(process.getuid()) + ":" + String(process.getgid()),
          "--mount",
          "type=bind,src=" + directory + ",dst=/bootstrap",
          ...allowed.flatMap((key) => ["--env", key]),
          image,
          script,
          ...args,
        ],
        { env: values, timeoutMs: 120_000, maxOutputChars: 4096 },
      );
    } catch {
      // Captured database output is deliberately withheld from test receipts.
      failed = true;
    }
    try {
      await execFile(docker, ["rm", "--force", name], { timeoutMs: 30_000 });
    } catch (error) {
      cleanupFailed = !/No such container/.test(error.stderr ?? "");
    }
    if (cleanupFailed) {
      throw new Error("Native upgrade initializer cleanup failed.");
    }
    if (failed) {
      throw new Error("Native upgrade image production initialization failed: " + script);
    }
    try {
      return JSON.parse(output.stdout);
    } catch {
      throw new Error("Native upgrade initialization receipt is invalid.");
    }
  };
  const migration = await run(
    "scripts/migrate-production.mjs",
    migrationUrl,
    expectedInstallationId === undefined ? ["--expect-empty"] : [],
  );
  assert.ok(
    migration?.event === "migration.completed" &&
      typeof migration?.history === "string" &&
      (expectedInstallationId !== undefined || migration.history === "empty"),
    "the baseline must migrate empty history; the candidate must accept the real incumbent catalog",
  );
  const checked = await run("scripts/migrate-production.mjs", migrationUrl, ["--require-current"]);
  assert.ok(
    checked?.event === "migration.checked" && checked?.history === "completed",
    "the selected image must verify its own complete current catalog after migration",
  );
  const bootstrap = await run(
    "scripts/bootstrap-installation.mjs",
    undefined,
    expectedInstallationId === undefined ? [] : ["--verify-existing", expectedInstallationId],
  );
  const bootstrapEvent =
    expectedInstallationId === undefined
      ? "installation.bootstrapped"
      : "installation.bootstrap-verified";
  assert.ok(
    bootstrap?.event === bootstrapEvent,
    "the selected image must bootstrap or verify the incumbent Installation",
  );
  const receipt = {
    migration: {
      event: "migration.completed",
      startedEmpty: migration.history === "empty",
      startedCurrent: migration.history === "completed",
      currentHistory: "completed",
    },
    bootstrap: { event: bootstrapEvent },
  };
  if (expectedInstallationId !== undefined) {
    return { receipt };
  }
  const password = (await readFile(join(directory, "initial-admin-password"), "utf8")).trim();
  assert.ok(password.length >= 32, "old image must generate the initial recovery password");
  return { credentials: { email: options.email, password }, receipt };
}
