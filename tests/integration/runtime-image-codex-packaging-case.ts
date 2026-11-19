import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { AGENT_RUNTIME_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { GATEWAY_TOOL_POLICY_SOURCE_COMMIT } from "../../apps/controller/src/drivers/compute/gateway-tool-policy.ts";
import { codexRuntimeArtifact } from "../../apps/controller/src/drivers/plugin/runtime-translator.ts";
import {
  cpuScaledImageTimeoutMs,
  imageSmokeTimeoutMultiplier,
} from "../helpers/image-smoke-timeout.ts";
import { runDocker } from "../helpers/runtime-image-docker.ts";
import { readRuntimePatchChecksums } from "../helpers/runtime-patch-checksums.ts";
import { probePackagedCodex } from "../fixtures/runtime-image-startup/packaged-codex.ts";
import { codexRpc, list, parseJson, record, text } from "../fixtures/runtime-image-startup/wire.ts";
import {
  parseRuntimeDownloadClientSelection,
  readReleaseDownloadClientSelection,
} from "../../scripts/lib/runtime-download-clients.ts";
import { readOpenclawSource } from "../../scripts/lib/openclaw-source.ts";
import { renderProbe, type StartupProfile } from "./runtime-image-startup-support.ts";

async function verifyRuntimeDownloadClients(image: string) {
  const revision = process.env.EXPECTED_OCC_REVISION ?? process.env.SOURCE_SHA;
  const selection = revision
    ? await readReleaseDownloadClientSelection(revision)
    : parseRuntimeDownloadClientSelection(
        await readFile(
          new URL("../../deploy/runtime/additional-download-clients.json", import.meta.url),
          "utf8",
        ),
      );
  const probe = await readFile(
    new URL("../helpers/runtime-image-native-download-clients.ts", import.meta.url),
    "utf8",
  );
  await runDocker(
    [
      "run",
      "--rm",
      "-i",
      "--pull=never",
      "--network",
      "none",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--entrypoint",
      "node",
      image,
      "--input-type=module-typescript",
      "-",
      JSON.stringify([...selection]),
    ],
    { timeout: cpuScaledImageTimeoutMs(60_000) },
    probe,
  );
}

export async function verifyCodexPackaging(
  image: string,
  { historicalCodex, stagingCodexVersion, historicalController }: StartupProfile,
) {
  const source = historicalCodex
    ? {
        commit: "554f0b886bde6c089578c49967227f8b50d1cf16",
        sourceArchiveSha256: "1532c8e1baf84ecae6080aee6d15003afd2458aeaaeaa30b0504818b000c82d9",
      }
    : await readOpenclawSource();
  assert.equal(
    source.commit,
    historicalController?.commit ?? GATEWAY_TOOL_POLICY_SOURCE_COMMIT,
    "expected a policy-qualified runtime",
  );
  const defaultPluginPolicy = codexRuntimeArtifact({}, []).configuration.plugins;
  const codexExecutableSource = AGENT_RUNTIME_ENTRYPOINT.match(
    /^function codexExecutable\(\) \{\n[\s\S]*?\n\}\n/m,
  )?.[0];
  assert.ok(codexExecutableSource, "the Harness entrypoint must define codexExecutable()");

  const script = renderProbe(probePackagedCodex, [
    {
      historicalCodex,
      stagingCodexVersion,
      deadlineMs: 30000 * imageSmokeTimeoutMultiplier,
      ...(historicalCodex
        ? {}
        : { expectedPatches: Object.fromEntries(await readRuntimePatchChecksums()) }),
    },
    codexExecutableSource,
    codexRpc,
    list,
    parseJson,
    record,
    text,
  ]);
  const { stdout } = await runDocker([
    "run",
    "--rm",
    "--network",
    "none",
    "--entrypoint",
    "node",
    image,
    "-e",
    script,
    JSON.stringify(defaultPluginPolicy),
    JSON.stringify(source),
  ]);
  assert.match(stdout, /shared-reviewed-codex-ready/);
  if (!historicalCodex) {
    await verifyRuntimeDownloadClients(image);
  }
}
