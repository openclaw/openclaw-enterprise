import assert from "node:assert/strict";
import { execFile, type ExecFileOptionsWithStringEncoding } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext, type TestOptions } from "node:test";
import { promisify } from "node:util";
import { asRecord } from "../../packages/utils/src/index.ts";
import { imageSmokeTimeoutMultiplier } from "../helpers/image-smoke-timeout.ts";
import { jsonEvent } from "../helpers/json-lines.ts";

const execute = promisify(execFile);
const docker = process.env.OCC_DOCKER_BIN ?? "docker";

export const image = process.env.OCC_TEST_PRODUCTION_IMAGE;
export const imageTestOptions: TestOptions =
  image === undefined
    ? {
        skip: "Set OCC_TEST_PRODUCTION_IMAGE to a locally built production controller image tag.",
      }
    : {};

type ControllerStartupCases = {
  productionFixture: (context: TestContext) => Promise<string>;
};

export async function runDocker(
  args: readonly string[],
  options: ExecFileOptionsWithStringEncoding = {},
) {
  return execute(docker, args, {
    encoding: "utf8",
    timeout: 20_000 * imageSmokeTimeoutMultiplier,
    maxBuffer: 1_000_000,
    ...options,
  });
}

async function runStartupExpectingFailure(
  args: readonly string[],
  options: ExecFileOptionsWithStringEncoding = {},
): Promise<string> {
  let failure: unknown;
  try {
    // Keep Node out of PID 1 so it can receive the forwarded timeout signal.
    // A Docker client timeout alone does not establish that the container stopped.
    await runDocker(["run", "--rm", "--init", "--network", "none", ...args], options);
  } catch (error) {
    failure = error;
  }

  assert.ok(failure, "startup must fail with exit code 1, but Docker exited successfully");
  const result = asRecord(failure);
  assert.ok(result, "Docker startup failure must carry process exit information");
  const { code, killed, signal } = result;
  assert.deepEqual(
    { code, killed, signal },
    { code: 1, killed: false, signal: null },
    "startup requires an unforced Docker CLI exit with code 1",
  );
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  assert.equal(typeof stdout, "string");
  assert.equal(typeof stderr, "string");
  return `${stdout}\n${stderr}`;
}

export function assertNoPackagingFailure(output: string): void {
  assert.doesNotMatch(output, /ERR_MODULE_NOT_FOUND|Cannot find module|Cannot find package/);
  assert.doesNotMatch(output, /ENOENT: no such file or directory/);
  assert.doesNotMatch(output, /TypeScript .* is not supported in strip-only mode/);
  assert.doesNotMatch(output, /drivers\.sandbox selects unavailable bundled OpenShell/);
  assert.doesNotMatch(output, /OpenShell gRPC service was not found in the proto/);
}

function assertPersistenceBoundary(output: string, event: string): void {
  const diagnostic = jsonEvent(output, event, { lenient: true });
  assert.equal(diagnostic.code, "PERSISTENCE_UNAVAILABLE");
  assert.doesNotMatch(output, /The platform persistence repository is unavailable/);
}

function serverStartupArguments(fixture: string, image: string): string[] {
  return [
    "--mount",
    `type=bind,src=${fixture},dst=/tmp/oce-production-image,readonly`,
    "-e",
    "NODE_ENV=production",
    "-e",
    "OCC_HOST=10.0.0.5",
    "-e",
    "OCC_PORT=3000",
    "-e",
    "OCC_CONFIG_PATH=/tmp/oce-production-image/installation.json",
    "-e",
    "OCC_AUTH_SECRET=openclaw-production-image-smoke-secret",
    "-e",
    "OCC_AUTH_BASE_URL=https://occ.example.invalid",
    "-e",
    "OCC_AGENT_NATIVE_ADMIN_DOMAIN=agents.example.invalid",
    "-e",
    "OCC_DATABASE_URL=postgresql://127.0.0.1:1/openclaw_enterprise",
    image,
  ];
}

export function registerProductionImageControllerStartupCases({
  productionFixture,
}: ControllerStartupCases): void {
  test(
    "production image server startup loads bundled Kubernetes, OpenShell, and ChatGPT modules",
    imageTestOptions,
    async (t) => {
      assert.ok(image !== undefined);
      const fixture = await productionFixture(t);

      // Run the default image command against a deliberately unavailable database.
      const output = await runStartupExpectingFailure(serverStartupArguments(fixture, image), {
        timeout: 60_000 * imageSmokeTimeoutMultiplier,
      });
      assertPersistenceBoundary(output, "startup-error");
      assertNoPackagingFailure(output);
    },
  );

  test(
    "production image startup rejects an invalid gateway StorageClass before persistence",
    imageTestOptions,
    async (t) => {
      assert.ok(image !== undefined);
      const fixture = await productionFixture(t);
      const path = join(fixture, "installation.json");
      const installation: unknown = JSON.parse(await readFile(path, "utf8"));
      const drivers = asRecord(asRecord(installation)?.drivers);
      const compute = asRecord(drivers?.compute);
      const configuration = asRecord(compute?.configuration);
      const runtime = asRecord(configuration?.runtime);
      assert.ok(runtime, "Expected a compute runtime in the Installation fixture.");
      runtime.gatewayStorageClassName = "Bad_Class";
      await writeFile(path, `${JSON.stringify(installation, undefined, 2)}\n`, {
        encoding: "utf8",
        mode: 0o644,
      });

      const output = await runStartupExpectingFailure(serverStartupArguments(fixture, image));
      const diagnostic = jsonEvent(output, "startup-error", { lenient: true });
      assert.equal(diagnostic.code, "DRIVER_CONFIGURATION_INVALID");
      assert.deepEqual(diagnostic.details, [
        {
          path: "/runtime/gatewayStorageClassName",
          code: "INVALID_FORMAT",
          message:
            "SQLite-compatible gateway storage class must be a DNS-safe Kubernetes resource name.",
        },
      ]);
      assert.doesNotMatch(output, /Bad_Class/);
      assert.doesNotMatch(output, /PERSISTENCE_UNAVAILABLE/);
      assertNoPackagingFailure(output);
    },
  );

  test(
    "production image worker startup loads the shared runtime graph",
    imageTestOptions,
    async (t) => {
      assert.ok(image !== undefined);
      const fixture = await productionFixture(t);

      // The explicit worker command must load its packaged modules before reaching persistence.
      const output = await runStartupExpectingFailure([
        "--mount",
        `type=bind,src=${fixture},dst=/tmp/oce-production-image,readonly`,
        "-e",
        "NODE_ENV=production",
        "-e",
        "OCC_CONFIG_PATH=/tmp/oce-production-image/installation.json",
        "-e",
        "OCC_DATABASE_URL=postgresql://127.0.0.1:1/openclaw_enterprise",
        image,
        "apps/controller/src/worker.mjs",
      ]);
      assertPersistenceBoundary(output, "worker.startup-error");
      assertNoPackagingFailure(output);
    },
  );
}
