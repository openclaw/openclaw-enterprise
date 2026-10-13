import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  privateBootstrapDirectory,
  productionBootstrapEnvironment,
} from "../helpers/bootstrap-installation.mjs";
import { createInstallationDriverConfiguration } from "../helpers/installation-driver-configuration.mjs";

const run = promisify(execFile);
const repository = fileURLToPath(new URL("../..", import.meta.url));
const databaseUrl = process.env.OCC_TEST_DATABASE_URL;

test(
  "production controller upgrades preserve operator Presets and Configuration with default seeding disabled",
  {
    skip: databaseUrl
      ? false
      : "Set OCC_TEST_DATABASE_URL to an empty, migrated disposable PostgreSQL database.",
    timeout: 90000,
  },
  async (t) => {
    const directory = await privateBootstrapDirectory(t, "openclaw-preset-upgrade-");
    const before =
      process.env.OCC_TEST_PRESET_BEFORE_ROOT === undefined
        ? resolve(repository)
        : resolve(process.env.OCC_TEST_PRESET_BEFORE_ROOT);
    const migrationUrl = process.env.OCC_TEST_PRESET_MIGRATION_DATABASE_URL;
    if (migrationUrl !== undefined) {
      const application = new URL(databaseUrl);
      const migrator = new URL(migrationUrl);
      assert.equal(migrator.host, application.host);
      assert.equal(migrator.pathname, application.pathname);
      assert.notEqual(migrator.username, application.username);
    }
    if (before !== resolve(repository)) {
      assert.ok(
        migrationUrl,
        "Cross-revision proof needs the separate migrator URL for this same disposable database.",
      );
      const revision = await run("git", ["rev-parse", "HEAD"], { cwd: before });
      t.diagnostic(`Before controller revision: ${revision.stdout.trim()}`);
    }
    const environment = productionBootstrapEnvironment({
      databaseUrl,
      directory,
      email: "preset-upgrade@example.test",
      authSecret: `preset-upgrade-${randomUUID()}-${randomUUID()}`,
      installationName: "Operator installation",
    });
    const configuration = createInstallationDriverConfiguration();
    configuration.presets = { includeDefaults: true };
    configuration.drivers.compute.id = "compute-preset-upgrade";
    const startupPath = join(directory, "startup.json");
    await writeFile(startupPath, JSON.stringify(configuration), { mode: 0o600 });
    await run(process.execPath, ["scripts/bootstrap-installation.mjs"], {
      cwd: before,
      env: environment,
      timeout: 20000,
    });
    const fixture = join(repository, "tests/helpers/preset-upgrade-process.mjs");
    async function phase(root, name) {
      const result = await run(process.execPath, [fixture, root, directory, name], {
        cwd: root,
        env: { ...environment, OCC_TEST_DATABASE_URL: databaseUrl },
        timeout: 25000,
        maxBuffer: 1024 * 1024,
      });
      t.diagnostic(result.stdout.trim());
    }
    await phase(before, "seed");
    const stockInputs = await readFile(startupPath, "utf8");
    // Close the old process before migrations/startup. Keep the same application
    // database and Configuration filesystem through all three controller processes.
    if (migrationUrl !== undefined) {
      await run(process.execPath, ["scripts/migrate-production.mjs"], {
        cwd: repository,
        env: { ...environment, OCC_MIGRATION_DATABASE_URL: migrationUrl },
        timeout: 20000,
      });
    }
    await phase(repository, "upgraded");
    assert.equal(await readFile(startupPath, "utf8"), stockInputs);
    configuration.presets.includeDefaults = false;
    await writeFile(startupPath, JSON.stringify(configuration), { mode: 0o600 });
    await phase(repository, "disabled");
  },
);
