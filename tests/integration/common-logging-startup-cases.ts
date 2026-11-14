import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { operationalLoggingConfiguration } from "../../apps/controller/src/logging.ts";
import {
  loadInstallationConfiguration,
  loadOperationalLoggingConfiguration,
  loadStartupConfigurationSnapshot,
} from "../../apps/controller/src/composition/installation-config.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { createInstallationDriverConfiguration } from "../helpers/installation-driver-configuration.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

async function fixture(t: TestContext, contents: string): Promise<string> {
  const directory = await temporaryDirectory(t, "occ-common-logging-");
  const path = join(directory, "installation.yaml");
  await writeFile(path, contents, "utf8");
  return path;
}

export function registerStartupConfigurationCases(): void {
  test("startup logging configuration is closed, defaults to info, and can stand alone in development", async (t) => {
    assert.deepEqual(operationalLoggingConfiguration(undefined), { level: "info" });
    assert.deepEqual(operationalLoggingConfiguration({}), { level: "info" });
    assert.throws(
      () => operationalLoggingConfiguration({ level: "trace" }),
      /logging\.level must be one of debug, info, warn, or error/,
    );
    assert.throws(
      () => operationalLoggingConfiguration({ level: null }),
      /logging\.level must be one of debug, info, warn, or error/,
    );
    assert.throws(
      () => operationalLoggingConfiguration({ level: "info", endpoint: "https://collector" }),
      /unsupported option/,
    );

    const loggingOnly = await fixture(t, "logging:\n  level: debug\n");
    assert.deepEqual(
      await loadOperationalLoggingConfiguration({
        mode: "development",
        environment: { OCC_CONFIG_PATH: loggingOnly },
      }),
      { level: "debug" },
    );
    assert.equal(
      await loadInstallationConfiguration({
        mode: "development",
        environment: { OCC_CONFIG_PATH: loggingOnly },
      }),
      undefined,
    );

    const full = { ...createInstallationDriverConfiguration(), logging: { level: "warn" } };
    const loaded = await loadInstallationConfiguration({
      mode: "production",
      environment: { OCC_CONFIG_PATH: await fixture(t, JSON.stringify(full)) },
    });
    assert.ok(loaded);
    assert.equal(loaded.installation.logging.level, "warn");
    assert.equal(Object.hasOwn(loaded, "logging"), false);
  });

  test("startup snapshot feeds logging and full Driver configuration without rereading YAML", async (t) => {
    const full = { ...createInstallationDriverConfiguration(), logging: { level: "warn" } };
    full.drivers.compute.configuration.network.gatewayPort = 8082;
    const path = await fixture(t, JSON.stringify(full));
    const startupConfiguration = await loadStartupConfigurationSnapshot({
      mode: "production",
      environment: { OCC_CONFIG_PATH: path },
    });

    // API and worker startup parse the trusted YAML once, then pass the same snapshot to logging
    // and Driver construction. A later file change must not affect the running process snapshot.
    await writeFile(path, "drivers: [\n", "utf8");
    assert.deepEqual(startupConfiguration.logging, { level: "warn" });
    const loaded = await loadInstallationConfiguration({
      mode: "production",
      environment: {},
      startupConfiguration,
    });

    assert.ok(loaded);
    assert.equal(loaded.installation.logging.level, "warn");
    const network = asRecord(loaded.installation.drivers.compute.configuration.network);
    assert.ok(network);
    assert.equal(network.gatewayPort, 8082);
  });
}

export function registerWorkerProcessCase(): void {
  test("worker startup diagnostics honor logging YAML and stay on stderr", async (t) => {
    const path = await fixture(t, "logging:\n  level: debug\n");
    const result = spawnSync(process.execPath, ["apps/controller/src/worker.mjs"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: "development",
        OCC_CONFIG_PATH: path,
        OCC_DATABASE_URL: "not-a-postgres-url",
      },
      encoding: "utf8",
      timeout: 10_000,
    });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    const diagnostic = result.stderr
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const parsed: unknown = JSON.parse(line);
        return asRecord(parsed);
      })
      .find((line) => line?.event === "worker.startup-error");
    assert.ok(diagnostic, result.stderr);
    assert.equal(diagnostic.severity, "ERROR");
    assert.equal(diagnostic.service, "occ-worker");
    assert.equal(diagnostic.code, "DATABASE_CONFIGURATION_INVALID");
    assert.equal(Object.hasOwn(diagnostic, "error"), false);
  });
}
