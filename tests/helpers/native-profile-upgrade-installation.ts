import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { TestContext } from "node:test";

import { asRecord } from "../../packages/utils/src/index.ts";
import { assertDockerImageId } from "../../scripts/ci/k3d-image-admission.ts";
import { execFile } from "../../scripts/ci/prepare-command.ts";
import { selectedImageMigrationEntry } from "../../scripts/lib/selected-image-migration.ts";
import { credentialInputs, privateBootstrapDirectory } from "./bootstrap-installation.mjs";

type NativeUpgradeOptions = Readonly<{
  image: string;
  migrationUrl: string;
  databaseUrl: string;
  expectedInstallationId?: string;
  email: string;
  authSecret: string;
  authBaseURL?: string;
  agentDomain?: string;
  installationName: string;
}>;

type InitializationStage = "migration" | "bootstrap";

async function removeInitializer(docker: string, name: string) {
  try {
    await execFile(docker, ["rm", "--force", name], { timeoutMs: 30_000 });
  } catch (error) {
    const stderr = asRecord(error)?.stderr;
    if (typeof stderr !== "string" || !stderr.includes("No such container")) {
      // eslint-disable-next-line preserve-caught-error -- Raw engine output must not enter test receipts.
      throw new Error("Native upgrade initializer cleanup failed.");
    }
  }
}

function readReceipt(stdout: string) {
  try {
    const value: unknown = JSON.parse(stdout);
    return asRecord(value);
  } catch {
    throw new Error("Native upgrade initialization receipt is invalid.");
  }
}

// Run the image's real production entrypoints, never the host checkout's
// bootstrap implementation. Only this short-lived initializer gets the
// migrator URL. API and Worker retain the limited application role.
export async function initializeNativeUpgradeInstallation(
  context: Pick<TestContext, "after">,
  options: NativeUpgradeOptions,
) {
  const { image, migrationUrl, databaseUrl, expectedInstallationId } = options;
  assertDockerImageId(image, "native upgrade initializer image");
  const fresh = expectedInstallationId === undefined;
  const credentials = fresh
    ? { email: options.email, password: randomBytes(32).toString("base64url") }
    : undefined;
  const directory = credentials
    ? await privateBootstrapDirectory(context, "oce-native-upgrade-bootstrap-")
    : undefined;
  // Only the fresh baseline bootstrap receives protected files on a read-only mount.
  const bootstrapInputs =
    directory !== undefined && credentials !== undefined
      ? Object.fromEntries(
          Object.entries(credentialInputs(directory, credentials.password)).map(([key, path]) => [
            key,
            "/bootstrap/" + basename(path),
          ]),
        )
      : {};
  const environment = {
    NODE_ENV: "production",
    OCC_DATABASE_URL: databaseUrl,
    OCC_AUTH_SECRET: options.authSecret,
    OCC_AUTH_BASE_URL: options.authBaseURL ?? "https://console.oce.localhost",
    OCC_AGENT_NATIVE_ADMIN_DOMAIN: options.agentDomain ?? "agents.oce.localhost",
    OCC_BOOTSTRAP_ADMIN_EMAIL: options.email,
    OCC_BOOTSTRAP_INSTALLATION_NAME: options.installationName,
  };
  const docker = process.env.OCC_DOCKER_BIN ?? "docker";
  const run = async (stage: InitializationStage, args: readonly string[]) => {
    // Historical images own these entrypoints; do not substitute host scripts.
    const entry =
      stage === "migration" ? selectedImageMigrationEntry : ["scripts/bootstrap-installation.mjs"];
    const name = "oce-native-upgrade-init-" + randomUUID();
    const mountedDirectory = stage === "bootstrap" ? directory : undefined;
    const values: NodeJS.ProcessEnv = {
      ...environment,
      ...(stage === "migration" ? { OCC_MIGRATION_DATABASE_URL: migrationUrl } : bootstrapInputs),
    };
    const environmentArgs = Object.entries(values).flatMap(([key, value]) =>
      value === undefined ? [] : ["--env", key],
    );
    let stdout: string;
    try {
      assert.ok(process.getuid && process.getgid, "Native upgrade requires POSIX user IDs.");
      ({ stdout } = await execFile(
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
          `${process.getuid()}:${process.getgid()}`,
          ...(mountedDirectory === undefined
            ? []
            : ["--mount", `type=bind,src=${mountedDirectory},dst=/bootstrap,readonly`]),
          ...environmentArgs,
          image,
          ...entry,
          ...args,
        ],
        { env: values, timeoutMs: 120_000, maxOutputChars: 4096 },
      ));
    } catch {
      // Captured database output is deliberately withheld from test receipts.
      throw new Error(`Native upgrade image production initialization failed: ${stage}`);
    } finally {
      // A failed cleanup takes precedence over the command's own failure.
      await removeInitializer(docker, name);
    }
    return readReceipt(stdout);
  };

  const migration = await run("migration", fresh ? ["--expect-empty"] : []);
  assert.ok(
    migration?.event === "migration.completed" &&
      typeof migration.history === "string" &&
      (!fresh || migration.history === "empty"),
    "the baseline must migrate empty history; the candidate must accept the real incumbent catalog",
  );
  const checked = await run("migration", ["--require-current"]);
  assert.ok(
    checked?.event === "migration.checked" && checked.history === "completed",
    "the selected image must verify its own complete current catalog after migration",
  );
  const bootstrap = await run(
    "bootstrap",
    fresh ? [] : ["--verify-existing", expectedInstallationId],
  );
  const bootstrapEvent = fresh ? "installation.bootstrapped" : "installation.bootstrap-verified";
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
  } as const;
  return credentials ? { credentials, receipt } : { receipt };
}
