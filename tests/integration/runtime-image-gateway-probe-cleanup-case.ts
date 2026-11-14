import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { TestContext } from "node:test";
import { image, runDocker } from "../helpers/runtime-image-startup.mjs";

export async function verifyRuntimeGatewayProbeCleanup(
  t: TestContext,
  pluginRuntimeHelpers: string,
): Promise<void> {
  const containerName = `oce-runtime-gateway-probe-${randomBytes(6).toString("hex")}`;
  t.after(() => runDocker(["rm", "-f", containerName]).catch(() => {}));
  const source = await readFile(
    new URL("../fixtures/runtime-gateway-probe.cjs", import.meta.url),
    "utf8",
  );
  const { stdout } = await runDocker([
    "run",
    "--rm",
    "--name",
    containerName,
    "--network",
    "none",
    "--entrypoint",
    "node",
    image,
    "-e",
    source,
    "fixture",
    pluginRuntimeHelpers,
  ]);
  assert.match(stdout, /GATEWAY_PROBE_RECOVERY_PASSED/);
}
