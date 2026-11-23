import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { TestContext } from "node:test";
import { nodeProgramArguments } from "../../apps/controller/src/drivers/compute/node-program.ts";
import {
  cpuScaledImageTimeoutMs,
  imageSmokeTimeoutMultiplier,
} from "../helpers/image-smoke-timeout.ts";
import { runDocker } from "../helpers/runtime-image-docker.ts";
import { temporaryGatewayConfiguration } from "../helpers/runtime-image-startup.ts";
import { probeRenderedSchema } from "../fixtures/runtime-image-startup/rendered-schema.ts";
import { record, parseJson, text, list } from "../fixtures/runtime-image-startup/wire.ts";
import { renderProbe, type StartupProfile } from "./runtime-image-startup-support.ts";

export async function verifyDedicatedSchema(
  t: TestContext,
  image: string,
  {
    kubernetesGateway,
    nativeWorker,
  }: Pick<StartupProfile["controller"], "kubernetesGateway" | "nativeWorker">,
) {
  const configurationPath: string = await temporaryGatewayConfiguration(t, "openclaw");
  const containerName = `oce-runtime-image-native-schema-${randomBytes(6).toString("hex")}`;
  t.after(() => runDocker(["rm", "-f", containerName]).catch(() => {}));
  // Run both production entrypoints, then validate the configuration each one
  // wrote with the image's own OpenClaw. Only the Harness model probe is
  // replaced: the container has no network or model credential.

  const launch = renderProbe(probeRenderedSchema, [record, parseJson, text, list]);
  // The Gateway start and validation waits scale with the runner's CPUs: the
  // lane's other files start runtimes at the same time, so a slow start under that
  // load is not a failure (finding 2460). The worker never connects without a
  // network, so its run always ends at harnessRunMs after writing its
  // configuration; that window stays fixed, or each run would take longer on
  // fewer CPUs. The container runs these one after another: its limit is their
  // sum plus a minute to create and remove it.
  const startupMs = cpuScaledImageTimeoutMs(90_000);
  const harnessRunMs = 90_000 * imageSmokeTimeoutMultiplier;
  const validateMs = cpuScaledImageTimeoutMs(60_000);
  const { stdout } = await runDocker(
    [
      "run",
      "-i",
      "--rm",
      "--name",
      containerName,
      "--user",
      "1000:1000",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--tmpfs",
      "/home/node:size=1024m,uid=1000,gid=1000,mode=700",
      "--tmpfs",
      "/tmp:size=64m,uid=1000,gid=1000,mode=1777",
      "--network",
      "none",
      "--volume",
      `${configurationPath}:/etc/openclaw/openclaw.json:ro`,
      "--volume",
      `${configurationPath}:/etc/openclaw-managed/openclaw.json:ro`,
      "--entrypoint",
      "node",
      image,
      "-e",
      launch,
    ],
    {
      timeout: 3 * startupMs + harnessRunMs + 2 * validateMs + 60_000 * imageSmokeTimeoutMultiplier,
    },
    JSON.stringify({
      gatewayArgs: nodeProgramArguments(kubernetesGateway),
      harness: nativeWorker,
      workspaceNodeId: randomBytes(32).toString("hex"),
      startupMs,
      harnessRunMs,
      validateMs,
    }),
  );
  const report = record(parseJson(stdout));
  const gateway = record(report.gateway);
  const harness = record(report.harness);
  const gatewayConfig = record(gateway.config);
  const harnessConfig = record(harness.config);
  const cloudWorkers = record(gatewayConfig.cloudWorkers);
  const gatewayValidation = record(gateway.validation);
  const harnessValidation = record(harness.validation);
  const entries = record(record(gatewayConfig.plugins).entries);
  const fileTransfer = record(record(entries["file-transfer"]).config);
  const main = record(record(fileTransfer.workspaces).main);
  const openai = record(record(record(harnessConfig.models).providers).openai);
  const workerRuns = record(record(harnessConfig.nodeHost).workerRuns);
  // The Gateway publishes its admitted worker and workspace. The Harness
  // keeps the credential reference without persisting launcher-only input.
  assert.equal(cloudWorkers.requiredProfile, "dedicated-native");
  assert.equal(record(record(cloudWorkers.profiles)["dedicated-native"]).provider, "device");
  assert.equal(main.remoteRoot, "/tmp/runtime-image-provider-workspace");
  assert.equal(record(list(openai.models)[0]).id, "runtime-image-schema");
  assert.equal(
    record(record(harnessConfig.agents).defaults).workspace,
    "/tmp/runtime-image-provider-workspace",
  );
  assert.deepEqual(openai.apiKey, {
    source: "env",
    provider: "model",
    id: "OPENAI_API_KEY",
  });
  assert.equal(workerRuns.nativeInferenceConfig, undefined);
  assert.deepEqual(gatewayValidation.issues, []);
  assert.deepEqual(harnessValidation.issues, []);
  assert.equal(gatewayValidation.valid, true);
  assert.equal(gateway.ready, true, text(gateway.output));
  const restart = record(gateway.restart);
  assert.equal(restart.ready, true, text(restart.output));
  const conflictingRestart = record(gateway.conflictingRestart);
  assert.equal(conflictingRestart.code, 1);
  assert.match(
    text(conflictingRestart.output),
    /worker profile conflicts with admitted configuration/u,
  );
  assert.equal(harnessValidation.valid, true);
  // Schema acceptance alone does not qualify the default image's complete native flow.
  // Runtime admission retains its separate native-worker support gate.
}
