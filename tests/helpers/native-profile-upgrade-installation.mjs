import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { basename } from "node:path";
import { execFile } from "../../scripts/ci/prepare-command.ts";
import { assertDockerImageId } from "../../scripts/ci/k3d-image-admission.ts";
import { selectedImageMigrationEntry } from "../../scripts/lib/selected-image-migration.ts";
import { credentialInputs, privateBootstrapDirectory } from "./bootstrap-installation.mjs";

// Run the image's real production entrypoints, never the host checkout's
// bootstrap implementation. Only this short-lived initializer gets the
// migrator URL. API and Worker retain the limited application role.
export async function initializeNativeUpgradeInstallation(context, options) {
  const { image, migrationUrl, databaseUrl, expectedInstallationId } = options;
  assertDockerImageId(image, "native upgrade initializer image");
  const initialCredentials =
    expectedInstallationId === undefined
      ? { email: options.email, password: randomBytes(32).toString("base64url") }
      : undefined;
  const directory = initialCredentials
    ? await privateBootstrapDirectory(context, "oce-native-upgrade-bootstrap-")
    : undefined;
  // Only the fresh baseline bootstrap receives credential inputs. Its real
  // image entrypoint consumes protected files without a writable mount.
  const bootstrapInputs =
    directory && initialCredentials
      ? Object.entries(credentialInputs(directory, initialCredentials.password)).map(
          ([key, path]) => [key, "/bootstrap/" + basename(path)],
        )
      : [];
  const environment = {
    NODE_ENV: "production",
    OCC_DATABASE_URL: databaseUrl,
    OCC_AUTH_SECRET: options.authSecret,
    OCC_AUTH_BASE_URL: options.authBaseURL ?? "https://console.oce.localhost",
    OCC_AGENT_NATIVE_ADMIN_DOMAIN: options.agentDomain ?? "agents.oce.localhost",
    OCC_BOOTSTRAP_ADMIN_EMAIL: options.email,
    OCC_BOOTSTRAP_INSTALLATION_NAME: options.installationName,
  };
  // The existing production launcher reads the selected image's declared
  // migration command.
  const docker = process.env.OCC_DOCKER_BIN ?? "docker";
  const run = async (entry, database, args = []) => {
    const stage = entry === selectedImageMigrationEntry ? "migration" : "bootstrap";
    const name = "oce-native-upgrade-init-" + randomUUID();
    const inputs = stage === "bootstrap" ? bootstrapInputs : [];
    const values = {
      ...environment,
      OCC_MIGRATION_DATABASE_URL: database,
      ...Object.fromEntries(inputs),
    };
    // Pass only the explicitly selected environment names to the container.
    const environmentArgs = Object.entries(values).flatMap(([key, value]) =>
      value === undefined ? [] : ["--env", key],
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
          ...(inputs.length
            ? ["--mount", "type=bind,src=" + directory + ",dst=/bootstrap,readonly"]
            : []),
          ...environmentArgs,
          image,
          ...entry,
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
      throw new Error("Native upgrade image production initialization failed: " + stage);
    }
    try {
      return JSON.parse(output.stdout);
    } catch {
      throw new Error("Native upgrade initialization receipt is invalid.");
    }
  };
  const migration = await run(
    selectedImageMigrationEntry,
    migrationUrl,
    expectedInstallationId === undefined ? ["--expect-empty"] : [],
  );
  assert.ok(
    migration?.event === "migration.completed" &&
      typeof migration?.history === "string" &&
      (expectedInstallationId !== undefined || migration.history === "empty"),
    "the baseline must migrate empty history; the candidate must accept the real incumbent catalog",
  );
  const checked = await run(selectedImageMigrationEntry, migrationUrl, ["--require-current"]);
  assert.ok(
    checked?.event === "migration.checked" && checked?.history === "completed",
    "the selected image must verify its own complete current catalog after migration",
  );
  const bootstrap = await run(
    ["scripts/bootstrap-installation.mjs"],
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
  return initialCredentials ? { credentials: initialCredentials, receipt } : { receipt };
}
