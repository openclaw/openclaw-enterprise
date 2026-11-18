import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import type { TestContext } from "node:test";
import type { GatewayProbeInvocation } from "../fixtures/runtime-gateway-probe.ts";
import { runDocker } from "../helpers/runtime-image-docker.ts";
import { image } from "../helpers/runtime-image-startup.ts";

export async function verifyRuntimeGatewayProbeCleanup(
  t: TestContext,
  pluginRuntimeHelpers: string,
): Promise<void> {
  const containerName = `oce-runtime-gateway-probe-${randomBytes(6).toString("hex")}`;
  t.after(() => runDocker(["rm", "-f", containerName]).catch(() => {}));
  const source = await readFile(
    new URL("../fixtures/runtime-gateway-probe.ts", import.meta.url),
    "utf8",
  );
  const invocation: GatewayProbeInvocation = ["fixture", pluginRuntimeHelpers];
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
    stripTypeScriptTypes(source),
    ...invocation,
  ]);
  assert.match(stdout, /GATEWAY_PROBE_RECOVERY_PASSED/);
}
